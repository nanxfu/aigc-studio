"""请求校验：把 ``POST /generate`` 的 spec 归一成「工具 + 可执行的任务列表」。

为什么从 daemon.py 拆出来：这段逻辑只依赖「参数边界表」与常量，不碰 HTTP、状态对象与
模型，是纯函数，拆成模块后可以单独导入与测试（daemon 只保留同名薄包装） 。

依赖注入：参数边界 ``limits_for(name) -> dict``、单批任务上限 ``max_tasks``、loader 白名单
``supported_loaders`` 与 upscale 的内部 pipeline 描述全部由调用方传入，本模块不读 daemon 的
全局 ``CONFIG``，也不认识 ``worker.inference.registry``——白名单的唯一真源在注册表，校验器
只是消费一份名字元组；upscale 的 ``{"loader": "upscale", "base": ...}`` 由 daemon 从
``worker/inference/upscale.py`` 取常量注入，避免协议层与推理层反向依赖。

``tool`` 口径（INTERFACES §2.1）：缺省 ``generate``；远端实现 ``generate`` / ``upscale`` 与
资产工坊的两类 GPU 后处理算子 ``remove-bg`` / ``pbr``（``outpaint`` 在远端就是"带蒙版的普通
inpaint"，Host 不会把它下发成 tool），未知值 400。
``tool=upscale`` 时不读 ``pipeline``、不查 loader 白名单，只校验可选的 ``upscale.factor``；
任务由 daemon 在源图头校验完成后按源图宽高合成（见 :func:`build_upscale_task`）。
``tool=remove-bg / pbr`` 同样不读 ``pipeline``：源图按 ``limits.workshop.<tool>`` 的字节 /
长边边界校验（见 :func:`parse_workshop_reference`），任务由 :func:`build_workshop_task`
按源图宽高合成；pbr 的采样步数按 ``limits.workshop.pbr.steps`` 钳制。
``tool=mesh3d``（图生 3D，M4.4a）与它们同构，但源图**只收带透明通道的 PNG**、边界取
``limits.mesh3d``，并额外校验 ``targetFaces`` 与 ``texture``（见 :func:`validate_mesh3d_spec`）。
"""

from __future__ import annotations

import math
import random
import re

from worker.errors import RequestError
from worker.inference.reference_codec import (
    REFERENCE_IMAGE_FORMATS,
    _close_quietly,
    _decode_base64_field,
    _open_image_header,
)

# 远端实现的 tool 集合（与 shared/contract.js 的 PROTOCOL.daemon.requestTools 同口径）。
# 不要照抄 REQUEST_TOOLS：outpaint 只在 Host 侧存在，远端收到它说明调用方越过了契约。
REMOTE_TOOLS = ("generate", "upscale", "remove-bg", "pbr", "depth", "relight", "mesh3d")

# 资产工坊 GPU 后处理算子：与 upscale 同构（1 张源图、不读扩散 pipeline、固定 1 个任务）。
WORKSHOP_TOOLS = ("remove-bg", "pbr", "depth", "relight")

# 图生 3D（M4.4a）：独立 tool，不进 WORKSHOP_TOOLS——3D 是任务不是通道，
# 没有 ``channel`` 语义，也不写 ``meta.channels[]``。
MESH3D_TOOL = "mesh3d"

# 工坊算子在 daemon 内部的伪 loader 名：它不加载任何模型（推理实现在 worker/inference/
# game_ops.py），只是让 job.pipeline 里能安全存放模型 / 步数，且不会与真实 loader 冲突。
WORKSHOP_PIPELINE_LOADER = "workshop"

# 工坊算子的模型目录（远端侧兜底白名单）：模型 id 由 Host 契约 WORKSHOP.*.models 下发，
# Python 无法 import JS，这里登记同值映射（id → (HF 仓库, 是否已接入实现)）。
# 与 shared/contract.js 的 WORKSHOP.cutout.models / WORKSHOP.pbr.models 保持一致。
WORKSHOP_MODELS: dict[str, dict[str, tuple[str, bool]]] = {
    "remove-bg": {
        "rmbg-2.0": ("briaai/RMBG-2.0", True),
        "birefnet": ("ZhengPeng7/BiRefNet", True),
    },
    "pbr": {
        "marigold": ("prs-eth/marigold-iid-appearance-v1-1", True),
        "chord": ("ubisoft/ubisoft-laforge-chord", True),
    },
    "depth": {
        "da3-small": ("ByteDance-Seed/DA3-SMALL", True),
        "da3mono-large": ("depth-anything/DA3MONO-LARGE", True),
        "da3-large": ("depth-anything/DA3-LARGE", True),
        "moge-2-vitl": ("Ruicheng/moge-2-vitl-normal", True),
    },
    "relight": {
        "ic-light": ("lllyasviel/ic-light", True),
    },
}

