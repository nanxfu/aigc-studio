#!/usr/bin/env python3
"""Worker 镜像基线一致性检查（GPU 运行时基线阶段 0）。

目的：把「Dockerfile 的 base / 运行用户 / 版本断言」与「requirements-gpu.txt 的锁定版本」
放在一起校验，避免出现下面这类静默漂移：

- 有人把 base 换回 Ubuntu（Python 3.10）但忘了改依赖断言 → 构建期才炸；
- 有人把 diffusers 升到 0.44 但 Dockerfile 断言还写着 0.43.0 → CI 构建失败却看不出原因；
- 有人为了修权限把 `USER worker` 加回来 → RunPod /workspace 挂载卷写不进去，
  运行时静默回退 /tmp/hf，容器盘被权重写爆；
- 有人在海外部署示例里塞回 `HF_ENDPOINT=hf-mirror.com` → 跨太平洋回源拉权重。

本脚本只做**一致性**校验，不判断版本号"是否最新"：版本选择由
docs/GPU_RUNTIME_BASELINE_PLAN.md 决定，改版本请同时改三处（base tag / 断言 / 依赖清单）。

用法：
    python tools/check-worker-image.py
    python tools/check-worker-image.py --quiet   # 只输出失败项与结论

退出码：0 通过，1 校验失败，2 文件缺失。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCKERFILE = ROOT / "worker" / "deploy" / "Dockerfile"
REQUIREMENTS = ROOT / "worker" / "requirements-gpu.txt"
ENTRYPOINT = ROOT / "worker" / "deploy" / "docker-entrypoint.sh"
COMPOSE = ROOT / "worker" / "deploy" / "docker-compose.yml"
DOCKERIGNORE = ROOT / ".dockerignore"

# base tag 必须同时体现 torch 与 CUDA 版本：torch 从 tag 推导，CUDA 从 Dockerfile 断言读取。
BASE_TAG_RE = re.compile(r"pytorch/pytorch:(?P<torch>\d+\.\d+\.\d+)-cuda(?P<cuda>\d+\.\d+)-cudnn\d+-runtime")
PIN_RE = re.compile(r"^(?P<name>[A-Za-z0-9_.-]+)\s*==\s*(?P<version>[^\s;#]+)", re.MULTILINE)
# Dockerfile 断言写法：assert diffusers.__version__ == '0.43.0'
ASSERT_VERSION_RE = re.compile(r"assert\s+(?P<module>[A-Za-z_][A-Za-z0-9_]*)\.__version__\.startswith\('(?P<version>[^']+)'\)|assert\s+(?P<module2>[A-Za-z_][A-Za-z0-9_]*)\.__version__\s*==\s*'(?P<version2>[^']+)'")
ASSERT_CUDA_RE = re.compile(r"assert\s+torch\.version\.cuda\s*==\s*'(?P<cuda>[^']+)'")
ASSERT_PYTHON_RE = re.compile(r"sys\.version_info\[:2\]\s*==\s*\(3,\s*11\)")

# requirements 里的发行名 → Dockerfile 断言里用的模块名（两者不一定同名）。
MODULE_ALIASES = {
    "torch": "torch",
    "torchvision": "torchvision",
    "diffusers": "diffusers",
    "transformers": "transformers",
    "accelerate": "accelerate",
    "peft": "peft",
    "huggingface-hub": "huggingface_hub",
    "safetensors": "safetensors",
    "pillow": "PIL",
}
# 必须精确锁定的包：推理栈主版本 + 已知良好组合（LKGR）。统一用 `-` 归一（pip 不区分
# `huggingface_hub` 与 `huggingface-hub`，脚本里只认一种写法，避免同一包两份键）。
REQUIRED_PINS = ("torch", "torchvision", "diffusers", "transformers", "accelerate", "peft", "huggingface-hub")

failures: list[str] = []
notes: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"[worker-image] 读取失败 {path}：{exc}", file=sys.stderr)
        raise SystemExit(2) from None


def parse_pins(text: str) -> dict[str, str]:
    """解析 `pkg==ver`（忽略注释行）；同一包出现多次时后者覆盖前者并记一条 note。"""
    pins: dict[str, str] = {}
    for match in PIN_RE.finditer(text):
        name = match.group("name").lower().replace("_", "-")
        version = match.group("version")
        if name in pins and pins[name] != version:
            notes.append(f"依赖清单里 {name} 出现了两个版本（{pins[name]} → {version}），以最后一条为准")
        pins[name] = version
    return pins


def check_base_image(dockerfile: str) -> str | None:
    arg = re.search(r"^ARG\s+BASE_IMAGE=(?P<value>\S+)", dockerfile, re.MULTILINE)
    if not arg:
        fail("Dockerfile 缺少 `ARG BASE_IMAGE=...`：CI 需要按 digest 覆盖基础镜像")
        return None
    if "FROM ${BASE_IMAGE}" not in dockerfile:
        fail("Dockerfile 的 FROM 必须引用 ${BASE_IMAGE}，否则 --build-arg 固定 digest 无效")
    tag = arg.group("value")
    match = BASE_TAG_RE.search(tag)
    if not match:
        fail(
            f"基础镜像 {tag!r} 不是预期的 pytorch runtime 形态"
            "（应为 pytorch/pytorch:<torch>-cuda<cuda>-cudnn<N>-runtime）"
        )
        return None
    return match.group("torch")


def check_root_user(dockerfile: str) -> None:
    """云端镜像必须以 root 运行（规划 §12 决策 2）。"""
    if re.search(r"^USER\s+(?!root\b)\S+", dockerfile, re.MULTILINE):
        fail(
            "Dockerfile 出现非 root 的 USER：RunPod /workspace 挂载卷属主是 root:root，"
            "非 root 用户会静默回退 /tmp/hf 并写爆容器盘"
        )
    if re.search(r"^USER\s+root\b", dockerfile, re.MULTILINE):
        notes.append("Dockerfile 显式写了 USER root（等价于默认，不影响构建）")


def check_python_assertion(dockerfile: str) -> None:
    if not ASSERT_PYTHON_RE.search(dockerfile):
        fail("Dockerfile 缺少 Python 3.11 构建期断言（基础层被替换时要立刻失败）")


def check_pins(pins: dict[str, str]) -> None:
    for name in REQUIRED_PINS:
        if name not in pins:
            fail(f"requirements-gpu.txt 未精确锁定 {name}（缺少 `{name}==<version>`）")
    for name in ("torch", "torchvision"):
        version = pins.get(name)
        if version and "+cu124" not in version:
            fail(f"{name} 必须锁定 cu124 轮子（收到 {name}=={version}，应为 `{name}==<version>+cu124`）")
    if any(name.startswith("nvidia-") for name in pins):
        notes.append("依赖清单里出现 nvidia-* 包：CUDA 运行库应由基础镜像提供，单独安装会重复占体积")


def check_assertions(dockerfile: str, pins: dict[str, str], base_torch: str | None) -> None:
    """Dockerfile 的版本断言必须与 requirements 的锁定值一致（两边不许各说各话）。"""
    asserted: dict[str, str] = {}
    for match in ASSERT_VERSION_RE.finditer(dockerfile):
        module = match.group("module") or match.group("module2")
        version = match.group("version") or match.group("version2")
        asserted[module] = version
    if not asserted:
        fail("Dockerfile 缺少依赖版本断言（torch / diffusers / transformers 至少要断言）")
        return
    for name, module in MODULE_ALIASES.items():
        pinned = pins.get(name)
        if not pinned:
            continue
        if module not in asserted:
            if name in REQUIRED_PINS:
                fail(f"Dockerfile 缺少 {name} 的版本断言：构建期无法确认 pip 没换版本")
            continue
        expected = pinned.split("+")[0]
        if asserted[module] != expected:
            fail(
                f"{name} 版本不一致：requirements={pinned}，Dockerfile 断言={asserted[module]}"
            )
    if base_torch and "torch" in pins and pins["torch"].split("+")[0] != base_torch:
        fail(f"基础镜像 torch={base_torch} 与 requirements torch={pins['torch']} 不一致（会触发重装）")
    cuda = ASSERT_CUDA_RE.search(dockerfile)
    if not cuda:
        fail("Dockerfile 缺少 `torch.version.cuda` 断言：无法确认装的是 cu124 而不是 CPU/cu126 轮子")
    elif cuda.group("cuda") != "12.4":
        fail(f"Dockerfile 断言的 CUDA 版本是 {cuda.group('cuda')}，基线要求 12.4")


def check_entrypoint(entrypoint: str) -> None:
    if "AIGC_WORKER_TOKEN" not in entrypoint:
        fail("入口脚本没有处理 AIGC_WORKER_TOKEN（RunPod / Vast 只给环境变量）")
    if "--token-file" not in entrypoint:
        fail("入口脚本没有把 Token 落成 --token-file（值会出现在进程参数里）")
    if "--no-install" not in entrypoint:
        fail("入口脚本没有传 --no-install：容器每次启动都会重新 pip 安装")


MIRROR_RE = re.compile(r"HF_ENDPOINT\s*[:=]\s*[\"']?https?://hf-mirror", re.IGNORECASE)


def _strip_comments(text: str) -> str:
    """去掉整行注释（Dockerfile / shell / YAML 都是 `#`）：只校验真正会生效的配置。

    注释里出现 `HF_ENDPOINT=hf-mirror.com` 是**说明不要这么配**，不能被当成违规。
    """
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def check_no_mirror(texts: dict[str, str]) -> None:
    for label, text in texts.items():
        if MIRROR_RE.search(_strip_comments(text)):
            fail(f"{label} 把 HF_ENDPOINT 指到了 hf-mirror.com：海外节点（RunPod / Vast）不应使用国内镜像源")


def check_dockerignore(text: str) -> None:
    for entry in ("node_modules", "models", "release", ".git"):
        if entry not in text:
            fail(f".dockerignore 未排除 {entry}：构建上下文会带上无关内容（镜像层与上传时间都会变大）")
    if re.search(r"^worker/?$", text, re.MULTILINE):
        fail(".dockerignore 把 worker/ 排除了：镜像里将没有代码")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验 Worker 镜像基线与依赖锁定是否自洽")
    parser.add_argument("--quiet", action="store_true", help="只输出失败项与结论")
    options = parser.parse_args(argv)

    dockerfile = read(DOCKERFILE)
    requirements = read(REQUIREMENTS)
    entrypoint = read(ENTRYPOINT)
    compose = read(COMPOSE)
    dockerignore = read(DOCKERIGNORE)

    pins = parse_pins(requirements)
    base_torch = check_base_image(dockerfile)
    check_root_user(dockerfile)
    check_python_assertion(dockerfile)
    check_pins(pins)
    check_assertions(dockerfile, pins, base_torch)
    check_entrypoint(entrypoint)
    check_no_mirror(
        {
            "deploy/Dockerfile": dockerfile,
            "deploy/docker-entrypoint.sh": entrypoint,
            "deploy/docker-compose.yml": compose,
        }
    )
    check_dockerignore(dockerignore)

    if not options.quiet:
        print("[worker-image] 当前基线：")
        print(f"  base      = {base_torch and 'pytorch/pytorch:' + base_torch + '-cuda12.4-cudnn9-runtime'}")
        for name in REQUIRED_PINS:
            print(f"  {name:<16}= {pins.get(name, '(未锁定)')}")
        for note in notes:
            print(f"  note: {note}")

    if failures:
        print("[worker-image] 检查失败：", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        return 1
    print(f"[worker-image] OK 检查项通过（锁定 {len(REQUIRED_PINS)} 个核心依赖）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
