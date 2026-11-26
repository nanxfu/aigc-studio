# 重型模型量化前置探针（P-01 / P-02）

对应 [`docs/MODEL_QUANTIZATION_AND_CLOUD_GPU_PLAN.md`](../../docs/MODEL_QUANTIZATION_AND_CLOUD_GPU_PLAN.md) §4.0。
目标：在改 `models/*.json`、`variants[]`、UI 或云端 `sd-cpp` 运行时之前，先用单卡拿到真机证据。

## 环境

- 单卡 `RTX 4090` 优先；`RTX 3090` 可跑但 FP8 Text Encoder 不可用。
- Linux CUDA 12.4+，至少 40GB 可用磁盘（P-02 权重约 22GB + 编译目录）。
- 海外节点**不要**设置 `HF_ENDPOINT=https://hf-mirror.com`。
- 不需要 AIGC Studio Host / Worker 协议；两个脚本都可独立运行。

## P-01：Z-Image Diffusers GGUF

```bash
cd /workspace/aigc-studio
export HF_HOME=/workspace/hf
pip install -r tools/probes/requirements.txt

# A. 原仓 BF16 Text Encoder（约 7.49 GiB）
python tools/probes/zimage_gguf_probe.py \
  --te-mode base \
  --output-dir /workspace/probe-zimage-base

# B. Qwen3-4B-FP8 Text Encoder（约 4.83 GiB，合计约 8.6 GiB；需要 sm_89+）
python tools/probes/zimage_gguf_probe.py \
  --te-mode fp8 \
  --output-dir /workspace/probe-zimage-fp8
```

看什么：

- `summary.json.load_seconds`：GGUF Model + Pipeline 加载；
- `cold.seconds` / `warm.seconds`：首图与热图；
- `cold.peak_vram_mb` / `warm.peak_vram_mb`：显存峰值；
- `text_encoder.class` / `dtype`：FP8 是否真的被管线接受；
- `cold.png` / `warm.png`：同 Seed 画质与中文/英文排字人工盲测。

判定：

- `diffusers 0.43` 能加载 `ZImageTransformer2DModel.from_single_file(Q4_K_M)`；
- 总下载体积与 16GB 卡显存是否可接受；
- FP8 TE 若失败，记录错误并保留 BF16 TE 的 `11.23 GiB` 基线，不阻塞 GGUF 主干路线。

**2026-11-26 实测（4090 / torch 2.6 / diffusers 0.43）**：

- BF16 TE 路径成功：加载 `43.0s`，首图 `6.29s`，热图 `5.85s`，峰值 `14.1GB`。
- `Qwen3-4B-FP8` 失败：`dtype=float8` 报 `Float8_e4m3fnStorage`；安装 `kernels==0.18.2` 后报 `torch.float8_e8m0fnu` 缺失（torch 2.6 没有该 dtype）。当前 Worker 栈不交付 FP8 TE。

## P-02：sd.cpp 能力门禁

```bash
cd /workspace/aigc-studio
bash tools/probes/sdcpp_g1_probe.sh
```

默认会编译 `stable-diffusion.cpp`、下载 Qwen / Flux 的 Q4 三文件，跑：

| case | 验证点 |
| :--- | :--- |
| `qwen_t2i` | Qwen-Image-2.1-Turbo 文生图 |
| `qwen_edit` | `-r` + `--llm_vision` 编辑 |
| `qwen_rgba` | 透明背景输出（PNG color type 4/6） |
| `qwen_multi_ref` | 重复 `-r` 多参考 |
| `flux_t2i` | FLUX.2 Klein 9B 文生图 |
| `flux_multi_ref` | FLUX.2 多参考 |

如果已有 `sd-cli`：

```bash
SKIP_BUILD=1 SD_BIN=/path/to/sd-cli bash tools/probes/sdcpp_g1_probe.sh
```

看什么：

- `summary.json.cases[*].status`：是否真的跑通；
- `seconds` / `peakVramMb`：24GB 卡余量；
- `pngColorType`：`4/6` 才有 alpha；
- `logs/*.log`：失败时的真实 sd.cpp 原因；
- `outputs/*.png`：与满血 BF16 同 Seed 的盲测素材。