# 缺省模型 id（与契约 WORKSHOP.cutout.defaultModel / WORKSHOP.pbr.defaultModel 同值）。
WORKSHOP_DEFAULT_MODEL = {
    "remove-bg": "birefnet",
    "pbr": "marigold",
    "depth": "da3mono-large",
    "relight": "ic-light",
}

# 工具名 → 契约 ``limits.workshop`` 下的边界块键名：remove-bg 对应 cutout，
# pbr 对应 pbr（Host 请求里的 tool 与契约常量名不同名，这里做唯一一次映射）。
WORKSHOP_LIMIT_KEYS = {
    "remove-bg": "cutout",
    "pbr": "pbr",
    "depth": "depth",
    "relight": "relight",
}


def normalize_tool(spec: dict) -> str:
    """归一请求里的可选 ``tool``：缺省 / 空串按 ``generate``，非法值 400。"""
    raw = spec.get("tool")
    if raw is None:
        return "generate"
    if not isinstance(raw, str):
        raise RequestError("tool 必须是字符串")
    text = raw.strip() or "generate"
    if text not in REMOTE_TOOLS:
        raise RequestError(
            f"未知 tool：{text!r}（支持 {', '.join(REMOTE_TOOLS)}）"
        )
    return text


def _int_param(value, field: str, low: int, high: int) -> int:  # noqa: ANN001
    if isinstance(value, bool):
        raise RequestError(f"{field} 必须是整数")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise RequestError(f"{field} 必须是整数") from None
    if number < low or number > high:
        raise RequestError(f"{field} 必须在 {low}..{high} 之间，收到 {number}")
    return number


_VALID_HF_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")


def _valid_pipeline_base(base: str) -> bool:
    text = base.strip()
    if not text or len(text) > 512 or any(ord(ch) < 32 for ch in text) or "\\" in text:
        return False
    if text.startswith("/"):
        parts = text.split("/")
        return any(parts[1:]) and not any(part in (".", "..") for part in parts[1:])
    if ".." in text:
        return False
    return bool(_VALID_HF_REPO_RE.match(text))


def _validate_upscale_factor(spec: dict, *, limits_for) -> None:  # noqa: ANN001
    """校验可选的 ``upscale.factor``：给了就必须等于契约里的 ``limits.upscale.factor``。

    为什么只认一个值：远端只实现 Real-ESRGAN x2（架构与权重都是固定的 x2），放行 4x
    只能靠"再放大一次"凑出来，质量与显存都不受控；x2/x4 的差异留给以后真正换模型。
    """
    raw = spec.get("upscale")
    if raw is None:
        return
    if not isinstance(raw, dict):
        raise RequestError("upscale 必须是对象")
    if raw.get("factor") is None:
        return
    value = raw.get("factor")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestError("upscale.factor 必须是数字")
    expected = limits_for("upscale").get("factor")
    if expected is None:
        raise RequestError("服务端契约缺少 limits.upscale.factor，无法校验放大倍数")
    if float(value) != float(expected):
        raise RequestError(f"upscale.factor 只支持 {expected}（收到 {value}）")


def build_upscale_task(width: int, height: int, *, limits_for) -> dict:  # noqa: ANN001
    """``tool=upscale`` 的执行任务：prompt 空、seed 随机、steps/cfg 0，宽高取源图实际尺寸。

    为什么由服务端合成而不是 Host 下发：超分没有采样参数，任务只用来把「源图宽高」带进
    job（结果里的 ``sourceWidth`` / ``sourceHeight`` 也从这里来）；让 Host 再拼一遍没有
    语义，还多一处与源图实际尺寸不同步的地方。
    """
    seed_limit = limits_for("seed")
    seed_max = int(seed_limit.get("max") or 2**31 - 1)
    return {
        "name": "01",
        "prompt": "",
        "negative_prompt": "",
        "seed": random.randint(0, seed_max),
        "width": max(1, int(width)),
        "height": max(1, int(height)),
        "steps": 0,
        "cfg": 0.0,
    }


# ---- 资产工坊 GPU 后处理（tool=remove-bg / pbr）------------------------------
#
# 与 upscale 同构的「提交期只读图片头」链路：
#  - 模型 id 白名单与缺省值见 WORKSHOP_MODELS / WORKSHOP_DEFAULT_MODEL；
#  - 源图字节 / 长边边界取 ``limits.workshop.<tool>``（cutout 与 pbr 是两条独立边界）；
#  - pbr 的采样步数取 ``limits.workshop.pbr.steps``（越界按契约的钳制语义自动校正）；
#  - 真正的模型加载 / 推理在 worker/daemon.py 的工坊执行分支，本模块不碰模型。


