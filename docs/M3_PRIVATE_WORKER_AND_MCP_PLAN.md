# 私有 GPU Worker、协议 v2 与 MCP（里程碑 M3）实施规划

> **定位**：Phase 2 的专项规划。目标是把「只能借 Kaggle/Colab 临时 Notebook」扩展为「可接自建长驻 GPU 服务」，同时把远端协议从「base64 JSON 单次轮询」升级为「二进制产物 + 事件流」，并把工作室能力以标准 MCP Server 暴露给外部 Agent。
> **上位文档**：[`AIGC_STUDIO_STANDALONE_PLAN.md`](AIGC_STUDIO_STANDALONE_PLAN.md) §五/§六、[`ARCHITECTURE.md`](ARCHITECTURE.md)（后者仍有 DSH 时代内容，阅读时以本文件与 `MIGRATION_NOTES.md` 为准）。
> **基线**：`0.15.0`；M3.0、M3.1-a/b、**M3.2（云端协议 v2）与 M3.3（MCP）已落地**（2026-11-22）；M3.1-c 真机验收按用户决定暂缓（AutoDL 接入冻结，2026-11-22）；**M3.4 本机 Vulkan 文生图闭环已完成（2026-11-25，AMD Radeon 880M），N 卡 CUDA 路径与设置页安装向导仍待续**；HTTP Range 已实现；Agent 工具是 JSON Schema（不是早期文档所说的 TypeBox）。
> **迭代日期**：2026-11-22。
>
> **命名说明**：本文的「M3」指私有 Worker / 协议 v2 / MCP 这一阶段；历史文档里 0.12.0 的「M3 图生图」是旧编号，二者不是同一件事。后文优先用「私有 Worker」「协议 v2」「MCP」这类描述性说法，里程碑编号只用于对照。

---

## 0. 决策摘要

1. **拆成四个可独立验收的子阶段**：`M3.0 底座` → `M3.1 私有 Worker` → `M3.2 云端协议 v2` → `M3.3 MCP`，`M3.4 本机 GPU` 为可选尾项。每个子阶段都能单独合并、单独回滚，不做一个「大爆炸式 M3」。
2. **协议版本与产品版本解耦**（M3.0 的第一件事）。现在 `package.json`、`shared/contract.js`、`worker/daemon.py` 三处版本强制相等；私有 Worker 是独立部署的，如果每发一次客户端都要同步升级 Worker，长驻部署就失去意义。拆成 `APP_VERSION`（产品）与 `PROTOCOL_VERSION`（Host↔Worker），Host 只按协议主版本握手。
3. **私有 Worker 先作为协议 v2 的参考实现**，再把 Kaggle/Colab 的 `daemon.py` 迁移到 v2。私有 Worker 没有历史包袱，可以先把「二进制产物 + SSE + 能力协商」跑通；云端 daemon 再按同一份协议补齐，避免协议改两遍。
4. **SSE 分两跳，但只强制做第一跳**：Worker → Host 的事件流（任务步数、状态、日志）是协议能力；Host → 渲染进程是否改用 SSE，先用现有 2 秒轮询承接，等真实需要再补 `server/routes/events.js`。不要为了「全链路 SSE」重写前端状态层。
5. **MCP 不复制工作室状态**：MCP Server 是独立 stdio 进程，只通过已鉴权的本地 `/api/*` 调用现有服务；通过 `runtime.json` 发现端口与 Token，不直接 import `server/app.js`，不另起队列、不另开 GPU 会话。
6. **本机 GPU 是可选尾项**：它依赖私有 Worker 的服务端与进程托管能力，但涉及 `nvidia-smi`、`uv` 环境、PyTorch/CUDA 下载、Windows 防火墙与磁盘占用，复杂度明显高于远程 Worker。没有真实 N 卡机器就不启动，不阻塞 M3 完成。
7. **不做多租户/调度器/热更新/视频 3D**：私有 Worker 是「单用户、单并发、自己的机器」；多用户鉴权、任务分发、配额计费不在本阶段。视频/3D 仍归 M4。

**依赖关系**：

```text
M2.8-A（发布通道） → M2.8-B（应用内更新）

M3.0（协议/Provider 底座） ──→ M3.1（私有 Worker） ──→ M3.2（云端协议 v2）
                                   └──────────────→ M3.3（MCP，可与 M3.2 并行）
                                   └──────────────→ M3.4（本机 GPU，可选）
```

MCP 不依赖私有 Worker；它只依赖 M3.0 之后的工具规格抽取与本地服务稳定。若想更快拿到外部 Agent 能力，可以把 M3.3 提到 M3.2 之前。

---

## 1. 现状盘底（差距不是猜测，是代码事实）

| 能力 | 当前实现 | 缺口 |
| :--- | :--- | :--- |
| Provider 契约 | [`server/providers/provider.js`](../server/providers/provider.js) 已定义 `provision / pollEndpoint / checkAlive / keepAlive / teardown / cleanupPending / readLogs` | 只有 Kaggle/Colab 两个实现；`private-worker.js`、`local-gpu.js` 全部抛 `not_implemented` |
| 会话状态机 | [`server/session.js`](../server/session.js) 已按 provider 拆分大部分动作 | `providerFor()`、`applyProviderSettings()`、`provision()` 里仍写死 `kaggle`/`colab` 二选一；`reattachCandidate()` 只认 Kernel；worker 型 provider 没有接入路径 |
| 会话记录 | [`server/session/persistence.js`](../server/session/persistence.js) `version=1`，`normalizeRecord()` 只接受 `provider === 'colab'` | 私有 Worker 的 `endpointUrl + token` 记录会被丢弃；没有 worker handle / 协议版本字段 |
| 算力来源白名单 | `SETTINGS.providers = ['kaggle','colab']`（[`shared/contract.js`](../shared/contract.js)） | 新增来源要同时改设置校验、模型能力过滤、设置抽屉、顶栏状态、Agent 提示词 |
| 长驻 Worker 入口 | [`worker/worker_server.py`](../worker/worker_server.py) 只解析参数并退出 2 | 没有 HTTP 服务、没有鉴权、没有任务执行；`worker/app.py` 的启动编排与 ntfy/cloudflared/claim 看门狗耦合，不能直接复用 |
| 远端产物回传 | `GET /job` 的 `results[]` 带 `image_b64`；Host 用 `httpText` 读 JSON（`remoteGenerateMaxBytes` 上限） | 内存峰值高、请求体上限硬；没有二进制下载、断点续传、哈希校验 |
| 进度 | `JobStore.payload()` 只有 `progress: {done,total}` | 没有扩散步数；没有事件流；Host 只能轮询 |
| `/health` | 已有 `phase / model_id / device / queue_depth / tunnel_* / versions / gpu_memory` | 没有 `protocol_version`、没有 `capabilities`、没有 `hardware`（GPU 型号/显存/驱动） |
| Agent 工具 | [`server/tools.js`](../server/tools.js) 7 个工具，JSON Schema 单源 | 描述里写死「Kaggle GPU」「Kernel」；没有可被 MCP 复用的纯规格模块；`mcp/` 没有被 electron-builder 打进安装包 |
| 媒体读取 | [`server/routes/files.js`](../server/routes/files.js) 已支持单段 Range/HEAD | 已满足视频/大图读取，本阶段不需要改 |
| 本机 GPU | [`server/providers/local-gpu.js`](../server/providers/local-gpu.js) 占位 | 无 `nvidia-smi` 探测、无 `uv` 环境、无进程托管 |
| 版本 | `package.json` = `shared/contract.js` `VERSION` = `worker/daemon.py` `VERSION` | 产品版本与协议版本未分离；私有 Worker 无法独立升级 |

