/**
 * LLM 配置的归一化、脱敏视图与 pi-ai Model 构造（纯函数，不碰磁盘）。
 *
 * 存储分工：
 *  - 非敏感字段（provider / baseUrl / model / reasoningEffort）随 app-config.json 保存；
 *  - apiKey 单独存 `credentials/llm.json`（0600，或由主进程 safeStorage 加密托管），
 *    本文件只做校验与对外视图，任何日志或 HTTP 响应都不得出现 Key 原文。
 *
 * Provider 元数据（默认端点 / 协议 / 是否需要 Key / 搜索别名）来自
 * `shared/llm-providers.js` 单一来源；本文件只做「用户配置 + 元数据 → 运行期配置」的归一。
 *
 * 协议映射（`@earendil-works/pi-ai`）：
 *  - `openai-completions`：OpenAI 传统 Chat Completions 与所有兼容端点；
 *  - `openai-responses`：OpenAI Responses API（含 OpenCode 中走 Responses 的模型）；
 *  - `anthropic-messages`：Anthropic 官方与兼容网关；
 *  - `google-generative-ai`：Gemini 原生 v1beta。
 *
 * OpenCode 是多协议聚合网关：同一 Key 下不同模型分别走 4 条协议与不同子端点，
 * 因此 `piModelOf()` 会按内置模型目录里的 `api` / `baseUrl` 覆盖 Provider 默认值。
 */

import { OPENCODE_MODELS } from '@earendil-works/pi-ai/providers/opencode.models'

import {
  LLM_PROVIDER_IDS,
  LLM_PROVIDERS,
  publicLlmProviders,
} from '../../shared/llm-providers.js'

/** Provider 预设（由共享元数据派生，保持既有 `PROVIDER_PRESETS[id]` 读法）。 */
export const PROVIDER_PRESETS = Object.freeze(
  Object.fromEntries(
    LLM_PROVIDERS.map((item) => [
      item.id,
      {
        label: item.label,
        api: item.api,
        baseUrl: item.baseUrl,
        requiresKey: item.requiresKey,
        defaultModel: item.defaultModel,
        group: item.group,
        aliases: item.aliases,
        modelSource: item.modelSource,
      },
    ]),
  ),
)

export const PROVIDER_IDS = LLM_PROVIDER_IDS

/** pi-ai 协议 → 内部简易协议名（保留旧字段，便于日志与兼容判断）。 */
const PROTOCOL_OF_API = Object.freeze({
  'openai-completions': 'openai',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic',
  'google-generative-ai': 'google',
})

/** 推理模型：决定 piModel.reasoning 与思考档位。 */
const REASONING_MODEL_RE =
  /^(?:o[134](?:-|$)|gpt-5|gpt-6|claude-(?:3-7|sonnet-4|opus-4|haiku-4)|gemini-(?:2\.5|3)|deepseek-(?:reasoner|v4-pro)|qwen3|qwq|kimi-k\d(?:\.\d)?-thinking|glm-(?:4\.[5-9]|5)|grok-[3-9]|magistral|minimax-m2)/i

/** OpenCode 内置模型索引：id → { api, baseUrl }（多协议网关按模型路由的唯一依据）。 */
const OPENCODE_MODEL_INDEX = new Map(
  Object.values(OPENCODE_MODELS).map((model) => [
    model.id,
    { api: model.api, baseUrl: model.baseUrl, reasoning: model.reasoning === true, vision: Array.isArray(model.input) && model.input.includes('image') },
  ]),
)

const REASONING_EFFORTS = Object.freeze(['', 'off', 'minimal', 'low', 'medium', 'high'])

/** 一个配置是否具备调用条件（协议可达所需的最小闭包）。 */
export function isLlmConfigured(config) {
  if (!config || typeof config !== 'object') return false
  if (!config.model) return false
  const preset = PROVIDER_PRESETS[config.provider]
  if (!preset) return false
  if (!config.baseUrl) return false
  if (preset.requiresKey && !config.apiKey) return false
  return true
}

/** 去掉 URL 末尾斜杠（保留 path 前缀，例如 https://host/v1）。 */
export function trimBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

/** 校验 Base URL：必须是可以解析的 http(s) 绝对地址。 */
export function normalizeBaseUrl(value) {
  const raw = trimBaseUrl(value)
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return raw
}

