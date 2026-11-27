"""M4.0 基础设施离线单测：视频量化/加速策略（quant_accel）与游戏素材算子（game_ops）。"""

from __future__ import annotations

import sys
import unittest
from types import ModuleType, SimpleNamespace
from unittest import mock

import support  # noqa: F401 - 确保直接运行本文件时已挂载仓库根路径

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 无 Pillow 环境下仅跳过图像用例
    Image = None

from worker.inference import game_ops, quant_accel


class TestQuantAccel(unittest.TestCase):
    def test_parse_compute_capability(self) -> None:
        self.assertEqual(quant_accel.parse_compute_capability((8, 9)), (8, 9))
        self.assertEqual(quant_accel.parse_compute_capability("sm_80"), (8, 0))
        self.assertEqual(quant_accel.parse_compute_capability("7.5"), (7, 5))
        self.assertEqual(quant_accel.parse_compute_capability(89), (8, 9))
        self.assertIsNone(quant_accel.parse_compute_capability("bad"))

    def test_turing_t4_disables_fp8_and_sage_even_if_installed(self) -> None:
        caps = quant_accel.probe_accel_capabilities(
            gpu_cc=(7, 5),
            vram_mb=15109,
            module_probe=lambda name: name in {"torchao", "sageattention", "flash_attn"},
        )
        self.assertFalse(caps["hardware"]["bf16"])
        self.assertFalse(caps["hardware"]["fp8_tensor_core"])

        plan = quant_accel.resolve_video_plan(
            {"quantization": "torchao_fp8", "attention": "sage", "steps": 30},
            capabilities=caps,
        )
        self.assertEqual(plan.quantization, "none")
        self.assertEqual(plan.attention, "sdpa")
        self.assertEqual(plan.step_cache, "teacache")
        self.assertTrue(plan.vae_tiling)
        self.assertTrue(plan.t5_cpu_offload)

    def test_4090_ada_enables_fp8_sage_and_low_vram_protections(self) -> None:
        caps = quant_accel.probe_accel_capabilities(
            gpu_cc=(8, 9),
            vram_mb=24564,
            module_probe=lambda name: name in {"torchao", "sageattention"},
        )
        plan = quant_accel.resolve_video_plan(
            {"quantization": "auto", "attention": "auto", "steps": 30},
            capabilities=caps,
        )
        self.assertEqual(plan.quantization, "torchao_fp8")
        self.assertEqual(plan.attention, "sage")
        self.assertEqual(plan.step_cache, "teacache")
        self.assertTrue(plan.vae_tiling)
        self.assertTrue(plan.vae_slicing)
        self.assertTrue(plan.t5_cpu_offload)

    def test_distilled_or_low_steps_blocks_step_cache(self) -> None:
        caps = quant_accel.probe_accel_capabilities(
            gpu_cc=(8, 9),
            vram_mb=48000,
            module_probe=lambda _name: False,
        )
        plan = quant_accel.resolve_video_plan(
            {"stepCache": "teacache", "distilled": True, "steps": 8},
            capabilities=caps,
        )
        self.assertEqual(plan.step_cache, "none")
        self.assertFalse(plan.vae_tiling)
        self.assertIn("cache:disabled_for_distilled_or_low_steps", plan.reasons)

    def test_gguf_preferred_when_gguf_file_declared(self) -> None:
        caps = quant_accel.probe_accel_capabilities(
            gpu_cc=(8, 6),
            vram_mb=24000,
            module_probe=lambda name: name in {"gguf", "torchao"},
        )
        plan = quant_accel.resolve_video_plan(
            {"ggufFile": "wan2.2-ti2v-5b-Q4_K_M.gguf", "steps": 25},
            capabilities=caps,
        )
        self.assertEqual(plan.quantization, "gguf")

    def test_apply_video_runtime_opts_calls_pipeline_hooks(self) -> None:
        calls: list[str] = []

        class FakeTransformer:
            def set_attention_backend(self, name: str) -> None:
                calls.append(f"attn:{name}")

        class FakePipe:
            transformer = FakeTransformer()

            def enable_vae_tiling(self) -> None:
                calls.append("vae_tiling")

            def enable_vae_slicing(self) -> None:
                calls.append("vae_slicing")

            def enable_model_cpu_offload(self) -> None:
                calls.append("cpu_offload")

        plan = quant_accel.VideoAccelPlan(
            quantization="torchao_fp8",
            attention="sage",
            step_cache="none",
            vae_tiling=True,
            vae_slicing=True,
            t5_cpu_offload=True,
            model_cpu_offload=True,
            reasons=(),
        )
        quant_accel.apply_video_runtime_opts(FakePipe(), plan, log=lambda _msg: None)
        self.assertEqual(calls, ["attn:sage", "vae_tiling", "vae_slicing", "cpu_offload"])


