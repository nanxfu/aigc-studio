/**
 * 全局应用设置的纯逻辑：视图解析、表单装载与白名单补丁拼装。
 *
 * 契约（server/standalone 与 shared/contract.js 共同约定）：
 *  - GET /api/app-settings → `{ ok, settings: { ui, llm, workspace, version } }`；
 *  - POST /api/app-settings 是白名单合并，响应与 GET 同形；
 *  - `llm.apiKey` 永不回传原文，只回 `hasApiKey` 与来源；清除走 `clearLlmApiKey: true`。
 *
 * 本模块不依赖 React / DOM，也不直接取字典：错误文案由抽屉用 settingsErrorText 翻译。
 */

/** 界面语言（应用设置只支持这两档）。 */
export const APP_LANGUAGES = ['zh', 'en']
/** 界面主题。 */
export const APP_THEMES = ['light', 'dark', 'system']
/** 创作助手模型 provider（custom 走 OpenAI 兼容端点）。 */
export const LLM_PROVIDERS = ['openai', 'anthropic', 'custom', 'ollama']
/** API Key 来源：全局设置 / 外部配置 / 未配置。 */
export const LLM_API_KEY_SOURCES = ['settings', 'config', 'none']

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * GET / POST /api/app-settings 响应 → 脱敏设置视图；形状不对返回 null，
 * 由抽屉展示可重试的读取失败态（不阻塞其它设置区块）。
 */
export function appSettingsViewOf(result) {
  if (!result || result.ok !== true || !result.data || typeof result.data !== 'object') return null
  const view = result.data.settings
  if (!view || typeof view !== 'object' || Array.isArray(view)) return null
  return normalizeAppSettingsView(view)
}

/** 脱敏设置视图归一化：缺字段与非法枚举都回落到安全默认值。 */
export function normalizeAppSettingsView(view) {
  const source = objectOf(view)
  const ui = objectOf(source.ui)
  const llm = objectOf(source.llm)
  const workspace = objectOf(source.workspace)
  const hasApiKey = llm.hasApiKey === true
  const apiKeySource = LLM_API_KEY_SOURCES.includes(llm.apiKeySource)
    ? llm.apiKeySource
    : hasApiKey
      ? 'settings'
      : 'none'
  return {
    ui: {
      lang: APP_LANGUAGES.includes(ui.lang) ? ui.lang : 'zh',
      theme: APP_THEMES.includes(ui.theme) ? ui.theme : 'system',
    },
    llm: {
      provider: LLM_PROVIDERS.includes(llm.provider) ? llm.provider : 'openai',
      baseUrl: textOf(llm.baseUrl),
      model: textOf(llm.model),
      hasApiKey,
      apiKeySource,
      reasoningEffort: textOf(llm.reasoningEffort),
    },
    workspace: {
      current: textOf(workspace.current),
      recent: Array.isArray(workspace.recent) ? workspace.recent.map(textOf).filter(Boolean) : [],
    },
    version: textOf(source.version),
  }
}

/** 脱敏设置视图 → 「创作助手模型」表单（apiKey 永远从空串开始，留空表示保持不变）。 */
export function llmFormOf(view) {
  const llm = objectOf(view && view.llm)
  return {
    provider: LLM_PROVIDERS.includes(llm.provider) ? llm.provider : 'openai',
    baseUrl: textOf(llm.baseUrl),
    model: textOf(llm.model),
    apiKey: '',
    clearApiKey: false,
  }
}

/** 脱敏设置视图 → 「界面」表单。 */
export function uiFormOf(view) {
  const ui = objectOf(view && view.ui)
  return {
    lang: APP_LANGUAGES.includes(ui.lang) ? ui.lang : 'zh',
    theme: APP_THEMES.includes(ui.theme) ? ui.theme : 'system',
  }
}

/**
 * 「创作助手模型」表单 → POST /api/app-settings 补丁。
 *
 * 只提交真正变化的字段：baseUrl / model 允许清空（清空即删除设置），
 * apiKey 留空表示保持不变；点过「清除」时提交 clearLlmApiKey（优先于 apiKey）。
 */
export function buildLlmPatch(form, view) {
  const source = objectOf(form)
  const base = objectOf(view && view.llm)
  const patch = {}
  const llm = {}

  const provider = LLM_PROVIDERS.includes(source.provider) ? source.provider : 'openai'
  const baseProvider = LLM_PROVIDERS.includes(base.provider) ? base.provider : 'openai'
  if (provider !== baseProvider) llm.provider = provider

  const baseUrl = textOf(source.baseUrl)
  if (baseUrl !== textOf(base.baseUrl)) llm.baseUrl = baseUrl

  const model = textOf(source.model)
  if (model !== textOf(base.model)) llm.model = model

  if (Object.keys(llm).length > 0) patch.llm = llm
  if (source.clearApiKey === true) {
    patch.clearLlmApiKey = true
  } else {
    const apiKey = textOf(source.apiKey)
    if (apiKey) patch.llm = { ...llm, apiKey }
  }
  return patch
}

/** 「界面」表单 → POST /api/app-settings 补丁（语言 / 主题都是短值，两项一起提交即可）。 */
export function buildUiPatch(ui) {
  const source = objectOf(ui)
  const patch = {}
  if (APP_LANGUAGES.includes(source.lang)) patch.lang = source.lang
  if (APP_THEMES.includes(source.theme)) patch.theme = source.theme
  return Object.keys(patch).length > 0 ? { ui: patch } : {}
}

/** 补丁是否有改动（决定保存按钮是否可用）。 */
export function hasAppSettingsChanges(patch) {
  return Boolean(patch && typeof patch === 'object' && Object.keys(patch).length > 0)
}
