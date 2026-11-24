# AIGC Studio v0.16.0 发布说明与社区首发包（GTM Launch Pack）

> 用途：供推送 `v0.16.0` Tag、发布 GitHub Release 及同步多社区首发时直接复用。文中所有耗时、显存、分辨率与功能口径均严格对齐代码与真机实测记录。

---

## 一、发版与上线执行清单（前置顺序不可倒置）

> 官网所有「下载客户端」按钮均指向 `releases/latest`，因此**公开 GitHub Release 必须先于社区发帖**。

1. **确认工作区收尾**：检查当前未提交代码（如 `WorkshopStage.jsx`、`workshop.css`），跑通离线套件 `npm test`、`npm run contract:check` 与 `site` 构建。
2. **完成 M2 遗留人工验收**（`docs/LIVE_ACCEPTANCE.md` §7）：本地安装版内跑通「唤醒云端 → 出图 → 切工作区」及「活跃会话关窗转托盘 → 托盘彻底退出关机」。
3. **部署官网到 Cloudflare Pages**：
   - Root directory: `site` · Build command: `npm run build` · Output directory: `dist`
   - 环境变量：`NODE_VERSION=22`、`PUBLIC_SITE_URL=https://aigc-studio-8rj.pages.dev`，按需填入 `PUBLIC_CF_BEACON_TOKEN` 与 `PUBLIC_UMAMI_WEBSITE_ID`。
   - 推送本仓库后 Cloudflare Pages 会自动重新构建并同步 `canonical`、`llms.txt` 与 `sitemap-index.xml` 中的域名。
4. **推送 `v0.16.0` Tag 并转正 Draft Release**：
   - `git tag v0.16.0 && git push origin v0.16.0` 触发 `.github/workflows/release.yml`；
   - CI 自动校验版本一致性并生成 Draft Release，检查 5 类资产齐全（`aigc-studio-0.16.0-x64.exe`、`aigc-studio-0.16.0-portable.exe`、`.blockmap`、`latest.yml`、`SHA256SUMS.txt`）；
   - 将上方「二、GitHub Release Notes」粘贴进 Release 正文并 **Publish release**。
5. **按渠道发布冷启动帖**（建议先发 LINUX DO 与 V2EX 收第一批真实用户反馈，再发掘金/知乎与小红书）。

---

## 二、GitHub Release Notes（`v0.16.0` 模板）

> 标题建议：`v0.16.0 — 商业生图/视频 API、6 项本地资产工坊、MCP 与应用内更新`