/**
 * 归一化为 pi-ai 期望的 `baseUrl`：
 *  - Anthropic SDK 内部会自动追加 `/v1/messages`，因此剥掉末尾 `/v1` 防止重复；
 *  - Ollama 兼容老配置（只填 `http://127.0.0.1:11434` 无路径时自动补 `/v1`）。
 */
export function normalizePiBaseUrl(api, rawBaseUrl, provider = '') {
  const base = trimBaseUrl(rawBaseUrl)
  if (!base) return ''
  if (api === 'anthropic-messages') return base.replace(/\/v1$/i, '')
  if (api === 'openai-completions') {
    try {
      const parsed = new URL(base)
      const bareRoot = !parsed.pathname || parsed.pathname === '/'
      // Ollama 的根地址（无论端口）统一补 /v1；其它 Provider 只在默认 11434 端口时兜底，
      // 自定义端点保持用户填写的原样（vLLM / LM Studio 通常自己带 /v1）。
      if (bareRoot && (provider === 'ollama' || parsed.port === '11434')) return `${base}/v1`
    } catch {}
  }
  return base
}

/** 该 Provider 的模型是否需要按内置目录覆盖协议与端点（当前只有 OpenCode）。 */
export function modelRouteOf(provider, modelId) {
  if (provider !== 'opencode') return null
  return OPENCODE_MODEL_INDEX.get(String(modelId ?? '').trim()) ?? null
}

/**
 * 归一化 LLM 配置（传入 app-config 的原始对象，返回运行期使用的完整配置）。
 * 任何非法字段回退到预设默认值；provider 非法时回退 `openai`。
 *
 * @param {{ provider?: string, baseUrl?: string, model?: string, apiKey?: string, reasoningEffort?: string }} [input]
 * @returns {{ provider: string, protocol: string, api: string, baseUrl: string, model: string,
 *             apiKey: string, reasoningEffort: string, configured: boolean }}
 */
export function normalizeLlmConfig(input) {
  const source = input && typeof input === 'object' ? input : {}
  const providerId = PROVIDER_IDS.includes(source.provider) ? source.provider : 'openai'
  const preset = PROVIDER_PRESETS[providerId]
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  // OpenCode 的端点由模型决定：未手改 baseUrl 时用内置目录里的子端点，避免默认端点
  // 与所选模型的协议不匹配（例如 Claude 模型要走 /inference/anthropic）。
  const route = modelRouteOf(providerId, model)
  const explicitBaseUrl = normalizeBaseUrl(source.baseUrl)
  const baseUrl = explicitBaseUrl ?? route?.baseUrl ?? preset.baseUrl
  const api = route?.api ?? preset.api
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : ''
  const reasoningEffort =
    typeof source.reasoningEffort === 'string' && REASONING_EFFORTS.includes(source.reasoningEffort.trim())
      ? source.reasoningEffort.trim()
      : ''
  const config = {
    provider: providerId,
    protocol: PROTOCOL_OF_API[api] ?? 'openai',
    api,
    baseUrl,
    model,
    apiKey,
    reasoningEffort,
  }
  config.configured = isLlmConfigured(config)
  return config
}

/**
 * 构造 `@earendil-works/pi-ai` 的 `Model` 描述对象。
 *
 * @param {ReturnType<typeof normalizeLlmConfig>} config
 * @param {{ maxTokens?: number }} [overrides]
 */
export function piModelOf(config, overrides = {}) {
  const normalized = normalizeLlmConfig(config)
  const api = normalized.api
  const baseUrl = normalizePiBaseUrl(api, normalized.baseUrl, normalized.provider)
  const route = modelRouteOf(normalized.provider, normalized.model)
  const reasoning = route ? route.reasoning : REASONING_MODEL_RE.test(normalized.model)
  const vision = route ? route.vision : false
  const maxTokens = Number.isFinite(overrides.maxTokens) && overrides.maxTokens > 0 ? Math.trunc(overrides.maxTokens) : 4096

  const model = {
    id: normalized.model || 'unknown',
    name: normalized.model || 'unknown',
    api,
    provider: normalized.provider,
    baseUrl,
    reasoning,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens,
  }

  if (api === 'openai-completions') {
    model.compat = {
      supportsStore: false,
      supportsUsageInStreaming: true,
      supportsDeveloperRole: normalized.provider === 'openai' || baseUrl.includes('api.openai.com'),
      maxTokensField: /^(?:o[134](?:-|$)|gpt-5)/i.test(normalized.model) ? 'max_completion_tokens' : 'max_tokens',
    }
  }

  if (normalized.provider === 'openrouter') {
    model.headers = {
      'http-referer': 'https://github.com/nanxfu/aigc-studio',
      'x-title': 'AIGC Studio',
    }
  }

  return model
}