---

## 2. 目标架构

```text
┌─────────────────────────────┐
│ MCP 客户端（Claude Desktop /│
│ Cursor / DSH / 自研 Agent） │
└──────────────┬──────────────┘
               │ stdio (JSON-RPC)
┌──────────────▼──────────────┐
│ mcp/server.mjs              │  只做协议适配，不持有队列/会话
│  · 读 runtime.json 发现端口 │
│  · Bearer Token 调本地 API  │
└──────────────┬──────────────┘
               │ HTTP 127.0.0.1 + Bearer
┌──────────────▼─────────────────────────────────────────────┐
│ 本地控制面 server/（Electron 子进程 / 独立 Node）          │
│  SessionManager ── Provider Registry ── JobQueue            │
│    ├─ kaggle / colab（Notebook 型：push + ntfy + tunnel）   │
│    ├─ private-worker（Worker 型：HTTPS + Bearer + SSE）     │
│    └─ local-gpu（Worker 型：本机 spawn + 127.0.0.1）        │
└───────┬───────────────────────────────┬─────────────────────┘
        │ ntfy 会合 + cloudflared       │ HTTPS / SSE / 二进制
┌───────▼──────────────┐       ┌────────▼─────────────────────┐
│ Kaggle / Colab       │       │ 私有 GPU Worker              │
│ worker/daemon.py     │       │ worker/worker_server.py      │
│ 临时容器，空闲退出   │       │ 长驻 Linux / Docker / 本机   │
└──────────────────────┘       └──────────────────────────────┘
```

**职责边界**：

- `server/session.js` 只负责「会话状态机」；平台差异全部下沉到 provider。
- `provider.kind` 区分 `notebook`（临时、需要会合/关机）与 `worker`（长驻、固定地址、无会合）。
- Worker 只负责「加载模型、执行任务、暴露健康/任务/产物/事件」，不感知工作区、不写本地画廊。
- MCP 只做协议转换，不绕过本地 API 的鉴权与参数校验。

---

## 3. 协议 v2

### 3.1 版本与协商

- `APP_VERSION`：产品版本（`package.json`），用于 UI、Release、日志。
- `PROTOCOL_VERSION`：Host↔Worker 协议版本，语义化 `2.0.0`。`shared/contract.js` 单源，`worker/contract.json` 由 `tools/gen-contract-json.mjs` 生成。
- `VERSION` 保留为 `APP_VERSION` 的兼容别名，避免一次性改遍 UI；新增代码一律用 `APP_VERSION` / `PROTOCOL_VERSION`。
- Host 连接 Worker 后先读 `/health.protocol_version`：
  - 主版本不同 → `protocol_mismatch`，不发送任务，提示升级 Worker 或客户端；
  - 主版本相同、Worker 次版本更高 → 允许，忽略不认识的 capability；
  - Worker 次版本更低但缺少 Host 必需能力 → 降级（例如没有 binary 就回 inline），并在日志标记。
- `daemonContract()` 里的 `version` 字段改为 `PROTOCOL_VERSION`；`worker/daemon.py` 的 `VERSION` 同步为协议版本。`package.json` 与 `APP_VERSION` 对齐，`check-contract` 分别校验两者。

### 3.2 `/health` 增量

保留现有字段，新增：

```json
{
  "phase": "ready",
  "protocol_version": "2.0.0",
  "capabilities": {
    "result_modes": ["inline", "binary"],
    "events": true,
    "artifact_range": true,
    "tools": ["generate", "upscale"],
    "loaders": ["sdxl", "sdxl-lora", "zimage", "flux2"],
    "reference": true,
    "inpaint": true
  },
  "hardware": {
    "gpu_name": "NVIDIA GeForce RTX 4090",
    "vram_total_mb": 24564,
    "driver": "550.54.14",
    "cuda": "12.4",
    "count": 1
  }
}
```

- `capabilities` 只声明**真实可用**的能力，不能照抄契约；`loaders` 来自 `worker/inference` 注册表。
- `hardware` 允许为 `null`（CPU mock / 驱动不可读）；Host 不用它做硬门槛，只用于 UI 与模型建议。
- `phase` 沿用 `booting / installing / loading / ready / error`；Worker 型没有 `tunnel_*` 字段，Host 按缺省处理。

### 3.3 任务与产物

| 端点 | v1 | v2 增量 |
| :--- | :--- | :--- |
| `POST /generate` | `pipeline / tasks / reference / referenceImages` | 可选 `result_mode: 'inline' \| 'binary'`；缺省 `inline`，保证旧 Host 不变 |
| `GET /job?id=` | `results[]` 带 `image_b64` | `binary` 模式下 `results[]` 只带元数据：`{index,width,height,seed,seconds,media_type,bytes,sha256}` |
| `GET /artifact?id=&index=` | — | 新增；`application/octet-stream`，`content-length`、`etag`（sha256）、单段 `Range`/416 |
| `GET /events` | — | 新增 SSE：`job` / `state` / `log`，15 秒心跳，`Last-Event-ID` 重放最近 200 条 |
| `POST /shutdown` | 有 | Worker 型默认关闭；本机托管时由 `--allow-shutdown` 打开 |

**二进制模式的生命周期**：

1. Worker 执行完成后把产物写进自己的临时目录（按 job id 分目录），`JobStore` 只存元数据与路径；
2. Host 在 `GET /job` 看到 `done` 后，逐个 `GET /artifact` 下载到 `%TEMP%/aigc-studio/artifacts/<jobId>/`，边下边算 sha256；
3. 校验通过后原子移动到最终产物目录；失败则重试（优先 Range 续传），仍失败标记该张失败，不影响同批其它张；
4. Worker 按 TTL 清理临时产物（建议 30 分钟），`artifact_not_found` 是明确终态，Host 不无限重试。

**为什么用 `/artifact` 而不是 multipart 一次性回传**：单张下载可续传、可校验、可并发；视频/3D 时代不需要再改协议。multipart 留给未来的「批量打包下载」场景，不在本阶段。

### 3.4 SSE 事件

```text
event: job
id: 42
data: {"id":"j_ab12","status":"running","progress":{"done":0,"total":1,"step":12,"steps":28}}

event: log
data: {"line":"[load] pipe ready"}

: ping
```

- 响应头：`content-type: text/event-stream`、`cache-control: no-cache`、`x-accel-buffering: no`、`connection: keep-alive`。
- 鉴权仍走 `Authorization: Bearer`；**不接受 query token**，避免进入代理日志。
- 每个 Worker 最多 4 条并发事件流；超出返回 `429 too_many_streams`。
- Host 侧事件流断开不影响任务：重连用 `Last-Event-ID`；若 Worker 不支持重放，回退 `/job` 轮询。
- Host 仍然是「最终状态以 `/job` 为准」：SSE 只用于降低延迟与展示步数，不能把 SSE 的 `done` 当作唯一完成信号。

