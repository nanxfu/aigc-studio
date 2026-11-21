/**
 * 独立 LLM 服务（基于 `@earendil-works/pi-ai` 底座）。
 *
 * 职责：
 *  - 统一对接 `@earendil-works/pi-ai` 的 `openai-completions`（OpenAI / DeepSeek / OpenRouter /
 *    Ollama / 自定义兼容端点）与 `anthropic-messages`（Anthropic）；
 *  - 对 `server/llm.js` 保持既有 `getSelection / stream / prepareCall / complete / describe` 契约，
 *    使提示词润色（enhance）与意图解析（intent）零改动切换至 `pi-ai`；
 *  - 同时提供标准 `streamFn`（`AssistantMessageEventStream`）与 `piModel()` 给
 *    `server/agent/runtime.js`（`@earendil-works/pi-agent-core`）复用。
 */

import { streamSimple as streamAnthropicSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamOpenAiSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

import { createLogger } from '../log.js'
import {
  isLlmConfigured,
  normalizeLlmConfig,
  piModelOf,
  publicLlmView,
} from './config.js'
import { mapFinishReason } from './finish.js'

const defaultLog = createLogger({ scope: 'llm' })

const EMPTY_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const VALID_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high'])

/** 按 `model.api` 分发到对应的 `pi-ai` 协议实现。 */
export function piStreamFn(model, transcriptContext, options) {
  if (model?.api === 'anthropic-messages') {
    return streamAnthropicSimple(model, transcriptContext, options)
  }
  return streamOpenAiSimple(model, transcriptContext, options)
}

/** 供 prepareCall 的 controls 回调判断「模型支持哪些思考档位」。 */
function modelMetaOf(config, model) {
  const efforts =
    model.api === 'openai-completions' && model.reasoning
      ? [{ id: 'off' }, { id: 'minimal' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }]
      : model.api === 'anthropic-messages'
        ? [{ id: 'off' }]
        : []
  return { id: config.model, provider: config.provider, reasoning: { efforts } }
}

/** 把任意文本 / 块数组消息归一为纯字符串（用于转换历史消息）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * 把调用方的 `{ role, content }` 消息数组转成 `pi-ai` `Message[]`。
 *（已在 `pi-ai` 标准格式的消息原样保留，仅补充缺失字段。）
 */
function toPiMessages(messages, model) {
  const out = []
  const now = Date.now()
  for (const item of Array.isArray(messages) ? messages : []) {
    if (!item || typeof item !== 'object') continue
    if (item.role === 'toolResult') {
      out.push(item)
      continue
    }
    if (item.role === 'assistant') {
      if (Array.isArray(item.content) && item.api && item.provider) {
        out.push(item)
        continue
      }
      const text = textOfContent(item.content)
      if (!text) continue
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : now,
      })
      continue
    }
    if (item.role === 'system') {
      const text = textOfContent(item.content)
      if (text) out.push({ role: 'system', content: text, timestamp: typeof item.timestamp === 'number' ? item.timestamp : now })
      continue
    }
    const text = textOfContent(item.content)
    if (!text) continue
    out.push({
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : now,
    })
  }
  return out
}

/** 把客户端工具声明（OpenAI `{type:'function',function}` / Anthropic `{name,input_schema}` / pi `Tool`）归一成 `pi-ai` `Tool[]`。 */
function toPiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.type === 'function' && tool.function) {
      out.push({
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      })
      continue
    }
    if (tool.name && (tool.parameters || tool.input_schema)) {
      out.push({
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? tool.input_schema,
      })
    }
  }
  return out.length > 0 ? out : undefined
}

/** 把 `pi-ai` 的 `stopReason` 映射成工作台内部终止口径。 */
function mapPiStopReason(reason) {
  if (reason === 'toolUse') return 'tool-calls'
  if (reason === 'length') return 'max-tokens'
  return mapFinishReason(reason)
}

