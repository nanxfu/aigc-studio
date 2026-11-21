# 发布通道与应用内更新（里程碑 M2.8）实施规格

> **定位**：把当前「本机 `npm run dist` 出包、手动发给用户」的交付方式，升级为「打 Tag → GitHub Actions 出包 → Release 资产 → 客户端检查/下载/安装」的可重复链路。本文是执行规格，设计取舍与第一性原理见 [`AUTO_UPDATE_PLAN.md`](AUTO_UPDATE_PLAN.md)。
> **基线**：`0.14.0`；Electron 44 / electron-builder 26；Windows NSIS + Portable 已能本机构建并通过安装/冒烟；仓库尚无 `.github/workflows/`，`electron-builder.yml` 尚无 `publish`，未引入 `electron-updater`。
> **迭代日期**：2026-11-22。
> **一句话结论**：先做「发布通道」（阶段 A），再做「应用内更新」（阶段 B）。A 不做完不进入 B，否则更新器没有可信的 `latest.yml` 可测。
>
> **实施进度（2026-11-22）**：阶段 A 与阶段 B 的代码/配置已落地，离线回归全绿；Gate 0 的版本收口（`0.15.0`）与「`0.15.0` → `0.15.1` 真实升级 E2E」尚未执行，因此本轮**不改 `package.json.version`、不打 Tag、不创建 Release**。本地联调：`npm run update:mock` + `AIGC_STUDIO_UPDATE_DEV=1 AIGC_STUDIO_UPDATE_FEED=http://127.0.0.1:8787 npm run dev`。

---

## 0. 范围与边界

### 0.1 本阶段交付

| 阶段 | 交付 | 用户可见结果 |
| :--- | :--- | :--- |
| **A. 发布通道** | `publish` 配置、release workflow、产物校验脚本、首个 Draft Release | 维护者打一个 Tag 就能得到一套可安装、可校验、可下载的产物 |
| **B. 应用内更新** | `electron/updater.mjs`、更新状态契约、设置/顶栏入口、安装护栏、镜像源 | 安装版用户能在应用内看到新版本、下载、重启安装；便携版只提示下载 |

### 0.2 明确不做

- **不购买代码签名证书**：Windows 安装包保持未签名；macOS 只出包、不启用自动更新；Linux AppImage 在本阶段只保留「只读提示」，不承诺自动更新（现有 `AUTO_UPDATE_PLAN.md` 中 AppImage 可自动更新的说法在本阶段收窄，等有 Linux 构建与实测后再放开）。
- **不做热更新**：模型清单、前端静态包、`server/` 路由、`worker/` 协议全部随整包升级。跨协议改动走 `.blockmap` 差分，不引入第二套资源更新通道。
- **不做灰度/分渠道**：只保留 `stable`。需要内测时用 Draft / Pre-release 手工验证，不在客户端做 beta 通道切换。
- **不做静默下载、静默安装**：检查可以自动，下载必须用户确认，安装必须用户确认或在用户明确选择「退出时安装」后执行。

### 0.3 完成定义

1. 推送 `v0.15.0` Tag 后，Release（可先 Draft）包含 `latest.yml`、NSIS 安装包、NSIS `.blockmap`、Portable、`SHA256SUMS.txt`，且 `latest.yml` 的 `sha512` 与实际安装包一致。
2. 在已安装 `0.14.0` 的干净 Windows 环境上，安装 `0.15.0` 后能检查到 `0.15.1`、下载、重启并完成升级；升级后版本号、工作区、设置均保留。
3. 有活跃云端会话或排队/出图任务时，「立即重启安装」被阻止；「退出时安装」在任务结束后正常执行，远端关机流程完整走完。
4. 便携版、解压版、开发态只显示「有新版本 + 打开发布页」，不下载、不安装。
5. GitHub 直连失败时，错误在 10 秒内以可读文案呈现；配置 `https://` 镜像后能完成检查与下载。

---

## 1. 入口条件（Gate 0）

> **本轮执行边界（2026-11-22）**：阶段 A 轮次完成配置、校验脚本、workflow 与本地/CI dry-run；阶段 B 轮次完成更新器、状态契约、安装护栏、镜像源、UI 与离线测试。两个轮次都**不改 `package.json.version`、不推 `v0.15.0` Tag、不创建正式 Release**。版本收口与真实升级演练等 M2.7 收尾和 M2 剩余人工验收完成后再统一执行。

在打第一个发布 Tag 之前，以下事项必须全部满足：

