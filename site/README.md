# AIGC Studio 中文官网 MVP

基于 **Astro 5（纯静态 SSG）** 构建的中文产品官网与 SEO/GEO 落地骨架。

## 本地预览与构建

```powershell
Set-Location d:\document\development\aigc-studio\site

# 本地开发预览（http://localhost:4321）
npm run dev

# 静态构建（输出到 site/dist，含 sitemap-index.xml、robots.txt、llms.txt）
npm run build
```

## 上线前替换域名

将正式域名统一替换以下 3 处即可部署至 Cloudflare Pages / Vercel / GitHub Pages：
1. `astro.config.mjs` 中的 `site`
2. `src/data/site.ts` 中的 `SITE.domain`
3. `public/robots.txt` 与 `public/llms.txt` 中的域名