```markdown
**AIGC Studio v0.16.0** 是首个面向公开社区发布的完整多模态桌面工作台版本：把本地 Electron 工作台、资产管理与云端推理算力彻底解耦，无需本地大显存独显与 ComfyUI 环境，所有作品、参数 `meta.json` 与衍生通道均保存在本地工作区 `outputs/` 目录。

- 项目官网与 7 模型实测对比：https://aigc-studio-8rj.pages.dev
- 完整更新日志：[CHANGELOG.md](https://github.com/nanxfu/aigc-studio/blob/master/CHANGELOG.md)

---

### 核心能力与更新亮点

* **多轨算力自由切换（默认免费云卡 + 商业 API + 私有 Worker）**
  * **Kaggle（默认，¥0） / Google Colab**：默认接入 Kaggle 每周 30 小时免费双卡 T4（30GB 显存），支持 7 款内置开源模型、局部重绘（Inpaint）、×2 高清放大、扩图（Outpaint LoRA）与多图参考。
  * **商业 API（`cloud-api`，0 秒就绪）**：内置硅基流动（SiliconFlow）、fal.ai、OpenAI Images 及自定义 OpenAI 兼容端点；支持文生图及**硅基流动视频生成**（MiniMax H3 5–15 秒文生视频 / 首尾帧图生视频，支持舞台原位抽帧接力）。
  * **私有远端 Worker（协议 v2）**：支持部署到自建 Linux GPU、RunPod 或 Vast.ai（容器镜像 `ghcr.io/nanxfu/aigc-worker:edge`），支持二进制产物断点续传与 SSE 步数进度回传。
* **内置资产工坊（6 项后处理 · 复合资产包）**
  * **4 项纯本机直算（0 GPU、0 Python）**：SVG 矢量转换（`@visioncortex/vtracer` WASM）、像素画网格对齐（Oklab 调色盘量化 + Alpha 硬边）、序列帧切片与 `atlas.json` 导出、2×2 无缝平铺校验与余弦混边。
  * **2 项云端 GPU 算子**：抹除背景（默认 MIT 协议 `BiRefNet` 免登录开箱即用，可选 `RMBG-2.0`）、PBR 材质拆解（`Marigold` Apache-2.0 一次输出 `albedo / normal / roughness / metallic` 四通道）。
  * 支持本地静默场景识别、应用即落盘、版本树血缘继承与整包 ZIP 导出。
* **AI 创作助手、视觉回看与探索抽卡（AG-UI）**
  * 接入 11 家 LLM 服务商（DeepSeek / Kimi / 通义千问 / 硅基流动 / OpenCode Zen / OpenRouter / Gemini / OpenAI / Anthropic / Ollama / 自定义），支持可编辑提案卡跨模型、跨后端一步切换生成。
  * 支持多模态视觉回看（`imagen_inspect`）与硬预算探索抽卡（限制最大轮数与张数，支持并排对比与选图变体回流）。
* **MCP Server 与桌面安全模型**
  * `mcp/server.mjs` 通过 stdio 暴露 7 个 `imagen_*` 工具，可接入 Claude Desktop / Cursor 共享同一份本地工作台状态。
  * 控制面仅监听 `127.0.0.1` + 256-bit 随机 Bearer Token；所有 API Key 与 Worker Token 经 `safeStorage` + AES-256-GCM 加密存储；活跃云端会话关窗自动转系统托盘防烧额度。

---

### 安装包选择（Windows x64）

| 文件名 | 形态 | 适用场景与更新方式 |
| :--- | :--- | :--- |
| `aigc-studio-0.16.0-x64.exe` | **Windows NSIS 安装版（推荐）** | 创建桌面与开始菜单快捷方式；支持应用内检查与一键差分更新（`.blockmap`），带活跃云端会话防烧额度安装护栏。 |
| `aigc-studio-0.16.0-portable.exe` | **免安装便携版** | 单文件直接运行，不写安装注册表；应用内仅提示新版本，需手动下载新版替换。 |

> **macOS / Linux 用户**：首批预编译安装包仅验证 Windows x64，macOS 与 Linux 目前支持通过 Node.js ≥ 20 从源码运行（详见 [README 快速开始](https://github.com/nanxfu/aigc-studio#方式-b从源码运行windows--macos--linux)）。

---

### SHA-256 完整性校验与 SmartScreen 说明

1. **Windows SmartScreen「未知发布者」提示**  
   开源个人项目暂未购买商业代码签名证书，Windows 首次运行安装包或便携版时可能弹出拦截提示。请确认下载自本仓库 GitHub Releases 并核对下方 SHA-256 后，点击 **「更多信息 → 仍要运行」**。
2. **手动校验文件摘要**  
   下载同目录下的 `SHA256SUMS.txt` 后，在 PowerShell 运行：
   ```powershell
   certutil -hashfile .\aigc-studio-0.16.0-x64.exe SHA256
   ```
   核对输出哈希与 `SHA256SUMS.txt` 完全一致即可。

---

### 首次运行与 3 分钟出图指引

1. 启动后点击右上角 **「设置」**，选择本地 **工作区目录**（所有产物将保存在该目录下的 `outputs/`）。
2. **选一种算力即可出图**：
   - **零成本免费 GPU**：在「算力来源」选择 **Kaggle**，使用内置 OAuth 登录（或本机已配置的 `~/.kaggle/kaggle.json`），点击顶部 **「唤醒云端」**，等待约 3~10 分钟冷启动分配双 T4 后即可连续出图。
   - **0 秒直接出图 / 视频**：在「算力来源」选择 **商业 API**（如硅基流动），填入 API Key 无需冷启动即可文生图或生成视频。
3. **（可选）配置 AI 创作助手**：在「设置 → 创作助手」选定服务商（如 DeepSeek / Gemini / 本地 Ollama）并填 Key，即可在右侧用自然语言生成可编辑参数提案卡。
```

