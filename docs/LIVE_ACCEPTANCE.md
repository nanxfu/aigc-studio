# 真机验收手册（M2）

> 关联：[`ROADMAP.md`](ROADMAP.md) 的 M2 里程碑、[`MIGRATION_NOTES.md`](MIGRATION_NOTES.md) §9、
> 排障手册：[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
> 适用版本：`0.14.0`（Phase 1 + M1.5 + M2 交付）

本手册把「真机出图回归」拆成可重复执行的步骤：**环境探测 → 调度链路 → 真实 GPU 推理 →
安装包形态 → 人工交互清单**。除人工清单外都有对应命令与机器可判定的结果，验收记录直接引用
命令输出即可。

---

## 1. 范围

| 类别 | 覆盖内容 | 判定方式 |
| :--- | :--- | :--- |
| A. 云端算力 | Kaggle 直连 / CLI、Colab；凭据登录、唤醒、隧道会合、握手、推理、关机 | 命令退出码 + `report.json` |
| B. 安装包形态 | NSIS 安装版、便携版：安装、启动、有图工作区渲染、卸载 | `test/smoke-installer.mjs` / `test/smoke-packaged.mjs` |
| C. 人工交互 | 托盘保活、彻底退出、桌面通知、任务栏角标、文件夹定位、工作区切换 | 清单逐项打勾（§7） |

Colab 走 Google OAuth，需要浏览器里人工授权，自动化只覆盖到「授权状态读取」；
首次授权仍需按 §7 的人工步骤确认。

---

## 2. 前置条件

- Windows 10/11 x64；源码形态另需 Node.js ≥ 20，安装包形态只用安装包。
- **Kaggle 凭据**（二者任一即可）：
  - 直连模式（默认、推荐）：`%USERPROFILE%\.kaggle\credentials.json`（工作台「设置 → 云端 →
    Kaggle 登录」用内置 OAuth 生成，access token 过期会自动续期）；
  - CLI 模式：本机安装并 `kaggle` 登录（`%USERPROFILE%\.kaggle\kaggle.json`）。
- Kaggle 账号已绑定手机号并开启 GPU 加速器，当日 GPU 配额充足（一轮文生图验收约消耗
  10 分钟 GPU 配额；`--inpaint` / `--outpaint` / `--reference` 各自另起 Kernel）。
- 网络能访问 `api.kaggle.com`、`trycloudflare.com`、`ntfy.sh`；本机若走代理，
 可在 shell 里设置 `HTTPS_PROXY` / `HTTP_PROXY`（Node `fetch` 失败时客户端会自动降级 `curl`）。
- 验收前**退出所有 AIGC Studio 实例**：单实例锁会让冒烟进程直接失败
  （`SMOKE_FAIL another-instance-running`）。

---

## 3. 步骤一：环境探测（只读，不消耗 GPU 配额）

```powershell
npm run kaggle:probe          # 等价 node tools/probe-kaggle.mjs
node tools/probe-kaggle.mjs --json   # 机器可读，退出码 0=鉴权正常 / 2=鉴权失败
```

判读：

- `鉴权：正常` 且 `GPU 配额` 有剩余 → 可以继续；
- `auth_required` → 在工作台重新登录 Kaggle，或检查 `credentials.json` / `kaggle.json`；
- `GPU 配额：不可用` → 账号未绑定手机号或未启用 GPU，先到 Kaggle 账号设置里开通。

---

## 4. 步骤二：调度链路（CPU 探针 Kernel，不占 GPU 配额）

```powershell
node test/kaggle-live.mjs          # 正常结束时自动 DeleteKernel
node test/kaggle-live.mjs --keep   # 保留 Kernel 观察，结束前手动关机
```

脚本推的是 `test/tunnel-probe.py`（CPU、不加载模型），验证 **push → 容器启动 →
cloudflared 隧道 → ntfy 上报 → Host 握手 → `/health` → `/generate` → 关机** 整条链路。
预期结尾输出：

```
链路验证通过：push → 隧道 → 握手 → 生成 → 关机
```

失败排查：排队超时（`queue_timeout`）见 TROUBLESHOOTING §4；镜像出网（`tunnel_failed`）
见同一章；账号无 GPU 时本步仍应通过（探针 `enableGpu: false`）。

> 排障提示：脚本异常退出时 Kernel 可能仍在运行，到 Kaggle「Your Work → Code」删除，
> 或在工作台「云端」面板点「彻底退出」。

---

## 5. 步骤三：真实 GPU 推理验收

每个命令都会新推一个 Kernel 并按 Kaggle 配额计费；报告与样张写入
`bench-results/gpu-live/<时间戳>/`（已在 `.gitignore`，仅本地留存）。

### 5.1 文生图（必做）

```powershell
node test/gpu-live.mjs
# 指定提示词 / 预设：
node test/gpu-live.mjs --prompt "…" --preset sdxl-lightning
```

通过标准：退出码 0；`report.json` 的 `models[]` 记录加载秒数、出图秒数、出图宽高与 PNG 字节数；
样张 `01.png` 可正常打开。

### 5.2 图片工具与参考生图（按需逐项）

```powershell
node test/gpu-live.mjs --inpaint                          # 局部重绘（含 from_pipe 显存复用对比）
node test/gpu-live.mjs --inpaint --strength-compare 0.9,1.0
node test/gpu-live.mjs --upscale                          # 高清放大（输出 = 源图 ×2）
node test/gpu-live.mjs --preset sdxl-inpaint --source-preset sdxl-lightning --outpaint
node test/gpu-live.mjs --preset flux2-klein-4b --reference   # 多图参考（1~2 张）
node test/gpu-live.mjs --c1-acceptance                    # 单 Kernel 内跑完参考生图 + 加速 A/B + 扩图 A/B
```

通过标准：退出码 0；`report.json` 对应段（`inpaint` / `upscale` / `outpaint` / `reference` /
`accel` / `outpaintLora`）里的断言全部成立；样张肉眼检查无接缝、蒙版区确实按新提示词重写。

### 5.3 页面级联调（可选，人工）

用安装版启动、在「创作设置」里点「唤醒」，按 §7 的清单在真实 UI 上走一遍文生图 / 图片工具 /
切换工作区；服务端链路已由 5.1~5.2 覆盖，这一步确认前端与真实后端的组合行为。

---

## 6. 步骤四：安装包形态验收

```powershell
npm run dist                                       # 产出 release/aigc-studio-<版本>-x64.exe 与 -portable.exe

npm run test:packaged                              # win-unpacked 目录形态（10 项）
npm run test:installer                             # NSIS 静默安装 → 冒烟 → 静默卸载（9 项）
npm run test:packaged -- --exe "release/aigc-studio-0.14.0-portable.exe" --timeout 240000
```

`test:packaged` 校验：打包布局（`resources/app/server/standalone.js`、`dist/web/index.html`、
`worker/daemon.py`、`models/`）、应用版本、`/api/state` 探针、有图工作区图片解码、
非空白截图、退出无残留进程。
`test:installer` 额外校验：静默安装退出码、安装目录结构、Windows 版本资源
（ProductName / FileVersion）、卸载后目录清理。

> **portable 版没有 stdout**：NSIS 自解压外壳另行拉起窗口进程，调用方的管道收不到
> `SMOKE_OK`。主进程会把自检结果同时写到 `<capture>.json`（`electron/main.mjs`
> `writeSmokeResultFile`），验收脚本自动回退读取该文件。

---

## 7. 人工交互清单（桌面端）

准备：安装版启动；Kaggle 已登录；在「设置」里选好工作区。以下每项在真实会话上逐条确认：

| # | 项目 | 操作 | 预期 |
| :--- | :--- | :--- | :--- |
| 1 | 会话唤醒 | 点「云端 → 唤醒」 | 状态从排队 → 隧道 → 就绪；顶栏显示设备与模型 |
| 2 | 文生图 | 输入提示词点「生成」 | 舞台出图、作品条新增、`outputs/<stamp>-<jobId>/` 落盘 |
| 3 | 后台通知 | 窗口最小化/隐藏后提交生成 | 完成后收到 Windows 桌面通知 |
| 4 | 任务栏角标 | 连续提交 2 个任务 | 任务栏显示排队数量；清零后角标消失 |
| 5 | 文件夹定位 | 舞台工具条「在文件夹中显示」 | 资源管理器高亮该产物文件 |
| 6 | 托盘保活 | 会话活跃时点窗口关闭按钮 | 窗口最小化到托盘而非退出；托盘菜单可见 |
| 7 | 彻底退出 | 托盘右键「彻底退出」 | 等待会话状态持久化后退出；Kaggle 端 Kernel 被删除 |
| 8 | 工作区切换 | 顶栏切换工作区 | 历史/收藏刷新，旧工作区图片不残留；未提交提示词保留 |
| 9 | 设置持久化 | 改语言/主题/LLM 配置后重启 | 设置保留；API Key 只显示「已保存」不显示原文 |

---

## 8. 验收记录

### 2026-11-21（M2，Windows 11 x64 / Node 24.19.0 / Electron 44.11.5）

| 项 | 命令 | 结果 |
| :--- | :--- | :--- |
| Kaggle 环境探测 | `npm run kaggle:probe` | ✅ 直连鉴权正常（账号 mogudd），GPU 配额 30h 未使用 |
| 调度链路（CPU 探针） | `node test/kaggle-live.mjs` | ✅ push → 排队 → 隧道 → 握手 → `/generate` → 关机，exit 0 |
| 文生图（真实 GPU） | `node test/gpu-live.mjs` | ✅ exit 0：2×Tesla T4，1024² 出图 9.69s（详见下节） |
| 局部重绘（真实 GPU） | `node test/gpu-live.mjs --inpaint` | ✅ exit 0：`from_pipe` 复用底座零加载，重绘 9.02s（详见下节） |
| 高清放大（真实 GPU） | `node test/gpu-live.mjs --upscale` | ✅ exit 0：1024²→2048²，放大推理 1.39s（详见下节） |
| 扩图（真实 GPU） | `node test/gpu-live.mjs --outpaint-lora` | ✅ exit 0：1536×864，绿边残留 0，推理 20.7s（详见下节） |
| 参考生图（真实 GPU） | `node test/gpu-live.mjs --preset flux2-klein-4b --reference` | ✅ exit 0：确定性 MAE 0，显存零增长（详见下节） |
| 安装包构建 | `npm run dist` | ✅ NSIS 安装包与便携版产出（见 §9 产物清单） |
| win-unpacked 形态 | `npm run test:packaged` | ✅ 10/10 通过 |
| 安装 → 冒烟 → 卸载 | `npm run test:installer` | ✅ 9/9 通过 |
| 便携版形态 | `npm run test:packaged -- --exe …-portable.exe` | ✅ 8/8 通过 |
| 托盘保活 / 彻底退出 / 通知 / 角标 | §7 清单 | ⏸ 需要人工在真实会话上确认 |

### GPU 推理

**文生图（2026-11-21，`node test/gpu-live.mjs`，exit 0）**

| 项 | 实测值 |
| :--- | :--- |
| Kernel | `mogudd/imagen-d806c4ff`（排队约 10 分钟，期间自动换新实例重排 2 次后拿到 GPU） |
| 设备 | Kaggle 2×Tesla T4；Python 3.13.16 / torch 2.11.0+cu130 / diffusers 0.43.0 / transformers 5.23.0 |
| 模型 | `sdxl-lightning`（`stabilityai/stable-diffusion-xl-base-1.0` + `ByteDance/SDXL-Lightning` LoRA） |
| 冷启动 | 预下载 35.3s + 加载 53.3s（`from_pretrained` + LoRA 挂载到 CUDA） |
| 出图 | 1024×1024 / 4 步 / CFG 0 / seed 42，**9.69s**，PNG 1,206,607 字节 |
| 显存 | allocated 6991 MiB / reserved 7008 MiB / max 6991 MiB |
| 关机 | `absent`（daemon shutdown 后 Kernel 转 COMPLETE） |
| 报告与样张 | `bench-results/gpu-live/2026-11-21T11-45-45/`（`report.json` + `01.png`） |

样张（`bench-results/gpu-live/2026-11-21T11-45-45/01.png`）：

![文生图：仙鹤与雾中荷塘](assets/live-acceptance/text2img-crane-2026-11-21.webp)

**局部重绘（2026-11-21，`node test/gpu-live.mjs --inpaint`，exit 0）**

| 项 | 实测值 |
| :--- | :--- |
| Kernel | `mogudd/imagen-06d8357d`（本次推送后直接进入隧道握手，无排队等待） |
| 流程 | 同会话内先文生图 1024²（12.77s），再用程序化矩形蒙版（中心 40%，覆盖率 16.03%，羽化 8px）重绘 |
| 重绘参数 | `strength=0.6`、seed 44、4 步、提示词「a bright red paper lantern floating on the water」 |
| 出图 | 1024×1024，**9.02s**，PNG 1.20 MB；蒙版区平均差异 9.53/255（强度 0.6 时按 `int(steps×strength)=2` 步执行，属弱改写，与 MIGRATION_NOTES 历史结论一致） |
| 显存复用 | `from_pipe` 复用已加载底座：`reusedBasePipeline=true`、重绘加载 0s；allocated 7000→7000 MiB、max_allocated 10233 MiB 不变、reserved +4 MiB（噪声） |
| 合成 | 未涂抹区域逐像素保留原图（worker 日志「已按蒙版合成」） |
| 关机 | `absent` |
| 报告与样张 | `bench-results/gpu-live/2026-11-21T11-49-20/`（`report.json`、`01.png`、`02-inpaint.png`） |

样张（蒙版重绘后）：

![局部重绘：蒙版区重写](assets/live-acceptance/inpaint-lantern-2026-11-21.webp)

**高清放大（2026-11-21，`node test/gpu-live.mjs --upscale`，exit 0）**

| 项 | 实测值 |
| :--- | :--- |
| Kernel | `mogudd/imagen-5bfe7e8a`（排队 13 分钟，自动换新实例 3 次后拿到 GPU） |
| 流程 | 先文生图 1024²（11.46s），再以该图为源发 `tool=upscale` |
| 放大 | 1024×1024 → **2048×2048**（factor 2 断言通过）；放大推理 1.39s、加载 2.17s、PNG 4.01 MB |
| 显存 | 放大后 reserved 10776 → 7030 MiB（-3746 MiB，Real-ESRGAN 显存占用低于扩散底座），max_allocated 10233 MiB 不变 |
| 关机 | `absent` |
| 报告与样张 | `bench-results/gpu-live/2026-11-21T12-09-12/`（`report.json`、`01.png`、`02-upscale.png`） |

样张（2048² 缩小到 1024 展示）：

![高清放大 2×](assets/live-acceptance/upscale-2x-2026-11-21.webp)

**扩图（2026-11-21，`node test/gpu-live.mjs --outpaint-lora`，exit 0）**

| 项 | 实测值 |
| :--- | :--- |
| Kernel | `mogudd/imagen-c7836aa2`（排队 10 分钟，自动换新实例 1 次后拿到 GPU） |
| 引擎 | `flux2-klein-4b` + `fal/flux-2-klein-4B-outpaint-lora`（scale 1.1），源图内容由 `sdxl-lightning` 生成 |
| 流程 | 864×864 内容居中放入 1536×864 纯绿画布（绿边覆盖率 43.75%），等比缩到 1024×576 作为参考图提交 |
| 结果 | 输出严格 1536×864；**绿边残留 exact 0 / near 0**；接缝比 1.15 / 1.14（无硬接缝）；内容区平均差 12.87（对源图）；颜色漂移 max 3.47 |
| 耗时 | LoRA 加载 34.4s、推理 20.7s；对比 sdxl-inpaint 历史中位 35.42s，**提速 1.71×** |
| 显存 | 提交前 reserved 9736 MiB → 提交后 11220 MiB（+1484 MiB，LoRA + 大画布），max_allocated 10701 MiB |
| 关机 | `absent` |
| 报告与样张 | `bench-results/gpu-live/2026-11-21T12-24-34/`（`report.json`、源图 / 画布 / 参考图 / 成图 4 张 PNG） |

成图（1536×864）：

![扩图：FLUX.2 Klein + 扩图 LoRA](assets/live-acceptance/outpaint-lora-2026-11-21.webp)

**参考生图（2026-11-21，`node test/gpu-live.mjs --preset flux2-klein-4b --reference`，exit 0）**

| 项 | 实测值 |
| :--- | :--- |
| Kernel | `mogudd/imagen-5ab9a7dd`（排队 10 分钟，自动换新实例 2 次后拿到 GPU） |
| 模型 | `flux2-klein-4b`（`black-forest-labs/FLUX.2-klein-4B`，`supportsReference=true`），与源图同一会话复用已加载管线 |
| 用例 | 1 张参考图 ×2 轮（同 seed）、2 张参考图 ×1 轮、1 张参考图 + 1280×720 画幅保持，最后补一次纯文生图核对显存 |
| 结果 | 1 参考图 23.72s / 25.48s（两轮输出逐像素一致，**确定性 MAE 0**）；2 参考图 50.92s；1280×720 画幅保持 `framePreserved=true` |
| 参考影响度 | `referenceEffectMae=7.71`（参考图确实改变出图）、`oneVsTwoRefsMae=1.99`（单/双参考图差异可见） |
| 显存稳定 | 复用管线 `loadSeconds=0`；全程 allocated 7680 MiB / max_allocated 7928 MiB 不变，`noGrowth=true` |
| 关机 | `absent` |
| 报告与样张 | `bench-results/gpu-live/2026-11-21T12-40-47/`（`report.json` + 7 张 PNG） |

样张（2 张参考图生图）：

![参考生图：2 张参考图](assets/live-acceptance/reference-2refs-2026-11-21.webp)

---

## 9. 本轮产物与证据

| 产物 | 说明 |
| :--- | :--- |
| `release/aigc-studio-0.14.0-x64.exe` | Windows NSIS 安装包（可选安装目录、创建快捷方式） |
| `release/aigc-studio-0.14.0-portable.exe` | 便携版（自解压运行，不写安装目录） |
| `release/win-unpacked/` | 免安装目录形态（`npm run pack` 亦可产出） |
| `bench-results/gpu-live/<时间戳>/` | 真机 GPU 报告与样张（本地保留，不入库） |

安装包未做代码签名：Windows SmartScreen 首次可能提示「未知发布者」，属于本地构建的预期行为；
对外分发前需补证书（见 `MIGRATION_NOTES.md` 遗留项）。

---

## 10. 失败处置

| 现象 | 处置 |
| :--- | :--- |
| 冒烟 `another-instance-running` | 退出所有 AIGC Studio 窗口/托盘实例后重跑 |
| `test:installer` 静默安装退出码非 0 | 看 `%TEMP%\aigc-installer-*`（`--keep` 保留目录）与安装包日志；确认系统未拦截 |
| 卸载后目录残留 | 一般是文件被占用（杀毒/索引）；确认无 AIGC Studio 进程后重试卸载 |
| Kaggle 排队超时 / 隧道失败 | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) §4；`gpu-live.mjs --max-queue-minutes` 可自动换实例重排 |
| 镜像拉取或 pip 安装失败 | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) §1~§2 |
| 模型下载失败 / 显存不足 | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) §3 |
| 直连鉴权失败 | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) §9（直连模式与内置 OAuth 登录） |
