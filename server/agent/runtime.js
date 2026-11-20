/**
 * 独立创作 Agent 运行时（Phase 1 最小工具循环）。
 *
 * 设计取舍（与 Plan §三.1 的差异，记录在 docs/MIGRATION_NOTES.md）：
 *  - 不引入 pi-agent-core：Phase 1 只需要「模型 → 调工具 → 再喂结果 → 出终稿」这一条循环；
 *  - 工具协议只做「声明 + 文本回填」：模型可以声明要调用的工具，执行结果以文本消息回填，
 *    不依赖 OpenAI / Anthropic 各自的原生工具消息格式，因此三类后端都能跑同一条循环；
 *  - 事件用回调推给 SSE 路由：text / tool-start / tool-result / done / error。
 *
 * 后续（Phase 2）如需严格的多轮原生工具协议（tool_calls / tool_result 消息），
 * 在 providers 层补结构化消息即可，本文件的循环与事件契约保持不变。
 */

import { normalizeConversation, toolResultMessage, toolCallMessage } from './message-adapter.js'

const DEFAULT_MAX_STEPS = 6
const DEFAULT_MAX_TOOL_CALLS = 4

/**
 * @param {{ llm: object, tools: object, log?: object, maxSteps?: number, maxToolCalls?: number }} options
 *   llm：server/llm/service.js 的实例；tools：server/agent/tools.js 的注册表。
 */
export function createAgentRuntime({ llm, tools, log, maxSteps = DEFAULT_MAX_STEPS, maxToolCalls = DEFAULT_MAX_TOOL_CALLS }) {
  if (!llm || typeof llm.complete !== 'function') throw new Error('Agent 运行时需要 LLM 服务')
  if (!tools || typeof tools.execute !== 'function') throw new Error('Agent 运行时需要工具注册表')

  /** 按当前后端协议转换工具声明；Ollama 原生协议本轮不开启工具。 */
  function toolDefinitions() {
    if (typeof tools.size === 'function' && tools.size() === 0) return []
    let protocol = 'openai'
    try {
      protocol = llm.currentConfig?.().protocol ?? 'openai'
    } catch {
      protocol = 'openai'
    }
    if (protocol === 'anthropic') return tools.toAnthropicTools()
    if (protocol === 'ollama') return []
    return tools.toOpenAiTools()
  }

  /**
   * 跑一轮（可能多步的）创作对话。
   *
   * @param {{ messages: Array<object>, system?: string, signal?: AbortSignal,
   *           onEvent?: (event: object) => void }} input
   * @returns {Promise<{ text: string, steps: number, stopReason: string, toolResults: Array<object> }>}
   */
  async function run(input = {}) {
    const emit = typeof input.onEvent === 'function' ? input.onEvent : () => {}
    const conversation = normalizeConversation(input.messages)
    const toolDefs = toolDefinitions()
    const toolResults = []
    let text = ''
    let step = 0

    while (step < maxSteps) {
      step += 1
      const result = await llm.complete({
        messages: conversation,
        system: input.system,
        tools: toolDefs,
        signal: input.signal,
      })
      text = result.text ?? ''
      if (text) emit({ type: 'text', step, text })

      const calls = Array.isArray(result.toolCalls) ? result.toolCalls.slice(0, maxToolCalls) : []
      if (calls.length === 0) {
        return { text, steps: step, stopReason: result.finish?.kind ?? 'stop', toolResults }
      }

      const callSummary = toolCallMessage(calls)
      if (callSummary) conversation.push(callSummary)
      for (const call of calls) {
        emit({ type: 'tool-start', step, name: call.name, arguments: call.arguments })
        const executed = await tools.execute(call.name, call.arguments)
        toolResults.push(executed)
        emit({ type: 'tool-result', step, name: executed.name, ok: executed.ok, text: executed.text })
        conversation.push(toolResultMessage(executed))
      }
      // 没有工具声明能力时（例如 Ollama），模型不会再给出 toolCalls，循环自然收敛到上面的 return。
    }

    log?.warn?.(`agent_max_steps steps=${step} tools=${toolResults.length}`)
    return { text, steps: step, stopReason: 'max-steps', toolResults }
  }

  return { run, toolDefinitions }
}
