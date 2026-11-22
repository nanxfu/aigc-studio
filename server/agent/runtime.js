/**
 * 独立创作 Agent 运行时（基于 `@earendil-works/pi-agent-core`）。
 *
 * 相比旧版手写循环的升级：
 *  - 使用 `Agent` + `pi-ai` 原生多轮 `toolCall` / `toolResult` 协议（不再用 `user` 文本模拟工具消息）；
 *  - 工具参数校验、串行/并行调度、AbortSignal 中断全部交给 `pi-agent-core`；
 *  - 通过事件订阅把流式增量与工具状态实时推送给 SSE 路由：
 *    `text-delta` / `reasoning-delta` / `text` / `tool-start` / `tool-result` / `done` / `error`。
 *
 * AGUI（Phase B/C）：
 *  - 工具返回 `data.ui` 时，运行时把它翻译成 `proposal` / `clarify` / `explore` 事件，并在本轮
 *    工具结果返回后立即结束循环（`finishTurn` → end）——卡片已展示，等待用户点击，不需要再跑 LLM；
 *  - 工具返回 `data.jobIds` 时发出 `job-bound`，前端据此把气泡绑定到真实任务进度；
 *  - 轮次上下文（舞台焦点 / 语言 / 算力来源）用 AsyncLocalStorage 挂载，工具可直接读取；
 *  - 探索授权后入参 `exploreBudget` 放大步数上限并强制计数：每次生图发 `explore-progress`，
 *    达到 maxImages 发 `budget-exhausted` 并收敛（`beforeToolCall` + `finishTurn` 双保险）。
 */

import { randomUUID } from 'node:crypto'

import { Agent } from '@earendil-works/pi-agent-core'

import { convertToLlm, toAgentMessages } from './message-adapter.js'
import { runWithTurnContext } from './turn-context.js'

const DEFAULT_MAX_STEPS = 6
const EXPLORE_GEN_TOOLS = new Set(['imagen_generate', 'imagen_batch', 'imagen_upscale'])
const MAX_POST_BUDGET_TURNS = 2

/** 估算一次生图工具调用会消耗的探索预算张数。 */
function requestedExploreCount(toolName, args) {
  if (toolName === 'imagen_batch') return Array.isArray(args?.items) ? args.items.length : 0
  if (toolName === 'imagen_generate') {
    const count = Number(args?.count)
    return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1
  }
  if (toolName === 'imagen_upscale') return 1
  return 0
}

/** 统计单次生图工具实际消耗的预算（提交失败不扣，批量以真实入队/落地数为准）。 */
function producedExploreCount(toolName, toolImages, result, isError) {
  if (isError) return 0
  if (toolImages.length > 0) return toolImages.length
  const data = result?.details?.data
  if (!data || typeof data !== 'object') return 0
  if (toolName === 'imagen_batch' && Array.isArray(data.jobIds)) return data.jobIds.length
  const hasJob = Boolean(data.jobId) || (Array.isArray(data.jobIds) && data.jobIds.length > 0)
  if (!hasJob) return 0
  const declared = Number(data.count)
  return Number.isFinite(declared) && declared > 0 ? Math.trunc(declared) : 0
}

function assistantTextOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 工具结果里的 UI 卡片数据（`data.ui`），非法时返回 null。 */
function uiPayloadOf(result) {
  const ui = result?.details?.data?.ui
  if (!ui || typeof ui !== 'object') return null
  if (ui.type !== 'proposal' && ui.type !== 'clarify' && ui.type !== 'explore') return null
  return ui
}

/** UI 卡片类型 → SSE 事件名。探索卡复用独立事件，便于前端渲染预算与进度。 */
function uiEventTypeOf(type) {
  if (type === 'proposal') return 'proposal'
  if (type === 'clarify') return 'clarify'
  if (type === 'explore') return 'explore'
  return 'tool-result'
}

