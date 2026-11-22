"""协议 v2 的离线回归：二进制产物、SSE 事件流、/healthz 与关机闸门。

覆盖：
- ``worker/jobs/artifacts.py``：binary 落盘、元数据、Range 查询、目录清理；
- ``worker/events.py``：重放窗口、Last-Event-ID、并发上限、慢订阅者丢弃；
- HTTP 层（真实 ThreadingHTTPServer + 回环请求）：/healthz 免鉴权、/artifact 200/206/416/304、
  /events 重放与 429、/shutdown 默认拒绝、result_mode 校验。

运行：python test/worker/test_protocol_v2.py（或 python test/worker/run.py）
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import types
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

from support import DaemonUnitTest, TASKS, d, worker_http

import worker.jobs.artifacts as artifacts
from worker.events import EventHub
from worker.jobs.models import Job

TOKEN = "protocol-v2-token-0123456789"


class ArtifactStoreTest(DaemonUnitTest):
    """/artifact 的落盘与读取。"""

    def setUp(self) -> None:
        super().setUp()
        self.root = tempfile.mkdtemp(prefix="aigc-artifacts-test-")
        self.env = mock.patch.dict(os.environ, {artifacts.ARTIFACT_DIR_ENV: self.root})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        shutil.rmtree(self.root, ignore_errors=True)
        super().tearDown()

    def _job(self, mode: str = "binary") -> Job:
        return Job(
            job_id="job-test-1",
            model_id="org/model",
            pipeline={"loader": "sdxl"},
            tasks=[{"name": "01"}],
            result_mode=mode,
        )

    def test_inline_mode_is_untouched(self) -> None:
        job = self._job("inline")
        payload = b"png-bytes"
        results = [{"name": "01", "image_b64": base64.b64encode(payload).decode("ascii")}]
        self.assertEqual(artifacts.materialize_results(job, results), results)
        self.assertIsNone(job.artifact_dir)

    def test_binary_mode_writes_metadata_and_file(self) -> None:
        job = self._job()
        payload = b"\x89PNG\r\n\x1a\nbinary-body"
        results = [
            {
                "name": "01",
                "seed": 42,
                "width": 8,
                "height": 8,
                "seconds": 1.0,
                "png_bytes": len(payload),
                "image_b64": base64.b64encode(payload).decode("ascii"),
            }
        ]
        materialized = artifacts.materialize_results(job, results)
        job.results = materialized
        self.assertEqual(len(materialized), 1)
        meta = materialized[0]
        self.assertNotIn("image_b64", meta)
        self.assertEqual(meta["index"], 0)
        self.assertEqual(meta["bytes"], len(payload))
        self.assertEqual(meta["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(meta["media_type"], "image/png")
        path = os.path.join(job.artifact_dir, "0.png")
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(open(path, "rb").read(), payload)

        info = artifacts.artifact_file(job, 0)
        self.assertEqual(info["bytes"], len(payload))
        self.assertEqual(info["sha256"], meta["sha256"])

    def test_binary_metadata_is_idempotent(self) -> None:
        job = self._job()
        meta = {"index": 0, "sha256": "x", "bytes": 1}
        self.assertEqual(artifacts.materialize_results(job, [meta]), [meta])

    def test_artifact_index_bounds(self) -> None:
        job = self._job()
        artifacts.materialize_results(
            job, [{"image_b64": base64.b64encode(b"x").decode("ascii")}]
        )
        self.assertIsNone(artifacts.artifact_file(job, 1))
        self.assertIsNone(artifacts.artifact_file(job, -1))
        self.assertIsNone(artifacts.artifact_file(job, "nope"))

    def test_artifact_dir_outside_root_is_rejected(self) -> None:
        job = self._job()
        job.artifact_dir = tempfile.gettempdir()
        self.assertIsNone(artifacts.artifact_file(job, 0))

    def test_cleanup_removes_job_directory(self) -> None:
        job = self._job()
        artifacts.materialize_results(
            job, [{"image_b64": base64.b64encode(b"x").decode("ascii")}]
        )
        directory = job.artifact_dir
        self.assertTrue(os.path.isdir(directory))
        artifacts.cleanup_job_artifacts(job)
        self.assertFalse(os.path.exists(directory))


class EventHubTest(DaemonUnitTest):
    """SSE 的事件缓冲与订阅上限。"""

    def test_replay_and_last_event_id(self) -> None:
        hub = EventHub()
        hub.publish("state", {"phase": "booting"})
        hub.publish("job", {"id": "j-1", "status": "queued"})
        self.assertEqual(len(hub.replay()), 2)
        second = hub.replay(1)
        self.assertEqual(len(second), 1)
        self.assertEqual(second[0]["data"]["id"], "j-1")
        # 非法 / 越界的 Last-Event-ID 按从头重放，不会卡死。
        self.assertEqual(len(hub.replay(999)), 0)
        self.assertEqual(len(hub.replay(None)), 2)

    def test_replay_window_is_bounded(self) -> None:
        hub = EventHub(replay_max=3)
        for index in range(5):
            hub.publish("job", {"id": index})
        self.assertEqual([item["data"]["id"] for item in hub.replay()], [2, 3, 4])

    def test_stream_limit_and_unsubscribe(self) -> None:
        hub = EventHub(max_streams=1)
        first = hub.subscribe()
        self.assertIsNotNone(first)
        self.assertIsNone(hub.subscribe())
        hub.unsubscribe(first)
        self.assertIsNotNone(hub.subscribe())

    def test_slow_subscriber_drops_instead_of_blocking(self) -> None:
        hub = EventHub(queue_max=1)
        subscriber = hub.subscribe()
        hub.publish("job", {"id": 1})
        hub.publish("job", {"id": 2})  # 队列已满：丢弃，不抛异常、不阻塞
        self.assertEqual(subscriber.get_nowait()["data"]["id"], 1)
        self.assertTrue(subscriber.empty())


class HttpProtocolV2Test(DaemonUnitTest):
    """真实回环 HTTP：路由、鉴权、Range 与 SSE。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_dir = tempfile.mkdtemp(prefix="aigc-http-v2-")
        cls.payload = b"0123456789abcdef"
        cls.payload_path = os.path.join(cls.temp_dir, "0.png")
        with open(cls.payload_path, "wb") as handle:
            handle.write(cls.payload)
        cls.sha = hashlib.sha256(cls.payload).hexdigest()

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def setUp(self) -> None:
        super().setUp()
        d.CONFIG.auth_token = TOKEN
        self.shutdown_calls: list[bool] = []
        self.submitted: list[dict] = []
        self.hub = EventHub()
        self.job = Job(
            job_id="job-1",
            model_id="org/model",
            pipeline={"loader": "sdxl"},
            tasks=[{"name": "01"}],
            result_mode="binary",
        )
        self.job.results = [{"index": 0, "bytes": len(self.payload), "sha256": self.sha}]
        self.job.artifact_dir = self.temp_dir
        self.api = worker_http.HttpApi(
            config=d.CONFIG,
            state=d.STATE,
            state_lock=d.STATE_LOCK,
            request_body_limit=lambda: 1024 * 1024,
            health_payload=lambda: {"status": "ok", "phase": "ready", "protocol_version": "2.0.0"},
            log_since=lambda since: ([], 0),
            get_job=lambda job_id: self.job if job_id == "job-1" else None,
            job_payload=lambda job: {"job_id": job.job_id, "status": job.status},
            submit_job=self._submit,
            validate_generate_spec=lambda spec: (
                {"loader": "sdxl"},
                "org/model",
                [{"name": "01"}],
                "generate",
            ),
            parse_reference_spec=lambda raw, pipeline: None,
            parse_reference_images=lambda raw, pipeline: None,
            parse_upscale_reference=lambda raw: None,
            build_upscale_task=lambda width, height: {},
            normalize_job_id=lambda raw: raw,
            request_shutdown=lambda: self.shutdown_calls.append(True),
            cleanup_before_exit=lambda: None,
            mark_claimed=lambda: None,
            iso_time=lambda ts: "2026-11-22T00:00:00Z",
            version=lambda: "2.0.0",
            artifact=lambda job_id, index: (
                {
                    "path": self.payload_path,
                    "bytes": len(self.payload),
                    "sha256": self.sha,
                    "media_type": "image/png",
                }
                if job_id == "job-1" and index == 0
                else None
            ),
            publish_event=lambda event, data: self.hub.publish(event, data),
            events=self.hub,
        )
        self.patch = mock.patch.object(worker_http.DaemonHandler, "api", self.api)
        self.patch.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), worker_http.DaemonHandler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.patch.stop()
        super().tearDown()

    def _submit(self, *args, **kwargs):  # noqa: ANN002, ANN003
        self.submitted.append(kwargs)
        return self.job, True

    def _request(self, path, *, method="GET", headers=None, body=None):  # noqa: ANN001
        url = f"http://127.0.0.1:{self.port}{path}"
        request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def _auth(self, extra=None):  # noqa: ANN001
        headers = {"Authorization": f"Bearer {TOKEN}"}
        headers.update(extra or {})
        return headers

    def test_healthz_is_unauthenticated_and_minimal(self) -> None:
        status, _headers, body = self._request("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})

    def test_health_requires_bearer(self) -> None:
        status, _headers, body = self._request("/health")
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body)["error"]["code"], "unauthorized")

    def test_artifact_full_and_range(self) -> None:
        status, headers, body = self._request("/artifact?id=job-1&index=0", headers=self._auth())
        self.assertEqual(status, 200)
        self.assertEqual(body, self.payload)
        self.assertEqual(headers.get("Content-Length"), str(len(self.payload)))
        self.assertEqual(headers.get("Accept-Ranges"), "bytes")
        self.assertEqual(headers.get("ETag"), f'"{self.sha}"')

        status, headers, body = self._request(
            "/artifact?id=job-1&index=0", headers=self._auth({"Range": "bytes=2-5"})
        )
        self.assertEqual(status, 206)
        self.assertEqual(body, self.payload[2:6])
        self.assertEqual(headers.get("Content-Range"), f"bytes 2-5/{len(self.payload)}")

        status, _headers, _body = self._request(
            "/artifact?id=job-1&index=0", headers=self._auth({"Range": "bytes=99-"})
        )
        self.assertEqual(status, 416)

        status, _headers, body = self._request(
            "/artifact?id=job-1&index=0", headers=self._auth({"If-None-Match": f'"{self.sha}"'})
        )
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")

    def test_artifact_missing(self) -> None:
        status, _headers, body = self._request("/artifact?id=job-1&index=9", headers=self._auth())
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"]["code"], "artifact_not_found")

    def test_events_replay_and_last_event_id(self) -> None:
        self.hub.publish("state", {"phase": "booting"})
        self.hub.publish("job", {"id": "job-1", "status": "queued"})

        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("GET", "/events", headers=self._auth({"Last-Event-ID": "1"}))
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        first = response.fp.readline().decode("utf-8")
        self.assertTrue(first.startswith("id: 2"), first)
        self.assertEqual(response.fp.readline().decode("utf-8").strip(), "event: job")
        data = response.fp.readline().decode("utf-8").strip()
        self.assertIn('"job-1"', data)
        connection.close()

    def test_events_stream_limit(self) -> None:
        held = self.hub.subscribe()
        self.assertIsNotNone(held)
        for _ in range(3):
            self.hub.subscribe()
        status, _headers, body = self._request("/events", headers=self._auth())
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(body)["error"]["code"], "too_many_streams")

    def test_shutdown_is_disabled_by_default(self) -> None:
        d.CONFIG.allow_shutdown = False
        try:
            status, _headers, body = self._request(
                "/shutdown", method="POST", headers=self._auth(), body=b"{}"
            )
        finally:
            d.CONFIG.allow_shutdown = True
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"]["code"], "shutdown_disabled")
        self.assertEqual(self.shutdown_calls, [])

    def test_invalid_result_mode_is_400(self) -> None:
        d.STATE.phase = "ready"
        d.STATE.booted = True
        spec = {"pipeline": {"loader": "sdxl"}, "tasks": TASKS, "result_mode": "weird"}
        status, _headers, body = self._request(
            "/generate",
            method="POST",
            headers=self._auth({"Content-Type": "application/json"}),
            body=json.dumps(spec).encode("utf-8"),
        )
        self.assertEqual(status, 400)
        self.assertIn("result_mode", json.loads(body)["error"]["message"])
        self.assertEqual(self.submitted, [])


