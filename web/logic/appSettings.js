/**
 * 全局应用设置的纯逻辑：视图解析、表单装载与白名单补丁拼装。
 *
 * 契约（server/standalone 与 shared/contract.js 共同约定）：
 *  - GET /api/app-settings → `{ ok, settings: { ui, llm, workspace, version } }`；
 *  - POST /api/app-settings 是白名单合并，响应与 GET 同形；
 *  - `llm.apiKey` 永不回传原文，只回 `hasApiKey` 与来源；清除走 `clearLlmApiKey: true`；
 *  - `llm.providers` 是 Provider 元数据清单，由 Host 从 `shared/llm-providers.js` 下发；
 *  - `worker` 段只有地址与 `tokenConfigured`（私有 Worker 连接配置），Token 原文永不回传。
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
import {
  IMAGE_API_VENDOR_IDS,
  imageApiVendorOf,
} from '../../shared/image-providers.js'
import { SALAD } from '../../shared/contract.js'

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
  const update = objectOf(source.update)
  const worker = objectOf(source.worker)
  const imageApi = objectOf(source.imageApi)
  const salad = objectOf(source.salad)
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
    update: {
      updateCheck: update.updateCheck === true,
      updateSource: update.updateSource === 'custom' ? 'custom' : 'github',
      updateMirrorUrl: textOf(update.updateMirrorUrl),
    },
    worker: {
      endpointUrl: textOf(worker.endpointUrl),
      tokenConfigured: worker.tokenConfigured === true,
    },
    imageApi: {
      vendor: IMAGE_API_VENDOR_IDS.includes(imageApi.vendor) ? imageApi.vendor : IMAGE_API_VENDOR_IDS[0],
      model: textOf(imageApi.model),
      baseUrl: textOf(imageApi.baseUrl),
      customModel: textOf(imageApi.customModel),
      customBaseUrl: textOf(imageApi.customBaseUrl),
      hasApiKey: imageApi.hasApiKey === true,
      apiKeysConfigured: Array.isArray(imageApi.apiKeysConfigured)
        ? imageApi.apiKeysConfigured.filter((id) => IMAGE_API_VENDOR_IDS.includes(id))
        : [],
    },
    salad: {
      org: textOf(salad.org).toLowerCase(),
      project: textOf(salad.project).toLowerCase() || SALAD.defaultProject,
      tier: SALAD.tierIds.includes(salad.tier) ? salad.tier : SALAD.defaultTier,
      hasApiKey: salad.hasApiKey === true,
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

/**
 * 私有 Worker 脱敏视图 → 表单（token 永远从空串开始，留空表示保持不变）。
 *
 * `tokenConfigured` 只用于占位提示与「清除 Token」按钮，不代表表单里有值。
 */
export function workerFormOf(view) {
  const worker = objectOf(view && view.worker)
  return {
    endpointUrl: textOf(worker.endpointUrl),
    tokenConfigured: worker.tokenConfigured === true,
    token: '',
    clearToken: false,
  }
}

/**
 * 私有 Worker 表单 → POST /api/app-settings 补丁。
 *
 * 只提交真正变化的字段：地址允许清空（清空即断开并移除配置），
 * Token 留空表示保持不变；点过「清除」时提交 clearToken（优先于 token）。
 */
export function buildWorkerPatch(form, view) {
  const source = objectOf(form)
  const base = objectOf(view && view.worker)
  const patch = {}
  const endpointUrl = textOf(source.endpointUrl)
  if (endpointUrl !== textOf(base.endpointUrl)) patch.endpointUrl = endpointUrl
  if (source.clearToken === true) {
    patch.clearToken = true
  } else {
    const token = textOf(source.token)
    if (token) patch.token = token
  }
  return Object.keys(patch).length > 0 ? { worker: patch } : {}
}

/** 补丁是否有改动（决定保存按钮是否可用）。 */
export function hasAppSettingsChanges(patch) {
  return Boolean(patch && typeof patch === 'object' && Object.keys(patch).length > 0)
}

/**
 * 商业生图 API 脱敏视图 → 表单（Key 永远从空串开始，留空表示保持不变）。
 *
 * `hasApiKey` / `apiKeysConfigured` 只用于占位提示与「清除 Key」按钮，
 * 不代表表单里有值；切换服务商时由 `imageApiFormOf` 重新取该服务商的配置。
 */
export function imageApiFormOf(view) {
  const imageApi = objectOf(view && view.imageApi)
  const vendor = IMAGE_API_VENDOR_IDS.includes(imageApi.vendor) ? imageApi.vendor : IMAGE_API_VENDOR_IDS[0]
  const meta = imageApiVendorOf(vendor)
  const fallbackModel = meta?.models?.[0]?.id ?? ''
  const customModel = textOf(imageApi.customModel) || (vendor === 'custom' ? textOf(imageApi.model) : '')
  const customBaseUrl = textOf(imageApi.customBaseUrl) || (vendor === 'custom' ? textOf(imageApi.baseUrl) : '')
  const configured = Array.isArray(imageApi.apiKeysConfigured) ? imageApi.apiKeysConfigured : []
  return {
    vendor,
    model: vendor === 'custom' ? customModel : (textOf(imageApi.model) || fallbackModel),
    baseUrl: vendor === 'custom' ? customBaseUrl : textOf(imageApi.baseUrl),
    hasApiKey: imageApi.hasApiKey === true || configured.includes(vendor),
    apiKey: '',
    clearApiKey: false,
  }
}

