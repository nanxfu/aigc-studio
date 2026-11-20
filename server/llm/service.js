/**
 * 独立 LLM 服务（Phase 1 零外部依赖实现）。
 *
 * 为什么自研而不是引入 pi-ai：Phase 1 只需要「流式文本 + 工具调用」两件事，
 * 自研一个 300 行左右的 fetch 客户端即可覆盖 OpenAI 兼容 / Anthropic / Ollama 三类后端，
 * 不引入依赖体积与版本约束，也便于用本地 mock HTTP 服务做离线回归。
 * 对外接口按 DSH 宿主 `ctx.get('llm')` 的既有形状设计，`server/llm.js` 无需改动即可复用。
 *
 * 对 `server/llm.js` 的契约：
 *   - `getSelection()`：返回 `{ provider, model, baseUrl, hasApiKey }` 或 null（未配置 → 静默降级）；
 *   - `stream(options)`：AsyncIterable，chunk 为 text-delta / reasoning-delta / finish；
 *   - `prepareCall(target, signal, controls)`：返回 `{ config, stream }`，兼容其两次尝试策略。
 *
 * 额外提供给 Agent 侧：
 *   - `complete(options)`：收集完整文本 + 工具调用（非流式语义）；
 *   - `describe()`：脱敏配置视图，供设置接口使用。
 */

import { createLogger } from '../log.js'
import {
  isLlmConfigured,
  normalizeLlmConfig,
  publicLlmView,
} from './config.js'
import * as anthropicProvider from './providers/anthropic.js'
import * as ollamaProvider from './providers/ollama.js'
import * as openaiProvider from './providers/openai.js'

const defaultLog = createLogger({ scope: 'llm' })

/** 协议 → provider 实现。 */
const PROVIDERS = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  ollama: ollamaProvider,
}

/** 供 prepareCall 的 controls 回调判断「模型支持哪些思考档位」。 */
function modelMetaOf(config) {
  const efforts =
    config.protocol === 'openai'
      ? [{ id: 'off' }, { id: 'minimal' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }]
      : config.protocol === 'anthropic'
        ? [{ id: 'off' }]
        : []
  return { id: config.model, provider: config.provider, reasoning: { efforts } }
}

/**
 * 创建 LLM 服务。
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
   * 流式调用。
   *
   * @param {{ provider?: string, model?: string, messages?: Array<object>, system?: string,
   *           maxTokens?: number, signal?: AbortSignal, tools?: Array<object>,
   *           temperature?: number, fetchImpl?: typeof fetch }} [input]
   * @returns {AsyncGenerator<object>}
   */
  async function* stream(input = {}) {
    const config = currentConfig()
    const providerId = typeof input.provider === 'string' && input.provider ? input.provider : config.provider
    const preset = PROVIDERS[config.protocol]
    // 允许调用方临时指定 provider / model（Agent 侧按单次任务选模型），但沿用同一份鉴权与地址。
    const effective = {
      ...config,
      provider: typeof input.provider === 'string' && input.provider ? input.provider : config.provider,
      model: typeof input.model === 'string' && input.model ? input.model : config.model,
    }
    if (!isLlmConfigured(effective)) {
      const error = new Error('未配置可用的模型：请在设置里填写 Base URL / Model / API Key')
      error.code = 'llm_not_configured'
      throw error
    }
    const implementation = PROVIDERS[effective.protocol] ?? preset
    log.info(`llm_stream provider=${providerId} model=${effective.model} maxTokens=${input.maxTokens ?? '-'}`)
    yield* implementation.streamChat({ ...input, config: effective })
  }

  /**
   * 兼容宿主两次尝试策略：先拿到「可复用的调用配置」，失败时还能直接调 `stream`。
   * controls 回调用于让调用方决定思考档位。
   */
  async function prepareCall(target, _signal, controls) {
    const config = currentConfig()
    if (!target || typeof target.model !== 'string' || !target.model) return null
    let extra = {}
    if (typeof controls === 'function') {
      try {
        extra = controls({}, modelMetaOf({ ...config, model: target.model })) ?? {}
      } catch {
        extra = {}
      }
    }
    const callConfig = {
      provider: target.provider ?? config.provider,
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
   * 收集一次完整调用（供 Agent 工具循环使用）。
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

  return { stream, prepareCall, complete, getSelection, describe, currentConfig }
}

export default createLlmService
