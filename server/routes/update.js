/**
 * 版本检查路由（M2.8 阶段 B）。
 *
 * 只读检查器默认按 TTL 在后台检查；设置抽屉的「立即检查」走这里主动触发一次。
 * NSIS 安装态由 `electron-updater` 独占更新（环境变量 `AIGC_STUDIO_UPDATE_OWNER=electron`），
 * 本路由只回占位，避免两套状态互相覆盖（规格 §3.2 优先级约定）。
 */

import { ROUTES } from '../../shared/contract.js'
import { sendJson } from '../http.js'

/**
 * @param {{ updateChecker: object, owner?: 'electron' | 'local', log?: object }} deps
 */
export function createUpdateRoutes({ updateChecker, owner = 'local', log } = {}) {
  if (!updateChecker) return []

  async function checkNow(_req, res) {
    if (owner === 'electron') {
      sendJson(res, 200, { ok: true, mode: 'electron', update: null })
      return
    }
    try {
      // 手动检查不受「自动检查」开关限制：用户点了就看结果。
      const update = await updateChecker.check({ force: true })
      sendJson(res, 200, { ok: true, mode: 'readonly', update })
    } catch (error) {
      log?.warn?.('手动版本检查失败', String(error?.message ?? error).slice(0, 200))
      sendJson(res, 500, { ok: false, code: 'internal_error', message: '版本检查失败，请稍后重试' })
    }
  }

  return [
    {
      name: 'update-check',
      path: ROUTES.updateCheck.path,
      method: ROUTES.updateCheck.method,
      handler: checkNow,
    },
  ]
}
