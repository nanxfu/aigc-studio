"""游戏素材与 UI 专用确定性算子及轻量后处理基础设施（M4 路线 A）。

定位与许可原则：
- **纯 CPU 确定性算子**：像素网格对齐（Pixel-Snap + 调色盘量化）、序列帧图集切片
  （Sprite Sheet + Atlas JSON）、四方连续无缝检测与修复（Seamless Check & Blend）、
  矢量 SVG 转换（``VTracer``），零显存占用且响应 < 100ms。
- **效果优先的轻量 GPU 算子（界面显式标识协议属性）**：
  - 透明抠图兼容 ``RMBG-2.0``（``briaai/RMBG-2.0``，非商用）与 ``BiRefNet``（``ZhengPeng7/BiRefNet``，MIT）；
  - PBR 材质拆解提供 ``diffusers`` 原生 ``MarigoldIntrinsicsPipeline`` + ``MarigoldNormalsPipeline`` 与 ``Ubisoft CHORD``（单步链式 SVBRDF 拆解，研究许可 / HF 受限仓库），输出同构四通道；
  - 无缝纹理生成使用临时上下文补丁 ``CircularPaddingPatch``，退出作用域自动恢复
    ``Conv2d.padding_mode``，绝不污染已缓存的推理管线。

顶层不直接 import ``PIL`` / ``torch`` / ``diffusers`` / ``vtracer``，便于离线按需测试。
"""

from __future__ import annotations

import io
import math
from pathlib import Path


class MissingDependencyError(RuntimeError):
    """可选后处理依赖缺失时抛出的显式错误（携带安装提示）。"""


class CircularPaddingPatch:
    """推理期临时把 PyTorch 模块里的 ``Conv2d`` 切为 ``padding_mode='circular'``。

    专为 SDXL 等卷积型底座生成四方连续（Seamless）游戏地面/墙面材质设计；
    退出 ``with`` 上下文时无条件恢复原始 ``padding_mode``，避免污染共享缓存底座。
    """

    def __init__(self, *modules) -> None:  # noqa: ANN002
        self._modules = [m for m in modules if m is not None]
        self._saved: list[tuple[object, str]] = []

    def __enter__(self) -> "CircularPaddingPatch":
        import torch.nn as nn

        self._saved.clear()
        for root in self._modules:
            for mod in root.modules():
                if isinstance(mod, nn.Conv2d) and getattr(mod, "padding_mode", "zeros") != "circular":
                    self._saved.append((mod, mod.padding_mode))
                    mod.padding_mode = "circular"
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        for mod, original_mode in self._saved:
            mod.padding_mode = original_mode
        self._saved.clear()


def pixel_snap_and_quantize(
    img,
    target_width: int,
    target_height: int,
    *,
    colors: int = 16,
    scale_back: int = 1,
    alpha_threshold: int = 128,
):
    """消除 AI 像素画抗锯齿与半像素偏移：网格最近邻对齐 + 调色盘量化。

    - 严格保留 Alpha 通道并在降采样后做二值化硬边缘处理（像素风不需要半透明灰边）；
    - ``scale_back > 1`` 时按整数倍最近邻放大，方便桌面端高清预览且不破坏像素格。
    """
    from PIL import Image

    if not (1 <= target_width <= 1024 and 1 <= target_height <= 1024):
        raise ValueError(f"像素目标尺寸必须在 1..1024 之间，收到 {target_width}x{target_height}")
    if not (2 <= colors <= 256):
        raise ValueError(f"调色盘颜色数必须在 2..256 之间，收到 {colors}")
    if not (1 <= scale_back <= 16):
        raise ValueError(f"整数放大倍数必须在 1..16 之间，收到 {scale_back}")

    rgba = img.convert("RGBA")
    snapped = rgba.resize((target_width, target_height), Image.Resampling.NEAREST)

    r, g, b, a = snapped.split()
    alpha_clean = a.point(lambda v: 255 if v >= alpha_threshold else 0)

    rgb = Image.merge("RGB", (r, g, b))
    quantized_rgb = rgb.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    qr, qg, qb = quantized_rgb.split()
    out = Image.merge("RGBA", (qr, qg, qb, alpha_clean))

    if scale_back > 1:
        out = out.resize(
            (target_width * scale_back, target_height * scale_back),
            Image.Resampling.NEAREST,
        )
    return out


