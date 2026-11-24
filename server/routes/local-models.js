/**
 * 本机端侧模型统一管理路由：
 *  - GET  /api/local-models           列出全部已登记模型、缓存目录与就绪/下载进度；
 *  - POST /api/local-models/download  触发指定模型的后台懒下载 + SHA-256 校验；
 *  - POST /api/local-models/delete    删除指定模型的本机缓存文件释放磁盘；
 *  - POST /api/local-models/dir       设置 / 重置自定义本机模型目录（持久化到 app-config）；
 *  - GET  /api/local-models/file      按需下载并流式输出模型二进制（供渲染进程 WebGPU/WASM 加载）。
 */

import { ERROR_CODES, ROUTES, TIMEOUTS } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { LOCAL_MODEL_NOT_FOUND, LOCAL_MODEL_UNAVAILABLE } from '../local-models.js'
import { parseQuery } from '../route-kit.js'

function statusOf(code) {
  if (code === LOCAL_MODEL_NOT_FOUND) return 404
  if (code === LOCAL_MODEL_UNAVAILABLE) return 503
  return ERROR_CODES[code]?.status ?? 500
}

function sendFail(res, result) {
  return sendError(res, statusOf(result.code), result.code, result.message)
}

export function createLocalModelsRoutes({ ctx, appConfig, localModels, log } = {}) {
  if (!localModels) return []

  return [
    {
      name: 'local-models-list',
      path: ROUTES.localModels.path,
      method: ROUTES.localModels.method,
      async handler(_req, res) {
        if (appConfig) await appConfig.whenReady()
        const view = await localModels.listModels({ ctx })
        sendJson(res, 200, { ok: true, ...view })
      },
    },
    {
      name: 'local-models-download',
      path: ROUTES.localModelDownload.path,
      method: ROUTES.localModelDownload.method,
      async handler(req, res) {
        let body
        try {
          body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) return sendError(res, 400, 'invalid_request', '缺少模型 id')
        if (appConfig) await appConfig.whenReady()
        const result = await localModels.startDownload(id, { ctx })
        if (!result.ok) return sendFail(res, result)
        sendJson(res, 200, { ok: true, model: result.model })
      },
    },
    {
      name: 'local-models-delete',
      path: ROUTES.localModelDelete.path,
      method: ROUTES.localModelDelete.method,
      async handler(req, res) {
        let body
        try {
          body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) return sendError(res, 400, 'invalid_request', '缺少模型 id')
        if (appConfig) await appConfig.whenReady()
        const result = await localModels.deleteModel(id, { ctx })
        if (!result.ok) return sendFail(res, result)
        sendJson(res, 200, { ok: true, model: result.model })
      },
    },
    {
      name: 'local-models-toggle',
      path: ROUTES.localModelToggle.path,
      method: ROUTES.localModelToggle.method,
      async handler(req, res) {
        let body
        try {
          body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) return sendError(res, 400, 'invalid_request', '缺少模型 id')
        if (typeof body.enabled !== 'boolean') {
          return sendError(res, 400, 'invalid_request', 'enabled 必须是布尔值')
        }
        if (appConfig) await appConfig.whenReady()
        const result = await localModels.setModelEnabled(id, body.enabled, { ctx })
        if (!result.ok) return sendFail(res, result)
        sendJson(res, 200, { ok: true, model: result.model })
      },
    },
    {
      name: 'local-models-dir',
      path: ROUTES.localModelsDir.path,
      method: ROUTES.localModelsDir.method,
      async handler(req, res) {
        if (!appConfig) {
          return sendError(res, 400, 'invalid_request', '当前运行模式不支持修改全局本机模型目录')
        }
        let body
        try {
          body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        if (typeof body.dir !== 'string') {
          return sendError(res, 400, 'invalid_request', 'dir 必须是字符串')
        }
        await appConfig.whenReady()
        const saved = await appConfig.saveLocalModelsDir(body.dir)
        if (!saved.ok) {
          const status = saved.code === 'internal_error' ? 500 : 400
          return sendError(res, status, saved.code || 'invalid_request', saved.message)
        }
        const view = await localModels.listModels({ ctx })
        sendJson(res, 200, { ok: true, ...view })
      },
    },
    {
      name: 'local-models-file',
      path: ROUTES.localModelFile.path,
      method: ROUTES.localModelFile.method,
      async handler(req, res) {
        const id = (parseQuery(req, log).get('id') ?? '').trim()
        if (!id) return sendError(res, 400, 'invalid_request', '缺少模型 id')
        if (appConfig) await appConfig.whenReady()
        const opened = await localModels.openModelStream(id, { ctx })
        if (!opened.ok) return sendFail(res, opened)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(opened.bytes),
          'cache-control': 'no-store',
        })
        opened.stream.on('error', (error) => {
          log?.warn?.(`读取本机模型流失败 id=${id} detail=${error?.message ?? error}`)
          if (!res.headersSent) {
            sendError(res, 503, LOCAL_MODEL_UNAVAILABLE, '读取本机模型文件失败')
          } else {
            res.destroy(error)
          }
        })
        opened.stream.pipe(res)
      },
    },
  ]
}