---

## 三、分渠道社区首发文案（重实测、无广告腔）

### 渠道 1：LINUX DO（开发调优 / 资源分享向）

**可选标题**：
- `开源了一个本地桌面 AI 生图/视频工作台 AIGC Studio：免买显卡白嫖 Kaggle 双 T4，自带商业 API + 6 项本地资产工坊 + MCP`
- `不想再折腾 ComfyUI 和显存了，用 Electron + Node 搓了一个「界面本地、算力上云」的开源桌面工作台（MIT）`

**正文草稿**：

> 先交底：本项目 MIT 协议完全开源，没有账号墙也没有会员订阅；首批只打出了 Windows x64 安装包/便携版，macOS/Linux 目前需要 Node ≥ 20 源码起。

很多朋友手里是核显轻薄本或小显存电脑，想在本地管理自己的画库和工作流，但又不想本地硬扛 PyTorch / CUDA / ComfyUI 节点报错，也不想用在线网页站被平台锁画廊和按月扣费。

所以写了 **AIGC Studio**：把 **Electron 桌面工作台 + `127.0.0.1` 本地控制面** 留在自己硬盘，把**模型推理按需调度到云端或商业 API**。

#### 1. 算力怎么接（4 条路按需切，不锁死一家）
- **Kaggle 免费双卡（默认）**：利用认证账号每周 30 小时的 `2×Tesla T4 (30GB)` 免费额度。客户端做了一整套防呆：内置 OAuth 登录、临时 Bearer Token 隧道加密回传、30 分钟空闲自动关机，最关键的是**会话活跃时点关闭窗口会缩到系统托盘而不是直接杀进程，防止 Kaggle Kernel 变孤儿空烧额度**。
- **Google Colab**：内置授权直连，T4 / Pro 的 L4、A100 都能跑，用来补 Kaggle 跑不动的大模型（比如 `Qwen-Image 2.1` 和 `FLUX.2 Klein 9B`）。
- **商业 API（0 秒就绪）**：如果临时赶图不想等 3~10 分钟冷启动，切到硅基流动 / fal.ai / OpenAI / 任意 OpenAI 兼容端点，填 Key 按张计费；同时接入了硅基流动视频主链路（MiniMax H3 5–15s 文生/首尾帧视频，舞台支持直接抽首尾帧落盘二次创作）。
- **私有 GPU Worker**：手头有 Linux 卡机或租 RunPod / Vast.ai 的，仓库带现成 Dockerfile（`ghcr.io/nanxfu/aigc-worker:edge`）和协议 v2（binary 分块传输 + SSE 步数回传）。

#### 2. 真机跑了 7 款开源模型（同题盲测数据直接贴出来）
为了避免“各自挑最美的一张宣传”，我们用同一组 9 维英文 Prompt 在真机上跑完了 7 个模型，官网上做了 2.4× 放大镜同题对照：

| 模型 | 稳态出图 | 显存占用 | 协议 / 特点 |
| :--- | :---: | :---: | :--- |
| SANA-Sprint 1.6B | 4.1s (2步) | 10.3 GB | Apache-2.0 · 极速构图试错 |
| SDXL Lightning | 6.2s (4步) | 10.3 GB | OpenRAIL++ · 默认主力，支持局部涂抹重绘 |
| FLUX.2 Klein 4B | 10.2s (4步) | 7.9 GB | Apache-2.0 · 原生中英双语、参考图 + 扩图 LoRA |
| Anima Turbo v1.1 | 21.6s (10步) | 8.5 GB | 非商用 · 二次元标签与赛璐璐光影 |
| Z-Image Turbo | 30.7s (9步) | 12.2 GB | Apache-2.0 · 写实摄影、中文招牌（Colab/私有） |
| Qwen-Image 2.1 | 43.7s (8步) | 16.8 GB | 非商用 · 中文排版、多图参考（Colab/私有） |
| FLUX.2 Klein 9B | 130.9s (4步) | 18.1 GB | 非商用 · 复杂静物与物理材质（Colab/私有） |

