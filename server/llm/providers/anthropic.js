/**
 * Anthropic Messages API 的流式实现。
 *
 * 协议要点：
 *  - `POST <baseUrl>/v1/messages`（baseUrl 已带 `/v1` 时不再重复）；
 *  - 鉴权用 `x-api-key` + `anthropic-version: 2023-06-01`；
 *  - system prompt 是顶层 `system` 字段，不在 messages 里；
 *  - SSE 事件有 `event:` 名：content_block_delta 里文本是 `text_delta`，
 *    思考是 `thinking_delta`，工具参数是 `input_json_delta`（partial_json 片段）；
 *  - 结束在 `message_delta.delta.stop_reason` 与 `message_stop`。
 */

import { mapFinishReason } from '../finish.js'
import { joinUrl, postJsonStream } from '../request.js'
import { parseDataJson, readSseEvents } from '../sse.js'

const ANTHROPIC_VERSION = '2023-06-01'

/** baseUrl 可能已带 /v1（用户填 https://api.anthropic.com/v1），避免拼成 /v1/v1/messages。 */
function messagesUrl(baseUrl) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '')
  if (/\/v1$/.test(base)) return `${base}/messages`
  return joinUrl(base, 'v1/messages')
}

/** messages 归一：Anthropic 要求 content 是内容块数组，且不允许空文本块。 */
function toAnthropicMessages(messages) {
  const output = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = []
    if (typeof message.content === 'string') {
      if (message.content.trim()) blocks.push({ type: 'text', text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
        if (!block.text.trim()) continue
        blocks.push({ type: 'text', text: block.text })
      }
    }
    if (blocks.length > 0) output.push({ role, content: blocks })
  }
  return output
}

/**
 * @param {{ config: object, messages?: Array<object>, system?: string, maxTokens?: number,
 *           signal?: AbortSignal, tools?: Array<object>, temperature?: number, fetchImpl?: typeof fetch }} input
 * @returns {AsyncGenerator<object>}
 */
export async function* streamChat(input) {
  const { config } = input
  const body = {
    model: config.model,
    max_tokens: Number.isFinite(input.maxTokens) ? input.maxTokens : 900,
    messages: toAnthropicMessages(input.messages),
    stream: true,
  }
  if (typeof input.system === 'string' && input.system.trim()) body.system = input.system
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) body.temperature = input.temperature
  if (Array.isArray(input.tools) && input.tools.length > 0) body.tools = input.tools

  const headers = {
    'x-api-key': config.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }

  const response = await postJsonStream(messagesUrl(config.baseUrl), {
    headers,
    body,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
  })

  let stopReason = null
  let usage = null
  /** @type {Map<number, { id: string, name: string, json: string }>} */
  const blocks = new Map()

  for await (const event of readSseEvents(response.body)) {
    const payload = parseDataJson(event.data)
    if (!payload) continue
    const type = payload.type ?? event.event

    if (type === 'error') {
      const message = typeof payload.error?.message === 'string' ? payload.error.message : '模型返回错误'
      const error = new Error(message)
      error.code = 'llm_provider_error'
      error.providerCode = payload.error?.type ?? null
      throw error
    }

    if (type === 'message_start' && payload.message?.usage) usage = payload.message.usage

    if (type === 'content_block_start') {
      const block = payload.content_block ?? null
      const index = Number.isFinite(payload.index) ? payload.index : blocks.size
      if (block && block.type === 'tool_use') {
        blocks.set(index, { id: typeof block.id === 'string' ? block.id : '', name: typeof block.name === 'string' ? block.name : '', json: '' })
      }
      if (block && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'reasoning-delta', text: block.thinking }
      }
    }

    if (type === 'content_block_delta') {
      const delta = payload.delta ?? null
      if (!delta) continue
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        yield { type: 'text-delta', text: delta.text }
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        yield { type: 'reasoning-delta', text: delta.thinking }
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const index = Number.isFinite(payload.index) ? payload.index : 0
        const current = blocks.get(index) ?? { id: '', name: '', json: '' }
        current.json += delta.partial_json
        blocks.set(index, current)
      }
      continue
    }

    if (type === 'message_delta') {
      if (payload.delta && typeof payload.delta.stop_reason === 'string') stopReason = payload.delta.stop_reason
      if (payload.usage) usage = { ...(usage ?? {}), ...payload.usage }
      continue
    }

    if (type === 'message_stop') break
  }

  const toolCalls = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, value]) => value.name)
    .map(([index, value]) => ({
      id: value.id || `tool_${index}`,
      name: value.name,
      arguments: value.json || '{}',
    }))

  yield {
    type: 'finish',
    reason: { kind: mapFinishReason(stopReason) },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  }
}