### 3.5 错误码

沿用 `worker/errors.py` 与 `PROVIDER_ERROR_CODES`，新增 Host 侧：

| 错误码 | 含义 | 用户可做的事 |
| :--- | :--- | :--- |
| `worker_unreachable` | 连接超时/DNS/拒绝 | 检查地址、容器、防火墙、SSH 隧道 |
| `worker_unauthorized` | Token 缺失/错误 | 重新填写 Token |
| `protocol_mismatch` | 协议主版本不一致 | 升级 Worker 或客户端 |
| `capability_missing` | Worker 不支持所需工具/加载器 | 换模型或升级 Worker |
| `artifact_failed` | 产物下载/哈希失败 | 重试；仍失败看 Worker 日志 |
| `gpu_unavailable` | 无 GPU / 显存不足 | 检查驱动、显存、模型档位 |

远端错误仍由 `ProviderError(code, message, {logsTail})` 收敛；provider 不改会话状态。

---

## 4. M3.0：底座（协议分离 + Provider 注册表 + 记录 v2）

> 这一阶段**不新增用户可见功能**，但它是私有 Worker 的前置。做完后 Kaggle/Colab 行为必须完全不变。

### 4.1 任务

1. **版本分离**（`shared/contract.js`、`server/session/provisioner.js`、`worker/daemon.py`、`tools/gen-contract-json.mjs`、`test/check-contract.mjs`、`test/kernel-package.mjs`）：
   - 新增 `APP_VERSION`、`PROTOCOL_VERSION`；`VERSION` 作为 `APP_VERSION` 别名；
   - `daemonContract().version` 改为 `PROTOCOL_VERSION`；daemon 常量同步；
   - `check-contract` 校验 `package.json === APP_VERSION`、`daemon === PROTOCOL_VERSION`、`contract.json === PROTOCOL_VERSION`；
   - `/api/state` 增加 `protocol` 字段（只读），`version` 仍是产品版本。
2. **Provider 注册表**（新增 `server/providers/index.js`）：
   - `PROVIDER_META`：`{ id, kind: 'notebook'|'worker', reattach, pendingCleanup, remoteShutdown, idleTimeout, logs, binary, events }`；
   - `createProvider(id, deps)` 统一构造；未注册 id 抛 `unknown_provider`；
   - `server/session.js` 改用注册表：`providerFor()`、`applyProviderSettings()`、`provision()` 不再写死 `kaggle`/`colab`。
3. **会话记录 v2**（`server/session/persistence.js`）：
   - Notebook 记录保持 `version:1`，旧客户端可读；
   - Worker 记录写 `version:2`，字段 `provider / endpointUrl / token / handle{workerId,protocolVersion} / presetId`，`kernelId/topic` 可空；
   - 新客户端同时读 v1/v2；v2 未知 provider 按无效记录清理，不猜成 Kaggle。
4. **设置与能力域**（`shared/contract.js`、`server/settings.js`、`shared/models-guide.js`）：
   - 契约新增 `PROVIDERS` 注册表（`kind` 与 `reattach / pendingCleanup / remoteShutdown / idleTimeout / logs / binary / events` 能力位，登记 `kaggle / colab / private-worker / local-gpu`）；`SETTINGS.providers` 只取 `enabled === true` 的项（M3.0 仍是 `kaggle/colab`，私有 Worker 随 M3.1、本机 GPU 随 M3.4 翻开放行）——这样模型资产可以提前声明 `private-worker`，而设置抽屉不会出现「点了就报未实现」的选项；
   - `PROVIDER_NAMES` 补「私有 Worker / 本机 GPU」；
   - `presetProviderRestrictionOf` 返回类型从 `''|'kaggle'|'colab'` 放宽为 `''|providerId`，UI 文案按 provider 名生成，不能再写死「仅 Colab」。
5. **测试替身**：新增 `server/providers/fake-worker.js`（仅测试用），实现 worker 型契约，配合本地 mock HTTP 服务覆盖「启动 → ready → 停止 → 重启恢复」。

### 4.2 验收

- [ ] `npm test`、`python test/worker/run.py` 全绿；Kaggle/Colab 的 session 套件零行为变化。
- [ ] 版本分离后，`check-contract` 能分别报出「产品版本不一致」与「协议版本不一致」，错误可读。
- [ ] 用 fake worker 走通 `SessionManager.start / stop / restore`，记录 v2 能落盘并恢复。
- [ ] 旧 v1 记录（Kaggle/Colab）仍能恢复；旧客户端读到 v2 worker 记录时安全拒绝，不误连 Kaggle。
- [ ] `/api/state` 的 `version`、`protocol` 与设置页「当前版本」一致。

---

## 5. M3.1：私有 Worker（长驻 GPU 服务）

### 5.1 部署形态

| 形态 | 适用 | 说明 |
| :--- | :--- | :--- |
| Docker（推荐） | 自有 Linux GPU 服务器 / 云 GPU 租用 | `worker/deploy/Dockerfile` + `docker-compose.yml`；`--gpus all`；模型缓存挂卷 |
| 裸机 systemd | 长期运行的 Ubuntu 工作站 | `worker/deploy/aigc-worker.service`；`Restart=on-failure` |
| SSH 隧道 | 内网机器、不想开公网端口 | `ssh -L 8765:127.0.0.1:8765 user@gpu-box`，Host 连 `http://127.0.0.1:8765` |
| 反代 + TLS | 公网访问 | Caddy/Nginx 终止 TLS，Worker 只监听 127.0.0.1 或内网 |
| 租用容器（AutoDL 等） | 按小时计费、预装 PyTorch 的云 GPU 容器 | 无法 Docker-in-Docker / 无 systemd；部署隔离、无卡预拉权重、闲置停机与隧道/代理实测见 [`AUTODL_WORKER_RESEARCH.md`](AUTODL_WORKER_RESEARCH.md) |

**安全基线**：

- Worker 默认监听 `127.0.0.1`；Docker 部署才 `0.0.0.0`，并由防火墙限制来源。
- Token 32 字节随机 hex，从 `AIGC_WORKER_TOKEN` 或 `--token-file` 读取，不落日志；文件 0600。
- 非回环地址必须 `https://`（Host 侧校验）；纯 `http://` 只允许 `127.0.0.1`/`::1`。公网明文 HTTP 直接拒绝，不给「我知道风险」开关。
- Worker 不执行 Host 传来的任意 shell；只接受契约内的 `pipeline/tasks/tool` 字段。

### 5.2 `worker/worker_server.py`

从占位改为可运行入口，复用现有模块而不是复制：

1. **抽取运行时编排**：把 `worker/app.py` 里的 `runtime_boot()`（GPU 探测 → 依赖安装 → 预加载 → phase 推进）抽到 `worker/runtime.py`，`DaemonApp` 与新的 `WorkerServerApp` 共用；隧道、ntfy、claim 看门狗留在 `DaemonApp`。
2. **参数**：
   - `--host`（默认 `127.0.0.1`）、`--port`（默认 `8765`，`0` = 随机）；
   - `--contract`（默认随包 `worker/contract.json`）；
   - `--token-file` / `AIGC_WORKER_TOKEN`；
   - `--no-install`（镜像已装依赖时跳过 pip）、`--preload <preset>`（可选）；
   - `--idle-timeout`（默认 `0` = 不自动退出；共享 Worker 不应因 Host 断开而关机）；
   - `--allow-shutdown`（仅本机托管/单用户场景；默认关闭）。