/** 把 `pi-ai` error 事件转成带稳定错误码的 Error 对象。 */
function toServiceError(event) {
  const reason = event?.reason
  const message = event?.error?.errorMessage || '模型返回错误'
  if (reason === 'aborted') {
    const error = new Error(message)
    error.code = 'llm_aborted'
    return error
  }
  const error = new Error(message)
  // 尽量从 pi-ai 归一化后的状态码 / JSON 文本识别 HTTP 错与 provider 错误码，便于上游日志分类。
  const statusMatch = /^(\d{3})\b/.exec(message.trim()) || /\bstatus\s+(\d{3})\b/i.exec(message)
  if (statusMatch) {
    error.code = 'llm_http_error'
    error.status = Number(statusMatch[1])
  } else if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(message)) {
    error.code = 'llm_network_error'
  } else {
    error.code = 'llm_http_error'
  }
  const jsonStart = message.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart))
      const inner = parsed?.error ?? parsed
      if (inner && (inner.code || inner.type)) {
        error.providerCode = inner.code ?? inner.type
      }
    } catch {}
  }
  return error
}

/**
 * 创建基于 `pi-ai` 的 LLM 服务。
 *
 * @param {{ getConfig?: () => object|null, log?: object }} [options]
 *   getConfig 由装配层注入（读 app-config + credentials，返回含 apiKey 的完整配置对象）。
 */
