/**
 * Ollama 原生协议的流式实现（本机/局域网模型，无需 API Key）。
 *
 * 协议要点：
 *  - `POST <baseUrl>/api/chat`，响应是 NDJSON（每行一个 JSON），不是 SSE；
 *  - system prompt 作为 messages 的第一条 `role: 'system'`；
 *  - 正文在 `message.content`，思考在 `message.thinking`（支持 thinking 的模型才有）；
 *  - `done: true` 结束，`done_reason` 为 `stop` / `length`；
 *  - 出错时该行是 `{ error: "..." }`。
 */

import { mapFinishReason } from '../finish.js'
import { joinUrl, postJsonStream } from '../request.js'
import { readJsonLines } from '../sse.js'

/** messages 归一：Ollama 只要 role + 字符串 content。 */
function toOllamaMessages(messages, system) {
  const output = []
  if (typeof system === 'string' && system.trim()) output.push({ role: 'system', content: system })
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
    let content = ''
    if (typeof message.content === 'string') content = message.content
    else if (Array.isArray(message.content)) {
      content = message.content
        .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('')
    }
    if (!content.trim()) continue
    output.push({ role, content })
  }
  return output
}

/**
 * @param {{ config: object, messages?: Array<object>, system?: string, maxTokens?: number,
 *           signal?: AbortSignal, temperature?: number, fetchImpl?: typeof fetch }} input
 * @returns {AsyncGenerator<object>}
 */
export async function* streamChat(input) {
  const { config } = input
  const body = {
    model: config.model,
    messages: toOllamaMessages(input.messages, input.system),
    stream: true,
  }
  const options = {}
  if (Number.isFinite(input.maxTokens)) options.num_predict = input.maxTokens
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) options.temperature = input.temperature
  if (Object.keys(options).length > 0) body.options = options

  const response = await postJsonStream(joinUrl(config.baseUrl, 'api/chat'), {
    body,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
  })

  let doneReason = null
  let usage = null
  for await (const payload of readJsonLines(response.body)) {
    if (!payload || typeof payload !== 'object') continue
    if (typeof payload.error === 'string' && payload.error) {
      const error = new Error(payload.error)
      error.code = 'llm_provider_error'
      throw error
    }
    const message = payload.message ?? null
    if (message) {
      if (typeof message.thinking === 'string' && message.thinking) {
        yield { type: 'reasoning-delta', text: message.thinking }
      }
      if (typeof message.content === 'string' && message.content) {
        yield { type: 'text-delta', text: message.content }
      }
    }
    if (payload.done) {
      if (typeof payload.done_reason === 'string') doneReason = payload.done_reason
      if (payload.eval_count || payload.prompt_eval_count) {
        usage = { outputTokens: payload.eval_count ?? null, inputTokens: payload.prompt_eval_count ?? null }
      }
      break
    }
  }

  yield { type: 'finish', reason: { kind: mapFinishReason(doneReason) }, ...(usage ? { usage } : {}) }
}