3. **启动顺序**：读契约 → 校验协议版本 → 启 HTTP（先可观测）→ 后台 `runtime_boot()` → phase `ready`；stdout 只打印一行 ready JSON `{type:'ready',port,pid,protocol_version,capabilities}`，日志走 stderr。
4. **HTTP 层**：复用 `worker/transport/http_server.py`，参数化 `auth_token`、`allow_shutdown`、`events`、`artifact`；新增 `/artifact` 与 `/events`；`/healthz` 无鉴权只回 `{ok:true}`，详细 `/health` 仍需 Bearer。
5. **任务层**：复用 `worker/jobs/store.py` 与 `worker/jobs/runner.py`；串行执行不变；`result_mode=binary` 时结果落临时目录。
6. **退出**：SIGTERM/SIGINT 停止 HTTP、等待当前 job 合作式结束（最多 10 秒）、清理临时产物；不自动卸载模型（进程退出自然释放）。

### 5.3 Host 侧 `private-worker` Provider

> **状态（M3.1-b，2026-11-22）**：已落地。除下表方法外，连接判定抽到
> `server/providers/worker-connection.js`（与 mock 替身、`POST /api/worker/probe` 共用）；
> 地址写 `app-config.compute.privateWorker`，Token 写 `credentials/workers.json`（AES-256-GCM）。
> 真机四项工具验收留给 M3.1-c。

实现 `server/providers/private-worker.js`：

| 方法 | 行为 |
| :--- | :--- |
| `provision` | 归一 endpoint（去尾斜杠）→ `GET /health`（5 秒）→ 401 归 `worker_unauthorized`，网络归 `worker_unreachable` → 校验 `protocol_version` 主版本 → 返回 `{workerId, endpointUrl, protocolVersion}`；`phase=error` 直接失败并带 `logsTail` |
| `pollEndpoint` | `phase=ready` 返回 `{endpointUrl}`；`booting/installing/loading` 返回 `null` 并更新 phase 文案；不自己建定时器 |
| `checkAlive` | 单次 `/health`；404/401/网络失败按 `alive:false` + `status` 返回 |
| `keepAlive` | 默认空操作（长驻服务不需要心跳续命）；可选 `GET /health` 轻量探活 |
| `teardown` | 共享 Worker：只断开，不关机；`owned:true`（本机 GPU）：调用 `/shutdown` 并等待进程退出 |
| `cleanupPending` | 共享 Worker：空操作；本机 GPU：按落盘 pid 清理残留进程 |
| `readLogs` | `GET /logs?since=`，与 daemon 同形 |

**SessionManager 适配**：

- `provision()` 对 `kind==='worker'` 跳过 Kernel 目录、`topic`、`buildKernelConfig`、`datasetSources`；
- `reattachCandidate()` 对 worker 读记录里的 `endpointUrl + token`，先 `/health`，ready 直接接管，warming 进入 `connecting`，不可达则 `worker_unreachable`；
- `teardown` 不删除远端会话记录（共享 Worker 仍在线），只清本地 `session.json`；
- 顶栏「断开」语义改为「断开连接」，不再承诺「关机」；本机 GPU 才显示「停止本机 Worker」。

### 5.4 设置、凭据与 UI

- **设置结构**（写入 `app-config`，Token 不进 `settings.json`）：
  ```json
  { "compute": { "provider": "private-worker",
                 "privateWorker": { "endpointUrl": "https://gpu.example.com:8765", "tokenConfigured": true } } }
  ```
- Token 存 `credentials/workers.json`，复用 `safeStorage` + AES-256-GCM（与 LLM Key 同一套主密钥），API 只回 `tokenConfigured`，不回明文。
- 新增路由 `POST /api/worker/probe`（契约登记）：入参 `{ endpointUrl, token? }`，返回 `{ ok, phase, protocolVersion, hardware, error }`；用于设置抽屉「测试连接」。
- 设置抽屉「算力」区按 provider 切换字段：
  - Kaggle：加速器、访问方式、数据集、空闲关机；
  - Colab：GPU 型号、高 RAM；
  - 私有 Worker：地址、Token、测试连接、协议版本/GPU 型号只读展示；
  - 本机 GPU（M3.4）：环境状态、安装/启动/停止。
- 顶栏算力胶囊：显示「私有 Worker · 已连接（RTX 4090）/ 连接中 / 不可达 / 鉴权失败」；不再显示 Kaggle 队列文案。
- 会话动作文案：`唤醒` → `连接`，`关机` → `断开`（共享 Worker）；本机 GPU 保留「停止」。
- 空闲关机：私有 Worker 隐藏该设置（由 Worker 自己的 `--idle-timeout` 决定）；本机 GPU 可保留。

### 5.5 模型能力

当前 `models/*.json` 用 `providers: ['colab']` 表达「只能在 Colab 跑」（3 个 9B/大模型）。私有 Worker 的显存可能更大，不能因为平台名被误伤。

- **M3.1 最小方案**：把 `private-worker` 加入这些模型的可运行来源；Worker `/health.hardware.vram_total_mb` 只用于提示，不做硬拦；显存不足由 Worker 返回 `gpu_unavailable`/OOM 可读错误。
- **M3.2 目标方案**：模型资产增加 `minVramGb`、`requiresHfToken`、`loaders` 等需求位；`presetAvailableForProvider()` 改为「provider 能力 + 模型需求」匹配，平台名逐步退化为兼容别名。不要在 M3.1 就把三套过滤逻辑重写，先让功能可用。
- Agent 工具描述里的「Kaggle GPU」「Kernel」改为「当前算力来源」，由 `server/agent/prompt.js` 注入实时来源；`describeSession()` 的 Kernel 文案按 provider 类型分支。

### 5.6 测试与验收

**离线**：

- Python：`worker_server` 启动/关闭、`/healthz` 免鉴权、`/health` 401、协议版本不匹配、`/generate` 入队、`/artifact` 200/206/416、`/events` 心跳与重放、`--allow-shutdown` 行为。
- Node：provider 的 URL 校验（http 非回环拒绝）、401/超时/协议不匹配分类、teardown 幂等、记录 v2 恢复。
- Host e2e：用 Node mock worker（返回 health/generate/job/artifact/events）走完一次生成，确认产物落盘与版本树。

**真机**：

- Docker（可用 CPU + mock pipeline 先验流程）：`docker compose up` → 设置页测试连接 → 生成一张图 → 断开 → 重连恢复。
- 真实 GPU（Linux + NVIDIA）：`sdxl-lightning` 文生图、`--upscale`、`--reference`、`--inpaint` 四项与 Kaggle 基线对齐；记录冷启动/出图耗时与显存。
- 故障：Token 错、端口不通、Worker 中途被杀、协议版本改错、产物下载中断，均要有可读错误与可重试路径。

**验收**：

