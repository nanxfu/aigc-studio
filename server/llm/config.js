/**
 * LLM 配置的归一化、脱敏视图与 pi-ai Model 构造（纯函数，不碰磁盘）。
 *
 * 存储分工：
 *  - 非敏感字段（provider / baseUrl / model / reasoningEffort）随 app-config.json 保存；
 *  - apiKey 单独存 `credentials/llm.json`（0600，或由主进程 safeStorage 加密托管），
 *    本文件只做校验与对外视图，任何日志或 HTTP 响应都不得出现 Key 原文。
 *
 * 接入 `@earendil-works/pi-ai` 后的协议映射：
 *  - `openai` / `deepseek` / `openrouter` / `custom` / `ollama`：走 `openai-completions`；
 *    其中 Ollama 若填写根地址 `http://127.0.0.1:11434` 会自动补 `/v1`，无需用户手改配置；
 *  - `anthropic`：走 `anthropic-messages`（自动去掉末尾 `/v1`，避免 SDK 拼出 `/v1/v1/messages`）。
 */

/** 推理模型（OpenAI o 系列 / GPT-5 / Claude 3.7+/4+）：决定 piModel.reasoning 与思考档位。 */
const REASONING_MODEL_RE = /^(?:o[134](?:-|$)|gpt-5|claude-(?:3-7|sonnet-4|opus-4|haiku-4))/i

/** provider 预设：baseUrl 缺省值与 pi-ai API 映射。 */
export const PROVIDER_PRESETS = Object.freeze({
  openai: {
    label: 'OpenAI',
    protocol: 'openai',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    defaultModel: 'gpt-4o-mini',
  },
  deepseek: {
    label: 'DeepSeek',
    protocol: 'openai',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    defaultModel: 'deepseek-chat',
  },
  openrouter: {
    label: 'OpenRouter',
    protocol: 'openai',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    defaultModel: '',
  },
  anthropic: {
    label: 'Anthropic',
    protocol: 'anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    defaultModel: 'claude-sonnet-4-5',
  },
  ollama: {
    label: 'Ollama（本地）',
    protocol: 'ollama',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    defaultModel: '',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai',
    api: 'openai-completions',
    baseUrl: '',
    requiresKey: true,
    defaultModel: '',
  },
})

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_PRESETS))

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
export function normalizePiBaseUrl(protocol, rawBaseUrl) {
  const base = trimBaseUrl(rawBaseUrl)
  if (!base) return ''
  if (protocol === 'anthropic') return base.replace(/\/v1$/i, '')
  if (protocol === 'ollama') {
    try {
      const parsed = new URL(base)
      if (!parsed.pathname || parsed.pathname === '/') return `${base}/v1`
    } catch {}
  }
  return base
}

/**
 * 归一化 LLM 配置（传入 app-config 的原始对象，返回运行期使用的完整配置）。
 * 任何非法字段回退到预设默认值；provider 非法时回退 `openai`。
 *
 * @param {{ provider?: string, baseUrl?: string, model?: string, apiKey?: string, reasoningEffort?: string }} [input]
 * @returns {{ provider: string, protocol: 'openai'|'anthropic'|'ollama', api: 'openai-completions'|'anthropic-messages',
 *             baseUrl: string, model: string, apiKey: string, reasoningEffort: string, configured: boolean }}
 */
export function normalizeLlmConfig(input) {
  const source = input && typeof input === 'object' ? input : {}
  const providerId = PROVIDER_IDS.includes(source.provider) ? source.provider : 'openai'
  const preset = PROVIDER_PRESETS[providerId]
  const baseUrl = normalizeBaseUrl(source.baseUrl) ?? preset.baseUrl
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : ''
  const reasoningEffort =
    typeof source.reasoningEffort === 'string' && REASONING_EFFORTS.includes(source.reasoningEffort.trim())
      ? source.reasoningEffort.trim()
      : ''
  const config = {
    provider: providerId,
    protocol: preset.protocol,
    api: preset.api,
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
  const baseUrl = normalizePiBaseUrl(normalized.protocol, normalized.baseUrl)
  const reasoning = REASONING_MODEL_RE.test(normalized.model)
  const maxTokens = Number.isFinite(overrides.maxTokens) && overrides.maxTokens > 0 ? Math.trunc(overrides.maxTokens) : 4096

  const model = {
    id: normalized.model || 'unknown',
    name: normalized.model || 'unknown',
    api,
    provider: normalized.provider,
    baseUrl,
    reasoning,
    input: ['text'],
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
  return {
    provider: providerId,
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDER_PRESETS[id].label,
      requiresKey: PROVIDER_PRESETS[id].requiresKey,
      defaultModel: PROVIDER_PRESETS[id].defaultModel,
      defaultBaseUrl: PROVIDER_PRESETS[id].baseUrl,
    })),
    baseUrl: normalizeBaseUrl(value.baseUrl) ?? preset.baseUrl,
    model: typeof value.model === 'string' ? value.model.trim() : '',
    hasApiKey: typeof value.apiKey === 'string' && value.apiKey.trim().length > 0,
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
    configured: isLlmConfigured({
      provider: providerId,
      baseUrl: normalizeBaseUrl(value.baseUrl) ?? preset.baseUrl,
      model: typeof value.model === 'string' ? value.model.trim() : '',
      apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    }),
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
