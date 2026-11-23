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


if __name__ == "__main__":
    unittest.main()
