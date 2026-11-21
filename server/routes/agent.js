/**
 * 创作 Agent 路由（基于 `@earendil-works/pi-agent-core` 工具循环 + SSE 流式输出）。
 *
 * 协议：
 *   POST /api/agent/chat
 *   body: { messages: [{role,content}], system?: string, stream?: boolean }
 *   - stream !== false：返回 text/event-stream，事件 data 为 JSON：
 *       { type:'text-delta', step, text }
 *       { type:'reasoning-delta', step, text }
 *       { type:'text', step, text }
 *       { type:'tool-start', step, toolCallId, name, arguments }
 *       { type:'tool-result', step, toolCallId, name, ok, text, images? }
 *       { type:'done', steps, stopReason, text, images }
 *       { type:'error', code, message }
 *   - stream === false：等循环结束返回 { text, steps, stopReason, toolResults, images }
 *
 * 鉴权与其它 /api 路由一致（由 http-server 层统一校验 Bearer Token）。
 */

import { modelCatalogText } from '../../shared/models-guide.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { createLogger } from '../log.js'

const log = createLogger({ scope: 'agent-route' })

/** 请求体上限：对话历史不需要大到能撑爆内存。 */
const MAX_BODY_MESSAGES = 40

function defaultAgentSystemPrompt(provider) {
  return [
    '你是 AIGC Studio 的创作助手，可以使用工具检索配方、查询历史作品、启动或查看云端 GPU 会话、提交单张/批量生图、高清放大以及取消任务。',
    '规则：',
    '1. 用户只是在讨论或询问时，直接简洁作答，不要擅自提交消耗 GPU 的生图任务；用户明确要求画图/重绘/批生成/查历史/管理会话时，主动调用对应工具。',
    '2. 提示词（prompt）通常应为具体、可感的英文视觉描述；需要时先调用 imagen_recipes 查配方模板，再把模板显式改写进 prompt。',
    '3. 当前可用模型目录（只能选用其中 id）：',
    modelCatalogText({ textToImageOnly: true, provider }),
    '4. 回复用户时使用中文（除非用户使用英文），结果里已生成的图片会由客户端自动展示，不必重复输出冗长说明。',
  ].join('\n')
}

function writeEvent(res, payload) {
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * @param {{ llm: object, tools: object, runtime?: object, getProvider?: () => string }} deps
 */
export function createAgentRoutes({ llm, tools, runtime, getProvider }) {
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
        const system = typeof body?.system === 'string' && body.system.trim()
          ? body.system
          : defaultAgentSystemPrompt(provider)
        const wantsStream = body?.stream !== false

        if (!llm.getSelection || !llm.getSelection()) {
          return sendError(res, 503, 'llm_not_configured', '未配置可用的模型，请先在设置里填写 Base URL / Model / API Key')
        }

        const agent = await getRuntime()
        if (!wantsStream) {
          try {
            const result = await agent.run({ messages, system })
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
        let closed = false
        res.on('close', () => {
          if (!res.writableFinished) closed = true
        })
        try {
          const result = await agent.run({
            messages,
            system,
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
