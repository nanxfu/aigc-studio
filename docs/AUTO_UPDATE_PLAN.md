# AIGC Studio 自动更新与热更新演进规划

> **文档定位**：针对脱离 DSH 插件体系后的独立 Electron 客户端，从第一性原理出发规划未来的版本分发、全量自动更新与轻量热更新架构。  
> **当前基线**：已清理 DSH 插件时代的 npm 注册表查询与 `enginesDsh` 依赖；[`server/update-check.js`](../server/update-check.js) 已改为只读查询 GitHub Releases API（默认关闭 `updateCheck: false`，缓存落在全局 `%APPDATA%\aigc-studio\update-check.json`）。

---

## 1. 第一性原理：我们需要解决哪两类「更新」？

在桌面端 AIGC 工作台场景里，用户的更新诉求其实分成两个频率截然不同的层：

| 层级 | 典型变更内容 | 体积 / 频率 | 适合机制 |
| :--- | :--- | :--- | :--- |
| **应用级更新** | Electron 壳、Node 后端、`shared/contract.js` 协议、原生依赖、安全修复 | 安装包 ~120MB（差分约数 MB）/ 按版本发布 | **`electron-updater`（全量 + 块级差分自动更新）** |
| **资源/前端级热更新（可选）** | 新模型清单 `models/*.json`、推理模板/配方向导、纯 UI 文案与样式微调 | 数 KB ~ 1MB / 高频迭代 | **静态资源热更新包（可选，严格受契约门控）** |

> **关键原则**：**`shared/contract.js` 与 `worker/` 协议强绑定**（`test/check-contract.mjs` 要求客户端、`server/`、`worker/daemon.py` 的 `VERSION` 与字段同源）。因此**跨协议版本的更新绝对不能只热更前端**，必须走整包应用更新，保证 `electron/` + `server/` + `web/` + `worker/` 原子同步。

---

## 2. 一期落地：基于 `electron-updater` 的客户端自动更新（推荐主力方案）

### 2.1 为什么优先选 `electron-updater` 而不是自研更新器
1. **差分下载已经解决体积痛点**：`electron-builder` 构建 NSIS 安装包时会产出 `.blockmap` 与 `latest.yml`；`electron-updater` 在 Windows NSIS / macOS DMG 上自动做**块级增量下载**，小版本升级通常只需下载几 MB，已经满足大多数“快速无感更新”需求，无需提前引入两套更新基础设施。
2. **安装包形态约束（必须前置对齐）**：
   - **NSIS 安装版（`win.target: nsis`）**：支持 `electron-updater` 完整静默下载 + 退出安装。
   - **便携版（`portable.exe`）与解压版（`win-unpacked`）**：不支持原地自覆盖升级，只能保留当前的「提示新版本 → 跳 GitHub Releases」只读路径。
   - **签名要求**：macOS 上 `autoUpdater` 硬依赖代码签名与公证；Windows 无签名时 `electron-updater` 可设 `verifyUpdateCodeSignature` 策略（仅过渡期调试，正式公开分发强烈建议配合代码签名证书）。

### 2.2 核心安全护栏：防烧云端 GPU 额度
AIGC Studio 与普通桌面软件最大的不同在于**可能挂着 Kaggle/Colab 远端 GPU 会话或正在跑出图任务**：
- 绝不允许在后台下载完成后直接调用 `quitAndInstall()` 强杀进程（会导致远端 Kernel 孤儿挂机空烧每周配额）。
- 必须复用 [`electron/tray.mjs`](../electron/tray.mjs) 的 `isSessionActive(state)` 判定：
  1. 有活跃会话 / 排队 / 出图任务时：即使更新已下载完毕，按钮文案显示**「任务结束后安装更新」**或仅允许**「下载并标记为退出时安装（`autoInstallOnAppQuit = true`）」**；
  2. 真正执行 `quitAndInstall()` 前，必须走完既有的 `ServerHost.stop()` 优雅关停流程（触发远端关机 / 持久化断点恢复记录）。

### 2.3 进程边界与统一状态契约
把当前仅由 `server/update-check.js` 提供的 `update` 快照，升级为**统一状态模型**（Electron 主进程优先接管，非 Electron/浏览器开发态或便携版回退 `server/update-check.js` 只读查询）：

