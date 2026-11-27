"""图生 3D（``tool=mesh3d``，M4.4a-1）：协议归一、源图校验、执行占位与二进制产物。

覆盖 M4.4a-1 的远端链路（没有 GPU 也能跑）：

1. ``normalize_tool`` 接受 mesh3d，``validate_generate_spec`` 不读扩散 pipeline；
2. 源图只收带 Alpha 的 PNG（RGBA / LA / P+tRNS），RGB PNG / JPEG / 蒙版一律 400；
3. 模型白名单、``targetFaces`` 钳制、``texture`` 能力校验（a 段只有白模）；
4. daemon 的 ``parse_reference_spec`` 按伪 loader 分流到 3D 源图校验；
5. ``execute_job`` 在推理未接入时以 ``mesh3d_unavailable`` + ``load_failed`` 明确失败；
6. ``worker/jobs/artifacts.py`` 的 binary 模式能把 ``glb_b64`` 落成 ``0.glb``，
   ``/artifact`` 读取端回报 ``model/gltf-binary``。

真实几何推理（Hunyuan3D-2mini 权重）不在本文件覆盖范围内：本机无 GPU、也不能下载权重，
那段路径随 M4.4a-2 接入后在真机上验证。

运行：python test/worker/test_mesh3d.py
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from support import (  # noqa: E402
    CONTRACT_DOC,
    DaemonUnitTest,
    FakePILImage,
    d,
    fake_pil_for,
    make_reference,
)

import worker.jobs.artifacts as artifacts  # noqa: E402
import worker.transport.validator as remote_validator  # noqa: E402
from worker.jobs.models import Job  # noqa: E402

HAS_NUMPY = importlib.util.find_spec("numpy") is not None
HAS_PILLOW = importlib.util.find_spec("PIL") is not None

MESH3D_LIMITS = CONTRACT_DOC["limits"]["mesh3d"]
TARGET_FACES = MESH3D_LIMITS["targetFaces"]
DEFAULT_REPO = MESH3D_LIMITS["models"][0]["repo"]


def make_mesh3d_spec(
    *,
    model=None,
    target_faces=None,
    texture=None,
    reference=None,
    **extra,
):  # noqa: ANN001, ANN201
    """构造图生 3D 请求体：``{tool, reference, mesh3d:{model, targetFaces, texture}}``。

    与 Host 的远端载荷同形（Host 同时下发顶层 ``model`` 与 ``mesh3d`` 块）；
    用例要测顶层/嵌套不一致时用 ``**extra`` 覆盖。
    """
    block = {}
    if model is not None:
        block["model"] = model
    if target_faces is not None:
        block["targetFaces"] = target_faces
    if texture is not None:
        block["texture"] = texture
    body = {
        "tool": "mesh3d",
        "reference": make_reference() if reference is None else reference,
        "mesh3d": block,
    }
    if model is not None:
        body["model"] = model
    body.update(extra)
    return body


class Mesh3dToolSpecTest(DaemonUnitTest):
    """tool 归一与契约边界。"""

    def test_tool_is_registered_remotely(self) -> None:
        self.assertIn("mesh3d", remote_validator.REMOTE_TOOLS)
        self.assertEqual(remote_validator.normalize_tool({"tool": "mesh3d"}), "mesh3d")
        # 3D 是任务不是通道：不得混进工坊算子集合。
        self.assertNotIn("mesh3d", remote_validator.WORKSHOP_TOOLS)

    def test_contract_limits_are_shipped(self) -> None:
        self.assertEqual(MESH3D_LIMITS["maxInputEdge"], 1024)
        self.assertEqual(MESH3D_LIMITS["minInputEdge"], 256)
        self.assertEqual(MESH3D_LIMITS["texture"], False)
        self.assertEqual(MESH3D_LIMITS["models"][0]["id"], "hunyuan3d-2mini")


class Mesh3dSpecValidationTest(DaemonUnitTest):
    """提交期校验（假 PIL，不加载任何模型）。"""

    def validate(self, spec, *, image=None):
        self.contract_config()
        fake = image if image is not None else FakePILImage((512, 512), mode="RGBA")
        with mock.patch.dict(sys.modules, fake_pil_for(fake)):
            return d.validate_generate_spec(spec)

    def test_defaults_produce_white_model_pipeline(self) -> None:
        pipeline, model_id, tasks, tool = self.validate(make_mesh3d_spec())
        self.assertEqual(tool, "mesh3d")
        self.assertEqual(model_id, DEFAULT_REPO)
        self.assertEqual(pipeline["loader"], remote_validator.MESH3D_PIPELINE_LOADER)
        self.assertEqual(pipeline["base"], "mesh3d")
        block = pipeline["mesh3d"]
        self.assertEqual(block["model"], "hunyuan3d-2mini")
        self.assertEqual(block["repo"], DEFAULT_REPO)
        self.assertEqual(block["targetFaces"], TARGET_FACES["default"])
        self.assertEqual(block["texture"], False)
        self.assertEqual(block["implemented"], False, "a-1 阶段推理尚未接入")
        self.assertEqual(len(tasks), 1)
        self.assertEqual((tasks[0]["width"], tasks[0]["height"]), (512, 512))
        self.assertEqual((tasks[0]["steps"], tasks[0]["cfg"]), (0, 0.0))
        self.assertEqual(tasks[0]["prompt"], "")

    def test_target_faces_are_clamped(self) -> None:
        _pipeline, _model, tasks, _tool = self.validate(make_mesh3d_spec(target_faces=TARGET_FACES["max"] + 10))
        self.assertEqual(tasks[0]["name"], "01")
        pipeline, _model, _tasks, _tool = self.validate(
            make_mesh3d_spec(target_faces=TARGET_FACES["max"] + 10)
        )
        self.assertEqual(pipeline["mesh3d"]["targetFaces"], TARGET_FACES["max"])
        pipeline, _model, _tasks, _tool = self.validate(make_mesh3d_spec(target_faces=1))
        self.assertEqual(pipeline["mesh3d"]["targetFaces"], TARGET_FACES["min"])

    def test_non_integer_target_faces_is_rejected(self) -> None:
        for bad in (1.5, "many", True):
            with self.assertRaises(d.RequestError, msg=f"targetFaces={bad!r} 应被拒绝"):
                self.validate(make_mesh3d_spec(target_faces=bad))

    def test_texture_true_is_rejected_for_white_model(self) -> None:
        with self.assertRaises(d.RequestError) as raised:
            self.validate(make_mesh3d_spec(texture=True))
        self.assertIn("白模", str(raised.exception))
        with self.assertRaises(d.RequestError):
            self.validate(make_mesh3d_spec(texture="yes"))

    def test_texture_is_allowed_when_model_supports_it(self) -> None:
        self.contract_config()
        d.CONFIG.contract = {
            "limits": {
                "mesh3d": {
                    "models": [
                        {"id": "hunyuan3d-2mini", "repo": "tencent/Hunyuan3D-2.1", "texture": True}
                    ]
                }
            }
        }
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage((512, 512), mode="RGBA"))):
            pipeline, model_id, _tasks, _tool = d.validate_generate_spec(make_mesh3d_spec(texture=True))
        self.assertEqual(model_id, "tencent/Hunyuan3D-2.1")
        self.assertTrue(pipeline["mesh3d"]["texture"])

    def test_unknown_model_is_rejected(self) -> None:
        for bad in ("nope", "hunyuan3d-2.1"):
            with self.assertRaises(d.RequestError, msg=f"model={bad!r} 应被拒绝"):
                self.validate(make_mesh3d_spec(model=bad))

    def test_top_level_and_nested_model_must_match(self) -> None:
        spec = make_mesh3d_spec(model="hunyuan3d-2mini")
        spec["mesh3d"]["model"] = "other"
        with self.assertRaises(d.RequestError) as raised:
            self.validate(spec)
        self.assertIn("不一致", str(raised.exception))

    def test_source_must_carry_alpha(self) -> None:
        with self.assertRaises(d.RequestError) as raised:
            self.validate(make_mesh3d_spec(), image=FakePILImage((512, 512), mode="RGB"))
        self.assertIn("透明通道", str(raised.exception))
        # 灰度 + Alpha 同样合法。
        self.validate(make_mesh3d_spec(), image=FakePILImage((512, 512), mode="LA"))

    def test_palette_png_needs_trns_to_count_as_alpha(self) -> None:
        palette = FakePILImage((512, 512), mode="P")
        palette.info = {}
        with self.assertRaises(d.RequestError):
            self.validate(make_mesh3d_spec(), image=palette)
        palette_with_trns = FakePILImage((512, 512), mode="P")
        palette_with_trns.info = {"transparency": 0}
        self.validate(make_mesh3d_spec(), image=palette_with_trns)

    def test_jpeg_source_is_rejected(self) -> None:
        with self.assertRaises(d.RequestError) as raised:
            self.validate(make_mesh3d_spec(), image=FakePILImage((512, 512), fmt="JPEG", mode="RGBA"))
        self.assertIn("PNG", str(raised.exception))

    def test_mask_is_rejected(self) -> None:
        reference = make_reference(mask_b64=make_reference()["image_b64"])
        with self.assertRaises(d.RequestError) as raised:
            self.validate(make_mesh3d_spec(reference=reference))
        self.assertIn("不支持蒙版", str(raised.exception))

    def test_missing_reference_is_rejected(self) -> None:
        for bad in (None, "", "image-b64", []):
            with self.assertRaises(d.RequestError, msg=f"reference={bad!r} 应被拒绝"):
                self.validate({"tool": "mesh3d", "reference": bad})

    def test_reference_images_are_rejected(self) -> None:
        spec = make_mesh3d_spec()
        spec["referenceImages"] = [{"image_b64": make_reference()["image_b64"]}]
        with self.assertRaises(d.RequestError) as raised:
            self.validate(spec)
        self.assertIn("referenceImages", str(raised.exception))

    def test_source_long_edge_must_fit_limit(self) -> None:
        size = (MESH3D_LIMITS["maxInputEdge"], 512)
        self.validate(make_mesh3d_spec(), image=FakePILImage(size, mode="RGBA"))
        with self.assertRaises(d.RequestError) as raised:
            self.validate(
                make_mesh3d_spec(),
                image=FakePILImage((MESH3D_LIMITS["maxInputEdge"] + 64, 512), mode="RGBA"),
            )
        self.assertIn(str(MESH3D_LIMITS["maxInputEdge"]), str(raised.exception))

    def test_source_min_edge_is_enforced(self) -> None:
        # minInputEdge 是「长边下限」：两个方向都小于它才会被拒。
        short_edge = MESH3D_LIMITS["minInputEdge"] - 16
        with self.assertRaises(d.RequestError):
            self.validate(
                make_mesh3d_spec(),
                image=FakePILImage((short_edge, short_edge), mode="RGBA"),
            )

    def test_source_bytes_limit_is_enforced(self) -> None:
        oversized = "A" * (MESH3D_LIMITS["maxBytes"] // 3 * 4 + 8)
        with self.assertRaises(d.RequestError) as raised:
            self.validate(make_mesh3d_spec(reference={"image_b64": oversized}))
        self.assertIn("上限", str(raised.exception))


class Mesh3dDaemonDispatchTest(DaemonUnitTest):
    """daemon 薄包装按伪 loader 分流；执行分支在 a-1 阶段明确失败。"""

    def build_job(self):  # noqa: ANN201
        self.contract_config()
        spec = make_mesh3d_spec()
        with mock.patch.dict(sys.modules, fake_pil_for(FakePILImage((512, 512), mode="RGBA"))):
            pipeline, model_id, tasks, tool = d.validate_generate_spec(spec)
            reference = d.parse_reference_spec(spec["reference"], pipeline)
        job, created = d.JOB_STORE.submit(pipeline, model_id, tasks, "m44-mesh3d", reference, tool=tool)
        self.assertTrue(created)
        return job, pipeline, reference

    def test_parse_reference_spec_dispatches_by_loader(self) -> None:
        _job, pipeline, reference = self.build_job()
        self.assertEqual(pipeline["loader"], remote_validator.MESH3D_PIPELINE_LOADER)
        self.assertEqual((reference["width"], reference["height"]), (512, 512))
        self.assertIn("image_bytes", reference)

    def test_execute_job_reports_mesh3d_unavailable(self) -> None:
        job, _pipeline, _reference = self.build_job()
        with mock.patch.object(
            d, "decode_reference_image", return_value=FakePILImage((512, 512), mode="RGBA")
        ), mock.patch.object(
            d, "ensure_pipeline", side_effect=AssertionError("图生 3D 不得加载扩散 pipeline")
        ), mock.patch.object(d, "free_cuda_cache") as free_cache:
            d.execute_job(job)
        self.assertEqual(job.status, d.JOB_STATUS_FAILED)
        self.assertEqual(job.error["code"], "load_failed")
        self.assertIn("mesh3d_unavailable", job.error["message"])
        self.assertIn("M4.4a-2", job.error["message"])
        self.assertTrue(free_cache.called, "GPU 算子失败也要清显存")


class Mesh3dArtifactTest(DaemonUnitTest):
    """binary 模式把 ``glb_b64`` 落成 ``.glb`` 并以 ``model/gltf-binary`` 提供。"""

    def setUp(self) -> None:
        super().setUp()
        self.root = tempfile.mkdtemp(prefix="aigc-mesh3d-artifacts-")
        self.env = mock.patch.dict(os.environ, {artifacts.ARTIFACT_DIR_ENV: self.root})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        shutil.rmtree(self.root, ignore_errors=True)
        super().tearDown()

    def _job(self) -> Job:
        return Job(
            job_id="job-mesh3d-1",
            model_id=DEFAULT_REPO,
            pipeline={"loader": "mesh3d"},
            tasks=[{"name": "01"}],
            result_mode="binary",
        )

    def test_glb_payload_is_materialized(self) -> None:
        job = self._job()
        payload = b"glTF" + b"\x02\x00\x00\x00" + b"\x0c\x00\x00\x00" + b"\x00" * 4
        results = [
            {
                "name": "01",
                "seed": 7,
                "mediaType": "mesh3d",
                "glb_b64": base64.b64encode(payload).decode("ascii"),
            }
        ]
        materialized = artifacts.materialize_results(job, results)
        job.results = materialized
        self.assertEqual(len(materialized), 1)
        meta = materialized[0]
        self.assertNotIn("glb_b64", meta)
        self.assertEqual(meta["media_type"], "model/gltf-binary")
        self.assertEqual(meta["bytes"], len(payload))
        self.assertEqual(meta["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(meta["artifact_file"], "0.glb")
        self.assertEqual(meta["mediaType"], "mesh3d", "结果里的媒体类型必须保留")
        self.assertTrue(os.path.isfile(os.path.join(job.artifact_dir, "0.glb")))

        info = artifacts.artifact_file(job, 0)
        self.assertIsNotNone(info)
        self.assertEqual(info["media_type"], "model/gltf-binary")
        self.assertTrue(info["path"].endswith("0.glb"))

    def test_image_payload_still_writes_png(self) -> None:
        job = self._job()
        payload = b"\x89PNG\r\n\x1a\nbody"
        materialized = artifacts.materialize_results(
            job, [{"name": "01", "image_b64": base64.b64encode(payload).decode("ascii")}]
        )
        self.assertEqual(materialized[0]["media_type"], "image/png")
        self.assertEqual(materialized[0]["artifact_file"], "0.png")

    def test_unsafe_artifact_name_is_rejected(self) -> None:
        job = self._job()
        payload = b"glTFpayload"
        materialized = artifacts.materialize_results(
            job, [{"name": "01", "glb_b64": base64.b64encode(payload).decode("ascii")}]
        )
        job.results = materialized
        # meta 来自本进程，但读取端仍不接受带路径分隔符的文件名。
        job.results[0]["artifact_file"] = "../0.glb"
        self.assertIsNone(artifacts.artifact_file(job, 0))


class Mesh3dMockDaemonTest(DaemonUnitTest):
    """``test/mock-daemon.py`` 的 3D 分支与真 daemon 同口径（离线回归的「远端」由它扮演）。

    只测纯函数（校验 + GLB 构造）：HTTP 面由 Node 侧的 ``test/host-mesh3d.mjs`` 覆盖。
    """

    def load_mock(self):  # noqa: ANN201
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        mock_path = os.path.join(root, "test", "mock-daemon.py")
        spec = importlib.util.spec_from_file_location("mock_daemon_mesh3d", mock_path)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    @unittest.skipUnless(HAS_PILLOW, "需要 Pillow 才能构造真实 PNG 头")
    def _png(self, mode: str = "RGBA", size=(512, 512)) -> str:
        import io

        from PIL import Image

        buffer = io.BytesIO()
        Image.new(mode, size, 0).save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("ascii")

    @unittest.skipUnless(HAS_PILLOW, "需要 Pillow 才能构造真实 PNG 头")
    def test_validate_spec_matches_contract(self) -> None:
        mock_module = self.load_mock()
        pipeline, repo, tasks, reference = mock_module.validate_mesh3d_spec(
            {
                "tool": "mesh3d",
                "model": "hunyuan3d-2mini",
                "reference": {"image_b64": self._png()},
                "mesh3d": {"model": "hunyuan3d-2mini", "targetFaces": 999999},
            }
        )
        self.assertEqual(repo, DEFAULT_REPO)
        self.assertEqual(pipeline["loader"], "mesh3d")
        self.assertEqual(pipeline["mesh3d"]["targetFaces"], TARGET_FACES["max"])
        self.assertFalse(pipeline["mesh3d"]["texture"])
        self.assertEqual(len(tasks), 1)
        self.assertEqual((tasks[0]["width"], tasks[0]["height"]), (512, 512))
        self.assertEqual(reference["width"], 512)

    @unittest.skipUnless(HAS_PILLOW, "需要 Pillow 才能构造真实 PNG 头")
    def test_validate_spec_rejects_rgb_and_texture(self) -> None:
        mock_module = self.load_mock()
        with self.assertRaises(ValueError) as raised:
            mock_module.validate_mesh3d_spec(
                {"tool": "mesh3d", "reference": {"image_b64": self._png(mode="RGB")}}
            )
        self.assertIn("透明通道", str(raised.exception))
        with self.assertRaises(ValueError):
            mock_module.validate_mesh3d_spec(
                {
                    "tool": "mesh3d",
                    "reference": {"image_b64": self._png()},
                    "mesh3d": {"texture": True},
                }
            )

    def test_glb_builder_emits_valid_container(self) -> None:
        mock_module = self.load_mock()
        glb, stats = mock_module._build_glb(TARGET_FACES["default"])
        self.assertEqual(glb[:4], b"glTF")
        self.assertEqual(int.from_bytes(glb[8:12], "little"), len(glb))
        self.assertGreater(stats["triangles"], 0)
        self.assertGreater(stats["vertices"], 0)
        self.assertEqual(stats["materials"], 1)
        self.assertFalse(stats["hasTexture"])

    def test_truncated_mode_is_shorter_than_declared(self) -> None:
        mock_module = self.load_mock()
        glb, _stats = mock_module._build_glb(TARGET_FACES["default"])
        # 与 --mesh3d-truncate 的裁剪口径一致：尾部少 9 字节，声明长度不再匹配。
        truncated = glb[: max(0, len(glb) - 9)]
        self.assertLess(len(truncated), int.from_bytes(truncated[8:12], "little"))


if __name__ == "__main__":
    unittest.main()