- [ ] **M2 剩余人工验收完成**：托盘保活/彻底退出/后台通知/角标/文件夹定位，以及安装版页面级联调（见 [`LIVE_ACCEPTANCE.md`](LIVE_ACCEPTANCE.md) §7）。发布通道不能用来掩盖未验收的交互。
- [ ] **版本收口 `0.15.0`**：`package.json`、`shared/contract.js` 的 `VERSION`、`worker/daemon.py` 的 `VERSION`、`CHANGELOG.md` 顶部条目、README 版本说明一致；`npm run contract:check` 通过。
- [ ] **`package.json` 元信息补齐**：`repository`、`homepage`、`bugs`、`author` 与 GitHub 实际仓库一致（当前只有 `author`/`license`）。
- [ ] **仓库与 Actions 就绪**：仓库公开可读；Actions 启用；Tag 推送权限可用；`GITHUB_TOKEN` 具备 `contents: write`。
- [ ] **文档就绪**：README / FAQ 增加「未签名安装包会触发 SmartScreen」「如何校验 SHA256」「便携版不支持自动更新」「镜像源如何配置」四段说明。
- [ ] **本地基线全绿**：`npm run test:contract`、`npm run test:client`、`npm run test:host`、`python test/worker/run.py`；`npm run dist` 能产出 NSIS + Portable。
- [ ] **先跑一次本地产物校验**：用本规格 §2.2 的 `tools/verify-release.mjs` 检查本机构建，确认 `latest.yml` 中的文件名、版本、`sha512` 与磁盘文件一致。

> 未满足项不要用「先发一个看看」绕过。发布通道一旦对外，后续每个版本都会继承它的错误。

---

## 2. 阶段 A：发布通道

### 2.1 构建与发布配置

| 文件 | 改动 | 验收 |
| :--- | :--- | :--- |
| `package.json` | 新增运行时依赖 `electron-updater`（当前锁定 `^6.8.11`，阶段 B 使用，但先随包安装以便 `app-update.yml` 与本地演练一致）；新增 `repository` / `homepage` / `bugs`；新增脚本 `release:verify`、`release:dry` | `npm ci` 后 `node -e "import('electron-updater')"` 可用；`npm run release:verify` 能读 `release/latest.yml` |
| `electron-builder.yml` | 增加 `publish: { provider: github, owner: nanxfu, repo: aigc-studio, releaseType: draft }`；`generateUpdatesFilesForAllChannels: false`（只做 stable）；`nsis.differentialPackage: true` 显式声明；`files` 补 `mcp/**`（M3 的 MCP 需要，提前纳入避免打包回归） | `npx electron-builder --win nsis portable --publish never` 后 `release/latest.yml`、`*.blockmap`、两个 `.exe` 均存在；`resources/app-update.yml` 存在 |
| `.github/workflows/release.yml` | 新增；Tag `v*` 触发；`workflow_dispatch` 仅做 dry-run；`permissions: contents: write`；Windows runner；Node 20 + Python 3.11 | 手动 dry-run 成功产出 artifact；Tag 触发能创建 Draft Release |
| `tools/check-release-version.mjs` | 新增：Tag 去 `v` 后必须等于 `package.json.version`；`package.json.version` 必须等于 `shared/contract.js` 的 `APP_VERSION ?? VERSION`，否则退出 1。**版本读取必须写成 `APP_VERSION ?? VERSION`**，为 M3.0 的产品/协议版本分离预留兼容，不能写死 `VERSION` | 故意改错 Tag 或契约版本时 job 失败且错误可读 |
| `tools/verify-release.mjs` | 新增：解析 `latest.yml`，校验版本、文件名、大小、`sha512`、`.blockmap` 存在且非空；生成 `SHA256SUMS.txt`。YAML 解析优先复用 `electron-updater` 已带的 `js-yaml`（若不想依赖传递包，则显式加入 devDependencies），不要手写正则解析整个文件 | 本地/CI 均通过；篡改 exe 后校验失败 |

**关于 `publish` 与实际上传方式**：`publish` 配置的核心作用是让 electron-builder 生成 `app-update.yml` 与 `latest.yml`。workflow 统一先用 `--publish never` 出包，接着跑 `verify-release.mjs` 校验全部资产并生成 hex 格式的 `SHA256SUMS.txt`，**确认全绿后再由 `gh release create "$GITHUB_REF_NAME" --draft` 一次性上传 5 个资产**。这样可以确保 `SHA256SUMS.txt` 一起进 Release，且校验失败时绝不会向 GitHub 留下半残 Draft。

**关于 `generateUpdatesFilesForAllChannels`**：只做 stable 时设为 `false`，避免生成无人消费的 `beta.yml` 等文件。将来引入 beta 通道时，再显式设置 `channel: beta` 并打开该开关，同时客户端增加 `allowPrerelease` 配置；不要在 M2.8 提前铺开。