def _workshop_limits(tool: str, *, limits_for) -> dict:  # noqa: ANN001
    """取某个工坊算子的边界块（``limits.workshop.<cutout|pbr>``）；缺项按空表处理。"""
    workshop = limits_for("workshop")
    if not isinstance(workshop, dict):
        return {}
    key = WORKSHOP_LIMIT_KEYS.get(tool, tool)
    item = workshop.get(key)
    if not isinstance(item, dict):
        return {}
    # pbr 的边界块里 steps 是嵌套 dict，与 cutout 的扁平数值块并存，直接返回即可。
    return item


def _workshop_model(tool: str, requested) -> tuple[str, str, bool]:  # noqa: ANN001
    """归一工坊模型 id，返回 ``(model_id, hf_repo, implemented)``；未知 id 抛 RequestError。"""
    catalog = WORKSHOP_MODELS.get(tool) or {}
    if not catalog:
        raise RequestError(f"工坊算子 {tool!r} 没有登记模型目录")
    raw = requested
    if raw is None or raw == "":
        model_id = WORKSHOP_DEFAULT_MODEL.get(tool) or next(iter(catalog))
    elif not isinstance(raw, str):
        raise RequestError("workshop.model 必须是字符串")
    else:
        model_id = raw.strip()
    entry = catalog.get(model_id)
    if entry is None:
        raise RequestError(
            f"{tool} 的模型只支持 {', '.join(catalog)}（收到 {model_id!r}）"
        )
    repo, implemented = entry
    return model_id, repo, implemented


def _workshop_steps(tool: str, raw, *, limits_for) -> int:  # noqa: ANN001
    """工坊采样步数：pbr / relight 按各自契约钳制；其余工具没有步数语义返回 0。"""
    if tool not in ("pbr", "relight"):
        return 0
    spec = _workshop_limits(tool, limits_for=limits_for).get("steps")
    if not isinstance(spec, dict):
        spec = {}
    low = int(spec.get("min") or 1)
    high = int(spec.get("max") or 8)
    default = int(spec.get("default") or low)
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise RequestError("workshop.steps 必须是整数")
    if not float(raw).is_integer():
        raise RequestError("workshop.steps 必须是整数")
    return max(low, min(high, int(raw)))


def parse_workshop_reference(raw, *, tool: str, limits_for) -> dict:  # noqa: ANN001
    """``tool=remove-bg / pbr`` 的源图提交期校验：只读图片头，归一成 ``{image_bytes,width,height}``。

    与 ``parse_upscale_reference`` 的差别：
    - 边界取 ``limits.workshop.<tool>``（maxBytes / maxInputEdge / minInputEdge），
      不是参考图那套 ``limits.reference``；cutout 与 pbr 的输入上限不同（1536 vs 1024）；
    - 不接受蒙版与 strength：工坊算子没有「重绘区域」语义。

    返回的 ``image_bytes`` 供执行期 ``decode_reference_image`` 再完整解码一次。
    """
    if raw is None:
        raise RequestError(f"tool={tool} 需要 reference.image_b64")
    if not isinstance(raw, dict):
        raise RequestError("reference 必须是对象")
    if raw.get("mask_b64") is not None:
        raise RequestError(f"tool={tool} 不支持蒙版（reference.mask_b64 必须省略）")
    limits = _workshop_limits(tool, limits_for=limits_for)
    max_bytes = int(limits.get("maxBytes") or 0)
    max_input_edge = int(limits.get("maxInputEdge") or 0)
    min_input_edge = int(limits.get("minInputEdge") or 0)
    data = _decode_base64_field(
        raw.get("image_b64"),
        "reference.image_b64",
        max_bytes,
        label="源图",
    )
    image = _open_image_header(
        bytes(data),
        formats=REFERENCE_IMAGE_FORMATS,
        label="源图",
        min_edge=min_input_edge,
    )
    try:
        width, height = image.size
    finally:
        _close_quietly(image)
    width, height = int(width), int(height)
    long_edge = max(width, height)
    if max_input_edge > 0 and long_edge > max_input_edge:
        raise RequestError(
            f"源图长边 {long_edge}px 超过 {tool} 的输入上限 {max_input_edge}px"
            f"（contract.limits.workshop.{tool}.maxInputEdge），请先缩小源图再重试"
        )
    return {"image_bytes": data, "width": width, "height": height}


