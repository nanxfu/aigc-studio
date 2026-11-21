/**
 * LLM 模型列表路由：`POST /api/llm/models`。
 *
 * 为什么由 Host 代理：
 *  - 浏览器直接请求第三方 `/models` 会撞 CORS；
 *  - 用户保存过的 API Key 只在 Host 侧（加密存储），不能下发到前端再转发；
 *  - 中转站常常只允许服务端 UA / 禁止浏览器预检。
 *
 * 请求体：`{ provider, baseUrl?, apiKey?, showAll? }`
 *  - `apiKey` 缺失时，仅当请求的 provider 与已保存的 provider 一致才复用已保存的 Key；
 *  - `baseUrl` 缺失时用 Provider 默认端点。
 *
 * 响应：`{ ok, source: 'remote'|'catalog'|'mixed', models: [...], warning }`
 * 任何在线失败都降级为内置目录（`source='catalog'`），用 `warning` 说明原因，
 * 不向上抛 5xx——设置界面永远能拿到一份可选的模型清单。
 */

import { LLM_PROVIDER_IDS, llmProviderOf } from '../../shared/llm-providers.js'
import { ROUTES } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { listModels, redactModelError } from '../llm/models.js'
import { normalizeBaseUrl } from '../llm/config.js'

/**
 * @param {{ appConfig?: object, log?: object }} deps
 */
export function createLlmModelRoutes({ appConfig, log } = {}) {
  return [
    {
      name: 'llm-models',
      path: ROUTES.llmModels.path,
      method: ROUTES.llmModels.method,
      async handler(req, res) {
        let body = null
        try {
          body = await readJsonBody(req)
        } catch {
          return sendError(res, 400, 'invalid_request', '请求体必须是合法 JSON 对象')
        }
        const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
        if (!provider || !llmProviderOf(provider)) {
          return sendError(res, 400, 'invalid_request', `provider 必须是 ${LLM_PROVIDER_IDS.join(' / ')} 之一`)
        }
        const meta = llmProviderOf(provider)

        // 显式传入的 baseUrl 必须合法；缺失时用 Provider 默认端点（OpenCode 用内置目录，不需要端点）。
        const rawBaseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
        let baseUrl = meta.baseUrl
        if (rawBaseUrl) {
          const normalized = normalizeBaseUrl(rawBaseUrl)
          if (!normalized) return sendError(res, 400, 'invalid_request', 'baseUrl 必须是 http(s) 绝对地址')
          baseUrl = normalized
        }

        // Key 解析顺序：请求体 → 已保存的同 provider Key。跨 provider 一律不复用，
        // 避免把 OpenAI 的 Key 发到别家端点。
        let apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey && appConfig && typeof appConfig.getLlmConfig === 'function' && typeof appConfig.whenReady === 'function') {
          await appConfig.whenReady()
          const saved = appConfig.getLlmConfig()
          if (saved && saved.provider === provider && typeof saved.apiKey === 'string') apiKey = saved.apiKey
        }

        try {
          const result = await listModels({
            provider,
            baseUrl,
            apiKey,
            showAll: body?.showAll === true,
          })
          log?.info?.(`llm_models provider=${provider} source=${result.source} count=${result.models.length}`)
          return sendJson(res, 200, {
            ok: true,
            source: result.source,
            models: result.models,
            warning: result.warning,
          })
        } catch (error) {
          // listModels 内部已降级；走到这里说明连兜底目录都不可用（极端情况）。
          log?.warn?.(`llm_models_failed provider=${provider} detail=${redactModelError(error?.message ?? error, apiKey)}`)
          return sendJson(res, 200, {
            ok: true,
            source: 'catalog',
            models: [],
            warning: '模型列表暂时不可用，请手动输入模型 ID',
          })
        }
      },
    },
  ]
}
