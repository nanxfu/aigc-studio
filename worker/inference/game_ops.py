"""游戏素材与 UI 专用确定性算子及轻量后处理基础设施（M4 路线 A）。

定位与许可原则：
- **纯 CPU 确定性算子**：像素网格对齐（Pixel-Snap + 调色盘量化）、序列帧图集切片
  （Sprite Sheet + Atlas JSON）、四方连续无缝检测与修复（Seamless Check & Blend）、
  矢量 SVG 转换（``VTracer``），零显存占用且响应 < 100ms。
- **效果优先的轻量 GPU 算子（界面显式标识协议属性）**：
  - 透明抠图兼容 ``RMBG-2.0``（``briaai/RMBG-2.0``，非商用）与 ``BiRefNet``（``ZhengPeng7/BiRefNet``，MIT）；
  - PBR 材质拆解提供 ``diffusers`` 原生 ``MarigoldIntrinsicsPipeline`` + ``MarigoldNormalsPipeline``，并预留接入 ``Ubisoft CHORD``（研究许可）的同构输出契约；
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
    model.to(target_device).eval()

    rgb = img.convert("RGB")
    orig_size = rgb.size
    transform = transforms.Compose(
        [
            transforms.Resize(input_size),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    tensor = transform(rgb).unsqueeze(0).to(target_device)

    with torch.no_grad():
        preds = model(tensor)[-1].sigmoid().cpu()

    mask = transforms.ToPILImage()(preds[0].squeeze()).resize(orig_size, Image.Resampling.BILINEAR)
    out = rgb.copy()
    out.putalpha(mask)
    return out


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
    iid_out = iid_pipe(rgb, num_inference_steps=steps)

    result: dict[str, object] = {
        "albedo": iid_out.prediction[0],
        "roughness": iid_out.prediction[1],
        "metallic": iid_out.prediction[2],
    }

    if include_normals:
        del iid_pipe
        if target_device.startswith("cuda"):
            torch.cuda.empty_cache()
        norm_pipe = MarigoldNormalsPipeline.from_pretrained(
            normals_repo,
            variant="fp16" if dtype == torch.float16 else None,
            torch_dtype=dtype,
        ).to(target_device)
        norm_out = norm_pipe(rgb, num_inference_steps=steps)
        result["normal"] = norm_pipe.image_processor.visualize_normals(norm_out.prediction)[0]

    return result