**关于 `differentialPackage`**：electron-builder 26 的 `nsis.differentialPackage` 支持 `true | "compressed" | "store-asar"`。当前 `asar: false`，没有 `app.asar` 可存，`"store-asar"` 等价于 `true`，所以显式写 `true`；若未来改回 asar，再评估 `"store-asar"`（它能让 asar 内容的差分更小，但安装包会变大）。

### 2.2 产物契约

一次正式 Release 必须且只包含以下资产（名称以 `artifactName` 为准）：

| 资产 | 必需 | 用途 / 校验 |
| :--- | :---: | :--- |
| `aigc-studio-<version>-x64.exe` | 是 | NSIS 安装包；`latest.yml.files[].url` 必须指向它 |
| `aigc-studio-<version>-x64.exe.blockmap` | 是 | 差分下载；必须与 exe 同版本、非空 |
| `latest.yml` | 是 | 更新清单；`version`、`path`、`sha512`、`size` 与实际文件一致 |
| `aigc-studio-<version>-portable.exe` | 是 | 便携版；不进入 `latest.yml`，不参与自动更新 |
| `SHA256SUMS.txt` | 是 | 手动下载者的校验依据；由 `verify-release.mjs` 生成 |
| `builder-effective-config.yaml` | 否 | 调试用；若出现可不上传 |

**命名陷阱**：`artifactName` 含空格、中文、`+` 都会让 `latest.yml` 与下载 URL 对不上。当前 `${name}` 为 `aigc-studio`，安全；但仍要在 `verify-release.mjs` 中逐项比对 URL 与磁盘文件名，不能只看「文件存在」。

### 2.3 Workflow 步骤

```text
# 步骤示意（不是可直接复制的完整 YAML；实际 workflow 以仓库文件为准）
checkout
setup-node 20（cache: npm）
setup-python 3.11
npm ci
node tools/check-release-version.mjs        # workflow_dispatch 时跳过
npm run test:contract
npm run test:client
npm run test:host
python test/worker/run.py
npm run build:web
npx electron-builder --win nsis portable --publish never
node tools/verify-release.mjs
gh release create "$GITHUB_REF_NAME" ... --draft --generate-notes  # 仅 Tag 触发
upload-artifact（无论是否发布，保留 release/ 供排障）
```

