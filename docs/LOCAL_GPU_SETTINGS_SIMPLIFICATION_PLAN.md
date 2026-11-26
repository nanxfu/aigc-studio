# 本机 GPU 设置面板精简设计方案

> **定位**：收敛设置抽屉中「算力来源 → 本机 GPU」的信息密度与交互边界，保持与 `Salad` / `商业生图 API` / `私有 Worker` 一致的克制产品体验。
> **上位文档**：[`LOCAL_GPU_VULKAN_PLAN.md`](LOCAL_GPU_VULKAN_PLAN.md)（§4.3 Host 接入与配置）。
> **制定日期**：2026-11-25。
> **状态**：已完成（2026-11-26）。

> **2026-11-26 distill 实现补充**：以下 §2–§5 保留最初方案记录。当前正式界面以代码和本节为准：模型下载与切换已由顶栏模型卡承接，不再渲染自定义引擎 / 模型 / VAE 路径。
>
> 所有算力来源统一默认收进「更换算力」，摘要显示当前选中来源；选择来源后立即收起列表并展示专属设置，保存与重新打开后保持同一行为。列表的小绿灯标记已保存的当前来源，选中边框表示本次选择，保存成功后绿灯才更新。本机 GPU 面板只显示一次引擎状态，将显卡名称、显存建议、适配档位与检测按钮合并为一行，并将共享模型目录默认折叠为「目录名称 + 已占用空间」。展开后仍可编辑、选择目录、恢复默认；「本机模型」页保留原有展开式控件。
>
> 删除的是重复状态、嵌套卡片和重复路径读数。引擎准备、取消、进度、失败重试、显卡检测、算力切换和目录保存功能均保留。目录即时保存与抽屉底部算力设置保存继续各自使用原有接口。
>
> 选择列表与专属设置互斥：展开「更换算力」时不在列表底部展示当前来源的设置面板或高级控件；点击任一来源（含当前来源）后才进入其设置。
>
> 验证：算力与本机 GPU 客户端回归 15/15、全部客户端检查 29/29 步、中英文文案检查与生产构建通过；真实浏览器覆盖 1440×900、768×900、390×844，以及目录键盘编辑、算力切换、取消和重试。六种来源均验证保存前后折叠行为一致，保存失败不更新绿灯。此前 distill 全量测试 76/77 步通过，唯一失败为当时范围之外的 `web/studio/workshop/workshopState.js` 中 `/api/file` 路径字面量契约检查。

---

## 1. 现状问题（第一性原理审视）

对照 [`web/studio/settings/SettingsLocalGpuSection.jsx`](../web/studio/settings/SettingsLocalGpuSection.jsx) 及后端 [`server/local-gpu/setup.js`](../server/local-gpu/setup.js)、[`server/local-gpu/config.js`](../server/local-gpu/config.js)，当前面板第一屏平铺了 **12 项信息与控件**，存在三类错位：