- [ ] 不依赖 ntfy/cloudflared，Docker 一条命令起服务，Host 填地址+Token 即可用。
- [ ] 生成/放大/参考生图/局部重绘在私有 Worker 上通过；产物落盘与版本树正确。
- [ ] 断开不杀共享 Worker；重连能接管；应用重启能从 `session.json` 恢复。
- [ ] Token 不以明文出现在设置响应、日志、`/api/state`。
- [ ] 协议不匹配/鉴权失败/地址不可达三类错误文案可执行。

---

## 6. M3.2：云端协议 v2（Kaggle/Colab 迁移 + 进度）

> **状态（2026-11-22）**：已落地。Host 侧 `server/net-stream.js` + `remote.downloadArtifact/openEvents` + `JobQueue` 能力协商/临时产物/SSE 步数；Worker 侧 `Job/JobStore` 步数 + daemon 的 `callback_on_step_end` 注入；Kaggle/Colab 的 `binary/events` 能力位已打开（仍以 `/health.capabilities` 为准）。离线回归见 `test/remote-v2.mjs` 与 `test/worker/test_protocol_v2.py`。

> 私有 Worker 跑通 v2 后，把同一套能力补到 `worker/daemon.py`。这一阶段的目标是「同一协议、两种部署」，不是再发明一套。

### 6.1 Worker 侧

1. `result_mode`：`POST /generate` 接受 `inline|binary`，缺省 `inline`；binary 时结果写 `jobs/<id>/<index>.png`，`JobStore` 存元数据。
2. `GET /artifact`：单段 Range、ETag、TTL 清理；下载失败可续传。
3. `GET /events`：SSE；`job` 进度包含 `step/steps`；`log` 复用日志环；`state` 在 phase 变化时推送。
4. **步数回调**：在 `worker/inference` 的 `run_task` 里接 diffusers 的 `callback_on_step_end`（或管线等价钩子），把 step 写入 `JobStore`；按 1 秒节流，避免每步都抢锁。
5. `capabilities` 写入 `/health`；旧 Host 不读也不影响。

### 6.2 Host 侧

1. 新增 `server/net-stream.js`：`httpStream(ctx, url, { headers, destPath, timeoutMs, signal })`，边下边算 sha256，支持 Range 续传；不要用 `httpText` 读大文件（它会 `maxBytes` 截断并整体解码）。
2. `server/remote.js` 增加 `downloadArtifact()`；`waitForJob` 在 `done` 后按 `results[].index` 下载。
3. `server/jobs/queue.js`：binary 模式下先下载到临时目录，再交给 `saveJobOutput`；单张失败不影响同批其它张，最终 `job.error` 汇总。
4. `server/output.js`：`saveJobOutput` 支持 `result.tempPath`（移动/复制 + PNG 元数据写入），保留现有 `image_b64` 路径作为兼容分支。
5. `server/remote.js` 增加 `openEvents()`（fetch 流解析 SSE）；`JobQueue` 在任务运行期间订阅，把 `step/steps` 写入 `job.progress`；断流回退轮询，终态仍以 `/job` 为准。
6. UI：任务卡进度条显示「12/28 步」；无需新路由，沿用 `/api/state` 的 `jobs[].progress`。

### 6.3 兼容与验收

| Host | Worker | 行为 |
| :--- | :--- | :--- |
| 0.15（v1） | daemon v1 | inline，现状 |
| 0.16（v2） | daemon v1 | 自动回退 inline，不订阅 SSE |
| 0.16（v2） | daemon v2 | binary + SSE |
| 0.16（v2） | private worker v2 | binary + SSE |
| 0.15（v1） | private worker v2 | 不支持（客户端没有该 provider），明确提示升级 |

- [ ] `gpu-live.mjs` 增加 `--binary`，与 inline 对比产物字节一致、峰值内存下降。
- [ ] 隧道抖动时产物下载可续传；断流后任务仍能完成。
- [ ] 旧 Host 对新 daemon 的回归通过（inline 字段不变）。
- [ ] `check-contract`、worker 单测、Kaggle 真机回归全绿。

---

## 7. M3.3：MCP Server

> **状态（2026-11-22）**：已落地。`shared/tool-specs.js` 单源、`server/runtime-file.js` 发现文件、`mcp/server.mjs`（stdio + 7 工具 + `--print-config`）；`test/tool-specs.mjs` 5 项、`test/mcp-server.mjs` 9 项。

### 7.1 进程模型与发现

- `mcp/server.mjs` 是独立 stdio 进程；由外部宿主（Claude Desktop / Cursor / DSH）拉起，不随 Electron 启动。
- 本地服务在启动成功后写 `<dataDir>/runtime.json`（原子写、0600）：
  ```json
  { "schema": 1, "pid": 12345, "port": 54321, "origin": "http://127.0.0.1:54321",
    "token": "…", "version": "0.17.0", "protocol": "2.0.0",
    "workspace": "D:\\AI\\demo", "startedAt": "2026-11-22T..." }
  ```
- MCP 读取顺序：`--runtime <path>` → `AIGC_STUDIO_RUNTIME` → 默认 `dataDir/runtime.json`；校验 `origin` 必须是回环、`pid` 存活、`schema` 匹配；不满足就给「请先启动 AIGC Studio」的可读错误。
- 服务正常退出时删除 `runtime.json`；崩溃残留由 `pid` 存活检查识别为 stale，不自动删除（避免误删正在启动的新实例文件）。
- MCP 不缓存 Token 到磁盘；只在进程内存中使用，不打印。

### 7.2 工具映射

为避免复制一份工具描述，先把 `server/tools.js` 里的「名称 + 描述 + JSON Schema」抽到 `shared/tool-specs.js`（纯数据，无 Node 依赖）；`server/tools.js` 继续附加 `execute`，MCP 只读规格。

| MCP 工具 | 本地 API 映射 | 说明 |
| :--- | :--- | :--- |
| `imagen_generate` | `POST /api/generate` → 轮询 `GET /api/job?id=` | `waitSeconds` 默认 60、上限 300；超时返回 jobId，不取消 |
| `imagen_batch` | 逐条 `POST /api/generate` | 共享总预算；单条失败隔离 |
| `imagen_upscale` | `POST /api/generate` `{tool:'upscale'}` → 轮询 | 源图必须在工作区 `outputs/` 内 |
| `imagen_history` | `GET /api/history?limit=` | 返回路径、提示词、尺寸 |
| `imagen_cancel` | `POST /api/job/cancel` | 排队/运行中两种语义与 UI 一致 |
| `imagen_session` | `GET /api/state`、`POST /api/session/start|stop` | `action: start|stop|status` |
| `imagen_recipes` | 本地 `shared/recipes.js` | 纯函数，不请求服务 |

- 返回值默认 `content: [{type:'text', text}]`，文本里给工作区相对路径与可读摘要；可选参数 `includeImage=true` 时追加 `{type:'image', data:<base64>, mimeType:'image/png'}`，默认关闭，避免几 MB 的图卡住客户端。
- 错误映射：HTTP 401 → `worker_unauthorized`；404 → `not_found`；400 → 把服务端 `message` 原样返回；超时 → `timeout`。不要把内部堆栈返回给模型。

### 7.3 安全

- 只连 `127.0.0.1`/`::1`；`runtime.json` 里的 `origin` 不是回环直接拒绝。
- Bearer Token 只放请求头；不写日志、不进错误文本、不进 MCP 返回值。
- 工具参数由本地服务再次校验（路径逃逸、体积、模型能力），MCP 不做「信任转发」。
- stdio 协议通道不能有噪声：`console.log` 一律禁用，日志走 stderr 或文件；启动失败也只写 stderr。

