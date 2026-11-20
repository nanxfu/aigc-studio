/**
 * 工作区路由：读取当前工作区 / 最近列表 / 是否可切换，以及切换工作区。
 *
 * 协议（docs/MIGRATION_SPEC.md §2.4，前端按 `web/logic/workspace.js` 消费）：
 *   GET  /api/workspace → `{ ok: true, workspace: { current, recent, switchable } }`
 *   POST /api/workspace  body `{ path }` → 同上；失败 400/409 `{ error: { code, message } }`
 *
 * 注册形态：GET/POST 共用同一 path，只注册一条路由、handler 内按 method 分发
 * （与 settings / ui-state 一致，避免 exact 路由表重复 path 报错）。
 *
 * 切换约束：会话处于活跃状态或队列里有 pending / running 任务时不可切换
 * （`switchable: false`，POST 返回 409 `workspace_busy`），避免产物落盘到一半换目录。
 *
 * 设置热切换：切换成功后 `await settings.reload()`，让 `/api/settings` 与 `/api/state`
 * 立即读新工作区的 settings.json（改造前设置存储固定按启动时的工作区路径读写）。
 */

import { ROUTES, TIMEOUTS } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'

/**
 * @param {{ workspaceManager?: object, session?: object, queue?: object, settings?: object, log?: object }} deps
 */
export function createWorkspaceRoutes({ workspaceManager, session, queue, settings, log } = {}) {
  if (!workspaceManager) return []

  /** 是否有进行中的会话 / 任务（有则禁止切换工作区）。 */
  function isBusy() {
    try {
      if (session?.isActive) return true
      const stats = queue?.queueStats?.() ?? null
      if (stats && (stats.running || (Number(stats.pending) || 0) > 0)) return true
    } catch {}
    return false
  }

  function view() {
    const snapshot = workspaceManager.snapshot()
    return {
      current: snapshot.current,
      recent: Array.isArray(snapshot.recent) ? snapshot.recent : [],
      switchable: !isBusy(),
    }
  }

  async function readWorkspace(req, res) {
    await workspaceManager.whenReady()
    sendJson(res, 200, { ok: true, workspace: view() })
  }

  async function switchWorkspace(req, res) {
    let body
    try {
      body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
    } catch (error) {
      log?.warn?.('工作区切换请求体不是合法 JSON', error?.message ?? error)
      return sendError(res, 400, 'invalid_request', '请求体必须是合法 JSON 对象')
    }
    const requested = typeof body.path === 'string' ? body.path.trim() : ''
    if (!requested) return sendError(res, 400, 'invalid_request', 'path 必须是非空的绝对路径')

    // 先做忙碌判定：有任务时不创建 / 校验新目录，避免副作用。
    if (isBusy()) {
      return sendError(res, 409, 'workspace_busy', '有正在进行的任务，完成或取消后才能切换工作区')
    }

    await workspaceManager.whenReady()
    const result = await workspaceManager.switchTo(requested)
    if (!result.ok) {
      const code = result.code === 'internal_error' ? 'internal_error' : 'invalid_request'
      const status = code === 'internal_error' ? 500 : 400
      return sendError(res, status, code, result.message)
    }

    // 设置存储按工作区动态解析路径：切换后立刻重读，保证紧接着的 GET /api/settings 与
    // /api/state 反映新工作区。重读失败不阻塞切换（设置读取本就静默降级为静态 config）。
    try {
      await settings?.reload?.()
    } catch (error) {
      log?.warn?.('工作区切换后重载设置失败（已忽略）', error?.message ?? error)
    }

    log?.info?.(`workspace_switch_ok path=${result.workspace.current}`)
    sendJson(res, 200, { ok: true, workspace: view() })
  }

  return [
    {
      name: 'workspace',
      path: ROUTES.workspace.path,
      method: [ROUTES.workspace.method, ROUTES.workspaceSwitch.method],
      handler(req, res) {
        if (req.method === ROUTES.workspaceSwitch.method) return switchWorkspace(req, res)
        return readWorkspace(req, res)
      },
    },
  ]
}