```ts
type UpdateState = {
  channel: 'stable' | 'beta'
  mode: 'readonly' | 'electron-updater'
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'
  current: string
  latest: string | null
  hasUpdate: boolean
  canAutoUpdate: boolean         // NSIS / macOS / AppImage 为 true；portable / browser 为 false
  progress: number | null        // 0..100（downloading 阶段）
  releaseUrl: string | null
  checkedAt: string | null
  error: string | null
}
```

- **Electron 通道**：`electron/updater.mjs` 封装 `electron-updater`，通过 `preload.cjs` 暴露 `checkForUpdates()` / `downloadUpdate()` / `quitAndInstall()` 与事件订阅给工作台 `TopBar` / `SettingsDrawer`。
- **`electron-builder.yml` 改造点**：增加 `publish: { provider: 'github', owner: 'nanxfu', repo: 'aigc-studio' }` 与 `generateUpdatesFilesForAllChannels: true`（在 GitHub Actions CI 中自动生成并上传 `latest.yml` + `.blockmap`）。

---

## 3. 二期可选：轻量资源 / 前端热更新设计（仅在确实有高频迭代需要时引入）

如果后续出现**“只新增一个模型卡片 JSON（`models/*.json`）”或“紧急修复纯前端 UI 交互，不想让用户重走整包安装重启”**的高频场景，才考虑引入热更新层。其必须遵守以下硬约束：

### 3.1 允许热更的范围 vs 禁止热更的范围
- **允许**：
  - `models/` 增量模型配置与对应 `shared/models.generated.js` / 海报资产（前提：使用的 `pipeline.loader` 和 `accel` 键已存在于当前客户端内置的 `worker/` 中）；
  - 纯静态 `dist/web/` 前端包（前提：所需的 `/api/*` 路由和字段在当前 `server/` 契约范围内）。
- **禁止**：
  - 修改 `electron/` 主进程、Node 原生模块、或引入新的 `/api/*` 路由或 `worker/` 协议字段（这类变更强制要求走 §2 的整包升级）。

### 3.2 目录与安全校验设计（防变砖）
热更新文件落在独立于安装目录的可写目录 `%APPDATA%\aigc-studio\hot-bundles\`（不修改程序安装目录，避免 Windows `Program Files` 权限问题）：

```text
%APPDATA%\aigc-studio\hot-bundles\
├─ current.json                  # 原子指针：{ activeSlot, previousSlot, appVersion, bundleVersion }
├─ slots\
│  ├─ 0.15.0-hot.1\              # 解压后的 dist/web 或 models 覆盖包
│  └─ 0.15.0-hot.2\
└─ pending-verify.flag           # 首次加载标记：若加载失败自动回滚 previousSlot
```

1. **强校验**：热更包 manifest 必须包含 `minAppVersion` / `maxAppVersion`（不匹配当前安装包版本直接忽略）、全量 `sha256` 校验与 **Ed25519 非对称签名**（公钥编译进应用源码），防止中间人或镜像篡改直接注入恶意 JS 到本地带 `aigcStudio` 原生桥的桌面窗口。
2. **自动回滚**：写入新 slot 后先打上 `pending-verify` 标记；下次启动若 `webContents` 在规定时间内未完成挂载（或出现 `did-fail-load` / 未捕获渲染崩溃），主进程自动切回 `previousSlot` 并拉黑该坏版本。
3. **版本对齐**：`server/standalone.js` 启动时检查 `current.json` 中的 `appVersion === package.json.version`，一旦用户安装了新的大版本安装包，自动失效并清理旧大版本残留的所有热更新 slot。

---

## 4. 建议的实施节奏

1. **当前阶段（已完成）**：清理 DSH 插件时代的 `enginesDsh` / npm 注册表遗留，将 `server/update-check.js` 切到 GitHub Releases 只读查询并将缓存迁至全局应用数据目录。
2. **下一步（配合首个正式 GitHub Release）**：配置 GitHub Actions 自动构建打包产物并生成 `latest.yml`；在 `SettingsDrawer` 增加「自动检查更新」开关（默认开启但只读提示，不强弹打扰）。
3. **正式桌面分发期**：引入 `electron-updater`（`electron/updater.mjs`），打通后台静默下载 + 云端会话安全保护的「退出时安装」闭环。
4. **仅在高频模型/UI 运营阶段**：按 §3 的签名 + 双槽回滚规范按需补齐热更新层，避免过早引入复杂度。
