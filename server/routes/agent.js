/**
 * 创作 Agent 路由（基于 `@earendil-works/pi-agent-core` 工具循环 + SSE 流式输出）。
 *
 * 协议：
 *   POST /api/agent/chat
 *   body: { messages: [{role,content}], system?, stream?, stage?, locale?, presetId?, cfg? }
 *   - stage：当前舞台选中图摘要 `{ imagePath, presetId, width, height, seed, prompt }`，
 *     用于「把当前这张图…」这类指令；服务端拼进 system prompt，并供 imagen_stage_context 读取；
 *   - locale / presetId / cfg：UI 语言、当前模型与 CFG，决定提示词语言与负向词能力说明。
 *
 *   - stream !== false：返回 text/event-stream，事件 data 为 JSON：
 *       { type:'text-delta', step, text }
 *       { type:'reasoning-delta', step, text }
 *       { type:'text', step, text }
 *       { type:'tool-start', step, toolCallId, name, arguments }
 *       { type:'tool-result', step, toolCallId, name, ok, text, images? }
 *       { type:'proposal', step, toolCallId?, summaryZh, prompt, negativePrompt?, presetId, ratioId?, ... }
 *       { type:'clarify', step, toolCallId?, question, dimensions, options }
 *       { type:'job-bound', step, toolCallId, jobId, presetId, count, prompt }
 *       { type:'done', steps, stopReason, text, images, pending? }
 *       { type:'error', code, message }
 *   - stream === false：等循环结束返回 { text, steps, stopReason, toolResults, images, pending }
 *
 * 无 LLM Key 的静默降级：不再返回 503，而是复用 `server/intent.js` 的本地解析生成一张
 * 提案卡（source='local'），让「没配模型也能出图」的既有体验在单轨助手里延续。
 *
 * 鉴权与其它 /api 路由一致（由 http-server 层统一校验 Bearer Token）。
 */

import { LIMITS } from '../../shared/contract.js'
import { historyMessages } from '../../shared/validation.js'
import { buildAgentSystemPrompt } from '../agent/prompt.js'
import { parseIntent } from '../intent.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { createLogger } from '../log.js'

const log = createLogger({ scope: 'agent-route' })

/** 请求体上限：对话历史不需要大到能撑爆内存。 */
const MAX_BODY_MESSAGES = 40

/** 读客户端上报的舞台焦点：只保留白名单字段，其它一律丢弃。 */
function stageOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const imagePath = typeof value.imagePath === 'string' ? value.imagePath.trim().slice(0, 500) : ''
  if (!imagePath) return null
  const width = Number(value.width)
  const height = Number(value.height)
  const seed = Number(value.seed)
  return {
    imagePath,
    presetId: typeof value.presetId === 'string' ? value.presetId.trim().slice(0, 80) : '',
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    seed: Number.isFinite(seed) && seed >= 0 ? Math.trunc(seed) : null,
    prompt: typeof value.prompt === 'string' ? value.prompt.trim().slice(0, LIMITS.prompt.maxChars) : '',
  }
}

/** 读 CFG：只接受有限数字；缺失/非法返回 undefined（交给 parseIntent 回落预设推荐值）。 */
function readCfg(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(number) ? number : undefined
}

function writeEvent(res, payload) {
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 最后一条 user 消息的纯文本（本地兜底解析的输入）。 */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim()
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
        .trim()
      if (text) return text
    }
  }
  return ''
}

/**
 * 无 LLM Key 的本地兜底：复用意图解析的本地分支，产出一张可编辑的提案卡。
 *
 * @returns {Promise<object|null>} proposal payload；输入为空时返回 null
 */
async function localProposal({ llm, messages, locale, presetId, cfg, provider }) {
  const text = lastUserText(messages)
  if (!text) return null
  const history = historyMessages(
    messages
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
      .slice(0, -1)
      .map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
      })),
  )
  const result = await parseIntent(
    { get: (name) => (name === 'llm' ? llm : null) },
    { text, locale, presetId, cfg, provider, history },
  )
  return {
    type: 'proposal',
    summaryZh: result.summary || text,
    prompt: result.prompt || text,
    negativePrompt: result.negative || '',
    presetId: presetId || '',
    ratioId: result.ratioId || '',
    count: 1,
    seed: null,
    notes: locale === 'en' ? 'Local mode: configure a model for richer plans.' : '本地模式：配置模型后可获得更完整的创作方案。',
    source: 'local',
    modelHint: result.modelHint ?? null,
  }
}

/**
 * @param {{ llm: object, tools: object, runtime?: object, getProvider?: () => string,
 *           getSession?: () => object|null, getQueue?: () => object|null }} deps
 */
