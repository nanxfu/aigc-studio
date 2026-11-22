/**
 * 私有 Worker 连接探测路由（M3.1-b）：`POST /api/worker/probe`。
 *
 * 入参 `{ endpointUrl, token? }`：设置抽屉「测试连接」用。
 *  - `endpointUrl` 可省略：缺省时使用 app-config 里已保存的地址；
 *  - `token` 可省略：只有「探测地址 === 已保存地址」时才回落到已保存 Token，
 *    绝不同时把本地 Token 发给一个刚输入的陌生地址；
 *  - 响应固定为 `{ ok, probe }`，`probe` 是脱敏的 phase / protocolVersion / hardware /
 *    capabilities / error，不含 Token 与原始响应。
 *
 * 失败（地址不可达 / 鉴权失败 / 协议不匹配）仍是 HTTP 200 + `ok:false`：
 * 这是用户可修复的配置问题，不是服务端异常；只有坏 JSON 才是 400。
 *
 * @module server/routes/worker
 */

import { ROUTES, TIMEOUTS } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { probeWorkerConnection } from '../providers/worker-connection.js'
import { normalizeWorkerEndpoint } from '../providers/worker-url.js'

/** 日志只记 host，避免把路径 / query 里的细节带进主机日志。 */
function hostOf(endpoint) {
  try {
    return new URL(endpoint).host || 'unknown'
  } catch {
    return 'invalid-url'
  }
}

/**
 * @param {{ appConfig?: object, ctx?: object, log?: object }} deps
 */
export function createWorkerRoutes({ appConfig = null, ctx = null, log = null } = {}) {
  return [
    {
      name: 'worker-probe',
      path: ROUTES.workerProbe.path,
      method: ROUTES.workerProbe.method,
      async handler(req, res) {
        let body
        try {
          body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
        } catch (error) {
          log?.warn?.('Worker 探测请求体不是合法 JSON', error?.message ?? error)
          return sendError(res, 400, 'invalid_request', '请求体必须是合法 JSON 对象')
        }

        const stored = appConfig?.getWorkerConfig?.() ?? { endpointUrl: '', token: '', tokenConfigured: false }
        const requested = typeof body.endpointUrl === 'string' && body.endpointUrl.trim()
          ? body.endpointUrl
          : stored.endpointUrl || ''
        const normalized = normalizeWorkerEndpoint(requested)

        let token = typeof body.token === 'string' ? body.token.trim() : ''
        if (!token && normalized.ok && stored.token && stored.endpointUrl === normalized.endpointUrl) {
          token = stored.token
        }

        const probe = normalized.ok
          ? await probeWorkerConnection({ ctx, endpointUrl: normalized.endpointUrl, token })
          : {
              ok: false,
              phase: null,
              protocolVersion: null,
              hardware: null,
              capabilities: null,
              modelId: null,
              error: { code: 'invalid_request', message: normalized.message },
            }

        log?.info?.(
          `worker_probe endpoint=${hostOf(normalized.ok ? normalized.endpointUrl : '')} ` +
            `ok=${probe.ok} code=${probe.error?.code ?? 'none'} phase=${probe.phase ?? 'unknown'}`,
        )
        sendJson(res, 200, { ok: probe.ok, probe })
      },
    },
  ]
}