def build_workshop_task(
    width: int,
    height: int,
    *,
    steps: int = 0,
    limits_for,
    prompt: str = "",
    cfg: float = 0.0,
    seed: int | None = None,
) -> dict:  # noqa: ANN001
    """``tool=remove-bg / pbr`` 的执行任务：prompt 空、宽高取源图实际尺寸、cfg=0。

    工坊算子没有采样参数语义（steps 只对 pbr 的记录意义，透传用于日志 / 结果回显）；
    seed 与扩散出图同口径随机，便于结果结构保持同形。
    """
    seed_limit = limits_for("seed")
    seed_max = int(seed_limit.get("max") or 2**31 - 1)
    resolved_seed = random.randint(0, seed_max) if seed is None else max(0, min(seed_max, int(seed)))
    return {
        "name": "01",
        "prompt": str(prompt or ""),
        "negative_prompt": "",
        "seed": resolved_seed,
        "width": max(1, int(width)),
        "height": max(1, int(height)),
        "steps": max(0, int(steps)),
        "cfg": float(cfg or 0.0),
    }


def _parse_workshop_spec(
    spec: dict,
    tool: str,
    *,
    limits_for,
) -> tuple[str, str, int, bool, dict]:
    """解析工坊请求里的模型与步数：兼容 ``workshop`` 块与顶层 ``model/steps`` 两种写法。

    返回 ``(model_id, hf_repo, steps, implemented, options)``；未知模型 / 非法步数直接 400。
    ``options`` 目前只有 relight 使用：提示词、CFG、种子与预设；depth 为空字典。
    """
    workshop = spec.get("workshop")
    if workshop is not None and not isinstance(workshop, dict):
        raise RequestError("workshop 必须是对象")
    workshop = workshop or {}
    # Host 会同时下发顶层 model 与 workshop.model（同一值）；两份都在却不一致说明调用方
    # 拼错了载荷，400 比「取其中一个静默执行」更容易定位问题。
    top_model = spec.get("model")
    nested_model = workshop.get("model")
    if top_model is not None and nested_model is not None:
        if str(top_model).strip() != str(nested_model).strip():
            raise RequestError(
                f"model（{top_model}）与 workshop.model（{nested_model}）不一致"
            )
    model_id, repo, implemented = _workshop_model(
        tool,
        nested_model if nested_model is not None else top_model if top_model is not None else spec.get("modelId"),
    )
    steps = _workshop_steps(
        tool,
        workshop.get("steps", spec.get("steps")),
        limits_for=limits_for,
    )
    options: dict = {}
    if tool == "relight":
        options_spec = workshop.get("options")
        if options_spec is None:
            options_spec = spec.get("options")
        if options_spec is not None and not isinstance(options_spec, dict):
            raise RequestError("workshop.options 必须是对象")
        options_spec = options_spec or {}
        prompt = options_spec.get("prompt", workshop.get("prompt", spec.get("prompt", "")))
        if not isinstance(prompt, str):
            raise RequestError("relight.prompt 必须是字符串")
        max_chars = int(
            (_workshop_limits(tool, limits_for=limits_for).get("maxPromptChars") or 400)
        )
        prompt = prompt.strip()
        if len(prompt) > max_chars:
            raise RequestError(f"relight.prompt 最多 {max_chars} 个字符")
        cfg_spec = _workshop_limits(tool, limits_for=limits_for).get("cfg")
        if not isinstance(cfg_spec, dict):
            cfg_spec = {}
        cfg_low = float(cfg_spec.get("min") or 1)
        cfg_high = float(cfg_spec.get("max") or 7)
        cfg_default = float(cfg_spec.get("default") or 2)
        raw_cfg = options_spec.get("cfg", cfg_default)
        if isinstance(raw_cfg, bool) or not isinstance(raw_cfg, (int, float)):
            raise RequestError("relight.cfg 必须是数字")
        options["cfg"] = max(cfg_low, min(cfg_high, float(raw_cfg)))
        raw_seed = options_spec.get("seed")
        if raw_seed is not None:
            if isinstance(raw_seed, bool) or not isinstance(raw_seed, int):
                raise RequestError("relight.seed 必须是整数")
            seed_max = int(limits_for("seed").get("max") or 2**31 - 1)
            options["seed"] = max(0, min(seed_max, raw_seed))
        preset = options_spec.get("preset", "")
        if preset is not None and not isinstance(preset, str):
            raise RequestError("relight.preset 必须是字符串")
        options["preset"] = str(preset or "").strip()[:80]
        options["prompt"] = prompt
    return model_id, repo, steps, implemented, options


