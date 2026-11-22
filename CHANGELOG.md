# 更新日志 (CHANGELOG)

## Unreleased（M3.2 云端协议 v2 / M3.3 MCP，2026-11-22）

### M3.2 云端协议 v2（Host + Worker 步数）

- **二进制产物通道**：新增 [`server/net-stream.js`](server/net-stream.js)（流式写盘 + 边下边算 sha256 + 单段 Range 续传，fetch 失败降级 curl）；`server/remote.js` 新增 `downloadArtifact()` 与 `openEvents()`（SSE 解析、`Last-Event-ID`、断流不影响任务）。
- **能力协商**：`JobQueue` 用 `provider.binary/events` + `/health.capabilities` 双重确认；只有远端真的声明 `result_modes` 含 `binary` 才下发 `result_mode=binary`，旧 daemon / 旧 Worker 自动回退 inline，行为与 0.15 一致。Kaggle/Colab 的能力位同步打开（仍以远端自报为准）。
- **产物落盘**：`saveJobOutput` 支持 `result.tempPath`（binary 下载到 `%TEMP%/aigc-studio/artifacts/<jobId>/`），哈希不一致删除半截文件并重试；单张失败重试 2 次后报 `artifact_failed`（Host 按单张拆分远端 job，失败会明确报出而不是静默丢图），任务收尾统一清理临时目录。
- **扩散步数**：`Job` / `JobStore` 增加 `step/steps`，`/job` 与 `/events` 的 `progress` 同步下发；`worker/daemon.py` 按 pipeline `__call__` 签名注入 `callback_on_step_end`（旧管线回退 `callback`），1 秒节流、每张开始归零。
- **UI**：任务卡 / 进度胶囊显示「正在生成第 x/y 张 · 12/28 步」，超分等无步数任务保持原文案。
- **轮询兜底**：Host 的 `onProgress` 同时读取 `/job` 的 `progress.step/steps`，即使 SSE 被代理 100 秒超时切断（RunPod HTTP proxy）也能显示步数。
- **容器入口**：新增 `worker/deploy/docker-entrypoint.sh`，支持 `AIGC_WORKER_TOKEN` 环境变量与 `HF_HOME` 不可写时回退 `/tmp/hf`，便于 RunPod / Vast 直接跑镜像；选型见 `docs/GPU_PROVIDER_COMPARISON.md`。
- **测试**：新增 [`test/remote-v2.mjs`](test/remote-v2.mjs) 8 项（完整下载 / 206 续传 / 416 重下 / 哈希校验 / SSE 解析 / binary 落盘 / inline 兼容）；Python 全套 549 项通过（新增步数进度 3 项）。

### M3.3 MCP Server

- **工具规格单源**：新增 [`shared/tool-specs.js`](shared/tool-specs.js)（名称 / 描述 / JSON Schema，纯数据）；`server/tools.js` 只按名称取规格并附加 `execute`，不再维护第二份描述。
- **发现文件**：新增 [`server/runtime-file.js`](server/runtime-file.js)；`server/standalone.js` 监听成功后原子写 `<dataDir>/runtime.json`（0600，含 `pid/port/origin/token/version/protocol/workspace`），正常退出删除（Windows 硬杀残留由 MCP 的 pid 存活检查识别）。
- **MCP 入口**：[`mcp/server.mjs`](mcp/server.mjs) 使用 `@modelcontextprotocol/sdk` 的 stdio 传输，7 个 `imagen_*` 工具映射本地 `/api/*`；只连回环、每次调用重读 runtime.json、Token 只放请求头、stdout 只有 JSON-RPC；`--print-config` 输出 Claude Desktop / Cursor 配置。
- **打包**：`electron-builder.yml` 的 `files` 已含 `mcp/**` 与 `shared/**`；`test:packaged` 增加 `mcp/server.mjs` 与 `shared/tool-specs.js` 存在性检查。
- **测试**：新增 [`test/mcp-server.mjs`](test/mcp-server.mjs) 9 项（initialize / tools/list / 生成 / 历史 / 取消 / stdout 纯净 / runtime 缺失）与 [`test/tool-specs.mjs`](test/tool-specs.mjs) 5 项（规格与注册面逐字一致）。

### M3.1-c 真机部署（AutoDL）

- 新增 [`worker/deploy/start-container.sh`](worker/deploy/start-container.sh)：自动选数据盘（`/root/autodl-tmp` → `/workspace` → 当前目录）、复用/生成 0600 Token、预装 torch 时只增量装 diffusers、后台启动并等待 `/healthz`。
- `worker/worker_server.py` 新增 `--prepare-only` 与 `--preload-json`：无卡模式只装依赖 + 按白名单预拉权重，不启动 HTTP、不检查 CUDA。
- **状态（已冻结）**：AutoDL 实名后创建 `v-48g` 实例实测，因基础镜像 Python 3.8 不兼容及 `v-48g` 单价过高，68 分钟 0 产出后已关机止损并冻结 AutoDL 接入（见 [`docs/AUTODL_WORKER_RESEARCH.md`](docs/AUTODL_WORKER_RESEARCH.md) §7/§9），转向 RunPod / Vast.ai 容器方案（见 [`docs/GPU_RUNTIME_BASELINE_PLAN.md`](docs/GPU_RUNTIME_BASELINE_PLAN.md)）。

