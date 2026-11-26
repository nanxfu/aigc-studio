/**
 * Vite 入口：挂载工作台，并在挂载前完成运行时语言 / 主题初始化。
 *
 * 独立客户端不再由 DSH 宿主注入 React 与语言环境：
 *  - API 基址 / Bearer Token 来自 `runtime.bootstrap()`（Electron preload 或服务端 HTML 注入）；
 *  - 语言 / 主题首选全局应用设置 GET /api/app-settings 的 `ui`，读取失败时退回本地缓存与默认值；
 *  - 首帧着色由 index.html 的内联脚本按同一份本地缓存完成，避免深色主题闪白。
 */

import React from 'react'
import { createRoot } from 'react-dom/client'

// 层叠顺序固定：先设计变量与基础原语，再各区域样式，最后响应式断点。
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/pipeline.css'
import './styles/model-picker.css'
import './styles/guidance.css'
import './styles/drawers.css'
import './styles/panel.css'
import './styles/stage.css'
import './styles/filmstrip.css'
import './styles/gallery.css'
import './styles/chat.css'
import './styles/import.css'
import './styles/workshop.css'
import './styles/onboarding.css'
import './styles/responsive.css'

import { detectPreferredLang } from '../shared/locale.js'
import { request, routePath } from './api.js'
import { fallbackTranslate, getLanguage, normalizeLanguage, setLanguage } from './i18n.js'
import { bootstrap, desktop } from './runtime.js'
import { Studio } from './studio/Studio.jsx'

/** 主题偏好的本地缓存键：index.html 的内联脚本按它做首帧着色。 */
export const THEME_STORAGE_KEY = 'aigc-studio:theme'
/** 语言偏好的本地缓存键：服务端设置不可用时的首帧语言。 */
export const LANGUAGE_STORAGE_KEY = 'aigc-studio:lang'

const THEMES = ['light', 'dark', 'system']

/** 主题名归一化：未知值一律按跟随系统处理。 */
export function normalizeTheme(theme) {
  const value = typeof theme === 'string' ? theme.trim().toLowerCase() : ''
  return THEMES.includes(value) ? value : 'system'
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key) || ''
  } catch {
    // 隐私模式 / 存储不可写：首帧偏好缺失不影响界面可用。
    return ''
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 同上：缓存失败不阻断设置生效。
  }
}

/** 应用主题：`data-theme` 驱动 tokens.css 的显式深色 / 浅色覆盖，并写入本地缓存。 */
export function applyTheme(theme) {
  const next = normalizeTheme(theme)
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', next)
  }
  writeStorage(THEME_STORAGE_KEY, next)
  return next
}

function detectBrowserLanguage() {
  if (typeof navigator === 'undefined') return 'zh'
  const raw = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages[0]
    : navigator.language
  return detectPreferredLang({ locale: typeof raw === 'string' ? raw : '', fallback: 'zh' })
}

/** 应用语言：更新模块级语言、<html lang>、本地缓存并通知桌面壳。 */
export function applyLanguage(lang) {
  const next = setLanguage(lang)
  writeStorage(LANGUAGE_STORAGE_KEY, next)
  try {
    desktop().setLocale?.(next)
  } catch {
    // 非桌面环境或旧 preload 忽略
  }
  return next
}

/** 读取全局应用设置：服务未就绪 / 接口缺失时返回 null，初始化继续用本地缓存。 */
async function loadAppSettings() {
  try {
    const result = await request(routePath('appSettings'), { method: 'GET' })
    if (!result || result.ok !== true || !result.data || typeof result.data !== 'object') return null
    const view = result.data.settings
    return view && typeof view === 'object' && !Array.isArray(view) ? view : null
  } catch {
    // 服务端版本落后（契约里还没有该路由）时按「无设置」处理，不阻塞挂载。
    return null
  }
}

/** 工作台根组件：语言状态在这里反转成新的 t，界面即时重渲染。 */
function App({ initialSettings }) {
  const [lang, setLang] = React.useState(getLanguage())
  const t = React.useMemo(() => fallbackTranslate(lang), [lang])

  // 设置抽屉保存语言 / 主题后回调：语言走 React 状态，主题直接落到 <html data-theme>。
  const onAppearanceChange = React.useCallback((next) => {
    if (!next || typeof next !== 'object') return
    if (next.lang) setLang(applyLanguage(next.lang))
    if (next.theme) applyTheme(next.theme)
  }, [])

  return <Studio t={t} onAppearanceChange={onAppearanceChange} defaultOnboardingOpen={initialSettings?.onboarding?.status === 'pending'} />
}

async function boot() {
  const runtime = bootstrap()
  // 外壳平台标记：darwin 下顶栏要给系统交通灯让位（见 shell.css），
  // 自绘窗口按钮也按平台决定是否渲染；必须在首帧前写入，避免布局跳动。
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.platform = desktop().platform || 'browser'
  }
  const bootUi = runtime && runtime.ui && typeof runtime.ui === 'object' ? runtime.ui : {}
  // 首帧先用本地缓存或浏览器语言，服务端设置回来后统一校正。
  applyLanguage(bootUi.lang || runtime.lang || readStorage(LANGUAGE_STORAGE_KEY) || detectBrowserLanguage())
  applyTheme(bootUi.theme || runtime.theme || readStorage(THEME_STORAGE_KEY) || 'system')

  const settings = await loadAppSettings()
  const ui = settings && settings.ui && typeof settings.ui === 'object' ? settings.ui : {}
  applyLanguage(normalizeLanguage(ui.lang) || bootUi.lang || getLanguage())
  applyTheme(ui.theme || bootUi.theme || normalizeTheme(readStorage(THEME_STORAGE_KEY)))

  if (!document.getElementById('root')) throw new Error('缺少 #root 容器，无法挂载工作台')
  createRoot(document.getElementById('root')).render(<App initialSettings={settings} />)
}

boot()

// 开发态工具：按住 Alt 悬浮即可看到光标下的 React 组件链（生产构建时该分支被静态剔除）。
if (import.meta.env.DEV) {
  import('./devtools/hover-inspector.js').then(({ installHoverInspector }) => installHoverInspector())
}