#### 3. 几个我自己用下来最刚需的小设计
- **内置 6 项资产工坊（4 项纯本机 0 GPU 跑）**：独立游戏/UI 常要出图后接处理，直接在软件里集成：
  - 本机直算：`@visioncortex/vtracer` WASM 转可编辑 SVG、边缘周期探测 + Oklab 调色盘像素对齐、序列帧切片 + 预览 + `atlas.json`、2×2 无缝平铺余弦混边。
  - 云端 GPU：`BiRefNet`（MIT 免登录 12.1s）或 `RMBG-2.0` 去背、`Marigold` 四通道 PBR 材质拆解（35.2s 出 albedo/normal/roughness/metallic）。
  - 产物全部以复合资产包继承原图版本树，支持一键导出 ZIP。
- **创作助手 + 视觉回看探索**：接了 `pi-ai` / `pi-agent-core`（11 家 LLM 服务商 + 本地 Ollama），先出可编辑提案卡再执行；开启探索模式后，Agent 会自己调用 `imagen_inspect` 看刚生成的图、按构图/畸变/命中率改词重抽，并且受**硬预算（轮数+总张数上限）**锁死防止刷爆余额。
- **标准 MCP Server**：带了 7 个 `imagen_*` stdio 工具，直接挂进 Claude Desktop 或 Cursor，跟桌面端共用同一个 `outputs/` 目录和算力会话。

#### 4. 相关链接 & 当前已知短板
- GitHub（求 Star 和 Issue 反馈）：`https://github.com/nanxfu/aigc-studio`
- 官网 & 7 模型实测放大镜：`https://aigc-studio-8rj.pages.dev`
- Releases 下载（Windows NSIS 安装包 + 便携版，附 `SHA256SUMS.txt`）：`https://github.com/nanxfu/aigc-studio/releases/latest`
- 当前不足：安装包未买代码签名证书（SmartScreen 会提示未知发布者，可核对 SHA256 后运行）；本机 Vulkan 核显推理（M3.4）和 3D 模型生成（M4.4）还在规划中，欢迎各位佬提建议或 PR。

---

### 渠道 2：V2EX（`/go/share` 创造版，克制极客风）

**标题**：
`[开源] AIGC Studio v0.16.0 — 界面和画库留本地，算力挂载 Kaggle / 商业 API 的开源生图桌面端`

**正文草稿**：

做这个桌面工具的动机很明确：在只有轻薄本/小显存机器的情况下，不想为了跑开源生图模型去租按小时计费的云主机挂 WebUI，也不想用在线生图网站（订阅墙 + 图片存别人服务器 + 缺后续工程处理）。

于是花了一段时间把整个链路收成了一个纯本地 Electron + React + Node.js 控制面的桌面应用，**MIT 协议开源**。

**架构思路一句话**：控制面只监听 `127.0.0.1`（256-bit 随机 Bearer Token + `safeStorage` 密钥加密），模型权重与算力完全不碰本地硬盘；所有原图、`meta.json` 和版本树留在你指定的本地目录。

**目前做完了哪些能力（v0.16.0）**：
1. **四轨算力调度**：
   - 默认 Kaggle 免费 `2×T4`（每周 30 小时，内置 OAuth / CLI 凭据，云端会话未关时点窗口 X 最小化到托盘防空烧）；
   - Google Colab（跑 `Qwen-Image 2.1` / `Z-Image Turbo` / `FLUX.2 Klein 9B`）；
   - 商业 API（硅基流动 / fal.ai / OpenAI / 自定义端点，0 秒冷启动；接入了硅基流动 MiniMax H3 视频生成与首尾帧抽帧）；
   - 私有 Worker（Docker 镜像 `ghcr.io/nanxfu/aigc-worker:edge`，支持 SSE 步数进度与 Range 断点续传）。
