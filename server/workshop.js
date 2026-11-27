/**
 * 资产工坊（M4.2a / M4.2b）Host 侧纯逻辑。
 *
 * 路由层（`server/routes/workshop.js`）只负责 HTTP 形状与错误码映射；校验、落盘、
 * 版本树继承与算子提交都在本模块完成，便于离线单测，也避免同一条规则写两遍。
 *
 * 目录约定（与 `/api/import` 同构，读取统一走 `server/output.js` 的 readHistoryItem）：
 *   outputs/<stamp>-workshop-<6 位随机>/
 *     01.png        主图（PNG；画廊 / 胶片条只认它）
 *     <role>.<ext>  附属通道（png / svg / json；重复角色追加 -2、-3）
 *     meta.json     提交标记（最后写，半截产物不会被历史扫描收录）
 *
 * 三条能力的分工：
 *  - saveWorkshopAsset：本机确定性算子（像素对齐 / 切片 / 平铺 / 矢量）的产物落盘；
 *  - exportWorkZip：把某个作品目录整包打成 ZIP（复用 server/bundle.js 的纯 JS 实现）；
 *  - vectorizeImage：Host 侧 Node WASM（@visioncortex/vtracer）把 PNG 转 SVG，不写盘；
 *  - submitWorkshopOp：把抹除背景 / PBR / 深度 / 重打光四个 GPU 算子提交进现有串行任务队列。
 *
 * 错误统一返回 `{ ok: false, code, message }`，由路由层按 `ERROR_CODES` 映射 HTTP 状态码。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { LIMITS, WORKSHOP } from '../shared/contract.js'
import { workshopComputeProfileOf } from '../shared/workshop-compute.js'
import { normalizeWorkshopPerceptionTag } from '../shared/workshop-scenes.js'
import { createZip } from './bundle.js'
import { writeFileAtomic } from './fs-atomic.js'
import { parseImageHeader } from './image-meta.js'
import { channelFileName, channelLabelOf, readHistoryItem, stamp } from './output.js'
import { isWithin, outputRoot, resolveOutputPath, workspaceRoot } from './paths.js'

/**
 * 矢量化依赖不可用时的错误码（契约 `ERROR_CODES.vectorizer_unavailable`，HTTP 503）。
 *
 * 集中成常量而不是散落字面量：保存 / 导出等其它工坊能力不依赖该码，只有 vectorize 会发出；
 * 路由层按它映射 503（见 server/routes/workshop.js）。
 */
export const VECTORIZER_UNAVAILABLE = 'vectorizer_unavailable'

/** meta 展示参数（body.meta）的字节上限：它只用于回显，不能借它把 meta.json 写爆。 */
const WORKSHOP_META_MAX_BYTES = 64 * 1024

/** 失败结果。 */
function fail(code, message) {
  return { ok: false, code, message }
}

