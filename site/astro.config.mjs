import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // 上线时替换为你的正式域名（同步更新 public/robots.txt 与 public/llms.txt）
  site: 'https://aigc-studio.app',
  output: 'static',
  integrations: [sitemap()],
  build: {
    assets: '_astro',
  },
});
