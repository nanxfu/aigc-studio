#!/usr/bin/env bash
#
# P-02：stable-diffusion.cpp 单卡能力门禁（Linux CUDA / 4090 或 3090）。
#
# 先用 sd-cli 验证「能不能跑、能不能编辑、能不能多参考、RGBA/排版是否可用」；
# 只有 CLI 过门禁，才值得继续做 sd-server 服务化与云端镜像。
#
# 默认会：
#   1. 拉取并编译 stable-diffusion.cpp（CUDA）；
#   2. 下载 Qwen-Image-2.1-Turbo / FLUX.2-klein-9B 的 Q4_K_M 三文件组合；
#   3. 跑 6 个最小 case（Qwen t2i/edit/RGBA/multi-ref；Flux t2i/multi-ref）；
#   4. 记录耗时、峰值显存、PNG/Alpha 检查与失败日志；
#   5. 写 summary.json，供后续决策与复现。
#
# 用法：
#   bash tools/probes/sdcpp_g1_probe.sh
#   SKIP_BUILD=1 SD_BIN=/path/to/sd-cli bash tools/probes/sdcpp_g1_probe.sh
#   WORK_DIR=/workspace/aigc-g1 OFFLOAD=1 bash tools/probes/sdcpp_g1_probe.sh
#
# 预计磁盘：约 22GB 权重 + 编译目录；建议 >= 40GB。
# 不会打印 HF_TOKEN；所有 URL 均为公开仓库。

set -euo pipefail

WORK_DIR="${WORK_DIR:-/workspace/aigc-g1}"
MODEL_DIR="$WORK_DIR/models"
OUT_DIR="$WORK_DIR/outputs"
LOG_DIR="$WORK_DIR/logs"
SD_REPO="${SD_REPO:-https://github.com/leejet/stable-diffusion.cpp.git}"
SD_REF="${SD_REF:-master-1127-79dc7ca}"
SD_DIR="${SD_DIR:-$WORK_DIR/stable-diffusion.cpp}"
SKIP_BUILD="${SKIP_BUILD:-0}"
OFFLOAD="${OFFLOAD:-0}"
SEED="${SEED:-42}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-1024}"

QWEN_DIT_URL="https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF/resolve/main/qwen-image-2.1-turbo-Q4_K_M.gguf"
QWEN_LLM_URL="https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q4_K_M.gguf"
QWEN_VISION_URL="https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-8B-Instruct-F16.gguf"
QWEN_VAE_URL="https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors"

FLUX_DIT_URL="https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF/resolve/main/flux-2-klein-9b-Q4_K_M.gguf"
FLUX_LLM_URL="https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf"
FLUX_VAE_URL="https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/vae/flux2-vae.safetensors"

QWEN_DIT="$MODEL_DIR/qwen-image-2.1-turbo-Q4_K_M.gguf"
QWEN_LLM="$MODEL_DIR/Qwen3VL-8B-Instruct-Q4_K_M.gguf"
QWEN_VISION="$MODEL_DIR/mmproj-Qwen3VL-8B-Instruct-F16.gguf"
QWEN_VAE="$MODEL_DIR/qwen_image_2.1_vae_bf16.safetensors"
FLUX_DIT="$MODEL_DIR/flux-2-klein-9b-Q4_K_M.gguf"
FLUX_LLM="$MODEL_DIR/Qwen3-8B-Q4_K_M.gguf"
FLUX_VAE="$MODEL_DIR/flux2-vae.safetensors"
CASES_TSV="$WORK_DIR/cases.tsv"
SUMMARY_JSON="$WORK_DIR/summary.json"

