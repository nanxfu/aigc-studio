/**
 * 工作台 Agent 消息适配（基于 `@earendil-works/pi-agent-core`）。
 *
 * 职责：
 *  1. `toAgentMessages()`：把 HTTP 请求 / 前端线程里的历史消息归一成 `pi-agent-core`
 *     标准的 `AgentMessage[]`（限制条数与单条字符数）；
 *  2. `convertToLlm()`：`pi-agent-core` 每轮调用 LLM 前的边界映射，保留标准
 *     `system` / `user` / `assistant`（含原生 `toolCall` 块）/ `toolResult` 消息，
 *     过滤掉仅用于 UI 展示的自定义通知消息（不污染模型上下文）。
 */

const MAX_MESSAGE_CHARS = 8000
const MAX_MESSAGES = 40

const EMPTY_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const STANDARD_ROLES = new Set(['system', 'user', 'assistant', 'toolResult'])

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'tool_result' && typeof block.content === 'string') return block.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function truncate(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return text
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n……（已截断）`
}

/**
 * 把入站对话数组转为 `pi-agent-core` 可直接消费的 `AgentMessage[]`。
 *
 * @param {Array<{ role?: string, content?: unknown, timestamp?: number }>} messages
 * @param {{ api?: string, provider?: string, id?: string }} [model]
 * @returns {Array<object>}
 */
export function toAgentMessages(messages, model = {}) {
  const output = []
  const now = Date.now()
  const api = model.api || 'openai-completions'
  const provider = model.provider || 'openai'
  const modelId = model.id || 'unknown'

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : now

    if (message.role === 'toolResult') {
      output.push(message)
      continue
    }

    if (message.role === 'system') {
      const text = blockText(message.content).trim()
      if (text) output.push({ role: 'system', content: truncate(text), timestamp })
      continue
    }

    if (message.role === 'assistant') {
      if (Array.isArray(message.content) && message.api && message.provider) {
        output.push(message)
        continue
      }
      const text = blockText(message.content).trim()
      if (!text) continue
      output.push({
        role: 'assistant',
        content: [{ type: 'text', text: truncate(text) }],
        api,
        provider,
        model: modelId,
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp,
      })
      continue
    }

    const text = blockText(message.content).trim()
    if (!text) continue
    output.push({
      role: 'user',
      content: [{ type: 'text', text: truncate(text) }],
      timestamp,
    })
  }

  if (output.length <= MAX_MESSAGES) return output
  const system = output.filter((item) => item.role === 'system')
  const rest = output.filter((item) => item.role !== 'system')
  return [...system, ...rest.slice(-MAX_MESSAGES)]
}

/**
 * `pi-agent-core` `convertToLlm`：在调用 LLM 边界过滤 UI 自定义消息，保留标准上下文。
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function convertToLlm(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (STANDARD_ROLES.has(message.role)) {
      out.push(message)
      continue
    }
    if (message.role === 'custom') {
      const text = blockText(message.content).trim()
      if (text) {
        out.push({
          role: 'user',
          content: [{ type: 'text', text: truncate(text) }],
          timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
        })
      }
    }
  }
  return out
}