**测试与 Electron 冒烟**：`npm run test:host` 包含 `smoke-image.mjs`，它会在有 Electron 二进制的环境里真的拉起窗口。**首版 release workflow 先保留它实跑**，Windows runner 自带桌面会话，先观察是否稳定；只有连续实测失败时才考虑给 `run-all.mjs` 增加显式跳过开关，并且必须在 workflow 里写明原因，不能静默 SKIP。**不要设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`**：`electron-builder.yml` 配了 `electronDist: node_modules/electron/dist`，CI 的 `npm ci` 必须完整下载 Electron 二进制，否则打包阶段找不到分发目录。

**发布边界**：`workflow_dispatch` 只做 dry-run，不会创建 Tag 或 Release；只有 `v*` Tag push 才在 `verify-release.mjs` 通过后执行 `gh release create --draft` 上传资产。手动 dispatch 不要传任何「发布」开关，避免误发。

**缓存**：`setup-node` 的 npm 缓存足够；Electron / electron-builder 的下载缓存可加，但不是首版必需。首版优先保证可复现，不为了省两分钟引入缓存失效问题。

**失败处理**：因为先本地 `verify-release.mjs` 后创建 Draft，校验失败会在上传前阻断，不会生成半套资产的 Draft。Tag 已推送但构建失败时，修复后重新推一个补丁版本，不要移动已发布的 Tag。

### 2.4 首次发布演练

1. 本地 `npm run dist`，跑 `npm run release:verify`，确认产物契约。
2. 推 `v0.15.0` Tag，workflow 产出 Draft Release；下载资产到干净目录，复核 `latest.yml` 与 `SHA256SUMS.txt`。
3. 在干净 Windows 虚拟机安装 `aigc-studio-0.15.0-x64.exe`，确认应用可启动、工作区可选、出图链路正常。
4. 手动发布 Draft 为正式 Release；不要急着让用户升级。
5. 把版本改为 `0.15.1`，重复流程，**发布为正式 Release（非 Draft、非 Pre-release）**；用已安装的 `0.15.0` 做第一次真实应用内升级。`electron-updater` 的 GitHub provider 与只读检查器都看不到 Draft/Pre-release，留在 Draft 状态是测不出更新的。**第一次自动更新必须发生在两个都带更新器的版本之间**；`0.14.0` 没有 `electron-updater`，只能手动安装 `0.15.0`。
6. 升级后核对：版本号、最近工作区、LLM 设置、`session.json` 是否存在/可恢复、日志无 `checksum`/`signature` 错误。

### 2.5 阶段 A 验收

- [ ] Tag 触发的 Release 资产齐全，`verify-release.mjs` 通过。
- [ ] 干净环境安装/卸载/便携版冒烟通过（沿用 `npm run test:installer` / `test:packaged`）。
- [ ] `latest.yml` 的 `version` 与 Tag、`package.json`、应用内「关于」版本一致。
- [ ] 故意构造一个错误 `sha512` 的 `latest.yml`，`verify-release.mjs` 必须失败（证明校验不是空跑）。
- [ ] workflow 在版本不匹配时失败，且日志直接指出 Tag 与 `package.json` 的差异。

---

## 3. 阶段 B：应用内更新

### 3.1 运行形态判定

更新器必须先回答「我是哪种安装形态」，再决定能不能自更新。判定顺序固定，不允许用「`app.isPackaged` 一个条件打天下」：

| 形态 | 判定依据 | `canAutoUpdate` | 行为 |
| :--- | :--- | :---: | :--- |
| 开发态 | `!app.isPackaged`，且未设置 `AIGC_STUDIO_UPDATE_DEV=1` | false | 不初始化更新器；需要联调时用 `forceDevUpdateConfig` + 本地 feed |
| 便携版 | `process.env.PORTABLE_EXECUTABLE_FILE` 或 `PORTABLE_EXECUTABLE_DIR` 存在 | false | 只读检查 + 打开发布页/镜像下载页 |
| 解压版 | `app.isPackaged` 且 `basename(dirname(process.execPath)) === 'win-unpacked'` | false | 只读检查 |
| NSIS 安装版 | `app.isPackaged`、Windows、非便携/解压，且存在 `app-update.yml` | true | 完整检查/下载/安装 |
| macOS 未签名 | `app.isPackaged` 且 `darwin` | false | 只读检查；等签名/公证后放开 |
| Linux AppImage | `process.env.APPIMAGE` 存在 | false（本阶段） | 只读检查；待 Linux 构建与实测后放开 |
| 其它 | 兜底 | false | 只读检查，错误码 `unsupported_form` |

**实现要求**：判定逻辑放在纯函数模块（建议 `electron/updater/policy.mjs`），不依赖 Electron API，输入是 `{ isPackaged, platform, env, execPath, resourcesPath }`，这样可以在 Node 里直接单测。主进程只负责把真实值传进去。

### 3.2 统一状态契约

建议新增 `shared/update-state.js`（纯函数 + 常量），主进程、渲染进程、只读检查器共用同一套形状与归一逻辑：

```ts
type UpdateMode = 'electron-updater' | 'readonly'
type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'
type InstallForm = 'nsis' | 'portable' | 'unpacked' | 'dev' | 'mac-unsigned' | 'linux-appimage' | 'unsupported'