def validate_workshop_spec(spec: dict, tool: str, *, limits_for) -> tuple[dict, str, list[dict]]:  # noqa: ANN001
    """``tool=remove-bg / pbr`` 的请求校验：不读 pipeline，合成 1 个工坊任务。

    返回 ``(pipeline_spec, model_id, tasks)``，与 ``validate_generate_spec`` 的生成分支同形。
    pipeline_spec 是 daemon 内部的伪 loader 描述：``workshop`` 块里存模型 id / HF 仓库 /
    是否已接入实现 / pbr 步数，执行分支（``run_workshop_job``）只读它，不加载扩散模型。
    """
    model_id, repo, steps, implemented, options = _parse_workshop_spec(
        spec,
        tool,
        limits_for=limits_for,
    )
    reference = parse_workshop_reference(spec.get("reference"), tool=tool, limits_for=limits_for)
    task = build_workshop_task(
        reference["width"],
        reference["height"],
        steps=steps,
        limits_for=limits_for,
        prompt=options.get("prompt", ""),
        cfg=options.get("cfg", 0.0),
        seed=options.get("seed"),
    )
    pipeline = {
        "loader": WORKSHOP_PIPELINE_LOADER,
        "base": tool,
        "workshop": {
            "model": model_id,
            "repo": repo,
            "steps": steps,
            "implemented": implemented,
            "options": options,
        },
    }
    return pipeline, repo, [task]


# ---- 图生 3D（tool=mesh3d，M4.4a）--------------------------------------------
#
# 与 upscale / 工坊算子同构的「提交期只读图片头」链路，三处差别：
#  - 源图只收**带透明通道的 PNG**：图生 3D 对背景极敏感，脏背景会被直接烧进网格，
#    所以宁可提交期 400 让用户先过一遍去背，也不放行 RGB / JPEG 硬跑；
#  - 边界取 ``limits.mesh3d``（源图长边 / 字节 / 目标面数 / texture 能力），不是工坊那套；
#  - 产物是一个二进制 ``.glb``（不是图片），执行期不走 channel 编码。

# daemon 内部的伪 loader 名：让提交期能按 loader 分流到 3D 源图校验，
# 且不会与真实扩散 loader 冲突（与 WORKSHOP_PIPELINE_LOADER 同一手法）。
MESH3D_PIPELINE_LOADER = "mesh3d"

# 远端模型目录（与契约 ``MESH3D.models`` 同值）：id → (HF 仓库, 是否支持贴图, 是否已接入实现)。
# M4.4a-1 只落契约与链路，真实几何推理在 M4.4a-2 接入；接入前 ``implemented=False``，
# 执行期给出「尚未接入」的明确失败，而不是让请求撞到未知 loader 后报内部错误。
MESH3D_MODELS: dict[str, tuple[str, bool, bool]] = {
    "hunyuan3d-2mini": ("tencent/Hunyuan3D-2mini", False, False),
}

# 缺省模型 id（与契约 MESH3D.defaultModel 同值）。
MESH3D_DEFAULT_MODEL = "hunyuan3d-2mini"

# PNG 里带透明语义的像素模式：真彩 / 灰度 + Alpha，以及调色板 / 真彩 + tRNS。
_ALPHA_MODES = frozenset({"RGBA", "LA", "PA"})
_TRANSPARENCY_MODES = frozenset({"P", "RGB"})


def _mesh3d_limits(*, limits_for) -> dict:  # noqa: ANN001
    """``limits.mesh3d`` 边界块；缺项按空表处理（旧契约未下发时也能量出清楚的错误）。"""
    spec = limits_for("mesh3d")
    return spec if isinstance(spec, dict) else {}


def _mesh3d_model(requested, *, limits_for) -> tuple[str, str, bool]:  # noqa: ANN001
    """归一 3D 模型 id，返回 ``(model_id, hf_repo, texture_supported)``；未知 id 抛 RequestError。"""
    catalog = dict(MESH3D_MODELS)
    # 契约下发的模型目录优先：远端登记表是兜底，两边不一致时以 Host 下发的为准。
    for item in _mesh3d_limits(limits_for=limits_for).get("models") or []:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        repo = str(item.get("repo") or "").strip()
        if model_id and repo:
            fallback = catalog.get(model_id)
            catalog[model_id] = (repo, bool(item.get("texture")), fallback[2] if fallback else False)
    if not catalog:
        raise RequestError("图生 3D 没有登记模型目录（contract.limits.mesh3d.models）")
    if requested is None or requested == "":
        model_id = MESH3D_DEFAULT_MODEL if MESH3D_DEFAULT_MODEL in catalog else next(iter(catalog))
    elif not isinstance(requested, str):
        raise RequestError("mesh3d.model 必须是字符串")
    else:
        model_id = requested.strip()
    entry = catalog.get(model_id)
    if entry is None:
        raise RequestError(
            f"mesh3d 的模型只支持 {', '.join(catalog)}（收到 {model_id!r}）"
        )
    repo, texture_supported, _implemented = entry
    return model_id, repo, texture_supported


