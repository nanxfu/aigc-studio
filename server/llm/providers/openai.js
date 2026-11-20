/**
 * OpenAI 兼容协议的流式实现（OpenAI / DeepSeek / OpenRouter / 自建兼容端点）。
 *
 * 协议要点：
 *  - `POST <baseUrl>/chat/completions`，`stream: true`，响应是 SSE；
 *  - 正文在 `choices[0].delta.content`；部分推理模型把思考放在 `reasoning_content` / `reasoning`；
 *  - 工具调用在 `delta.tool_calls[i]` 里分片下发（索引 + 名字 + 参数片段），需按索引累积；
 *  - 结束由 `choices[0].finish_reason` 与 `data: [DONE]` 共同标记。
 *
 * 产出 chunk 统一形状（与 server/llm.js 的收集逻辑对齐）：
 *   { type: 'text-delta', text }
 *   { type: 'reasoning-delta', text }
 *   { type: 'finish', reason: { kind, failure? }, toolCalls? }
 */

import { mapFinishReason } from '../finish.js'
import { joinUrl, postJsonStream } from '../request.js'
import { parseDataJson, readSseEvents } from '../sse.js'

/** 推理模型（OpenAI o 系列 / GPT-5）用于决定参数名与 reasoning_effort 是否可下发。 */
const REASONING_MODEL_RE = /^(?:o[134]|o[134]-|gpt-5)/i

/** 把对话消息归一为 OpenAI 形状（content 允许字符串或文本块数组）。 */
function toOpenAiMessages(messages, system) {
  const output = []
  if (typeof system === 'string' && system.trim()) output.push({ role: 'system', content: system })
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
    const content = normalizeContent(message.content)
    if (!content) continue
    output.push({ role, content })
  }
  return output
}

function normalizeContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * 调用 OpenAI 兼容端点。
 *
 * @param {{ config: object, messages?: Array<object>, system?: string, maxTokens?: number,
 *           signal?: AbortSignal, tools?: Array<object>, temperature?: number, fetchImpl?: typeof fetch }} input
 * @returns {AsyncGenerator<object>}
 */
export async function* streamChat(input) {
  const { config } = input
  const url = joinUrl(config.baseUrl, 'chat/completions')
  const maxTokens = Number.isFinite(input.maxTokens) ? input.maxTokens : 900
  // 推理模型（o 系列 / GPT-5）要 max_completion_tokens，且只接受 minimal|low|medium|high 档位；
  // 「off」表示不要显式思考档位，直接省略参数（工作台默认走最低档，见 server/llm.js）。
  const reasoningModel = REASONING_MODEL_RE.test(String(config.model ?? ''))
  const body = {
    model: config.model,
    messages: toOpenAiMessages(input.messages, input.system),
    stream: true,
    ...(reasoningModel ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
  }
  if (reasoningModel && ['minimal', 'low', 'medium', 'high'].includes(config.reasoningEffort)) {
    body.reasoning_effort = config.reasoningEffort
  }
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) body.temperature = input.temperature
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    body.tools = input.tools
    body.tool_choice = 'auto'
  }

  const headers = {}
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
  if (config.provider === 'openrouter') {
    // OpenRouter 推荐带来源标识，缺失也能用；这里用项目名，避免匿名调用被限流。
    headers['http-referer'] = 'https://github.com/nanxfu/aigc-studio'
    headers['x-title'] = 'AIGC Studio'
  }

  const response = await postJsonStream(url, { headers, body, signal: input.signal, fetchImpl: input.fetchImpl })

  let finishKind = null
  let usage = null
  /** @type {Map<number, { id: string, name: string, arguments: string }>} */
  const toolCalls = new Map()

  for await (const event of readSseEvents(response.body)) {
    const data = event.data
    if (data === '[DONE]') break
    const payload = parseDataJson(data)
    if (!payload) continue
    if (payload.error) {
      const message = typeof payload.error.message === 'string' ? payload.error.message : '模型返回错误'
      const error = new Error(message)
      error.code = 'llm_provider_error'
      error.providerCode = payload.error.code ?? payload.error.type ?? null
      throw error
    }
    if (payload.usage) usage = payload.usage
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
    if (!choice) continue
    const delta = choice.delta ?? choice.message ?? null
    if (delta) {
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : ''
      if (reasoning) yield { type: 'reasoning-delta', text: reasoning }
      const text = typeof delta.content === 'string' ? delta.content : Array.isArray(delta.content) ? normalizeContent(delta.content) : ''
      if (text) yield { type: 'text-delta', text }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number.isFinite(call.index) ? call.index : toolCalls.size
          const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' }
          if (typeof call.id === 'string' && call.id) current.id = call.id
          const fn = call.function ?? null
          if (fn) {
            if (typeof fn.name === 'string' && fn.name) current.name = fn.name
            if (typeof fn.arguments === 'string' && fn.arguments) current.arguments += fn.arguments
          }
          toolCalls.set(index, current)
        }
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishKind = choice.finish_reason
  }

  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, value]) => ({ id: value.id || `call_${index}`, name: value.name, arguments: value.arguments }))
  yield {
    type: 'finish',
    reason: { kind: mapFinishReason(finishKind) },
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
    ...(usage ? { usage } : {}),
  }
}
