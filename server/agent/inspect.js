/**
 * Agent 视觉回看的图片预览构造（M3.5 Phase B）。
 *
 * 设计取舍（与 Host「零图像依赖」原则一致，见 server/tools.js 顶部注释）：
 *  - 不引入 sharp / jimp / Python PIL 做缩放：直接读取产物字节转 data URL；
 *  - 用文件体积上限（LIMITS.explore 之外的 INTENT.inspectMaxBytes）控制上下文 Token 成本，
 *    超限的图片不注入，只在文本里说明原因，让模型改用路径 / 元数据做判断；
 *  - 真正的「视觉门控」由 pi-ai 完成：`model.input.includes('image')` 的模型才会把
 *    toolResult 里的 image 块转成 image_url 发给上游；纯文本模型自动忽略，不额外烧 Token
 *    （见 node_modules/@earendil-works/pi-ai openai-completions / anthropic-messages 的 transform）。
 *
 * 返回的 image 块格式遵循 pi-ai 的 `ImageContent`：`{ type:'image', data:<base64>, mimeType }`。
 */

import { readFile, stat } from 'node:fs/promises'

import { INTENT } from '../../shared/contract.js'
import { resolveOutputPath } from '../paths.js'
import { contentTypeOf } from '../paths.js'

/** 允许注入视觉上下文的图片 MIME（产物固定 PNG / JPEG / WebP）。 */
const VISIBLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp'])

/**
 * 读取一组工作区相对产物路径，构造可直接塞进 toolResult.content 的 pi-ai 图片块。
 *
 * 只处理落在输出目录内的合法路径（复用 resolveOutputPath 的软链接逃逸校验）；单张超过
 * inspectMaxBytes、非图片 MIME、读取失败的图片都会被跳过并在 `skipped` 里给出原因。
 *
 * @param {object} ctx Host 上下文（供 resolveOutputPath 解析工作区）
 * @param {string[]} paths 工作区相对产物路径
 * @returns {Promise<{ blocks: Array<{type:'image',data:string,mimeType:string}>, skipped: Array<{path:string,reason:string}> }>}
 */
export async function buildInspectBlocks(ctx, paths) {
  const blocks = []
  const skipped = []
  const seen = new Set()

  for (const raw of Array.isArray(paths) ? paths : []) {
    if (blocks.length >= INTENT.inspectMaxImages) {
      skipped.push({ path: String(raw), reason: `超出单次最多 ${INTENT.inspectMaxImages} 张的限制` })
      continue
    }
    if (typeof raw !== 'string' || !raw.trim() || seen.has(raw)) continue
    seen.add(raw)

    let resolved
    try {
      resolved = await resolveOutputPath(ctx, raw)
    } catch {
      resolved = null
    }
    if (!resolved?.absolute) {
      skipped.push({ path: raw, reason: '路径不在产物目录内或文件不存在' })
      continue
    }

    const mime = contentTypeOf(resolved.absolute)
    if (!VISIBLE_MIME.has(mime)) {
      skipped.push({ path: raw, reason: '不是可预览的图片格式' })
      continue
    }

    let info
    try {
      info = await stat(resolved.absolute)
    } catch {
      skipped.push({ path: raw, reason: '文件不可读' })
      continue
    }
    if (!info.isFile() || info.size > INTENT.inspectMaxBytes) {
      skipped.push({ path: raw, reason: `文件过大（${Math.round(info.size / 1024)}KB，上限 ${Math.round(INTENT.inspectMaxBytes / 1024)}KB）` })
      continue
    }

    try {
      const buffer = await readFile(resolved.absolute)
      blocks.push({ type: 'image', data: buffer.toString('base64'), mimeType: mime })
    } catch {
      skipped.push({ path: raw, reason: '读取失败' })
    }
  }

  return { blocks, skipped }
}
