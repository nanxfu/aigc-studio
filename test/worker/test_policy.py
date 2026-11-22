"""显存策略覆写（cpuOffload）与 /health 上报。

阶段 0 的压测开关：默认 auto 必须与改造前逐字一致，on/off 必须参与管线缓存键，
否则 A/B 会命中旧管线、拿到上一次的加载耗时与显存峰值。

运行：python test/worker/test_policy.py
"""

from __future__ import annotations

import os
from unittest import mock

from support import DaemonUnitTest, d
from worker.inference import policy


class ParseModeTest(DaemonUnitTest):
    """输入归一：只认三种模式与常见 shell 写法，其余一律 None（不猜）。"""

    def test_canonical_modes(self) -> None:
        for raw in ("auto", "on", "off", "ON", " Off ", "AUTO"):
            self.assertIsNotNone(policy.parse_mode(raw), raw)

    def test_shell_aliases(self) -> None:
        self.assertEqual(policy.parse_mode("true"), "on")
        self.assertEqual(policy.parse_mode("1"), "on")
        self.assertEqual(policy.parse_mode("yes"), "on")
        self.assertEqual(policy.parse_mode("false"), "off")
        self.assertEqual(policy.parse_mode("0"), "off")
        self.assertEqual(policy.parse_mode("no"), "off")

    def test_unknown_and_empty_are_none(self) -> None:
        for raw in (None, "", "   ", "of", "enable", 2):
            self.assertIsNone(policy.parse_mode(raw), repr(raw))


class ResolveModeTest(DaemonUnitTest):
    """优先级：CLI > 环境变量 > auto；非法值回落 auto 且不阻断启动。"""

    def setUp(self) -> None:
        super().setUp()
        policy.set_cli_mode(None)
        policy.reset_cache()
        self.addCleanup(policy.set_cli_mode, None)
        self.addCleanup(policy.reset_cache)

    def test_default_is_auto(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(policy.CPU_OFFLOAD_ENV, None)
            policy.reset_cache()
            self.assertEqual(policy.resolve_mode(), ("auto", "default"))

    def test_env_is_used(self) -> None:
        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "off"}):
            policy.reset_cache()
            self.assertEqual(policy.resolve_mode(), ("off", "env"))

    def test_cli_beats_env(self) -> None:
        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "off"}):
            policy.set_cli_mode("on")
            self.assertEqual(policy.resolve_mode(), ("on", "cli"))

    def test_invalid_env_falls_back_to_auto_and_warns_once(self) -> None:
        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "of"}):
            policy.reset_cache()
            self.assertEqual(policy.resolve_mode(), ("auto", "default"))
            self.assertLogContains("无法识别，回落 auto")
            self.assertEqual(policy.resolve_mode(), ("auto", "default"))

    def test_invalid_cli_warns_and_keeps_env(self) -> None:
        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "on"}):
            policy.set_cli_mode("maybe")
            self.assertEqual(policy.resolve_mode(), ("on", "env"))
            self.assertLogContains("--cpu-offload")


class ApplyPolicyTest(DaemonUnitTest):
    """覆写只改 cpuOffload，不碰其它键；auto 不拷贝（缓存键逐字节不变）。"""

    def setUp(self) -> None:
        super().setUp()
        policy.set_cli_mode(None)
        policy.reset_cache()
        self.addCleanup(policy.set_cli_mode, None)
        self.addCleanup(policy.reset_cache)

    def test_auto_returns_same_object(self) -> None:
        spec = {"loader": "flux2", "base": "black-forest-labs/FLUX.2-klein-9B", "cpuOffload": True}
        patched, info = policy.apply(spec, mode="auto")
        self.assertIs(patched, spec)
        self.assertEqual(info["effective"], True)
        self.assertFalse(info["overridden"])

    def test_off_forces_false_without_mutating_input(self) -> None:
        spec = {"loader": "flux2", "base": "org/model", "cpuOffload": True, "deviceMap": "balanced"}
        patched, info = policy.apply(spec, mode="off")
        self.assertIsNot(patched, spec)
        self.assertIs(patched["cpuOffload"], False)
        self.assertIs(spec["cpuOffload"], True, "请求体持有的 dict 不能被就地修改")
        self.assertEqual(patched["deviceMap"], "balanced", "其它键原样保留")
        self.assertTrue(info["overridden"])
        self.assertEqual(info["requested"], True)

    def test_on_forces_true_for_undeclared_model(self) -> None:
        spec = {"loader": "sdxl", "base": "stabilityai/stable-diffusion-xl-base-1.0"}
        patched, info = policy.apply(spec, mode="on")
        self.assertIs(patched["cpuOffload"], True)
        self.assertIsNone(info["requested"])
        self.assertTrue(info["overridden"])

    def test_no_copy_when_asset_already_matches(self) -> None:
        spec = {"loader": "zimage", "base": "Tongyi-MAI/Z-Image-Turbo", "cpuOffload": True}
        patched, info = policy.apply(spec, mode="on")
        self.assertIs(patched, spec)
        self.assertFalse(info["overridden"])

    def test_env_mode_is_applied_when_mode_omitted(self) -> None:
        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "off"}):
            policy.reset_cache()
            patched, info = policy.apply({"loader": "qwen-image-2.1", "base": "Qwen/x", "cpuOffload": True})
        self.assertIs(patched["cpuOffload"], False)
        self.assertEqual(info["source"], "env")

    def test_payload_shape(self) -> None:
        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "off"}):
            policy.reset_cache()
            payload = policy.cpu_offload_payload(effective=False)
        self.assertEqual(payload, {"mode": "off", "source": "env", "effective": False})
        # 非布尔（未加载传 None）一律归一成 null，避免 /health 出现 "None" 字符串。
        self.assertIsNone(policy.cpu_offload_payload(effective="x")["effective"])