/**
 * 切换生图服务商时的表单补丁：内置服务商回到首个默认模型，custom 恢复已保存的自定义地址与模型；
 * Key 输入清空（每家的 Key 分仓保存，切回来仍可用）。
 */
export function imageApiVendorSwitchPatch(vendorId, imageApiView = null) {
  const vendor = imageApiVendorOf(vendorId) ?? imageApiVendorOf(IMAGE_API_VENDOR_IDS[0])
  const view = objectOf(imageApiView)
  if (vendor.id === 'custom') {
    return {
      vendor: vendor.id,
      model: textOf(view.customModel) || (view.vendor === 'custom' ? textOf(view.model) : ''),
      baseUrl: textOf(view.customBaseUrl) || (view.vendor === 'custom' ? textOf(view.baseUrl) : ''),
      apiKey: '',
      clearApiKey: false,
    }
  }
  return {
    vendor: vendor.id,
    model: vendor.models[0]?.id ?? '',
    baseUrl: '',
    apiKey: '',
    clearApiKey: false,
  }
}

/**
 * 商业生图 API 表单 → POST /api/app-settings 补丁。
 *
 * 只提交真正变化的字段：内置服务商的模型在顶栏选择，设置抽屉不再提交 model 变动；
 * custom 端点才随表单提交 model 与必填的 baseUrl。
 */
export function buildImageApiPatch(form, view) {
  const source = objectOf(form)
  const base = objectOf(view && view.imageApi)
  const patch = {}
  const vendor = IMAGE_API_VENDOR_IDS.includes(source.vendor) ? source.vendor : IMAGE_API_VENDOR_IDS[0]
  const baseVendor = IMAGE_API_VENDOR_IDS.includes(base.vendor) ? base.vendor : IMAGE_API_VENDOR_IDS[0]
  const isCustom = vendor === 'custom'
  if (vendor !== baseVendor) patch.vendor = vendor

  const model = textOf(source.model)
  const baseCustomModel = textOf(base.customModel) || (baseVendor === 'custom' ? textOf(base.model) : '')
  if (isCustom && (vendor !== baseVendor || model !== baseCustomModel)) {
    patch.model = model
  }

  const baseUrl = textOf(source.baseUrl)
  const compareBaseUrl = isCustom
    ? (textOf(base.customBaseUrl) || (baseVendor === 'custom' ? textOf(base.baseUrl) : ''))
    : textOf(base.baseUrl)
  if (vendor !== baseVendor || baseUrl !== compareBaseUrl) {
    // 空串是合法值（使用服务商默认端点）；非法地址由服务端统一校验并报错。
    patch.baseUrl = baseUrl
  }

  if (source.clearApiKey === true) {
    patch.clearApiKey = true
  } else {
    const apiKey = textOf(source.apiKey)
    if (apiKey) patch.apiKey = apiKey
  }
  return Object.keys(patch).length > 0 ? { imageApi: patch } : {}
}

/** SaladCloud 脱敏视图 → 表单（API Key 永远从空串开始，留空表示保持不变）。 */
export function saladFormOf(view) {
  const salad = objectOf(view && view.salad)
  return {
    org: textOf(salad.org).toLowerCase(),
    project: textOf(salad.project).toLowerCase() || SALAD.defaultProject,
    tier: SALAD.tierIds.includes(salad.tier) ? salad.tier : SALAD.defaultTier,
    hasApiKey: salad.hasApiKey === true,
    apiKey: '',
    clearApiKey: false,
  }
}

/**
 * SaladCloud 表单 → POST /api/app-settings 补丁。
 *
 * 只提交真正变化的字段；API Key 留空表示保持不变，清除时提交 clearApiKey。
 * org / project 的格式由 Host 统一校验并给可执行错误。
 */
export function buildSaladPatch(form, view) {
  const source = objectOf(form)
  const base = objectOf(view && view.salad)
  const patch = {}
  const org = textOf(source.org).toLowerCase()
  const project = textOf(source.project).toLowerCase() || SALAD.defaultProject
  const tier = SALAD.tierIds.includes(source.tier) ? source.tier : SALAD.defaultTier
  if (org !== textOf(base.org).toLowerCase()) patch.org = org
  if (project !== (textOf(base.project).toLowerCase() || SALAD.defaultProject)) patch.project = project
  if (tier !== (SALAD.tierIds.includes(base.tier) ? base.tier : SALAD.defaultTier)) patch.tier = tier
  if (source.clearApiKey === true) {
    patch.clearApiKey = true
  } else {
    const apiKey = textOf(source.apiKey)
    if (apiKey) patch.apiKey = apiKey
  }
  return Object.keys(patch).length > 0 ? { salad: patch } : {}
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