class TestDepthGeometry(unittest.TestCase):
    """M4.2e-1：深度归一与法线生成的纯函数。"""

    def test_normalize_depth_array_uses_percentiles_and_ignores_nan(self) -> None:
        import numpy as np

        raw = np.array([[np.nan, 1.0], [2.0, 1000.0]], dtype=np.float32)
        field = game_ops._normalize_depth_array(raw)
        self.assertEqual(field.shape, (2, 2))
        self.assertTrue(np.isfinite(field).all())
        self.assertGreaterEqual(float(field.min()), 0.0)
        self.assertLessEqual(float(field.max()), 1.0)

    @unittest.skipIf(Image is None, "Pillow 未安装")
    def test_depth_to_normal_returns_rgb_matching_depth_size(self) -> None:
        import numpy as np

        depth = np.linspace(0, 1, 32 * 24, dtype=np.float32).reshape(24, 32)
        normal = game_ops.depth_to_normal(depth)
        self.assertEqual(normal.size, (32, 24))
        self.assertEqual(normal.mode, "RGB")
        center = normal.getpixel((16, 12))
        self.assertTrue(all(0 <= value <= 255 for value in center))


class TestGameOps(unittest.TestCase):
    def test_circular_padding_patch_restores_on_exit_and_exception(self) -> None:
        fake_torch = ModuleType("torch")
        fake_nn = ModuleType("torch.nn")

        class FakeConv2d:
            def __init__(self, padding_mode: str = "zeros") -> None:
                self.padding_mode = padding_mode

        class FakeModule:
            def __init__(self) -> None:
                self.conv_a = FakeConv2d("zeros")
                self.conv_b = FakeConv2d("reflect")
                self.conv_c = FakeConv2d("circular")

            def modules(self):
                return [self, self.conv_a, self.conv_b, self.conv_c]

        fake_nn.Conv2d = FakeConv2d
        fake_torch.nn = fake_nn

        mod = FakeModule()
        with mock.patch.dict(sys.modules, {"torch": fake_torch, "torch.nn": fake_nn}):
            with self.assertRaises(RuntimeError):
                with game_ops.CircularPaddingPatch(mod):
                    self.assertEqual(mod.conv_a.padding_mode, "circular")
                    self.assertEqual(mod.conv_b.padding_mode, "circular")
                    raise RuntimeError("boom")
            self.assertEqual(mod.conv_a.padding_mode, "zeros")
            self.assertEqual(mod.conv_b.padding_mode, "reflect")
            self.assertEqual(mod.conv_c.padding_mode, "circular")

    def test_vectorize_to_svg_requires_vtracer(self) -> None:
        with mock.patch.dict(sys.modules, {"vtracer": None}):
            with self.assertRaises(game_ops.MissingDependencyError):
                game_ops.vectorize_to_svg(b"fake")

    @unittest.skipIf(Image is None, "需要 Pillow")
    def test_pixel_snap_and_quantize(self) -> None:
        img = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
        for y in range(32, 96):
            for x in range(32, 96):
                img.putpixel((x, y), ((x * 3) % 255, (y * 2) % 255, 180, 255))

        out = game_ops.pixel_snap_and_quantize(img, 32, 32, colors=8, scale_back=4)
        self.assertEqual(out.size, (128, 128))
        # 验证 Alpha 被二值化锁定，没有半透明毛边
        alphas = set(out.getdata(3))
        self.assertTrue(alphas.issubset({0, 255}))

    @unittest.skipIf(Image is None, "需要 Pillow")
    def test_slice_sprite_sheet_and_atlas(self) -> None:
        sheet = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        # 在 2x2 格子的第 0 格和第 2 格放实心色块，第 1/3 格留全透明
        for y in range(4, 28):
            for x in range(4, 28):
                sheet.putpixel((x, y), (255, 0, 0, 255))
        for y in range(32, 64):
            for x in range(0, 32):
                sheet.putpixel((x, y), (0, 255, 0, 255))

        frames, atlas = game_ops.slice_sprite_sheet(sheet, rows=2, cols=2, trim_alpha=True)
        self.assertEqual(len(frames), 2)
        self.assertEqual(atlas["meta"]["count"], 2)
        self.assertEqual(atlas["frames"]["frame_000.png"]["trimmed"], True)
        self.assertEqual(atlas["frames"]["frame_000.png"]["spriteSourceSize"], {"x": 4, "y": 4, "w": 24, "h": 24})
        self.assertEqual(atlas["frames"]["frame_001.png"]["trimmed"], False)

    @unittest.skipIf(Image is None, "需要 Pillow")
    def test_seamless_analysis_and_blend(self) -> None:
        # 左半纯黑、右半纯白 → 左右边界极不连续
        bad = Image.new("RGB", (32, 32), (0, 0, 0))
        for y in range(32):
            for x in range(16, 32):
                bad.putpixel((x, y), (255, 255, 255))
        report_bad = game_ops.analyze_seamless_tile(bad)
        self.assertFalse(report_bad["isSeamless"])
        self.assertGreater(report_bad["horizontalSeamMae"], 200.0)

        fixed = game_ops.blend_seamless_edges(bad, border_ratio=0.25)
        report_fixed = game_ops.analyze_seamless_tile(fixed)
        # 融合后边界误差应显著降低且首尾可无缝衔接
        self.assertLess(report_fixed["horizontalSeamMae"], report_bad["horizontalSeamMae"])

        preview = game_ops.make_tile_preview_2x2(bad, max_side=48)
        self.assertEqual(preview.size, (48, 48))

    @unittest.skipIf(Image is None, "需要 Pillow")
    def test_vectorize_to_svg_with_mock_vtracer(self) -> None:
        captured: dict = {}
        fake_vtracer = SimpleNamespace(
            convert_raw_image_to_svg=lambda raw, **kw: captured.update({"len": len(raw), **kw}) or "<svg/>"
        )
        img = Image.new("RGBA", (16, 16), (255, 0, 0, 255))
        with mock.patch.dict(sys.modules, {"vtracer": fake_vtracer}):
            svg = game_ops.vectorize_to_svg(img, color_precision=4)
        self.assertEqual(svg, "<svg/>")
        self.assertEqual(captured["img_format"], "png")
        self.assertEqual(captured["color_precision"], 4)

    @unittest.skipIf(Image is None, "需要 Pillow")
    def test_marigold_pbr_visualize_intrinsics_maps_metallicity(self) -> None:
        class _FakeProcessor:
            def visualize_intrinsics(self, prediction, props):
                return [
                    {
                        "albedo": Image.new("RGB", (8, 8), (120, 80, 40)),
                        "roughness": Image.new("L", (8, 8), 200),
                        "metallicity": Image.new("L", (8, 8), 10),
                    }
                ]

            def visualize_normals(self, prediction):
                return [Image.new("RGB", (8, 8), (128, 128, 255))]

        class _FakeIidPipe:
            image_processor = _FakeProcessor()
            target_properties = {"albedo": {}, "roughness": {}, "metallicity": {}}

            def to(self, device):
                return self

            def __call__(self, rgb, num_inference_steps=4):
                return SimpleNamespace(prediction="raw")

        class _FakeNormPipe:
            image_processor = _FakeProcessor()

            def to(self, device):
                return self

            def __call__(self, rgb, num_inference_steps=4):
                return SimpleNamespace(prediction="raw-norm")

        fake_diffusers = SimpleNamespace(
            MarigoldIntrinsicsPipeline=SimpleNamespace(from_pretrained=lambda *a, **kw: _FakeIidPipe()),
            MarigoldNormalsPipeline=SimpleNamespace(from_pretrained=lambda *a, **kw: _FakeNormPipe()),
        )
        fake_torch = SimpleNamespace(
            float16="fp16",
            float32="fp32",
            cuda=SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None),
        )
        img = Image.new("RGB", (8, 8), (10, 20, 30))
        with mock.patch.dict(sys.modules, {"diffusers": fake_diffusers, "torch": fake_torch}):
            out = game_ops.run_marigold_pbr(img, steps=4, include_normals=True, device="cpu")
        self.assertEqual(set(out.keys()), {"albedo", "roughness", "metallic", "normal"})
        for channel_img in out.values():
            self.assertEqual(channel_img.size, (8, 8))
            self.assertIn(channel_img.mode, ("RGB", "L"))

    @unittest.skipIf(Image is None, "需要 Pillow")
    def test_chord_pbr_maps_channels_and_injects_sd21_config_dir(self) -> None:
        import io
        import tarfile
        import tempfile
        from pathlib import Path

        import numpy as np

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # 1. 验证 ensure_chord_repo 从本地 tar.gz 归档解包并跳过已缓存目录。
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                for rel, content in [
                    ("ubisoft-laforge-chord-main/chord/__init__.py", b"class ChordModel: pass\n"),
                    ("ubisoft-laforge-chord-main/config/chord.yaml", b"model:\n  stable_diffusion:\n    fp16: true\n"),
                ]:
                    info = tarfile.TarInfo(rel)
                    info.size = len(content)
                    tf.addfile(info, io.BytesIO(content))
            archive_file = root / "chord.tar.gz"
            archive_file.write_bytes(buf.getvalue())
            cache_dir = root / "cached-chord"
            resolved = game_ops.ensure_chord_repo(cache_dir, archive_url=archive_file.as_uri())
            self.assertEqual(resolved, cache_dir)
            self.assertTrue((cache_dir / "chord" / "__init__.py").is_file())

            # 2. 验证 run_chord_pbr 注入 sd21 本地配置目录并映射 4 通道。
            sd21_dir = root / "sd21-cfg"
            sd21_dir.mkdir()
            ckpt_file = root / "chord_v1.safetensors"
            ckpt_file.write_bytes(b"fake")

            recorded: dict[str, object] = {}

            class _FakeTensor:
                def __init__(self, arr: np.ndarray) -> None:
                    self._arr = arr
                    self.shape = arr.shape

                def permute(self, *dims: int) -> "_FakeTensor":
                    return _FakeTensor(np.transpose(self._arr, dims))

                def to(self, *args, **kwargs) -> "_FakeTensor":
                    return self

                def unsqueeze(self, dim: int) -> "_FakeTensor":
                    return _FakeTensor(np.expand_dims(self._arr, axis=dim))

                def dim(self) -> int:
                    return self._arr.ndim

                def clamp(self, lo: float, hi: float) -> "_FakeTensor":
                    return _FakeTensor(np.clip(self._arr, lo, hi))

                def detach(self) -> "_FakeTensor":
                    return self

                def float(self) -> "_FakeTensor":
                    return self

                def cpu(self) -> "_FakeTensor":
                    return self

                def numpy(self) -> np.ndarray:
                    return self._arr

                def __getitem__(self, idx):
                    return _FakeTensor(self._arr[idx])

            class _FakeChordModel:
                def __init__(self, cfg) -> None:
                    recorded["hf_key"] = cfg.model.stable_diffusion.hf_key
                    recorded["fp16"] = cfg.model.stable_diffusion.fp16
                    self.model = SimpleNamespace(dtype=None, device=None, sd=SimpleNamespace(dtype=None, device=None))

                def to(self, *args, **kwargs):
                    return self

                def load_state_dict(self, state_dict):
                    recorded["loaded_keys"] = sorted(state_dict.keys())

                def eval(self):
                    return self

                def __call__(self, x):
                    recorded["input_shape"] = x.shape
                    return {
                        "basecolor": _FakeTensor(np.full((1, 3, 8, 8), 0.5, dtype=np.float32)),
                        "normal": _FakeTensor(np.full((1, 3, 8, 8), 0.7, dtype=np.float32)),
                        "roughness": _FakeTensor(np.full((1, 1, 8, 8), 0.3, dtype=np.float32)),
                        "metalness": _FakeTensor(np.full((1, 1, 8, 8), 0.9, dtype=np.float32)),
                    }

            class _NoopCtx:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

            fake_cfg = SimpleNamespace(
                model=SimpleNamespace(stable_diffusion=SimpleNamespace(fp16=True, hf_key=None))
            )
            fake_torch = SimpleNamespace(
                float16="fp16",
                float32="fp32",
                bfloat16="bf16",
                device=lambda d: d,
                from_numpy=lambda arr: _FakeTensor(arr),
                no_grad=lambda: _NoopCtx(),
                autocast=lambda **kw: _NoopCtx(),
                cuda=SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None),
            )
            fake_tv_v2 = SimpleNamespace(
                Resize=lambda size, antialias=True: (
                    lambda t: _FakeTensor(np.zeros((t.shape[0], 3 if len(t.shape) == 4 else t.shape[0], size[0], size[1]) if len(t.shape) == 4 else (3, size[0], size[1]), dtype=np.float32))
                )
            )
            fake_tv = ModuleType("torchvision")
            fake_tv.transforms = SimpleNamespace(v2=fake_tv_v2)
            fake_hf = SimpleNamespace(
                hf_hub_download=lambda **kw: str(ckpt_file),
                snapshot_download=lambda **kw: str(sd21_dir),
            )
            fake_st = ModuleType("safetensors.torch")
            fake_st.load_file = lambda path, device="cpu": {"w": 1}
            fake_safetensors = ModuleType("safetensors")
            fake_safetensors.torch = fake_st
            fake_omegaconf = SimpleNamespace(OmegaConf=SimpleNamespace(load=lambda p: fake_cfg))
            fake_chord = SimpleNamespace(ChordModel=_FakeChordModel)

            img = Image.new("RGB", (8, 8), (40, 80, 120))
            with mock.patch.dict(
                sys.modules,
                {
                    "torch": fake_torch,
                    "torchvision": fake_tv,
                    "torchvision.transforms": fake_tv.transforms,
                    "torchvision.transforms.v2": fake_tv_v2,
                    "huggingface_hub": fake_hf,
                    "safetensors": fake_safetensors,
                    "safetensors.torch": fake_st,
                    "omegaconf": fake_omegaconf,
                    "chord": fake_chord,
                },
            ):
                out = game_ops.run_chord_pbr(img, device="cpu", code_dir=cache_dir)

            self.assertEqual(recorded["hf_key"], str(sd21_dir))
            self.assertFalse(recorded["fp16"])
            self.assertEqual(recorded["input_shape"], (1, 3, 1024, 1024))
            self.assertEqual(set(out.keys()), {"albedo", "normal", "roughness", "metallic"})
            for channel_img in out.values():
                self.assertEqual(channel_img.mode, "RGB")

            # 3. 验证 safe_open 流式加载兼容 transformers 5.x（扁平化 text_encoder 键名 + position_ids 非持久化缓冲区）。
            copied: list[str] = []

            class _CopyableParam:
                def __init__(self, name: str) -> None:
                    self.name = name
                    self.device = "cpu"
                    self.dtype = "fp32"

                def copy_(self, src) -> None:
                    copied.append(self.name)

            class _FakeSafeOpenChordModel(_FakeChordModel):
                def named_parameters(self):
                    return [
                        ("model.sd.text_encoder.embeddings.token_embedding.weight", _CopyableParam("tok")),
                        ("model.sd.unet.mid_block.weight", _CopyableParam("unet")),
                    ]

                def named_buffers(self):
                    return [
                        ("model.sd.text_encoder.embeddings.position_ids", _CopyableParam("pos_ids")),
                    ]

                def modules(self):
                    return [SimpleNamespace(_non_persistent_buffers_set={"position_ids"})]

            class _FakeSafeOpenCtx:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def keys(self):
                    return [
                        "model.sd.text_encoder.text_model.embeddings.token_embedding.weight",
                        "model.sd.unet.mid_block.weight",
                    ]

                def get_tensor(self, k: str):
                    return SimpleNamespace(to=lambda **kw: f"src:{k}")

            fake_st_stream = ModuleType("safetensors")
            fake_st_stream.safe_open = lambda path, framework="pt", device="cpu": _FakeSafeOpenCtx()
            fake_st_stream.torch = fake_st
            fake_chord_stream = SimpleNamespace(ChordModel=_FakeSafeOpenChordModel)
            with mock.patch.dict(
                sys.modules,
                {
                    "torch": fake_torch,
                    "torchvision": fake_tv,
                    "torchvision.transforms": fake_tv.transforms,
                    "torchvision.transforms.v2": fake_tv_v2,
                    "huggingface_hub": fake_hf,
                    "safetensors": fake_st_stream,
                    "safetensors.torch": fake_st,
                    "omegaconf": fake_omegaconf,
                    "chord": fake_chord_stream,
                },
            ):
                out2 = game_ops.run_chord_pbr(img, device="cpu", code_dir=cache_dir)
            self.assertEqual(copied, ["tok", "unet"])
            self.assertEqual(set(out2.keys()), {"albedo", "normal", "roughness", "metallic"})


if __name__ == "__main__":
    unittest.main()