class StepProgressTest(DaemonUnitTest):
    """扩散步数进度：JobStore 字段、/job 载荷与 run_task 的回调注入。"""

    def setUp(self) -> None:
        super().setUp()
        self.contract_config()

    def _job(self) -> Job:
        return Job(
            job_id="job-step-1",
            model_id="org/model",
            pipeline={"loader": "sdxl"},
            tasks=[{"name": "01"}],
        )

    def test_job_payload_exposes_step_progress(self) -> None:
        job = self._job()
        self.assertNotIn("step", d.JOB_STORE.payload(job)["progress"])
        d.JOB_STORE.update_step(job, 3, 8)
        self.assertEqual(
            d.JOB_STORE.payload(job)["progress"],
            {"done": 0, "total": 1, "step": 3, "steps": 8},
        )
        # 越界值钳到 [0, steps]：客户端进度条不会出现 12/8。
        d.JOB_STORE.update_step(job, 99, 8)
        self.assertEqual(d.JOB_STORE.payload(job)["progress"]["step"], 8)

    def test_run_task_reports_steps_via_callback_on_step_end(self) -> None:
        seen = []

        class FakeImage:
            def __init__(self, size):  # noqa: ANN001
                self.size = size

            def save(self, buffer, format=None):  # noqa: A002, ANN001
                buffer.write(b"fake-png")

        class FakePipe:
            def __call__(
                self,
                prompt=None,  # noqa: ANN001
                negative_prompt=None,  # noqa: ANN001
                num_inference_steps=None,  # noqa: ANN001
                guidance_scale=None,  # noqa: ANN001
                width=None,  # noqa: ANN001
                height=None,  # noqa: ANN001
                generator=None,  # noqa: ANN001
                callback_on_step_end=None,  # noqa: ANN001
            ):
                for index in range(int(num_inference_steps)):
                    callback_on_step_end(self, index, None, {"latents": index})
                return types.SimpleNamespace(images=[FakeImage((64, 64))])

        d.STATE.sig_params = {
            "prompt",
            "negative_prompt",
            "num_inference_steps",
            "guidance_scale",
            "width",
            "height",
            "generator",
            "callback_on_step_end",
        }
        torch_module = types.ModuleType("torch")
        torch_module.cuda = types.SimpleNamespace(
            is_available=lambda: False, synchronize=lambda: None
        )
        torch_module.Generator = lambda device: types.SimpleNamespace(manual_seed=lambda seed: device)
        with mock.patch.dict(sys.modules, {"torch": torch_module}):
            d.run_task(
                FakePipe(),
                dict(TASKS[0], steps=4),
                on_step=lambda step, steps: seen.append((step, steps)),
            )
        self.assertEqual(seen, [(1, 4), (2, 4), (3, 4), (4, 4)])

    def test_run_task_without_callback_signature_is_silent(self) -> None:
        class FakeImage:
            def __init__(self, size):  # noqa: ANN001
                self.size = size

            def save(self, buffer, format=None):  # noqa: A002, ANN001
                buffer.write(b"fake-png")

        class FakePipe:
            def __call__(self, **kwargs):  # noqa: ANN003
                self.kwargs = kwargs
                return types.SimpleNamespace(images=[FakeImage((64, 64))])

        pipe = FakePipe()
        d.STATE.sig_params = {"prompt", "num_inference_steps", "guidance_scale", "width", "height", "generator"}
        torch_module = types.ModuleType("torch")
        torch_module.cuda = types.SimpleNamespace(
            is_available=lambda: False, synchronize=lambda: None
        )
        torch_module.Generator = lambda device: types.SimpleNamespace(manual_seed=lambda seed: device)
        with mock.patch.dict(sys.modules, {"torch": torch_module}):
            d.run_task(pipe, dict(TASKS[0], steps=2), on_step=lambda step, steps: None)
        self.assertNotIn("callback_on_step_end", pipe.kwargs)
        self.assertNotIn("callback", pipe.kwargs)


if __name__ == "__main__":
    import unittest

    unittest.main()
