"""worker/hub_download.py 单元测试：ModelScope / HF-Mirror / HuggingFace 切换与自动回退。"""

from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[2]
_WORKER = _ROOT / "worker"
for _p in (str(_WORKER), str(_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import hub_download as hd  # noqa: E402
from worker.cache_ops import prefetch_weights  # noqa: E402
from worker.inference.loaders.base import LoadContext, ModelLoader  # noqa: E402


class HubDownloadTest(unittest.TestCase):
    def test_apply_model_source_sets_env(self) -> None:
        logs: list[str] = []
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(hd.apply_model_source("hf-mirror", log=logs.append), "hf-mirror")
            self.assertEqual(os.environ.get("AIGC_MODEL_SOURCE"), "hf-mirror")
            self.assertEqual(os.environ.get("HF_ENDPOINT"), hd.HF_MIRROR_ENDPOINT)
        self.assertTrue(any("hf-mirror" in line for line in logs))

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(hd.apply_model_source("invalid-source", log=logs.append), "huggingface")
            self.assertEqual(os.environ.get("AIGC_MODEL_SOURCE"), "huggingface")
            self.assertNotIn("HF_ENDPOINT", os.environ)

    def test_modelscope_snapshot_and_file_download_with_fallback(self) -> None:
        calls: list[tuple] = []
        fake_ms_hub = types.ModuleType("modelscope.hub")
        fake_ms_snapshot = types.ModuleType("modelscope.hub.snapshot_download")
        fake_ms_file = types.ModuleType("modelscope.hub.file_download")

        def ms_snapshot(**kwargs):  # noqa: ANN003, ANN202
            calls.append(("ms_snapshot", kwargs))
            if kwargs.get("model_id") == "only-on-hf/repo":
                raise RuntimeError("repo not found on modelscope")
            return "/tmp/ms-cache/zimage"

        def ms_file(**kwargs):  # noqa: ANN003, ANN202
            calls.append(("ms_file", kwargs))
            return "/tmp/ms-cache/lora.safetensors"

        fake_ms_snapshot.snapshot_download = ms_snapshot
        fake_ms_file.model_file_download = ms_file
        fake_ms_root = types.ModuleType("modelscope")

        fake_hf = types.ModuleType("huggingface_hub")
        fake_hf.snapshot_download = lambda **kw: (calls.append(("hf_snapshot", kw)), "/tmp/hf-cache/repo")[1]
        fake_hf.hf_hub_download = lambda **kw: (calls.append(("hf_file", kw)), "/tmp/hf-cache/file")[1]

        logs: list[str] = []
        with mock.patch.dict(
            sys.modules,
            {
                "modelscope": fake_ms_root,
                "modelscope.hub": fake_ms_hub,
                "modelscope.hub.snapshot_download": fake_ms_snapshot,
                "modelscope.hub.file_download": fake_ms_file,
                "huggingface_hub": fake_hf,
            },
        ):
            with mock.patch.dict(os.environ, {"AIGC_MODEL_SOURCE": "modelscope"}):
                snap = hd.hub_snapshot_download(
                    "Tongyi-MAI/Z-Image-Turbo", allow_patterns=["model_index.json"], log=logs.append
                )
                self.assertEqual(snap, "/tmp/ms-cache/zimage")

                f = hd.hub_file_download("ByteDance/SDXL-Lightning", "lora.safetensors", log=logs.append)
                self.assertEqual(f, "/tmp/ms-cache/lora.safetensors")

                # HF Space 跳过 ModelScope，直接走 huggingface_hub
                space_snap = hd.hub_snapshot_download(
                    "hugging-apps/demo", repo_type="space", allow_patterns=["*"], log=logs.append
                )
                self.assertEqual(space_snap, "/tmp/hf-cache/repo")

                # 魔搭缺失时自动回退 huggingface_hub
                fallback = hd.hub_snapshot_download("only-on-hf/repo", log=logs.append)
                self.assertEqual(fallback, "/tmp/hf-cache/repo")
                self.assertTrue(any("回退 HuggingFace" in line for line in logs))

                # 预下载在 modelscope 模式下返回本地目录，prepare_base 直接透传
                local_dir = prefetch_weights("Tongyi-MAI/Z-Image-Turbo", None, log=logs.append)
                self.assertEqual(local_dir, "/tmp/ms-cache/zimage")

        class _DummyCache:
            def resolve_local_model(self, repo):  # noqa: ANN001, ANN202
                return None

            def ensure_disk_capacity(self, spec):  # noqa: ANN001, ANN202
                return None

            def prefetch_weights(self, base, patterns):  # noqa: ANN001, ANN202
                return "/tmp/ms-cache/zimage"

        loader = ModelLoader()
        ctx = LoadContext(
            cache=_DummyCache(),
            log=logs.append,
            error_cls=RuntimeError,
            request_error_cls=ValueError,
            release_gpu=lambda: None,
        )
        with mock.patch.dict(os.environ, {"AIGC_MODEL_SOURCE": "modelscope"}):
            self.assertEqual(
                loader.prepare_base({"base": "Tongyi-MAI/Z-Image-Turbo"}, ctx),
                "/tmp/ms-cache/zimage",
            )


if __name__ == "__main__":
    unittest.main()