2. **内置 6 项资产工坊（出图后不用切软件）**：
   - 本机零显存直算：VTracer WASM 转 SVG 矢量、Oklab 像素画对齐、序列帧切片导出 `atlas.json`、2×2 无缝平铺混边；
   - 云端 GPU 算子：`BiRefNet` / `RMBG-2.0` 去背、`Marigold` 四通道 PBR 拆解。
3. **创作助手与 MCP**：
   - 基于 `pi-agent-core` 接入 11 家 LLM / 本地 Ollama，支持提案卡跨后端一步生成、视觉回看（`imagen_inspect`）与硬预算探索抽卡；
   - `mcp/server.mjs` 暴露 7 个标准 stdio 工具，可直接在 Claude Desktop / Cursor 里调起生图。

**坦诚说明边界与不足**：
- 首批安装包只验证了 Windows x64（NSIS 安装版 + 便携版），未购买代码签名（首次运行需在 SmartScreen 点仍要运行，Release 附 `SHA256SUMS.txt`）；macOS / Linux 目前需 Node ≥ 20 源码运行；
- Kaggle 冷启动 allocation + 拉权重仍需约 3~10 分钟（急用建议切商业 API）；
- 目前没有内置节点连线编辑器——如果你需要高度复杂的 ControlNet / 工作流编排，依然应该用 ComfyUI（官网专门写了一篇对照说明什么时候不该用它）。

**链接**：
- 仓库：`https://github.com/nanxfu/aigc-studio`
- 官网 & 7 模型同题实测对比：`https://aigc-studio-8rj.pages.dev`
- Releases 下载：`https://github.com/nanxfu/aigc-studio/releases/latest`

欢迎 V 友试用拍砖，尤其是工作流设计、Mac 打包需求或私有 Worker 部署上的建议。

---

### 渠道 3：掘金 / 知乎（深度实测与工程复盘向）

**可选标题**：
- `没有独立显卡怎么白嫖双 T4 跑 FLUX.2 和 Qwen-Image？我做了一个开源桌面生图工作台（附 7 模型 9 维横评）`
- `把 ComfyUI 留在云端，把画廊和 SVG/像素/PBR 工坊留在本地：AIGC Studio 架构拆解与实测`

**正文结构与核心段落草稿**：

1. **开篇切痛点（客观对比两条现有路径的缺陷）**
   - 本地部署 WebUI/ComfyUI：12GB 以下显存跑现代 DiT（FLUX.2 / Qwen-Image）寸步难行，环境依赖极重；
   - 在线生图网站：订阅贵、图库绑死平台、无法无缝对接本地代码/游戏工程（转 SVG、切序列帧、拆 PBR）。
2. **核心解法：控制面本地化 + 算力插件化（附工作台截图）**
   - 解释架构：Electron + 本地 `127.0.0.1` Node 控制面 + 可插拔 Provider（Kaggle / Colab / 商业 API / 私有 Worker）。
   - 贴 `https://aigc-studio-8rj.pages.dev/guides/aigc-studio-vs-comfyui` 的选型边界：需要复杂多 ControlNet 编排选 ComfyUI；日常高频创作、无独显、要本地资产闭环选 AIGC Studio。
3. **7 款开源模型真机 9 维同题实测（贴对比图 + 表格）**
   - 直接引用 `docs/MODEL_BENCHMARK_PROMPTS.md` 与官网实测数据：
     - **最快起稿**：`SANA-Sprint 1.6B`（2 步 4.1s，10.3GB）；
     - **综合默认**：`SDXL Lightning`（4 步 6.2s，支持 Inpaint 涂抹重绘 9.02s、×2 放大 1.39s）；
     - **中文排版 / 平面海报**：`FLUX.2 Klein 4B`（4 步 10.2s，Apache-2.0 可商用，7.9GB 显存 + 扩图 LoRA 20.7s）与 `Qwen-Image 2.1`（7B DiT，8 步 43.7s，汉字准确度拔尖）；
     - **写实摄影 / 复杂静物**：`Z-Image Turbo`（30.7s，Apache-2.0）与 `FLUX.2 Klein 9B`（130.9s）；
     - **二次元**：`Anima Turbo v1.1`（21.6s，支持 Danbooru 标签）。