export function createLlmService(options = {}) {
  const log = options.log ?? defaultLog
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => null

  /** 每次调用都重新读取配置：设置抽屉保存后无需重启服务即可生效。 */
  function currentConfig() {
    let raw = null
    try {
      raw = getConfig()
    } catch (error) {
      log.warn(`llm_config_error detail=${String(error?.message ?? error)}`)
      raw = null
    }
    return normalizeLlmConfig(raw ?? {})
  }

  /** 按当前配置（允许单次覆盖 provider/model/maxTokens）构造 `pi-ai` Model。 */
  function resolveModel(overrides = {}) {
    const base = currentConfig()
    const effective = normalizeLlmConfig({
      ...base,
      ...(typeof overrides.provider === 'string' && overrides.provider ? { provider: overrides.provider } : {}),
      ...(typeof overrides.model === 'string' && overrides.model ? { model: overrides.model } : {}),
    })
    return { effective, model: piModelOf(effective, { maxTokens: overrides.maxTokens }) }
  }

  /** 解析给 `pi-ai` 使用的 API Key（Ollama 等免鉴权端点给占位值满足 SDK 非空校验）。 */
  function resolveApiKey(config) {
    if (config.apiKey) return config.apiKey
    return config.protocol === 'ollama' ? 'ollama' : ''
  }

  /** 宿主侧「当前选中模型」：未配置完整时返回 null，让 server/llm.js 走本地兜底。 */
  function getSelection() {
    const config = currentConfig()
    if (!isLlmConfigured(config)) return null
    return {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      hasApiKey: Boolean(config.apiKey),
    }
  }

  /**
   * 流式调用（对外保持原 chunk 协议，内部全部走 `@earendil-works/pi-ai`）。
   *
   * @param {{ provider?: string, model?: string, messages?: Array<object>, system?: string,
   *           maxTokens?: number, signal?: AbortSignal, tools?: Array<object>,
   *           temperature?: number, reasoningEffort?: string, fetchImpl?: typeof fetch }} [input]
   * @returns {AsyncGenerator<object>}
   */
  async function* stream(input = {}) {
    const { effective, model } = resolveModel({
      provider: input.provider,
      model: input.model,
      maxTokens: input.maxTokens,
    })
    if (!isLlmConfigured(effective)) {
      const error = new Error('未配置可用的模型：请在设置里填写 Base URL / Model / API Key')
      error.code = 'llm_not_configured'
      throw error
    }

    const piMessages = toPiMessages(input.messages, model)
    const piTools = toPiTools(input.tools)
    const transcript = normalizeContext({
      systemPrompt: typeof input.system === 'string' && input.system.trim() ? input.system : undefined,
      messages: piMessages,
      tools: piTools,
    })

    const requestedEffort = typeof input.reasoningEffort === 'string' && VALID_THINKING.has(input.reasoningEffort)
      ? input.reasoningEffort
      : VALID_THINKING.has(effective.reasoningEffort)
        ? effective.reasoningEffort
        : 'off'

    const streamOptions = {
      apiKey: resolveApiKey(effective),
      signal: input.signal,
      maxTokens: Number.isFinite(input.maxTokens) ? input.maxTokens : 900,
      ...(typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? { temperature: input.temperature } : {}),
      ...(model.reasoning && requestedEffort !== 'off' ? { reasoning: requestedEffort } : {}),
      ...(typeof input.fetchImpl === 'function' ? { fetch: input.fetchImpl } : {}),
      ...(typeof input.sessionId === 'string' && input.sessionId ? { sessionId: input.sessionId } : {}),
      maxRetries: 0,
    }

    log.info(`llm_stream backend=pi-ai provider=${effective.provider} api=${model.api} model=${model.id}`)

    const eventStream = piStreamFn(model, transcript, streamOptions)
    for await (const event of eventStream) {
      if (!event || typeof event !== 'object') continue
      if (event.type === 'text_delta' && event.delta) {
        yield { type: 'text-delta', text: event.delta }
        continue
      }
      if (event.type === 'thinking_delta' && event.delta) {
        yield { type: 'reasoning-delta', text: event.delta }
        continue
      }
      if (event.type === 'error') {
        throw toServiceError(event)
      }
      if (event.type === 'done') {
        const message = event.message ?? {}
        const blocks = Array.isArray(message.content) ? message.content : []
        const toolCalls = blocks
          .filter((block) => block && block.type === 'toolCall')
          .map((block, index) => ({
            id: block.id || `call_${index}`,
            name: block.name,
            arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          }))
        const usage = message.usage
          ? {
              inputTokens: message.usage.input ?? 0,
              outputTokens: message.usage.output ?? 0,
              totalTokens: message.usage.totalTokens ?? 0,
            }
          : null
        yield {
          type: 'finish',
          reason: { kind: mapPiStopReason(event.reason) },
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(usage ? { usage } : {}),
        }
      }
    }
  }

  /**
   * 兼容宿主两次尝试策略：先拿到「可复用的调用配置」，失败时还能直接调 `stream`。
   */
  async function prepareCall(target, _signal, controls) {
    const { effective, model } = resolveModel({
      provider: target?.provider,
      model: target?.model,
      maxTokens: target?.maxTokens,
    })
    if (!target || typeof target.model !== 'string' || !target.model) return null
    let extra = {}
    if (typeof controls === 'function') {
      try {
        extra = controls({}, modelMetaOf(effective, model)) ?? {}
      } catch {
        extra = {}
      }
    }
    const callConfig = {
      provider: target.provider ?? effective.provider,
      model: target.model,
      maxTokens: target.maxTokens,
      ...extra,
    }
    return {
      config: callConfig,
      stream(effectiveOptions = {}) {
        return stream({ ...effectiveOptions, ...callConfig, provider: callConfig.provider, model: callConfig.model })
      },
    }
  }

  /**
   * 收集一次完整调用。
   *
   * @param {object} input 与 stream 相同
   * @returns {Promise<{ text: string, reasoning: string, toolCalls: Array<object>,
   *                     finish: { kind: string, failure?: object } | null, usage: object|null }>}
   */
  async function complete(input = {}) {
    let text = ''
    let reasoning = ''
    let finish = null
    let usage = null
    for await (const chunk of stream(input)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text ?? ''
      else if (chunk.type === 'finish') {
        finish = chunk.reason ?? null
        if (chunk.usage) usage = chunk.usage
        if (Array.isArray(chunk.toolCalls) && chunk.toolCalls.length > 0) {
          finish = { ...(finish ?? {}), toolCalls: chunk.toolCalls }
        }
      }
    }
    return { text, reasoning, toolCalls: Array.isArray(finish?.toolCalls) ? finish.toolCalls : [], finish, usage }
  }

  /** 脱敏配置视图（设置接口与诊断使用）。 */
  function describe() {
    return publicLlmView(currentConfig())
  }

  /** 提供给 `pi-agent-core` `Agent` 使用的配置、Model 与 `streamFn`。 */
  function agentTarget(overrides = {}) {
    const { effective, model } = resolveModel(overrides)
    return {
      configured: isLlmConfigured(effective),
      config: effective,
      model,
      apiKey: resolveApiKey(effective),
      streamFn: piStreamFn,
    }
  }

  return { stream, prepareCall, complete, getSelection, describe, currentConfig, agentTarget }
}

export default createLlmService