### 7.4 打包与文档

- `package.json` 增加 `@modelcontextprotocol/sdk` 运行时依赖；`electron-builder.yml` 的 `files` 加入 `mcp/**`（阶段 A 已提前加入，这里验证产物里确实有）。
- `mcp/server.mjs --print-config` 输出 Claude Desktop / Cursor 可粘贴的 JSON（含 `command: node`、`args: [<安装目录>/resources/app/mcp/server.mjs]`、`env.AIGC_STUDIO_DATA_DIR`）。
- `mcp/README.md` 重写：前置条件（Node ≥ 20）、启动顺序（先开应用再开 MCP）、常见错误（runtime.json 不存在/过期、401、端口变了）、安全边界。
- 可选增强：为没有 Node 的用户提供 `mcp/launch.cmd`，用 Electron 的 `ELECTRON_RUN_AS_NODE=1` 运行同一脚本；不把 Node 运行时打进安装包（体积与升级复杂度不划算）。

### 7.5 测试与验收

- `test/mcp-server.mjs`：spawn stdio，发 `initialize` → `tools/list`（7 个）→ `tools/call imagen_recipes` → `tools/call imagen_history`（对 mock 服务）；断言 stdout 只有 JSON-RPC，没有日志。
- `test/tool-specs.mjs`：`shared/tool-specs.js` 与 `server/tools.js` 注册的工具名称/参数 schema 完全一致（防两套真相）。
- 打包冒烟：`npm run test:packaged` 增加「安装目录存在 `resources/app/mcp/server.mjs`」；`node mcp/server.mjs --print-config` 可执行。
- 人工：Claude Desktop / Cursor 各接一次，完成「列出工具 → 生成一张图 → 查历史 → 取消任务」。

**验收**：

- [ ] 应用未启动时，MCP 给出「请先启动 AIGC Studio」，不崩溃、不重试风暴。
- [ ] 应用启动后，外部客户端能列出 7 个工具并成功生成/查询/取消。
- [ ] MCP 进程退出不影响应用；应用退出后 MCP 的下一次调用报可读错误。
- [ ] `runtime.json` 权限 0600；Token 不出现在任何日志。

---

## 8. M3.4：本机 GPU（可选，不阻塞 M3）

