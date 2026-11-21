/**
 * 全局应用设置的纯逻辑：视图解析、表单装载与白名单补丁拼装。
 *
 * 契约（server/standalone 与 shared/contract.js 共同约定）：
 *  - GET /api/app-settings → `{ ok, settings: { ui, llm, workspace, version } }`；
 *  - POST /api/app-settings 是白名单合并，响应与 GET 同形；
 *  - `llm.apiKey` 永不回传原文，只回 `hasApiKey` 与来源；清除走 `clearLlmApiKey: true`；
 *  - `llm.providers` 是 Provider 元数据清单，由 Host 从 `shared/llm-providers.js` 下发。
 *
 * 本模块不依赖 React / DOM，也不直接取字典：错误文案由抽屉用 settingsErrorText 翻译。
 */

import {
  LLM_PROVIDERS as SHARED_LLM_PROVIDERS,
  LLM_PROVIDER_GROUPS,
  groupLlmProviders,
  llmProviderMeta,
  llmProviderOf,
  searchLlmProviders,
} from '../../shared/llm-providers.js'

/** 界面语言（应用设置只支持这两档）。 */
export const APP_LANGUAGES = ['zh', 'en']
/** 界面主题。 */
export const APP_THEMES = ['light', 'dark', 'system']
/**
 * 创作助手模型 Provider：唯一来源是 `shared/llm-providers.js`。
 * 这里保留 id 数组的导出形态，避免调用方为「是不是合法 provider」各写一份判断。
 */
export const LLM_PROVIDERS = Object.freeze(SHARED_LLM_PROVIDERS.map((item) => item.id))
/** Provider 分组顺序（设置界面的分组标题）。 */
export { LLM_PROVIDER_GROUPS }
/** API Key 来源：全局设置 / 外部配置 / 未配置。 */
export const LLM_API_KEY_SOURCES = ['settings', 'config', 'none']

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 单个 Provider 元数据的归一：Host 下发的优先，缺字段回落到共享清单。 */
function normalizeProviderMeta(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  const fallback = llmProviderOf(id)
  return {
    id,
    label: textOf(raw.label) || fallback?.label || id,
    group: textOf(raw.group) || fallback?.group || 'local',
    api: textOf(raw.api) || fallback?.api || 'openai-completions',
    requiresKey: raw.requiresKey === true || (raw.requiresKey === undefined && fallback?.requiresKey === true),
    defaultModel: textOf(raw.defaultModel) || fallback?.defaultModel || '',
    defaultBaseUrl: textOf(raw.defaultBaseUrl) || fallback?.baseUrl || '',
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(textOf).filter(Boolean) : [...(fallback?.aliases || [])],
    modelSource: textOf(raw.modelSource) || fallback?.modelSource || 'openai',
  }
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
      // 旧宿主没有 providers 字段时退回共享清单：界面永远能渲染完整的分组列表。
      providers: normalizeProviders(llm.providers),
    },
    workspace: {
      current: textOf(workspace.current),
      recent: Array.isArray(workspace.recent) ? workspace.recent.map(textOf).filter(Boolean) : [],
    },
    version: textOf(source.version),
  }
}

/** Provider 列表归一：Host 下发的优先；缺失 / 非法时用共享清单。 */
export function normalizeProviders(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return SHARED_LLM_PROVIDERS.map((item) => normalizeProviderMeta(item)).filter(Boolean)
  }
  const normalized = list.map(normalizeProviderMeta).filter(Boolean)
  return normalized.length > 0
    ? normalized
    : SHARED_LLM_PROVIDERS.map((item) => normalizeProviderMeta(item)).filter(Boolean)
}

/** 视图 → Provider 元数据（未知 id 回退共享清单里的同名项，再回退默认 Provider）。 */
export function providerMetaFromView(view, id) {
  const providers = normalizeProviders(view && view.llm ? view.llm.providers : null)
  return providers.find((item) => item.id === id) || providers.find((item) => item.id === 'openai') || normalizeProviderMeta(llmProviderMeta(id))
}

/** 视图 → Provider 搜索（模糊匹配 id / 展示名 / 别名）。 */
export function searchProviders(view, query) {
  const providers = normalizeProviders(view && view.llm ? view.llm.providers : null)
  return searchLlmProviders(query, providers)
}

/** 视图 → 分组后的 Provider（空组自动省略）。 */
export function groupedProviders(view) {
  return groupLlmProviders(normalizeProviders(view && view.llm ? view.llm.providers : null))
}

/** 该 Provider 实际生效的端点：用户手填优先，否则用默认端点。 */
export function effectiveBaseUrlOf(meta, baseUrl) {
  const custom = textOf(baseUrl)
  if (custom) return custom
  return meta && typeof meta.defaultBaseUrl === 'string' ? meta.defaultBaseUrl : ''
}

/** 当前配置是否覆盖了默认端点（设置界面据此决定「修改接口地址」是否展开）。 */
export function isCustomBaseUrl(meta, baseUrl) {
  const custom = textOf(baseUrl)
  if (!custom) return false
  return custom !== (meta && meta.defaultBaseUrl ? meta.defaultBaseUrl : '')
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
 * 只提交真正变化的字段：baseUrl / model 允许清空（清空即删除设置、回退 Provider 默认），
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
  // 换 Provider 时若表单还留着上一家的端点，按空串提交：服务端回退新 Provider 默认地址。
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

/**
 * 切换 Provider 时的表单补丁：换默认端点与推荐模型。
 *
 * 端点重置为空串（表示使用新 Provider 的默认地址），模型回到该 Provider 的推荐值；
 * 用户随后仍可手改端点或直接选择 / 输入任意模型。
 */
export function providerSwitchPatch(view, providerId) {
  const meta = providerMetaFromView(view, providerId)
  return {
    provider: meta.id,
    baseUrl: '',
    model: meta.defaultModel || '',
  }
}