/** 工具结果里的任务绑定（`data.jobIds` / `data.jobId`），去重后返回。 */
function jobBindingsOf(result) {
  const data = result?.details?.data
  if (!data || typeof data !== 'object') return []
  const ids = []
  const push = (value) => {
    const id = typeof value === 'string' ? value.trim() : ''
    if (id && !ids.includes(id)) ids.push(id)
  }
  if (Array.isArray(data.jobIds)) data.jobIds.forEach(push)
  push(data.jobId)
  return ids.map((jobId) => ({
    jobId,
    presetId: typeof data.presetId === 'string' ? data.presetId : '',
    count: Number.isFinite(Number(data.count)) ? Number(data.count) : null,
    prompt: typeof data.prompt === 'string' ? data.prompt : '',
  }))
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
   *           stage?: object|null, locale?: 'zh'|'en', provider?: string,
   *           exploreBudget?: { maxRounds?: number, maxImages?: number },
   *           onEvent?: (event: object) => void }} input
   * @returns {Promise<{ text: string, steps: number, stopReason: string,
   *                     toolResults: Array<object>, images: Array<object>, pending: object|null }>}
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

    // M3.5 Phase C：探索预算护栏。授权后客户端下发 exploreBudget，运行时强制计数：
    //  - 探索模式的步数上限放大到 maxRounds × 每轮典型步数（查配方/生图/看图/改词），但不无限；
    //  - 生产图片数达到 maxImages 时立即收敛（finishTurn + beforeToolCall 双保险）。
    const budgetRaw = input.exploreBudget && typeof input.exploreBudget === 'object' ? input.exploreBudget : null
    const maxImagesBudget = budgetRaw && Number.isFinite(Number(budgetRaw.maxImages))
      ? Math.max(1, Math.min(16, Math.trunc(Number(budgetRaw.maxImages))))
      : 0
    const maxRoundsBudget = budgetRaw && Number.isFinite(Number(budgetRaw.maxRounds))
      ? Math.max(1, Math.min(4, Math.trunc(Number(budgetRaw.maxRounds))))
      : 0
    const exploreMode = maxImagesBudget > 0 && maxRoundsBudget > 0
    const stepLimit = exploreMode ? Math.min(40, Math.max(maxSteps, maxRoundsBudget * 8)) : maxSteps

    let steps = 0
    let producedImages = 0
    let budgetExhausted = false
    let postBudgetTurns = 0
    let finalText = ''
    let stopReason = 'stop'
    let failure = null
    let pending = null
    const toolResults = []
    const images = []
    const seenPaths = new Set()

    const sessionId =
      typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : randomUUID()

    const agent = new Agent({
      initialState: {
        systemPrompt: typeof input.system === 'string' && input.system.trim() ? input.system.trim() : undefined,
        model: target.model,
        thinkingLevel,
        tools: piTools,
        messages: seedMessages,
      },
      sessionId,
      convertToLlm,
      streamFn: target.streamFn,
      getApiKey: () => target.apiKey,
      toolExecution: 'sequential',
      beforeToolCall: async ({ toolCall, args }) => {
        // 若同一步中前一个工具已产出确认卡 / 澄清卡 / 探索卡，阻止后续工具执行（防止既弹卡又顺手直调生图）。
        if (pending) {
          return { block: true, reason: '已向用户展示交互卡片，本轮暂停执行后续工具' }
        }
        // 探索预算硬护栏：只拦截生图工具（允许只读 imagen_inspect 继续回看并总结），
        // 且对单次调用做前瞻余量检查，避免「剩余 2 张却一次批提交 4 张」超额。
        if (exploreMode && EXPLORE_GEN_TOOLS.has(toolCall?.name)) {
          if (budgetExhausted) {
            return { block: true, reason: '已达到本次探索的图片总数上限，禁止继续生图；请直接基于已有结果输出中文对比总结与推荐。' }
          }
          const remaining = Math.max(0, maxImagesBudget - producedImages)
          const requested = requestedExploreCount(toolCall.name, args)
          if (requested > remaining) {
            return {
              block: true,
              reason: `本次请求需要 ${requested} 张，超出当前剩余预算（仅剩 ${remaining} 张）。请缩减本批张数，或直接基于已有结果输出中文对比总结。`,
            }
          }
        }
        return undefined
      },
      finishTurn: ({ toolResults: turnTools }) => {
        // 已展示交互卡片：本轮到此结束，等待用户交互（避免空转与重复生成）。
        if (pending) {
          stopReason = 'awaiting-user'
          return { action: 'end' }
        }
        // 探索预算耗尽：允许模型用最多 MAX_POST_BUDGET_TURNS 轮完成看图与最终文字总结，
        // 一旦产出无工具调用的总结回复（或超限）立即收敛。
        if (budgetExhausted) {
          const hasToolCalls = Array.isArray(turnTools) && turnTools.length > 0
          if (!hasToolCalls || postBudgetTurns >= MAX_POST_BUDGET_TURNS || steps >= stepLimit) {
            stopReason = 'budget-exhausted'
            return { action: 'end' }
          }
          postBudgetTurns += 1
          return undefined
        }
        if (steps >= stepLimit) {
          stopReason = exploreMode ? 'budget-exhausted' : 'max-steps'
          log?.warn?.(`agent_max_steps steps=${steps} tools=${toolResults.length} explore=${exploreMode}`)
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
        if (stopReason !== 'max-steps' && stopReason !== 'awaiting-user' && stopReason !== 'budget-exhausted') {
          stopReason = msg.stopReason || 'stop'
        }
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

        const ui = uiPayloadOf(result)
        if (ui) {
          pending = ui
          // 结构化卡片事件：前端只消费事件，不关心是哪个工具产生的（M3.5 起含 explore）。
          emit({
            type: uiEventTypeOf(ui.type),
            step: steps,
            toolCallId: event.toolCallId,
            ...ui,
          })
        }

        const bindings = jobBindingsOf(result)
        for (const binding of bindings) {
          emit({ type: 'job-bound', step: steps, toolCallId: event.toolCallId, ...binding })
        }

        // 探索预算计数：只统计实际成功入队 / 落地的生图张数，提交失败不白扣预算。
        if (exploreMode && EXPLORE_GEN_TOOLS.has(event.toolName)) {
          const produced = producedExploreCount(event.toolName, toolImages, result, event.isError)
          if (produced > 0) {
            producedImages += produced
            emit({
              type: 'explore-progress',
              step: steps,
              produced: producedImages,
              maxImages: maxImagesBudget,
              maxRounds: maxRoundsBudget,
            })
            if (producedImages >= maxImagesBudget && !budgetExhausted) {
              budgetExhausted = true
              emit({ type: 'budget-exhausted', step: steps, produced: producedImages, maxImages: maxImagesBudget })
            }
          }
        }

        // UI 工具不再单独发 tool-result：卡片本身就是结果，避免时间线里出现重复条目。
        if (!ui) {
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
      }
    })

    const onAbort = () => agent.abort()
    if (input.signal) {
      if (input.signal.aborted) agent.abort()
      else input.signal.addEventListener('abort', onAbort, { once: true })
    }

    // 轮次上下文：舞台焦点 / UI 语言 / 算力来源，供 `imagen_stage_context` 等工具读取。
    const turnContext = {
      stage: input.stage && typeof input.stage === 'object' ? input.stage : null,
      locale: input.locale === 'en' ? 'en' : 'zh',
      provider: typeof input.provider === 'string' ? input.provider : '',
    }

    try {
      await runWithTurnContext(turnContext, async () => {
        if (hasTrailingUser) {
          await agent.prompt(last)
        } else {
          await agent.continue()
        }
        await agent.waitForIdle()
      })
    } finally {
      unsubscribe()
      input.signal?.removeEventListener?.('abort', onAbort)
    }

    if (failure) throw failure
    return { text: finalText, steps, stopReason, toolResults, images, pending }
  }

  return { run, toolDefinitions: () => tools.toPiAgentTools() }
}