**门禁结论**：

- Qwen 编辑/排版/RGBA 与 Flux 多参考都可用 → 才立项云端 `sd-cpp`；
- 任一项核心能力不可用 → 直接砍掉云端 `sd-cpp` 分支，Qwen/Flux 仅保留满血（Vast / Colab / 私有 Worker / `cloud-api`）；
- `sd-cli` 通过后，再单独验 `sd-server` 三文件启动与协议映射，不要跳过服务化验证。

**2026-11-26 实测（4090 / sd.cpp `master-1127-79dc7ca`）**：

- Qwen t2i / 单参考编辑 / RGBA 通过；RGBA alpha 透明像素约 `53.3%`。
- Qwen 多参考**未真正生效**：用红方块做第二张参考，输出仍只使用第一张图；不要把 `supportsReference` 标为 `true`。
- Flux2 t2i / 多参考通过：红陶壶被正确放入霓虹楼梯场景。
- `sd-server` 尚未验证，`sd-cli` 通过不等于 Worker 服务化通过。

## Vast 只读库存（零流量费）

```bash
node tools/probes/vast_inventory_probe.mjs \
  --json bench-results/vast-inventory-20261126/summary.json
```

- 只调用 `POST /api/v0/bundles/`，不创建实例、不挂载磁盘、不产生流量费；
- Key 从 `VAST_API_KEY` 或仓库根 `.env` 读取，脚本不打印 Key；
- 过滤单卡 3090/4090、`inet_down >= 1000`、`inet_down_cost <= 0.002`、磁盘 >= 50GB、
  on-demand、`dph_total <= 0.50`；
- 注意：`/bundles/` 的请求体就是筛选器本身，不要再包一层 `{ q: ... }`；`gpu_name`
  传带空格的全名（`RTX 4090`），不要用 `RTX_4090`。

**2026-11-26 实测**：10 台命中（3090×5 / 4090×5），3 台下载费为 `$0`；3090 最低
`$0.121/h`，4090 最低 `$0.401/h`。库存偏薄，暂不正式立项 Vast Provider。

## Salad Z-Image compact-q4 验收

```bash
node tools/probes/salad_zimage_validate.mjs \
  --gpu 4090 \
  --image ghcr.io/nanxfu/aigc-worker:manual-58e6674 \
  --full
```

- 创建前会落待清理标记；结束（含异常）在 `finally` 删除容器组；
- 默认使用产品同一组欧美区域；`--any-region` 才放开到全球（慢节点风险更高）；
- `--full` 会在同一容器里再跑满血 BF16，使用同 prompt / seed 供画质对比；
- 摘要、冷/热图写到 `bench-results/salad-zimage-20261126/<gpu>/`；
- Key 只读 `.env` / 环境变量，不打印。

**2026-11-26 实测**：

| 节点 | Worker ready | compact 冷启总 | 加载 | 首图 | 热图 | 峰值 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| RTX 3090（默认区域） | 884.4s | 984.9s | 69.5s | 27.41s | 21.68s | 7,876 MiB |
| RTX 3090 Ti（不限区域，慢节点） | 804.6s | 1790.5s | 963.4s | 18.75s | 16.83s | 7,876 MiB |
| RTX 4090（不限区域，快节点） | 165.1s | 329.1s | 141.4s | 17.21s | 12.83s | 7,876 MiB |
| RTX 4090（默认区域，慢节点） | 250.7s | 1307.1s | 1013.4s | 38.83s | 13.50s | 7,876 MiB |

4090 满血 BF16 同容器：加载 `119.4s` / 出图 `26.31s` / 峰值 `12,233 MiB`。所有样本中文、
英文标题均清晰；同型号 4090 冷启可在 `5.5–21.8min` 波动，不能承诺固定 15min。

## 清理

```bash
rm -rf /workspace/aigc-g1 /workspace/probe-zimage-base /workspace/probe-zimage-fp8
```

如果使用 Salad / Vast 临时实例，停止实例前先确认输出与 `summary.json` 已下载。
