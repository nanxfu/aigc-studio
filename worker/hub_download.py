"""统一模型权重下载入口：支持 HuggingFace、HF 镜像（hf-mirror）与魔搭（ModelScope）。

设计原则：
1. 模块顶层只 import 标准库，不在模块加载期触发 huggingface_hub / modelscope；
2. 默认来源 `huggingface` 与 `hf-mirror` 直接走 `huggingface_hub`（保留单测的
   `sys.modules['huggingface_hub']` mock 生效点，并支持 `HF_ENDPOINT` 环境变量）；
3. `modelscope` 来源优先使用 `modelscope.hub` 拉取仓库文件/快照，当仓库为 HF Space
   或魔搭缺失/SDK 未安装时自动降级回 `huggingface_hub` 并打清晰告警，不阻断出图。
"""

from __future__ import annotations

import os

MODEL_SOURCES = ("huggingface", "hf-mirror", "modelscope")
DEFAULT_MODEL_SOURCE = "huggingface"
HF_MIRROR_ENDPOINT = "https://hf-mirror.com"
MODEL_SOURCE_ENV = "AIGC_MODEL_SOURCE"


def _short_err(exc: BaseException, limit: int = 300) -> str:
    text = f"{type(exc).__name__}: {exc}"
    return " ".join(text.split())[:limit]


def normalize_model_source(raw) -> str:  # noqa: ANN001
    """归一化下载源名称；空值或非法值回退默认值 `huggingface`。"""
    if not isinstance(raw, str):
        return DEFAULT_MODEL_SOURCE
    text = raw.strip().lower()
    return text if text in MODEL_SOURCES else DEFAULT_MODEL_SOURCE


def active_model_source() -> str:
    """读取当前生效的模型下载源（优先环境变量 AIGC_MODEL_SOURCE）。"""
    return normalize_model_source(os.environ.get(MODEL_SOURCE_ENV))


def apply_model_source(raw: str | None = None, *, log=print) -> str:  # noqa: ANN001
    """把模型下载源写入环境变量；选择 `hf-mirror` 时同步设置 `HF_ENDPOINT`。"""
    candidate = raw if (isinstance(raw, str) and raw.strip()) else os.environ.get(MODEL_SOURCE_ENV)
    source = normalize_model_source(candidate)
    os.environ[MODEL_SOURCE_ENV] = source
    if source == "hf-mirror":
        os.environ["HF_ENDPOINT"] = HF_MIRROR_ENDPOINT
        log(f"[config] 模型下载源：model_source={source}（HF_ENDPOINT={HF_MIRROR_ENDPOINT}）")
    elif source == "modelscope":
        log(f"[config] 模型下载源：model_source={source}（优先魔搭 ModelScope，缺失时自动回退 HuggingFace）")
    return source


def hub_file_download(
    repo_id: str,
    filename: str,
    *,
    revision: str | None = None,
    token: str | None = None,
    source: str | None = None,
    log=print,  # noqa: ANN001
) -> str:
    """按配置下载单个模型文件并返回本地文件路径。"""
    resolved = normalize_model_source(source) if source else active_model_source()
    if resolved == "modelscope":
        try:
            from modelscope.hub.file_download import model_file_download

            kwargs: dict = {"model_id": repo_id, "file_path": filename}
            if revision:
                kwargs["revision"] = revision
            return model_file_download(**kwargs)
        except Exception as exc:  # noqa: BLE001 - 缺包/仓不存在时回退 HF
            log(f"[load] WARN ModelScope 下载 {repo_id}/{filename} 失败（回退 HuggingFace）：{_short_err(exc)}")

    from huggingface_hub import hf_hub_download

    kwargs = {}
    if revision is not None:
        kwargs["revision"] = revision
    if token is not None:
        kwargs["token"] = token
    return hf_hub_download(repo_id=repo_id, filename=filename, **kwargs)


def hub_snapshot_download(
    repo_id: str,
    *,
    allow_patterns=None,  # noqa: ANN001
    revision: str | None = None,
    repo_type: str | None = None,
    source: str | None = None,
    log=print,  # noqa: ANN001
) -> str:
    """按配置下载仓库快照（可选 allow_patterns 白名单）并返回本地缓存目录。"""
    resolved = normalize_model_source(source) if source else active_model_source()
    patterns = list(allow_patterns) if allow_patterns else None
    if resolved == "modelscope" and not repo_type:
        try:
            from modelscope.hub.snapshot_download import snapshot_download as ms_snapshot_download

            kwargs: dict = {"model_id": repo_id}
            if patterns:
                kwargs["allow_patterns"] = patterns
            if revision:
                kwargs["revision"] = revision
            return ms_snapshot_download(**kwargs)
        except Exception as exc:  # noqa: BLE001 - 缺包/仓不存在时回退 HF
            log(f"[load] WARN ModelScope 仓库 {repo_id} 拉取失败（回退 HuggingFace）：{_short_err(exc)}")

    from huggingface_hub import snapshot_download

    kwargs = {}
    if patterns is not None:
        kwargs["allow_patterns"] = patterns
    if revision is not None:
        kwargs["revision"] = revision
    if repo_type is not None:
        kwargs["repo_type"] = repo_type
    return snapshot_download(repo_id=repo_id, **kwargs)