type UpdateState = {
  schema: 1
  mode: UpdateMode
  form: InstallForm
  canAutoUpdate: boolean
  channel: 'stable'
  source: 'github' | 'custom'
  current: string
  latest: string | null
  hasUpdate: boolean
  status: UpdateStatus
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  releaseUrl: string | null        // 发布页或镜像下载页
  releaseName: string | null
  checkedAt: string | null
  installOnQuit: boolean
  error: { code: string; message: string } | null
}
```

**不变量**：

1. `downloaded` 只在 `canAutoUpdate === true` 时出现；只读形态最多到 `available`。
2. `progress` 只在 `downloading` 时非空；百分比钳在 `0..100`。
3. `latest` 在 `up-to-date` 时仍保留（用于显示「已是最新 0.15.1」），但 `hasUpdate=false`。
4. `error` 与 `status='error'` 同时出现；恢复检查时先清 `error`。
5. `source` 与 `releaseUrl` 必须同源：自定义镜像时不能把 `releaseUrl` 指向 GitHub 的另一个版本。

**优先级**：渲染进程若检测到 `window.aigcStudio?.updater`，以主进程状态为准；否则读 `/api/state.update`（只读形态）。两套状态不得同时驱动 UI。为避免重复请求，NSIS 安装态下主进程通过环境变量 `AIGC_STUDIO_UPDATE_OWNER=electron` 告知本地服务，`server/update-check.js` 不再发起检查，`/api/state.update` 返回 `null` 或 `{ mode: 'electron' }` 占位。

### 3.3 主进程实现

| 文件 | 职责 |
| :--- | :--- |
| `electron/updater.mjs` | 创建更新器；通过本地服务 `GET /api/app-settings` 读取 `update` 段（不直接读 app-config 文件）；`autoUpdater` 事件 → `UpdateState`；导出 `getState / check / download / install / setInstallOnQuit / setSource` |
| `electron/updater/policy.mjs` | 纯函数：形态判定、`canAutoUpdate`、`canInstallNow`、错误分类、镜像 URL 校验 |
| `electron/preload.cjs` | `contextBridge` 暴露 `updater` 命名空间；`onStateChange` 返回取消订阅函数；不暴露任意 IPC 通道 |
| `electron/main.mjs` | 初始化时机、`ipcMain` 处理、安装前刷新 `/api/state`、`quitAndInstall` 与 `shutdown()` 协同、`pendingInstall` 标志 |
| `shared/update-state.js` | 状态常量、`normalizeUpdateState`、`canInstallNow`、`errorMessageKey` |
| `server/update-check.js` | 只读检查器扩展：读取 `update.updateCheck / update.updateSource / update.updateMirrorUrl`；自定义 `latest.yml`、错误分类、缓存按源失效 |
| `server/update-source.js` | 新增：`parseLatestYml`、`normalizeMirrorUrl`、`resolveDownloadUrl` |
| `server/app-config.js` | 新增独立 `update` 段 `{ updateCheck, updateSource, updateMirrorUrl }`，**不要继续往 `COMPUTE_KEYS` 里塞**；`saveSettings` 接受 `update` patch 并归一；`publicSettingsView()` 返回 `update`；加载旧 `compute.updateCheck` 时一次性迁移到 `update.updateCheck`，`getCompute()` 仅为兼容 `createApp` 派生 `updateCheck` |
| `server/routes/app-settings.js` | `KNOWN_FIELDS` 增加 `update`；`GET /api/app-settings` 返回 `settings.update`；`POST` 接受 `{ update: { updateCheck?, updateSource?, updateMirrorUrl? } }`，校验布尔 / 枚举 / `https://` 后交给 `appConfig.saveSettings`；安装包、便携版、浏览器态统一走这条路由，不依赖工作区设置 |
| `server/settings.js` | 保持工作区运行设置，不接管 `updateCheck`；不要把它加进 `KNOWN_FIELDS`，否则更新配置会跟随工作区漂移 |
| `server/app.js` | 从 `appConfig` 的 `update` 段构造 `createApp` 的 `updateCheck` 与检查器源；Electron 托管时禁用只读检查器 |
| `web/logic/update.js` | 从「只派生提示」升级为「归一完整状态 + 可执行动作」；保留旧 `updateOf` 兼容 |
| `web/studio/TopBar.jsx` | 顶栏独立更新入口（图标 + 红点）；弹层展示版本、进度、动作 |
| `web/studio/SettingsDrawer.jsx` / `settings/SettingsAppSections.jsx` | 「版本与更新」区：当前版本、自动检查、更新源/镜像、立即检查、错误详情；读写 `/api/app-settings` 的 `update` 段 |
| `web/studio/hooks/useUpdate.js` | 新增：优先订阅桥接状态，回退轮询 `/api/state`；卸载时退订 |

**初始化顺序**：`app.whenReady()` → 判定形态 → 若 `canAutoUpdate` 则创建 updater（`autoDownload=false`、`autoInstallOnAppQuit=false`、`allowPrerelease=false`）→ 注册 IPC → 启动后延迟 10 秒做首次检查（不要和本地服务启动、首轮出图抢网络）→ 之后按 6 小时 TTL 复查。开发态与只读形态不创建 `autoUpdater`，只保留 `check` 的只读路径。

**`electron-updater` 的 ESM 导入方式**：它是 CJS 包，Node/Electron 的 ESM 命名导出列表里没有 `autoUpdater`。主进程应写成 `import electronUpdater from 'electron-updater'; const { autoUpdater } = electronUpdater`，不要直接 `import { autoUpdater } from 'electron-updater'`（实测后者在 Node 22 下是 `undefined`，只会在运行期炸）。

**日志**：使用 `electron/logger.mjs`，记录 `form`、`source`、`status` 迁移、错误码、耗时；绝不记录 Token、完整 URL 查询串或用户目录。下载进度按 1% 或 500ms 节流后再发给渲染进程，避免 IPC 风暴。

### 3.4 安装护栏（防烧云端 GPU 额度）

这是本项目与普通桌面软件最大的差异，必须按以下顺序执行，不能只信 5 秒前的缓存：

