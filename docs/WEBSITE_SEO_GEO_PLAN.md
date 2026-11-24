# AIGC Studio 中文官网、宣传物料与 SEO / GEO 落地方案

> 阶段状态：**官网视觉与核心交互主体已完成（约 65%–70%）**。暗房光桌设计系统、首页双滚动粘性叙事、同题 2.4× 放大镜实测与首批 4 个核心页面已落地并提交（`c8704a4`）；剩余工作聚焦于「实机短片与工坊真图替换」「剩余 4 篇 SEO/GEO 种子页」「上线工程细节与域名部署」。

---

## 一、对标拆解：高转化 AI 工具官网真正起作用的机制

参考 `thunderbit.com` 的实际页面结构、`/sitemap.xml`、`/robots.txt` 与 `/llms.txt`，其效果并非依赖重型前端框架，而是三层结构协同：

1. **视觉与动效层（强辨识度 + 轻量静态性能）**
   - **鲜明视觉立场**：沿用软件本体“暗房光桌与相纸”基因（暗房/日光双主题、银盐颗粒、衬线大标题与等宽光学参数），让真实作品画幅成为视觉主角。
   - **高张力滚动叙事与微交互**：全视口幻灯机首屏、35mm 胶片长卷、垂直领域 100vh 幕帘粘性叙事、桌面工作台反色插页粘性叙事、同题 A/B 2.4× 放大镜与工坊分屏实验室，全部以纯 CSS + 轻量原生 JS 实现，零客户端水合坑。
   - **真实产品短片（待补齐）**：3–4 条 6–8 秒静音循环 MP4/WebM，用 Screen Studio 等专业录屏展示真实操作手感，替代部分静态截图。
2. **SEO 流量层（首页负责品牌与转化，长尾页承接搜索）**
   - 首页聚焦核心定位与视觉转化；自然搜索流量靠垂直长尾页（模型实测对比、硬件痛点指南、具体工作流与后处理场景）。
3. **GEO 层（面向 ChatGPT / Perplexity / Claude / AI Search）**
   - **`/robots.txt`**：明确放行 `GPTBot`、`ClaudeBot`、`PerplexityBot`、`Google-Extended`，并声明 Sitemap。
   - **`/llms.txt`**：按使用场景与问答意图编写结构化 Markdown 路由索引，写清产品边界、适用人群、支持模型、费用结构与页面直链。
   - **结构化 Schema（JSON-LD）**：`Organization`、`WebSite`、`SoftwareApplication`（含 `price: 0`）、`FAQPage`（页面可见问答与 JSON-LD 保持 1:1 一致）。

---

## 二、产品定位与文案原则（中文生图市场）

### 核心卖点提炼
- **主标题定调**：`免显卡，免配置，运行旗舰开源模型。`
- **向下打掉门槛（对比本地 ComfyUI / WebUI）**：无需 16GB/24GB 独显，不配 Python / CUDA / 节点；默认接入 Kaggle 每周 30 小时免费双卡 T4（30GB 显存），日常起步成本为 `¥0`。
- **向上拉满控制力（对比在线付费生图网站）**：不绑定平台账号、无按月订阅墙；原图、参数 `meta.json` 与版本树全部落在本地硬盘，内置资产工坊与标准 MCP Server。

### 文案红线（实战复盘补充）
- **拒绝“AI 营销腔”**：不用“前沿”“赋能”“重塑”“颠覆”“一站式”“出图不是终点”等空泛套话。
- **拒绝 AI 句式模板与参数堆砌**：避免“A、B 与 C，都在……完成”三段式排比、冒号清单体标题，以及把分辨率/耗时/费用用中点挤成一长串；区块标题保持简短书面语（`运行方式`、`同题实测`、`桌面工作台`、`资产工坊`、`方案对照`、`常见问题`），避免过于口语化的书面标题，也不把“点击图片可放大”这类操作说明塞进宣传副标题。
- **坚持事实与边界**：直白呈现耗时、显存、开源商用协议，并客观写明适用边界（例如何时依然该用 ComfyUI）。

---

## 三、当前进度总览与剩余清单