/** 对外脱敏视图：绝不包含 apiKey 原文。 */
export function publicLlmView(config) {
  const value = config && typeof config === 'object' ? config : {}
  const providerId = PROVIDER_IDS.includes(value.provider) ? value.provider : 'openai'
  const preset = PROVIDER_PRESETS[providerId]
  const normalized = normalizeLlmConfig(value)
  return {
    provider: providerId,
    // 前端不再硬编码 Provider 白名单：列表、分组、默认端点与搜索别名都由这里下发。
    providers: publicLlmProviders(),
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    hasApiKey: typeof value.apiKey === 'string' && value.apiKey.trim().length > 0,
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
    // 与该 Provider 的默认端点是否一致：设置界面据此决定 Base URL 是否需要展开。
    customBaseUrl: Boolean(normalizeBaseUrl(value.baseUrl)) && normalizeBaseUrl(value.baseUrl) !== preset.baseUrl,
    configured: normalized.configured,
  }
}

/**
 * 校验来自设置界面的 LLM 补丁（只认识白名单字段）。
 *
 * 规则：
 *  - provider 必须在预设列表内；
 *  - baseUrl 允许空串（回退预设默认）；非空必须合法；
 *  - model 允许空串（表示「尚未配置」，调用时静默降级）；最长 200 字符；
 *  - apiKey 空串表示「保持不变」；`clearLlmApiKey: true` 显式清除且优先；
 *  - reasoningEffort 必须在下拉枚举内。
 *
 * @param {unknown} patch
 * @returns {{ ok: true, value: object } | { ok: false, code: 'invalid_request', message: string }}
 */
export function normalizeLlmPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'invalid_request', message: 'llm 必须是 JSON 对象' }
  }
  const value = {}

  if (Object.prototype.hasOwnProperty.call(patch, 'provider')) {
    const provider = typeof patch.provider === 'string' ? patch.provider.trim() : patch.provider
    if (!PROVIDER_IDS.includes(provider)) {
      return { ok: false, code: 'invalid_request', message: `provider 必须是 ${PROVIDER_IDS.join(' / ')} 之一` }
    }
    value.provider = provider
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'baseUrl')) {
    if (typeof patch.baseUrl !== 'string') {
      return { ok: false, code: 'invalid_request', message: 'baseUrl 必须是字符串' }
    }
    const trimmed = patch.baseUrl.trim()
    if (trimmed) {
      const normalized = normalizeBaseUrl(trimmed)
      if (!normalized) return { ok: false, code: 'invalid_request', message: 'baseUrl 必须是 http(s) 绝对地址' }
      value.baseUrl = normalized
    } else {
      value.baseUrl = ''
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
    if (typeof patch.model !== 'string') {
      return { ok: false, code: 'invalid_request', message: 'model 必须是字符串' }
    }
    value.model = patch.model.trim().slice(0, 200)
  }

  const clear = patch.clearLlmApiKey === true
  if (clear) value.clearLlmApiKey = true
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
    if (typeof patch.apiKey !== 'string') {
      return { ok: false, code: 'invalid_request', message: 'apiKey 必须是字符串' }
    }
    const key = patch.apiKey.trim()
    if (key.length > 4096) return { ok: false, code: 'invalid_request', message: 'apiKey 过长' }
    if (key && !clear) value.apiKey = key
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort')) {
    const effort = typeof patch.reasoningEffort === 'string' ? patch.reasoningEffort.trim() : patch.reasoningEffort
    if (!REASONING_EFFORTS.includes(effort)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: `reasoningEffort 必须是 ${REASONING_EFFORTS.filter(Boolean).join(' / ')} 之一或空串`,
      }
    }
    value.reasoningEffort = effort
  }

  return { ok: true, value }
}