```text
用户点「立即重启安装」
  → 重新请求 /api/state（2.5s 超时）
  → 失败? → 阻止安装，提示「无法确认云端状态」
  → isSessionActive(state) 或 queue.running / queue.pending > 0 / jobs 活跃?
      → 是 → 不安装，给出两个出口：
            A. 「退出时安装」：installOnQuit=true，等用户正常退出时执行
            B. 「先断开算力」：调用 /api/session/stop，轮询到无活跃会话后再安装
      → 否 → 继续
  → 置 pendingInstall=true，forceQuit=true，app.quit()
  → before-quit → shutdown()（ServerHost.stop，远端关机/断点持久化，最多 10s）
  → shutdown 完成 → autoUpdater.quitAndInstall(true, true)
```

**与当前 `onBeforeQuit` 的冲突（实现时必改）**：现在 [`electron/main.mjs`](../electron/main.mjs) 的 `onBeforeQuit` 在 `shutdown().catch(...).finally()` 里固定执行 `shutdownComplete = true; app.quit()`。如果按上面的顺序在 `shutdown()` 结束后再调用 `quitAndInstall()`，`.finally()` 里的 `app.quit()` 会与安装器争抢退出流程。正确写法是：

- `pendingInstall === true` 时，在同一个 `.finally()` 里先置 `shutdownComplete = true`，再调用 `autoUpdater.quitAndInstall(true, true)`，**不要再调用 `app.quit()`**；
- 或者先 `await shutdown()` 完成，再在 `.finally()` 之外判断 `pendingInstall` 并调用 `quitAndInstall()`，同样不能同时 `app.quit()`；
- `quitting` / `shutdownComplete` 的幂等保护保留，避免 `quitAndInstall` 触发的二次 `before-quit` 重新跑一遍关停；
- 失败路径（`shutdown()` reject）不能安装：记录错误、清 `pendingInstall`，回到可重试状态。

**为什么不在下载完成后自动装**：`quitAndInstall` 会直接结束进程，`ServerHost.stop()` 来不及完成，Kaggle/Colab Kernel 会变成孤儿继续烧配额。必须让安装动作排在优雅关停之后。

**「退出时安装」的语义**：只设置 `installOnQuit=true`，不立即退出；顶栏显示「将在退出时安装」。用户下一次正常退出（托盘「彻底退出」或窗口关闭且无活跃会话）时，走同一条 `shutdown → quitAndInstall` 路径。若退出时仍有活跃会话，`onWindowClose` 仍按现有逻辑拦截并隐藏到托盘，安装继续等待——这是正确行为，UI 要说明「会话结束后才会安装」。

**取消**：用户可随时关闭「退出时安装」开关；已下载的包保留，下次可直接安装。下载过程不提供取消（electron-updater 没有稳定的取消 API），但允许关闭弹层，后台继续。

### 3.5 弱网、镜像与错误分类

**代理**：`electron-updater` 走 Electron 网络栈，继承系统代理与 `HTTP(S)_PROXY`；只读检查器复用 `server/net.js` 的 `fetch → curl` 降级。两条路径都要在日志里记录「是否走了代理/降级」，但不要打印代理地址。

**自定义源**：

- **配置归属**：不要只改 `server/app-config.js` 的 `COMPUTE_KEYS`。当前 `server/routes/app-settings.js` 只认 `ui / llm / workspace`，`server/routes/settings.js` 的 `KNOWN_FIELDS` 也没有 `updateCheck`，所以 `compute.updateCheck` 目前**没有任何 HTTP 路由能落盘**。阶段 B 必须在 `app-config` 增加独立的 `update` 段，并在 `/api/app-settings` 的 GET/POST 中统一承载：
  ```json
  { "update": { "updateCheck": true, "updateSource": "github", "updateMirrorUrl": "" } }
  ```
  这样安装包、便携版、浏览器态都能通过设置抽屉持久化，不依赖工作区设置。旧 `compute.updateCheck` 只做一次性迁移，迁移后以 `update.updateCheck` 为准；`server/settings.js` 保持工作区运行设置，不接管更新字段。
- 配置项：`updateSource: 'github' | 'custom'`、`updateMirrorUrl: string`。
- 校验：必须是 `https://`；禁止用户名/密码、query、fragment；长度 ≤ 512；末尾斜杠归一；生产态禁止 `http://`（仅 `AIGC_STUDIO_UPDATE_DEV=1` 允许 `http://127.0.0.1:<port>` 做本地联调）。
- 自定义源按 `electron-updater` 的 `generic` provider 使用：`setFeedURL({ provider: 'generic', url })`；镜像根目录下必须能取到 `latest.yml`，其中的相对 `url` 按镜像根解析。
- 只读检查器通过 `GET <mirror>/latest.yml` 解析 `version` / `files[].url` / `sha512`，失败时返回可读分类，不静默吞错。
- **信任边界要说清楚**：HTTPS + `sha512` 只能防传输损坏与中间人替换「传输内容」，不能防「镜像本身恶意替换 exe 并同步改 `sha512`」。自定义镜像等同于用户信任该镜像；官方 GitHub 是默认信任源。后续若要更强保证，需要 Ed25519 签名 `latest.yml` 或代码签名，不在本阶段做。

