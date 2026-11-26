"""Offline failure checks; media validation uses real FFmpeg when installed."""

import argparse
import contextlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import h3_sdcpp_probe as probe
import pih3_lakonlab_probe as pih3


class ProbeTests(unittest.TestCase):
    def test_baked_turbo_rejects_base_model_step_count(self):
        with patch("sys.argv", ["probe", "check", "--profile", "q4-turbo-clipproj", "--steps", "20"]), \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                probe.main()
        self.assertEqual(raised.exception.code, 2)

    def test_two_gpu_selection_rejects_physical_aliases(self):
        with patch.object(probe, "gpu_memory", return_value={"uuid": "GPU-same"}):
            with self.assertRaisesRegex(ValueError, "same physical GPU"):
                probe.selected_gpus("0,GPU-same", "split-components")
        with self.assertRaisesRegex(ValueError, "requires 2 GPU"):
            probe.selected_gpus("0", "split-dit")

    def test_multi_gpu_mapping_keeps_selected_order(self):
        with patch.object(probe, "gpu_memory", side_effect=lambda value: {"uuid": f"GPU-{value}"}):
            self.assertEqual(probe.selected_gpus("2,0", "split-components"),
                             [{"uuid": "GPU-2"}, {"uuid": "GPU-0"}])

    def test_clipproj_remote_check_uses_each_components_own_repository(self):
        files = probe.selected_files("q3-clipproj")
        def remote(url):
            repo = url.split("/api/models/")[1].split("/tree/")[0]
            entries = [{"path": name, "size": asset["bytes"], "lfs": {"oid": asset["sha256"]}}
                       for name, asset in files.items() if probe.source_of(asset)[0] == repo]
            return io.BytesIO(json.dumps(entries).encode())
        with patch.object(probe, "request", side_effect=remote):
            info = probe.inventory("q3-clipproj", Path("/nonexistent"), True)
        self.assertTrue(info["remote_verified"])
        self.assertLess(info["total_gib"], 17)

    def test_pih3_index_replaces_remote_sources_without_changing_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base"
            base.mkdir()
            original = {"_class_name": "MiniMaxH3ModularPipeline",
                        "transformer": ["diffusers", "AutoModel", {"pretrained_model_name_or_path": "multimodalart/MiniMax-H3-Pruned"}],
                        "vae": ["diffusers", "VAE", {"pretrained_model_name_or_path": "MiniMaxAI/MiniMax-H3"}]}
            (base / "modular_model_index.json").write_text(json.dumps(original))
            resolved = pih3.local_index(argparse.Namespace(base_dir=str(base), shared_dir=str(root / "shared")), root)
            index = json.loads((resolved / "modular_model_index.json").read_text())
            self.assertEqual(index["vae"][2]["pretrained_model_name_or_path"], str((root / "shared").resolve()))
            self.assertEqual(json.loads((base / "modular_model_index.json").read_text()), original)

    def test_pih3_unknown_remote_source_fails_before_loading_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "modular_model_index.json").write_text(json.dumps({
                "transformer": ["diffusers", "AutoModel", {"pretrained_model_name_or_path": "unexpected/repo"}]}))
            with self.assertRaisesRegex(ValueError, "Unknown component source"):
                pih3.local_index(argparse.Namespace(base_dir=directory, shared_dir=directory), root)

    def test_corrupt_download_does_not_publish_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source", root / "model"
            source.write_bytes(b"broken")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                probe.download(source.as_uri(), target, {"bytes": 6, "sha256": "0" * 64})
            self.assertFalse(target.exists())

    def test_existing_invalid_model_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model"
            target.write_bytes(b"keep")
            with self.assertRaises(ValueError):
                probe.download("https://invalid.example/model", target, {"bytes": 6, "sha256": "0" * 64})
            self.assertEqual(target.read_bytes(), b"keep")

    def test_archive_cannot_write_outside_engine_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / probe.MANIFEST["windowsVulkan"]["file"]
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escaped", "bad")
            with patch.object(probe.platform, "system", return_value="Windows"), \
                 patch.object(probe.platform, "machine", return_value="AMD64"), \
                 patch.object(probe, "download"):
                with self.assertRaisesRegex(ValueError, "leaves engine directory"):
                    probe.prepare_engine(root / "engine")
            self.assertFalse((root / "escaped").exists())

    def test_preflight_failure_is_reported_as_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("sys.argv", ["probe", "check", "--output-dir", directory, "--sd-bin", ""]), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(probe.main(), 1)
            reports = list(Path(directory).glob("*/report.json"))
            report = json.loads(reports[0].read_text())
            self.assertEqual(report["status"], "failed")
            self.assertFalse(report["inference_completed"])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg")
    def test_media_validator_checks_real_frames_and_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "fixture.avi"
            subprocess.run([
                "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=size=64x64:rate=24",
                "-f", "lavfi", "-i", "anullsrc=r=32000:cl=stereo", "-frames:v", "22", "-shortest",
                "-c:v", "mjpeg", "-c:a", "pcm_s16le", str(clip),
            ], check=True, capture_output=True, timeout=30)
            args = argparse.Namespace(width=64, height=64, frames=22)
            self.assertEqual(probe.validate_video(clip, args)["audio_channels"], 2)
            args.frames = 39
            with self.assertRaisesRegex(ValueError, "frame count / fps"):
                probe.validate_video(clip, args)
            silent = Path(directory) / "silent.avi"
            subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(clip),
                            "-an", "-c:v", "copy", str(silent)], check=True, capture_output=True, timeout=30)
            with self.assertRaisesRegex(ValueError, "one video and one audio"):
                probe.validate_video(silent, argparse.Namespace(width=64, height=64, frames=22))


if __name__ == "__main__":
    unittest.main()
