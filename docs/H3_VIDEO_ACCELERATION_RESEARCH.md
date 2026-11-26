# H3 视频推理选型与双卡实验（2026-11-26）

本次范围按用户要求放宽：接受单卡、双卡、现成加速运行时、量化与蒸馏衍生模型。评估目标是**合格视频的生成成本、等待时间和接入维护量**，不再将单卡 24GB 作为所有候选的前提。

目前优先保留三条路线：**pi-H3 / LakonLab 验证快速草稿；LightX2V 验证可服务化的 H3 / Pika；sd.cpp GGUF 验证低下载体积与双卡放置**。NVIDIA Sol-H3 提供另一条值得跑的独立原生实现，Pika QAD 和快 VAE 可作对照实验。

**本日后续实测已完成**：用户要求实际开机，并进一步强调受众的存储开销。采用单3090、40GB临时盘测试基础Q3与8步Turbo Q4，各三条480p/约5秒视频；Turbo中位耗时149.274秒、GPU峰值16.29GiB。资源、样片、账单和销毁证据见 [H3_VIDEO_GPU_LIVE_20261126.md](H3_VIDEO_GPU_LIVE_20261126.md)。本页以下“没有启动”的表述保留为调研阶段历史记录。

**产品平台选择更新**：Vast的模型下载费在本轮超过六条生成费估算合计，不将其作为低频用户默认Provider，暂缓专用自动租机接入。现成推理运行时和量化模型仍保留价值，可部署到用户自备GPU环境并通过`private-worker`连接；下一步比较已有按次API与免费/订阅资源的完整成本，避免仅用小时价推荐平台。

## 新发现与修正

### 1. pi-H3 已有双卡组件分离