**错误分类**（至少覆盖）：

| 错误码 | 触发 | 用户文案方向 |
| :--- | :--- | :--- |
| `offline` / `dns` | 无网络、域名解析失败 | 检查网络/代理，可切换镜像 |
| `timeout` | 连接/读取超时 | 稍后重试或切换镜像 |
| `http_401/403` | 私有仓库/权限 | 检查 Release 可见性 |
| `http_404` | `latest.yml` 不存在 | 镜像地址不对或尚未发布 |
| `http_429` | 限流 | 稍后重试 |
| `http_5xx` | 服务端错误 | 稍后重试/切换镜像 |
| `checksum` | 下载包哈希不符 | 删除缓存后重试；仍失败则换源 |
| `signature` | 签名校验失败 | 不要安装，提示从官方渠道重新下载 |
| `feed_invalid` | `latest.yml` 字段缺失/版本不合法 | 镜像内容不完整 |
| `disk_full` / `permission` | 写入失败 | 清理磁盘/检查权限 |
| `unsupported_form` | 便携/解压/未签名 macOS | 打开发布页手动下载 |

**缓存**：只读检查结果按 `source + feedUrl` 缓存 24 小时；源变更立即失效。`electron-updater` 的下载缓存在 `%LOCALAPPDATA%\aigc-studio-updater`（以实际为准），设置抽屉提供「清除更新缓存」仅清理该目录，不碰工作区。

### 3.6 UI 与文案

- **顶栏**：新增独立更新入口（下载图标 + 红点），不再把更新提示塞进「算力」胶囊。弹层状态：检查中 / 已是最新 / 有新版本（版本号 + 发布页）/ 下载中（百分比 + 速度）/ 已下载（立即重启安装 / 退出时安装）/ 错误（错误码 + 重试 + 换源）。
- **设置抽屉 → 版本与更新**：当前版本、自动检查开关（首个正式 Release 后默认开启）、更新源（GitHub / 自定义）、镜像 URL、立即检查、上次检查时间、清除缓存、打开发布页。读写统一走 `/api/app-settings` 的 `update` 段（`updateCheck / updateSource / updateMirrorUrl`），不要落到工作区 `settings.json`。
- **文案**：中英文词典严格同构；错误文案用「用户能做什么」而不是堆错误码；`check-client-locale` 必须通过。
- **可访问性**：进度条有 `aria-valuenow`；按钮在下载/安装期间正确禁用；不要用 toast 承载需要用户决策的安装动作。

### 3.7 测试

**纯函数单测（Node，不启动 Electron）**：

- `test/update-policy.mjs`：七种形态判定、`canAutoUpdate`、`canInstallNow`（会话活跃/队列活跃/状态过期/下载未完成）、错误分类、镜像 URL 合法/非法（http、userinfo、query、超长、localhost）。
- `test/update-check.mjs` 扩展：GitHub API 与自定义 `latest.yml` 双源、缓存按源失效、`sha512` 格式校验、错误分类。
- `test/app-settings-update.mjs`（新增或并入 `settings-host.mjs`）：`GET /api/app-settings` 回 `update` 段；`POST` 可持久化 `updateCheck / updateSource / updateMirrorUrl`；非法枚举 / `http://` / 超长 URL 返回 400；重启进程后仍能读回。
- `test/check-client-update.mjs`：状态归一、按钮可用性、文案键、只读/可更新两种模式。

**主进程集成（可用 mock `autoUpdater`）**：

- `electron/updater.mjs` 接受注入的 `autoUpdater` 与 `getServerState`，用假对象触发 `checking-for-update` / `update-available` / `download-progress` / `update-downloaded` / `error`，断言状态迁移与 IPC 载荷。
- 安装护栏：假 `getServerState` 返回活跃会话，断言 `install()` 不调用 `quitAndInstall`，且返回 `session_active`。

**端到端（人工 + 脚本辅助）**：