class EnsurePipelineOverrideTest(DaemonUnitTest):
    """覆写必须发生在缓存键之前：切换开关要重新加载，而不是命中旧管线。"""

    def setUp(self) -> None:
        super().setUp()
        policy.set_cli_mode(None)
        policy.reset_cache()
        self.addCleanup(policy.set_cli_mode, None)
        self.addCleanup(policy.reset_cache)

    def _run(self, spec: dict, loaded: list[dict]) -> None:
        def fake_build(captured):  # noqa: ANN001
            loaded.append(dict(captured))
            return object(), f"{captured.get('loader')}:{captured.get('base')}"

        with (
            mock.patch.object(d.CACHE, "log_probe_once"),
            mock.patch.object(d.CACHE, "ensure_cache_capacity"),
            mock.patch.object(d, "build_pipeline", side_effect=fake_build),
            mock.patch.object(d, "pipe_signature_params", return_value=set()),
            mock.patch.object(d, "reset_peak_memory_stats"),
            mock.patch.object(d, "release_pipeline"),
        ):
            d.ensure_pipeline(spec)

    def test_off_overrides_before_cache_key_and_reloads_on_switch(self) -> None:
        loaded: list[dict] = []
        spec = {"loader": "flux2", "base": "black-forest-labs/FLUX.2-klein-9B", "cpuOffload": True}

        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "off"}):
            policy.reset_cache()
            self._run(spec, loaded)
            self._run(spec, loaded)
            self.assertEqual(len(loaded), 1, "同一模式下第二次调用应命中缓存")
            self.assertIs(loaded[0]["cpuOffload"], False)
            self.assertIs(d.STATE.cpu_offload_effective, False)
            self.assertLogContains("显存策略覆写")

            # 切到 on：缓存键必须变化，触发第二次真实加载。
            policy.set_cli_mode("on")
            self._run(spec, loaded)
            self.assertEqual(len(loaded), 2, "模式变化必须重新加载")
            self.assertIs(loaded[1]["cpuOffload"], True)
            self.assertIs(d.STATE.cpu_offload_effective, True)

    def test_auto_keeps_model_asset_value(self) -> None:
        loaded: list[dict] = []
        spec = {"loader": "flux2", "base": "black-forest-labs/FLUX.2-klein-9B", "cpuOffload": True}
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(policy.CPU_OFFLOAD_ENV, None)
            policy.reset_cache()
            self._run(spec, loaded)
        self.assertIs(loaded[0]["cpuOffload"], True)
        self.assertIs(d.STATE.cpu_offload_effective, True)


class BuildPipelineOverrideTest(DaemonUnitTest):
    """直接调 build_pipeline（工具 / 单测路径）也要吃到同一个开关。"""

    def setUp(self) -> None:
        super().setUp()
        policy.set_cli_mode(None)
        policy.reset_cache()
        self.addCleanup(policy.set_cli_mode, None)
        self.addCleanup(policy.reset_cache)

    def test_build_pipeline_applies_env_mode(self) -> None:
        captured: dict = {}

        def fake_build(spec, _ctx):  # noqa: ANN001
            captured.update(spec)
            return object(), "flux2:org/model"

        with mock.patch.dict(os.environ, {policy.CPU_OFFLOAD_ENV: "off"}):
            policy.reset_cache()
            with mock.patch.object(d.LOADERS, "build", side_effect=fake_build):
                d.build_pipeline({"loader": "flux2", "base": "org/model", "cpuOffload": True})
        self.assertIs(captured["cpuOffload"], False)


if __name__ == "__main__":
    import unittest

    unittest.main()
