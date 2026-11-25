/**
 * SaladCloud 连接探测（M3.6）：`POST /api/salad/probe`。
 *
 * 入参 `{ apiKey?, org?, project? }`。设置抽屉可用未保存的值测试；API Key 留空时，
 * 只有 org / project 与已保存配置完全一致才回落到本机加密凭据，避免把 Key 发给陌生组织。
 *
 * 只读：查询配额 / 容器组 / GPU 目录，不创建容器组。失败仍返回 HTTP 200 + `ok:false`，
 * 便于界面展示可修复的凭据 / 网络问题。
 */

import { ROUTES, SALAD, TIMEOUTS } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { saladIdOf, probeSaladAccount } from '../providers/salad.js'

/**
 * @param {{ appConfig?: object, ctx?: object, log?: object }} deps
 */
export function createSaladRoutes({ appConfig = null, ctx = null, log = null } = {}) {
  return [
    {
      name: 'salad-probe',
      path: ROUTES.saladProbe.path,
      method: ROUTES.saladProbe.method,
      async handler(req, res) {
        let body
        try {
          body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
        } catch (error) {
          log?.warn?.('Salad 探测请求体不是合法 JSON', error?.message ?? error)
          return sendError(res, 400, 'invalid_request', '请求体必须是合法 JSON 对象')
        }

        const stored = appConfig?.getSaladConfig?.() ?? {
          org: '',
          project: SALAD.defaultProject,
          tier: SALAD.defaultTier,
          apiKey: '',
        }
        const org = saladIdOf(body.org) || saladIdOf(stored.org)
        const project = saladIdOf(body.project, 'project')
          || saladIdOf(stored.project, 'project')
          || SALAD.defaultProject
        let apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey && org && project
          && org === saladIdOf(stored.org)
          && project === (saladIdOf(stored.project, 'project') || SALAD.defaultProject)) {
          apiKey = typeof stored.apiKey === 'string' ? stored.apiKey : ''
        }

        const probe = await probeSaladAccount({
          config: { apiKey, org, project },
          ctx,
        })
        log?.info?.(
          `salad_probe org=${org || 'none'} project=${project || 'none'} ` +
            `ok=${probe.ok} code=${probe.error?.code ?? 'none'}`,
        )
        sendJson(res, 200, { ok: probe.ok, probe })
      },
    },
  ]
}
