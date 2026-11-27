"""资产工坊 GPU 后处理（``tool=remove-bg / pbr``）：协议归一、源图校验、执行分支与失败归因。

覆盖 M4.2a / M4.2b 的远端链路（没有 GPU 也能跑）：

1. ``normalize_tool`` 接受 remove-bg / pbr，其它未知值仍然 400；
2. ``validate_generate_spec`` 对工坊算子在提交期完成：模型白名单 / pbr 步数钳制 / 源图
   字节与长边边界（``limits.workshop.<tool>``），不读扩散 pipeline；
3. ``parse_workshop_reference`` 经 daemon 的 ``parse_reference_spec`` 包装按伪 loader 分流；
4. ``execute_job`` 的工坊分支：不加载扩散 pipeline、按契约通道顺序返回带 ``channel`` 的
   results、执行结束释放显存 / 模型句柄（含异常路径）；
1. 失败归因：未接入模型占位 → ``pbr_model_unavailable`` 文案；依赖缺失 → ``load_failed``
   且文案写清缺什么、怎么装；OOM 仍归 ``oom`` 并清缓存；
6. HTTP 协议：``POST /generate`` 对工坊请求返回 202 并入库，非法 model/steps 返回 400。

真实模型加载与推理（torch / diffusers / transformers / HF 权重）不在本文件覆盖范围内：
本机无 GPU、也不能下载权重，那段路径只能在真机上验证（执行体本身通过 mock 覆盖）。

运行：python test/worker/test_workshop.py
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from unittest import mock

HAS_NUMPY = importlib.util.find_spec("numpy") is not None
HAS_PILLOW = importlib.util.find_spec("PIL") is not None

from support import (  # noqa: E402
    CONTRACT_DOC,
    DaemonUnitTest,
    FakePILImage,
    d,
    fake_pil_for,
    make_generate_handler,
    make_reference,
    make_reference_b64,
    make_workshop_spec,
)

import worker.transport.validator as remote_validator  # noqa: E402  # support 导入后 sys.path 已就绪

WORKSHOP_LIMITS = CONTRACT_DOC["limits"]["workshop"]
CUTOUT_LIMITS = WORKSHOP_LIMITS["cutout"]
PBR_LIMITS = WORKSHOP_LIMITS["pbr"]
PBR_CHANNELS = tuple(PBR_LIMITS["channels"])
DEPTH_LIMITS = WORKSHOP_LIMITS["depth"]
RELIGHT_LIMITS = WORKSHOP_LIMITS["relight"]
DEPTH_CHANNELS = tuple(DEPTH_LIMITS["channels"])


class FakeEncodableImage:
    """可编码的假 PIL 图：只提供 ``save`` / ``size`` / ``close``，供 ``_encode_png`` 使用。"""

    def __init__(self, size, payload: bytes = b"fake-workshop-png"):
        self.size = (int(size[0]), int(size[1]))
        self.payload = payload
        self.closed = False

    def save(self, buffer, format="PNG"):  # noqa: A002 - 与 PIL 签名一致
        buffer.write(self.payload)

    def close(self) -> None:
        self.closed = True


class WorkshopToolSpecTest(DaemonUnitTest):
    """tool 归一：remove-bg / pbr 进入远端白名单，未知值仍然 400。"""

    def test_remote_tools_cover_workshop_ops(self) -> None:
        self.assertEqual(
            remote_validator.REMOTE_TOOLS,
            ("generate", "upscale", "remove-bg", "pbr", "depth", "relight", "mesh3d"),
        )
        for tool in ("remove-bg", "pbr", "depth", "relight", "mesh3d"):
            self.assertEqual(remote_validator.normalize_tool({"tool": tool}), tool)
        # 空串 / 缺省仍按 generate（旧 Host 行为不变）。
        self.assertEqual(remote_validator.normalize_tool({}), "generate")
        self.assertEqual(remote_validator.normalize_tool({"tool": "  "}), "generate")

    def test_invalid_tool_still_rejected(self) -> None:
        for bad in ("outpaint", "cutout", "pbr-unavailable", 1):
            with self.assertRaises(d.RequestError, msg=f"tool={bad!r} 应被拒绝"):
                remote_validator.normalize_tool({"tool": bad})


class WorkshopLimitsTest(DaemonUnitTest):
    """``limits.workshop`` 的取数：默认来自内置 contract.json，注入契约逐键优先。"""

    def test_default_limits_come_from_contract_json(self) -> None:
        d.CONFIG.contract = {}
        self.assertEqual(d._limit_spec("workshop"), WORKSHOP_LIMITS)

    def test_injected_nested_limits_override_key_by_key(self) -> None:
        d.CONFIG.contract = {
            "limits": {
                "workshop": {
                    "pbr": {"maxInputEdge": 512, "steps": {"max": 6}},
                    "cutout": {"minInputEdge": 64},
                }
            }
        }
        spec = d._limit_spec("workshop")
        self.assertEqual(spec["pbr"]["maxInputEdge"], 512)
        self.assertEqual(spec["pbr"]["steps"]["max"], 6)
        # 未覆盖的键继续用内置 contract.json 的同名值。
        self.assertEqual(spec["pbr"]["steps"]["min"], PBR_LIMITS["steps"]["min"])
        self.assertEqual(spec["pbr"]["maxBytes"], PBR_LIMITS["maxBytes"])
        self.assertEqual(spec["cutout"]["minInputEdge"], 64)
        self.assertEqual(spec["cutout"]["maxInputEdge"], CUTOUT_LIMITS["maxInputEdge"])
        self.assertEqual(spec["channels"], WORKSHOP_LIMITS["channels"])


class WorkspaceSpecValidationTest(DaemonUnitTest):
    """工坊算子的提交期校验（假 PIL，不加载任何模型）。"""

    def validate(self, spec, size=(512, 512)):
        self.contract_config()
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage(size))):
            return d.validate_generate_spec(spec)

    def test_remove_bg_defaults_to_birefnet_model(self) -> None:
        pipeline, model_id, tasks, tool = self.validate(make_workshop_spec("remove-bg"))
        self.assertEqual(tool, "remove-bg")
        self.assertEqual(model_id, "ZhengPeng7/BiRefNet")
        self.assertEqual(pipeline["loader"], remote_validator.WORKSHOP_PIPELINE_LOADER)
        self.assertEqual(pipeline["base"], "remove-bg")
        self.assertEqual(pipeline["workshop"]["model"], "birefnet")
        self.assertEqual(pipeline["workshop"]["steps"], 0)
        self.assertTrue(pipeline["workshop"]["implemented"])
        self.assertEqual(len(tasks), 1)
        self.assertEqual((tasks[0]["width"], tasks[0]["height"]), (512, 512))
        self.assertEqual((tasks[0]["steps"], tasks[0]["cfg"]), (0, 0.0))
        self.assertEqual(tasks[0]["prompt"], "")

    def test_remove_bg_accepts_rmbg(self) -> None:
        _pipeline, model_id, _tasks, _tool = self.validate(
            make_workshop_spec("remove-bg", model="rmbg-2.0")
        )
        self.assertEqual(model_id, "briaai/RMBG-2.0")

    def test_pbr_defaults_and_steps_clamping(self) -> None:
        _pipeline, model_id, tasks, tool = self.validate(make_workshop_spec("pbr"))
        self.assertEqual(tool, "pbr")
        self.assertEqual(model_id, "prs-eth/marigold-iid-appearance-v1-1")
        steps_spec = PBR_LIMITS["steps"]
        self.assertEqual(tasks[0]["steps"], steps_spec["default"])
        # 越界按契约的钳制语义自动校正（与 Host 侧一致，不 400）。
        _pipeline, _model, clamped_high, _tool = self.validate(
            make_workshop_spec("pbr", steps=steps_spec["max"] + 10)
        )
        self.assertEqual(clamped_high[0]["steps"], steps_spec["max"])
        _pipeline, _model, clamped_low, _tool = self.validate(
            make_workshop_spec("pbr", steps=steps_spec["min"] - 5)
        )
        self.assertEqual(clamped_low[0]["steps"], steps_spec["min"])

    def test_pbr_chord_is_accepted_and_marked_implemented(self) -> None:
        pipeline, model_id, _tasks, _tool = self.validate(make_workshop_spec("pbr", model="chord"))
        self.assertEqual(model_id, "ubisoft/ubisoft-laforge-chord")
        self.assertTrue(pipeline["workshop"]["implemented"], "chord 已接入实现，implemented 必须为 True")

    def test_depth_defaults_and_cloud_model_whitelist(self) -> None:
        pipeline, model_id, tasks, tool = self.validate(make_workshop_spec("depth"))
        self.assertEqual(tool, "depth")
        self.assertEqual(model_id, "depth-anything/DA3MONO-LARGE")
        self.assertEqual(pipeline["workshop"]["model"], "da3mono-large")
        self.assertEqual(pipeline["workshop"]["steps"], 0)
        self.assertEqual(tasks[0]["prompt"], "")
        for model in ("da3-large", "moge-2-vitl"):
            _pipeline, repo, _tasks, _tool = self.validate(make_workshop_spec("depth", model=model))
            self.assertTrue(repo)

    def test_relight_options_and_steps(self) -> None:
        spec = make_workshop_spec("relight", steps=RELIGHT_LIMITS["steps"]["max"] + 20)
        spec["workshop"]["options"] = {
            "prompt": "warm sunset window light",
            "cfg": 99,
            "seed": 7,
            "preset": "sunset",
        }
        pipeline, model_id, tasks, tool = self.validate(spec)
        self.assertEqual(tool, "relight")
        self.assertEqual(model_id, "lllyasviel/ic-light")
        self.assertEqual(tasks[0]["steps"], RELIGHT_LIMITS["steps"]["max"])
        self.assertEqual(tasks[0]["prompt"], "warm sunset window light")
        self.assertEqual(tasks[0]["cfg"], RELIGHT_LIMITS["cfg"]["max"])
        self.assertEqual(tasks[0]["seed"], 7)
        self.assertEqual(pipeline["workshop"]["options"]["preset"], "sunset")

    def test_relight_unknown_model_is_rejected(self) -> None:
        with self.assertRaises(d.RequestError):
            self.validate(make_workshop_spec("relight", model="ic-light-flux"))

    def test_unknown_model_is_rejected(self) -> None:
        for bad in ("nope", "rmbg-1.4"):
            with self.assertRaises(d.RequestError, msg=f"model={bad!r} 应被拒绝"):
                self.validate(make_workshop_spec("pbr", model=bad))
        with self.assertRaises(d.RequestError):
            self.validate(make_workshop_spec("remove-bg", model="marigold"))

    def test_missing_or_malformed_reference_is_rejected(self) -> None:
        for bad in (None, "", "image-b64", [], {"mask_b64": make_reference_b64()}):
            with self.assertRaises(d.RequestError, msg=f"reference={bad!r} 应被拒绝"):
                self.validate({"tool": "remove-bg", "reference": bad})

    def test_mask_is_rejected(self) -> None:
        reference = make_reference(mask_b64=make_reference_b64(b"mask"))
        with self.assertRaises(d.RequestError) as raised:
            self.validate(make_workshop_spec("remove-bg", reference=reference))
        self.assertIn("不支持蒙版", str(raised.exception))

    def test_workshop_block_must_be_object(self) -> None:
        with self.assertRaises(d.RequestError):
            self.validate(dict(make_workshop_spec("remove-bg"), workshop="rmbg-2.0"))

    def test_source_long_edge_must_fit_tool_limit(self) -> None:
        # cutout 上限 1536：1600 超限；正好 1536 放行。
        self.validate(make_workshop_spec("remove-bg"), size=(CUTOUT_LIMITS["maxInputEdge"], 512))
        with self.assertRaises(d.RequestError) as raised:
            self.validate(
                make_workshop_spec("remove-bg"),
                size=(CUTOUT_LIMITS["maxInputEdge"] + 64, 512),
            )
        self.assertIn(str(CUTOUT_LIMITS["maxInputEdge"]), str(raised.exception))
        # pbr 上限更紧（1024）：cutout 放行的 1536 在 pbr 上必须 400。
        with self.assertRaises(d.RequestError):
            self.validate(make_workshop_spec("pbr"), size=(CUTOUT_LIMITS["maxInputEdge"], 1024))

    def test_source_min_edge_is_enforced(self) -> None:
        with self.assertRaises(d.RequestError):
            self.validate(
                make_workshop_spec("remove-bg"),
                size=(CUTOUT_LIMITS["minInputEdge"] - 1, 64),
            )
        with self.assertRaises(d.RequestError):
            self.validate(make_workshop_spec("pbr"), size=(PBR_LIMITS["minInputEdge"] - 1, 64))

    def test_source_bytes_limit_is_enforced(self) -> None:
        oversized = make_reference_b64(b"x" * (CUTOUT_LIMITS["maxBytes"] + 1))
        with self.assertRaises(d.RequestError) as raised:
            self.validate(make_workshop_spec("remove-bg", reference={"image_b64": oversized}))
        self.assertIn("超过上限", str(raised.exception))

    def test_invalid_base64_is_rejected(self) -> None:
        with self.assertRaises(d.RequestError):
            self.validate(make_workshop_spec("remove-bg", reference={"image_b64": "not base64!"}))

    def test_build_workshop_task_shape(self) -> None:
        self.contract_config()
        task = d.build_workshop_task(640, 480, 3)
        self.assertEqual(task["name"], "01")
        self.assertEqual((task["width"], task["height"]), (640, 480))
        self.assertEqual((task["steps"], task["cfg"]), (3, 0.0))
        self.assertEqual(task["prompt"], "")
        seed_max = CONTRACT_DOC["limits"]["seed"]["max"]
        self.assertGreaterEqual(task["seed"], 0)
        self.assertLessEqual(task["seed"], seed_max)


class WorkshopReferenceRoutingTest(DaemonUnitTest):
    """daemon 的 ``parse_reference_spec`` 包装按伪 loader 分流到工坊源图校验。"""

    def test_workshop_pipeline_routes_to_workshop_parser(self) -> None:
        self.contract_config()
        pipeline = {
            "loader": remote_validator.WORKSHOP_PIPELINE_LOADER,
            "base": "remove-bg",
            "workshop": {"model": "rmbg-2.0"},
        }
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage((768, 512)))):
            reference = d.parse_reference_spec(make_reference(), pipeline)
        self.assertEqual((reference["width"], reference["height"]), (768, 512))
        self.assertNotIn("strength", reference, "工坊源图没有 strength 语义")

    def test_generate_pipeline_still_uses_reference_parser(self) -> None:
        self.contract_config()
        pipeline = {"loader": "sdxl", "base": "org/base-model"}
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage((768, 512)))):
            reference = d.parse_reference_spec(make_reference(strength=0.8), pipeline)
        self.assertIn("strength", reference, "普通垫图路径必须保持原行为")


class WorkshopExecutionTest(DaemonUnitTest):
    """``execute_job`` 的工坊分支：不加载扩散 pipeline、按通道组装结果、释放资源。"""

    def submit(self, tool, *, model=None, steps=None, size=(512, 512)):
        spec = make_workshop_spec(tool, model=model, steps=steps)
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage(size))):
            pipeline, model_id, tasks, parsed_tool = d.validate_generate_spec(spec)
            reference = d.parse_reference_spec(spec.get("reference"), pipeline)
        job, created = d.JOB_STORE.submit(
            pipeline,
            model_id,
            tasks,
            f"ws-{tool}-{model or 'default'}",
            reference,
            tool=parsed_tool,
        )
        self.assertTrue(created)
        return job

    def run_job(
        self,
        job,
        *,
        cutout=None,
        pbr=None,
        depth=None,
        relight=None,
        pbr_error=None,
        cutout_error=None,
        depth_error=None,
        relight_error=None,
    ):
        source = FakeEncodableImage((512, 512))
        with mock.patch.object(d, "decode_reference_image", return_value=source), mock.patch.object(
            d, "ensure_pipeline", side_effect=AssertionError("工坊算子不得加载扩散 pipeline")
        ), mock.patch.object(d, "run_cutout_model", side_effect=cutout_error, return_value=cutout) as cutout_model, mock.patch.object(  # noqa: E501
            d, "run_pbr_model", side_effect=pbr_error, return_value=pbr
        ) as pbr_model, mock.patch.object(
            d, "run_depth_model", side_effect=depth_error, return_value=depth
        ) as depth_model, mock.patch.object(
            d, "run_relight_model", side_effect=relight_error, return_value=relight
        ) as relight_model, mock.patch.object(
            d, "release_workshop_memory"
        ) as release_memory, mock.patch.object(
            d, "free_cuda_cache"
        ) as free_cache, mock.patch.object(
            d, "_sync_cuda"
        ):
            d.execute_job(job)
        self.depth_model = depth_model
        self.relight_model = relight_model
        return cutout_model, pbr_model, release_memory, free_cache, source

    def test_remove_bg_returns_single_cutout_channel(self) -> None:
        job = self.submit("remove-bg")
        image = FakeEncodableImage((512, 512), b"cutout-png")
        _cutout, pbr_model, release_memory, _free, source = self.run_job(job, cutout=image)
        self.assertEqual(job.status, d.JOB_STATUS_DONE)
        self.assertEqual(len(job.results), 1)
        result = job.results[0]
        self.assertEqual(result["channel"], "cutout")
        self.assertEqual((result["width"], result["height"]), (512, 512))
        self.assertEqual(result["png_bytes"], len(b"cutout-png"))
        self.assertTrue(image.closed, "通道图编码后必须关闭")
        self.assertTrue(source.closed, "源图解码后必须关闭")
        self.assertEqual(pbr_model.call_count, 0, "remove-bg 不得调用 PBR 模型")
        self.assertEqual(release_memory.call_count, 1, "执行结束必须释放显存/句柄")
        self.assertEqual(d.STATE.jobs_done, 1)

    def test_remove_bg_passes_repo_id_to_model(self) -> None:
        job = self.submit("remove-bg", model="birefnet")
        image = FakeEncodableImage((512, 512))
        cutout_model, _pbr, _release, _free, _source = self.run_job(job, cutout=image)
        self.assertEqual(cutout_model.call_count, 1)
        _image_arg, kwargs = cutout_model.call_args
        self.assertEqual(kwargs.get("repo_id"), "ZhengPeng7/BiRefNet")

    def test_pbr_returns_channels_in_contract_order(self) -> None:
        job = self.submit("pbr", steps=2)
        images = {channel: FakeEncodableImage((512, 512), f"{channel}-png".encode()) for channel in PBR_CHANNELS}
        cutout_model, pbr_model, release_memory, _free, _source = self.run_job(job, pbr=images)
        self.assertEqual(job.status, d.JOB_STATUS_DONE)
        self.assertEqual(
            [result["channel"] for result in job.results],
            list(PBR_CHANNELS),
            "results 顺序必须与契约通道顺序一致（albedo 在前）",
        )
        self.assertEqual(cutout_model.call_count, 0, "pbr 不得调用抠图模型")
        self.assertEqual(pbr_model.call_count, 1)
        _image_arg, kwargs = pbr_model.call_args
        self.assertEqual(kwargs.get("steps"), 2)
        self.assertTrue(all(image.closed for image in images.values()))
        self.assertEqual(release_memory.call_count, 1)

    def test_chord_dispatches_to_chord_model_and_returns_channels(self) -> None:
        job = self.submit("pbr", model="chord")
        images = {channel: FakeEncodableImage((512, 512), f"{channel}-png".encode()) for channel in PBR_CHANNELS}
        _cutout, pbr_model, release_memory, free_cache, _source = self.run_job(job, pbr=images)
        self.assertEqual(job.status, d.JOB_STATUS_DONE)
        self.assertEqual([item["channel"] for item in job.results], list(PBR_CHANNELS))
        self.assertEqual(pbr_model.call_count, 1)
        _image_arg, kwargs = pbr_model.call_args
        self.assertEqual(kwargs.get("model_id"), "chord")
        self.assertEqual(kwargs.get("repo_id"), "ubisoft/ubisoft-laforge-chord")
        self.assertEqual(release_memory.call_count, 1)

    def test_depth_returns_depth_and_normal_in_contract_order(self) -> None:
        job = self.submit("depth", model="da3-large")
        images = {
            channel: FakeEncodableImage((512, 512), f"{channel}-png".encode())
            for channel in DEPTH_CHANNELS
        }
        _cutout, _pbr, release_memory, _free, _source = self.run_job(job, depth=images)
        self.assertEqual(job.status, d.JOB_STATUS_DONE)
        self.assertEqual([item["channel"] for item in job.results], list(DEPTH_CHANNELS))
        self.assertEqual(self.depth_model.call_count, 1)
        _image_arg, kwargs = self.depth_model.call_args
        self.assertEqual(kwargs.get("model_id"), "da3-large")
        self.assertEqual(kwargs.get("repo_id"), "depth-anything/DA3-LARGE")
        self.assertEqual(release_memory.call_count, 1)

    def test_relight_returns_relit_channel_and_passes_prompt(self) -> None:
        spec = make_workshop_spec("relight", steps=12)
        spec["workshop"]["options"] = {"prompt": "neon cyan rim light", "cfg": 3.5, "seed": 42}
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage((512, 512)))):
            pipeline, model_id, tasks, parsed_tool = d.validate_generate_spec(spec)
            reference = d.parse_reference_spec(spec.get("reference"), pipeline)
        job, created = d.JOB_STORE.submit(
            pipeline,
            model_id,
            tasks,
            "ws-relight",
            reference,
            tool=parsed_tool,
        )
        self.assertTrue(created)
        image = FakeEncodableImage((512, 512), b"relit-png")
        _cutout, _pbr, release_memory, _free, _source = self.run_job(job, relight=image)
        self.assertEqual(job.status, d.JOB_STATUS_DONE)
        self.assertEqual([item["channel"] for item in job.results], ["relit"])
        self.assertEqual(self.relight_model.call_count, 1)
        _image_arg, kwargs = self.relight_model.call_args
        self.assertEqual(kwargs.get("prompt"), "neon cyan rim light")
        self.assertEqual(kwargs.get("steps"), 12)
        self.assertEqual(kwargs.get("guidance"), 3.5)
        self.assertEqual(kwargs.get("seed"), 42)
        self.assertEqual(release_memory.call_count, 1)

    def test_depth_missing_channel_is_explicit_failure(self) -> None:
        job = self.submit("depth")
        images = {"depth": FakeEncodableImage((512, 512))}
        self.run_job(job, depth=images)
        self.assertEqual(job.status, d.JOB_STATUS_FAILED)
        self.assertEqual(job.error["code"], "load_failed")
        self.assertIn("normal", job.error["message"])

    def test_unimplemented_model_fails_with_pbr_model_unavailable_message(self) -> None:
        job = self.submit("pbr", model="chord")
        job.pipeline["workshop"]["implemented"] = False
        _cutout, pbr_model, release_memory, free_cache, _source = self.run_job(
            job, pbr={channel: FakeEncodableImage((512, 512)) for channel in PBR_CHANNELS}
        )
        self.assertEqual(job.status, d.JOB_STATUS_FAILED)
        self.assertEqual(job.error["code"], "load_failed")
        self.assertIn("pbr_model_unavailable", job.error["message"])
        self.assertIn("chord", job.error["message"])
        self.assertEqual(pbr_model.call_count, 0, "未接入实现的模型不得真去加载")
        self.assertEqual(release_memory.call_count, 1, "异常路径也要释放显存/句柄")
        self.assertTrue(free_cache.called)

    def test_missing_dependency_is_reported_with_install_hint(self) -> None:
        job = self.submit("remove-bg")
        error = ModuleNotFoundError("No module named 'transformers'", name="transformers")
        _cutout, _pbr, release_memory, _free, _source = self.run_job(job, cutout_error=error)
        self.assertEqual(job.status, d.JOB_STATUS_FAILED)
        self.assertEqual(job.error["code"], "load_failed")
        self.assertIn("transformers", job.error["message"])
        self.assertIn("pip install", job.error["message"])
        self.assertEqual(release_memory.call_count, 1)

    def test_missing_missing_dependency_error_is_mapped(self) -> None:
        job = self.submit("pbr")
        error = d.MissingDependencyError("缺少 diffusion 依赖 diffusers，请执行 `pip install diffusers`")
        _cutout, _pbr, _release, _free, _source = self.run_job(job, pbr_error=error)
        self.assertEqual(job.error["code"], "load_failed")
        self.assertIn("diffusers", job.error["message"])

    def test_oom_is_classified_and_cache_freed(self) -> None:
        job = self.submit("pbr")
        with mock.patch.object(
            d, "decode_reference_image", return_value=FakeEncodableImage((512, 512))
        ), mock.patch.object(
            d, "run_pbr_model", side_effect=RuntimeError("CUDA out of memory. Tried to allocate")
        ), mock.patch.object(
            d, "release_workshop_memory"
        ), mock.patch.object(
            d, "free_cuda_cache"
        ) as free_cache, mock.patch.object(
            d, "_sync_cuda"
        ):
            d.execute_job(job)
        self.assertEqual(job.status, d.JOB_STATUS_FAILED)
        self.assertEqual(job.error["code"], "oom")
        self.assertTrue(free_cache.called, "OOM 收尾必须主动清显存缓存")

    def test_missing_channel_is_an_explicit_failure(self) -> None:
        job = self.submit("pbr")
        images = {channel: FakeEncodableImage((512, 512)) for channel in PBR_CHANNELS if channel != "roughness"}
        _cutout, _pbr, _release, _free, _source = self.run_job(job, pbr=images)
        self.assertEqual(job.status, d.JOB_STATUS_FAILED)
        self.assertEqual(job.error["code"], "load_failed")
        self.assertIn("roughness", job.error["message"])

    def test_job_payload_carries_tool_and_model(self) -> None:
        job = self.submit("remove-bg")
        payload = d.JOB_STORE.payload(job)
        self.assertEqual(payload["tool"], "remove-bg")
        self.assertEqual(payload["model_id"], "ZhengPeng7/BiRefNet")

    def test_gated_repo_error_is_mapped_to_model_gated(self) -> None:
        job = self.submit("remove-bg", model="rmbg-2.0")
        err = OSError(
            "You are trying to access a gated repo. Make sure to have access to it at "
            "https://huggingface.co/briaai/RMBG-2.0. 401 Client Error."
        )
        _cutout, _pbr, _release, _free, _source = self.run_job(job, cutout_error=err)
        self.assertEqual(job.status, d.JOB_STATUS_FAILED)
        self.assertEqual(job.error["code"], "model_gated")
        self.assertIn("HF Token", job.error["message"])


class WorkshopHttpProtocolTest(DaemonUnitTest):
    """``POST /generate`` 对工坊请求的协议行为：202 入库、非法 model/steps 400。"""

    def setUp(self) -> None:
        super().setUp()
        self.contract_config()
        d.STATE.phase = "ready"

    def submit(self, spec, size=(512, 512)):
        handler, sent = make_generate_handler(spec)
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage(size))):
            d.DaemonHandler._handle_generate(handler)
        return handler, sent

    def test_remove_bg_request_enqueues_single_workshop_job(self) -> None:
        _handler, sent = self.submit(make_workshop_spec("remove-bg"))
        self.assertEqual(sent[0][0], 202, sent)
        payload = sent[0][1]
        self.assertEqual(payload["tool"], "remove-bg")
        self.assertEqual(payload["model_id"], "ZhengPeng7/BiRefNet")
        job = d.JOB_STORE.get(payload["job_id"])
        self.assertIsNotNone(job)
        self.assertEqual(job.tool, "remove-bg")
        self.assertEqual(job.pipeline["loader"], remote_validator.WORKSHOP_PIPELINE_LOADER)
        self.assertEqual(job.pipeline["workshop"]["model"], "birefnet")
        self.assertEqual(len(job.tasks), 1)
        self.assertEqual((job.tasks[0]["width"], job.tasks[0]["height"]), (512, 512))
        self.assertEqual(job.reference["width"], 512)

    def test_pbr_request_enqueues_with_steps(self) -> None:
        _handler, sent = self.submit(make_workshop_spec("pbr", steps=6))
        self.assertEqual(sent[0][0], 202, sent)
        job = d.JOB_STORE.get(sent[0][1]["job_id"])
        self.assertEqual(job.pipeline["workshop"]["steps"], 6)
        self.assertEqual(job.tasks[0]["steps"], 6)

    def test_unknown_model_returns_400(self) -> None:
        _handler, sent = self.submit(make_workshop_spec("pbr", model="nope"))
        self.assertEqual(sent[0][0], 400, sent)
        self.assertEqual(sent[0][1]["error"]["code"], "invalid_request")
        self.assertEqual(d.JOB_STORE.queue_depth(), 0, "非法请求不得占用队列")

    def test_top_level_and_nested_model_mismatch_returns_400(self) -> None:
        spec = make_workshop_spec("remove-bg", model="birefnet")
        spec["model"] = "rmbg-2.0"
        _handler, sent = self.submit(spec)
        self.assertEqual(sent[0][0], 400, sent)
        self.assertIn("不一致", sent[0][1]["error"]["message"])

    def test_non_integer_steps_returns_400(self) -> None:
        spec = make_workshop_spec("pbr")
        spec["workshop"]["steps"] = "four"
        _handler, sent = self.submit(spec)
        self.assertEqual(sent[0][0], 400, sent)

    def test_out_of_range_steps_is_clamped_by_daemon(self) -> None:
        # daemon 与 Host 同一套钳制语义：越界自动校正到契约上界，而不是 400。
        spec = make_workshop_spec("pbr")
        spec["workshop"]["steps"] = PBR_LIMITS["steps"]["max"] + 1
        _handler, sent = self.submit(spec)
        self.assertEqual(sent[0][0], 202, sent)
        job = d.JOB_STORE.get(sent[0][1]["job_id"])
        self.assertEqual(job.pipeline["workshop"]["steps"], PBR_LIMITS["steps"]["max"])

    def test_source_too_large_returns_400(self) -> None:
        _handler, sent = self.submit(
            make_workshop_spec("pbr"),
            size=(PBR_LIMITS["maxInputEdge"] + 64, 512),
        )
        self.assertEqual(sent[0][0], 400, sent)
        self.assertIn(str(PBR_LIMITS["maxInputEdge"]), sent[0][1]["error"]["message"])


class DepthAndRelightLoaderTests(unittest.TestCase):
    @unittest.skipUnless(HAS_NUMPY and HAS_PILLOW, "需要 Pillow 与 NumPy")
    def test_estimate_depth_routes_da3_and_moge_and_preserves_native_normal(self) -> None:
        import numpy as np
        from PIL import Image
        import inference.game_ops as game_ops

        img = Image.new("RGB", (16, 12), (100, 120, 140))

        class FakeDA3Prediction:
            def __init__(self) -> None:
                self.depth = np.linspace(1.0, 5.0, 16 * 12, dtype=np.float32).reshape(1, 12, 16)

        class FakeDA3Model:
            def to(self, device=None):  # noqa: ARG002
                return self

            def eval(self):
                return self

            def inference(self, images):  # noqa: ARG002
                return FakeDA3Prediction()

        class FakeDA3Cls:
            called_repo = None

            @classmethod
            def from_pretrained(cls, repo_id: str):
                cls.called_repo = repo_id
                return FakeDA3Model()

        class FakeMoGeModel:
            called_repo = None

            @classmethod
            def from_pretrained(cls, repo_id: str):
                cls.called_repo = repo_id
                return cls()

            def to(self, device=None):  # noqa: ARG002
                return self

            def eval(self):
                return self

            def infer(self, tensor):  # noqa: ARG002
                depth = np.linspace(0.5, 4.0, 12 * 16, dtype=np.float32).reshape(12, 16)
                normal = np.zeros((12, 16, 3), dtype=np.float32)
                normal[..., 2] = 1.0
                return {"depth": depth, "normal": normal}

        fake_da3_mod = mock.MagicMock(DepthAnything3=FakeDA3Cls)
        fake_moge_mod = mock.MagicMock(MoGeModel=FakeMoGeModel)
        with mock.patch.dict(
            sys.modules,
            {
                "depth_anything_3": mock.MagicMock(),
                "depth_anything_3.api": fake_da3_mod,
                "moge": mock.MagicMock(),
                "moge.model": mock.MagicMock(),
                "moge.model.v2": fake_moge_mod,
            },
        ):
            da3_out = game_ops.estimate_depth(img, repo_id="depth-anything/DA3MONO-LARGE", device="cpu")
            self.assertEqual(FakeDA3Cls.called_repo, "depth-anything/DA3MONO-LARGE")
            self.assertEqual(da3_out["depth"].size, (16, 12))
            self.assertEqual(da3_out["normal"].size, (16, 12))

            moge_out = game_ops.estimate_depth(img, repo_id="Ruicheng/moge-2-vitl-normal", device="cpu")
            self.assertEqual(FakeMoGeModel.called_repo, "Ruicheng/moge-2-vitl-normal")
            self.assertEqual(moge_out["depth"].size, (16, 12))
            self.assertEqual(moge_out["normal"].size, (16, 12))
            # 原生法线 (0, 0, 1) 编码为 RGB 约 (128, 128, 255)
            self.assertGreaterEqual(moge_out["normal"].getpixel((8, 6))[2], 254)


class LocalWorkshopRunnerTests(unittest.TestCase):
    def test_normalize_pip_spec_and_uv_fallback(self) -> None:
        import inference.game_ops as game_ops

        git_spec = "git+https://github.com/EasternJournalist/utils3d-moge.git@62f09d58509485564e24d5d9f6aac9ee9ebc0c37"
        self.assertEqual(game_ops._normalize_pip_spec(git_spec, has_git=True), git_spec)
        self.assertEqual(
            game_ops._normalize_pip_spec(git_spec, has_git=False),
            "https://github.com/EasternJournalist/utils3d-moge/archive/62f09d58509485564e24d5d9f6aac9ee9ebc0c37.tar.gz",
        )

        called_cmds = []
        import_calls = {"count": 0}

        def fake_import(name: str):
            if name == "utils3d_moge" and import_calls["count"] == 0:
                import_calls["count"] += 1
                raise ImportError("missing")
            return mock.MagicMock()

        def fake_which(cmd: str):
            return "/tmp/uv" if cmd == "uv" else None

        with (
            mock.patch("importlib.util.find_spec", return_value=None),
            mock.patch("shutil.which", side_effect=fake_which),
            mock.patch("subprocess.check_call", side_effect=lambda cmd: called_cmds.append(cmd)),
            mock.patch("importlib.import_module", side_effect=fake_import),
        ):
            game_ops._ensure_pip_packages([("utils3d_moge", git_spec)], purpose="MoGe-2")

        self.assertEqual(len(called_cmds), 1)
        self.assertEqual(called_cmds[0][:4], ["/tmp/uv", "pip", "install", "--python"])
        self.assertTrue(called_cmds[0][-1].endswith(".tar.gz"))

    def test_local_workshop_relight_preserves_zero_cfg(self) -> None:
        import worker.local_workshop as lw

        captured = {}

        def fake_run_ic_light(image, **kwargs):  # noqa: ARG001
            captured.update(kwargs)
            return "ok"

        with mock.patch("inference.game_ops.run_ic_light", side_effect=fake_run_ic_light):
            out = lw.run_relight(
                "img",
                {"gpuIndex": 0, "steps": 8, "outputEdge": 768, "options": {"prompt": "warm", "cfg": 0, "seed": 7}},
            )
        self.assertEqual(out, {"relit": "ok"})
        self.assertEqual(captured["guidance"], 0.0)
        self.assertEqual(captured["seed"], 7)


if __name__ == "__main__":
    import unittest as _unittest

    _unittest.main()
