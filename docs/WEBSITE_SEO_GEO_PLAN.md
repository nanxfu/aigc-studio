# AIGC Studio 中文官网、宣传物料与 SEO / GEO 落地方案

> 阶段状态：**方案已沉淀，执行暂搁置**。待桌面客户端核心 UI 趋于稳定后，再按本清单集中准备视觉素材、精修动效并正式上线。

---

## 一、对标拆解：高转化 AI 工具官网真正起作用的机制

参考 `thunderbit.com` 的实际页面结构、`/sitemap.xml`、`/robots.txt` 与 `/llms.txt`，其效果并非依赖重型前端特效，而是三层结构协同：

1. **视觉与动效层（高性价比、克制）**
   - **1 个首屏核心隐喻**：用 1 个直观动画讲清“输入什么 → 得到什么”（例如：选免费算力 → 写一句中文 → 产出高清图并落盘本地）。
   - **3–5 条真实产品短片（6–10 秒、静音循环 MP4）**：用 Screen Studio 等专业录屏工具录制干净交互并配合微缩放，再用柔和画框包裹，观感远胜纯代码拼接。
   - **轻量微交互**：角色/场景 Tab 切换、模型对比切换、平滑胶囊滑块、克制的滚动渐入；避免纯客户端水合坑。
2. **SEO 流量层（首页负责转化，长尾页承接搜索）**
   - 首页保持精炼，重点承接品牌词与转化；自然搜索流量靠垂直长尾页（模型实测对比、硬件痛点指南、具体场景工作流、免费小工具）。
3. **GEO 层（面向 ChatGPT / Perplexity / Claude / AI Search）**
   - **`/robots.txt`**：明确放行 `GPTBot`、`ClaudeBot`、`PerplexityBot`、`Google-Extended`，并声明 Sitemap。
   - **`/llms.txt`**：按使用场景与问答意图编写结构化 Markdown 路由索引，写清产品边界、适用人群、支持模型、费用结构与页面直链。
   - **结构化 Schema（JSON-LD）**：`Organization`、`WebSite`、`SoftwareApplication`（含 `price: 0`）、`FAQPage`（页面可见问答与 JSON-LD 保持 1:1 一致）。

---

## 二、产品定位与文案原则（中文生图市场）

### 核心差异化：两头通吃
- **向下打掉门槛（对比本地 ComfyUI / WebUI）**：无需 16GB/24GB 独显，不配 Python / CUDA / 节点；默认接入 Kaggle 每周 30 小时免费双卡 T4（30GB 显存），日常起步成本为 `¥0`。
- **向上拉满控制力（对比在线付费生图网站）**：不绑定平台账号、无按月订阅墙；图片与参数 `meta.json` 100% 落盘本地硬盘，按版本树管理，并内置资产工坊（去背、转 SVG、像素对齐、序列帧切片、无缝平铺、PBR 四通道）与标准 MCP Server。

### 文案红线
- **拒绝“AI 营销腔”**：不用“前沿”“赋能”“重塑”“颠覆”“一站式全链路”“释放无限创意”等空泛修饰词。
- **坚持事实与数字**：直接写 `Kaggle 免费 30h/周双 T4`、`4 步 / 6.8 秒`、`费用 ¥0`、`MIT 开源`、`4 项工坊本机 0 GPU 直算`，并客观写出适用边界（例如何时更应该用 ComfyUI）。
- **宣传节奏聚焦主卖点**：短片与首屏不铺流水账功能，先打透“3 步就能零成本出图 + 本地掌控”，把资产工坊与 MCP 作为加分项收口。

---

## 三、正式开工前的 4 项物料准备清单

后续重启官网与宣传时，按此顺序准备投入产出比最高：

1. **视觉与演示素材（决定 80% 质感，建议等 UI 定型后统一制作）**
   - **1 条 15–20 秒核心主短片**：用 Screen Studio 录真实操作 + 选一首贴合调性的版权/商用强节奏 BGM 人工精剪，主线只讲“零显卡 · 3 步出图 · 费用 ¥0”。
   - **3–4 条 6–8 秒官网板块循环短片（静音 MP4/WebM）**：分别展示「选模型出图」「AI 提案卡」「就地二创与版本树」「资产工坊一键转 SVG/去背」。
   - **9 维真机盲测对比图**：利用 `README.md` 已有的 9 个评测提示词，跑出 7 款内置模型的横向对比原图。
2. **核心页面与文案定稿**
   - 首页：Hero（核心定位 + 主演示）→ 4 项硬事实 → 3 步工作原理 → 真实界面多视图切换 → 7 款模型实测 → 资产工坊 → 三方客观对比表（`AIGC Studio` vs `本地 ComfyUI` vs `在线付费网站`）→ FAQ → 下载 CTA。
3. **首批高意向 SEO / GEO 种子页（先做 6–8 篇验证流量，不盲目铺量）**
   - `/models`：7 款内置开源生图模型实测对比（耗时、显存、中英支持、商用许可、9 维样张）
   - `/guides/free-gpu-no-comfyui`：没有高显存显卡，如何免配 ComfyUI 免费跑 FLUX.2 和 Qwen-Image？
   - `/guides/aigc-studio-vs-comfyui`：AIGC Studio vs ComfyUI：创作者该怎么选？
   - `/workshop`：AI 出图后的 6 项本地后处理（去背、SVG、像素对齐、序列帧、平铺、PBR）
   - `/guides/ai-pixel-art-sprite`：AI 生成游戏像素画如何自动对齐像素格并导出序列帧 Atlas？
   - `/guides/ai-image-to-svg`：免 GPU 本地把 AI 插画一键转可编辑 SVG 矢量图
   - `/guides/mcp-claude-cursor-image`：通过 MCP 让 Claude Desktop / Cursor 直接调用本地工作台生图
4. **技术选型与上线配置**
   - **推荐架构**：**Astro（纯静态 SSG）**，零 Hydration 报错、首屏直出完整 HTML、天然适配 Cloudflare Pages / Vercel / GitHub Pages；若后期要做大量高交互在线免费小工具引流，再局部挂载 React Islands 或迁移 Next.js。
   - **上线三件套**：绑定正式域名后同步更新 `site`、`robots.txt`、`llms.txt`、`sitemap-index.xml`，以及 `public/_headers`（确保 `llms.txt` / `robots.txt` 带 `charset=utf-8`）。

---

## 四、当前本地原型资产记录（供后期参考或清理）

本轮探索已在本地留下两个独立实验目录，均不影响主工程构建与 Electron 打包：

- `site/`：基于 Astro 5 的中文官网 MVP 骨架（含首页、`/models`、`/workshop`、`/guides/free-gpu-no-comfyui`、`robots.txt`、`llms.txt` 与静态构建验证），后期可直接推倒重做视觉，或直接复用其中的数据层（`site/src/data/site.ts`）与 SEO/GEO 配置。
- `tools/promo/`：基于 Playwright + Remotion 的自动化录屏/合成实验脚本（含 `tools/preview/app.jsx` 新增的 `?clean=1` 无浮窗预览参数）。程序合成 BGM 与模板节奏达不到自媒体成片水准，后续可仅保留 Playwright 自动抓干净界面片段的能力，或改用 Screen Studio 人工精剪。