export function createAgentRoutes({ llm, tools, runtime, getProvider, getSession, getQueue }) {
  if (!llm || !tools) return []
  let cachedRuntime = runtime ?? null
  async function getRuntime() {
    if (cachedRuntime) return cachedRuntime
    const { createAgentRuntime } = await import('../agent/runtime.js')
    cachedRuntime = createAgentRuntime({ llm, tools, log })
    return cachedRuntime
  }

  return [
    {
      name: 'agentChat',
      path: '/api/agent/chat',
      method: 'POST',
      async handler(req, res) {
        let body = null
        try {
          body = await readJsonBody(req)
        } catch {
          return sendError(res, 400, 'invalid_body', '请求体不是合法 JSON')
        }
        const messages = Array.isArray(body?.messages) ? body.messages.slice(-MAX_BODY_MESSAGES) : []
        if (messages.length === 0) {
          return sendError(res, 400, 'invalid_request', 'messages 不能为空')
        }
        const provider = typeof getProvider === 'function' ? getProvider() : undefined
        const locale = body?.locale === 'en' ? 'en' : 'zh'
        const presetId = typeof body?.presetId === 'string' ? body.presetId : ''
        const cfg = readCfg(body?.cfg)
        const stage = stageOf(body?.stage)
        const sessionSnapshot = (() => {
          try {
            return typeof getSession === 'function' ? getSession() : null
          } catch {
            return null
          }
        })()
        const queueSnapshot = (() => {
          try {
            return typeof getQueue === 'function' ? getQueue() : null
          } catch {
            return null
          }
        })()
        const system = typeof body?.system === 'string' && body.system.trim()
          ? body.system
          : buildAgentSystemPrompt({ locale, provider, session: sessionSnapshot, queue: queueSnapshot, stage })
        const wantsStream = body?.stream !== false

        // 未配置模型：走本地兜底（同一个端点、同一张卡片），不再把用户挡在 503 后面。
        const configured = Boolean(llm.getSelection && llm.getSelection())
        if (!configured) {
          let proposal = null
          try {
            proposal = await localProposal({ llm, messages, locale, presetId, cfg, provider })
          } catch (error) {
            log.warn(`agent_local_fallback_failed detail=${String(error?.message ?? error).slice(0, 200)}`)
          }
          const text = proposal
            ? (locale === 'en'
              ? 'No model configured yet — here is a quick draft you can edit and generate.'
              : '还没有配置模型，先按本地规则整理了一版草稿，可直接修改后生成。')
            : ''
          if (!wantsStream) {
            if (!proposal) return sendError(res, 400, 'invalid_request', 'messages 里没有可用的用户输入')
            return sendJson(res, 200, {
              text,
              steps: 1,
              stopReason: 'awaiting-user',
              toolResults: [],
              images: [],
              pending: proposal,
            })
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          try {
            if (proposal) {
              writeEvent(res, { type: 'text', step: 1, text })
              writeEvent(res, { type: 'proposal', step: 1, ...proposal })
              writeEvent(res, {
                type: 'done',
                steps: 1,
                stopReason: 'awaiting-user',
                text,
                images: [],
                pending: proposal,
              })
            } else {
              writeEvent(res, { type: 'error', code: 'invalid_request', message: 'messages 里没有可用的用户输入' })
            }
          } finally {
            if (!res.writableEnded) res.end()
          }
          return
        }

        const agent = await getRuntime()
        if (!wantsStream) {
          try {
            const result = await agent.run({ messages, system, stage, locale, provider })
            return sendJson(res, 200, result)
          } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : 'agent_failed'
            return sendError(res, 502, code, String(error?.message ?? error))
          }
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        const abortController = new AbortController()
        let closed = false
        const abortIfDisconnected = () => {
          if (!res.writableFinished && !closed) {
            closed = true
            abortController.abort()
          }
        }
        res.on('close', abortIfDisconnected)
        if (res.destroyed) abortIfDisconnected()
        try {
          const result = await agent.run({
            messages,
            system,
            stage,
            locale,
            provider,
            signal: abortController.signal,
            onEvent(event) {
              if (!closed) writeEvent(res, event)
            },
          })
          if (!closed) {
            writeEvent(res, {
              type: 'done',
              steps: result.steps,
              stopReason: result.stopReason,
              text: result.text,
              images: result.images ?? [],
              ...(result.pending ? { pending: result.pending } : {}),
            })
          }
        } catch (error) {
          log.warn(`agent_chat_failed detail=${String(error?.message ?? error)}`)
          if (!closed) {
            writeEvent(res, {
              type: 'error',
              code: typeof error?.code === 'string' ? error.code : 'agent_failed',
              message: String(error?.message ?? error).slice(0, 500),
            })
          }
        } finally {
          if (!res.writableEnded) res.end()
        }
      },
    },
  ]
}