def slice_sprite_sheet(
    img,
    *,
    rows: int | None = None,
    cols: int | None = None,
    frame_width: int | None = None,
    frame_height: int | None = None,
    trim_alpha: bool = True,
    prefix: str = "frame",
) -> tuple[list[tuple[str, object]], dict]:
    """将序列帧大图按行列或固定格尺寸切片，并生成通用游戏引擎 ``atlas`` 元数据。"""
    rgba = img.convert("RGBA")
    sheet_w, sheet_h = rgba.size

    if rows is not None and cols is not None:
        if rows <= 0 or cols <= 0:
            raise ValueError("rows 与 cols 必须为正整数")
        fw = sheet_w // cols
        fh = sheet_h // rows
        grid_rows, grid_cols = rows, cols
    elif frame_width is not None and frame_height is not None:
        if frame_width <= 0 or frame_height <= 0:
            raise ValueError("frame_width 与 frame_height 必须为正整数")
        fw, fh = frame_width, frame_height
        grid_cols = max(1, sheet_w // fw)
        grid_rows = max(1, sheet_h // fh)
    else:
        raise ValueError("必须成对提供 (rows, cols) 或 (frame_width, frame_height)")

    if fw <= 0 or fh <= 0:
        raise ValueError(f"单帧尺寸无效：{fw}x{fh}（原图 {sheet_w}x{sheet_h}）")

    frames_out: list[tuple[str, object]] = []
    atlas_frames: dict[str, dict] = {}
    index = 0

    for r_idx in range(grid_rows):
        for c_idx in range(grid_cols):
            x0 = c_idx * fw
            y0 = r_idx * fh
            x1 = x0 + fw
            y1 = y0 + fh
            if x1 > sheet_w or y1 > sheet_h:
                continue

            tile = rgba.crop((x0, y0, x1, y1))
            trimmed = False
            src_box = {"x": 0, "y": 0, "w": fw, "h": fh}

            if trim_alpha:
                bbox = tile.getbbox()
                if bbox is None:
                    # 完全透明的空占位格跳过导出
                    continue
                if bbox != (0, 0, fw, fh):
                    trimmed = True
                    tile = tile.crop(bbox)
                    src_box = {
                        "x": bbox[0],
                        "y": bbox[1],
                        "w": bbox[2] - bbox[0],
                        "h": bbox[3] - bbox[1],
                    }

            name = f"{prefix}_{index:03d}.png"
            index += 1
            frames_out.append((name, tile))
            atlas_frames[name] = {
                "frame": {"x": x0 + src_box["x"], "y": y0 + src_box["y"], "w": src_box["w"], "h": src_box["h"]},
                "trimmed": trimmed,
                "spriteSourceSize": src_box,
                "sourceSize": {"w": fw, "h": fh},
                "pivot": {"x": 0.5, "y": 0.5},
            }

    atlas = {
        "meta": {
            "app": "aigc-studio",
            "format": "RGBA8888",
            "size": {"w": sheet_w, "h": sheet_h},
            "frameSize": {"w": fw, "h": fh},
            "count": len(frames_out),
        },
        "frames": atlas_frames,
    }
    return frames_out, atlas


def analyze_seamless_tile(img, *, threshold: float = 12.0) -> dict:
    """量化评估图像四边平铺接缝误差（左右边 / 上下边 RGB 平均绝对差 MAE）。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    if w < 2 or h < 2:
        raise ValueError("图像尺寸至少为 2x2")

    px = rgb.load()
    h_diff = 0.0
    for y in range(h):
        l_r, l_g, l_b = px[0, y]
        r_r, r_g, r_b = px[w - 1, y]
        h_diff += abs(l_r - r_r) + abs(l_g - r_g) + abs(l_b - r_b)
    h_mae = h_diff / (h * 3)

    v_diff = 0.0
    for x in range(w):
        t_r, t_g, t_b = px[x, 0]
        b_r, b_g, b_b = px[x, h - 1]
        v_diff += abs(t_r - b_r) + abs(t_g - b_g) + abs(t_b - b_b)
    v_mae = v_diff / (w * 3)

    max_mae = max(h_mae, v_mae)
    return {
        "horizontalSeamMae": round(h_mae, 3),
        "verticalSeamMae": round(v_mae, 3),
        "maxSeamMae": round(max_mae, 3),
        "isSeamless": max_mae <= threshold,
        "threshold": threshold,
    }


def make_tile_preview_2x2(img, *, max_side: int = 1024):
    """生成 2×2 平铺预览图，供桌面端舞台直观校验接缝。"""
    from PIL import Image

    rgb = img.convert("RGBA")
    w, h = rgb.size
    canvas = Image.new("RGBA", (w * 2, h * 2))
    canvas.paste(rgb, (0, 0))
    canvas.paste(rgb, (w, 0))
    canvas.paste(rgb, (0, h))
    canvas.paste(rgb, (w, h))
    if max(canvas.size) > max_side:
        canvas.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    return canvas


def blend_seamless_edges(img, *, border_ratio: float = 0.1):
    """纯 CPU 兜底：通过半格平移 + 余弦交叉渐隐消除显式接缝。"""
    from PIL import Image

    if not (0.02 <= border_ratio <= 0.45):
        raise ValueError("border_ratio 必须在 0.02..0.45 之间")

    rgba = img.convert("RGBA")
    w, h = rgba.size
    half_x, half_y = w // 2, h // 2
    band_x = max(2, int(w * border_ratio))
    band_y = max(2, int(h * border_ratio))

    # 水平和垂直各滚动半张图，使原本的四边接缝落到图像中心十字区域
    rolled = Image.new("RGBA", (w, h))
    rolled.paste(rgba.crop((half_x, half_y, w, h)), (0, 0))
    rolled.paste(rgba.crop((0, half_y, half_x, h)), (w - half_x, 0))
    rolled.paste(rgba.crop((half_x, 0, w, half_y)), (0, h - half_y))
    rolled.paste(rgba.crop((0, 0, half_x, half_y)), (w - half_x, h - half_y))

    src = rgba.load()
    dst = rolled.load()

    # 沿中心十字带按余弦权重融合原图中心平滑纹理，消除生硬接缝
    for y in range(h):
        dy = abs(y - (h - half_y))
        wy = 0.5 * (1.0 + math.cos(math.pi * min(1.0, dy / band_y))) if dy < band_y else 0.0
        for x in range(w):
            dx = abs(x - (w - half_x))
            wx = 0.5 * (1.0 + math.cos(math.pi * min(1.0, dx / band_x))) if dx < band_x else 0.0
            weight = max(wx, wy)
            if weight > 0.0:
                sr, sg, sb, sa = src[x, y]
                dr, dg, db, da = dst[x, y]
                dst[x, y] = (
                    int(round(dr * (1.0 - weight) + sr * weight)),
                    int(round(dg * (1.0 - weight) + sg * weight)),
                    int(round(db * (1.0 - weight) + sb * weight)),
                    int(round(da * (1.0 - weight) + sa * weight)),
                )
    return rolled


def vectorize_to_svg(
    image_input,
    *,
    colormode: str = "color",
    hierarchical: str = "stacked",
    mode: str = "spline",
    color_precision: int = 6,
    filter_speckle: int = 4,
) -> str:
    """将栅格图标/UI PNG 矢量化为 SVG 字符串（基于 Rust ``vtracer``，纯 CPU）。"""
    try:
        import vtracer
    except ImportError as exc:
        raise MissingDependencyError(
            "缺少矢量转换依赖 vtracer，请执行 `pip install vtracer` 后重试"
        ) from exc

    from PIL import Image

    if isinstance(image_input, (str, Path)):
        img = Image.open(image_input).convert("RGBA")
    elif isinstance(image_input, bytes):
        img = Image.open(io.BytesIO(image_input)).convert("RGBA")
    else:
        img = image_input.convert("RGBA")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    svg_str = vtracer.convert_raw_image_to_svg(
        buf.getvalue(),
        img_format="png",
        colormode=colormode,
        hierarchical=hierarchical,
        mode=mode,
        color_precision=int(color_precision),
        filter_speckle=int(filter_speckle),
    )
    return svg_str


def _normalize_array_to_pil(value):  # noqa: ANN001, ANN202
    """把 diffusers / numpy 原始张量规整成 uint8 PIL.Image（兜底可视化路径）。"""
    if hasattr(value, "save"):
        return value
    import numpy as np
    from PIL import Image

    arr = np.asarray(value)
    while arr.ndim > 3 and arr.shape[0] == 1:
        arr = arr[0]
    if arr.ndim == 3 and arr.shape[0] in (1, 3, 4) and arr.shape[-1] not in (1, 3, 4):
        arr = np.transpose(arr, (1, 2, 0))
    if np.issubdtype(arr.dtype, np.floating):
        arr = np.clip(arr * 255.0, 0, 255).round().astype(np.uint8)
    else:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    if arr.ndim == 3 and arr.shape[-1] == 1:
        arr = arr[:, :, 0]
    if arr.ndim == 2:
        return Image.fromarray(arr, mode="L").convert("RGB")
    if arr.ndim == 3 and arr.shape[-1] == 4:
        return Image.fromarray(arr, mode="RGBA")
    return Image.fromarray(arr, mode="RGB")


def run_birefnet_cutout(
    img,
    *,
    repo_id: str = "ZhengPeng7/BiRefNet",
    device: str | None = None,
    input_size: tuple[int, int] = (1024, 1024),
):
    """使用 ``BiRefNet`` / ``RMBG-2.0`` 提取高精度透明前景，返回带 Alpha 的 RGBA PIL.Image。"""
    import torch
    from PIL import Image
    from torchvision import transforms
    from transformers import AutoModelForImageSegmentation

    target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    model = AutoModelForImageSegmentation.from_pretrained(repo_id, trust_remote_code=True)
    try:
        model.to(target_device).eval()
        first_param = next(model.parameters(), None)
        model_dtype = getattr(first_param, "dtype", None) or torch.float32

        rgb = img.convert("RGB")
        orig_size = rgb.size
        transform = transforms.Compose(
            [
                transforms.Resize(input_size),
                transforms.ToTensor(),
                transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
            ]
        )
        # ZhengPeng7/BiRefNet 官方权重以 fp16 存档：输入张量必须对齐模型权重 dtype，
        # 推理完再转回 fp32 给 ToPILImage，避免 Input (float) 与 bias (Half) 冲突。
        tensor = transform(rgb).unsqueeze(0).to(device=target_device, dtype=model_dtype)

        with torch.no_grad():
            preds = model(tensor)[-1].sigmoid().float().cpu()

        mask = transforms.ToPILImage()(preds[0].squeeze()).resize(orig_size, Image.Resampling.BILINEAR)
        out = rgb.copy()
        out.putalpha(mask)
        return out
    finally:
        del model
        if target_device.startswith("cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()


def run_marigold_pbr(
    img,
    *,
    intrinsics_repo: str = "prs-eth/marigold-iid-appearance-v1-1",
    normals_repo: str = "prs-eth/marigold-normals-v1-1",
    steps: int = 4,
    include_normals: bool = True,
    device: str | None = None,
) -> dict[str, object]:
    """使用 ``diffusers`` 原生 Marigold 管线拆解 PBR 材质通道。

    返回字典包含：``albedo``、``roughness``、``metallic`` 及可选 ``normal``（均为 PIL.Image）。
    """
    import torch
    from diffusers import MarigoldIntrinsicsPipeline, MarigoldNormalsPipeline

    target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.float16 if target_device.startswith("cuda") else torch.float32
    rgb = img.convert("RGB")

    iid_pipe = MarigoldIntrinsicsPipeline.from_pretrained(
        intrinsics_repo,
        variant="fp16" if dtype == torch.float16 else None,
        torch_dtype=dtype,
    ).to(target_device)
    try:
        iid_out = iid_pipe(rgb, num_inference_steps=steps)
        image_processor = getattr(iid_pipe, "image_processor", None)
        visualize_fn = getattr(image_processor, "visualize_intrinsics", None)
        target_props = getattr(iid_pipe, "target_properties", None)
        if callable(visualize_fn) and target_props is not None:
            vis = visualize_fn(iid_out.prediction, target_props)[0]
            result: dict[str, object] = {
                "albedo": _normalize_array_to_pil(vis["albedo"]),
                "roughness": _normalize_array_to_pil(vis["roughness"]),
                "metallic": _normalize_array_to_pil(
                    vis.get("metallic") if vis.get("metallic") is not None else vis["metallicity"]
                ),
            }
        else:
            preds = iid_out.prediction
            if hasattr(preds, "ndim") and preds.ndim == 5 and preds.shape[0] == 1:
                preds = preds[0]
            result = {
                "albedo": _normalize_array_to_pil(preds[0]),
                "roughness": _normalize_array_to_pil(preds[1]),
                "metallic": _normalize_array_to_pil(preds[2]),
            }
    finally:
        del iid_pipe
        if target_device.startswith("cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()

    if include_normals:
        norm_pipe = MarigoldNormalsPipeline.from_pretrained(
            normals_repo,
            variant="fp16" if dtype == torch.float16 else None,
            torch_dtype=dtype,
        ).to(target_device)
        try:
            norm_out = norm_pipe(rgb, num_inference_steps=steps)
            result["normal"] = norm_pipe.image_processor.visualize_normals(norm_out.prediction)[0]
        finally:
            del norm_pipe
            if target_device.startswith("cuda") and torch.cuda.is_available():
                torch.cuda.empty_cache()

    return result


CHORD_ARCHIVE_URL = "https://github.com/ubisoft/ubisoft-laforge-chord/archive/refs/heads/main.tar.gz"
CHORD_SD21_CONFIG_REPO = "sd2-community/stable-diffusion-2-1-base"
CHORD_WEIGHT_FILENAME = "chord_v1.safetensors"
DA3_ARCHIVE_URL = "https://github.com/ByteDance-Seed/Depth-Anything-3/archive/refs/heads/main.tar.gz"
MOGE_ARCHIVE_URL = "https://github.com/microsoft/MoGe/archive/refs/heads/main.tar.gz"


def _runtime_cache_root(folder_name: str) -> Path:
    """返回运行期按需拉取源码的缓存根目录（位于仓库外，保持许可隔离）。"""
    import os

    hf_home = (os.environ.get("HF_HOME") or "").strip()
    if hf_home:
        return Path(hf_home) / folder_name
    hf_hub_cache = (os.environ.get("HF_HUB_CACHE") or "").strip()
    if hf_hub_cache:
        return Path(hf_hub_cache).parent / folder_name
    return Path.home() / ".cache" / "huggingface" / folder_name


def _chord_cache_root() -> Path:
    """返回 Ubisoft CHORD 源码与配置的运行期缓存根目录（位于仓库外，不混入 MIT 源码）。"""
    return _runtime_cache_root("ubisoft-laforge-chord-src")


def _ensure_pip_packages(requirements: list[tuple[str, str]], *, purpose: str) -> None:
    """按需确保轻量运行期依赖可导入；缺失时仅补装未安装项。"""
    import importlib
    import subprocess
    import sys

    missing = []
    for import_name, pip_spec in requirements:
        try:
            importlib.import_module(import_name)
        except ImportError:
            missing.append((import_name, pip_spec))
    if not missing:
        return
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "--progress-bar", "off", *[spec for _, spec in missing]],
        )
        for import_name, _ in missing:
            importlib.import_module(import_name)
    except Exception as exc:  # noqa: BLE001 - 统一转成缺失依赖可读提示
        specs = " ".join(spec for _, spec in missing)
        raise MissingDependencyError(
            f"{purpose} 需要依赖 {specs}（自动安装失败：{type(exc).__name__}: {exc}）；"
            f"请执行 `pip install {specs}` 后重试"
        ) from exc


def _ensure_omegaconf() -> None:
    """按需确保 omegaconf 可导入；Kaggle/容器镜像未预装时在线补装。"""
    _ensure_pip_packages([("omegaconf", "omegaconf")], purpose="Ubisoft CHORD")


def _ensure_archive_repo(
    cache_dir: Path,
    *,
    archive_url: str,
    markers: tuple[str, ...],
    label: str,
) -> Path:
    """下载并原子解压 GitHub 源码归档到缓存目录，避免重装镜像与许可污染。"""
    import shutil
    import tarfile
    import tempfile
    import urllib.request

    if all((cache_dir / marker).is_file() for marker in markers):
        return cache_dir

    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f"{cache_dir.name}.tmp-", dir=str(cache_dir.parent)))
    try:
        with urllib.request.urlopen(archive_url, timeout=60) as resp:
            archive_bytes = resp.read()
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tf:
            resolved_staging = staging.resolve()
            for member in tf.getmembers():
                parts = Path(member.name).parts
                if len(parts) <= 1:
                    continue
                rel = Path(*parts[1:])
                dest = (resolved_staging / rel).resolve()
                if not dest.is_relative_to(resolved_staging):
                    raise ValueError(f"非法的归档路径：{member.name}")
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    src = tf.extractfile(member)
                    if src is None:
                        continue
                    with src, open(dest, "wb") as out_f:
                        shutil.copyfileobj(src, out_f)
        if not all((staging / marker).is_file() for marker in markers):
            raise RuntimeError(f"{label} 源码归档缺少必要文件：{', '.join(markers)}")
        if cache_dir.exists():
            shutil.rmtree(cache_dir, ignore_errors=True)
        staging.replace(cache_dir)
        return cache_dir
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def ensure_chord_repo(
    cache_dir: Path | str | None = None,
    *,
    archive_url: str = CHORD_ARCHIVE_URL,
) -> Path:
    """运行期按需拉取 Ubisoft CHORD 官方推理代码到工作区外缓存目录。"""
    target = Path(cache_dir) if cache_dir is not None else _chord_cache_root()
    return _ensure_archive_repo(
        target,
        archive_url=archive_url,
        markers=("chord/__init__.py", "config/chord.yaml"),
        label="Ubisoft CHORD",
    )


def run_chord_pbr(
    img,
    *,
    repo_id: str = "ubisoft/ubisoft-laforge-chord",
    sd21_config_repo: str = CHORD_SD21_CONFIG_REPO,
    device: str | None = None,
    code_dir: Path | str | None = None,
) -> dict[str, object]:
    """使用 ``Ubisoft CHORD`` 拆解 SVBRDF 4 通道（albedo / normal / roughness / metallic）。

    设计要点：
    1. 权重 ``chord_v1.safetensors`` 从受限仓库（需 HF Token 并同意协议）拉取；
    2. 官方源码硬编码的 ``RedbeardNZ/stable-diffusion-2-1-base`` 已失效（401），这里先通过
       ``snapshot_download`` 仅拉取公开镜像 ``sd2-community/stable-diffusion-2-1-base`` 的
       网络结构配置与分词器（< 2MB，不下载 SD2.1 大权重）再经 ``hf_key`` 注入本地目录；
    3. 规避 ``chord.io`` 对 ``imageio`` 的多余依赖，直接用 ``numpy`` / ``PIL`` / ``safetensors`` 完成张量与图像转换。
    """
    import gc
    import os
    import sys

    import numpy as np
    import safetensors
    import torch
    from hub_download import hub_file_download, hub_snapshot_download
    from safetensors.torch import load_file
    from torchvision.transforms import v2

    _ensure_omegaconf()
    from omegaconf import OmegaConf

    chord_root = Path(code_dir) if code_dir is not None else ensure_chord_repo()
    chord_root_str = str(chord_root)
    added_to_path = chord_root_str not in sys.path
    if added_to_path:
        sys.path.insert(0, chord_root_str)

    target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    token = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip() or None
    hf_repo = "Ubisoft/ubisoft-laforge-chord" if str(repo_id).lower() == "ubisoft/ubisoft-laforge-chord" else repo_id

    model = None
    state_dict = None
    x = None
    output = None
    try:
        from chord import ChordModel

        ckpt_path = hub_file_download(hf_repo, CHORD_WEIGHT_FILENAME, token=token)
        sd21_dir = hub_snapshot_download(
            sd21_config_repo,
            allow_patterns=[
                "unet/config.json",
                "vae/config.json",
                "text_encoder/config.json",
                "tokenizer/*",
                "scheduler/scheduler_config.json",
            ],
        )

        config = OmegaConf.load(str(chord_root / "config" / "chord.yaml"))
        config.model.stable_diffusion.hf_key = str(sd21_dir)
        use_cuda = target_device.startswith("cuda") and torch.cuda.is_available()
        if not use_cuda:
            config.model.stable_diffusion.fp16 = False
            compute_dtype = torch.float32
        else:
            config.model.stable_diffusion.fp16 = True
            major, _minor = torch.cuda.get_device_capability(target_device)
            # Turing (SM 7.5, e.g. T4) 无原生 bf16 Tensor Core：改用 float16 提速并对齐 autocast。
            compute_dtype = torch.bfloat16 if major >= 8 else torch.float16

        model = ChordModel(config)
        model.to(device=target_device, dtype=compute_dtype)
        inner = getattr(model, "model", None)
        if inner is not None:
            inner.dtype = compute_dtype
            inner.device = torch.device(target_device)
            sd = getattr(inner, "sd", None)
            if sd is not None:
                sd.dtype = compute_dtype
                sd.device = torch.device(target_device)

        safe_open = getattr(safetensors, "safe_open", None)
        if callable(safe_open) and hasattr(model, "named_parameters"):
            # 流式逐张量拷贝，避免 9.4GB 权重整包常驻 CPU 内存；
            # 同时兼容 transformers 5.x 将 CLIPTextModel.text_model 扁平化后的键名变化，并保留非持久化缓冲区。
            model_tensors = dict(model.named_parameters())
            model_tensors.update(dict(model.named_buffers()))
            non_persistent = set()
            for mod in model.modules():
                non_persistent.update(getattr(mod, "_non_persistent_buffers_set", ()) or ())
            with safe_open(ckpt_path, framework="pt", device="cpu") as f:
                ckpt_keys = list(f.keys())
                resolved: list[tuple[str, object]] = []
                unexpected: list[str] = []
                matched_targets: set[str] = set()
                for ckpt_key in ckpt_keys:
                    target_key = ckpt_key
                    if target_key not in model_tensors and ckpt_key.startswith("model.sd.text_encoder.text_model."):
                        alt_key = "model.sd.text_encoder." + ckpt_key[len("model.sd.text_encoder.text_model."):]
                        if alt_key in model_tensors:
                            target_key = alt_key
                    if target_key in model_tensors:
                        resolved.append((ckpt_key, model_tensors[target_key]))
                        matched_targets.add(target_key)
                    else:
                        unexpected.append(ckpt_key)
                missing = [
                    k
                    for k in model_tensors
                    if k not in matched_targets and k.rsplit(".", 1)[-1] not in non_persistent
                ]
                if missing or unexpected:
                    raise RuntimeError(
                        f"CHORD 权重键不匹配（missing={len(missing)}, unexpected={len(unexpected)}）"
                    )
                with torch.no_grad():
                    for ckpt_key, target_tensor in resolved:
                        src_tensor = f.get_tensor(ckpt_key)
                        target_tensor.copy_(src_tensor.to(device=target_tensor.device, dtype=target_tensor.dtype))
                        del src_tensor
        else:
            state_dict = load_file(ckpt_path, device="cpu")
            model.load_state_dict(state_dict)
            del state_dict
            state_dict = None
        gc.collect()
        model.eval()

        rgb = img.convert("RGB")
        arr = np.asarray(rgb, dtype=np.float32) / 255.0
        img_tensor = torch.from_numpy(arr).permute(2, 0, 1).to(target_device)
        ori_h, ori_w = img_tensor.shape[-2:]
        x = v2.Resize(size=(1024, 1024), antialias=True)(img_tensor).unsqueeze(0)

        with torch.no_grad():
            if use_cuda:
                with torch.autocast(device_type="cuda", dtype=compute_dtype):
                    output = model(x)
            else:
                output = model(x)

        resizer = v2.Resize(size=(ori_h, ori_w), antialias=True)
        channel_map = (
            ("albedo", "basecolor"),
            ("normal", "normal"),
            ("roughness", "roughness"),
            ("metallic", "metalness"),
        )
        result: dict[str, object] = {}
        for out_key, chord_key in channel_map:
            tensor = output.get(chord_key)
            if tensor is None:
                raise RuntimeError(f"Ubisoft CHORD 输出缺少 {chord_key} 通道")
            if tensor.dim() == 3:
                tensor = tensor.unsqueeze(1)
            resized = resizer(tensor).clamp(0.0, 1.0)
            result[out_key] = _normalize_array_to_pil(resized[0].detach().float().cpu().numpy()).convert("RGB")
        return result
    finally:
        del output, x, state_dict, model
        if added_to_path and chord_root_str in sys.path:
            try:
                sys.path.remove(chord_root_str)
            except ValueError:
                pass
        gc.collect()
        if target_device.startswith("cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()


def _normalize_depth_array(value):  # noqa: ANN001, ANN202
    """把任意深度网络输出压成 ``[0,1]``（0=近，1=远）的二维数组。"""
    import numpy as np

    arr = np.asarray(value, dtype=np.float32)
    while arr.ndim > 2 and arr.shape[0] == 1:
        arr = arr[0]
    if arr.ndim == 3:
        # 少数导出返回 [H,W,1]；多通道时优先取第一通道，避免把 RGB 误当深度。
        if arr.shape[-1] == 1:
            arr = arr[..., 0]
        elif arr.shape[0] == 1:
            arr = arr[0]
        else:
            arr = arr[..., 0]
    if arr.ndim != 2:
        raise RuntimeError(f"深度模型输出维度异常：{arr.shape}")
    finite = np.isfinite(arr)
    if not finite.any():
        raise RuntimeError("深度模型输出没有有效数值")
    valid = arr[finite]
    low, high = np.percentile(valid, [2.0, 98.0])
    if not np.isfinite(low) or not np.isfinite(high) or high - low < 1e-6:
        return np.zeros_like(arr, dtype=np.float32)
    # 无效像素（NaN / inf）按最近值填零：下游法线与通道编码不能把 NaN 传到 uint8。
    normalized = np.nan_to_num((arr - low) / (high - low), nan=0.0, posinf=1.0, neginf=0.0)
    return np.clip(normalized, 0.0, 1.0).astype(np.float32)


def depth_to_normal(depth, *, strength: float = 2.4):  # noqa: ANN001, ANN202
    """由归一化深度生成可复用的 OpenGL 风格表面法线（RGB PIL）。"""
    import numpy as np
    from PIL import Image

    field = np.asarray(depth, dtype=np.float32)
    if field.ndim != 2:
        raise ValueError("depth 必须是二维数组")
    # 先做一次 3×3 均值，削弱单像素噪声导致的彩色法线毛刺。
    padded = np.pad(field, 1, mode="edge")
    smooth = (
        padded[:-2, :-2] + 2 * padded[:-2, 1:-1] + padded[:-2, 2:]
        + 2 * padded[1:-1, :-2] + 4 * padded[1:-1, 1:-1] + 2 * padded[1:-1, 2:]
        + padded[2:, :-2] + 2 * padded[2:, 1:-1] + padded[2:, 2:]
    ) / 16.0
    dz_dx = np.gradient(smooth, axis=1) * strength
    dz_dy = np.gradient(smooth, axis=0) * strength
    nx = dz_dx
    ny = -dz_dy
    nz = np.ones_like(smooth)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack((nx / length, ny / length, nz / length), axis=-1)
    rgb = np.clip((normal * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB")


def _depth_estimate_via_pipeline(rgb, repo_id: str, device: str):  # noqa: ANN001, ANN202
    """优先走 transformers 原生 DepthEstimation 管线，兼容 DA3 / MoGe 导出。"""
    import numpy as np
    from PIL import Image
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    import torch

    processor = AutoImageProcessor.from_pretrained(repo_id, trust_remote_code=True)
    model = AutoModelForDepthEstimation.from_pretrained(repo_id, trust_remote_code=True)
    try:
        model.to(device).eval()
        inputs = processor(images=rgb, return_tensors="pt")
        inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in inputs.items()}
        with torch.no_grad():
            output = model(**inputs)
        predicted = getattr(output, "predicted_depth", None)
        if predicted is None:
            raise RuntimeError(f"{repo_id} 没有返回 predicted_depth")
        while predicted.ndim > 2 and predicted.shape[0] == 1:
            predicted = predicted[0]
        if predicted.ndim == 3 and predicted.shape[0] == 1:
            predicted = predicted[0]
        field = _normalize_depth_array(predicted.detach().float().cpu().numpy())
        gray = Image.fromarray(
            np.clip((1.0 - field) * 255.0, 0, 255).astype(np.uint8),
            mode="L",
        ).resize(rgb.size, Image.Resampling.BILINEAR)
        return field, gray
    finally:
        del model
        if device.startswith("cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()


def _depth_estimate_via_da3(rgb, repo_id: str, device: str):  # noqa: ANN001, ANN202
    """使用官方 ``depth_anything_3`` 包加载 DA3Mono-Large / DA3-Large。"""
    import importlib
    import sys
    import types

    import numpy as np
    import torch
    from PIL import Image

    stubbed: list[str] = []
    try:
        mod = importlib.import_module("depth_anything_3.api")
        added_path = None
    except ImportError:
        _ensure_pip_packages(
            [
                ("einops", "einops"),
                ("omegaconf", "omegaconf"),
                ("addict", "addict"),
                ("cv2", "opencv-python-headless"),
                ("scipy", "scipy"),
            ],
            purpose="Depth Anything 3",
        )
        root = _ensure_archive_repo(
            _runtime_cache_root("da3-src"),
            archive_url=DA3_ARCHIVE_URL,
            markers=("src/depth_anything_3/api.py",),
            label="Depth Anything 3",
        )
        added_path = str(root / "src")
        if added_path not in sys.path:
            sys.path.insert(0, added_path)
        # export / pose_align 依赖 plyfile / trimesh / moviepy / evo 等 3D 导出库，
        # 单图深度推理阶段不调用它们；仅在缺失时注入轻量占位模块。
        for mod_name, attrs in (
            ("depth_anything_3.utils.export", {"export": None}),
            ("depth_anything_3.utils.pose_align", {"align_poses_umeyama": None}),
        ):
            if mod_name in sys.modules:
                continue
            try:
                importlib.import_module(mod_name)
            except ImportError:
                stub = types.ModuleType(mod_name)
                for attr_name, attr_val in attrs.items():
                    setattr(stub, attr_name, attr_val)
                sys.modules[mod_name] = stub
                stubbed.append(mod_name)
        mod = importlib.import_module("depth_anything_3.api")

    DepthAnything3 = getattr(mod, "DepthAnything3")
    model = DepthAnything3.from_pretrained(repo_id).to(device=device)
    try:
        model.eval()
        prediction = model.inference([rgb])
        raw_depth = getattr(prediction, "depth", None)
        if raw_depth is None:
            raise RuntimeError(f"{repo_id} 没有返回 depth")
        if hasattr(raw_depth, "detach"):
            raw_depth = raw_depth.detach().float().cpu().numpy()
        field = _normalize_depth_array(raw_depth[0] if np.asarray(raw_depth).ndim >= 3 else raw_depth)
        gray = Image.fromarray(
            np.clip((1.0 - field) * 255.0, 0, 255).astype(np.uint8),
            mode="L",
        ).resize(rgb.size, Image.Resampling.BILINEAR)
        return field, gray, None
    finally:
        del model
        for mod_name in stubbed:
            sys.modules.pop(mod_name, None)
        if added_path and added_path in sys.path:
            try:
                sys.path.remove(added_path)
            except ValueError:
                pass
        if device.startswith("cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()


def _depth_estimate_via_moge(rgb, repo_id: str, device: str):  # noqa: ANN001, ANN202
    """使用官方 ``microsoft/MoGe`` 加载 MoGe-2 ViT-L Normal（同时提取原生法线）。"""
    import importlib
    import sys

    import numpy as np
    import torch
    from PIL import Image

    try:
        mod = importlib.import_module("moge.model.v2")
        added_path = None
    except ImportError:
        _ensure_pip_packages(
            [
                ("utils3d_moge", "git+https://github.com/EasternJournalist/utils3d-moge.git@62f09d58509485564e24d5d9f6aac9ee9ebc0c37"),
                ("cv2", "opencv-python-headless"),
                ("scipy", "scipy"),
            ],
            purpose="MoGe-2",
        )
        root = _ensure_archive_repo(
            _runtime_cache_root("moge-src"),
            archive_url=MOGE_ARCHIVE_URL,
            markers=("moge/model/v2.py",),
            label="MoGe-2",
        )
        added_path = str(root)
        if added_path not in sys.path:
            sys.path.insert(0, added_path)
        mod = importlib.import_module("moge.model.v2")

    MoGeModel = getattr(mod, "MoGeModel")
    model = MoGeModel.from_pretrained(repo_id).to(device).eval()
    try:
        arr = np.asarray(rgb, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(arr).permute(2, 0, 1).to(device)
        with torch.no_grad():
            output = model.infer(tensor)
        raw_depth = output.get("depth") if isinstance(output, dict) else None
        if raw_depth is None and isinstance(output, dict) and output.get("points") is not None:
            raw_depth = output["points"][..., 2]
        if raw_depth is None:
            raise RuntimeError(f"{repo_id} 没有返回 depth")
        field = _normalize_depth_array(
            raw_depth.detach().float().cpu().numpy() if hasattr(raw_depth, "detach") else raw_depth
        )
        gray = Image.fromarray(
            np.clip((1.0 - field) * 255.0, 0, 255).astype(np.uint8),
            mode="L",
        ).resize(rgb.size, Image.Resampling.BILINEAR)
        normal_pil = None
        raw_normal = output.get("normal") if isinstance(output, dict) else None
        if raw_normal is not None:
            n_arr = raw_normal.detach().float().cpu().numpy() if hasattr(raw_normal, "detach") else np.asarray(raw_normal, dtype=np.float32)
            while n_arr.ndim > 3 and n_arr.shape[0] == 1:
                n_arr = n_arr[0]
            if n_arr.ndim == 3 and n_arr.shape[0] == 3 and n_arr.shape[-1] != 3:
                n_arr = np.transpose(n_arr, (1, 2, 0))
            if n_arr.ndim == 3 and n_arr.shape[-1] == 3:
                # MoGe 相机空间法线统一归一化并翻转 Z 朝向观察者（与 OpenGL 切空间法线一致）。
                norm = np.linalg.norm(n_arr, axis=-1, keepdims=True)
                n_arr = n_arr / np.maximum(norm, 1e-6)
                n_arr[..., 2] = np.abs(n_arr[..., 2])
                normal_pil = Image.fromarray(
                    np.clip((n_arr * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8),
                    mode="RGB",
                ).resize(rgb.size, Image.Resampling.BILINEAR)
        return field, gray, normal_pil
    finally:
        del model
        if added_path and added_path in sys.path:
            try:
                sys.path.remove(added_path)
            except ValueError:
                pass
        if device.startswith("cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()


def estimate_depth(
    img,
    *,
    repo_id: str = "depth-anything/DA3MONO-LARGE",
    device: str | None = None,
) -> dict[str, object]:
    """统一深度估计：返回 ``depth``（近白远黑的灰度）与 ``normal``（RGB）两张 PIL。"""
    import numpy as np
    import torch
    from PIL import Image

    target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    rgb = img.convert("RGB")
    lower = repo_id.lower()
    native_normal = None

    if "moge" in lower:
        field, depth_image, native_normal = _depth_estimate_via_moge(rgb, repo_id, target_device)
    elif "depth-anything/da3" in lower:
        field, depth_image, native_normal = _depth_estimate_via_da3(rgb, repo_id, target_device)
    else:
        try:
            field, depth_image = _depth_estimate_via_pipeline(rgb, repo_id, target_device)
        except Exception as primary_error:  # noqa: BLE001
            from transformers import pipeline

            pipe = pipeline(
                "depth-estimation",
                model=repo_id,
                trust_remote_code=True,
                device=0 if target_device.startswith("cuda") else -1,
            )
            try:
                result = pipe(rgb)
                predicted = result.get("predicted_depth") if isinstance(result, dict) else None
                if predicted is not None:
                    field = _normalize_depth_array(
                        predicted.detach().float().cpu().numpy() if hasattr(predicted, "detach") else predicted
                    )
                    depth_image = Image.fromarray(
                        np.clip((1.0 - field) * 255.0, 0, 255).astype(np.uint8),
                        mode="L",
                    )
                else:
                    value = result.get("depth") if isinstance(result, dict) else None
                    if not isinstance(value, Image.Image):
                        raise RuntimeError(
                            f"无法加载深度模型 {repo_id}：{type(primary_error).__name__}: {primary_error}"
                        ) from primary_error
                    gray = value.convert("L")
                    field = 1.0 - np.asarray(gray, dtype=np.float32) / 255.0
                    depth_image = gray
                depth_image = depth_image.resize(rgb.size, Image.Resampling.BILINEAR)
            finally:
                del pipe
                if target_device.startswith("cuda") and torch.cuda.is_available():
                    torch.cuda.empty_cache()
    field = np.asarray(field, dtype=np.float32)
    if field.shape != (rgb.height, rgb.width):
        field = np.asarray(
            depth_image.resize((rgb.width, rgb.height), Image.Resampling.BILINEAR),
            dtype=np.float32,
        ) / 255.0
        field = 1.0 - field
    normal = native_normal if native_normal is not None else depth_to_normal(field)
    return {"depth": depth_image, "normal": normal}


IC_LIGHT_BASE_REPO = "stablediffusionapi/realistic-vision-v51"
IC_LIGHT_WEIGHT_REPO = "lllyasviel/ic-light"
IC_LIGHT_WEIGHT_FILE = "iclight_sd15_fc.safetensors"


def run_ic_light(
    img,
    *,
    prompt: str = "",
    steps: int = 16,
    guidance: float = 2.0,
    seed: int = 12345,
    output_edge: int = 768,
    base_repo: str = IC_LIGHT_BASE_REPO,
    weight_repo: str = IC_LIGHT_WEIGHT_REPO,
    device: str | None = None,
):
    """IC-Light 前景条件重打光（SD1.5 + 8 通道 UNet 偏移权重）。"""
    import numpy as np
    import torch
    from diffusers import (
        AutoencoderKL,
        DPMSolverMultistepScheduler,
        StableDiffusionPipeline,
        UNet2DConditionModel,
    )
    from hub_download import hub_file_download
    from PIL import Image, ImageOps
    from safetensors.torch import load_file
    from transformers import CLIPTextModel, CLIPTokenizer

    target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    use_cuda = target_device.startswith("cuda") and torch.cuda.is_available()
    dtype = torch.float16 if use_cuda else torch.float32
    rgb = img.convert("RGB")
    if "A" in img.getbands():
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (128, 128, 128, 255))
        rgb = Image.alpha_composite(bg, rgba).convert("RGB")

    # SD1.5 的 latent 长宽必须是 8 的倍数；输出长边按 64 对齐，既省显存也便于
    # 在 16GB T4 上运行。比例只做轻微拉伸，不做中心裁切，避免构图被吃掉。
    ratio = rgb.width / max(1, rgb.height)
    long_edge = max(256, min(1024, int(output_edge)))
    if ratio >= 1:
        target_w = long_edge
        target_h = max(256, int(round(long_edge / ratio)))
    else:
        target_h = long_edge
        target_w = max(256, int(round(long_edge * ratio)))
    target_w = max(256, int(round(target_w / 64)) * 64)
    target_h = max(256, int(round(target_h / 64)) * 64)
    conditioned = ImageOps.fit(rgb, (target_w, target_h), method=Image.Resampling.LANCZOS)

    tokenizer = CLIPTokenizer.from_pretrained(base_repo, subfolder="tokenizer")
    text_encoder = CLIPTextModel.from_pretrained(base_repo, subfolder="text_encoder")
    vae = AutoencoderKL.from_pretrained(base_repo, subfolder="vae")
    unet = UNet2DConditionModel.from_pretrained(base_repo, subfolder="unet")
    weight_path = hub_file_download(weight_repo, IC_LIGHT_WEIGHT_FILE)
    try:
        with torch.no_grad():
            old_conv = unet.conv_in
            new_conv = torch.nn.Conv2d(
                8,
                old_conv.out_channels,
                old_conv.kernel_size,
                old_conv.stride,
                old_conv.padding,
            )
            new_conv.weight.zero_()
            new_conv.weight[:, :4, :, :].copy_(old_conv.weight)
            new_conv.bias = old_conv.bias
            unet.conv_in = new_conv
            del old_conv

        original_forward = unet.forward

        def hooked_forward(sample, timestep, encoder_hidden_states, **kwargs):  # noqa: ANN001
            concat = kwargs["cross_attention_kwargs"]["concat_conds"].to(sample)
            concat = torch.cat([concat] * (sample.shape[0] // concat.shape[0]), dim=0)
            merged = torch.cat([sample, concat], dim=1)
            kwargs["cross_attention_kwargs"] = {}
            return original_forward(merged, timestep, encoder_hidden_states, **kwargs)

        unet.forward = hooked_forward
        offsets = load_file(weight_path, device="cpu")
        state = unet.state_dict()
        for key in state.keys():
            if key in offsets:
                state[key] = state[key] + offsets[key]
        unet.load_state_dict(state, strict=True)
        del offsets, state

        scheduler = DPMSolverMultistepScheduler(
            num_train_timesteps=1000,
            beta_start=0.00085,
            beta_end=0.012,
            algorithm_type="sde-dpmsolver++",
            use_karras_sigmas=True,
            steps_offset=1,
        )
        pipe = StableDiffusionPipeline(
            vae=vae,
            text_encoder=text_encoder,
            tokenizer=tokenizer,
            unet=unet,
            scheduler=scheduler,
            safety_checker=None,
            requires_safety_checker=False,
            feature_extractor=None,
            image_encoder=None,
        ).to(device=target_device, dtype=dtype)
        pipe.set_progress_bar_config(disable=True)
        try:
            generator = torch.Generator(device=target_device).manual_seed(int(seed) & 0x7FFFFFFF)
            image_tensor = torch.from_numpy(
                np.asarray(conditioned, dtype=np.float32) / 127.5 - 1.0
            ).permute(2, 0, 1).unsqueeze(0).to(target_device, dtype=pipe.vae.dtype)
            with torch.no_grad():
                latent = pipe.vae.encode(image_tensor).latent_dist.mode() * pipe.vae.config.scaling_factor
            prompt_embeds, negative_embeds = pipe.encode_prompt(
                prompt=prompt or "natural light",
                device=target_device,
                num_images_per_prompt=1,
                do_classifier_free_guidance=True,
                negative_prompt="lowres, bad anatomy, bad hands, cropped, worst quality",
            )
            result = pipe(
                prompt_embeds=prompt_embeds,
                negative_prompt_embeds=negative_embeds,
                width=target_w,
                height=target_h,
                num_inference_steps=max(1, int(steps)),
                guidance_scale=float(guidance),
                generator=generator,
                cross_attention_kwargs={"concat_conds": latent},
                output_type="pil",
            ).images[0]
            return result.resize(rgb.size, Image.Resampling.LANCZOS)
        finally:
            del pipe
    finally:
        del unet, vae, text_encoder, tokenizer
        if use_cuda:
            torch.cuda.empty_cache()