def _mesh3d_target_faces(raw, *, limits_for) -> int:  # noqa: ANN001
    """目标面数：按契约 ``limits.mesh3d.targetFaces`` 钳制（越界自动校正，与其它参数一致）。"""
    spec = _mesh3d_limits(limits_for=limits_for).get("targetFaces")
    if not isinstance(spec, dict):
        spec = {}
    low = int(spec.get("min") or 1000)
    high = int(spec.get("max") or 200000)
    default = int(spec.get("default") or low)
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise RequestError("mesh3d.targetFaces 必须是整数")
    if not float(raw).is_integer():
        raise RequestError("mesh3d.targetFaces 必须是整数")
    return max(low, min(high, int(raw)))


def _image_has_alpha(image) -> bool:  # noqa: ANN001
    """只读头部判断图片是否带透明通道：RGBA / LA / PA，或 P / RGB + tRNS。"""
    mode = str(getattr(image, "mode", "") or "").upper()
    if mode in _ALPHA_MODES:
        return True
    if mode not in _TRANSPARENCY_MODES:
        return False
    info = getattr(image, "info", None)
    return isinstance(info, dict) and info.get("transparency") is not None


def parse_mesh3d_reference(raw, *, limits_for) -> dict:  # noqa: ANN001
    """``tool=mesh3d`` 的源图提交期校验：只收带 Alpha 的 PNG，归一回 ``{image_bytes,width,height}``。

    为什么不接受 JPEG / RGB PNG：图生 3D 的输入被视为「孤立物体」，背景会被 VAE 当成
    几何的一部分；没有 alpha 就无从裁剪，硬跑只会得到一坨带背景的网格。这里提前 400 并
    在文案里指出「先去背」，比执行期失败可解释得多。

    ``image_bytes`` 供执行期 ``decode_reference_image`` 再完整解码一次。
    """
    if raw is None:
        raise RequestError("tool=mesh3d 需要 reference.image_b64")
    if not isinstance(raw, dict):
        raise RequestError("reference 必须是对象")
    if raw.get("mask_b64") is not None:
        raise RequestError("tool=mesh3d 不支持蒙版（reference.mask_b64 必须省略）")
    limits = _mesh3d_limits(limits_for=limits_for)
    max_bytes = int(limits.get("maxBytes") or 0)
    max_input_edge = int(limits.get("maxInputEdge") or 0)
    min_input_edge = int(limits.get("minInputEdge") or 0)
    data = _decode_base64_field(
        raw.get("image_b64"),
        "reference.image_b64",
        max_bytes,
        label="源图",
    )
    image = _open_image_header(
        bytes(data),
        formats=("PNG",),
        label="源图",
        min_edge=min_input_edge,
    )
    try:
        if not _image_has_alpha(image):
            raise RequestError(
                "图生 3D 的源图必须是带透明通道的 PNG（RGBA）：请先在工坊「抹除背景」"
                "或本机去背后再提交"
            )
        width, height = image.size
    finally:
        _close_quietly(image)
    width, height = int(width), int(height)
    long_edge = max(width, height)
    if max_input_edge > 0 and long_edge > max_input_edge:
        raise RequestError(
            f"源图长边 {long_edge}px 超过 mesh3d 的输入上限 {max_input_edge}px"
            f"（contract.limits.mesh3d.maxInputEdge），请先缩小源图再重试"
        )
    return {"image_bytes": data, "width": width, "height": height}


def build_mesh3d_task(width: int, height: int, *, limits_for) -> dict:  # noqa: ANN001
    """``tool=mesh3d`` 的执行任务：prompt 空、cfg=0、宽高取源图实际尺寸。

    与 ``build_workshop_task`` 同形（Job 只用于携带源图尺寸与随机种子），网格参数
    （目标面数 / 是否贴图）放在 pipeline 的 ``mesh3d`` 块里，不进任务。
    """
    seed_limit = limits_for("seed")
    seed_max = int(seed_limit.get("max") or 2**31 - 1)
    return {
        "name": "01",
        "prompt": "",
        "negative_prompt": "",
        "seed": random.randint(0, seed_max),
        "width": max(1, int(width)),
        "height": max(1, int(height)),
        "steps": 0,
        "cfg": 0.0,
    }


