/**
 * Vite 配置：Web 工作台构建与开发服务器。
 *
 * 设计要点：
 *  - 开发态：`vite` 直接服务 `web/`，`/api` 代理到本地 standalone 服务并注入 Bearer Token，
 *    因此浏览器打开开发服务器即可调试完整工作台（不需要 Electron）。
 *  - 生产态：`vite build` 输出到 `dist/web/`，由本地 standalone 服务的静态文件路由托管；
 *    它会在 index.html 里注入运行时 bootstrap（API 基址 + Token）。
 *  - CSS：原插件用 esbuild 的 text loader 把 CSS 当字符串打进 bundle（组件里以
 *    `<style>{CSS}</style>` 注入）。Vite 下用 `?inline` 取得同样的字符串语义，
 *    由下面的 `cssAsText` 插件统一改写，业务源码无需改动。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vite'

const ROOT = dirname(fileURLToPath(import.meta.url))

/** 把 JS/JSX 里对 `*.css` 的导入改写成 `*.css?inline`（Vite 的「取 CSS 字符串」形式）。 */
function cssAsText() {
  return {
    name: 'aigc-css-as-text',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || source.includes('?')) return null
      if (!/\.(?:js|jsx|mjs)$/.test(importer)) return null
      if (!/\.css$/.test(source)) return null
      return this.resolve(`${source}?inline`, importer, { skipSelf: true })
    },
  }
}

export default defineConfig(({ mode }) => {
  // 读取仓库根目录的 .env（与 `npm run dev:server` 的 --env-file 读同一份变量），
  // 这样「两个终端分别跑 dev:server / dev:web」时端口与 dev token 自动对齐。
  // 优先级：进程环境变量（npm run dev 由 dev.mjs 注入）> .env > 默认值。
  const env = loadEnv(mode, ROOT, '')
  const envOf = (key) => process.env[key] || env[key] || ''
  const apiTarget = envOf('AIGC_STUDIO_API_TARGET') || `http://127.0.0.1:${envOf('AIGC_STUDIO_PORT') || 5130}`
  const apiToken = envOf('AIGC_STUDIO_TOKEN') || 'aigc-studio-dev-token'

  return {
    root: resolve(ROOT, 'web'),
    base: '/',
    plugins: [cssAsText()],
    // 与原插件 esbuild 构建保持一致：JSX 走 automatic runtime（react/jsx-runtime）。
    // 工作台里 `web/studio/icons.jsx` 等纯 JSX 片段没有 import React，
    // 用 Vite 默认的 classic 变换会编译成 React.createElement(...) 而运行时报
    // "React is not defined"；automatic 模式由编译器自动注入 jsx 运行时导入。
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'react',
    },
    server: {
      host: '127.0.0.1',
      port: Number(envOf('AIGC_STUDIO_DEV_PORT') || 5173),
      strictPort: true,
      proxy: {
        // 注意两点，缺一不可：
        // 1) 键必须带尾斜杠：前缀匹配下写 '/api' 会把模块请求 `/api.js` 也代理走；
        // 2) 仍需 bypass：`web/api/resources.js` 在 dev 下的模块 URL 是 `/api/resources.js`，
        //    它同样以 '/api/' 开头，会被代理到本地服务并 404，导致模块图中断、页面白屏。
        //    带静态资源扩展名的请求交还给 Vite 模块服务；真正的接口路径（无扩展名，
        //    如 /api/state、/api/app-settings、/api/file?path=x.png）仍走代理——
        //    bypass 只看 pathname，不看 query。
        '/api/': {
          target: apiTarget,
          changeOrigin: false,
          headers: { authorization: `Bearer ${apiToken}` },
          bypass(req) {
            const pathname = String(req.url || '').split('?')[0]
            if (/\.(?:[cm]?[jt]sx?|css|map|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|json)$/i.test(pathname)) {
              return req.url
            }
            return undefined
          },
        },
      },
    },
    build: {
      outDir: resolve(ROOT, 'dist/web'),
      emptyOutDir: true,
      target: 'chrome126',
      assetsInlineLimit: 4096,
    },
  }
})
