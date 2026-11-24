/**
 * 资产工坊路由（M4.2a/b）：复合资产包保存 / ZIP 导出 / SVG 矢量 / GPU 后处理算子提交。
 *
 * 路径与方法一律引用 `shared/contract.js` 的 ROUTES（唯一来源）；校验、落盘与入队逻辑
 * 都在 `server/workshop.js`，这里只负责 HTTP 形状：请求体上限、错误码 → HTTP 状态映射、
 * 二进制 ZIP 响应。错误码沿用契约词表，客户端按 `error.code` 统一解释。
 */

import { ERROR_CODES, ROUTES, TIMEOUTS, WORKSHOP } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import { parseQuery } from '../route-kit.js'
import {
  VECTORIZER_UNAVAILABLE,
  exportWorkZip,
  saveWorkshopAsset,
  submitWorkshopOp,
  vectorizeImage,
} from '../workshop.js'
import {
  VISION_UNAVAILABLE,
  createWorkshopVision,
  decodeWorkshopVisionPixels,
} from '../workshop-vision.js'

/**
 * 保存请求体上限：主图 + 通道以 base64 提交（体积约为解码后的 4/3），
 * 在契约总字节上限之上留 1 MB 给 JSON 字段与 dataURL 前缀，避免合法请求在路由层被拒。
 */
const SAVE_BODY_MAX_BYTES = Math.max(TIMEOUTS.bodyMaxBytes, WORKSHOP.save.maxTotalBytes + 1024 * 1024)

/**
 * 错误码 → HTTP 状态：优先取契约 `ERROR_CODES` 登记值；
 * `vectorizer_unavailable` 由 workshop.js 集中导出，这里显式兜底 503（即使契约词表变化也不影响语义）。
 */
function statusOf(code) {
  if (code === VECTORIZER_UNAVAILABLE) return 503
  if (code === VISION_UNAVAILABLE) return 503
  return ERROR_CODES[code]?.status ?? 500
}

/** 统一发送失败结果（code 已由 workshop.js 归类）。 */
function sendFail(res, result) {
  return sendError(res, statusOf(result.code), result.code, result.message)
}

/**
 * 读取严格 JSON 对象：坏 JSON / 非对象一律 400 invalid_body（与 `/api/import` 一致，
 * 不让数组或标量被静默归一成空对象）。
 */
async function readStrictBody(req, maxBytes) {
  return readJsonBody(req, { maxBytes, strictObject: true })
}

/**
 * @param {{ ctx: object, log: object, queue: object, vision?: object }} deps
 *   `vision` 可选注入：离线测试用假感知器代替 ONNX；缺省时创建真实实例，
 *   但模型与 WASM 都在首次请求时才懒加载。
 */
export function createWorkshopRoutes({ ctx, log, queue, vision, localModels }) {
  const visionEngine = vision || createWorkshopVision({ log, localModels })
  return [
    {
      name: 'workshop-save',
      path: ROUTES.workshopSave.path,
      method: ROUTES.workshopSave.method,
      async handler(req, res) {
        let body
        try {
          body = await readStrictBody(req, SAVE_BODY_MAX_BYTES)
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        // 成功形状：{ ok: true, entry: { image, item } }——item 与 /history 条目逐字段同形。
        const result = await saveWorkshopAsset(ctx, body)
        if (!result.ok) return sendFail(res, result)
        sendJson(res, 200, { ok: true, entry: result.entry })
      },
    },
    {
      name: 'workshop-export',
      path: ROUTES.workshopExport.path,
      method: ROUTES.workshopExport.method,
      async handler(req, res) {
        const requested = parseQuery(req, log).get('path') ?? ''
        const result = await exportWorkZip(ctx, requested)
        if (!result.ok) return sendFail(res, result)
        // 作品目录名由时间戳 + 随机串组成，这里再兜底过滤一次，保证响应头里不出现越界字符。
        const safeName = result.name.replace(/[^\w.-]+/g, '_')
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': String(result.bytes.length),
          'content-disposition': `attachment; filename="${safeName}"`,
          'cache-control': 'no-store',
        })
        res.end(result.bytes)
      },
    },
    {
      name: 'workshop-vectorize',
      path: ROUTES.workshopVectorize.path,
      method: ROUTES.workshopVectorize.method,
      async handler(req, res) {
        let body
        try {
          body = await readStrictBody(req, TIMEOUTS.bodyMaxBytes)
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        // 成功形状：{ ok: true, svg, width, height, bytes }；不写盘，保存交给 /api/workshop/save。
        const result = await vectorizeImage(ctx, body)
        if (!result.ok) return sendFail(res, result)
        sendJson(res, 200, {
          ok: true,
          svg: result.svg,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
        })
      },
    },
    {
      name: 'workshop-op',
      path: ROUTES.workshopOp.path,
      method: ROUTES.workshopOp.method,
      async handler(req, res) {
        let body
        try {
          body = await readStrictBody(req, TIMEOUTS.bodyMaxBytes)
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        // 成功形状：{ ok: true, jobId }；队列暂不支持该 tool 时原样透传其错误码。
        const result = await submitWorkshopOp(ctx, body, queue)
        if (!result.ok) return sendFail(res, result)
        sendJson(res, 200, { ok: true, jobId: result.jobId })
      },
    },
    {
      name: 'workshop-perceive',
      path: ROUTES.workshopPerceive.path,
      method: ROUTES.workshopPerceive.method,
      async handler(req, res) {
        let body
        try {
          body = await readStrictBody(req, WORKSHOP.vision.maxBodyBytes)
        } catch (error) {
          return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
        }
        // 只接受已经由客户端缩放 / 合成好的 256×256 RGB；Host 不读作品路径、不解码图片。
        const decoded = decodeWorkshopVisionPixels(body.pixels)
        if (!decoded.ok) return sendFail(res, decoded)
        // 失败一律 503 vision_unavailable：客户端静默保留 L1，不把它当成操作失败。
        const result = await visionEngine.perceive(ctx, decoded.pixels)
        if (!result.ok) return sendFail(res, result)
        sendJson(res, 200, { ok: true, perception: result.perception })
      },
    },
  ]
}