log() { printf '[g1] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

if [[ "${1:-}" == "--help" ]]; then
  sed -n '1,32p' "$0"
  exit 0
fi

need curl
need nvidia-smi
mkdir -p "$MODEL_DIR" "$OUT_DIR" "$LOG_DIR"

if [[ ! -w "$WORK_DIR" ]]; then
  die "WORK_DIR 不可写：$WORK_DIR"
fi

free_gib="$(df -Pm "$WORK_DIR" | awk 'NR==2 {print int($4 / 1024)}')"
if [[ -n "$free_gib" && "$free_gib" -lt 35 ]]; then
  log "WARN 可用空间约 ${free_gib} GiB，建议至少 40 GiB（权重约 22 GiB + 编译）"
fi

download() {
  local url="$1"
  local out="$2"
  if [[ -s "$out" ]]; then
    log "已存在 $(basename "$out") ($(du -h "$out" | awk '{print $1}'))"
    return 0
  fi
  local auth=()
  if [[ -n "${HF_TOKEN:-}" ]]; then
    auth=(-H "Authorization: Bearer ${HF_TOKEN}")
  fi
  log "下载 $(basename "$out")"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
    "${auth[@]}" -o "${out}.part" "$url"
  mv "${out}.part" "$out"
}

build_sdcpp() {
  need git
  need cmake
  need nvidia-smi
  if [[ ! -d "$SD_DIR/.git" ]]; then
    log "克隆 stable-diffusion.cpp"
    git clone --recursive "$SD_REPO" "$SD_DIR"
  fi
  if ! git -C "$SD_DIR" rev-parse --verify "$SD_REF" >/dev/null 2>&1; then
    git -C "$SD_DIR" fetch --tags origin || true
  fi
  log "切到 $SD_REF"
  git -C "$SD_DIR" checkout "$SD_REF"
  git -C "$SD_DIR" submodule update --init --recursive

  local arch
  arch="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n1 | tr -d '.')"
  [[ -n "$arch" ]] || die "无法从 nvidia-smi 读取 compute_cap"
  log "CUDA 架构：$arch"
  cmake -S "$SD_DIR" -B "$SD_DIR/build" \
    -DSD_CUDA=ON \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CUDA_ARCHITECTURES="$arch"
  cmake --build "$SD_DIR/build" --config Release -j "$(nproc)"
}

find_sd_cli() {
  local configured="${SD_BIN:-}"
  if [[ -n "$configured" && -x "$configured" ]]; then
    printf '%s\n' "$configured"
    return 0
  fi
  local candidate
  for candidate in \
    "$SD_DIR/build/bin/sd-cli" \
    "$SD_DIR/build/bin/Release/sd-cli" \
    "$SD_DIR/build/sd-cli"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  candidate="$(find "$SD_DIR/build" -type f -name sd-cli -perm -111 2>/dev/null | head -n1 || true)"
  [[ -n "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

start_vram_sampler() {
  local out="$1"
  (
    while true; do
      nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null || true
      sleep 1
    done
  ) >"$out" &
  printf '%s\n' "$!"
}

stop_vram_sampler() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

png_meta() {
  local file="$1"
  if [[ ! -s "$file" ]]; then
    printf 'missing\t\t\n'
    return 0
  fi
  local magic color_type bytes
  magic="$(od -An -tx1 -N8 "$file" 2>/dev/null | tr -d ' \n')"
  color_type="$(od -An -tu1 -j25 -N1 "$file" 2>/dev/null | tr -d ' \n')"
  bytes="$(stat -c '%s' "$file" 2>/dev/null || wc -c <"$file")"
  if [[ "$magic" == "89504e470d0a1a0a" ]]; then
    printf 'ok\t%s\t%s\n' "$color_type" "$bytes"
  else
    printf 'bad\t%s\t%s\n' "$color_type" "$bytes"
  fi
}

run_case() {
  local name="$1"
  local output="$2"
  shift 2
  local log_file="$LOG_DIR/${name}.log"
  local vram_file="$LOG_DIR/${name}.vram"
  local sampler
  sampler="$(start_vram_sampler "$vram_file")"
  local started ended status seconds max_vram png_status color_type bytes tail_text
  started="$(date +%s%3N)"
  if "$@" >"$log_file" 2>&1; then
    status="ok"
  else
    status="fail"
  fi
  ended="$(date +%s%3N)"
  stop_vram_sampler "$sampler"
  seconds="$(awk -v s="$started" -v e="$ended" 'BEGIN {printf "%.1f", (e-s)/1000}')"
  max_vram="$(awk 'NF {if ($1+0 > max) max=$1+0} END {print max+0}' "$vram_file" 2>/dev/null || true)"
  read -r png_status color_type bytes < <(png_meta "$output")
  if [[ "$png_status" != "ok" ]]; then
    status="fail"
  fi
  if [[ "$status" != "ok" ]]; then
    tail_text="$(tail -n 3 "$log_file" 2>/dev/null | tr '\n\t' ' ' || true)"
  else
    tail_text=""
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$name" "$status" "$seconds" "$output" "$bytes" "$png_status" "$color_type" "$max_vram" "$tail_text" >>"$CASES_TSV"
  log "case=$name status=$status time=${seconds}s peak_vram=${max_vram}MiB color_type=${color_type:-?} bytes=${bytes:-?}"
}

write_summary() {
  need python3
  python3 - "$CASES_TSV" "$SUMMARY_JSON" "$WORK_DIR" "$SD_REPO" "$SD_REF" "$SD_BIN_PATH" <<'PY'
import csv
import datetime
import json
import os
import subprocess
import sys

cases_path, summary_path, work_dir, sd_repo, sd_ref, sd_bin = sys.argv[1:7]

def sh(command):
    try:
        return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT).strip()
    except Exception as exc:  # noqa: BLE001
        return f"ERROR: {exc}"

rows = []
with open(cases_path, newline="", encoding="utf-8") as handle:
    for row in csv.reader(handle, delimiter="\t"):
        if not row:
            continue
        name, status, seconds, output, size, png, color_type, vram, tail = (row + [""] * 9)[:9]
        rows.append({
            "name": name,
            "status": status,
            "seconds": float(seconds) if seconds else None,
            "output": output,
            "bytes": int(size) if size.isdigit() else None,
            "png": png,
            "pngColorType": int(color_type) if color_type.isdigit() else None,
            "peakVramMb": int(vram) if vram.isdigit() else None,
            "tail": tail,
        })

summary = {
    "probe": "P-02",
    "finishedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "workDir": work_dir,
    "stableDiffusionCpp": {
        "repo": sd_repo,
        "ref": sd_ref,
        "bin": sd_bin,
        "gpu": sh(["nvidia-smi", "--query-gpu=name,compute_cap,memory.total", "--format=csv,noheader"]),
    },
    "cases": rows,
    "pass": all(row["status"] == "ok" for row in rows) if rows else False,
    "notes": [
        "RGBA 只在 pngColorType 4/6 时通过；colorType 2 表示没有 alpha。",
        "sd-cli 只能证明能力与数值；服务化前还需验证 sd-server 的同一三文件启动与协议映射。",
        "画质对比请用同一 seed / 尺寸 / 步数，与满血 BF16 输出做盲测；本脚本只保证可跑与可检查。",
    ],
}
with open(summary_path, "w", encoding="utf-8") as handle:
    json.dump(summary, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY
}

log "WORK_DIR=$WORK_DIR"
log "SD_REF=$SD_REF SKIP_BUILD=$SKIP_BUILD OFFLOAD=$OFFLOAD"

if [[ "$SKIP_BUILD" != "1" ]]; then
  build_sdcpp
fi
SD_BIN_PATH="$(find_sd_cli || true)"
[[ -n "$SD_BIN_PATH" && -x "$SD_BIN_PATH" ]] || die "找不到 sd-cli；可用 SD_BIN=... 指定"
log "sd-cli=$SD_BIN_PATH"

HELP_TEXT="$("$SD_BIN_PATH" --help 2>&1 || true)"
if ! grep -q -- '--llm_vision' <<<"$HELP_TEXT"; then
  log "WARN sd-cli --help 中没有 --llm_vision；Qwen 编辑/RGBA case 可能无法运行"
fi
if ! grep -q -- '--sigmas' <<<"$HELP_TEXT"; then
  log "WARN sd-cli --help 中没有 --sigmas；Qwen 将退回仅 --steps 8"
  QWEN_SIGMAS=()
else
  QWEN_SIGMAS=(--sigmas qwen-image-2.1-turbo)
fi

download "$QWEN_DIT_URL" "$QWEN_DIT"
download "$QWEN_LLM_URL" "$QWEN_LLM"
download "$QWEN_VISION_URL" "$QWEN_VISION"
download "$QWEN_VAE_URL" "$QWEN_VAE"
download "$FLUX_DIT_URL" "$FLUX_DIT"
download "$FLUX_LLM_URL" "$FLUX_LLM"
download "$FLUX_VAE_URL" "$FLUX_VAE"
rm -f "$CASES_TSV"
touch "$CASES_TSV"

QWEN_COMMON=(
  --diffusion-model "$QWEN_DIT"
  --llm "$QWEN_LLM"
  --vae "$QWEN_VAE"
  --steps 8
  --cfg-scale 1.0
  "${QWEN_SIGMAS[@]}"
  --sampling-method euler
  --seed "$SEED"
  -W "$WIDTH" -H "$HEIGHT"
)
FLUX_COMMON=(
  --diffusion-model "$FLUX_DIT"
  --llm "$FLUX_LLM"
  --vae "$FLUX_VAE"
  --steps 4
  --cfg-scale 1.0
  --sampling-method euler
  --seed "$SEED"
  -W "$WIDTH" -H "$HEIGHT"
)
if [[ "$OFFLOAD" == "1" ]]; then
  QWEN_COMMON+=(--offload-to-cpu)
  FLUX_COMMON+=(--offload-to-cpu)
fi

run_case "qwen_t2i" "$OUT_DIR/qwen-t2i.png" \
  "$SD_BIN_PATH" "${QWEN_COMMON[@]}" \
  -p 'A minimalist poster with the Chinese headline "山城夜色" and English subtitle "NIGHT CITY", neon reflections on wet stone stairs, crisp typography, cinematic light' \
  -o "$OUT_DIR/qwen-t2i.png"

run_case "flux_t2i" "$OUT_DIR/flux-t2i.png" \
  "$SD_BIN_PATH" "${FLUX_COMMON[@]}" \
  -p 'A red ceramic teapot on a dark wooden table, soft studio product photography, warm rim light, high detail' \
  -o "$OUT_DIR/flux-t2i.png"

run_case "qwen_edit" "$OUT_DIR/qwen-edit.png" \
  "$SD_BIN_PATH" "${QWEN_COMMON[@]}" \
  --llm_vision "$QWEN_VISION" \
  -r "$OUT_DIR/qwen-t2i.png" \
  -p 'Change the large Chinese headline from "山城夜色" to "QWEN IMAGE 2.1" while keeping the same neon stair scene, typography style and layout' \
  -o "$OUT_DIR/qwen-edit.png"

run_case "qwen_rgba" "$OUT_DIR/qwen-rgba.png" \
  "$SD_BIN_PATH" "${QWEN_COMMON[@]}" \
  -p 'This is an RGBA image with transparency. A cute cartoon dragon sticker with the Chinese text "龙" and English text "DRAGON". The image has alpha channel and the background is transparent.' \
  -o "$OUT_DIR/qwen-rgba.png"

run_case "qwen_multi_ref" "$OUT_DIR/qwen-multi-ref.png" \
  "$SD_BIN_PATH" "${QWEN_COMMON[@]}" \
  --llm_vision "$QWEN_VISION" \
  -r "$OUT_DIR/qwen-t2i.png" -r "$OUT_DIR/flux-t2i.png" \
  -p 'Place the red ceramic teapot from the second reference into the neon stair scene of the first reference, keep the poster typography visible and preserve both shapes' \
  -o "$OUT_DIR/qwen-multi-ref.png"

run_case "flux_multi_ref" "$OUT_DIR/flux-multi-ref.png" \
  "$SD_BIN_PATH" "${FLUX_COMMON[@]}" \
  -r "$OUT_DIR/qwen-t2i.png" -r "$OUT_DIR/flux-t2i.png" \
  -p 'Use the red ceramic teapot from the second reference in the neon stair scene from the first reference; preserve the teapot shape and scene lighting' \
  -o "$OUT_DIR/flux-multi-ref.png"

write_summary

log "完成：$SUMMARY_JSON"
if ! awk -F '\t' '$2 != "ok" {exit 1}' "$CASES_TSV"; then
  log "存在失败 case；请先看 $LOG_DIR/*.log，再决定是否继续 sd-server 服务化"
  exit 1
fi
log "全部 case 可运行；下一步再验 sd-server 三文件启动与协议映射"
