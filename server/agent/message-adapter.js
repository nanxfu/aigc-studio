/**
 * 工作台 Agent 消息适配（Phase 1 最小实现）。
 *
 * 与 DSH 版 `convertToLlm` 的差异：独立客户端不再有「确认卡 / 任务气泡」这类宿主自定义消息，
 * 对话记录统一是纯文本消息。本文件只做三件事：
 *  1. 把任意来源（HTTP 请求、未来 MCP、工作台卡片快照）的消息归一成 LLM 可用的
 *     `{ role, content }` 数组，保证发给模型的内容里不掺 UI 状态；
 *  2. 把工具执行结果折叠成模型可读的文本段（Phase 1 用文本回填，不依赖各家原生工具消息）；
 *  3. 限制条数与单条长度，避免一次请求把整段历史全塞进上下文。
 */

/** 单条消息最大字符数（超出截断并标注）。 */
const MAX_MESSAGE_CHARS = 8000
/** 最多保留的历史条数（保留最近的部分，system 单独处理）。 */
const MAX_MESSAGES = 40

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      // 工具结果块（未来 MCP / 卡片快照）按文本折叠，避免把结构化对象喂给模型造成歧义。
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
 * 归一化对话消息。
 *
 * @param {Array<{ role?: string, content?: unknown }>} messages
 * @returns {Array<{ role: 'user'|'assistant'|'system', content: string }>}
 */
export function normalizeConversation(messages) {
  const output = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user'
    const text = blockText(message.content).trim()
    if (!text) continue
    output.push({ role, content: truncate(text) })
  }
  if (output.length <= MAX_MESSAGES) return output
  // system 消息通常在最前且只有一条：保留它，再截取最近的历史。
  const system = output.filter((item) => item.role === 'system')
  const rest = output.filter((item) => item.role !== 'system')
  return [...system, ...rest.slice(-MAX_MESSAGES)]
}

/**
 * 把一次工具调用折叠成回填给模型的文本。
 *
 * @param {{ name: string, ok: boolean, text: string }} result
 * @returns {{ role: 'user', content: string }}
 */
export function toolResultMessage(result) {
  const label = result.ok ? '工具结果' : '工具失败'
  return {
    role: 'user',
    content: `【${label}】${result.name}\n${result.text}`,
  }
}

/** 把最近一次 assistant 的工具调用意图折叠成 user 消息前的说明（无原生 tool 消息时的替代）。 */
export function toolCallMessage(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return null
  const lines = calls.map((call) => `- ${call.name}(${call.arguments || '{}'})`)
  return { role: 'user', content: `【继续】你刚请求了以下工具调用，结果附在本条之后：\n${lines.join('\n')}` }
}
