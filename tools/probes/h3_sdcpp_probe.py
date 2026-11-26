#!/usr/bin/env python3
"""H3 GGUF probe using upstream sd-cli, without ComfyUI or Python ML packages.

inspect: inspect the pinned four-component inventory; no model downloads.
check: validate the upstream H3 DGL graph without loading model weights.
download: explicitly download and verify only the selected profile's files.
run: use already downloaded weights on one or two NVIDIA GPUs and validate AV output.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path


MANIFEST = json.loads(Path(__file__).with_name("h3-sdcpp-assets.json").read_text(encoding="utf-8"))
GIB = 1024**3
PROMPT = (
    "A red fox walks through a snowy pine forest at dawn, "
    "the camera tracks beside it, natural motion. "
    "Sound: snow crunching under its paws, gentle wind, distant birds. No music."
)


def request(url: str):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "aigc-studio-h3-probe"}),
        timeout=60,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024**2), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: Path, asset: dict) -> None:
    if not path.is_file() or path.stat().st_size != asset["bytes"]:
        raise ValueError(f"Missing or incomplete file: {path}")
    if sha256(path) != asset["sha256"]:
        raise ValueError(f"SHA-256 mismatch: {path}")


def download(url: str, path: Path, asset: dict) -> None:
    if path.exists():
        verify(path, asset)
        print(f"Verified existing file: {path.name}", flush=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    print(f"Downloading {path.name}: {asset['bytes'] / GIB:.2f} GiB", flush=True)
    # Restart partial files; leave a failed transfer for diagnosis, never publish it.
    with request(url) as incoming, partial.open("wb") as outgoing:
        shutil.copyfileobj(incoming, outgoing, length=4 * 1024**2)
    verify(partial, asset)
    partial.replace(path)


def selected_files(profile: str) -> dict:
    selected = MANIFEST["profiles"][profile]
    names = [selected["diffusion"], selected["text"],
             "vae/minimax_h3_video_vae_fp16.safetensors",
             "vae/minimax_h3_audio_vae_fp32.safetensors"]
    names += [selected[key] for key in ("connector", "vision") if key in selected]
    return {name: MANIFEST["files"][name] for name in names}


def source_of(asset: dict) -> tuple[str, str]:
    return asset.get("repo", MANIFEST["modelRepo"]), asset.get("revision", MANIFEST["modelRevision"])


def inventory(profile: str, model_dir: Path, remote: bool) -> dict:
    files = selected_files(profile)
    if remote:
        def read_tree(source):
            repo, revision = source
            with request(f"https://huggingface.co/api/models/{repo}/tree/{revision}?recursive=true") as incoming:
                return source, {item["path"]: item for item in json.load(incoming)}

        sources = sorted({source_of(asset) for asset in files.values()})
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            trees = dict(pool.map(read_tree, sources))
        for name, asset in files.items():
            item = trees[source_of(asset)].get(name, {})
            if item.get("size") != asset["bytes"] or item.get("lfs", {}).get("oid") != asset["sha256"]:
                raise ValueError(f"Pinned remote asset differs from manifest: {name}")
    return {
        "repo": MANIFEST["modelRepo"], "revision": MANIFEST["modelRevision"],
        "profile": profile, "remote_verified": remote,
        "conditioning": MANIFEST["profiles"][profile].get("conditioning", "original MiniMax-H3 32B encoder, quantized"),
        "total_gib": round(sum(item["bytes"] for item in files.values()) / GIB, 3),
        "files": [{"file": name, **asset, "exists": (model_dir / name).is_file()}
                  for name, asset in files.items()],
    }


def prepare_engine(engine_dir: Path) -> Path:
    if platform.system() != "Windows" or platform.machine().lower() not in ("amd64", "x86_64"):
        raise ValueError("--prepare-engine uses Windows x64 Vulkan; on Linux build CUDA and pass --sd-bin")
    asset = MANIFEST["windowsVulkan"]
    archive = engine_dir.parent / asset["file"]
    url = (f"https://github.com/{MANIFEST['sourceRepo']}/releases/download/"
           f"{MANIFEST['release']}/{asset['file']}")
    download(url, archive, asset)
    destination = engine_dir.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            target = (destination / entry.filename).resolve()
            if not target.is_relative_to(destination):
                raise ValueError(f"Archive entry leaves engine directory: {entry.filename}")
        bundle.extractall(destination)
    binaries = list(destination.rglob("sd-cli.exe"))
    if len(binaries) != 1:
        raise ValueError("Engine archive must contain exactly one sd-cli.exe")
    return binaries[0]


def captured(command: list[str], timeout: float = 60, env: dict | None = None) -> str:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=timeout, env=env,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError(f"{Path(command[0]).name} exited {result.returncode}: "
                           f"{(result.stdout + result.stderr)[-2000:]}")
    return result.stdout + result.stderr


def engine_info(binary: Path) -> dict:
    version = captured([str(binary), "--version"]).strip()
    if MANIFEST["sourceRevision"][:7] not in version:
        raise ValueError(f"Expected sd.cpp {MANIFEST['sourceRevision'][:7]}, got: {version}")
    help_text = captured([str(binary), "--help"])
    for flag in ("--audio-vae", "--video-frames", "--backend", "--offload-to-cpu", "--flash-attn"):
        if flag not in help_text:
            raise ValueError(f"sd-cli lacks required option: {flag}")
    return {"path": str(binary), "version": version,
            "devices": captured([str(binary), "--list-devices"]).strip()}


def generation_command(binary: Path, args, model_dir: Path, output: Path) -> list[str]:
    selected = MANIFEST["profiles"][args.profile]
    placement = getattr(args, "placement", "cpu-text")
    if placement == "cpu-text":
        device_flags = ["--backend", "te=cpu", "--offload-to-cpu"]
    elif placement == "split-components":
        device_flags = ["--backend", "diffusion=cuda0,te=cuda1,vae=cuda1"]
    else:
        device_flags = ["--backend", "diffusion=cuda0&cuda1,te=cpu,vae=cuda0", "--split-mode", "layer"]
    command = [str(binary), "-M", "vid_gen",
               "--diffusion-model", str(model_dir / selected["diffusion"]),
               "--llm", str(model_dir / selected["text"]),
               "--vae", str(model_dir / "vae/minimax_h3_video_vae_fp16.safetensors"),
               "--audio-vae", str(model_dir / "vae/minimax_h3_audio_vae_fp32.safetensors"),
               *device_flags,
               "--flash-attn", "off,diffusion=on", "--rng", "cpu",
               "--cfg-scale", "1.0", "--steps", str(args.steps),
               "--sampling-method", "euler", "--scheduler", "discrete",
               "--width", str(args.width), "--height", str(args.height),
               "--fps", "24", "--video-frames", str(args.frames),
               "--seed", str(args.seed), "--prompt", args.prompt,
               "--output", str(output), "-v"]
    if "connector" in selected:
        command += ["--embeddings-connectors", str(model_dir / selected["connector"]),
                    "--llm_vision", str(model_dir / selected["vision"])]
    if "flowShift" in selected:
        command += ["--flow-shift", str(selected["flowShift"])]
    if args.first_frame:
        command += ["--init-img", str(Path(args.first_frame).resolve())]
    if args.last_frame:
        command += ["--end-img", str(Path(args.last_frame).resolve())]
    return command


def gpu_memory(gpu: str) -> dict:
    command = ["nvidia-smi", f"--id={gpu}", "--query-gpu=uuid,name,memory.total,memory.used",
               "--format=csv,noheader,nounits"]
    rows = list(csv.reader(captured(command, timeout=10).strip().splitlines()))
    if len(rows) != 1 or len(rows[0]) != 4:
        raise ValueError("Select exactly one NVIDIA GPU with --gpu")
    uuid, name, total, used = (part.strip() for part in rows[0])
    return {"uuid": uuid, "name": name, "total_mib": int(total), "used_mib": int(used)}


def selected_gpus(selection: str, placement: str) -> list[dict]:
    identifiers = [item.strip() for item in selection.split(",") if item.strip()]
    expected = 1 if placement == "cpu-text" else 2
    if len(identifiers) != expected:
        raise ValueError(f"{placement} requires {expected} GPU(s); use --gpu 0 or --gpu 0,1")
    devices = [gpu_memory(item) for item in identifiers]
    if len({device["uuid"] for device in devices}) != len(devices):
        raise ValueError("GPU selection contains the same physical GPU more than once")
    return devices


def validate_video(path: Path, args) -> dict:
    if not path.is_file() or not path.stat().st_size:
        raise ValueError(f"No video artifact: {path}")
    data = json.loads(captured(["ffprobe", "-v", "error", "-count_frames",
                               "-show_streams", "-show_format", "-of", "json", str(path)]))
    videos = [s for s in data["streams"] if s["codec_type"] == "video"]
    audio = [s for s in data["streams"] if s["codec_type"] == "audio"]
    if len(videos) != 1 or len(audio) != 1:
        raise ValueError("Expected exactly one video and one audio stream")
    video, sound = videos[0], audio[0]
    if (video["width"], video["height"]) != (args.width, args.height):
        raise ValueError("Encoded canvas differs from requested canvas")
    if int(video.get("nb_read_frames", 0)) != args.frames or Fraction(video["avg_frame_rate"]) != 24:
        raise ValueError("Encoded frame count / fps differs from requested H3 geometry")
    if int(sound["sample_rate"]) != 32000 or sound["channels"] != 2:
        raise ValueError("Expected 32 kHz stereo audio")
    return {"path": str(path), "bytes": path.stat().st_size,
            "frames": args.frames, "fps": 24, "width": args.width, "height": args.height,
            "duration_seconds": args.frames / 24,
            "audio_sample_rate": 32000, "audio_channels": 2,
            "video_codec": video["codec_name"], "audio_codec": sound["codec_name"]}


def run_inference(binary: Path, args, model_dir: Path, out: Path) -> dict:
    if not shutil.which("nvidia-smi"):
        raise ValueError("No NVIDIA GPU runtime. check validates syntax only; run needs a CUDA host")
    for command in ("ffprobe", "ffmpeg"):
        if not shutil.which(command):
            raise ValueError(f"Missing {command}; install FFmpeg before running the GPU test")
    hardware = selected_gpus(args.gpu, args.placement)
    for name, asset in selected_files(args.profile).items():
        verify(model_dir / name, asset)
    environment = os.environ.copy()
    environment["CUDA_VISIBLE_DEVICES"] = ",".join(device["uuid"] for device in hardware)
    observations = {device["uuid"]: [] for device in hardware}
    host_rss, cgroup_memory, sample_errors = [], [], []
    stop = threading.Event()
    process = None

    def sample():
        while not stop.is_set():
            for device in hardware:
                try:
                    observations[device["uuid"]].append(gpu_memory(device["uuid"])["used_mib"])
                except Exception as error:
                    sample_errors.append(type(error).__name__)
            if process is not None and platform.system() == "Linux":
                try:
                    for line in Path(f"/proc/{process.pid}/status").read_text().splitlines():
                        if line.startswith("VmRSS:"):
                            host_rss.append(int(line.split()[1]) / 1024)
                            break
                    current = Path("/sys/fs/cgroup/memory.current")
                    if current.is_file():
                        cgroup_memory.append(int(current.read_text()) / 1024**2)
                except (OSError, ValueError):
                    pass
            stop.wait(0.25)

    video = out / "native.avi"
    command = generation_command(binary, args, model_dir, video)
    sampler = threading.Thread(target=sample, daemon=True)
    sampler.start()
    started = time.perf_counter()
    try:
        with (out / "inference.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=environment,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                code = process.wait(timeout=args.timeout)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
        if code:
            raise RuntimeError(f"Inference exited {code}; see {out / 'inference.log'}")
    finally:
        stop.set()
        sampler.join(timeout=12)
        per_device = [{**device, "sample_count": len(observations[device["uuid"]]),
                       "peak_used_mib": max(observations[device["uuid"]]) if observations[device["uuid"]] else None}
                      for device in hardware]
        metrics = {"sd_cli_seconds": round(time.perf_counter() - started, 3),
                   "gpus": per_device, "placement": args.placement,
                   "process_peak_rss_mib": round(max(host_rss), 2) if host_rss else None,
                   "cgroup_peak_memory_mib": round(max(cgroup_memory), 2) if cgroup_memory else None,
                   "gpu_sampling_errors": sample_errors,
                   "memory_scope": "sampled whole-device use, including other processes; not torch allocated memory",
                   "host_memory_scope": "sampled Linux process RSS; cgroup v2 total includes all member processes and file cache; unavailable fields are null",
                   "argv": command}
        (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    native = validate_video(video, args)
    conversion_started = time.perf_counter()
    mp4 = out / "video.mp4"
    captured(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(video),
              "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "fast",
              "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(mp4)],
             timeout=args.timeout)
    return {**metrics, "native": native, "mp4": validate_video(mp4, args),
            "mp4_conversion_seconds": round(time.perf_counter() - conversion_started, 3),
            "timing_scope": "one fresh CLI process: model load + text encoding + denoise + AV decode/export; excludes downloads/hash checks",
            "benchmark_kind": "cold process, not a resident-model warm request"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "check", "download", "run"))
    parser.add_argument("--profile", choices=tuple(MANIFEST["profiles"]), default="q4")
    parser.add_argument("--model-dir", default=".tmp/probes/h3/models")
    parser.add_argument("--output-dir", default=".tmp/probes/h3/results")
    parser.add_argument("--engine-dir", default=".tmp/probes/h3/engine")
    parser.add_argument("--sd-bin", default=shutil.which("sd-cli") or "")
    parser.add_argument("--prepare-engine", action="store_true", help="download the pinned 30 MB Windows Vulkan engine only")
    parser.add_argument("--verify-remote", action="store_true", help="compare selected files against the pinned HF tree")
    parser.add_argument("--width", type=int, default=864)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--frames", type=int, default=124)
    parser.add_argument("--steps", type=int, default=None, help="default 20 for base profiles; baked Turbo profile uses 8")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--first-frame", default="")
    parser.add_argument("--last-frame", default="")
    parser.add_argument("--gpu", default="0")
    parser.add_argument("--placement", choices=("cpu-text", "split-components", "split-dit"),
                        default="cpu-text", help="cpu-text: single GPU; other modes: two GPUs selected by --gpu 0,1")
    parser.add_argument("--timeout", type=float, default=1800)
    args = parser.parse_args()
    profile_steps = MANIFEST["profiles"][args.profile].get("steps")
    if args.steps is None:
        args.steps = profile_steps or 20
    elif profile_steps is not None and args.steps != profile_steps:
        parser.error(f"{args.profile} uses its baked {profile_steps}-step schedule")
    if args.width < 32 or args.height < 32 or args.width % 32 or args.height % 32:
        parser.error("width and height must be positive multiples of 32")
    if not 22 <= args.frames <= 362 or (args.frames - 5) % 17:
        parser.error("frames must follow 17n+5, between 22 and 362; use 124 for about 5 s")
    if args.steps < 1 or args.timeout <= 0:
        parser.error("steps and timeout must be positive")
    for path in (args.first_frame, args.last_frame):
        if path and not Path(path).is_file():
            parser.error(f"Missing conditioning image: {path}")
    if args.prepare_engine and args.action != "check":
        parser.error("--prepare-engine is only used by check")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    out = Path(args.output_dir).resolve() / f"{stamp}-{args.action}-{args.profile}"
    out.mkdir(parents=True, exist_ok=False)
    model_dir = Path(args.model_dir).resolve()
    report = {"action": args.action, "status": "failed", "source_revision": MANIFEST["sourceRevision"],
              "started_at": datetime.now(timezone.utc).isoformat(), "inference_completed": False}
    try:
        report["inventory"] = inventory(args.profile, model_dir, args.verify_remote)
        if args.action == "download":
            model_dir.mkdir(parents=True, exist_ok=True)
            missing = sum(a["bytes"] for name, a in selected_files(args.profile).items()
                          if not (model_dir / name).exists())
            if shutil.disk_usage(model_dir).free < missing + 2 * GIB:
                raise ValueError("Insufficient model-disk space; keep at least 2 GiB extra for output")
            for name, asset in selected_files(args.profile).items():
                repo, revision = source_of(asset)
                url = f"https://huggingface.co/{repo}/resolve/{revision}/{urllib.parse.quote(name, safe='/')}"
                download(url, model_dir / name, asset)
            for repo, revision in sorted({source_of(asset) for asset in selected_files(args.profile).values()}):
                notices = model_dir / "sources" / repo.replace("/", "--")
                notices.mkdir(parents=True, exist_ok=True)
                for name in ("LICENSE", "NOTICE", "README.md"):
                    try:
                        with request(f"https://huggingface.co/{repo}/resolve/{revision}/{name}") as incoming:
                            (notices / name).write_bytes(incoming.read())
                    except urllib.error.HTTPError as error:
                        if error.code != 404:
                            raise
        elif args.action in ("check", "run"):
            binary = prepare_engine(Path(args.engine_dir).resolve()) if args.prepare_engine else Path(args.sd_bin).resolve()
            if not args.sd_bin and not args.prepare_engine:
                raise ValueError("Pass --sd-bin; Windows check can instead use --prepare-engine")
            report["engine"] = engine_info(binary)
            report["planned_argv"] = generation_command(binary, args, model_dir, out / "native.avi")
            if args.action == "check":
                url = (f"https://raw.githubusercontent.com/{MANIFEST['sourceRepo']}/{MANIFEST['sourceRevision']}/"
                       "docs/dgl/minimax_h3/minimax-h3-text-to-av.dgl")
                script = out / "upstream-h3.dgl"
                with request(url) as incoming:
                    script.write_bytes(incoming.read())
                # Parse the same generation options too, then type-check upstream's
                # graph. DGL check exits before any model file is opened.
                command = report["planned_argv"].copy()
                command[2] = "dgl"
                command += ["--script", str(script), "--check"]
                result = captured(command)
                (out / "graph-check.log").write_text(result, encoding="utf-8")
                report["evidence"] = "generation CLI options parsed and upstream H3 graph syntax/types accepted; no weights loaded, no inference benchmark"
            else:
                if "cuda0" not in report["engine"]["devices"].lower():
                    raise ValueError("run requires a CUDA build of sd-cli; the Windows Vulkan download is for check only")
                report["result"] = run_inference(binary, args, model_dir, out)
                report["inference_completed"] = True
        report["status"] = "passed"
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        path = out / "report.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"Report: {path}")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