1. **把“内建托管能力”做成了“手工运维面板”**：
   - Windows x64 客户端已内置 `sd-server.exe`（`useBundledEngine`），且 `setup.js` 已能一键校验显卡与磁盘空间并自动下载模型与 VAE。
   - 前端却把 `sd-server 可执行文件`、`默认 GGUF 模型权重`、`VAE 文件（可选，建议 fp16-fix）` 三个文件路径输入框直接暴露在第一屏；组件里甚至计算了 `managedEngine` 却未使用。
   - 更矛盾的是，[`setup.js`](../server/local-gpu/setup.js#L104-L108) 一旦检测到用户写入过手动路径，就会拦截自动准备并提示「已有手动 GPU 配置。请先在**高级设置**中清空旧模型路径」——后端将其定位为“高级设置”，前端却放在了主屏。
2. **把底层推理引擎参数抛给了普通创作者**：
   - `权重内存策略`（`paramsBackend`：`disk` vs `cpu`）、`空闲卸载权重（秒）`（`idleTimeoutSec`）、`开启 VAE 分块解码`（`vaeTiling`）本质是 `sd-server` 命令行调优参数。
   - [`runtime.js`](../server/local-gpu/runtime.js#L138-L143) 已经定义了实测安全的默认值（`disk`、`vaeTiling: true`、`300` 秒）；普通用户既不理解这些概念，也不应在切换算力来源时被迫做工程调优。
3. **术语泄露与同级风格不一致**：
   - 主视图直接出现 `stable-diffusion.cpp（Vulkan / GGUF）`、`sd-server / vulkaninfo`、`fp16-fix` 以及 `local-gpu.json` 的磁盘绝对路径。
   - 相较之下，[`SettingsSaladSection.jsx`](../web/studio/settings/SettingsSaladSection.jsx) 隐藏了卡池选型，[`SettingsCloudApiSection.jsx`](../web/studio/settings/SettingsCloudApiSection.jsx) 默认折叠接口地址，[`SettingsWorkerSection.jsx`](../web/studio/settings/SettingsWorkerSection.jsx) 隐藏了空闲超时；唯独 `local-gpu` 把内部配置全量展开。

---

## 2. 收敛原则（方案 A：极简主视图 + 折叠自定义路径）

回到用户使用「本机 GPU」时的真实目标：**只关心“电脑显卡能不能跑、怎么一键启用、现在就绪了没有”**。

1. **主视图只留用户关心的 3 件事**：状态定位、一键启用/就绪摘要、轻量显卡检测。
2. **自定义路径默认收起**：仅少数自带模型文件、源码调试或非自动准备环境的用户需要指定路径，统一收进默认折叠的「自定义路径」区。
3. **底层调优参数退出 UI**：`paramsBackend`、`idleTimeoutSec`、`vaeTiling`、`threads`、`extraArgs` 及 `local-gpu.json` 文件路径从界面移除，继续保留在 `local-gpu.json` 与 `AIGC_STUDIO_LOCAL_GPU_*` 环境变量中供排障使用，后端契约零破坏。
4. **去除内部工程术语**：界面文案不出现 `stable-diffusion.cpp`、`sd-server`、`vulkaninfo`、`GGUF`、`fp16-fix`、`local-gpu.json` 等实现细节词。

---

## 3. 目标信息架构与分层规格

### 3.1 主视图（默认可见）

| 区块 | 显示条件 | 展示内容与交互 |
| :--- | :--- | :--- |
| **头部摘要** | 常驻 | 标题「本机 GPU」、副标题「使用当前电脑显卡离线生图，数据全程不出本机」、状态徽章（`已就绪` / `未配置`） |
| **环境变量接管提示** | `view.overrideByEnv === true` | 精简提示当前本机 GPU 配置由系统环境变量接管 |
| **一键启用卡片** | `setup?.supported && (!configured \|\| setupBusy \|\| setup?.phase === 'error' \|\| setup?.requiresSwitch)` | 保留现有准备流程：预计下载体积、模型盘可用空间、「下载并启用 / 重试 / 切换并连接 / 取消下载」、实时进度与报错 |
| **就绪摘要** | `configured === true`（且不在准备流程中） | 一行精简摘要：当前已就绪模型（优先显示 `view.modelName`）+ 提示「模型可在创作页顶栏切换」 |
| **显卡检测行** | 常驻 | 「检测本机显卡」按钮（调 `POST /api/local-gpu/probe`，返回显卡名称或明确失败原因）+「查看硬件适配」跳转按钮（`onOpenLocalModels`，跳转「本机模型」页） |

### 3.2 折叠区：「自定义路径」（默认收起）

交互样式对齐 [`SettingsCloudApiSection.jsx`](../web/studio/settings/SettingsCloudApiSection.jsx) 的可折叠接口地址区或 [`SettingsAdvancedSection.jsx`](../web/studio/settings/SettingsAdvancedSection.jsx) 的折叠开关：

- **默认状态**：收起；仅在 `setup?.supported === false` 且 `!configured`（如非 Windows x64 自动安装环境或未打包引擎的开发态）时可默认展开，确保无自动安装入口时用户仍能看到配置方式。
- **展开后仅保留 3 个路径项**（均支持桌面端原生文件选择）：
  1. `自定义模型文件`（`form.modelPath`）
  2. `自定义 VAE 文件（可选）`（`form.vaePath`）
  3. `推理引擎文件`（`form.serverPath`；若 `view.useBundledEngine === true` 或 `setup?.supported === true`，提示「留空即使用内置引擎」）
- **引导提示**：当已有自定义路径导致自动准备不可用时，折叠区提示「清空自定义路径后保存，可恢复自动下载与托管」。

---

## 4. 字段去留总表（向后兼容说明）

| 字段 | 现况 | 调整后位置 | 后端行为（`config.js` / `runtime.js`） |
| :--- | :--- | :--- | :--- |
| 一键准备 (`setup`) | 主视图 | **保留在主视图** | 不变 |
| 环境检测 (`probe`) | 主视图 | **保留在主视图**（简化文案） | 不变 |
| `modelPath` | 主视图 | **移入折叠「自定义路径」** | 不变 |
| `vaePath` | 主视图 | **移入折叠「自定义路径」** | 不变 |
| `serverPath` | 主视图 | **移入折叠「自定义路径」** | 不变 |
| `paramsBackend` | 主视图下拉框 | **从 UI 移除** | 保持默认 `'disk'`；仍支持 `local-gpu.json` / `AIGC_STUDIO_LOCAL_GPU_PARAMS_BACKEND` |
| `idleTimeoutSec` | 主视图数字框 | **从 UI 移除** | 保持默认 `300`；仍支持 `local-gpu.json` / `AIGC_STUDIO_LOCAL_GPU_IDLE_SEC` |
| `vaeTiling` | 主视图复选框 | **从 UI 移除** | 保持默认 `true`；仍支持 `local-gpu.json` / `AIGC_STUDIO_LOCAL_GPU_VAE_TILING` |
| `view.configPath` | 主视图底部文本 | **从 UI 移除** | `/api/local-gpu/config` 字段保留，不渲染在界面 |

---

## 5. 实施与验收清单（待执行时按此推进）

1. **表单状态逻辑**：精简 [`web/logic/localGpu.js`](../web/logic/localGpu.js) 中的 `localGpuFormOf` / `buildLocalGpuPatch`，移除 `paramsBackend`、`idleTimeoutSec`、`vaeTiling` 的表单字段与脏检查；同步调整 [`web/studio/SettingsDrawer.jsx`](../web/studio/SettingsDrawer.jsx#L307-L312) 的 `probeLocalGpuConfig` 入参（无需再从表单传 `paramsBackend`）。
2. **视图组件**：重构 [`web/studio/settings/SettingsLocalGpuSection.jsx`](../web/studio/settings/SettingsLocalGpuSection.jsx)，按 §3 拆分主视图与折叠「自定义路径」区。
3. **中英文词典**：同步精简与去术语化 [`web/dict/zh.js`](../web/dict/zh.js) 与 [`web/dict/en.js`](../web/dict/en.js) 中 `studio.settings.localGpu.*` 文案，确保两份词典键集合一致。
4. **客户端回归测试**：更新 [`test/check-client-local-gpu.mjs`](../test/check-client-local-gpu.mjs) 对设置页默认态、折叠区展开后修改自定义路径保存、以及不再展示底层参数的断言。
5. **验收命令**：实施后运行 `node test/check-client-local-gpu.mjs` 与 `npm test` 验证通过。
