"""HTTP 传输层：路由分派、Bearer 鉴权与「异常 → 状态码」映射。

为什么从 daemon.py 拆出来：``DaemonHandler`` 是协议出口（``docs/SPEC.md`` 的每条路由都在
这里落成状态码），却和模型加载、缓存清理、进程生命周期挤在同一个 2k 行模块里——改一行
路由要先读懂整个守护进程。搬到独立模块后，本文件只做四件事：

1. 路径分派（``/health`` / ``/logs`` / ``/job`` / ``/generate`` / ``/shutdown``）；
2. Bearer 鉴权（``hmac.compare_digest``；无 token 时按 ``allow_no_auth`` 决定是否放行）；
   鉴权通过即通知生命周期层「Host 已接管」（``mark_claimed``，取消启动后的 claim 看门狗）；
3. 请求体解码与体积闸门（上限来自注入契约，见 ``config.request_body_limit``）；
4. ``/generate`` 按 ``tool`` 分派：``generate`` 校验 pipeline / loader 与 tasks（含 img2img /
   inpaint 的参考图），``upscale`` 只校验源图并合成 1 条任务——两条路都走同一个异步 job 协议；
5. 把 ``RequestError`` / ``QueueFullError`` 映射成 400 / 429，其余异常交给调用方分类。

**协作者一律从 :class:`HttpApi` 取，本模块不 import daemon**：daemon 反向依赖本模块，
再反向导入就是循环。更重要的是，按**模块属性**（lambda 延迟解析）取协作者而不是在
import 时绑死函数对象，才能让单测的 ``mock.patch.object(daemon, "submit_job")`` 生效
——构造时把实现绑死会让断言静默测到旧对象（架构规格 §1.3.6 点名的假绿陷阱）。
``HttpApi`` 的每个可调用字段都由 Composition Root 用 lambda 装配（见 ``daemon.HTTP_API``）。

**锁顺序（规格 §5.8）**：``/health`` 的「持锁取样 → 释放 → 取队列深度」由注入的
``health_payload`` 自己保证，本模块只负责调用；``/generate`` 读阶段与刷新活动时间都用
注入的 ``state_lock``，**不在持锁期间**调用 ``submit_job``（它内部要拿 JOB_LOCK，
反向嵌套会与 ``_finish_job`` 的 JOB_LOCK → STATE_LOCK 死锁）。任务表只经
``get_job`` / ``job_payload`` / ``submit_job`` 三个语义入口访问。
"""

from __future__ import annotations

import hmac
import ipaddress
import json
import os
import queue
import socket
import threading
import time
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from log_ring import _ORIG_STDERR, log
from worker.errors import QueueFullError, RequestError
from worker.text import short


@dataclass(frozen=True)
class HttpApi:
    """handler 需要的全部协作者（Composition Root 装配，handler 不持有任何全局）。

    ``config`` / ``state`` 是**活对象**而不是值的拷贝：单测在用例里就地改
    ``CONFIG.auth_token``、``STATE.phase``，handler 必须读到最新值。其余字段是
    可调用对象，调用时机由 handler 决定（鉴权在请求头解析后、体积闸门在读完
    Content-Length 后、入队在请求体校验通过后）。
    """

    config: Any
    state: Any
    state_lock: Any
    request_body_limit: Callable[[], int]
    health_payload: Callable[[], dict]
    log_since: Callable[[int], tuple[list[str], int]]
    get_job: Callable[[str], Any]
    job_payload: Callable[[Any], dict]
    submit_job: Callable[..., Any]
    validate_generate_spec: Callable[[Any], Any]
    parse_reference_spec: Callable[[Any, dict], Any]
    # 原生参考生图（supportsReference）的 job 级图片列表校验：与 reference 互斥，
    # 只读图片头；完整解码留到执行期（见 worker/inference/reference_codec.py）。
    parse_reference_images: Callable[[Any, dict], Any]
    # tool=upscale 的源图校验与任务合成：upscale 不读 pipeline、不查 loader 白名单，
    # 任务要等源图头校验拿到宽高后才能拼出来（见 worker/transport/validator.py）。
    parse_upscale_reference: Callable[[Any], Any]
    build_upscale_task: Callable[[int, int], dict]
    normalize_job_id: Callable[[Any], Any]
    request_shutdown: Callable[[], None]
    cleanup_before_exit: Callable[[], None]
    # 鉴权通过时调用：标记 Host 已接管，取消启动后的 claim 看门狗（幂等）。
    mark_claimed: Callable[[], None]
    iso_time: Callable[[float], str]
    version: Callable[[], str]
    # ---- 协议 v2（M3.1）----
    # 二进制产物查询：``(job_id, index) -> {path, bytes, sha256, media_type} | None``。
    # 旧 daemon / 单测可以不注入，此时 /artifact 回 404。
    artifact: Callable[[str, int], dict | None] | None = None
    # 事件发布（任务入队在传输层发生，生产者在业务点）：``(event, data) -> None``。
    publish_event: Callable[[str, dict], None] | None = None
    # EventHub 实例（提供 subscribe/unsubscribe/replay）；None 时 /events 回 404。
    events: Any = None


