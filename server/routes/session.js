/**
 * 会话相关路由：状态快照、环境探测、启动、关机。
 *
 * 路径与方法取自 `shared/contract.js` 的 ROUTES（唯一来源），本文件不写字面量。
 */

import { ROUTES } from '../../shared/contract.js'
import { sendError, sendJson } from '../http.js'
import { presetById } from '../presets.js'
import { readBodyOr } from '../route-kit.js'

/**
 * @param {{ session: object, probes: object, statePayload: () => object, defaultPreset: string, log: object }} deps
 */
export function createSessionRoutes({ session, probes, statePayload, defaultPreset, log }) {
  return [
    {
      name: 'state',
      path: ROUTES.state.path,
      method: ROUTES.state.method,
      handler(req, res) {
        sendJson(res, 200, statePayload())
      },
    },
    {
      name: 'probe',
      path: ROUTES.probe.path,
      method: ROUTES.probe.method,
      async handler(req, res) {
        const probe = await probes.run()
        sendJson(res, 200, { ok: probe.auth?.ok === true, probe })
      },
    },
    {
      name: 'session-start',
      path: ROUTES.sessionStart.path,
      method: ROUTES.sessionStart.method,
      async handler(req, res) {
        const body = await readBodyOr(req, {}, log)
        const presetId = typeof body.presetId === 'string' ? body.presetId : defaultPreset
        const forceNew = body.forceNew === true
        // replace=true：换新实例重排。允许在 provisioning 等活跃状态放弃当前会话，
        // 删除旧 Kernel 后推送新 Kernel；等待中的任务继续等新会话。
        const replace = body.replace === true
        // 精度档随手动唤醒一起下发：Salad 的选卡与容器规格按档位权重体积计算，
        // 不传会按满血规格起实例。归一（auto → 具体档）在 SessionManager 内完成。
        const variantId = typeof body.variantId === 'string' ? body.variantId.trim() : ''
        let snapshot
        try {
          snapshot = await session.start(presetById(presetId).id, { forceNew, replace, variantId })
        } catch (error) {
          // 显式精度档非法：请求本身有问题，明确 400；不要写成会话 error 快照。
          if (error?.code === 'invalid_request') {
            return sendError(res, 400, error.code, error.message)
          }
          throw error
        }
        sendJson(res, 200, { ok: snapshot.state !== 'error', session: snapshot })
      },
    },
    {
      name: 'session-stop',
      path: ROUTES.sessionStop.path,
      method: ROUTES.sessionStop.method,
      async handler(req, res) {
        const snapshot = await session.stop()
        sendJson(res, 200, { ok: true, session: snapshot })
      },
    },
  ]
}