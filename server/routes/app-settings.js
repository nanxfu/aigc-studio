/**
 * 全局应用设置路由：读取脱敏视图 / 合并保存白名单字段。
 *
 * 协议（docs/MIGRATION_SPEC.md §2.4，前端按 `web/logic/appSettings.js` 消费）：
 *   GET  /api/app-settings → `{ ok: true, settings: { ui, llm, update, workspace, version } }`
 *   POST /api/app-settings  body 白名单 `{ ui?, llm?, clearLlmApiKey?, workspace?, update? }` → 同 GET
 *
 * 安全约束：
 *  - LLM Key 永不回传原文，只回 `hasApiKey` / `apiKeySource`；
 *  - 日志只记字段名与结果，不记请求体原文；
 *  - 工作区字段（若用户显式提交）委托 WorkspaceManager，与 `/api/workspace` 同一套校验；
 *  - `update` 段（updateCheck / updateSource / updateMirrorUrl）由 app-config 严格校验后落盘，
 *    保存成功后回调 `onUpdateChanged`，让服务端只读检查器立即按新源排期。
 */

import { ROUTES, TIMEOUTS } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'

/** 白名单字段（用于日志记录字段名；其余字段由归一化函数忽略）。 */
const KNOWN_FIELDS = ['ui', 'llm', 'clearLlmApiKey', 'workspace', 'update']

function fieldNamesOf(body) {
  return KNOWN_FIELDS.filter((name) => Object.prototype.hasOwnProperty.call(body, name)).join(',')
}

/**
 * @param {{ appConfig?: object, workspaceManager?: object, session?: object,
 *           queue?: object, version?: string | null, log?: object,
 *           onUpdateChanged?: () => void }} deps
 */
export function createAppSettingsRoutes({
  appConfig,
  workspaceManager,
  session,
  queue,
  version = null,
  log,
  onUpdateChanged = null,
} = {}) {
  if (!appConfig) return []

  function workspaceView() {
    const snapshot = workspaceManager?.snapshot?.() ?? { current: null, recent: [] }
    const busy = (() => {
      try {
        if (session?.isActive) return true
        const stats = queue?.queueStats?.() ?? null
        if (stats && (stats.running || (Number(stats.pending) || 0) > 0)) return true
      } catch {}
      return false
    })()
    return {
      current: snapshot.current ?? null,
      recent: Array.isArray(snapshot.recent) ? snapshot.recent : [],
      switchable: !busy,
    }
  }

  function view() {
    return {
      ...appConfig.publicSettingsView(),
      workspace: workspaceView(),
      version: typeof version === 'string' && version ? version : null,
    }
  }

  async function readSettings(req, res) {
    await appConfig.whenReady()
    sendJson(res, 200, { ok: true, settings: view() })
  }

  async function saveSettings(req, res) {
    let body
    try {
      body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
    } catch (error) {
      log?.warn?.('应用设置请求体不是合法 JSON', error?.message ?? error)
      return sendError(res, 400, 'invalid_request', '请求体必须是合法 JSON 对象')
    }

    await appConfig.whenReady()

    // 工作区字段：可选，提交时等价于一次工作区切换（同一套忙碌 / 路径校验）。
    if (Object.prototype.hasOwnProperty.call(body, 'workspace')) {
      if (!workspaceManager) {
        return sendError(res, 400, 'invalid_request', '当前不支持切换工作区')
      }
      const requested =
        typeof body.workspace === 'string'
          ? body.workspace
          : typeof body.workspace?.current === 'string'
            ? body.workspace.current
            : typeof body.workspace?.path === 'string'
              ? body.workspace.path
              : ''
      if (!requested.trim()) return sendError(res, 400, 'invalid_request', 'workspace 必须是绝对路径')
      if (!workspaceView().switchable) {
        return sendError(res, 409, 'workspace_busy', '有正在进行的任务，完成或取消后才能切换工作区')
      }
      const switched = await workspaceManager.switchTo(requested)
      if (!switched.ok) {
        const status = switched.code === 'internal_error' ? 500 : 400
        return sendError(res, status, status === 500 ? 'internal_error' : 'invalid_request', switched.message)
      }
    }

    const patch = {}
    if (Object.prototype.hasOwnProperty.call(body, 'ui')) patch.ui = body.ui
    if (Object.prototype.hasOwnProperty.call(body, 'llm')) patch.llm = body.llm
    if (Object.prototype.hasOwnProperty.call(body, 'update')) patch.update = body.update
    // 顶层 clearLlmApiKey 与 llm.clearLlmApiKey 等价。
    if (body.clearLlmApiKey === true) patch.clearLlmApiKey = true

    const result = await appConfig.saveSettings(patch)
    if (!result.ok) {
      const code = result.code === 'internal_error' ? 'internal_error' : 'invalid_request'
      const status = code === 'internal_error' ? 500 : 400
      log?.info?.(`app_settings_rejected code=${code} fields=${fieldNamesOf(body) || 'none'}`)
      return sendError(res, status, code, result.message)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'update')) {
      // 只读检查器按新配置重新排期（源变更时旧缓存作废并立即检查）。
      try {
        onUpdateChanged?.()
      } catch (error) {
        log?.warn?.('应用更新配置后刷新检查器失败（忽略）', error?.message ?? error)
      }
    }
    log?.info?.(`app_settings_saved fields=${fieldNamesOf(body) || 'none'}`)
    sendJson(res, 200, { ok: true, settings: view() })
  }

  return [
    {
      name: 'app-settings',
      path: ROUTES.appSettings.path,
      method: [ROUTES.appSettings.method, ROUTES.appSettingsSave.method],
      handler(req, res) {
        if (req.method === ROUTES.appSettingsSave.method) return saveSettings(req, res)
        return readSettings(req, res)
      },
    },
  ]
}
