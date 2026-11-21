"""二进制产物落盘：``result_mode=binary`` 时把 PNG 从结果里搬到临时目录。

为什么不让 ``/job`` 继续回 base64：大图（2560² PNG 约 7~10 MB）经 JSON + base64
会放大 33%，隧道/代理上还要整体缓冲一次；``/artifact`` 支持 Range 续传与 sha256
校验，视频/3D 时代也不用再改协议。

生命周期（协议 §3.3）：
1. 任务结束后把每张 ``image_b64`` 解码写进 ``<root>/<job_id>/<index>.png``；
2. ``/job`` 的 results 只保留元数据（``index/bytes/sha256/media_type`` + 原有尺寸字段）；
3. ``/artifact?id=&index=`` 读取文件并支持单段 Range；
4. JobStore 淘汰任务时删除对应目录；进程退出时清理整棵根目录。

安全：``<root>`` 只放本轮进程产生的临时文件；读取时二次校验路径必须落在根目录内，
``index`` 必须是已登记的结果序号，不接受任意文件名。
"""

from __future__ import annotations

import base64
import hashlib
import os
import shutil
import tempfile

# 可用环境变量覆盖（Docker 里挂 tmpfs 卷时用）；默认放系统临时目录，容器退出即丢。
ARTIFACT_DIR_ENV = "AIGC_WORKER_ARTIFACT_DIR"
ARTIFACT_ROOT_NAME = "aigc-worker-artifacts"
MEDIA_TYPE_PNG = "image/png"
# 与 JobStore 的 TTL 一致：产物只在任务记录存活期间可下载。
ARTIFACT_INDEX_MAX = 32
# 本进程创建过的任务目录：退出清理只删自己建的，避免同一台机器上多个 Worker
# （私有 Worker + 本机 GPU）互相清掉对方的产物。
_CREATED_DIRS: set[str] = set()


def artifact_root() -> str:
    override = str(os.environ.get(ARTIFACT_DIR_ENV) or "").strip()
    return override or os.path.join(tempfile.gettempdir(), ARTIFACT_ROOT_NAME)


def artifact_dir_of(job) -> str:  # noqa: ANN001
    """单个任务的产物目录（以 job id 命名；job id 已由契约限制为安全字符）。"""
    return os.path.join(artifact_root(), str(getattr(job, "job_id", "") or "unknown"))


def _write_bytes(path: str, data: bytes) -> None:
    """同目录临时文件 + rename，避免 Host 读到半截 PNG。"""
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".artifact-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def materialize_results(job, results: list[dict]) -> list[dict]:  # noqa: ANN001
    """按 job.result_mode 处理结果：binary 落盘并返回元数据，inline 原样返回。

    只在任务收尾时调用一次（部分进度仍是 base64，Host 在 done 之前不读 results）。
    单张写盘失败不拖垮整批：该张保留 ``image_b64`` 并标记 ``artifactError``，
    其它张仍按二进制交付；Host 会按「无 sha256」回退成 inline 解码。
    """
    mode = str(getattr(job, "result_mode", "inline") or "inline")
    if mode != "binary" or not results:
        return results
    directory = artifact_dir_of(job)
    output: list[dict] = []
    for index, item in enumerate(results):
        if not isinstance(item, dict):
            output.append(item)
            continue
        encoded = item.get("image_b64")
        if not isinstance(encoded, str) or not encoded:
            # 已经是元数据（例如重复调用）或异常条目：原样保留，幂等。
            output.append(item)
            continue
        try:
            data = base64.b64decode(encoded, validate=True)
            path = os.path.join(directory, f"{index}.png")
            _write_bytes(path, data)
        except Exception as exc:  # noqa: BLE001 - 单张失败不影响同批其它张
            fallback = dict(item)
            fallback["artifactError"] = f"{type(exc).__name__}: {exc}"
            output.append(fallback)
            continue
        meta = {key: value for key, value in item.items() if key != "image_b64"}
        meta.update(
            {
                "index": index,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "media_type": MEDIA_TYPE_PNG,
            }
        )
        output.append(meta)
    job.artifact_dir = directory
    _CREATED_DIRS.add(os.path.realpath(directory))
    return output


def artifact_file(job, index) -> dict | None:  # noqa: ANN001
    """读取一张产物；未启用 binary / 序号越界 / 文件缺失都返回 None（HTTP 层回 404）。"""
    directory = str(getattr(job, "artifact_dir", "") or "")
    if not directory:
        return None
    try:
        position = int(index)
    except (TypeError, ValueError):
        return None
    results = list(getattr(job, "results", []) or [])
    if position < 0 or position >= len(results) or position >= ARTIFACT_INDEX_MAX:
        return None
    item = results[position]
    if not isinstance(item, dict) or not item.get("sha256"):
        return None
    path = os.path.join(directory, f"{position}.png")
    root = os.path.realpath(artifact_root())
    real = os.path.realpath(path)
    if not (real == root or real.startswith(root + os.sep)):
        return None
    try:
        size = os.path.getsize(real)
    except OSError:
        return None
    return {
        "path": real,
        "bytes": int(item.get("bytes") or size),
        "sha256": str(item.get("sha256")),
        "media_type": str(item.get("media_type") or MEDIA_TYPE_PNG),
    }


def cleanup_job_artifacts(job) -> None:  # noqa: ANN001
    """删除单个任务的产物目录（淘汰 / 失败清理；best-effort）。"""
    directory = str(getattr(job, "artifact_dir", "") or "")
    if not directory:
        directory = artifact_dir_of(job) if getattr(job, "job_id", None) else ""
    if not directory:
        return
    root = os.path.realpath(artifact_root())
    real = os.path.realpath(directory)
    if not (real == root or real.startswith(root + os.sep)):
        return
    shutil.rmtree(real, ignore_errors=True)
    _CREATED_DIRS.discard(real)


def cleanup_all_artifacts() -> None:
    """进程退出时只清理本进程创建过的任务目录（best-effort）。

    不整棵删根目录：同一台机器可能同时跑私有 Worker 与本机 GPU，两个进程各有各的
    产物；删根目录会把对方的文件一起带走。
    """
    for directory in list(_CREATED_DIRS):
        shutil.rmtree(directory, ignore_errors=True)
        _CREATED_DIRS.discard(directory)
