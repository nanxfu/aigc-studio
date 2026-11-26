# H3 视频独立推理探针（2026-11-26）

目标是验证 **单卡或双卡 H3 量化视频的实际成本**。2026-11-26 用户放宽到双卡及现成加速/衍生路线，完整选型见 [H3_VIDEO_ACCELERATION_RESEARCH.md](H3_VIDEO_ACCELERATION_RESEARCH.md)。先复用现成运行时生成文件，拿到下载、整条生成耗时、显存、主机内存和音画质量证据，再决定服务接入。首轮没有修改产品 Provider、图片 Worker、模型目录或 UI。

**最新进展**：已在Vast单RTX3090、40GB临时盘完成六条480p/约5秒音视频实测并销毁实例，Turbo中位耗时149.274秒、显存峰值16.29GiB，详细资源、账单和质量观察见 [H3_VIDEO_GPU_LIVE_20261126.md](H3_VIDEO_GPU_LIVE_20261126.md)。下面无GPU检查是前期记录，已不代表当前实测状态。

## 已核实的候选

| 运行时 | 可以直接复用的能力 | 与这次测试的关系 | 尚未成立的结论 |
| --- | --- | --- | --- |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/blob/52491bd9f1fc15281791723bdff13baab7fd6819/docs/models/minimax_h3.md) | H3 T2VA / FL2VA / Ref2VA；GGUF 主干和文本编码器；CPU / 磁盘参数存储；自动分段执行；FlashAttention；独立 CLI、C API 和 server | **首轮探针**，不需要 Python ML 包或 ComfyUI，现有本机引擎管理经验可复用 | 目标卡上的整条生成显存和画质还未实测；本探针验证原始 H3 FL2VA 的量化版本，不能代表 pi-H3 DWD / Pika / TriPRISM |
| [LightX2V](https://github.com/ModelTC/LightX2V/blob/83a424ac3c60849601ee7b6c393cae53a49f843c/scripts/minimax_h3/README.md) | H3 Python API / HTTP 服务；INT8 ConvRot / FP8；模型、文本端、VAE 分块卸载；AdaLN 缓存；4/8 步 Turbo LoRA；Pika 六步 LCM 配置 | **第二候选**，适合独立 Python 视频服务；可以直接使用上游，不必先移植 ComfyUI 节点 | 上游 INT8 8-step 示例默认 SP8、362 帧、768p，不能直接当作 24GB 单卡配置；Pika 示例为 BF16，不能据此声称低显存量化已跑通 |
| [LakonLab / pi-H3](https://github.com/Lakonik/LakonLab/blob/2ee2b334374ec91b7cee371a85a524bf4ba644d3/docs/piH3.md) | 官方 2/4 步 DWD；FP8 W8A8；SageAttention / Sol-Attn / AOT；独立 Python 示例 | 若测试重点是 pi-H3 的 2/4 步与去 VAE 解码收益，直接用官方实现 | 官方示例从大权重加载后在线量化，不能解决首次权重下载；`--offload` 主要处理文本编码器，不等于整个 DiT 都可分块卸载到 24GB |
| [FastVideo](https://github.com/hao-ai-lab/FastVideo/blob/a04639fa976d9f27ea0ff0c3febb9e7643ecbc37/docs/inference/pika_h3_flex.md) | H3 / Pika 独立流水线；融合内核、layerwise offload、文本缓存、VAE 分块；FastH3 蒸馏学生 | 可用作后续加速对照，不必自行编写内核 | 其 [4090 低显存实测](https://github.com/hao-ai-lab/FastVideo/blob/a04639fa976d9f27ea0ff0c3febb9e7643ecbc37/scripts/benchmarks/minimax_h3_4090/README.md) 使用私有 `FastH3-Pruned-8Step-FP8-ckpt300`，不是用户所列三个模型；不能直接搬用其显存结论 |
| [QuantFunc](https://github.com/QuantFunc/ComfyUI-QuantFunc) | 原生 C++ / CUDA INT4 引擎；H3 12.37GB 量化权重 | 有成熟的 ComfyUI 包装，性能值得关注 | 公共入口依赖 ComfyUI 的文本端、VAE、采样；引擎为预编译库且有单独许可，不能把“插件源码公开”当作整个引擎都能自由移植 |

代码许可：sd.cpp MIT，LightX2V / FastVideo Apache-2.0；模型及其衍生权重仍遵循各自模型许可。无需把 ComfyUI 纳入产品，也不需要自研注意力、量化或采样算法。

## 本次落地的探针

- [`tools/probes/h3_sdcpp_probe.py`](../tools/probes/h3_sdcpp_probe.py)：Python 标准库 CLI，使用上游 `sd-cli`。
- [`tools/probes/h3-sdcpp-assets.json`](../tools/probes/h3-sdcpp-assets.json)：固定代码 revision、发行版、HF revision、逐文件大小和 SHA-256。
- [`tools/probes/test_h3_sdcpp_probe.py`](../tools/probes/test_h3_sdcpp_probe.py)：下载校验、解压边界、失败报告、实际 FFmpeg 音画文件验证。

四个动作分开：`inspect` 只检查文件清单；`check` 解析生成参数并对上游 H3 DGL 推理图做语法和类型校验；`download` 显式下载选中档的四个文件；`run` 使用现有本地权重做一次 GPU 生成。检查成功不表示生成成功；报告始终写 `inference_completed`。

| Profile | 去噪主干 | 文本编码器 | 两个 VAE | 总下载（GiB） | 用途 |
| --- | --- | --- | --- | --- | --- |
| `q4` | Q4_K，10.637 | Q4_K_M，16.967 | 5.414 | **33.017** | 首轮画质基线 |
| `q3` | Q3_K，8.158 | 同一 Q4_K_M，16.967 | 5.414 | **30.538** | 只改变主干精度，同 Seed A/B |
| `q2-small` | UD-Q2_K_XL，7.509 | Q2_K_M，12.203 | 5.414 | **25.125** | 整体减小体积；同时改变文本端精度，不能作为只测主干损失的 A/B |
| `q4-clipproj` | 同一 Q4_K | Qwen3-VL-4B Q4 + ClipProj + 视觉塔 | 同上 | **19.179** | 社区小文本端替代，质量独立评估 |
| `q3-clipproj` | 同一 Q3_K | 同一 4B 组合 | 同上 | **16.701** | 小下载体积候选 |
| `q4-turbo-clipproj` | 社区Q4_K_M，已融合8-step LoRA | 同一4B组合 | 同上 | **19.149** | 已实测8步T2VA；按该checkpoint契约运行 |

以上数字来自固定 HF revision 的文件字节数，不是显存预测。默认 `cpu-text` 将文本端放 CPU 并 offload 主干。新增 `split-components` 将视频模型放 GPU0、文本/VAE 放 GPU1；`split-dit` 让视频模型按层分布在两卡，文本仍放 CPU。双卡模式用 `--gpu 0,1`，各卡峰值独立写入报告，不能相加后当作单卡显存。CPU 运算和 PCIe 传输可能拖慢整条流程，需要实测每条合格视频的总成本。

这些是**预量化文件**，探针不从 BF16 在线量化，也不下载整个模型仓库。已经存在但校验失败的文件会报错，不会自动覆盖或改下另一精度。中断下载再次执行会从头下载当前 `.part`；本探针尚未实现断点续传。

## 不加载权重的本机检查

在仓库根目录执行：

```powershell
python tools/probes/h3_sdcpp_probe.py inspect --verify-remote
python tools/probes/h3_sdcpp_probe.py check --prepare-engine
python tools/probes/test_h3_sdcpp_probe.py
```

第二条仅下载固定 Windows x64 Vulkan 引擎 ZIP，约 31MB，校验 SHA-256 后解压到 `.tmp/probes/h3/engine/`。此副本和桌面产品已打包的引擎分开。`check` 的 H3 图脚本来自相同固定代码 revision，`--check` 不打开模型权重。

本机证据（2026-11-26）：

- Radeon 880M 核显，系统内存约 23.79 GiB，无 NVIDIA CUDA 设备。
- `sd-cli` 版本回报 commit `52491bd`，Vulkan / CPU 设备枚举成功。
- `q4` 四文件在固定 HF revision 下的大小与 LFS SHA-256 均匹配。
- H3 上游推理图检查通过；生成参数解析也通过。
- 首轮探针的 5 项测试通过，包括真实 FFmpeg / FFprobe 的帧数与音频验证；双卡/多仓/本地 pi-H3 索引加入后共 10 项测试通过。测试素材为合成色视频，不是 H3 生成样片。
- **GPU 生成尚未执行**，未下载 H3 大权重，未申请或启动云 GPU。

原始报告在 `.tmp/probes/h3/results/<UTC时间>-<动作>-<profile>/report.json`。目录时间是 UTC；这里的用户日期采用 Asia/Shanghai。

## NVIDIA 单卡生成测试

选择已存在的 Linux CUDA 主机，优先 3090 / 4090 24GB。主机内存暂按 **64GB 测试条件**准备，至少 60GB 可用磁盘；这不是已测得的最低内存要求。Q4 / Q3 共享文件，合计约 41.18 GiB，不需要复制两套文本端和 VAE。

先构建固定版本的 CUDA CLI。用独立目录，不覆盖其他运行时 checkout：

```bash
git clone https://github.com/leejet/stable-diffusion.cpp.git /workspace/h3-sdcpp
git -C /workspace/h3-sdcpp checkout 52491bd9f1fc15281791723bdff13baab7fd6819
git -C /workspace/h3-sdcpp submodule update --init --recursive
cmake -S /workspace/h3-sdcpp -B /workspace/h3-sdcpp/build \
  -DSD_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=89
cmake --build /workspace/h3-sdcpp/build -j 4
```

4090 用架构 `89`，3090 改为 `86`；需要可用的 CUDA toolkit / nvcc、CMake 和 C++ 编译器。Windows NVIDIA 用户可以使用同一发行版的 CUDA 二进制，不能拿 `--prepare-engine` 的 Vulkan 副本做这个 CUDA 基准。

在已安装 FFmpeg 的主机上，从 AIGC Studio 仓库根执行：

```bash
python tools/probes/h3_sdcpp_probe.py check \
  --sd-bin /workspace/h3-sdcpp/build/bin/sd-cli

# 显式准备 q4 四个文件；只在 download 动作下载大权重。
python tools/probes/h3_sdcpp_probe.py download --profile q4 \
  --model-dir /workspace/h3-models --verify-remote

# 默认 864x480、124 帧、24fps、20 步 Euler/discrete、seed 42、带音频。
python tools/probes/h3_sdcpp_probe.py run --profile q4 \
  --sd-bin /workspace/h3-sdcpp/build/bin/sd-cli \
  --model-dir /workspace/h3-models --output-dir /workspace/h3-results --gpu 0

# q3 只补下载另一份主干，文本端和 VAE 复用；所有采样参数保持一致。
python tools/probes/h3_sdcpp_probe.py download --profile q3 --model-dir /workspace/h3-models
python tools/probes/h3_sdcpp_probe.py run --profile q3 \
  --sd-bin /workspace/h3-sdcpp/build/bin/sd-cli \
  --model-dir /workspace/h3-models --output-dir /workspace/h3-results --gpu 0
```

默认 20 步沿用上游基础模型 DGL 的采样基线，不会冒充 4-step / 8-step 蒸馏模型。要测试少步蒸馏，必须另行加入对应模型、LoRA 和 scheduler；不能只把 `--steps` 改成 4 再宣称得到 pi-H3 或 Pika。

可用 `--first-frame /path/to/first.png` / `--last-frame /path/to/last.png` 测首尾帧。先测文生视频，再测首帧，最后测首尾帧。Ref2VA 没有放入这个探针，避免误用 FL2VA 权重。

输出包含 `native.avi`、转码后的 `video.mp4`、`inference.log`、`metrics.json`、`report.json`。FFprobe 必须验证帧数、24fps、画布尺寸、32kHz stereo，以及一个视频和一个音频流；缺音频或缺视频都失败。FFmpeg 转码耗时单列。

NVIDIA 显存采样覆盖加载、文本编码、采样、VAE / 音频解码和原生视频导出；字段是 **整个设备的已用显存**，包含其他进程，采样间隔约 250ms 加查询耗时，可能漏掉很短的峰值。Linux 同时采样生成进程 RSS 和当前 cgroup v2 总内存，后者包含页缓存。采样不可用时写 `null` / 错误记录，不能填 0 当作测得值。

每次 `run` 是一个新 CLI 进程，耗时包含模型加载，不是常驻服务的热请求。权重下载和 SHA-256 读取耗时不在 `sd_cli_seconds` 内。只有后续常驻 C API / server 测试才能量化热请求收益。

## 进入产品的门槛

1. 在选定单卡或双卡配置实际生成视频，整条流程各卡留有显存余量；参考输入同样通过。
2. 同提示词、同 Seed、同几何和同采样配置比对 Q4 / Q3；人工看主体、动作、细节、首尾帧和听音频。单独看文件体积、PSNR 或单个算子加速不足以替代这个判断。
3. 至少测 3 条不同内容，记录下载、冷进程耗时、主机内存、GPU 峰值和失败率。租卡时记录单价：生成费用 = GPU 小时价 × 整条计费秒数 / 3600，另算存储和下载冷启。冷进程 POC 不证明常驻热请求成本。
4. 如果 Q4 / Q3 达到质量和成本要求，再用 sd.cpp C API / server 或 LightX2V 包装现有 `/generate`、Job 和二进制回传。保留视频依赖和模型进程隔离，复用 Host 的队列与产物展示。
5. pi-H3 / Pika / TriPRISM 分别验证对应加载和采样契约，不把 H3 基础模型成功自动视为三个衍生模型成功。

LightX2V 的 AdaLN cache 是已支持的计算复用；`use_compile` 有冷编译成本；2–8 步模型的跨步近似缓存先不开。先选单个适配器和明确的内核路径，再比较额外优化，避免同时改精度、采样、稀疏注意力和 VAE 而无法定位质量变化。
