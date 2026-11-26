/**
 * 界面语言归一化与首次运行系统语言探测（Node / Electron / Browser 共用）。
 *
 * 约定：
 *  - 应用界面只支持 `zh`（简体中文）与 `en`（英文）；
 *  - 中文区域（`zh` / `zh-CN` / `zh-TW` / `zh_CN.UTF-8` 等）归一化为 `zh`；
 *  - 其它明确识别到的非中文区域（如 `en-US`、`ja-JP`、`fr-FR`、`de`）映射为 `en`；
 *  - 无法判断或遇到 `C` / `POSIX` 等占位值时，回退 `fallback`（默认 `'zh'`）。
 */

export const SUPPORTED_LANGS = Object.freeze(['zh', 'en'])

const NON_LOCALE_VALUES = new Set(['', 'c', 'posix', 'c.utf8', 'c.utf-8', 'unknown', 'und'])

/** 提取纯语言码前缀并去掉编码/修饰符（如 `zh_CN.UTF-8` → `zh-cn`）。 */
function cleanLocaleTag(raw) {
  if (typeof raw !== 'string') return ''
  // Accept-Language 可能是 `en-US,en;q=0.9,zh;q=0.8`：取第一段即可。
  const first = raw.split(',')[0].split(';')[0].trim()
  // POSIX 环境变量可能带 `.UTF-8` 或 `@euro`
  const base = first.split('.')[0].split('@')[0].trim().replace(/_/g, '-').toLowerCase()
  if (!base || NON_LOCALE_VALUES.has(base)) return ''
  return base
}

/**
 * 显式语言码归一化：仅识别 `zh*` → `'zh'` 与 `en*` → `'en'`，其它返回 `null`。
 *
 * @param {unknown} value
 * @returns {'zh' | 'en' | null}
 */
export function normalizeUiLang(value) {
  const tag = cleanLocaleTag(value)
  if (!tag) return null
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
  if (tag === 'en' || tag.startsWith('en-')) return 'en'
  return null
}

/**
 * 把任意非空区域码映射为应用支持的两档语言：`zh*` → `'zh'`，其余有效语言码 → `'en'`。
 *
 * @param {unknown} raw
 * @returns {'zh' | 'en' | null}
 */
export function mapLocaleToUiLang(raw) {
  const tag = cleanLocaleTag(raw)
  if (!tag) return null
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(tag)) return 'en'
  return null
}

/**
 * 解析 HTTP `Accept-Language` 请求头（按权重 q 从高到低或出现顺序取首个有效语言）。
 *
 * @param {unknown} header
 * @returns {'zh' | 'en' | null}
 */
export function parseAcceptLanguage(header) {
  if (typeof header !== 'string' || !header.trim()) return null
  const items = header
    .split(',')
    .map((part, index) => {
      const segments = part.trim().split(';')
      const tag = segments[0]?.trim() || ''
      let q = 1
      for (let i = 1; i < segments.length; i += 1) {
        const match = /^q\s*=\s*([0-9.]+)$/i.exec(segments[i].trim())
        if (match) {
          const parsed = Number(match[1])
          if (Number.isFinite(parsed)) q = parsed
        }
      }
      return { tag, q, index }
    })
    .filter((item) => item.tag && item.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)

  for (const item of items) {
    const mapped = mapLocaleToUiLang(item.tag)
    if (mapped) return mapped
  }
  return null
}

/**
 * 探测当前运行环境的默认界面语言（仅用于无持久化偏好时的首次默认）。
 *
 * 优先级：
 *  1. 显式传入的 `locale`（例如 Electron `app.getLocale()` 或 `navigator.language`）；
 *  2. HTTP 请求头 `acceptLanguage`；
 *  3. 环境变量（`AIGC_STUDIO_LOCALE` → `LC_ALL` → `LC_MESSAGES` → `LANG` → `LANGUAGE`）；
 *  4. `Intl.DateTimeFormat().resolvedOptions().locale`（运行时系统区域）；
 *  5. 兜底 `fallback`（默认 `'zh'`）。
 *
 * @param {{ locale?: string, acceptLanguage?: string, env?: Record<string, string | undefined>, fallback?: 'zh' | 'en' }} [options]
 * @returns {'zh' | 'en'}
 */
export function detectPreferredLang(options = {}) {
  const fallback = options.fallback === 'en' ? 'en' : 'zh'

  const fromExplicit = mapLocaleToUiLang(options.locale)
  if (fromExplicit) return fromExplicit

  const fromHeader = parseAcceptLanguage(options.acceptLanguage)
  if (fromHeader) return fromHeader

  const env = options.env && typeof options.env === 'object' ? options.env : null
  if (env) {
    for (const key of ['AIGC_STUDIO_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
      const value = env[key]
      if (!value) continue
      // LANGUAGE 可能是冒号分隔列表 `en_US:en`
      const first = String(value).split(':')[0]
      const fromEnv = mapLocaleToUiLang(first)
      if (fromEnv) return fromEnv
    }
  }

  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale
    const fromIntl = mapLocaleToUiLang(intlLocale)
    if (fromIntl) return fromIntl
  } catch {
    // 忽略受限环境
  }

  return fallback
}
