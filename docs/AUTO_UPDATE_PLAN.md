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
   - **NSIS 安装版（`win.target: nsis`）**：支持 `electron-updater` 完整差分下载 + 退出安装。
   - **Linux AppImage**：技术上支持 `electron-updater`，但 M2.8 没有 Linux 构建产物与实测，客户端先按只读形态处理；等有 Linux CI 与真机升级验证后再放开，避免「代码里写了 true、实际从没跑过」。
   - **便携版（`portable.exe`）与解压版（`win-unpacked`）**：不支持原地自覆盖升级（主进程通过 `PORTABLE_EXECUTABLE_DIR` / `PORTABLE_EXECUTABLE_FILE` 与 `!app.isPackaged` 严格识别），强制降级为「提示新版本 → 跳 GitHub Releases / 镜像下载页」只读路径。
   - **无代码签名证书策略（已确认暂不购买证书）**：
     - **Windows NSIS**：`electron-updater` 在配置了 `publisherName` 时会校验 Authenticode 签名；无证书构建不设置该字段，并按当前 `electron-updater` 版本的实际行为确认是否跳过校验。若该版本仍强制校验，则显式覆盖其签名校验钩子放行，改由 **HTTPS 传输 + `latest.yml` 中 `sha512` 文件哈希**保证传输完整性；首次安装需在文档提示 SmartScreen 处理方式。这一步必须在阶段 B 开头做最小升级 spike，不能等到 UI 做完才发现装不上。
     - **macOS**：`autoUpdater` 受系统签名与公证硬限制，无证书阶段统一设为 `canAutoUpdate = false`，沿用只读提示与手动覆盖升级。

### 2.2 核心安全护栏：防烧云端 GPU 额度与关停协同
AIGC Studio 与普通桌面软件最大的不同在于**可能挂着 Kaggle/Colab 远端 GPU 会话或正在跑出图任务**：
- 保持 `autoUpdater.autoDownload = false`（只自动检查，由用户确认下载），且绝不允许下载完成后直接强杀进程重启（会导致远端 Kernel 孤儿挂机空烧每周配额）。
- 必须复用 [`electron/tray.mjs`](../electron/tray.mjs) 的 `isSessionActive(state)` 与任务队列状态判定：
  1. 有活跃会话 / 排队 / 出图任务时：即使更新已下载完毕，禁用「立即重启安装」，仅提供**「会话/任务结束后安装（退出时安装）」**或引导用户先结束算力。这里的「退出时安装」由主进程记录标志，在 `shutdown()` 完成后显式调用 `quitAndInstall()`，不依赖 `autoInstallOnAppQuit` 的自动触发，避免安装动作跑在优雅关停之前；
  2. 真正执行 `quitAndInstall()` 前，必须协调 [`electron/main.mjs`](../electron/main.mjs) 的 `onWindowClose` 与 `onBeforeQuit`：确保先完成 `ServerHost.stop()` 优雅关停（触发远端关机 / 持久化断点恢复记录）再由安装器接管重启，避免关停未完成或被最小化到托盘拦截。

### 2.3 弱网与 GitHub 不通畅兜底（多源 / 镜像支持）
针对部分用户直连 `github.com` / `objects.githubusercontent.com` 超时或丢包的问题：
- **代理兼容**：`electron-updater` 继承系统代理与 `HTTP(S)_PROXY`；只读查询 [`server/update-check.js`](../server/update-check.js) 复用 [`server/net.js`](../server/net.js)（`fetch` 失败降级 `curl`）。
- **自定义更新源 / 镜像通道**：在 `app-config.json` 与设置抽屉预留 `updateSource`（`github` | `custom`）与 `updateMirrorUrl`（仅允许 `https://`）：
  - 自定义源按 `electron-updater` `generic` provider 托管同一套 `latest.yml` + `.exe` + `.blockmap`；
  - 主进程通过 `autoUpdater.setFeedURL({ provider: 'generic', url })`、只读检测器通过对应 `latest.yml` 保持检测与下载同源，且下载产物仍强制校验 `latest.yml` 的 `sha512`。

### 2.4 进程边界与统一状态契约
把当前仅由 `server/update-check.js` 提供的 `update` 快照，升级为**统一状态模型**（Electron 主进程优先接管，非 Electron/浏览器开发态或便携版回退 `server/update-check.js` 只读查询）：

```ts
type UpdateState = {
  channel: 'stable' | 'beta'
  mode: 'readonly' | 'electron-updater'
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'
  current: string
  latest: string | null
  hasUpdate: boolean
  canAutoUpdate: boolean         // M2.8 只对 Windows NSIS 为 true；portable / unpacked / 未签名 macOS / AppImage 为 false
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

1. **基线已完成**：清理 DSH 插件时代的 `enginesDsh` / npm 注册表遗留，将 `server/update-check.js` 切到 GitHub Releases 只读查询并将缓存迁至全局应用数据目录。
2. **M2.8 实施目标（当前规划，详见 [`M2_8_RELEASE_AND_UPDATER_SPEC.md`](M2_8_RELEASE_AND_UPDATER_SPEC.md)）**：
   - **阶段 A：发布通道**——补齐 `electron-builder.yml` `publish` 与 `.github/workflows/release.yml`，先以 Draft Release 验流；新增版本一致性与产物校验脚本（`latest.yml` / `sha512` / `.blockmap`）；首次发布用 `0.15.0` 手动安装，再用 `0.15.1` 做真实升级；
   - **阶段 B：应用内更新**——引入 `electron/updater.mjs`（NSIS 差分下载 + 无签名校验 + 活跃会话防烧额度护栏 + 便携版/解压版/开发态降级）；打通弱网/自定义 `https://` 镜像源与 `SettingsDrawer` / `TopBar` 交互（首个正式 Release 落地后默认开启自动检查）。
   - **范围收窄**：本阶段只承诺 Windows NSIS 自动更新；Portable / `win-unpacked` / 未签名 macOS / Linux AppImage 一律只读提示，等有签名或 Linux 实测后再放开，避免把未验证路径暴露给用户。
3. **仅在高频纯前端/模型运营阶段**：再按 §3 的签名 + 双槽回滚规范按需补齐热更新层，当前 M2.8/M3 跨协议迭代期不提前引入复杂度。
