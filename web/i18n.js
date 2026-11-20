/** 翻译查询：字典回落、运行时语言状态与静态文案查询。 */

import { DICT } from './dict/index.js'

/** 支持的语言（应用设置里只有这两档）。 */
export const LANGUAGES = ['zh', 'en']

/** 模块级当前语言：独立客户端不再从宿主 <html lang> 隐式读取。 */
let currentLanguage = 'zh'

/** 语言名归一化：`zh-CN` / `zh` → `zh`，`en-US` / `en` → `en`，未知返回空串。 */
export function normalizeLanguage(lang) {
  const value = typeof lang === 'string' ? lang.trim().toLowerCase() : ''
  if (value.startsWith('zh')) return 'zh'
  if (value.startsWith('en')) return 'en'
  return ''
}

/** 当前界面语言（zh | en）。 */
export function getLanguage() {
  return currentLanguage
}

/**
 * 切换界面语言：更新模块级状态与 <html lang>，返回归一化后的语言名。
 * 未知语言保持当前值（不把界面切到一个不存在的语言）。
 */
export function setLanguage(lang) {
  const next = normalizeLanguage(lang) || currentLanguage
  currentLanguage = next
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
  }
  return currentLanguage
}

export function fallbackTranslate(lang) {
  const language = lang && String(lang).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const dict = language === 'zh' ? DICT.zh : DICT.en
  const translate = (key) => dict[key] ?? DICT.en[key] ?? key
  // 翻译函数自带语言标记：组合层据此判断 isEn 等，不必再从 DOM <html lang> 反推。
  translate.lang = language
  return translate
}

/**
 * 取当前渲染用的翻译函数：优先调用方（预览 / 测试 / 父组件）显式传入的 props.t，
 * 否则用运行时语言对应的字典。
 */
export function translator(props) {
  if (props && typeof props.t === 'function') return props.t
  return fallbackTranslate(currentLanguage)
}

export function localized(t, key) {
  const value = t(key)
  return typeof value === 'string' && value !== key ? value : ''
}