4. **为什么还要做“内置资产工坊”？（游戏与 UI 工程闭环）**
   - 展示「生成 → 工坊加工 → 复合资产包版本树 → 导出工程可用格式」的真实链路：
     - 像素画：AI 直出往往网格歪、半透明虚边多，本机算子通过边缘周期网格探测 + Oklab 调色盘量化 + 硬边清理一步救回；
     - 平面插画/Icon：Node WASM 跑 `@visioncortex/vtracer`，不占显存直接出可进 Figma 的 SVG；
     - 3D 贴图与角色：云端 T4 12.1s 出 `BiRefNet` 透明底 PNG，35.2s 出 `Marigold` 四通道 PBR 贴图。
5. **Agent 视觉闭环与 MCP 工程化细节**
   - 简述 `pi-agent-core` + `imagen_inspect` 视觉回看 + 硬预算防刷爆，以及通过 `runtime.json` 暴露标准 MCP Server 给 Claude Desktop / Cursor。
6. **文末附上开源仓库与文档链接**（GitHub / Releases / 官网 / 5 篇专项指南）。

---

### 渠道 4：小红书（强视觉对比 + 极简干货向）

**配图规划（建议 5–6 张图，4:3 或 3:4 竖版高清拼图）**：
1. **封面图**：深色暗房桌面工作台截图 + 醒目大字：`轻薄本白嫖双卡T4跑开源生图｜全开源免费桌面端`
2. **图 2（7 模型同题对比拼图）**：从 `bench-results/9dim/` 挑 `01-typography-poster` 或 `06-chinese-aesthetics` 的 4 张对比拼图（SDXL vs FLUX.2 Klein 4B vs Qwen-Image vs Z-Image），直接标注耗时与显存。
3. **图 3（工坊 1：AI 像素画救星）**：`site/public/assets/workshop/pixel-before.webp` vs `pixel-after.webp` + 序列帧动图/图集展示。
4. **图 4（工坊 2：零显存秒转 SVG & 一键 PBR 四通道）**：`vector-before` vs `vector-after` + `shield-cutout` / 四通道贴图网格。
5. **图 5（多轨算力界面截图）**：设置抽屉「Kaggle 免费 30h/周 + 商业 API 0 秒出图/生视频」界面。

**正文草稿（带标签，控制篇幅在 350 字内）**：

💻 **没有 4090 独显、也不想折腾 ComfyUI 连线和配环境？**
我自己开源了一个桌面生图工作台 **AIGC Studio**（MIT 协议免费），核心思路很简单：**界面和文件留在自己电脑，显卡算力挂载云端。**

✨ **用起来什么体验：**
1️⃣ **每周白嫖 30 小时双卡 T4（30G 显存）**：默认直连 Kaggle 免费 GPU，关闭窗口会自动缩到托盘防空烧额度；急着出图还能切硅基流动等商业 API，0 秒就绪，还能直接生视频 + 抽首尾帧。
2️⃣ **7 款热门开源模型开箱即用**：SDXL Lightning（6 秒出图）、FLUX.2 Klein 4B（原生中文+扩图）、Qwen-Image 2.1（超强中文海报）、Z-Image Turbo、Anima 二次元等，全部真机跑通。
3️⃣ **自带 6 项实用后处理工坊**（独立游戏 & 设计师刚需）：
   - 本机零显存跑：AI 像素画网格对齐、序列帧切片导出、无缝贴图混边、插画一键转可编辑 SVG；
   - 云端跑：一键抠图去背、PBR 四通道材质拆解。
4️⃣ **原图全存自己硬盘**：无月费订阅、不绑平台账号，还支持接 Claude Desktop / Cursor（MCP）。

📌 目前首批支持 **Windows 安装版 / 免安装便携版**（Mac/Linux 可源码运行）。
🔗 GitHub 搜 `nanxfu/aigc-studio` 或看评论区官网链接（内含 7 模型同题放大镜对比），欢迎试用提意见！

`#AI绘画 #开源工具 #独立游戏开发 #AIGC #ComfyUI平替 #免费GPU #效率工具`
