/**
 * 创作 Agent 路由（Phase 1：单轮/多轮对话 + 工具循环）。
 *
 * 为什么 Phase 1 就提供：Plan §三.1 把 Agent 工具循环列为 DSH 六个依赖点之一；
 * 独立客户端需要一条不依赖 DSH 的原生通道，Phase 2 的 MCP Server 也会复用同一份
 * 工具注册表与运行逻辑。
 *
 * 协议：
 *   POST /api/agent/chat
 *   body: { messages: [{role,content}], system?: string, stream?: boolean }
 *   - stream !== false：返回 text/event-stream，事件 data 为 JSON：
 *       { type:'text', step, text }
 *       { type:'tool-start', step, name, arguments }
 *       { type:'tool-result', step, name, ok, text }
 *       { type:'done', steps, stopReason, text }
 *       { type:'error', code, message }
 *   - stream === false：等循环结束返回 { text, steps, stopReason, toolResults }
 *
 * 鉴权与其它 /api 路由一致（由 http 层统一校验 Bearer Token）。
 */

import { readJsonBody, sendError, sendJson } from '../http.js'
import { createLogger } from '../log.js'

const log = createLogger({ scope: 'agent-route' })

/** 请求体上限：对话历史不需要大到能撑爆内存。 */
const MAX_BODY_MESSAGES = 40

function writeEvent(res, payload) {
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * @param {{ llm: object, tools: object, runtime?: object }} deps
 */
export function createAgentRoutes({ llm, tools, runtime }) {
  if (!llm || !tools) return []
  // 运行时按需懒加载：路由装配发生在工具注册之前也没关系。
  // 注意路径是 ../agent/runtime.js（agent/ 子目录），不是同级 runtime.js。
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
        const system = typeof body?.system === 'string' ? body.system : undefined
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
        // 客户端断开时不中断服务端工具执行：工具可能已经在排队/出图，
        // 但不再往已关闭的流里写事件。
        let closed = false
        req.on('close', () => {
          closed = true
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