## Unreleased（M3.0 底座 / M3.1-a 私有 Worker 服务，2026-11-22）

- **产品版本与协议版本分离**：`shared/contract.js` 新增 `APP_VERSION`（`0.15.0`，与 `package.json` 一致）与 `PROTOCOL_VERSION`（`2.0.0`）；`daemonContract().version`、注入配置版本、`worker/daemon.py`、`worker/contract.json`、`test/mock-daemon.py`、`test/tunnel-probe.py` 统一为协议版本。客户端小版本升级不再要求远端 daemon / 私有 Worker 同步重装。
- **算力来源注册表**：新增契约 `PROVIDERS` 能力位（`kind` / `reattach` / `pendingCleanup` / `remoteShutdown` / `idleTimeout` / `logs` / `binary` / `events` / `owned`）与 `server/providers/index.js`；`server/session.js` 不再写死 `kaggle/colab`，长驻 Worker 走「连接 + 协议校验 + 健康轮询」，跳过 Kernel 目录、ntfy 会合与空闲关机。
- **会话记录 v1/v2**：Kaggle/Colab 仍写 v1；Worker 写 v2（`provider/endpointUrl/token/handle`），新客户端同时读取，v2 未知来源安全拒绝；恢复按记录来源切换 provider，Worker 不可达写入 `worker_unreachable` 并保留记录。
- **设置与模型能力域**：`SETTINGS.providers` 只含当前可选项（仍为 Kaggle/Colab），模型能力判定与展示名改用全部已知来源；Agent 工具与提示词里的「Kaggle GPU / Kernel」改为「当前算力来源 / 会话」；新增 5 个 Worker 错误码与双语文案。
- **测试**：新增 `test/session-worker.mjs`（注册表、记录 v2、fake worker 的 start/stop/restore、协议不匹配、token 不泄漏）；`npm run test:contract` 15/15、`test:client` 19/19 步、`test:host` 30/30 步、`test:worker` 528 项全部通过。

### M3.1-a 私有 Worker 服务（Host 接入待续）

- **常驻入口**：`worker/worker_server.py` 可运行（默认 `127.0.0.1:8765`、Bearer 鉴权、`--token-file`/`AIGC_WORKER_TOKEN`、SIGTERM 优雅退出、stdout 只输出一行 ready JSON）；运行时启动抽到 `worker/runtime.py`，与 Kaggle/Colab daemon 共用 GPU 探测 / 依赖 / 预加载逻辑。
- **协议 v2 端点**：`/healthz`（免鉴权存活探针）、`/artifact`（单段 Range + ETag + sha256，`result_mode=binary` 时 PNG 落盘）、`/events`（SSE、15 秒心跳、`Last-Event-ID` 重放 200 条、并发 4 条）；`/health` 增加 `protocol_version / capabilities / hardware`；`/shutdown` 默认 403，仅 `--allow-shutdown` 生效。
- **产物生命周期**：binary 结果写入临时目录，`results[]` 只带元数据；任务淘汰与进程退出清理；同机多 Worker 只清自己的目录。
- **部署**：`worker/deploy/Dockerfile`、`docker-compose.yml`（`--gpus all`、模型缓存卷、healthcheck）、systemd 单元、SSH 隧道 / Caddy TLS 文档；`worker/requirements-gpu.txt`。
- **测试**：新增 `test/worker/test_protocol_v2.py` 18 项（产物落盘/Range/416/304、事件重放/上限、`/healthz`、关机闸门、`result_mode` 校验）；Python 全套 546 项通过。

## 0.15.0 (2026-11-22)

首个独立桌面端发布候选版本，包含完整的本地工作台、多后端云端 GPU 调度、创作助手与自动更新链路：

- **独立桌面客户端（M1 / M1.5 / M2）**：脱离 DSH 宿主的 Electron 桌面端，支持多工作区切换、`safeStorage` + AES-256-GCM 凭据加密、系统托盘防烧额度保护、后台完成桌面通知与任务栏角标。
- **云端 GPU 与多模型生态**：支持 Kaggle（CLI / 内置 OAuth）与 Google Colab 双后端；覆盖 `SDXL-Lightning`、`SANA-Sprint 1.6B`、`Z-Image-Turbo`、`Qwen-Image 2.1`、`FLUX.2 Klein 4B/9B`、`Anima Turbo v1.1` 等 7 套模型，支持文生图、局部重绘、高清放大、扩图（LoRA）与多图参考生成。
- **创作助手单轨化与智能调度（M2.5 / M2.6 / M2.7）**：接入 `pi-ai` / `pi-agent-core`，支持 11 家 LLM 服务商与模型自动拉取、共用参考图条、跨后端「切换并生成」一步到位、导入裸图焦点隔离锁定，以及按工作区隔离的对话持久化。
- **发布通道与应用内更新（M2.8）**：接入 GitHub Releases 自动化构建与产物校验（`latest.yml` + `.blockmap` + `SHA256SUMS.txt`），支持 NSIS 差分更新、活跃会话/任务安装防烧额度护栏、自定义 `https://` 镜像源，以及便携版/开发态只读降级提示。
