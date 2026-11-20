/**
 * 浏览器运行时入口：React 运行时、宿主 Bootstrap 与桌面桥访问。
 *
 * 原 DSH 插件由宿主注入 React；独立客户端里统一从 `react` 同步导入，
 * 组件模块一律从这里取 h / React。桌面原生能力（选目录、通知等）由 Electron
 * preload 暴露在 `window.aigcStudio`，浏览器开发态返回空实现，调用方按能力探测降级。
 */

import React from 'react'

export { React }

export const h = React.createElement

/** 浏览器 / 纯 Web 开发态的空桌面桥：没有原生方法，调用方用 typeof 探测后再降级。 */
const BROWSER_DESKTOP = Object.freeze({
  platform: 'browser',
  isElectron: false,
})

/**
 * 桌面桥：Electron 下返回 preload 暴露的 `window.aigcStudio`，否则返回空实现。
 * 浏览器里只有 platform / isElectron，不含 pickDirectory 等原生方法。
 */
export function desktop() {
  const bridge = typeof window !== 'undefined' ? window.aigcStudio : null
  return bridge && typeof bridge === 'object' ? bridge : BROWSER_DESKTOP
}

const BROWSER_BOOTSTRAP = Object.freeze({
  apiBaseUrl: '',
  authToken: '',
  platform: 'browser',
  native: false,
})

/**
 * 运行时 Bootstrap：本地服务的 API 基址、Bearer Token 与平台信息。
 *
 * 优先级：
 *  1. Electron preload 注入的 `window.aigcStudio.bootstrap`（生产桌面端）；
 *  2. 本地服务在 index.html 里注入的 `window.__AIGC_STUDIO__`（浏览器直连服务）；
 *  3. 空值兜底——Vite 开发态由代理注入 Token，前端不需要知道它。
 */
export function bootstrap() {
  if (typeof window === 'undefined') return BROWSER_BOOTSTRAP
  const bridge = window.aigcStudio
  const fromDesktop = bridge && bridge.bootstrap && typeof bridge.bootstrap === 'object' ? bridge.bootstrap : null
  const injected = window.__AIGC_STUDIO__ && typeof window.__AIGC_STUDIO__ === 'object' ? window.__AIGC_STUDIO__ : null
  const source = fromDesktop || injected
  if (!source) return BROWSER_BOOTSTRAP
  const isElectron = Boolean(bridge && (bridge.isElectron === true || typeof bridge.pickDirectory === 'function'))
  return {
    apiBaseUrl: typeof source.apiBaseUrl === 'string' ? source.apiBaseUrl : '',
    authToken: typeof source.authToken === 'string' ? source.authToken : '',
    platform: typeof source.platform === 'string' ? source.platform : BROWSER_BOOTSTRAP.platform,
    native: source.native === true || isElectron,
  }
}