/** 字节数 → MB 文案（保留一位小数）。 */
function mbOf(bytes) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`
}

/**
 * 清理展示名：去掉控制字符、首尾空白，按字符截断到 `WORKSHOP.save.maxNameChars`。
 * 名字只进 meta / 列表标题，不参与落盘路径（与 `/api/import` 同一套规则）。
 */
function cleanName(value) {
  if (typeof value !== 'string') return ''
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  return Array.from(stripped).slice(0, WORKSHOP.save.maxNameChars).join('')
}

/**
 * 把 base64（可带 dataURL 前缀）归一成字节。
 * 只做格式归一，图片类型由调用方按魔数校验（与 `/api/import` 一致）。
 */
function decodeBase64Data(data) {
  let text = data.trim()
  if (/^data:/i.test(text)) {
    const match = /^data:([^,]*);base64,([\s\S]*)$/i.exec(text)
    if (!match) return { ok: false, message: 'data 不是合法的 base64 dataURL（需要 ...;base64,... 形式）' }
    text = match[2]
  }
  const payload = text.replace(/\s+/g, '')
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    return { ok: false, message: 'data 不是合法的 base64 字符串' }
  }
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length === 0) return { ok: false, message: 'data 解码后为空' }
  return { ok: true, buffer }
}

/**
 * 把文本通道（SVG / JSON）的 data 归一成字符串：既接受裸文本，也接受 dataURL
 * （`data:image/svg+xml;base64,...` / `data:application/json;base64,...`）。
 */
function decodeTextData(data) {
  const text = data.trim()
  if (!/^data:/i.test(text)) return { ok: true, value: text }
  const match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(text)
  if (!match) return { ok: false, message: 'data 不是合法的 dataURL' }
  if (match[2]) {
    const payload = match[3].replace(/\s+/g, '')
    if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
      return { ok: false, message: 'data 的 base64 部分不合法' }
    }
    return { ok: true, value: Buffer.from(payload, 'base64').toString('utf8') }
  }
  try {
    return { ok: true, value: decodeURIComponent(match[3]) }
  } catch {
    return { ok: false, message: 'data 不是合法的 URI 编码文本' }
  }
}

/** 判断文本是否是 SVG：允许 BOM 与前导空白，接受 XML 声明或根元素直接以 `<svg` 开头。 */
function isSvgText(text) {
  const head = text.replace(/^\uFEFF/, '').trimStart().toLowerCase()
  return head.startsWith('<?xml') || head.startsWith('<svg')
}

/**
 * 通道格式：显式 format 必须命中白名单；缺省按角色推断（svg → svg，atlas → json，其余 png）。
 * 客户端总会显式给，这里只是给手写请求留一条可预期的兜底。
 */
function channelFormatOf(channel) {
  if (channel.format !== undefined && channel.format !== null) {
    return WORKSHOP.channels.formats.includes(channel.format) ? channel.format : null
  }
  if (channel.role === 'svg') return 'svg'
  if (channel.role === 'atlas') return 'json'
  return 'png'
}

/** 展示参数（body.meta）：普通对象才保留，其它（数组 / 标量 / 超限）一律按 null。 */
function normalizeWorkshopParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > WORKSHOP_META_MAX_BYTES) return null
  } catch {
    return null
  }
  return value
}

/**
 * 解析 base 作品，得到版本树继承字段。
 *
 * 规则与出图落盘的 rootImage 语义一致：父作品 meta 有 rootImage 就继承（readHistoryItem
 * 已按 sourceImage 链回溯 ≤8 层），读不到父条目时退回 base 自身作为根。
 * base 非法（越界 / 不存在 / 非 outputs 内路径）时按「没有父作品」处理，不阻断保存：
 * 工坊产物仍可独立成根，避免一次历史清理就把保存链路打挂。
 *
 * @returns {Promise<{ sourceImage: string|null, rootImage: string|null }>}
 */
async function resolveWorkshopBase(ctx, base) {
  const requested = base && typeof base === 'object' && !Array.isArray(base) ? base.path : null
  if (typeof requested !== 'string' || requested.trim() === '') return { sourceImage: null, rootImage: null }
  const found = await resolveOutputPath(ctx, requested.trim()).catch(() => null)
  if (!found) return { sourceImage: null, rootImage: null }
  // found.relative 形如 `outputs/<作品目录>/<文件>`：目录名固定是第二段。
  const dirName = found.relative.split('/')[1]
  const parent = dirName ? await readHistoryItem(ctx, outputRoot(ctx), dirName).catch(() => null) : null
  return { sourceImage: found.relative, rootImage: parent?.rootImage ?? found.relative }
}

/**
 * 保存工坊复合资产包：主图 + 可选附属通道落成一个新作品，并继承 base 的版本树。
 *
 * 请求体（`POST /api/workshop/save`）：
 * ```
 * {
 *   base?: { path?: string },                       // 源作品图片路径（outputs/ 内），可省略
 *   tool: string,                                   // WORKSHOP.tools 之一
 *   name?: string,                                  // 展示名（清洗后截断）
 *   primary: { data: string, width?: number, height?: number },   // PNG dataURL / base64
 *   channels?: [{ role, label?, format?: 'png'|'svg'|'json', data: string }],
 *   meta?: object                                   // 工具参数快照，只用于回显
 * }
 * ```
 *
 * @returns {Promise<{ ok: true, entry: { image: object, item: object } }
 *   | { ok: false, code: string, message: string }>}
 */
export async function saveWorkshopAsset(ctx, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', '请求体必须是 JSON 对象')

  // ---- 工具白名单 ----
  const tool = typeof body.tool === 'string' && WORKSHOP.tools.includes(body.tool) ? body.tool : null
  if (!tool) return fail('invalid_request', `tool 必须是 ${WORKSHOP.tools.join(' / ')} 之一`)

  // ---- 主图：必须是 PNG，字节与尺寸以图片头为准 ----
  const primary = body.primary
  if (!primary || typeof primary !== 'object' || Array.isArray(primary) || typeof primary.data !== 'string') {
    return fail('invalid_request', 'primary.data 必须是 PNG 的 dataURL 或 base64 字符串')
  }
  if (primary.data.trim() === '') return fail('invalid_request', 'primary.data 不能为空')
  const primaryDecoded = decodeBase64Data(primary.data)
  if (!primaryDecoded.ok) return fail('invalid_request', `primary：${primaryDecoded.message}`)
  const primaryBuffer = primaryDecoded.buffer
  if (primaryBuffer.length > WORKSHOP.save.maxPrimaryBytes) {
    return fail('invalid_request', `主图超过 ${mbOf(WORKSHOP.save.maxPrimaryBytes)} 上限`)
  }
  const primaryHeader = parseImageHeader(primaryBuffer)
  if (!primaryHeader || primaryHeader.format !== 'png') {
    return fail('invalid_request', 'primary 必须是 PNG 图片（只接受 PNG 主图）')
  }
  const width = primaryHeader.width
  const height = primaryHeader.height

  // ---- 附属通道：数量 / 单项体积 / 格式 / 总字节逐项校验 ----
  const rawChannels = body.channels === undefined || body.channels === null ? [] : body.channels
  if (!Array.isArray(rawChannels)) return fail('invalid_request', 'channels 必须是数组')
  if (rawChannels.length > WORKSHOP.channels.maxCount) {
    return fail('invalid_request', `channels 最多 ${WORKSHOP.channels.maxCount} 个`)
  }
  const usedNames = new Set()
  const preparedChannels = []
  let totalBytes = primaryBuffer.length
  for (const [index, channel] of rawChannels.entries()) {
    const label = `channels[${index}]`
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
      return fail('invalid_request', `${label} 必须是对象`)
    }
    const role = WORKSHOP.channels.roles.includes(channel.role) ? channel.role : null
    if (!role) return fail('invalid_request', `${label}.role 必须是 ${WORKSHOP.channels.roles.join(' / ')} 之一`)
    const format = channelFormatOf(channel)
    if (!format) {
      return fail('invalid_request', `${label}.format 必须是 ${WORKSHOP.channels.formats.join(' / ')} 之一`)
    }
    if (typeof channel.data !== 'string' || channel.data.trim() === '') {
      return fail('invalid_request', `${label}.data 不能为空`)
    }

    let buffer
    let channelWidth = null
    let channelHeight = null
    if (format === 'png') {
      const decoded = decodeBase64Data(channel.data)
      if (!decoded.ok) return fail('invalid_request', `${label}：${decoded.message}`)
      const header = parseImageHeader(decoded.buffer)
      if (!header) return fail('invalid_request', `${label} 不是合法的 PNG 图片`)
      buffer = decoded.buffer
      channelWidth = header.width
      channelHeight = header.height
    } else {
      const decoded = decodeTextData(channel.data)
      if (!decoded.ok) return fail('invalid_request', `${label}：${decoded.message}`)
      if (format === 'svg' && !isSvgText(decoded.value)) {
        return fail('invalid_request', `${label} 的 data 必须以 <?xml 或 <svg 开头`)
      }
      if (format === 'json') {
        try {
          JSON.parse(decoded.value)
        } catch {
          return fail('invalid_request', `${label} 的 data 不是合法 JSON`)
        }
      }
      buffer = Buffer.from(decoded.value, 'utf8')
    }
    if (buffer.length > WORKSHOP.channels.maxBytes) {
      return fail('invalid_request', `${label} 超过 ${mbOf(WORKSHOP.channels.maxBytes)} 上限`)
    }
    totalBytes += buffer.length
    if (totalBytes > WORKSHOP.save.maxTotalBytes) {
      return fail('invalid_request', `主图 + 通道合计超过 ${mbOf(WORKSHOP.save.maxTotalBytes)} 上限`)
    }
    preparedChannels.push({
      file: channelFileName(role, format, usedNames),
      role,
      label: channelLabelOf(channel.label, role),
      format,
      width: channelWidth,
      height: channelHeight,
      bytes: buffer.length,
      buffer,
    })
  }

  // ---- 版本树继承（base.path 非法时按独立根处理）----
  const base = await resolveWorkshopBase(ctx, body.base)
  const name = cleanName(body.name)
  const prompt = name || tool
  const workshopParams = normalizeWorkshopParams(body.meta)
  const now = new Date().toISOString()
  const dirName = `${stamp()}-workshop-${randomBytes(3).toString('hex')}`
  const absoluteDir = join(outputRoot(ctx), dirName)

  // 先写全部文件、最后写 meta.json（commit 标记）：中途失败时目录里没有 meta，
  // 历史扫描会忽略半截产物，而不是展示一条缺文件的坏记录。
  try {
    await mkdir(absoluteDir, { recursive: true })
    await writeFileAtomic(join(absoluteDir, '01.png'), primaryBuffer)
    for (const channel of preparedChannels) {
      await writeFileAtomic(join(absoluteDir, channel.file), channel.buffer)
    }
    const meta = {
      version: 1,
      mediaType: 'image',
      jobId: `workshop-${dirName}`,
      presetId: null,
      provider: null,
      device: null,
      createdAt: now,
      finishedAt: now,
      params: {
        prompt,
        width,
        height,
        count: 1,
        source: 'workshop',
        workshop: { tool, params: workshopParams },
      },
      images: [{ file: '01.png', mediaType: 'image', width, height, seed: null, seconds: null, prompt }],
      source: 'ai',
      workshop: true,
      workshopTool: tool,
      workshopParams,
      sourceImage: base.sourceImage,
      rootImage: base.rootImage,
    }
    // meta 形状按规格固定包含 channels（没有通道时写空数组），读取端与 /history 同形。
    meta.channels = preparedChannels.map(({ file, role, label, format: channelFormat, width: w, height: h, bytes }) => ({
      file,
      role,
      label,
      format: channelFormat,
      width: w,
      height: h,
      bytes,
    }))
    await writeFileAtomic(join(absoluteDir, 'meta.json'), JSON.stringify(meta, null, 2), { encoding: 'utf8' })
  } catch (error) {
    return fail('internal_error', `工坊产物写入失败：${error?.message ?? error}`)
  }

  // 直接复用历史扫描的归一逻辑，保证响应里的 item 与 /history 条目逐字段同形。
  const item = await readHistoryItem(ctx, outputRoot(ctx), dirName).catch(() => null)
  if (!item) return fail('internal_error', '工坊产物已落盘但读取失败，请刷新历史')
  return { ok: true, entry: { image: item.images[0], item } }
}

const metaTagWriteLocks = new Map()

function withMetaTagLock(metaPath, task) {
  const previous = metaTagWriteLocks.get(metaPath) || Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.catch(() => {})
  metaTagWriteLocks.set(metaPath, tail)
  tail.finally(() => {
    if (metaTagWriteLocks.get(metaPath) === tail) metaTagWriteLocks.delete(metaPath)
  })
  return run
}

/**
 * 把客户端收敛后的感知标签写回作品目录的 `meta.json`（Phase 2.5）。
 *
 * 安全与幂等约束：
 *  - `path` 必须经 `resolveOutputPath` 确认是 `outputs/` 内已存在的文件，再定位到
 *    同一目录的 `meta.json`；不跟随任意相对路径。
 *  - 标签按共享白名单归一（版本必须等于当前 `tagVersion`，工具 / 场景 / Noul 都会被
 *    过滤），未知字段不落盘。
 *  - 已有同版本的 `l1+l2` 标签时，迟到的纯 L1 标签不会降级覆盖；直接返回现有标签。
 *  - 单图目录只替换 `meta.workshopPerception`；多图批次按文件名写入 `meta.workshopPerceptions[file]`
 *    （同时串行化同一 `meta.json` 的并发写入，避免多张图同时落盘互相覆盖），其余字段原样保留并原子写回。
 *
 * @param {object} ctx
 * @param {{ path?: string, tag?: object }} body
 * @returns {Promise<{ ok: true, tag: object, skipped?: boolean }
 *   | { ok: false, code: string, message: string }>}
 */
export async function saveWorkshopPerceptionTag(ctx, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('invalid_body', '请求体必须是 JSON 对象')
  }
  const requested = typeof body.path === 'string' ? body.path.trim() : ''
  if (!requested) return fail('invalid_path', 'path 不能为空')

  const tag = normalizeWorkshopPerceptionTag(body.tag)
  if (!tag) {
    return fail(
      'invalid_request',
      `tag 不符合当前契约（version 必须为 ${WORKSHOP.perception.tagVersion}，且场景 / 工具 / Noul / updatedAt 必须合法）`,
    )
  }

  const found = await resolveOutputPath(ctx, requested).catch(() => null)
  if (!found) return fail('invalid_path', `path 必须是 ${basename(outputRoot(ctx))}/ 内已存在的作品文件`)

  const fileName = basename(found.absolute)
  const metaPath = join(dirname(found.absolute), 'meta.json')

  return withMetaTagLock(metaPath, async () => {
    let meta
    try {
      meta = JSON.parse(await readFile(metaPath, 'utf8'))
    } catch {
      return fail('not_found', '作品 meta.json 不存在或无法解析')
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return fail('invalid_request', '作品 meta.json 不是有效对象')
    }

    const isMultiImage = Array.isArray(meta.images) && meta.images.length > 1
    if (isMultiImage) {
      const existing = meta.workshopPerceptions && typeof meta.workshopPerceptions === 'object' && !Array.isArray(meta.workshopPerceptions)
        ? meta.workshopPerceptions
        : {}
      const nextMap = {}
      for (const [key, value] of Object.entries(existing)) {
        const clean = normalizeWorkshopPerceptionTag(value)
        if (clean) nextMap[key] = clean
      }
      const current = nextMap[fileName] || null
      if (current && current.source === 'l1+l2' && tag.source === 'l1-heuristic') {
        return { ok: true, tag: current, skipped: true }
      }
      nextMap[fileName] = tag
      meta.workshopPerceptions = nextMap
    } else {
      const current = normalizeWorkshopPerceptionTag(meta.workshopPerception)
      if (current && current.source === 'l1+l2' && tag.source === 'l1-heuristic') {
        return { ok: true, tag: current, skipped: true }
      }
      meta.workshopPerception = tag
    }

    try {
      await writeFileAtomic(metaPath, JSON.stringify(meta, null, 2), { encoding: 'utf8' })
    } catch (error) {
      return fail('internal_error', `感知标签写入失败：${error?.message ?? error}`)
    }
    return { ok: true, tag }
  })
}

/**
 * 把请求里的作品路径（作品图片或作品目录）归一成 `outputs/` 内的作品目录。
 *
 * 校验口径与 `resolveOutputPath` 相同：词法包含性 + realpath 包含性 + 目录存在；
 * 区别只在于允许传入目录本身。作品目录必须严格位于产物根目录下（不允许导出整个 outputs/）。
 *
 * @returns {Promise<{ ok: true, value: { absolute: string, name: string } }
 *   | { ok: false, code: 'invalid_path'|'not_found', message: string }>}
 */
async function resolveExportDir(ctx, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    return fail('invalid_path', 'path 不能为空')
  }
  const text = requestedPath.trim()
  if (text.includes('\0')) return fail('invalid_path', 'path 含有非法字符')
  const root = resolve(outputRoot(ctx))

  // 先按作品图片解析：命中文件时取它所在目录；否则按作品目录解析。
  const foundFile = await resolveOutputPath(ctx, text).catch(() => null)
  let target
  if (foundFile) {
    target = dirname(foundFile.absolute)
  } else {
    target = isAbsolute(text) ? resolve(text) : resolve(workspaceRoot(ctx), ...text.split(/[\\/]+/))
    if (!isWithin(root, target)) {
      return fail('invalid_path', `path 必须是 ${basename(root)}/ 内的作品路径或作品目录`)
    }
  }

  const realRoot = await realpath(root).catch(() => null)
  const realTarget = await realpath(target).catch(() => null)
  if (!realRoot || !realTarget) return fail('not_found', '作品目录不存在')
  if (!isWithin(realRoot, realTarget)) {
    return fail('invalid_path', `path 指向了 ${basename(root)}/ 之外的目录`)
  }
  const info = await stat(realTarget).catch(() => null)
  if (!info?.isDirectory()) return fail('not_found', '作品目录不存在')
  return { ok: true, value: { absolute: realTarget, name: basename(realTarget) } }
}

/**
 * 把一个作品目录整包导出为 ZIP（`GET /api/workshop/export?path=...`）。
 *
 * 目录内常规文件全部打包（meta.json / 主图 / 通道文件），条目名就是目录内文件名；
 * 不递归子目录、不跟随符号链接。文件数与总字节按契约 `WORKSHOP.export` 护栏。
 *
 * @returns {Promise<{ ok: true, name: string, bytes: Buffer }
 *   | { ok: false, code: string, message: string }>}
 */
export async function exportWorkZip(ctx, relativePath) {
  const resolvedDir = await resolveExportDir(ctx, relativePath)
  if (!resolvedDir.ok) return resolvedDir
  const { absolute, name: dirName } = resolvedDir.value

  let children
  try {
    children = await readdir(absolute, { withFileTypes: true })
  } catch (error) {
    return fail('not_found', `作品目录读取失败：${error?.message ?? error}`)
  }
  // 只打包常规文件：dirent.isFile() 为 false 的（子目录 / 符号链接）一律跳过。
  const fileNames = children
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  if (fileNames.length === 0) return fail('not_found', '作品目录里没有可导出的文件')
  if (fileNames.length > WORKSHOP.export.maxFiles) {
    return fail('too_many', `作品目录文件数 ${fileNames.length} 超过导出上限 ${WORKSHOP.export.maxFiles}`)
  }

  const entries = []
  let totalBytes = 0
  for (const fileName of fileNames) {
    const filePath = join(absolute, fileName)
    const info = await stat(filePath).catch(() => null)
    if (!info?.isFile()) continue
    totalBytes += info.size
    if (totalBytes > WORKSHOP.export.maxBytes) {
      return fail('invalid_request', `作品目录合计超过导出上限 ${mbOf(WORKSHOP.export.maxBytes)}`)
    }
    const data = await readFile(filePath).catch(() => null)
    if (!data) continue
    entries.push({ name: fileName, data })
  }
  if (entries.length === 0) return fail('not_found', '作品目录里没有可导出的文件')

  try {
    // createZip 是纯 JS 实现（server/bundle.js），不新增依赖；条目名已被上面限定为目录内文件名。
    const bytes = createZip(entries)
    return { ok: true, name: `${dirName}.zip`, bytes }
  } catch (error) {
    return fail('internal_error', `ZIP 打包失败：${error?.message ?? error}`)
  }
}

/**
 * 矢量化选项归一：逐项按契约 `WORKSHOP.vector` 的边界校验，非法值直接拒绝（不静默改写，
 * 否则用户看到的预览与所选参数对不上）。
 *
 * @returns {{ ok: true, value: object } | { ok: false, code: 'invalid_request', message: string }}
 */
export function normalizeVectorOptions(raw) {
  const options = raw === undefined || raw === null ? {} : raw
  if (typeof options !== 'object' || Array.isArray(options)) {
    return fail('invalid_request', 'options 必须是对象')
  }
  const spec = WORKSHOP.vector
  const value = {
    // 缺省值与契约保持同源，避免不同版本默认参数漂移。
    colorPrecision: spec.colorPrecision.default,
    filterSpeckle: spec.filterSpeckle.default,
    hierarchical: spec.hierarchy[0],
    mode: spec.mode[0],
    clustering: 'color-cluster',
  }

  const { colorPrecision, filterSpeckle, colormode, hierarchy, mode } = options
  if (colorPrecision !== undefined && colorPrecision !== null) {
    if (
      typeof colorPrecision !== 'number'
      || !Number.isInteger(colorPrecision)
      || colorPrecision < spec.colorPrecision.min
      || colorPrecision > spec.colorPrecision.max
    ) {
      return fail(
        'invalid_request',
        `colorPrecision 必须是 ${spec.colorPrecision.min}~${spec.colorPrecision.max} 的整数`,
      )
    }
    value.colorPrecision = colorPrecision
  }
  if (filterSpeckle !== undefined && filterSpeckle !== null) {
    if (
      typeof filterSpeckle !== 'number'
      || !Number.isInteger(filterSpeckle)
      || filterSpeckle < spec.filterSpeckle.min
      || filterSpeckle > spec.filterSpeckle.max
    ) {
      return fail(
        'invalid_request',
        `filterSpeckle 必须是 ${spec.filterSpeckle.min}~${spec.filterSpeckle.max} 的整数`,
      )
    }
    value.filterSpeckle = filterSpeckle
  }
  if (colormode !== undefined && colormode !== null) {
    if (!spec.colormode.includes(colormode)) {
      return fail('invalid_request', `colormode 必须是 ${spec.colormode.join(' / ')} 之一`)
    }
    // vtracer 用 clustering 表达「彩色 / 二值」：color → color-cluster，binary → bw。
    value.clustering = colormode === 'binary' ? 'bw' : 'color-cluster'
  }
  if (hierarchy !== undefined && hierarchy !== null) {
    if (!spec.hierarchy.includes(hierarchy)) {
      return fail('invalid_request', `hierarchy 必须是 ${spec.hierarchy.join(' / ')} 之一`)
    }
    value.hierarchical = hierarchy
  }
  if (mode !== undefined && mode !== null) {
    if (!spec.mode.includes(mode)) {
      return fail('invalid_request', `mode 必须是 ${spec.mode.join(' / ')} 之一`)
    }
    value.mode = mode
  }
  return { ok: true, value }
}

/** 缓存成功的矢量转换函数：@visioncortex/vtracer 是 WASM 模块，import 本身也有成本。 */
let cachedVectorizer = null

/**
 * 动态加载矢量化依赖（成功结果只缓存一次）。
 *
 * 已安装的 `@visioncortex/vtracer@1.0.0-alpha.4` 是 CJS + WASM 包，实际导出
 * `convertBuffer(buffer, options)`；规格书里写的 `convertRawImageToSvg` 是更早的命名，
 * 这里保留同名兜底（按同样的 encoded buffer 入参调用）。两种形状都没有时按依赖不可用处理
 * （路由返回 503 vectorizer_unavailable，绝不让进程崩溃）。
 *
 * @returns {Promise<{ convert: Function, kind: 'buffer'|'raw' }>}
 */
async function loadVectorizer() {
  if (cachedVectorizer) return cachedVectorizer
  const mod = await import('@visioncortex/vtracer')
  if (typeof mod.convertBuffer === 'function') {
    cachedVectorizer = { convert: (buffer, options) => mod.convertBuffer(buffer, options), kind: 'buffer' }
    return cachedVectorizer
  }
  if (typeof mod.convertRawImageToSvg === 'function') {
    cachedVectorizer = {
      convert: (buffer, options) => mod.convertRawImageToSvg(buffer, options),
      kind: 'raw',
    }
    return cachedVectorizer
  }
  throw new Error('@visioncortex/vtracer 未导出 convertBuffer / convertRawImageToSvg')
}

/**
 * 把 `outputs/` 内的 PNG 矢量化成 SVG（Host 侧 Node WASM，0 Python / 0 GPU）。
 *
 * 只读取与转换、不写盘：落盘由 `/api/workshop/save` 统一完成（作为 svg 通道保存），
 * 避免矢量预览在产物目录里留下无人登记的临时文件。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ path?: string, options?: object }} body
 * @returns {Promise<{ ok: true, svg: string, width: number, height: number, bytes: number }
 *   | { ok: false, code: string, message: string }>}
 */
export async function vectorizeImage(ctx, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', '请求体必须是 JSON 对象')
  const requested = typeof body.path === 'string' ? body.path.trim() : ''
  if (!requested) return fail('invalid_request', 'path 不能为空')

  const found = await resolveOutputPath(ctx, requested).catch(() => null)
  if (!found) return fail('invalid_path', `path 必须是 ${basename(outputRoot(ctx))}/ 内已存在的作品文件`)
  const info = await stat(found.absolute).catch(() => null)
  if (!info?.isFile()) return fail('invalid_path', '源图不存在')
  if (info.size > WORKSHOP.save.maxPrimaryBytes) {
    return fail('invalid_request', `源图超过 ${mbOf(WORKSHOP.save.maxPrimaryBytes)} 上限`)
  }
  const buffer = await readFile(found.absolute).catch(() => null)
  if (!buffer) return fail('not_found', '源图读取失败')
  const header = parseImageHeader(buffer)
  if (!header || header.format !== 'png') return fail('invalid_request', '矢量化的源图必须是 PNG')
  const longEdge = Math.max(header.width, header.height)
  if (longEdge > WORKSHOP.vector.maxInputEdge) {
    return fail(
      'invalid_request',
      `源图长边 ${longEdge}px 超过矢量化上限 ${WORKSHOP.vector.maxInputEdge}px，请先缩小画幅`,
    )
  }

  const options = normalizeVectorOptions(body.options)
  if (!options.ok) return options

  let vectorizer
  try {
    vectorizer = await loadVectorizer()
  } catch (error) {
    return fail(
      VECTORIZER_UNAVAILABLE,
      `SVG 矢量化依赖 @visioncortex/vtracer 不可用（${error?.message ?? error}）：请在仓库根目录执行 npm install 后重试`,
    )
  }

  let svg
  try {
    svg = vectorizer.convert(buffer, options.value)
  } catch (error) {
    // WASM 解码失败通常是 PNG 结构损坏（只校验了头部魔数），按输入非法返回。
    return fail('invalid_request', `PNG 解码失败，无法矢量化：${error?.message ?? error}`)
  }
  if (typeof svg !== 'string' || svg.trim() === '') {
    return fail('invalid_request', '矢量化没有产出 SVG 内容')
  }
  return {
    ok: true,
    svg,
    width: header.width,
    height: header.height,
    bytes: Buffer.byteLength(svg, 'utf8'),
  }
}

/** 按算子 op 取契约配置（模型白名单 / 尺寸与体积边界 / 步数）。 */
function workshopOpSpecOf(op) {
  if (op === WORKSHOP.cutout.op) {
    const spec = WORKSHOP.cutout
    return {
      op,
      models: spec.models.map((model) => model.id),
      defaultModel: spec.defaultModel,
      maxInputEdge: spec.maxInputEdge,
      minInputEdge: spec.minInputEdge,
      maxBytes: spec.maxBytes,
      steps: null,
    }
  }
  if (op === WORKSHOP.pbr.op) {
    const spec = WORKSHOP.pbr
    return {
      op,
      models: spec.models.map((model) => model.id),
      defaultModel: spec.defaultModel,
      maxInputEdge: spec.maxInputEdge,
      minInputEdge: spec.minInputEdge,
      maxBytes: spec.maxBytes,
      steps: spec.steps,
    }
  }
  if (op === WORKSHOP.depth.op) {
    const spec = WORKSHOP.depth
    return {
      op,
      models: spec.models.filter((model) => model.runtime === 'gpu-worker').map((model) => model.id),
      defaultModel: spec.defaultCloudModel,
      maxInputEdge: spec.maxInputEdge,
      minInputEdge: spec.minInputEdge,
      maxBytes: spec.maxBytes,
      steps: null,
    }
  }
  if (op === WORKSHOP.relight.op) {
    const spec = WORKSHOP.relight
    return {
      op,
      models: spec.models.map((model) => model.id),
      defaultModel: spec.defaultModel,
      maxInputEdge: spec.maxInputEdge,
      minInputEdge: spec.minInputEdge,
      maxBytes: spec.maxBytes,
      steps: spec.steps,
    }
  }
  return null
}

/**
 * 提交 GPU 后处理算子（抹除背景 / PBR / 深度 / 重打光）。
 *
 * 校验顺序与出图链路一致：op / model 白名单 → path 越界与存在性 → 图片头宽高与体积 →
 * pbr 步数边界 → 入队。入队形状对齐现有 upscale 分支（单张源图、无 prompt / 预设），
 * 另带 `model` 与 `steps`；队列实现（server/jobs/queue.js）尚未支持这两个 tool 时，
 * 直接把它返回的错误码透传给客户端（不在这里伪造成功）。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ op?: string, path?: string, model?: string, options?: { steps?: number } }} body
 * @param {object} queue JobQueue（优先 enqueue，兼容旧命名 submit）
 * @returns {Promise<{ ok: true, jobId: string } | { ok: false, code: string, message: string }>}
 */
export async function submitWorkshopOp(ctx, body, queue) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', '请求体必须是 JSON 对象')
  const op = typeof body.op === 'string' ? body.op : ''
  const spec = workshopOpSpecOf(op)
  if (!spec) {
    return fail(
      'invalid_request',
      `op 必须是 ${WORKSHOP.cutout.op} / ${WORKSHOP.pbr.op} / ${WORKSHOP.depth.op} / ${WORKSHOP.relight.op} 之一`,
    )
  }
  if (body.execution !== undefined && !['local', 'cloud'].includes(body.execution)) {
    return fail('invalid_request', 'execution 必须是 local / cloud 之一')
  }
  // ---- 模型白名单（缺省取契约默认模型）----
  let model = spec.defaultModel
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (!requestedModel || !spec.models.includes(requestedModel)) {
      return fail('invalid_request', `model 必须是 ${spec.models.join(' / ')} 之一`)
    }
    model = requestedModel
  }

  // 本机 / 云端执行位置：只允许契约里登记为 hybrid-cuda 的模型进入本机队列；
  // 端侧 ONNX 与 cloud-only 模型在这里就拒绝，避免任务开始后才在 Python 里失败。
  const localProfile = workshopComputeProfileOf(op, model)
  const localEngine = queue?.options?.localWorkshop
    ?? (op === WORKSHOP.pbr.op ? queue?.options?.localPbr : null)
  const capability = localProfile?.tier === 'hybrid-cuda' && typeof localEngine?.capability === 'function'
    ? await localEngine.capability({ op, model }).catch(() => null)
    : null
  let execution = body.execution
  if (execution === 'local') {
    if (localProfile?.tier !== 'hybrid-cuda') {
      return fail('invalid_request', `模型 ${model} 不支持本机 CUDA 执行，请切换云端。`)
    }
    if (!capability?.localEligible && !capability?.available) {
      const reason = capability?.reason ? `：${capability.reason}` : ''
      return fail('invalid_request', `本机暂不满足 ${model} 的运行条件${reason}；请释放资源或切换云端。`)
    }
  } else if (execution === undefined) {
    execution = localProfile?.tier === 'hybrid-cuda'
      && (capability?.localEligible === true || capability?.available === true)
      ? 'local'
      : 'cloud'
  }

  // ---- 源图：必须是 outputs/ 内已存在的图片，按图片头校验尺寸 ----
  const requested = typeof body.path === 'string' ? body.path.trim() : ''
  if (!requested) return fail('invalid_path', 'path 不能为空')
  const found = await resolveOutputPath(ctx, requested).catch(() => null)
  if (!found) return fail('invalid_path', `path 必须是 ${basename(outputRoot(ctx))}/ 内已存在的作品文件`)
  const info = await stat(found.absolute).catch(() => null)
  if (!info?.isFile()) return fail('invalid_path', '源图不存在')
  if (info.size > spec.maxBytes) {
    return fail('invalid_request', `源图超过 ${mbOf(spec.maxBytes)} 上限`)
  }
  const buffer = await readFile(found.absolute).catch(() => null)
  if (!buffer) return fail('not_found', '源图读取失败')
  const header = parseImageHeader(buffer)
  if (!header) return fail('invalid_request', 'path 必须指向 PNG / JPEG 图片')
  const longEdge = Math.max(header.width, header.height)
  const shortEdge = Math.min(header.width, header.height)
  if (longEdge > spec.maxInputEdge) {
    return fail(
      'invalid_request',
      `源图长边 ${longEdge}px 超过 ${op} 上限 ${spec.maxInputEdge}px`,
    )
  }
  if (shortEdge < spec.minInputEdge) {
    return fail(
      'invalid_request',
      `图片太小（${header.width}×${header.height}），宽高都至少需要 ${spec.minInputEdge} 像素`,
    )
  }

  // ---- 采样步数：pbr / relight 显式给出时按契约边界严格校验 ----
  let steps = null
  if (spec.steps) {
    const rawSteps = body.options && typeof body.options === 'object' ? body.options.steps : undefined
    if (rawSteps !== undefined && rawSteps !== null) {
      if (
        typeof rawSteps !== 'number'
        || !Number.isInteger(rawSteps)
        || rawSteps < spec.steps.min
        || rawSteps > spec.steps.max
      ) {
        return fail('invalid_request', `options.steps 必须是 ${spec.steps.min}~${spec.steps.max} 的整数`)
      }
      steps = rawSteps
    }
  }
  let options = steps !== null ? { steps } : null
  if (op === WORKSHOP.relight.op) {
    const source = body.options && typeof body.options === 'object' && !Array.isArray(body.options)
      ? body.options
      : {}
    const prompt = typeof source.prompt === 'string' ? source.prompt.trim() : ''
    if (prompt.length > WORKSHOP.relight.maxPromptChars) {
      return fail('invalid_request', `prompt 最多 ${WORKSHOP.relight.maxPromptChars} 个字符`)
    }
    const rawCfg = source.cfg
    let cfg = WORKSHOP.relight.cfg.default
    if (rawCfg !== undefined && rawCfg !== null) {
      if (typeof rawCfg !== 'number' || !Number.isFinite(rawCfg)
        || rawCfg < WORKSHOP.relight.cfg.min || rawCfg > WORKSHOP.relight.cfg.max) {
        return fail(
          'invalid_request',
          `options.cfg 必须是 ${WORKSHOP.relight.cfg.min}~${WORKSHOP.relight.cfg.max} 的数字`,
        )
      }
      cfg = rawCfg
    }
    let seed = null
    if (source.seed !== undefined && source.seed !== null) {
      if (typeof source.seed !== 'number' || !Number.isInteger(source.seed) || source.seed < 0) {
        return fail('invalid_request', 'options.seed 必须是非负整数')
      }
      seed = Math.min(LIMITS.seed.max, source.seed)
    }
    options = {
      ...(options || {}),
      prompt,
      cfg,
      seed,
      preset: typeof source.preset === 'string' ? source.preset.trim().slice(0, 80) : '',
    }
  }

  // ---- 入队：与 upscale 分支同构；T-D 的队列实现优先用 enqueue()，旧命名 submit() 兜底 ----
  const enqueue =
    typeof queue?.enqueue === 'function'
      ? (request) => queue.enqueue(request)
      : typeof queue?.submit === 'function'
        ? (request) => queue.submit(request)
        : null
  if (!enqueue) return fail('internal_error', '任务队列不可用')

  const request = {
    tool: op,
    prompt: options?.prompt || '',
    presetId: null,
    reference: { path: found.relative },
    // 宽高与 /api/generate 的 upscale 分支一样放在顶层，队列可据此复用尺寸预检。
    width: header.width,
    height: header.height,
    model,
  }
  request.execution = execution
  if (options) {
    // 同时给 options.steps 与顶层 steps：queue / validator 两处实现都能直接读到，
    // 值相同，不会产生歧义（客户端请求体用的是 options.steps）。
    request.options = options
    if (steps !== null) request.steps = steps
    if (options.cfg !== undefined) request.cfg = options.cfg
    if (options.seed !== null && options.seed !== undefined) request.seed = options.seed
  }

  let result
  try {
    // await 兼容同步返回（JobQueue.submit）与异步返回（enqueue 实现可能挂在远端 / 包装层）。
    result = await enqueue(request)
  } catch (error) {
    return fail('internal_error', `任务入队失败：${error?.message ?? error}`)
  }
  if (!result || typeof result !== 'object') return fail('internal_error', '任务队列没有返回结果')
  if (result.ok === false) return fail(result.code || 'internal_error', result.message || '任务入队被拒绝')
  const job = result.job && typeof result.job === 'object' ? result.job : null
  const jobId = typeof job?.id === 'string' ? job.id : typeof result.jobId === 'string' ? result.jobId : ''
  if (!jobId) return fail('internal_error', '任务队列没有返回 jobId')
  return { ok: true, jobId }
}