[官方 Gradio 源码](https://github.com/Lakonik/LakonLab/blob/2ee2b334374ec91b7cee371a85a524bf4ba644d3/demo/gradio_pih3.py) 把文本编码拆成单独 pipeline：有两张卡时，文本端在 `cuda:1`，视频 Transformer 在 `cuda:0`。文本 embedding 在采样前复制到视频卡。这个策略适合保留视频模型常驻，减少跨请求 CPU 卸载。

它并不切分视频 Transformer；第二张卡的空闲显存不能自动替第一张卡承接采样张量。`--offload` 是整个文本模型的阶段卸载，也不保证 24GB 卡能容纳完整文本编码阶段。

[官方量化代码](https://github.com/Lakonik/LakonLab/blob/2ee2b334374ec91b7cee371a85a524bf4ba644d3/lakonlab/ops/quant/quant.py) 支持 FP8、INT8 和 INT8 ConvRot。CPU 权重可以逐层在 GPU 上量化后返回 CPU，再将量化完的模型放上卡；不需要先把整个 BF16 视频模型塞进显存。FP8 计算要求 SM89+（4090 / Hopper / Blackwell）；3090 应选择 INT8 路线。

新增 [`pih3_lakonlab_probe.py`](../tools/probes/pih3_lakonlab_probe.py) 从官方示例提取头部无界面推理路径：单个 2-step 或 4-step DWD adapter、逐层量化、文本卡分离、一次 warmup + 三次计时，记录编码、DWD / 音频解码、MP4 导出、每张卡的 allocated / reserved 峰值。`streamed` 文本端使用 Accelerate 参数卸载，是**待真机确认的实验项**。不加载四个 adapter，也不启动 Gradio。

第一批 pi-H3 测试只做 T2VA。后续首尾帧需要加入 VAE 编码的放置和调度，不能从文生视频结果推断显存。

### 2. Pika 已有可直接下载的量化衍生版本

发现 [FastVideo/Pika-H3-Flex-NVFP4-QAD](https://huggingface.co/FastVideo/Pika-H3-Flex-NVFP4-QAD)（固定 revision `0434eb89466c15ab451cb92fdd20995b4a2d1f1a`）。它把 Pika adapter 合并到基础主干后进行 NVFP4 量化感知蒸馏，发布的主干已是 FastVideo 支持的格式。无需我们自己训练、量化或再叠加 Pika adapter。

还有 [FP4-attention 版本](https://huggingface.co/FastVideo/Pika-H3-Flex-NVFP4-FP4Attn-QAD)，目标是更快的长视频。它需要相应的 Hadamard / key-smoothing / BF16 保留层配置；基础 QAD 版本保留 BF16 attention，先以它作质量基线。

**NVFP4 文件名不能简单推算成原体积的四分之一。**固定文件树统计：每个 transformer 分区约 **35.93 GiB**，文本端约 **15.34 GiB**，完整 VAE **9.70 GiB**，NVFP4 decoder **1.29 GiB**。敏感层和非量化组件仍占空间。单个任务选相应分区；不要把两个主干都下载。

这条路线需要 Blackwell。32GB 的 5090 也需要卸载 / 分块才能处理这份主干；两张 5090 不会通过“可见两个 CUDA 设备”自动组成 64GB。官方模型卡没有建立 2×5090 的完整推理成绩，因此保留为测试候选。

### 3. 32B 文本端可以做有适配器的小模型替代实验

[ClipProj](https://huggingface.co/NicoLab28/ClipProj-MiniMax-H3) 发布了 Qwen3-VL-4B / 8B 到 H3 conditioning 空间的投影矩阵。它是社区校准的替代方案，不能宣称和原始 32B 编码相同。

关键是固定版本的 [sd.cpp 已有独立加载支持](https://github.com/leejet/stable-diffusion.cpp/blob/52491bd9f1fc15281791723bdff13baab7fd6819/docs/models/minimax_h3.md)：`--llm` 配小 Qwen，`--embeddings-connectors` 配对应线性投影，`--llm_vision` 配对应视觉塔。支持线性版本，当前没有接 residual `-mlp` 版本。它既不需要 ComfyUI，也不需要我们重写投影加载代码。

探针新增两档，均含视觉塔与视频 / 音频 VAE：

| 档位 | 去噪主干 | 文本组件 | 整套下载 |
| --- | --- | --- | --- |
| `q4` | Q4_K | 原始 32B 的 Q4 | 33.017 GiB |
| `q4-clipproj` | 相同 Q4_K | 4B Q4 + 线性投影 + 视觉塔 | **19.179 GiB** |
| `q3-clipproj` | Q3_K | 相同 4B 组合 | **16.701 GiB** |

这是磁盘和冷启收益，不是显存实测。先用相同 Q4 主干比较 32B / 4B conditioning 的效果，随后在相同 4B conditioning 下比较 Q4 / Q3。不要同时改变文本端和主干后只把质量变化归因给某一种量化。

### 4. 可以单独用 Comfy Kitchen 内核

[Comfy Kitchen](https://github.com/Comfy-Org/comfy-kitchen) 是 Apache-2.0 的独立 Python / CUDA / Triton / HIP 内核库，提供 ConvRot INT8 / INT4、attention、RoPE 等算子。它的名字不代表必须启动 ComfyUI。LightX2V 的 `int8-convrot` 线性算子已经直接调用该库。

这为后续 TriPRISM 单文件权重支持提供了可复用的内核。剩下的适配成本主要是 fused QKV 命名、AdaLN table、输出精度、采样配置和布局映射。不能把文件名含 `LightX2V` 的 Comfy 单文件误认成原生 Diffusers / LightX2V 权重；[Spectrallic 的量化包](https://huggingface.co/Spectrallic/MiniMax-H3-LightX2V-int8-convrot)明确记录的是 Comfy 布局。

## 双卡具体怎么用

| 方式 | 作用 | 可以直接用的实现 | 如何看成本 |
| --- | --- | --- | --- |
| 组件分离 | 文本端 / VAE 与视频模型放不同卡，减少卸载和单卡阶段峰值 | pi-H3 官方代码；sd.cpp 模块 backend 分配 | 第二张卡可能在采样时空闲；收益来自更短编码、少搬权重、减少重载 |
| 分层放置 | 视频 Transformer 按连续 block 范围放两卡，激活在边界传递 | sd.cpp `diffusion=cuda0&cuda1` + `--split-mode layer` | 主要解锁显存；同一请求的 blocks 仍按顺序执行，不承诺两倍速度 |
| Tensor parallel / row split | 每层矩阵在两卡分片并同时计算 | LightX2V TP；sd.cpp row split | 可缩小每卡权重并利用两卡计算，但每层要通信；NVLink / P2P / PCIe 带宽决定净收益 |
| Sequence parallel | 长序列 token、attention 和 VAE tiles 分担 | LightX2V Ulysses SP；Sol-H3 | 常用于 768p / 长片；通常复制主干权重，不能自动解决模型本身放不下 |
| 两张卡各跑一个请求 | 增加批量吞吐 | 两个独立 worker 进程 | 单条延迟不变；比双卡联合更容易接入，适合排队请求较多的服务 |

具体比较 **1×4090、2×3090、2×4090、1×5090**。3090 有 NVLink 能力，但必须确认实际机器装了桥、驱动 P2P 可用；4090 没有 NVLink，某些租用机器的 PCIe P2P 还受限制。记录 `nvidia-smi topo -m` 和 P2P 检查结果，不能只看 GPU 数量。

sd.cpp row split 在 backend 不支持时会回退为 layer split，且当前预算可能保守地把整个 split buffer 大小计入每张卡；第一次显存实验使用明确的 layer split，row split 后置并核对日志里的实际模式。

## 运行时优先级

### A. 低成本基线：sd.cpp 组件分离 / 双卡分层

沿用已准备的 GGUF 文件，比较 single / component split / layer split。低比特权重无需每次现场量化，原始 32B Q4 保留为 conditioning 基线。加入 ClipProj 后，下载体积适合有限磁盘环境。

新增参数示例：

```bash
# 双卡组件分离：GPU0 视频，GPU1 文本和 VAE。
python tools/probes/h3_sdcpp_probe.py run --profile q4 \
  --placement split-components --gpu 0,1 \
  --sd-bin /workspace/h3-sdcpp/build/bin/sd-cli --model-dir /workspace/h3-models

# 视频模型按层分配，两卡分别记录峰值；文本端先留 CPU。
python tools/probes/h3_sdcpp_probe.py run --profile q4 \
  --placement split-dit --gpu 0,1 \
  --sd-bin /workspace/h3-sdcpp/build/bin/sd-cli --model-dir /workspace/h3-models

# 小文本端可和任一放置策略组合。
python tools/probes/h3_sdcpp_probe.py inspect --profile q3-clipproj --verify-remote
python tools/probes/h3_sdcpp_probe.py download --profile q3-clipproj --model-dir /workspace/h3-models
```

参数已通过真实 sd-cli 的解析与 DGL `--check`。本机 Vulkan 检查没有执行 CUDA 放置，不能作为双卡显存或速度证据。

### B. 快速迭代主候选：pi-H3 / LakonLab

先测试 4-step DWD，再切 2-step，看细节、动作和音频是否足够做预览。候选环境是双消费卡，CPU 内存和持久磁盘足够；FP8 / INT8 quant 是逐层转换，单次准备可能仍要约 100 GiB 上游基础组件 + DWD adapter。使用持久缓存，单独记准备时间，不适合每次短任务都从零下载。

代码使用官方 quantization / scheduler / DWD head / 音频保存实现。新增探针的 GPU 路径未执行，仅标准库 plan、语法和本地索引处理已有验证。

```bash
git clone https://github.com/Lakonik/LakonLab.git /workspace/LakonLab
git -C /workspace/LakonLab checkout 2ee2b334374ec91b7cee371a85a524bf4ba644d3
# 根据上游 Installation 安装独立环境，3090 INT8 或 4090 FP8；不要改图片 Worker 依赖。

hf download multimodalart/MiniMax-H3-Pruned \
  --revision 1a0ef5e65b639e84af81d883817968532180e9c7 \
  --include 'modular_model_index.json' 'transformer/**' 'text_encoder/**' \
  --local-dir /workspace/pih3/base
hf download MiniMaxAI/MiniMax-H3 \
  --revision 12253298adb81e36757eabebb81d2ba1c0cc70cc \
  --include 'tokenizer/**' 'processor/**' 'vae/**' 'audio_vae/**' \
  --local-dir /workspace/pih3/shared
hf download Lakonik/pi-H3 \
  --revision 4a864589b0fac3d14768f932c930c4dcf1a17b56 \
  --include 'pi_h3_4step_dwd_adapter/**' 'pi_h3_2step_dwd_adapter/**' \
  --local-dir /workspace/pih3/adapters

# 无 GPU 的 recipe 检查，不导入 torch。
python tools/probes/pih3_lakonlab_probe.py plan --gpus 0,1 --quantization int8_convrot

# 初始 T2VA 双卡测试。原始 32B 文本端量化后仍可能超过 24GB，先尝试 streamed。
python tools/probes/pih3_lakonlab_probe.py run --gpus 0,1 \
  --steps 4 --quantization int8_convrot --text-placement streamed \
  --lakonlab-dir /workspace/LakonLab --base-dir /workspace/pih3/base \
  --shared-dir /workspace/pih3/shared --adapter-dir /workspace/pih3/adapters \
  --output-dir /workspace/pih3/results
```

先为准备期选约 128GB 主机内存、150–200GB 磁盘，这是实验条件而非已验证最低要求。`resident` 与 `streamed` 单独比较；两卡各自约 24GB 能不能跑完整 DWD，仍要看第一张卡的主干 + DWD 激活。

### C. 多模态服务主候选：LightX2V

独立 [Python API / 服务](https://github.com/ModelTC/LightX2V/blob/83a424ac3c60849601ee7b6c393cae53a49f843c/scripts/minimax_h3/README.md)覆盖 T2AV、首尾帧、Ref2AV，已支持量化基础主干 + 独立 LoRA 和 AdaLN cache。先复用现成服务验证，不需要先写 AIGC Provider。

比较以下两个配置方向：

- 2-GPU SP + block offload：`parallel.seq_p_size=2`，控制长视频激活；权重可能复制，主干显存需另处理。
- 2-GPU TP + quantized base：`parallel.tensor_p_size=2`，切分线性层权重；量化 LoRA 先用 `separate`。`consumer` 模式当前不支持 TP，不能从 SP 示例照抄。

上游有 Pika 六步 LCM 配置，也有 LightX2V Turbo 4/8-step 原生 adapter。原始 Pika 六步、Pika Turbo 混合 4-step、pi-H3 4-step 的轨迹不同；分别按 checkpoint 契约运行。

首期多参考功能需求出现时，LightX2V 优先于为 sd.cpp 自写 Ref2VA 控制面。缓存只复用相同 model / adapter / schedule；少步生成先不开 TeaCache 等跨步近似缓存。

### D. NVIDIA Sol-H3：独立现成实现，可作为积极探索项

在 `NVlabs/Sana` 的 **`sol-engine` 分支**找到 [Sol-H3 生产包](https://github.com/NVlabs/Sana/tree/1006b6a219b48e5798eec89478e7d12c101de661/models/minimax_h3/Sol-H3)，含 CLI / Python API、1/2/4/8 GPU 路径、融合内核、SOL / BSA、LoRA、分布式 VAE。此前只看 Sana `main` 分支会漏掉这套代码。

另有 [RTX5090 独立双阶段包](https://github.com/NVlabs/Sana/tree/1006b6a219b48e5798eec89478e7d12c101de661/models/minimax_h3/Sol-H3-RTX5090)：先 H3 384p 草稿，再传递 latent 到 LTX refine，生成约 768p/5s。不是纯 H3 同轨迹模型，但符合“接受衍生路线、看结果”的本次范围。

独立 [Sol-H3-VAE](https://huggingface.co/Efficient-Large-Model/Sol-H3-VAE) 可以替换原视频解码器，代码 Apache-2.0。它的快 CUDA-graph 模式可能用较多显存（文档 720p/5s 约 24 GiB），在小卡上应先跑 eager / ref，不能只按权重体积选它。

## 已公开的速度证据：只做选型线索

| 路线 | 硬件 / 工作量 | 上游结果 | 具体边界 |
| --- | --- | --- | --- |
| pi-H3 2-step DWD | 单 B200，768p / 5s | **3.8s** | [作者结果](https://hanshengchen.com/blog/pi-h3/)，包含编码、DWD、音频解码，排除加载、编译、MP4；不能外推为 4090 3.8s |
| pi-H3 2-step DWD | 单 B200，768p / 15s | **18.6s** | 同上；2-step 质量 / 音频需按我们的任务看样片 |
| Sol-H3 独立 5090 双阶段 | 单 5090，1344×768 / 121 帧 | **39.80s** | 一次正式实测，含模型阶段加载、传输和 MP4；使用 H3→LTX refine，非纯 H3；首尾帧未 GPU 验证 |
| Sol-H3 4-forward | 单 B300，1344×768 / 124 帧 | **13.745s** | 含编码、采样、VAEs；排除 MP4 / 初始化；用 FastH3 adapter |
| Sol-H3 4-forward | 4×B300，同工作量 | **2.918s** | 四步 + 近似稀疏/通信；与 49-forward BF16 速度差不能全归因于运行时 |
| FastVideo FastH3 | 4090，832×480 / 243 帧 | **约 99–107s** | 上游特定私有学生模型，8-forward、流式文本端 / offload；不是公开基础 H3 或 pi-H3 的直接成绩 |
| Pika Turbo 4-step | A100，848×480 / 121 帧 | **66.0s** | 模型卡作者成绩，排除跨轨迹“同 Seed 就必须逐像素相同”的误解 |

这些数值改变了路线优先级：少步蒸馏和 decoder 优化可能比从 24GB 再挤几 GB 更影响单条成本；吞吐测试应测常驻热请求，同时把冷启动另列。

## 成本判断

设整台机器小时价为 `R`（已经包含全部 GPU），一条请求平均耗时 `T` 秒，合格率为 `P`：

`每条合格视频推理成本 ≈ R × T / (3600 × P)`

再加摊销的环境准备、首次下载、编译 warmup、空闲和存储。双卡总价约单卡两倍时，如果两卡只让单条速度快 30%，单条费用更高；如果减少严重 CPU 卸载导致的数倍耗时，则可能更便宜。两卡独立跑两个请求则应看批量每小时产出。

示意账本（不是市场报价、不是实测）：

| 机器 | 整机价 | 单条耗时 | 单条推理费 |
| --- | --- | --- | --- |
| 单卡 | ¥2/h | 180s | ¥0.10 |
| 双卡 | ¥4/h | 60s | ¥0.067 |
| 双卡 | ¥4/h | 120s | ¥0.133 |

同样不能预先判定“单卡 80GB 都不划算”：如果高带宽卡无需卸载且总价/秒优势明显，它仍可赢低价双卡。消费卡仍是主要实验方向，选机最后看实际价与每条成本。

## 本次实际完成与下一批测试

完成了：多卡源代码与发布资产核对；五个运行时 / 两类 Pika 衍生 / ClipProj / 独立 VAE 的比较；sd.cpp 双卡 placement 和小文本端档位；pi-H3 无 Gradio 的实验脚本；10 项探针测试；多仓库固定 SHA-256 清单和真实 sd-cli 参数 / 图检查。

运行资源只读探测：Kaggle 凭据可用，2026-11-26 查询剩余约 **28.93 GPU 小时**；Colab 没有本机凭据；本机没有 NVIDIA GPU。没有启动云实例，也没有记录 GPU 视频生成成绩。

Kaggle 的 **2×T4 各约 15GB**不能当成一张 30GB 卡；T4 没有 FP8 / BF16 计算能力，pi-H3 当前 probe 按 Ampere+ 编写。小文本端 GGUF 组合的磁盘量现在约 16.7 GiB，可以作为双 T4 的独立候选，但 CUDA 编译目录和产物仍要预留空间。不要只因有两张 T4 就直接运行 pi-H3 FP8。

建议真实实验顺序：

1. 2×3090 或 2×4090：sd.cpp Q4 original32B，component split / layer split，做几何和音频完整基线。
2. 同机器：pi-H3 4-step DWD / 2-step DWD，INT8 或 FP8，resident / streamed 文本端，480p→768p。
3. 原始32B / ClipProj4B 对比：文本遵循、中文发音、动作、身份和多参考需求分别看。
4. 需要 Ref2VA 时：LightX2V 双卡与 Pika / Turbo adapter；先检验原生权重加载，再选量化 TP / SP。
5. 有 5090 环境时：Sol-H3 双阶段、Pika QAD、独立快 VAE；比较同档最终视频和每条成本。

每个运行时复用上游内核，只维护实验入口和服务协议。实测后将胜出的运行时接到现有 private-worker Job / artifact 通道；视频进程和依赖隔离，桌面端无需感知 Comfy 节点或分布式通信。
