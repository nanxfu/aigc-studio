import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const siteUrl = (process.env.PUBLIC_SITE_URL || 'https://aigc-studio.app').trim().replace(/\/+$/, '');

export default defineConfig({
  // 绑定正式域名后只需在 Cloudflare Pages 设置环境变量 PUBLIC_SITE_URL（例如 https://yourdomain.com）
  site: siteUrl,
  output: 'static',
  integrations: [sitemap()],
  build: {
    assets: '_astro',
  },
});