> 只有在有真实本机硬件可验收、且远程 Worker 已稳定后才启动。目标是「自己的显卡（含 N 卡 CUDA 与 AMD/Intel Vulkan 核显）也能像私有 Worker 一样用」，不是做通用 AI 运行时管理器。
> **2026-11-23 增补**：针对无 NVIDIA 独显但具备现代核显/统一内存的 Windows 机器（如本机实测的 AMD Ryzen AI 9 H 365 + Radeon 880M），新增 **Vulkan（`stable-diffusion.cpp`）轻量双后端路线与资源平缓方案**，详见 [`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)（独立 D 盘基线验收通过后再合入 Host）。

### 8.1 任务

1. **探测**（`server/local-gpu/probe.js`）：`nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version,compute_cap --format=csv,noheader,nounits` 结合本机系统内存（`os.totalmem()` / 空闲内存）；Windows 下优先 `C:\Windows\System32\nvidia-smi.exe`，失败再查 PATH；解析型号/显存/剩余显存/驱动/架构代际；无 N 卡返回 `gpu_unavailable`。
2. **运行时**（`server/local-gpu/runtime.js`）：
   - 检测 `uv`（`uv --version`），没有则给安装指引，不静默下载二进制；
   - 环境目录 `%APPDATA%/aigc-studio/runtimes/gpu-<driver-major>/`；
   - `uv venv` + `uv pip install -r worker/requirements-gpu.txt`（torch 索引按平台/驱动选择，允许用户覆盖）；
   - 安装前检查磁盘空间（至少 15 GB），展示下载体积与进度；失败保留日志，不留下半套环境。
3. **进程托管**（`server/local-gpu/process.js`）：`spawn(python, ['worker/worker_server.py', '--host','127.0.0.1','--port','0','--token-file',...])`，解析 stdout ready 行；崩溃最多重启 2 次；应用退出时先 `/shutdown` 再杀进程树；日志进 `logs/local-gpu.log`。
4. **Provider**：`local-gpu` 复用 `private-worker` 的连接逻辑，增加 `owned:true` 的启动/停止/清理；`teardown` 真正停进程；`cleanupPending` 按 pid 清理。
5. **UI**：设置抽屉「本机 GPU」显示探测结果、环境状态、安装/启动/停止、磁盘占用、日志入口；首次使用给三步向导（探测 → 安装环境 → 启动）。模型选择区展示基于本机硬件的「流畅 / 省显存可跑 / 吃紧」预测标签（见 §8.2）。
6. **安全**：只绑 `127.0.0.1`；每次启动随机 Token；不执行用户输入的 shell；环境变量白名单；不使用管理员权限。

### 8.2 端侧硬件兼容性预测（不能直接照搬云端 `peakVramMb`）

不能只拿云端无头 Linux 的单个 `measured.peakVramMb` 来判定消费级电脑能否运行，原因有三点：
- **桌面占用与共享显存陷阱**：Windows DWM/浏览器/Electron 会常驻占用 **1.0~1.5 GB VRAM**；而且 Windows 爆显存不会立刻 OOM，而是静默溢出到系统共享内存导致速度暴跌 10 倍；
- **系统内存（RAM）瓶颈**：本仓多个模型带超大文本编码器（`flux2-klein-9b` 的 Qwen3-8B FP16 约 15.26 GB、`qwen-image-2.1` 带 Qwen3-VL-8B、`z-image-turbo` 带 Qwen3-4B）。一旦开启 CPU Offload，16 GB 系统内存机器会先于显存崩溃；
- **架构精度差异**：RTX 30/40/50 系（Ampere+）支持原生 `bf16`；GTX 10/16 系等老卡仅支持 `fp16/fp32`（部分现代 DiT 在纯 `fp16` 下易溢出出黑图）。

**预测模型设计**：
1. **模型运行档案（`models/*.json` 扩展可选 `localProfiles`）**：按运行策略分档标注需求，而不是单一阈值：
   - `standard`（全驻 VRAM / BF16-FP16，全速）：`minVramGb` + `minRamGb`（如 `sdxl-lightning` 约 12 GB VRAM；`qwen-image-2.1` / `flux2-klein-9b` 约 20~24 GB VRAM）；
   - `lowVram`（`group_offload` / `enable_model_cpu_offload` + `vaeTiling`）：显存需求降至 **6~10 GB**，但要求 `minRamGb >= 32`；
   - `quantized`（双端量化：Transformer + Text Encoder 共同压到 4~8 bit，如 FP8/INT8/SVDQuant/GGUF）：可将 4B~9B DiT 压进 **8~12 GB** 消费卡全驻或半驻运行。
2. **三色预测与自动策略匹配**（仅提示、不硬封杀）：
   - 扣除桌面安全余量（Windows 预留 `1.5 GB`，Linux 桌面预留 `0.5 GB`）后对比档案：
     - **🟢 流畅（原生全速）**：剩余显存 ≥ `standard.minVramGb` 且 RAM 达标；
     - **🟡 可运行（省显存策略，耗时增加）**：命中 `lowVram` 或 `quantized` 档，自动勾选推荐加速/卸载参数并提示预期变慢；
     - **🔴 吃紧 / 极易卡顿（不推荐）**：连最低档都不满足或 RAM 不足，提示 OOM/共享显存龟速风险，并给出「改用云端 / AutoDL 算力」快捷引导。
3. **Trace 飞轮持续校准**：由 [`AUTODL_WORKER_RESEARCH.md`](AUTODL_WORKER_RESEARCH.md) §6 的 `runs.jsonl` 账本收集真实 `(gpuName, os, vramMb, profile, peakVramMb, steadySeconds, status)` 数据，随使用积累将经验估值逐步替换为同卡型实测通过率。

### 8.3 端侧 SOTA 部署与加速方案清单（结合本仓 7 模型特征，2026 基线）

本仓当前 7 个模型有两个鲜明特征：**① 全是 2~10 步少步蒸馏/Turbo 模型**（`sana-sprint-1.6b` 2 步、`sdxl-lightning`/`flux2-klein-4b/9b` 4 步、`qwen-image-2.1` 8 步、`z-image-turbo` 9 步、`anima-turbo-v1.1` 10 步）；**② 现代 DiT 的显存大头在 Text Encoder（2B~8B）而非仅 DiT 本体**。端侧选型必须贴合这两个事实（并遵循 [`INFERENCE_ACCELERATION_RESEARCH.md`](INFERENCE_ACCELERATION_RESEARCH.md) 的同 Seed 真机对照原则）：

| 梯队 | 方案 / 技术 | 适用模型与硬件 | 核心收益与代价 | Windows 兼容性与引入顺序 |
| :--- | :--- | :--- | :--- | :--- |
| **第一梯队**（零编译、稳态基础） | **`uv` 隔离环境 + PyTorch 原生 SDPA + `vae_tiling`** | 全模型；所有 CUDA GPU | 环境构建提速数倍；高分辨率（`1536×864` / 放大）防瞬间爆显存 | **Windows 原生无痛**；M3.4 首期必选底座 |
| **第一梯队**（消费卡救星） | **`diffusers` `Group Offloading`（`group_offload`）与 `enable_model_cpu_offload`** | `flux2-klein-4b/9b`、`qwen-image-2.1`、`z-image-turbo`、`anima-turbo-v1.1`（8~16 GB 显存卡） | 按层组流式调度（`group_offload` 比 `sequential_cpu_offload` 快得多），让 8~12 GB 卡跑起大模型；需较大系统内存（建议 ≥ 32 GB） | **纯 Python / diffusers 原生**，零编译；作为 `lowVram` 档首推策略 |
| **第一梯队**（轻量显存减半） | **Diffusers `Layerwise Casting`（FP8 存储 + 动态 BF16/FP16 计算）** | `sm_80+`（RTX 30/40/50 系）上的 DiT 与大 Text Encoder | 权重按 FP8 驻留显存（约省 50% VRAM），前向计算动态转回 BF16/FP16；兼容老卡不要求原生 FP8 Tensor Core | **PyTorch / diffusers 原生支持**，无需额外编译包；需实测画质 MAE |
| **第二梯队**（双组件量化提速） | **全管线量化：`TorchAO` / `Quanto` / `SDNQ` / `GGUF`（Transformer + Text Encoder 联合量化）** | `flux2-klein-9b`、`qwen-image-2.1`、`z-image-turbo`（12~16 GB 消费卡） | 注意 [`INFERENCE_ACCELERATION_RESEARCH.md` §4.4.3](INFERENCE_ACCELERATION_RESEARCH.md#443-colab-l4-torchao-fp8-评估不做运行时改造) 已实测「**只量化 Transformer 不量化 8B Text Encoder 仍放不下**」；端侧必须对 Text Encoder 与 DiT **联合 8-bit/4-bit 量化**才能真正免 Offload 提速 | `TorchAO` / `SDNQ` 支持纯 pip；4-bit/GGUF 需核对各 loader 兼容与画质损失，二期按模型逐个验证 |
| **第二梯队**（长驻内核 SOTA） | **`SageAttention` / `SageAttention2` + `Nunchaku`（SVDQuant 4-bit）** | `flux2` / `qwen` / `z-image` 等长序列 DiT；RTX 30/40/50 系 | `SageAttention2`（INT8/FP8 注意力核）在 Ada/Ampere 上通常提速 1.5×~2.5×；`Nunchaku` 针对 4-bit FLUX 类模型在 4090/消费卡上避免 Offload 实现数倍提速 | Windows 上常依赖预编译 CUDA wheel 或特定 torch 版本，安装脆弱；作为**可选进阶加速包**（检测存在才启用，不进硬依赖） |
| **长驻专属**（有条件启用） | **`torch.compile(mode="reduce-overhead")`** | 长驻本地/私有 Linux GPU（单次开机连续出图 ≥ 10 张） | Linux 上稳态提速明显；但首次编译耗时 **40~120 秒**，且 Windows 上 Triton 兼容性较差 | **禁止默认开启**；仅在长驻 Worker 显式开关 + 用户确认长会话场景时按需开放 |
| **明确避雷**（本模型库不适用） | **`TeaCache` / `First-Block Cache (FBCache)` / `sequential_cpu_offload` / `TAESD`** | — | 本仓 7 模型全为 **2~10 步蒸馏模型**，步数过少强跳步会糊图/飘构图（且 §4.4.2 已实测 `Flux2` 双栈不兼容 `firstBlock`）；`sequential` 慢至分钟级；`TAESD` 损锐度 | 不合入；仅未来若引入 25~30 步常规基座模型时再评估 `TeaCache` / `FBCache` |

### 8.4 验收

- [ ] Windows 11 + RTX 3060 12GB（或同级 CUDA 卡）或 AMD Radeon 880M（Vulkan + GGUF 路线，见 [`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)）能跑通 `sdxl-lightning` 1024²；首张冷启动、稳态耗时与内存/显存峰值有记录。
- [ ] 能正确探测并展示本机 GPU（`nvidia-smi` 或 `vulkaninfo`）/ 剩余显存 / 系统 RAM，并对 7 个模型给出符合实际的「流畅 / 省显存 / 吃紧」三色预测与策略提示。
- [ ] 应用退出后本机 Worker 进程不残留；异常崩溃后最多重启 2 次并给出日志。
- [ ] 环境安装失败/磁盘不足/驱动过旧都有可读提示，不破坏用户全局 Python。
- [ ] 与远程 Worker 切换不需要重启应用。

> 若在 M3 周期内未完成本机真机基准验收，M3.4 保持「设计就绪、代码未实现」，不把 M3 整体标记为未完成。

---

## 9. 兼容与迁移

| 对象 | 迁移策略 |
| :--- | :--- |
| `session.json` | Notebook 仍写 v1；Worker 写 v2。新客户端读 v1/v2；旧客户端读到 v2 安全拒绝（它本来也不支持 Worker），不会误连 Kaggle |
| `settings.json` | `provider` 白名单扩容；旧客户端读到 `private-worker` 回退 `kaggle` 并提示；不升级 schema 版本，避免无意义迁移 |
| `app-config.json` | 新增 `compute.privateWorker` 与 `credentials/workers.json`；Token 加密存储，API 只回 `tokenConfigured` |
| `contract` / `contract.json` | `version` 语义改为协议版本；`APP_VERSION` 单独校验；`tools/gen-contract-json.mjs --check` 防漂移 |
| `models/*.json` | M3.1 给大模型补 `private-worker` 来源；M3.2 再引入 `minVramGb` 等需求位，平台名逐步退化为别名 |
| MCP | `runtime.json schema=1`；后续字段只增不改；客户端不认识的字段忽略 |

**降级风险**：0.16 写入的 Worker 设置/记录被 0.15 读到会回退 Kaggle 或拒绝记录；这是可接受的，因为 0.15 没有 Worker 功能。文档要提示「降级前先断开私有 Worker」。

---

## 10. 测试矩阵

| 层级 | 覆盖 | 命令 |
| :--- | :--- | :--- |
| 契约 | 路由/错误码/协议版本/`contract.json`/工具规格单源 | `npm run test:contract` |
| Host 离线 | provider 注册表、会话记录 v1/v2、binary 下载、SSE 解析、MCP HTTP 适配 | `npm run test:host` |
| Python | `worker_server` 路由、鉴权、artifact Range、SSE、协议不匹配、任务执行 | `python test/worker/run.py` |
| 客户端 | 设置字段切换、顶栏来源状态、进度步数、错误文案、词典同构 | `npm run test:client` |
| Mock 集成 | Node mock worker 全链路（health→generate→artifact→events） | `npm run test:host` 新增用例 |
| 真机（云端） | Kaggle v2 inline/binary 回归、断流续传 | `node test/gpu-live.mjs --binary` |
| 真机（私有） | Docker CPU mock → Linux GPU 四项工具 | `worker/deploy/` + 手动清单 |
| MCP | stdio JSON-RPC、7 工具、错误映射、打包路径 | `node test/mcp-server.mjs` |
| 升级 | 0.15 ↔ 0.16 设置/记录/协议兼容 | 手动 |

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
| :--- | :--- | :--- |
| Provider 注册表重构碰坏 Kaggle/Colab | 现有主链路回归 | M3.0 单独合并；先加 fake worker 测试；session 全套件必须绿；不做「顺手重构」 |
| 协议 v2 与旧 daemon 不兼容 | 云端出图失败 | 缺省 inline；能力协商；旧 Host 回归用例；M3.2 单独灰度 |
| 私有 Worker Token 泄漏 | 任意人可出图/耗显存 | Token 加密存储、请求头传输、日志脱敏、非回环强制 HTTPS、文档给 SSH 隧道方案 |
| SSE 被反代缓冲 | 进度不更新 | `x-accel-buffering: no`、心跳、Host 回退轮询；不把 SSE 当唯一完成信号 |
| 二进制产物下载中断 | 任务白跑 | 单段 Range 续传 + sha256 + TTL；失败只影响单张 |
| MCP stdout 被日志污染 | 客户端解析失败 | 禁用 console.log；测试断言 stdout 只有 JSON-RPC；启动失败写 stderr |
| `mcp/` 未打进安装包 | 功能不可用 | `files` 加 `mcp/**`；打包冒烟检查文件；`--print-config` 实测 |
| 本机 GPU 环境安装失败/污染全局 | 用户机器受损 | 独立 `uv` 环境、磁盘检查、失败回滚、不使用管理员权限；M3.4 可选 |
| 模型显存不匹配 | OOM/差体验 | 先给可读错误；M3.2 再做 `minVramGb` 能力过滤；不虚标「支持」 |
| 共享 Worker 被误关机 | 影响其他使用者 | `teardown` 默认只断开；`/shutdown` 默认关闭，仅本机托管打开 |

---

## 12. 实施顺序与提交切分

1. **M3.0-a 版本分离**：`shared/contract.js`、`provisioner.js`、`daemon.py`、`contract.json`、`check-contract`、`kernel-package`。
2. **M3.0-b Provider 注册表**：`server/providers/index.js`、`session.js` 去硬编码、`persistence.js` v2、fake worker、session 套件。
3. **M3.0-c 设置/模型能力域**：`SETTINGS.providers`、`models-guide`、`settings.js`、Agent prompt 来源文案。
4. **M3.1-a Worker 服务**：抽 `worker/runtime.py`、`worker_server.py`、HTTP 参数化、`/artifact`、`/events`、Docker 部署文件。
5. **M3.1-b Host Provider**：`private-worker.js`、凭据、`/api/worker/probe`、设置抽屉、顶栏状态。
6. **M3.1-c 真机验收**：Docker CPU mock → Linux GPU 四项工具 → 故障注入。**2026-11-22**：`worker/deploy/start-container.sh` 与 `--prepare-only/--preload-json` 已就绪；实名认证后曾创建 AutoDL `v-48g` 实例，因单价 ¥30.30/小时 + 基础镜像 Python 3.8 不兼容，68 分钟消耗 ¥35.5、0 产出，已关机止损并**冻结 AutoDL 接入**（详见 [`AUTODL_WORKER_RESEARCH.md`](AUTODL_WORKER_RESEARCH.md) §8/§9）；后续转向 RunPod / Vast.ai 容器方案，基线与阶段 0–3 验收计划见 [`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)（已确认，待阶段 0）。
7. **M3.2-a daemon v2**：`result_mode`、artifact、SSE、步数回调。
8. **M3.2-b Host binary/SSE**：`net-stream.js`、`downloadArtifact`、queue/output 改造、进度 UI。
9. **M3.2-c 云端回归**：Kaggle inline/binary、断流续传、旧 Host 兼容。
10. **M3.3-a 工具规格抽取**：`shared/tool-specs.js`、`server/tools.js` 适配、测试。
11. **M3.3-b MCP**：`runtime.json`、`mcp/server.mjs`、打包、文档、stdio 测试。
12. **M3.4（可选）**：探测、uv 环境、进程托管、本机 provider、UI。

每个提交都应满足：`npm run test:contract` + 相关分组绿；涉及协议时 `python test/worker/run.py` 绿；涉及 UI 时 `check-client-locale` 同构。

---

## 13. 最终验收清单

- [ ] **底座**：产品版本与协议版本分离；Provider 注册表可用；Kaggle/Colab 零回归；记录 v1/v2 兼容。
- [ ] **私有 Worker**：Docker 一条命令启动；设置页测试连接；生成/放大/参考/重绘通过；断开与重连正确；Token 不泄漏。
- [ ] **协议 v2**：binary 产物与 inline 字节一致；SSE 步数可见；断流可续传；旧 Host/旧 Worker 兼容。
- [ ] **MCP**：外部客户端可列工具、生成、查历史、取消；stdout 干净；打包产物含 `mcp/server.mjs`。
- [ ] **本机 GPU（可选）**：探测/安装/启动/停止/清理闭环；不污染全局环境。
- [ ] **文档**：`ROADMAP.md`、`AUTO_UPDATE_PLAN.md`、`MIGRATION_NOTES.md`、`mcp/README.md`、`worker/deploy/README.md` 与实现一致；旧文档中的「Phase 2 占位/未实现」表述全部更新。
