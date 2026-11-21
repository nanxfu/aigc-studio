/**
 * 创作助手对话历史路由（按工作区持久化 `<workspace>/.aigc-studio/chat.json`）。
 *
 * 同一 path 同时受理 GET（读取）与 POST（保存/清空），与 `routes/ui-state.js` 同形。
 * 路径与方法取自 `shared/contract.js` 的 ROUTES（唯一来源）。
 */

import { ROUTES, TIMEOUTS } from '../../shared/contract.js'
import { readChatHistory, writeChatHistory } from '../chat-store.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { workspaceRoot } from '../paths.js'

export function createChatRoutes({ ctx, log }) {
  async function readHistory(req, res) {
    const messages = await readChatHistory(ctx)
    sendJson(res, 200, { ok: true, workspace: workspaceRoot(ctx), messages })
  }

  async function saveHistory(req, res) {
    let body
    try {
      body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
    } catch (error) {
      log?.warn?.('对话历史请求体不是合法 JSON', error?.message ?? error)
      return sendError(res, 400, 'invalid_body', '请求体必须是合法 JSON 对象')
    }

    if (!Array.isArray(body.messages)) {
      return sendError(res, 400, 'invalid_request', 'messages 必须是数组')
    }

    try {
      const messages = await writeChatHistory(ctx, body.messages)
      sendJson(res, 200, { ok: true, workspace: workspaceRoot(ctx), messages })
    } catch (error) {
      log?.warn?.('对话历史写入失败（不影响出图主链路）', error?.message ?? error)
      sendError(res, 500, 'internal_error', '对话历史保存失败，请检查工作区目录权限')
    }
  }

  return [
    {
      name: 'chat-history',
      path: ROUTES.chatHistory.path,
      method: [ROUTES.chatHistory.method, ROUTES.chatHistorySave.method],
      handler(req, res) {
        if (req.method === ROUTES.chatHistorySave.method) return saveHistory(req, res)
        return readHistory(req, res)
      },
    },
  ]
}
