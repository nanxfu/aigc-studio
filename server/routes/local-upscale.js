/**
 * 本机端侧超分落盘路由（M3.5 Phase D S3）。
 *
 * 推理与瓦片融合在渲染进程（WebGPU / WASM）完成；Host 只校验回传 PNG、
 * 来源作品与尺寸，然后复用 `saveJobOutput` 写入标准产物目录。这样
 * `meta.upscale / sourceImage / rootImage`、版本树、历史与画廊全部沿用现有语义，
 * 不另造一套「本机产物」格式。
 */

import { randomBytes } from 'node:crypto'

import { LOCAL_UPSCALE, ROUTES, TIMEOUTS, UPSCALE } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { decodeImageData } from '../image-data.js'
import { parseImageHeader } from '../image-meta.js'
import { normalizeReference } from '../jobs/validator.js'
import { readHistoryItem, saveJobOutput } from '../output.js'
import { outputRoot, resolveOutputPath } from '../paths.js'

const BODY_MAX_BYTES = Math.max(
  TIMEOUTS.bodyMaxBytes,
  Math.ceil((LOCAL_UPSCALE.maxSaveBytes * 4) / 3) + 1024 * 1024,
)

/**
 * @param {{ ctx: object, log: object }} deps
 */
export function createLocalUpscaleRoutes({ ctx, log }) {
  return [
    {
      name: 'local-upscale-save',
      path: ROUTES.localUpscaleSave.path,
      method: ROUTES.localUpscaleSave.method,
      async handler(req, res) {
        let body
        try {
          body = await readJsonBody(req, { maxBytes: BODY_MAX_BYTES, strictObject: true })
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        if (typeof body?.data !== 'string' || !body.data.trim()) {
          return sendError(res, 400, 'invalid_body', '缺少 data（dataURL 或 base64 字符串）')
        }

        const decoded = decodeImageData(body.data)
        if (!decoded.ok) return sendError(res, 400, 'invalid_request', decoded.message)
        if (decoded.buffer.length > LOCAL_UPSCALE.maxSaveBytes) {
          const limitMb = Math.round((LOCAL_UPSCALE.maxSaveBytes / 1024 / 1024) * 10) / 10
          return sendError(res, 400, 'invalid_request', `放大结果超过 ${limitMb} MB 上限`)
        }
        const header = parseImageHeader(decoded.buffer)
        if (!header) return sendError(res, 400, 'invalid_request', '本机放大结果必须是 PNG / JPEG')
        if (Math.max(header.width, header.height) > UPSCALE.maxOutputEdge) {
          return sendError(
            res,
            400,
            'invalid_request',
            `放大结果长边 ${Math.max(header.width, header.height)}px 超过 ${UPSCALE.maxOutputEdge}px 上限`,
          )
        }
        const declaredWidth = Number(body.width)
        const declaredHeight = Number(body.height)
        if (
          (Number.isFinite(declaredWidth) && Math.round(declaredWidth) !== header.width)
          || (Number.isFinite(declaredHeight) && Math.round(declaredHeight) !== header.height)
        ) {
          return sendError(res, 400, 'invalid_request', '回传宽高与图片头不一致')
        }

        const referenceResult = normalizeReference({ path: body.sourcePath })
        if (!referenceResult.ok || !referenceResult.value?.path) {
          return sendError(
            res,
            400,
            referenceResult.code || 'invalid_request',
            referenceResult.message || '缺少来源作品路径',
          )
        }
        const sourcePath = referenceResult.value.path
        const sourceAbsolute = await resolveOutputPath(ctx, sourcePath)
        if (!sourceAbsolute) {
          return sendError(res, 400, 'invalid_path', '来源作品不存在或不在当前工作区 outputs/ 内')
        }

        const sourceWidth = Math.max(1, Math.round(header.width / UPSCALE.factor))
        const sourceHeight = Math.max(1, Math.round(header.height / UPSCALE.factor))
        const prompt = typeof body.prompt === 'string'
          ? body.prompt.trim().slice(0, 1200)
          : ''
        const model = typeof body.model === 'string' && body.model.trim()
          ? body.model.trim().slice(0, 120)
          : 'realesrgan-x2plus'
        const ep = body.ep === 'webgpu' ? 'WebGPU' : body.ep === 'wasm' ? 'WASM' : '本机'
        const now = new Date().toISOString()
        const job = {
          id: `local-upscale-${randomBytes(4).toString('hex')}`,
          tool: 'upscale',
          presetId: UPSCALE.id,
          modelId: model,
          provider: null,
          device: `端侧 ONNX · ${ep}`,
          createdAt: now,
          params: {
            prompt,
            negativePrompt: '',
            width: sourceWidth,
            height: sourceHeight,
            steps: 0,
            cfg: 0,
            seed: 0,
            count: 1,
            reference: { sourcePath, upscale: true },
          },
        }
        let saved
        try {
          saved = await saveJobOutput(ctx, job, [{
            image_b64: decoded.buffer.toString('base64'),
            width: header.width,
            height: header.height,
            sourceWidth,
            sourceHeight,
            scale: UPSCALE.factor,
            seconds: Math.max(0, Number(body.elapsedMs) || 0) / 1000,
          }])
        } catch (error) {
          log?.warn?.(`local_upscale_save_failed detail=${String(error?.message ?? error).slice(0, 300)}`)
          return sendError(res, 500, error?.code || 'internal_error', String(error?.message ?? error))
        }
        const item = await readHistoryItem(ctx, outputRoot(ctx), saved.dir.split('/').pop())
        if (!item) {
          return sendError(res, 500, 'internal_error', '本机放大已落盘但读取历史条目失败')
        }
        sendJson(res, 200, { ok: true, entry: { image: item.images[0], item } })
      },
    },
  ]
}