class DaemonHandler(BaseHTTPRequestHandler):
    """协议出口：路由 + 鉴权 + 状态码映射。

    ``api`` 是类属性而不是构造参数：``ThreadingHTTPServer`` 会为每个连接新建 handler，
    实例上没有地方塞依赖；单测也用 ``object.__new__(DaemonHandler)`` 造裸实例，类属性
    同样可见（不必绑定真实 socket）。
    """

    api: HttpApi | None = None
    # 版本号在 configure() 里按入口模块的常量填；保持与改造前完全一致的 `Server:` 头。
    server_version = "imagen-daemon"
    sys_version = ""

    # ---- 元信息 ----

    @classmethod
    def _api(cls) -> HttpApi:
        api = cls.api
        if api is None:  # pragma: no cover - 装配漏了才会到这里
            raise RuntimeError("HTTP 层未装配：启动前必须调用 http_server.configure(HttpApi)")
        return api

    # 默认实现会把每行请求写 stderr；这里只写控制台，避免 /health 轮询把日志环刷满。
    def log_message(self, fmt, *args):  # noqa: ANN001
        try:
            _ORIG_STDERR.write(f"[http] {self.address_string()} - {fmt % args}\n")
            _ORIG_STDERR.flush()
        except Exception:
            pass

    # ---- 基础响应 ----

    def _send_json(self, code: int, payload: dict, extra_headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _send_error(self, code: int, error_code: str, message: str, headers: dict | None = None) -> None:
        self._send_json(code, {"error": {"code": error_code, "message": message}}, headers)

    def _require_auth(self) -> bool:
        api = self._api()
        config = api.config
        expected = config.auth_token
        if not expected:
            # 安全修复：没有 token 时默认不放行（本地调试需显式 allow_no_auth=true）。
            if config.allow_no_auth:
                # 本地调试没有 Token 可比，但请求确实到达了鉴权后的接口：同样算已接管，
                # 否则调试中的进程会在 claim_timeout_sec 后自行退出。
                api.mark_claimed()
                return True
            self._send_error(
                401,
                "unauthorized",
                "Daemon 未配置 auth_token，拒绝请求（本地调试请显式配置 allow_no_auth=true）",
            )
            return False
        header = self.headers.get("Authorization", "") or ""
        if header.startswith("Bearer "):
            provided = header[len("Bearer ") :].strip()
            if hmac.compare_digest(provided, expected):
                # 任何带正确 Bearer Token 的请求（/health、/shutdown、/generate、/job、/logs 等）
                # 都说明 Host 已经找到并接管了这个 Kernel：取消 claim 看门狗。
                api.mark_claimed()
                return True
        self._send_error(401, "unauthorized", "缺少或错误的 Bearer Token")
        return False

    def _read_json(self):  # noqa: ANN202
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return {}
        limit = self._api().request_body_limit()
        if length > limit:
            raise RequestError(f"请求体超过上限（{round(limit / 1024 / 1024, 1)}MB）")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise RequestError(f"请求体不是合法 JSON：{type(exc).__name__}") from None

    # ---- 路由 ----

    def do_GET(self):  # noqa: N802
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path.rstrip("/") or "/"
        # 免鉴权存活探针：只回 {"ok": true}，不暴露 phase / 设备 / 版本等任何细节。
        # 给 Docker healthcheck 与负载均衡用，避免把 Token 写进探针配置。
        if path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        if not self._require_auth():
            return
        query = urllib.parse.parse_qs(parts.query)
        api = self._api()
        if path == "/health":
            self._send_json(200, api.health_payload())
            return
        if path == "/artifact":
            self._handle_artifact(query)
            return
        if path == "/events":
            self._handle_events()
            return
        if path == "/logs":
            try:
                since = int((query.get("since") or ["0"])[0])
            except (TypeError, ValueError):
                since = 0
            lines, nxt = api.log_since(since)
            self._send_json(200, {"lines": lines, "next": nxt})
            return
        if path == "/job":
            job_id = str((query.get("id") or [""])[0]).strip()
            if not job_id:
                self._send_error(400, "invalid_request", "缺少 job id（GET /job?id=...）")
                return
            job = api.get_job(job_id)
            if job is None:
                self._send_error(404, "unknown_job", "任务不存在或已过期")
                return
            self._send_json(200, api.job_payload(job))
            return
        self._send_error(404, "not_found", f"未知路径：{path}")

    def do_POST(self):  # noqa: N802
        if not self._require_auth():
            return
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path.rstrip("/") or "/"

        if path == "/shutdown":
            api = self._api()
            # 共享 Worker 默认关闭远程关机（M3.1 安全基线）：只有本机托管 / 单用户部署
            # 显式加 --allow-shutdown 才允许，避免误关别人的长驻服务。
            if getattr(api.config, "allow_shutdown", True) is False:
                self._send_error(
                    403,
                    "shutdown_disabled",
                    "该 Worker 未开启远程关机（启动时未加 --allow-shutdown）",
                )
                return
            api.request_shutdown()
            self._send_json(200, {"status": "shutting_down"})
            threading.Thread(target=self._delayed_exit, daemon=True).start()
            return

        if path == "/generate":
            self._handle_generate()
            return

        self._send_error(404, "not_found", f"未知路径：{path}")

    # ---- 协议 v2：/artifact 与 /events ----

    def _handle_artifact(self, query: dict) -> None:
        """GET /artifact?id=&index=：二进制产物，支持单段 Range 与 ETag。"""
        api = self._api()
        job_id = str((query.get("id") or [""])[0]).strip()
        raw_index = str((query.get("index") or [""])[0]).strip()
        if not job_id:
            self._send_error(400, "invalid_request", "缺少 job id（GET /artifact?id=...&index=0）")
            return
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            self._send_error(400, "invalid_request", "index 必须是整数（从 0 开始）")
            return
        if api.artifact is None:
            self._send_error(404, "artifact_not_found", "该 Worker 未启用二进制产物")
            return
        job = api.get_job(job_id)
        if job is None:
            self._send_error(404, "unknown_job", "任务不存在或已过期")
            return
        info = api.artifact(job_id, index)
        if not info:
            self._send_error(404, "artifact_not_found", "产物不存在或已过期")
            return
        etag = f'"{info["sha256"]}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        try:
            total = os.path.getsize(info["path"])
        except OSError:
            self._send_error(404, "artifact_not_found", "产物文件已不存在")
            return
        start, end = 0, total - 1
        status = 200
        range_header = self.headers.get("Range", "") or ""
        if range_header:
            parsed = _parse_single_range(range_header, total)
            if parsed is None:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start, end = parsed
            status = 206
        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", str(info.get("media_type") or "application/octet-stream"))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        try:
            with open(info["path"], "rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except Exception:
            pass

    def _handle_events(self) -> None:
        """GET /events：SSE 事件流（job / state），15 秒心跳，支持 Last-Event-ID 重放。

        SSE 只用于降低延迟与展示进度：任务最终状态仍以 /job 为准；断流不取消任务。
        """
        api = self._api()
        hub = api.events
        if hub is None:
            self._send_error(404, "not_found", "该 Worker 未启用事件流")
            return
        subscriber = hub.subscribe()
        if subscriber is None:
            self._send_error(429, "too_many_streams", "并发事件流已达上限（4 条），请关闭不用的连接")
            return
        last_id = None
        raw_last = self.headers.get("Last-Event-ID")
        if raw_last:
            try:
                last_id = int(raw_last)
            except (TypeError, ValueError):
                last_id = None
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            for item in hub.replay(last_id):
                self._write_sse(item)
            self.wfile.flush()
            while True:
                try:
                    item = subscriber.get(timeout=15.0)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._write_sse(item)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            return
        finally:
            hub.unsubscribe(subscriber)

    def _write_sse(self, item: dict) -> None:
        body = json.dumps(item.get("data") or {}, ensure_ascii=False, separators=(",", ":"))
        frame = f"id: {item.get('id')}\nevent: {item.get('event')}\ndata: {body}\n\n"
        self.wfile.write(frame.encode("utf-8"))

    def _delayed_exit(self) -> None:
        """先把 202/200 响应写回连接，再清理退出（0.3s 给内核刷缓冲）。"""
        api = self._api()
        time.sleep(0.3)
        api.cleanup_before_exit()
        os._exit(0)

    def _handle_generate(self) -> None:
        api = self._api()
        with api.state_lock:
            phase = api.state.phase
            last_error = api.state.last_error
            booted = api.state.booted
            shutting_down = api.state.shutting_down
        can_accept = not shutting_down and (phase == "ready" or (phase == "loading" and booted))
        if not can_accept:
            if phase == "error":
                message = last_error or "Daemon 启动失败"
                self._send_error(503, "load_failed", message)
            else:
                # Host 正常不会在 ready 之前调用；这里给它一个可重试的明确信号。
                self._send_error(
                    503,
                    "warming",
                    f"Daemon 尚未就绪（phase={phase}），请稍后重试",
                    {"Retry-After": "5"},
                )
            return

        spec = None
        try:
            spec = self._read_json()
            pipeline_spec, model_id, tasks, tool = api.validate_generate_spec(spec)
            if tool == "upscale":
                # 高清放大（INTERFACES §2.1）：源图只做头部校验，任务按源图宽高由 daemon
                # 合成 1 条；不读 pipeline、不查 loader 白名单（固定 Real-ESRGAN 权重）。
                reference = api.parse_upscale_reference(spec.get("reference"))
                tasks = [api.build_upscale_task(reference["width"], reference["height"])]
                reference_images = None
            else:
                # 图生图（M3）：参考图提交期只读图片头做校验，失败直接 400；
                # 没有 reference 时返回 None，文生图路径逐字不变。
                reference = api.parse_reference_spec(spec.get("reference"), pipeline_spec)
                # 原生参考生图（Phase C1）：referenceImages 是 job 级图片列表，与 reference
                # 互斥（validate_generate_spec 已拦同时出现），同样只读图片头。
                reference_images = api.parse_reference_images(
                    spec.get("referenceImages"), pipeline_spec
                )
            job_id = api.normalize_job_id(spec.get("jobId"))
            result_mode = spec.get("result_mode", "inline")
            if not isinstance(result_mode, str) or result_mode not in ("inline", "binary"):
                raise RequestError("result_mode 只能是 inline / binary")
        except RequestError as exc:
            log(f"[gen] 请求非法（tool={spec.get('tool') if isinstance(spec, dict) else '-'}）：{exc}")
            self._send_error(400, "invalid_request", str(exc))
            return

        try:
            job, created = api.submit_job(
                pipeline_spec,
                model_id,
                tasks,
                job_id,
                reference,
                tool=tool,
                reference_images=reference_images,
                result_mode=result_mode,
            )
        except QueueFullError as exc:
            log(f"[gen] 队列已满：{exc}")
            self._send_error(429, "queue_full", str(exc), {"Retry-After": "5"})
            return
        except Exception as exc:  # pragma: no cover - 入队本身不涉及 IO
            log(f"[gen] 入队失败：{short(exc)}")
            self._send_error(500, "generation_failed", short(exc))
            return

        with api.state_lock:
            api.state.last_active = time.time()
        if api.publish_event is not None:
            try:
                api.publish_event(
                    "job",
                    {
                        "id": job.job_id,
                        "status": job.status,
                        "progress": {"done": len(job.results), "total": job.total},
                    },
                )
            except Exception:
                pass
        if not created:
            log(f"[gen] 幂等命中 {job.job_id}（status={job.status}），不重复入队")
        self._send_json(
            202,
            {
                "status": "accepted",
                "job_id": job.job_id,
                "tool": job.tool,
                "model_id": job.model_id,
                "created_at": api.iso_time(job.created_at),
            },
        )


def _parse_single_range(header: str, total: int) -> tuple[int, int] | None:
    """解析单段 Range（``bytes=start-end`` / ``bytes=start-`` / ``bytes=-suffix``）。

    多段 Range、非 bytes 单位、越界一律返回 None（HTTP 层回 416）；只支持单段是有意为之：
    Host 的续传只需要「从某字节继续到尾」，多段响应会把复杂度推给两端。
    """
    text = str(header or "").strip()
    if not text.lower().startswith("bytes="):
        return None
    spec = text[len("bytes=") :].strip()
    if "," in spec or "-" not in spec:
        return None
    left, _, right = spec.partition("-")
    left = left.strip()
    right = right.strip()
    if total <= 0:
        return None
    if left == "":
        # 后缀范围：最后 N 字节
        if not right.isdigit():
            return None
        suffix = int(right)
        if suffix <= 0:
            return None
        suffix = min(suffix, total)
        return total - suffix, total - 1
    if not left.isdigit():
        return None
    start = int(left)
    if start >= total:
        return None
    if right == "":
        return start, total - 1
    if not right.isdigit():
        return None
    end = int(right)
    if end < start:
        return None
    return start, min(end, total - 1)


def configure(api: HttpApi) -> type[DaemonHandler]:
    """装配 handler 的依赖（启动前调用一次；重复调用等价于替换）。"""
    DaemonHandler.api = api
    DaemonHandler.server_version = f"imagen-daemon/{api.version()}"
    return DaemonHandler


def _normalize_bind_host(host: str) -> str:
    raw = str(host or "127.0.0.1").strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1].strip()
    return raw or "127.0.0.1"


def _is_ipv6_literal(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).version == 6
    except ValueError:
        return False


class _DualStackHTTPServer(ThreadingHTTPServer):
    """支持 IPv6（含 `::` 双栈同时承接 IPv4/IPv6，适配 SaladCloud 等 IPv6 网关）。"""

    address_family = socket.AF_INET6
    require_dual_stack = False

    def server_bind(self) -> None:
        if hasattr(socket, "IPPROTO_IPV6") and hasattr(socket, "IPV6_V6ONLY"):
            try:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            except OSError:
                if self.require_dual_stack:
                    raise
        super().server_bind()


class _StrictDualStackHTTPServer(_DualStackHTTPServer):
    require_dual_stack = True


def _bind_http_server(host: str, port: int) -> tuple[ThreadingHTTPServer, str]:
    normalized = _normalize_bind_host(host)
    if normalized.lower() == "auto":
        try:
            return _StrictDualStackHTTPServer(("::", port), DaemonHandler), "::"
        except OSError as exc:
            log(f"[http] IPv6 双栈不可用，回退 IPv4 0.0.0.0：{exc}")
            return ThreadingHTTPServer(("0.0.0.0", port), DaemonHandler), "0.0.0.0"
    if _is_ipv6_literal(normalized):
        return _DualStackHTTPServer((normalized, port), DaemonHandler), normalized
    return ThreadingHTTPServer((normalized, port), DaemonHandler), normalized


def start_server(
    port: int,
    *,
    boot,  # noqa: ANN001 - BootState（活对象，只用于登记 server 句柄）
    boot_lock,  # noqa: ANN001
    host: str = "127.0.0.1",
    thread_name: str = "http-server",
) -> ThreadingHTTPServer:
    """监听并后台 serve；server 句柄写进 ``BOOT.http_server`` 供退出清理关闭。

    用线程而不是阻塞主线程：主线程要跑会合点发布与空闲看门狗（见 ``worker/app.py``）。
    """
    server, bound_host = _bind_http_server(host, port)
    server.daemon_threads = True
    with boot_lock:
        boot.http_server = server
    threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.5},
        name=thread_name,
        daemon=True,
    ).start()
    actual_port = int(server.server_address[1])
    log(f"[http] 监听 {bound_host}:{actual_port}")
    return server
