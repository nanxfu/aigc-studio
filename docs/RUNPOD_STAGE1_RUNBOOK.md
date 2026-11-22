# 阶段 1 运行手册：RunPod A5000 24G 验收（不建 Network Volume）

> 上位规划：[`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md) §10 阶段 1。
> 前置：阶段 0 已完成（镜像已发布到 GHCR，CI 实测压缩 3.16GB / 未压缩 6.07GB）。
> 本阶段只验两个模型：`sdxl-lightning`（6.78GB）+ `flux2-klein-4b`（16.0GB），约 22.8GB 权重。
> **不建 Network Volume**：直接用 Pod 的 Volume Disk，避免被锁在单一数据中心导致低价卡缺货。

---

## 1. 开 Pod 前：生成 Token（本机执行）

```bash
python -c "import secrets; print(secrets.token_hex(32))"
# 或者：openssl rand -hex 32
```

- 输出是 **64 位十六进制**（32 字节）；Worker 要求 ≥32 字符。
- 只显示这一次：立刻存进密码管理器，后面要粘到 RunPod 环境变量和 AIGC Studio 两处。
- 不要用弱口令、不要提交到仓库、不要贴进聊天记录。

---

## 2. RunPod Pod 配置清单（逐字段照填）

| RunPod 字段 | 填写值 | 说明 |
| :--- | :--- | :--- |
| **Template** | `Custom`（自定义） | 不要选 RunPod 的 PyTorch 模板：那会覆盖镜像入口 |
| **Pod Name** | `aigc-stage1-a5000` | 便于在控制台辨认 |
| **GPU** | `NVIDIA RTX A5000` × 1（24GB） | Secure Cloud 优先；Community 更便宜但可能排队 |
| **Container Image** | `ghcr.io/nanxfu/aigc-worker:sha-5e9986c` | 公开镜像，无需 registry 凭据；`edge` 是移动标签，验收建议用 commit 固定 |
| **Container Disk** | `20 GB` | 镜像未压缩 6.07GB + 临时产物；产物下载后即清理，20GB 足够 |
| **Volume Disk** | `50 GB` | 挂载点 `/workspace`；MVP 权重 22.8GB，留出 HF 缓存与日志余量 |
| **Volume Mount Path** | `/workspace` | RunPod 默认值，不要改成 `/workspace/hf` |
| **Expose HTTP Ports** | `8765` | RunPod 会生成 `https://<pod-id>-8765.proxy.runpod.net` |
| **Expose TCP Ports** | 留空 | 不需要 SSH；调试可用 Web Terminal |
| **Container Start Command** | **留空** | 镜像自带 ENTRYPOINT；填了会作为参数追加，导致 argparse 报错 |

### 2.1 环境变量（3 条，缺一不可）

| Key | Value |
| :--- | :--- |
| `AIGC_WORKER_TOKEN` | 第 1 节生成的 64 位 hex |
| `HF_HOME` | `/workspace/hf` |
| `HF_HUB_CACHE` | `/workspace/hf/hub` |

**为什么两个 HF 变量都要设**：镜像的 `ENV` 里预置了 `HF_HUB_CACHE=/models/hf/hub`，而
`huggingface_hub` 的优先级是 `HF_HUB_CACHE` > `HF_HOME/hub`。只改 `HF_HOME` 的话权重仍会落到
容器盘 `/models/hf/hub`，20GB 容器盘会被 22.8GB 权重写爆，且 Pod 重启后全部重下。

**不要设** `HF_ENDPOINT=https://hf-mirror.com`：RunPod 机房在海外，走国内镜像会跨太平洋回源，
反而更慢甚至被限流。

### 2.2 成本与时长预期

| 项 | 预期 |
| :--- | :--- |
| A5000 单价 | 约 $0.27/小时（≈¥1.9/小时） |
| 首次权重下载 | 22.8GB，取决于机房带宽（10–30 分钟） |
| 模型加载 | `sdxl-lightning` ≈8s、`flux2-klein-4b` ≈28s（T4 基线，A5000 通常更快） |
| 单张出图 | 6–10s（1024²、4 步） |
| 整轮验收 | 20–40 分钟，约 $0.10–0.20（≈¥0.7–1.4） |

---

## 3. 开机后 60 秒自检（RunPod Web Terminal）

Pod 状态变成 **Running** 后，打开控制台 **Connect → Web Terminal**，依次执行：

```bash
# 0) 确认终端里拿得到 Token（Web Terminal 通常继承容器环境变量）
echo ${#AIGC_WORKER_TOKEN}      # 期望 64；若为 0，先 export AIGC_WORKER_TOKEN=<粘贴 Token>

# 1) 存活探针（免鉴权）
curl -s http://127.0.0.1:8765/healthz
# 期望：{"ok":true}

# 2) 详细健康（需 Bearer）
curl -s -H "Authorization: Bearer $AIGC_WORKER_TOKEN" http://127.0.0.1:8765/health \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print({k:d[k] for k in ('status','phase','protocol_version','cpu_offload')}); print(d['hardware']); print({k:d['versions'].get(k) for k in ('python','torch','diffusers','transformers')})"
```

> `hardware` 为 `null` 说明 torch 还在导入，等 10 秒重跑第 2 条即可。

期望输出（字段顺序可能不同）：

```text
{'status': 'ok', 'phase': 'ready', 'protocol_version': '2.0.0',
 'cpu_offload': {'mode': 'auto', 'source': 'default', 'effective': None}}
{'gpu_name': 'NVIDIA RTX A5000', 'vram_total_mb': 24564, 'count': 1, 'cuda': '12.4', 'driver': None}
{'python': '3.11.x', 'torch': '2.6.0+cu124', 'diffusers': '0.43.0', 'transformers': '5.23.0'}
```

```bash
# 3) 确认权重落盘位置（首次生成后再执行）
df -h /workspace
du -sh /workspace/hf 2>/dev/null
```

判定：`phase=ready`、协议 `2.0.0`、`gpu_name` 是 A5000、`vram_total_mb` 约 24564。
若 `phase=error` 且 `last_error_code=gpu_unavailable`，说明 Pod 没拿到 GPU（规格选错或宿主机异常），
直接重建 Pod，不要继续验收。

---

## 4. AIGC Studio 逐项验收

> 前置：本机 AIGC Studio 0.15.0 已启动。每项都给出「操作 → 期望」，任一项不符即记录并停止后续步骤。

### 4.1 连接与协议协商

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 1 | 右上角「设置」→「云端算力」→ 算力来源选 **私有 Worker（自有 GPU）** | 出现「Worker 地址 / 访问令牌 / 测试连接」三个字段 |
| 2 | Worker 地址填 `https://<pod-id>-8765.proxy.runpod.net`（从 RunPod Connect 面板复制，**不要**带尾部斜杠或路径） | 输入框不报错（非本机地址必须 `https://`） |
| 3 | 访问令牌粘贴第 1 节的 64 位 hex | 显示为密码框；旁边提示「Token 只保存在本机加密凭据里」 |
| 4 | 点「测试连接」 | 显示 `连接正常 · 协议 2.0.0 · NVIDIA RTX A5000` |
| 5 | 保存设置 → 顶栏算力入口点「连接」 | 顶栏显示「私有 Worker」且状态为「已连接」；展开弹层，GPU 一行显示 `NVIDIA RTX A5000`，连接地址是 RunPod 域名 |

失败对照：`连不上私有 Worker` = 地址/端口错；`鉴权失败` = Token 不一致；
`协议版本不一致` = 镜像不是本次发布的版本（核对镜像 tag）。

### 4.2 文生图（SDXL Lightning，含首次下载与加载）

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 6 | 左栏模型选 **SDXL Lightning**，1024×1024、4 步、1 张，输入提示词后点生成 | 任务卡进入排队/运行；首次会下载 6.78GB 权重，Pod 日志出现下载与 `[load]` 加载记录 |
| 7 | 观察任务卡 | 出现「正在生成第 1/1 张 · n/4 步」（4 步很快，可能一闪而过，属正常） |
| 8 | 出图后打开产物 | 1024×1024 图片完整可打开（binary 通道 + sha256 校验通过，失败会报 `artifact_failed`） |
| 9 | 记录耗时 | 任务卡或 `/health` 的 `gpu_memory.max_allocated_mb` ≈ 10.3GB（T4 基线 10347MB） |

> 步数进度在 4 步模型上只能瞬时看到；阶段 2 的 9B/Qwen 步数更多，可稳定观察。

### 4.3 图生图（整图重绘）

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 10 | 舞台选中刚出的图 → 动作坞「整图重绘」→ 改一句描述、强度 0.6 → 重绘 | 新版本挂在同一作品谱系下；尺寸跟随源图 |
| 11 | 看 Pod 日志 | 第二次起**没有**新的 `[load] 模型就绪` 行（`from_pipe` 复用底座，不重新加载权重），出图直接开始 |

### 4.4 局部重绘

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 12 | 选中出图 → 动作坞「局部重绘」→ 涂抹中心区域 → 填修改描述 → 重绘 | 提交成功；未涂抹区域逐像素保留（可与源图对比） |
| 13 | 涂抹覆盖率过低时 | 提交前被拦下并提示（蒙版最小覆盖率护栏） |

### 4.5 高清放大（Real-ESRGAN 2×）

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 14 | 选中 1024² 出图 → 动作坞「高清放大」 | 任务卡无步数（零参数工具），完成后得到 2048×2048 |
| 15 | 检查产物 | 尺寸恰好 2×，内容与源图一致（无错位/花屏） |

### 4.6 参考生图（FLUX.2 Klein 4B，含第二次下载）

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 16 | 模型切 **FLUX.2 Klein 4B**（首次下载 16.0GB）→ 参考图槽「从作品选择」选 1 张 → 生成 | 出图成功；Pod 日志显示 `flux2` 加载与新架构（diffusers 0.43）无 import 错误 |
| 17 | 再加第 2 张参考图 → 生成 | 两张参考图同时生效，无报错；显存无异常增长 |
| 18 | 切回 SDXL Lightning 再生成一次 | 切换模型不残留旧管线（显存回落，日志有「先卸载旧模型」） |

### 4.7 取消、断线与重连

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 19 | 发起 4 张批量，第 1 张完成后点任务卡「取消」 | 提示「当前这张画完后停止」，已完成图片保留；`/health.queue_depth` 归零 |
| 20 | 顶栏「断开」→ 再「连接」 | 几秒内恢复 ready；RunPod 日志无进程重启（共享 Worker 只断连接不关机） |
| 21 | 重连后立即再生成一张 | Pod 日志没有新的 `[load]` 加载行、出图立即开始（模型仍在显存），证明断开没有卸载模型 |

### 4.8 安全与计费

| # | 操作 | 期望 |
| :--- | :--- | :--- |
| 22 | 在 Pod 内按下方命令检查 `/health` 是否回显 Token | 输出 `NO_LEAK`（Token 不出现在 `/health`） |
| 23 | RunPod 控制台 **Logs** 页签搜索 Token 前 8 位 | 无命中（Token 只落 0600 临时文件，不进日志） |
| 24 | 验收结束：RunPod 控制台 **Stop Pod**（不要 Terminate，除非确认不再用） | 计费停止；Volume Disk 保留，下次启动权重不用重下 |

第 22 项的检查命令（在 Web Terminal 里执行）：

```bash
curl -s -H "Authorization: Bearer $AIGC_WORKER_TOKEN" http://127.0.0.1:8765/health \
  | grep -F "$AIGC_WORKER_TOKEN" && echo "LEAK" || echo "NO_LEAK"
```

---

## 5. 记录表（回填到规划文档）

| 指标 | 实测值 |
| :--- | :--- |
| Pod / GPU / 单价 |  |
| `sdxl-lightning` 首次下载 + 加载秒数 |  |
| `sdxl-lightning` 稳态出图秒数（1024²/4 步） |  |
| `flux2-klein-4b` 首次下载 + 加载秒数 |  |
| `flux2-klein-4b` 稳态出图秒数 |  |
| `/health.gpu_memory.max_allocated_mb`（两模型各一次） |  |
| 整轮耗时 / 费用 |  |
| 失败项与错误码 |  |

---

## 6. 常见错误与处置

| 现象 | 原因 | 处置 |
| :--- | :--- | :--- |
| 顶栏一直「未连接」/ `worker_unreachable` | 端口没暴露、Pod 未 Running、地址复制错 | 核对 Expose HTTP Ports=8765；用 Pod 内 `curl 127.0.0.1:8765/healthz` 先确认服务活着 |
| `worker_unauthorized` | Token 不一致（多了空格/换行） | 重新粘贴；Pod 内 `echo ${#AIGC_WORKER_TOKEN}` 应为 64 |
| `protocol_mismatch` | 用了旧镜像 | 换成 `ghcr.io/nanxfu/aigc-worker:sha-5e9986c` |
| 权重下到容器盘、Pod 磁盘告警 | 只设了 `HF_HOME`，没设 `HF_HUB_CACHE` | 补上 `HF_HUB_CACHE=/workspace/hf/hub`，删掉 `/models/hf` 后重下 |
| 首次生成卡在下载很久 | 机房到 HF 的带宽 | 正常；`/workspace/hf` 会保留，重启用 `du -sh` 确认已缓存 |
| `gpu_unavailable` | Pod 没拿到 GPU | 重建 Pod；确认规格是 A5000 24G 而非 CPU |
| 出图报 OOM | 并发/分辨率超限 | 单张 1024² 重试；本阶段两模型 24GB 足够，OOM 多半是残留管线 |
| SSE 被切断（日志有断流） | RunPod 代理 100 秒超时 | 预期行为；Host 自动回退 `/job` 轮询，任务不受影响 |

---

## 7. 收尾

1. 把第 5 节数据补进 [`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md) §10 阶段 1 与
   `docs/ROADMAP.md` 的 M3.1-c 阶段 1 条目。
2. RunPod 控制台 **Stop Pod**；确认计费归零（Billing 页）。
3. 本阶段通过后，阶段 2 再补 `sana-sprint` / `anima-turbo-v1.1` / `z-image-turbo` /
   `qwen-image-2.1` / `flux2-klein-9b`，并做 `cpuOffload` 开/关跨卡 A/B（用
   `AIGC_WORKER_CPU_OFFLOAD=on|off` 重建 Pod 即可，不改模型资产）。

> **阶段 2 前置小优化（本次未改镜像，避免验收期间镜像变动）**：镜像 `ENV` 预置了
> `HF_HUB_CACHE=/models/hf/hub`，导致只设 `HF_HOME` 时权重仍写容器盘。下一版镜像应删掉这条
> 预置，让 `HF_HOME` 单变量即可决定缓存位置；届时本手册 §2.1 可只保留 `HF_HOME`。