def validate_mesh3d_spec(spec: dict, *, limits_for) -> tuple[dict, str, list[dict]]:  # noqa: ANN001
    """``tool=mesh3d`` 的请求校验：不读 pipeline，合成 1 个 3D 任务。

    返回 ``(pipeline_spec, model_id, tasks)``，与 ``validate_generate_spec`` 的生成分支同形。
    pipeline_spec 是 daemon 内部的伪 loader 描述：``mesh3d`` 块里存模型 / HF 仓库 /
    目标面数 / 是否贴图 / 是否已接入实现，执行分支只读它。
    """
    block = spec.get("mesh3d")
    if block is not None and not isinstance(block, dict):
        raise RequestError("mesh3d 必须是对象")
    block = block or {}
    # 与工坊算子同一口径：顶层 model 与 mesh3d.model 同时给出却不一致，说明调用方拼错了载荷。
    top_model = spec.get("model")
    nested_model = block.get("model")
    if top_model is not None and nested_model is not None:
        if str(top_model).strip() != str(nested_model).strip():
            raise RequestError(f"model（{top_model}）与 mesh3d.model（{nested_model}）不一致")
    requested_model = nested_model if nested_model is not None else top_model
    if requested_model is None:
        requested_model = spec.get("modelId")
    model_id, repo, texture_supported = _mesh3d_model(requested_model, limits_for=limits_for)

    raw_texture = block.get("texture", spec.get("texture"))
    if raw_texture is None:
        texture = False
    elif isinstance(raw_texture, bool):
        texture = raw_texture
    else:
        raise RequestError("mesh3d.texture 必须是布尔值")
    if texture and not texture_supported:
        raise RequestError(
            f"模型 {model_id} 只输出几何白模（texture=false）："
            "带贴图的 PBR 需要在 24GB 容器里用 Hunyuan3D-2.1 / TRELLIS.2（见 M4.4b）"
        )

    target_faces = _mesh3d_target_faces(
        block.get("targetFaces", spec.get("targetFaces")),
        limits_for=limits_for,
    )
    reference = parse_mesh3d_reference(spec.get("reference"), limits_for=limits_for)
    task = build_mesh3d_task(reference["width"], reference["height"], limits_for=limits_for)
    implemented = MESH3D_MODELS.get(model_id, ("", False, False))[2]
    pipeline = {
        "loader": MESH3D_PIPELINE_LOADER,
        "base": MESH3D_TOOL,
        "mesh3d": {
            "model": model_id,
            "repo": repo,
            "targetFaces": target_faces,
            "texture": texture,
            "implemented": implemented,
        },
    }
    return pipeline, repo, [task]


def _validate_reference_shapes(spec: dict, tool: str) -> None:
    """拦截参考图相关字段的互斥关系（阶段十五 Phase C1）。

    同一个请求只能走一条参考路径：

    - ``reference``：单图垫图重绘 / 局部重绘（img2img，尺寸跟随参考图，吃 strength）；
    - ``referenceImages``：模型原生参考生图（基础管线 ``image=[PIL...]``，宽高取请求值）。

    两者同时出现说明调用方把两种语义混在了一起，必须 400 而不是挑一个静默忽略；
    ``referenceImages`` 只对 ``tool=generate`` 生效（upscale 的源图走 ``reference``）。
    """
    has_reference = spec.get("reference") is not None
    has_reference_images = spec.get("referenceImages") is not None
    if has_reference_images and tool != "generate":
        raise RequestError("referenceImages 只对 tool=generate 生效")
    if has_reference and has_reference_images:
        raise RequestError(
            "reference 与 referenceImages 不能同时使用："
            "单图垫图重绘与原生参考生图是两条互斥路径"
        )