### 已完成（站点主体与视觉系统）
- [x] **暗房光桌设计系统与全站 4 页统一**（`site/src/styles/global.css`、`darkroom.css`、`editorial.css`、`domain-story.css`、`BaseLayout.astro`）：支持暗房/日光双主题本地记忆、全局大图灯箱与 4 页统一水印幕布收尾。
- [x] **首页高密度交互与双滚动粘性叙事**（`site/src/pages/index.astro`）：
  - 全视口 7 模型幻灯机首屏 + 35mm 样片胶片长卷；
  - 垂直领域全屏 100vh 幕帘粘性叙事（`DomainStory.astro`：游戏概念、3D 与建模、平面与海报、静物与人像）；
  - 同题 7 模型 A/B 对比 + 2.4× 暗房光学放大镜（`BenchCompare.astro`，已接入 4 题 × 7 模型 = 28 张真机 WebP）；
  - 桌面工作台暖白反色插页粘性叙事（全尺寸含分屏与窄屏自适应）；
  - 资产工坊多模式交互实验室（`WorkshopLab.astro`：透明棋盘格、2×2 平铺、像素网格、PBR 四通道切换）。
- [x] **真机 7×9 评测图库沉淀**：`bench-results/9dim/` 已完成 7 款模型 × 9 维真机盲测原图，并压制导出首批轻量 WebP 至 `site/public/assets/bench/` 与 `site/public/assets/domains/`。
- [x] **首批 4 个核心页面与 SEO/GEO 基础设施**：`/`、`/models`（含筛选与速度/显存排序）、`/workshop`、`/guides/free-gpu-no-comfyui`，以及 `robots.txt`、`llms.txt`、`_headers`、JSON-LD 与 `sitemap-index.xml` 静态构建通过。

### 待完成（收尾与上线阶段）
1. **线上体验与兼容性加固（上线前必做）**
   - [ ] **中文字体自托管 / 国内镜像防回退**：将 `Noto Serif SC` / `Instrument Serif` 做子集自托管或换稳定国内源，避免国内访问 `fonts.googleapis.com` 超时退回系统黑体。
   - [ ] **移动端折叠导航菜单**：为 `≤ 900px` 视口补齐抽屉导航，保证手机端可直达 `/models`、`/workshop` 与 `/guides`。
   - [ ] **按系统识别直链下载**：根据 Windows / macOS / Linux 自动突出对应安装包入口，减少普通用户在 Releases 列表页的迷失。
2. **演示素材升级（把“示意”替换为“实机产出”）**
   - [ ] **资产工坊真机前后对比图**：用 AIGC Studio 实跑 3–4 组真实原图 ↔ 透明去背 PNG / 硬边像素图 / Marigold PBR 四通道贴图，替换当前 CSS 滤镜示意；按需补充更多游戏角色三视图与 3D 材质球样片。
   - [ ] **1 条 15–20 秒核心主短片 + 3–4 条 6–8 秒静音循环短片**：用 Screen Studio 录制真实高频操作（选模型出图、提案卡、局部重绘与版本树、工坊导出）。
   - [ ] **1200×630 暗房风 OG 社交分享封面图**。
3. **补齐剩余 4 篇高意向 SEO / GEO 长尾种子页**
   - [ ] `/guides/aigc-studio-vs-comfyui`：AIGC Studio vs ComfyUI 选型对照
   - [ ] `/guides/ai-pixel-art-sprite`：游戏像素画对齐网格与序列帧 Atlas 导出指南
   - [ ] `/guides/ai-image-to-svg`：本机零显存将插画转换为可编辑 SVG 矢量图
   - [ ] `/guides/mcp-claude-cursor-image`：通过 MCP 让 Claude Desktop / Cursor 调用本地工作台生图
   - [ ] （可选）中英双语 `/en/` 路由以承接 GitHub / 海外社区流量。
4. **正式域名与自动部署**
   - [ ] 绑定正式域名后同步更新 `site/astro.config.mjs`、`site/src/data/site.ts`、`site/public/robots.txt`、`site/public/llms.txt`。
   - [ ] 接入 Cloudflare Pages / Vercel / GitHub Pages 自动部署，确认 `llms.txt`、`robots.txt` 与 `sitemap-index.xml` 线上响应头正常。

---

## 四、本地资产目录索引

- `site/`：基于 Astro 5 的正式官网工程（纯静态 SSG，输出至 `site/dist`），包含核心页面、暗房设计系统、双粘性叙事组件、28 张同题实测图与 6 张垂直领域样片，独立构建不影响主客户端与 Electron 打包。
- `bench-results/9dim/`：7 款内置模型 × 9 维评测原图与元数据 JSON，作为官网同题实测与垂直领域样片的原始素材库。
- `tools/promo/`：早期 Playwright + Remotion 自动化录屏实验脚本（含 `tools/preview/app.jsx` 的 `?clean=1` 无浮窗模式）；后续正式宣传短片建议用 Playwright 抓干净界面片段或改用 Screen Studio 人工精剪。
