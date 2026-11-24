# AIGC Studio 中文官网

基于 **Astro 5（纯静态 SSG）** 构建的产品官网与 SEO / GEO 站点。

## 本地预览与构建

```powershell
Set-Location d:\document\development\aigc-studio\site

# 本地开发预览（http://localhost:4321）
npm run dev

# 静态构建（输出到 site/dist，含 sitemap-index.xml、robots.txt、llms.txt）
npm run build
```

## 托管到 Cloudflare Pages（推荐）

1. 在 Cloudflare Dashboard 进入 **Workers & Pages → Create → Pages → Connect to Git**，选择仓库。
2. 构建配置如下：
   - **Root directory**：`site`
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`
   - **Environment variables**：
     - `NODE_VERSION` = `22`（`site/.node-version` 亦已声明为 `22`）
     - `PUBLIC_SITE_URL` = `https://aigc-studio-8rj.pages.dev`（或日后绑定的正式域名）
     - （可选）`PUBLIC_CF_BEACON_TOKEN` = Cloudflare Web Analytics Token（统计 PV / 来源 / 页面路径，免 Cookie）
     - （可选）`PUBLIC_UMAMI_WEBSITE_ID` = Umami Cloud Website ID（统计自定义 `download-client` 下载按钮点击事件，含 `os` / `page` / `slot` 属性）
     - （可选）`PUBLIC_UMAMI_SCRIPT_URL` = 自建 Umami 脚本地址（默认 `https://cloud.umami.is/script.js`）
3. 无需修改任何源码，`canonical`、`og:image`、JSON-LD、`sitemap-index.xml`、`robots.txt` 与 `llms.txt` 均会自动跟随 `PUBLIC_SITE_URL` 生成；若暂用 `*.pages.dev` 过渡，可先不提交 Google/Bing 收录，待日后绑定独立域名后再统一提交 `sitemap-index.xml`。
4. 如需从本机直接部署验证：

```powershell
Set-Location d:\document\development\aigc-studio\site
$env:PUBLIC_SITE_URL = "https://aigc-studio-8rj.pages.dev"
npm run build
npx wrangler pages deploy dist --project-name aigc-studio-site
```

## 上线后必做验收

```powershell
curl.exe -I https://<你的域名>/llms.txt
curl.exe -I https://<你的域名>/robots.txt
curl.exe -I https://<你的域名>/sitemap-index.xml
curl.exe -I https://<你的域名>/assets/og-cover.png
```

确认 `/llms.txt` 与 `/robots.txt` 返回 `200` 且 `Content-Type: text/plain; charset=utf-8`，页面内无外链 Google Fonts 阻塞。

## 重新生成工坊高清样本与 OG 封面图

```powershell
python d:\document\development\aigc-studio\site\scripts\generate-assets.py
```
