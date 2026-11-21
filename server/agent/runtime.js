/**
 * 独立创作 Agent 运行时（基于 `@earendil-works/pi-agent-core`）。
 *
 * 相比旧版手写循环的升级：
 *  - 使用 `Agent` + `pi-ai` 原生多轮 `toolCall` / `toolResult` 协议（不再用 `user` 文本模拟工具消息）；
 *  - 工具参数校验、串行/并行调度、AbortSignal 中断全部交给 `pi-agent-core`；
 *  - 通过事件订阅把流式增量与工具状态实时推送给 SSE 路由：
 *    `text-delta` / `reasoning-delta` / `text` / `tool-start` / `tool-result` / `done` / `error`。
 */

import { Agent } from '@earendil-works/pi-agent-core'

import { convertToLlm, toAgentMessages } from './message-adapter.js'

const DEFAULT_MAX_STEPS = 6

function assistantTextOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * @param {{ llm: object, tools: object, log?: object, maxSteps?: number }} options
 */
export function createAgentRuntime({ llm, tools, log, maxSteps = DEFAULT_MAX_STEPS }) {
  if (!llm || typeof llm.agentTarget !== 'function') {
    throw new Error('Agent 运行时需要基于 pi-ai 的 LLM 服务（缺少 agentTarget）')
  }
  if (!tools || typeof tools.toPiAgentTools !== 'function') {
    throw new Error('Agent 运行时需要带 toPiAgentTools() 的工具注册表')
  }

  /**
   * 跑一轮（可能多步的）创作对话。
   *
   * @param {{ messages: Array<object>, system?: string, signal?: AbortSignal,
   *           onEvent?: (event: object) => void }} input
   * @returns {Promise<{ text: string, steps: number, stopReason: string,
   *                     toolResults: Array<object>, images: Array<object> }>}
   */
  async function run(input = {}) {
    const emit = typeof input.onEvent === 'function' ? input.onEvent : () => {}
    const target = llm.agentTarget()
    if (!target?.configured) {
      const error = new Error('未配置可用的模型：请在设置里填写 Base URL / Model / API Key')
      error.code = 'llm_not_configured'
      throw error
    }

    const piTools = tools.toPiAgentTools()
    const agentMessages = toAgentMessages(input.messages, target.model)
    if (agentMessages.length === 0) {
      const error = new Error('messages 不能为空')
      error.code = 'invalid_request'
      throw error
    }

    // 历史消息作为初始上下文，最后一条 user 消息通过 agent.prompt() 注入（启动标准 agent_start → turn_start 循环）。
    const last = agentMessages[agentMessages.length - 1]
    const hasTrailingUser = last && last.role === 'user'
    const seedMessages = hasTrailingUser ? agentMessages.slice(0, -1) : agentMessages

    const thinkingLevel =
      target.model.reasoning && ['minimal', 'low', 'medium', 'high'].includes(target.config.reasoningEffort)
        ? target.config.reasoningEffort
        : 'off'

    let steps = 0
    let finalText = ''
    let stopReason = 'stop'
    let failure = null
    const toolResults = []
    const images = []
    const seenPaths = new Set()

    const agent = new Agent({
      initialState: {
        systemPrompt: typeof input.system === 'string' && input.system.trim() ? input.system.trim() : undefined,
        model: target.model,
        thinkingLevel,
        tools: piTools,
        messages: seedMessages,
      },
      convertToLlm,
      streamFn: target.streamFn,
      getApiKey: () => target.apiKey,
      toolExecution: 'sequential',
      finishTurn: () => {
        if (steps >= maxSteps) {
          stopReason = 'max-steps'
          log?.warn?.(`agent_max_steps steps=${steps} tools=${toolResults.length}`)
          return { action: 'end' }
        }
        return undefined
      },
    })

    const unsubscribe = agent.subscribe((event) => {
      if (!event || typeof event !== 'object') return
      if (event.type === 'turn_start') {
        steps += 1
        return
      }
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent
        if (!inner) return
        if (inner.type === 'text_delta' && inner.delta) {
          emit({ type: 'text-delta', step: steps, text: inner.delta })
        } else if (inner.type === 'thinking_delta' && inner.delta) {
          emit({ type: 'reasoning-delta', step: steps, text: inner.delta })
        }
        return
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const msg = event.message
        if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          stopReason = msg.stopReason
          failure = new Error(msg.errorMessage || '模型调用失败')
          failure.code = msg.stopReason === 'aborted' ? 'llm_aborted' : 'agent_failed'
          return
        }
        if (stopReason !== 'max-steps') stopReason = msg.stopReason || 'stop'
        const text = assistantTextOf(msg)
        if (text) {
          finalText = text
          emit({ type: 'text', step: steps, text })
        }
        return
      }
      if (event.type === 'tool_execution_start') {
        emit({
          type: 'tool-start',
          step: steps,
          toolCallId: event.toolCallId,
          name: event.toolName,
          arguments: event.args,
        })
        return
      }
      if (event.type === 'tool_execution_end') {
        const result = event.result ?? {}
        const text = Array.isArray(result.content)
          ? result.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : ''
        const toolImages = Array.isArray(result.details?.images) ? result.details.images : []
        for (const img of toolImages) {
          const key = img.path || img.url
          if (key && !seenPaths.has(key)) {
            seenPaths.add(key)
            images.push(img)
          }
        }
        const entry = {
          name: event.toolName,
          ok: !event.isError,
          text,
          images: toolImages,
          data: result.details?.data,
        }
        toolResults.push(entry)
        emit({
          type: 'tool-result',
          step: steps,
          toolCallId: event.toolCallId,
          name: event.toolName,
          ok: !event.isError,
          text,
          ...(toolImages.length > 0 ? { images: toolImages } : {}),
        })
      }
    })

    const onAbort = () => agent.abort()
    if (input.signal) {
      if (input.signal.aborted) agent.abort()
      else input.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      if (hasTrailingUser) {
        await agent.prompt(last)
      } else {
        await agent.continue()
      }
      await agent.waitForIdle()
    } finally {
      unsubscribe()
      input.signal?.removeEventListener?.('abort', onAbort)
    }

    if (failure) throw failure
    return { text: finalText, steps, stopReason, toolResults, images }
  }

  return { run, toolDefinitions: () => tools.toPiAgentTools() }
}