def validate_generate_spec(  # noqa: ANN001
    spec,
    *,
    limits_for,
    max_tasks,
    supported_loaders,
    upscale_pipeline: dict,
    upscale_model_id: str,
):
    """把请求体归一成 ``(pipeline_spec, model_id, tasks, tool)``。

    ``tool=generate`` 时逐字保持改造前行为（pipeline / loader 白名单 / tasks 校验全部照旧）；
    ``tool=upscale`` 时返回 daemon 内部合成的 pipeline 描述、模型 id 与**空任务列表**——
    任务要等源图头校验拿到宽高后才能合成（见 ``build_upscale_task``），由 HTTP 层补上。
    """
    if not isinstance(spec, dict):
        raise RequestError("请求体必须是 JSON 对象")

    tool = normalize_tool(spec)
    _validate_reference_shapes(spec, tool)
    if tool in WORKSHOP_TOOLS:
        # 工坊 GPU 后处理（remove-bg / pbr）：与 upscale 同样不读 pipeline / tasks，
        # 源图头校验 + 任务合成都在本分支完成（步数与模型白名单见 validate_workshop_spec）。
        pipeline, model_id, tasks = validate_workshop_spec(spec, tool, limits_for=limits_for)
        return pipeline, model_id, tasks, tool
    if tool == MESH3D_TOOL:
        # 图生 3D（M4.4a）：同样不读扩散 pipeline，源图必须是带 Alpha 的 PNG。
        pipeline, model_id, tasks = validate_mesh3d_spec(spec, limits_for=limits_for)
        return pipeline, model_id, tasks, tool
    if tool == "upscale":
        _validate_upscale_factor(spec, limits_for=limits_for)
        # 不读请求里的 pipeline：Host 不会下发，客户端硬塞也只会被忽略（超分没有底座概念）。
        pipeline = dict(upscale_pipeline)
        return pipeline, str(upscale_model_id), [], tool

    pipeline_spec = spec.get("pipeline")
    if not isinstance(pipeline_spec, dict):
        raise RequestError("缺少 pipeline 对象")
    loader = str(pipeline_spec.get("loader") or "").strip()
    allowed = tuple(supported_loaders)
    if loader not in allowed:
        raise RequestError(f"未知 loader：{loader!r}（支持 {', '.join(allowed)}）")
    base = pipeline_spec.get("base")
    if not isinstance(base, str) or not base.strip():
        raise RequestError("pipeline.base 必须是非空字符串")
    if not _valid_pipeline_base(base):
        raise RequestError("pipeline.base 必须是 owner/name 仓库标识或绝对路径")

    tasks_raw = spec.get("tasks")
    if not isinstance(tasks_raw, list) or not tasks_raw:
        raise RequestError("tasks 必须是非空数组")
    if len(tasks_raw) > max_tasks:
        raise RequestError(f"单次请求最多 {max_tasks} 个任务")

    width_limit = limits_for("width")
    height_limit = limits_for("height")
    steps_limit = limits_for("steps")
    cfg_limit = limits_for("cfg")
    seed_limit = limits_for("seed")
    prompt_max = int(limits_for("prompt").get("maxChars") or 0)
    neg_max = int(limits_for("negativePrompt").get("maxChars") or 0)
    width_min, width_max = int(width_limit["min"]), int(width_limit["max"])
    height_min, height_max = int(height_limit["min"]), int(height_limit["max"])
    width_step = int(width_limit.get("step") or 8)
    height_step = int(height_limit.get("step") or 8)
    steps_min, steps_max = int(steps_limit["min"]), int(steps_limit["max"])
    cfg_min, cfg_max = cfg_limit["min"], cfg_limit["max"]
    seed_max = int(seed_limit.get("max") or 2**31 - 1)

    model_id = spec.get("modelId") or spec.get("model_id") or base
    tasks: list[dict] = []
    for index, raw in enumerate(tasks_raw):
        if not isinstance(raw, dict):
            raise RequestError(f"tasks[{index}] 必须是对象")
        prompt = raw.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise RequestError(f"tasks[{index}].prompt 必填")
        prompt = prompt.strip()
        if prompt_max > 0 and len(prompt) > prompt_max:
            raise RequestError(f"tasks[{index}].prompt 最长 {prompt_max} 个字符")
        neg_raw = raw.get("negative_prompt")
        if neg_raw is None:
            neg_prompt = ""
        elif not isinstance(neg_raw, str):
            raise RequestError(f"tasks[{index}].negative_prompt 必须是字符串")
        else:
            neg_prompt = neg_raw.strip()
        if neg_max > 0 and len(neg_prompt) > neg_max:
            raise RequestError(f"tasks[{index}].negative_prompt 最长 {neg_max} 个字符")
        width = _int_param(raw.get("width", 1024), f"tasks[{index}].width", width_min, width_max)
        height = _int_param(raw.get("height", 1024), f"tasks[{index}].height", height_min, height_max)
        steps = _int_param(raw.get("steps", 4), f"tasks[{index}].steps", steps_min, steps_max)
        raw_cfg = raw.get("cfg", 0.0)
        if isinstance(raw_cfg, bool):
            raise RequestError(f"tasks[{index}].cfg 必须是数字")
        try:
            cfg = float(raw_cfg)
        except (TypeError, ValueError):
            raise RequestError(f"tasks[{index}].cfg 必须是数字") from None
        if not math.isfinite(cfg):
            raise RequestError(f"tasks[{index}].cfg 必须是有限数字")
        if cfg < cfg_min or cfg > cfg_max:
            raise RequestError(f"tasks[{index}].cfg 必须在 {cfg_min}..{cfg_max} 之间")
        raw_seed = raw.get("seed", -1)
        if isinstance(raw_seed, bool):
            raise RequestError(f"tasks[{index}].seed 必须是整数")
        try:
            seed = int(raw_seed)
        except (TypeError, ValueError):
            raise RequestError(f"tasks[{index}].seed 必须是整数") from None
        if seed < 0:
            seed = random.randint(0, seed_max)
        elif seed > seed_max:
            raise RequestError(f"tasks[{index}].seed 必须不超过 {seed_max}")
        tasks.append(
            {
                "name": str(raw.get("name") or f"{index + 1:02d}"),
                "prompt": prompt,
                "negative_prompt": neg_prompt,
                "seed": seed,
                "width": width - width % width_step,
                "height": height - height % height_step,
                "steps": steps,
                "cfg": cfg,
            }
        )
    return pipeline_spec, str(model_id), tasks, tool