- `tools/mock-update-feed.mjs`：本地 `generic` 源，提供 `latest.yml` + 假 exe，用于 UI 联调（不执行安装）。
- 真机升级：`0.15.0` → `0.15.1`；活跃会话拦截；便携版只读；断网/镜像错误。
- 打包冒烟：`npm run test:packaged` / `test:installer` 保持通过；新增一条「安装版启动后 10 秒内不崩溃且更新状态为 idle/up-to-date」。

### 3.8 阶段 B 验收

- [ ] NSIS 安装版：检查 → 下载 → 重启安装 → 版本更新，设置/工作区保留。
- [ ] 活跃会话/任务时「立即安装」被阻止，两个出口都可用；「退出时安装」在任务结束后执行。
- [ ] 便携版/解压版/开发态：只读提示，不下载、不安装。
- [ ] GitHub 不可达时 10 秒内给出可读错误；自定义 `https://` 镜像可完成检查与下载；非法镜像 URL 被拒绝。
- [ ] 篡改下载包或 `sha512` 时安装被拒绝，错误码为 `checksum`。
- [ ] 更新检查不影响出图主链路；安装完成后 `session.json` 不残留错误状态。
- [ ] 新增/扩展测试全绿，`check-client-locale` 同构。

---

## 4. 风险与对策

| 风险 | 影响 | 对策 |
| :--- | :--- | :--- |
| 无签名导致 `electron-updater` 拒绝安装或 SmartScreen 拦截 | 更新链路不可用/用户不敢装 | 阶段 B 第一步先做「无签名 NSIS 的最小升级 spike」，确认当前 electron-updater 版本在未配置 `publisherName` 时的行为；若仍强制校验，显式覆盖签名校验钩子并保留 `sha512`，同时 README 给出 SmartScreen 图解 |
| 镜像被篡改 | 恶意 exe | 明确信任边界；默认 GitHub；后续 Ed25519 签名清单/代码签名 |
| CI 产物命名/`latest.yml` 不一致 | 更新 404 | `verify-release.mjs` 逐项比对 URL、文件名、大小、`sha512`；失败删除 Draft |
| 双更新检查源互相覆盖 | UI 状态抖动/重复请求 | NSIS 态由主进程独占，服务端检查器禁用；只读形态才走 `/api/state.update` |
| 安装时仍有云端会话 | 配额空烧 | 安装前强制刷新 `/api/state`；活跃时禁止；`shutdown → quitAndInstall` 顺序固定 |
| 用户跨大版本升级（0.14 → 0.17） | 兼容/数据迁移 | 只保证相邻版本差分；跨版本回退到全量下载；升级前提示备份工作区 |
| 便携版用户误点更新 | 覆盖失败/文件损坏 | 形态判定禁用安装，只给下载页 |
| GitHub 在部分地区不可达 | 首次安装后无法更新 | 文档提供镜像配置；发布页同时给 Portable 直链；不硬编码第三方代理 |

---

## 5. 任务切分（建议按提交拆分）

1. **docs**：本规格 + `AUTO_UPDATE_PLAN.md` 链接 + ROADMAP 状态。
2. **build**：`package.json` 元信息/依赖/脚本、`electron-builder.yml` `publish`、`tools/verify-release.mjs`、`tools/check-release-version.mjs`。
3. **ci**：`.github/workflows/release.yml`；先 `--publish never` dry-run，再 Tag Draft。
4. **release drill**：`0.15.0` Draft → 校验 → 正式；`0.15.1` 用于真实升级演练。
5. **pure updater**：`electron/updater/policy.mjs`、`shared/update-state.js`、`server/update-source.js` + 单测。
6. **main updater**：`electron/updater.mjs`、`electron/main.mjs`、`electron/preload.cjs` + mock 集成测试。
7. **server readonly + 配置**：`server/update-check.js`、`server/update-source.js`、`server/app-config.js` 的 `update` 段、`server/routes/app-settings.js` 的 `update` 路由、`server/app.js` + 测试；同时核对 `server/settings.js` 没有把 `updateCheck` 收进工作区字段。
8. **UI**：`TopBar`、`SettingsDrawer`、`useUpdate`、词典 + 客户端测试。
9. **docs/FAQ**：SmartScreen、SHA256、便携版、镜像、故障排查。

---

## 6. 最终核对表

- [ ] Tag、`package.json`、`shared/contract.js`、应用内版本四处一致。
- [ ] Release 资产齐全且 `verify-release.mjs` 通过。
- [ ] 安装版可自动更新；便携/解压/开发态只读。
- [ ] 活跃会话拦截与「退出时安装」均验证。
- [ ] 镜像/断网/校验失败三类错误可读。
- [ ] 更新不阻塞出图，不残留会话。
- [ ] README/FAQ 完成，测试全绿。
