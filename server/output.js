/**
 * 本地产物：图片落盘、meta.json、历史扫描与预览 URL。
 *
 * 目录结构固定为 `<workspace>/outputs/<YYYYMMDD-HHmmss>-<jobId>/`，
 * 目录名以时间戳开头，因此字典序即时间序，历史列表不需要额外索引。
 *
 * 版本树（阶段十三）：图生图/局部重绘产物在 meta 里记录 `rootImage`（根作品图片路径），
 * 落盘时按父作品 meta 继承；旧数据缺失该字段时按 `sourceImage` 链回溯（≤8 层）。
 * 历史接口透传这条链，`/history/tree` 按根跨分页拉整棵树。
 */

import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { LIMITS, PROVIDER_IDS, UPSCALE, WORKSHOP } from '../shared/contract.js'
import { normalizeWorkshopPerceptionTag } from '../shared/workshop-scenes.js'
import { writeFileAtomic } from './fs-atomic.js'
import { writeGenerationMeta } from './image-meta.js'
import { normalizeOutpaintContent } from './jobs/validator.js'
import { isOutputDirName, isWithin, outputDirName, outputRoot, resolveWorkspaceWritePath, toRelative } from './paths.js'

function pad(value, size = 2) {
  return String(value).padStart(size, '0')
}

export function stamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * 产物图片的对外 URL：**工作区相对路径** `/api/file?path=...`，不带 origin。
 *
 * 为什么不再拼绝对 origin：渲染进程（Electron 生产页面 / 浏览器打开本地服务）与本地服务同源，
 * 只有相对 URL 才会按页面 origin 解析——生产态直连本地服务（带同源 Session Cookie），
 * 开发态走 Vite 代理（代理注入 Bearer；直连端口则既无 Token 也无 Cookie，必然 401）。
 *
 * @param {object} _ctx 历史签名保留（曾经用于取 `webServer.getOrigin()`），当前不再使用。
 * @param {string} relativePath 工作区相对路径，如 `outputs/20260101-000000-x/01.png`
 * @returns {string} `/api/file?path=<encodeURIComponent 后的相对路径>`
 */
export function fileUrl(_ctx, relativePath) {
  const query = new URLSearchParams({ path: relativePath })
  return `/api/file?${query.toString()}`
}

/**
 * 多张交付时的文件名：`docs/assets/hero.png` → `docs/assets/hero-01.png`。
 * 序号插在扩展名前；单张交付直接用目标文件名。
 *
 * @param {string} relative 校验过的 saveTo 相对路径（已补扩展名）
 * @param {number} index 0 起的图片序号
 * @param {number} total 本批张数
 */
function deliveredName(relative, index, total) {
  if (total <= 1) return relative
  const slash = relative.lastIndexOf('/')
  const dir = slash === -1 ? '' : relative.slice(0, slash + 1)
  const name = slash === -1 ? relative : relative.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return `${dir}${stem}-${String(index + 1).padStart(2, '0')}${ext}`
}

/** 版本链回溯深度上限：旧 meta 没有 rootImage 时沿 sourceImage 链最多读 8 层。 */
const ROOT_IMAGE_MAX_DEPTH = 8

/**
 * 把 meta / 请求里记录的图片路径归一成 `outputs/` 内的 POSIX 相对路径；非法返回 null。
 *
 * meta 是本地文件，但旧版本写入或被用户手改的字段不能把后续读取带出产物目录：
 * 绝对路径、盘符、`..` / `.` 段与非 `outputs/` 前缀一律视为无效。
 */
function outputImagePathOf(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.includes('\0')) return null
  const segments = text.split(/[\\/]+/).filter((segment) => segment !== '')
  if (segments.length < 2) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (!isOutputDirName(segments[0])) return null
  return segments.join('/')
}

/**
 * 读取产物目录的 meta.json（按目录名缓存，扫描时同一目录只读一次）。
 * 目录不存在、meta 缺失或 JSON 损坏都返回 null：版本链读取只是尽力而为，不能让历史/版本树接口失败。
 */
async function readWorkMeta(rootAbsolute, dirName, memo) {
  const cached = memo?.metas?.get(dirName)
  if (cached) return cached
  const task = readFile(join(rootAbsolute, dirName, 'meta.json'), 'utf8')
    .then((text) => {
      const meta = JSON.parse(text)
      return meta && typeof meta === 'object' ? meta : null
    })
    .catch(() => null)
  memo?.metas?.set(dirName, task)
  return task
}

/**
 * 解析一张作品图的版本树根作品路径。
 *
 * 规则（.tmp/plan/INTERFACES.md §3.1 / §3.2）：
 *  - 父作品 meta 有 `rootImage` 就直接继承；
 *  - 旧 meta 没有 `rootImage` 但有 `sourceImage`：沿链继续向上，最多 8 层；
 *  - 读不到 meta / 没有 `sourceImage`：当前这张就是根；
 *  - 链出现环或超过深度上限：停在当前这张，返回它的路径（不能回溯时退回来源图）。
 *
 * @param {object} ctx 宿主上下文
 * @param {string|null} sourceImage 来源图工作区相对路径（params.reference.sourcePath 或 meta.sourceImage）
 * @param {{ maxDepth?: number, memo?: { metas?: Map, roots?: Map, contexts?: Map } }} [options]
 * @returns {Promise<string|null>} 根作品图片路径；没有有效来源图时 null
 */
async function resolveRootImage(ctx, sourceImage, { maxDepth = ROOT_IMAGE_MAX_DEPTH, memo = null } = {}) {
  const start = outputImagePathOf(sourceImage)
  if (!start) return null
  if (memo?.roots?.has(start)) return memo.roots.get(start)

  const root = outputRoot(ctx)
  const seen = new Set([start])
  let current = start
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const meta = await readWorkMeta(root, current.split('/')[1], memo)
    const inherited = meta ? outputImagePathOf(meta.rootImage) : null
    if (inherited) {
      current = inherited
      break
    }
    const parent = meta ? outputImagePathOf(meta.sourceImage) : null
    if (!parent || seen.has(parent)) break
    seen.add(parent)
    current = parent
  }
  memo?.roots?.set(start, current)
  return current
}

/** 通道标签的展示长度上限：meta 是本地文件，可能被手改，截断避免列表被超长文本拖慢。 */
const CHANNEL_LABEL_MAX_CHARS = 80

/**
 * 根作品提示词的透传长度上限。
 *
 * `rootPrompt` 只供工坊感知层做场景先验（关键词匹配），完整提示词可能在几千字符量级，
 * 历史列表每条都带着走会白白撑大响应体，所以按这句上限截断。
 */
const ROOT_PROMPT_MAX_CHARS = 600

/**
 * 从作品 meta 里取「根作品先验」：原生提示词与预设 id。
 *
 * 本地导入图没有生图语义（prompt 是文件名），一律按 null 处理；`params.prompt` 为非字符串
 * 或空白时同样 null。
 */
function rootContextOfMeta(meta) {
  const empty = { prompt: null, presetId: null }
  if (!meta || typeof meta !== 'object') return empty
  if (meta.source === 'import') return empty
  const params = meta.params && typeof meta.params === 'object' && !Array.isArray(meta.params) ? meta.params : null
  const rawPrompt = params && typeof params.prompt === 'string' ? params.prompt.trim() : ''
  const rawPreset = typeof meta.presetId === 'string' ? meta.presetId.trim() : ''
  return {
    prompt: rawPrompt ? Array.from(rawPrompt).slice(0, ROOT_PROMPT_MAX_CHARS).join('') : null,
    presetId: rawPreset || null,
  }
}

/**
 * 解析根作品的先验上下文（`rootPrompt` / `rootPresetId`）。
 *
 * 工坊感知层需要「这张图最初是被什么提示词 / 模型生出来的」作为场景先验，而工坊产物
 * 会把 `params.prompt` 覆写成作品名或工具 id，当前作品的 prompt 已经不可信。
 * 沿 `rootImage` 读到根作品目录的 meta 即可拿回原始意图；读不到时按 null 处理，
 * 前端会退回「只看图像特征」的降级路径。
 *
 * @param {object} ctx 宿主上下文
 * @param {string|null} rootImage 根作品图片路径（`outputs/<目录>/<文件>`）
 * @param {{ metas?: Map, contexts?: Map }} [memo] 同一次历史扫描内的缓存，避免重复读盘
 * @returns {Promise<{ prompt: string|null, presetId: string|null }>}
 */
async function resolveRootContext(ctx, rootImage, memo) {
  const path = outputImagePathOf(rootImage)
  if (!path) return { prompt: null, presetId: null }
  const cached = memo?.contexts?.get(path)
  if (cached) return cached
  const dirName = path.split('/')[1]
  const task = dirName
    ? readWorkMeta(outputRoot(ctx), dirName, memo).then(rootContextOfMeta)
    : Promise.resolve({ prompt: null, presetId: null })
  memo?.contexts?.set(path, task)
  return task
}

/** 归一通道标签：去控制字符、首尾空白并截断；为空时回落角色名（前端总有可读文案）。 */
export function channelLabelOf(value, role) {
  if (typeof value !== 'string') return role
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  if (!stripped) return role
  return Array.from(stripped).slice(0, CHANNEL_LABEL_MAX_CHARS).join('')
}

/** 宽高归一：有限正整数才透传，其余 null（SVG / JSON 通道没有像素尺寸）。 */
function channelEdgeOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/**
 * 在已占用文件名集合里给通道分配 `<role>.<ext>`（重复 role 依次追加 -2、-3）。
 * 通道文件与主图同目录，重名会互相覆盖，必须先占位再写入。
 * 与 `/api/workshop/save` 的落盘共用同一套命名规则（server/workshop.js 也调用它）。
 */
export function channelFileName(role, extension, used) {
  let name = `${role}.${extension}`
  let index = 2
  while (used.has(name)) {
    name = `${role}-${index}.${extension}`
    index += 1
  }
  used.add(name)
  return name
}

/**
 * 读取并校验 meta.channels[]，归一成历史条目里的 `channels` 数组。
 *
 * 校验口径与 images 一致（meta 可能被手改或来自更早版本）：
 *  - `file` 必须落在本作品目录内（isWithin），且实际存在（stat isFile）；
 *  - `role` / `format` 必须在契约白名单内；
 *  - 非法项直接丢弃，不让一条坏记录毁掉整个历史条目。
 * 没有通道的旧产物返回空数组（读取端不必判断字段是否存在）。
 *
 * @returns {Promise<Array<{ file: string, role: string, label: string, format: string,
 *   width: number|null, height: number|null, bytes: number, absolute: string, url: string }>>}
 */
async function readChannels(ctx, resolvedDir, meta) {
  const raw = Array.isArray(meta?.channels) ? meta.channels : []
  const channels = []
  for (const channel of raw) {
    if (!channel || typeof channel !== 'object') continue
    const file = typeof channel.file === 'string' ? channel.file : ''
    if (!file) continue
    const role = WORKSHOP.channels.roles.includes(channel.role) ? channel.role : null
    if (!role) continue
    const format = WORKSHOP.channels.formats.includes(channel.format) ? channel.format : null
    if (!format) continue
    const targetAbsolute = resolve(resolvedDir, file)
    if (!isWithin(resolvedDir, targetAbsolute)) continue
    const info = await stat(targetAbsolute).then(
      (value) => (value.isFile() ? value : null),
      () => null,
    )
    if (!info) continue
    const relative = toRelative(ctx, targetAbsolute)
    channels.push({
      file,
      role,
      label: channelLabelOf(channel.label, role),
      format,
      width: channelEdgeOf(channel.width),
      height: channelEdgeOf(channel.height),
      bytes: info.size,
      absolute: targetAbsolute,
      url: fileUrl(ctx, relative),
    })
  }
  return channels
}

/**
 * 把远端返回的 Base64 图片写盘，并生成 meta.json。
 *
 * 顺序固定：先写全部图片、最后写 meta.json，meta 是「本目录已完成」的提交标记；
 * 中途失败时目录里最多只有若干完整图片，没有 meta，历史扫描会忽略该目录而不是展示半截产物。
 *
 * `job.saveTo` 存在时在归档之后额外做一次「工作区交付」：目标路径先经
 * `resolveWorkspaceWritePath` 校验（越界 / 软链接逃逸 / 插件保留目录直接失败），
 * 每张图都以同目录临时文件 + rename 写入，交付成功的相对路径记在 `deliveredPaths`。
 *
 * 多通道结果（GPU 后处理算子）：`result.channel` 命中契约通道角色时写 `<role>.png` 并登记
 * meta.channels[]，第一个通道结果同时作为主图进 images[]；无 channel 的结果保持 01.png /
 * 02.png 的旧命名与旧行为，旧链路零影响。
 *
 * @returns {Promise<{ dir: string, metaFile: string, images: Array<object>, deliveredPaths: string[] }>}
 */
export async function saveJobOutput(ctx, job, results) {
  // 交付路径先解析：非法时在创建归档目录之前失败，不留半截产物。
  const delivery = job.saveTo ? await resolveWorkspaceWritePath(ctx, job.saveTo) : null
  if (delivery && !delivery.ok) {
    throw Object.assign(new Error(delivery.message), { code: delivery.code })
  }
  const deliveryTotal = Math.max(1, Math.round(Number(job.params?.count) || 1))

  const dirName = `${stamp()}-${job.id}`
  const root = outputRoot(ctx)
  const absoluteDir = join(root, dirName)
  await mkdir(absoluteDir, { recursive: true })

  const images = []
  const records = []
  const deliveredPaths = []
  // GPU 后处理算子（抹除背景 / PBR）的多通道结果：写入 meta.channels[]，
  // 且第一个通道同时作为 images[0]（画廊 / 胶片条仍只占一张卡）。
  const channels = []
  const usedChannelFiles = new Set()
  // 无通道的图片仍按 01.png / 02.png 序号命名；通道文件不占序号，
  // 因此需要用独立计数器（有通道时 images.length 不再等于已写序号）。
  let numbered = 0

  for (const result of results) {
    // 媒体类型（M4.1）：视频结果写 .mp4 并在 meta / 历史条目里带 mediaType，
    // 图片仍写 .png 并写生成参数 tEXt。旧结果没有该字段时按 image 处理。
    const mediaType = result?.mediaType === 'video' ? 'video' : 'image'
    const extension = mediaType === 'video' ? (result?.ext === 'webm' ? 'webm' : 'mp4') : 'png'
    // 协议 v2：binary 模式的产物已由 JobQueue 下载到临时文件（tempPath），
    // 这里优先读文件；读失败/旧远端仍走 image_b64 兼容分支。
    let buffer = null
    if (typeof result?.tempPath === 'string' && result.tempPath) {
      try {
        buffer = await readFile(result.tempPath)
      } catch {
        buffer = null
      }
    }
    if (!buffer) {
      const b64 = typeof result?.image_b64 === 'string'
        ? result.image_b64
        : typeof result?.video_b64 === 'string'
          ? result.video_b64
          : ''
      if (!b64) continue
      buffer = Buffer.from(b64, 'base64')
    }
    if (buffer.length === 0) continue

    const width = result.width ?? job.params.width
    const height = result.height ?? job.params.height
    const seed = result.seed ?? job.params.seed

    // 阶段十五 Phase A3：落盘前把生成参数写进 PNG tEXt，图片单独离开工作区（拖入导入、
    // 交付到仓库）时也能回填原参数。写入是增强能力，任何异常都退回原始 buffer，绝不让
    // 出图失败。视频没有 tEXt 容器，跳过这一步。
    let storable = buffer
    if (mediaType === 'image') {
      try {
        storable = writeGenerationMeta(buffer, {
          prompt: job.params.prompt,
          negativePrompt: job.params.negativePrompt ?? '',
          presetId: job.presetId,
          width,
          height,
          steps: job.params.steps,
          cfg: job.params.cfg,
          seed,
          jobId: job.id,
          createdAt: job.createdAt ?? null,
        })
      } catch {}
    }

    // 通道结果（GPU 后处理算子）：结果带合法 channel 时写 `<role>.png`，不占 01/02 序号。
    // 非法 channel 值按普通图片处理（旧链路行为不变，不让一条脏结果毁掉整批产物）。
    const channelRole =
      mediaType === 'image' && WORKSHOP.channels.roles.includes(result?.channel) ? result.channel : null

    // 远端返回的 name 只用于展示，不参与路径拼接：避免 `../` 之类写出输出目录。
    let file
    if (channelRole) {
      file = channelFileName(channelRole, 'png', usedChannelFiles)
    } else {
      numbered += 1
      file = `${String(numbered).padStart(2, '0')}.${extension}`
    }
    await writeFileAtomic(join(absoluteDir, file), storable)

    const relative = toRelative(ctx, join(absoluteDir, file))
    if (channelRole) {
      channels.push({
        file,
        role: channelRole,
        label: channelLabelOf(result?.channelLabel, channelRole),
        format: 'png',
        width,
        height,
        bytes: storable.length,
      })
      // 第一个通道结果同时进 images[]：画廊 / 胶片条仍只占一张卡，其余通道只进 channels[]。
      if (channels.length === 1) {
        images.push({
          file,
          path: relative,
          mediaType: 'image',
          url: fileUrl(ctx, relative),
          width,
          height,
          seed,
          seconds: result.seconds ?? null,
          duration: null,
        })
        records.push({
          file,
          mediaType: 'image',
          seed,
          seconds: result.seconds ?? null,
          width,
          height,
          prompt: job.params.prompt,
          negativePrompt: job.params.negativePrompt ?? '',
        })
      }
      // 通道文件不参与 saveTo 工作区交付：后处理产物整目录留在 outputs/ 内，由导出 ZIP 交付。
      continue
    }

    images.push({
      file,
      path: relative,
      mediaType,
      url: fileUrl(ctx, relative),
      width,
      height,
      seed,
      seconds: result.seconds ?? null,
      duration: mediaType === 'video' ? (result.duration ?? null) : null,
    })
    records.push({
      file,
      mediaType,
      seed,
      seconds: result.seconds ?? null,
      width,
      height,
      ...(mediaType === 'video' ? { duration: result.duration ?? null } : {}),
      prompt: job.params.prompt,
      negativePrompt: job.params.negativePrompt ?? '',
    })

    // 工作区交付：与归档图片同样的原子写（同目录临时文件 + rename），
    // 多张时按 -01/-02 追加序号，并再次通过 resolveWorkspaceWritePath 校验落点安全。
    if (delivery?.ok) {
      const deliveredRelative = deliveredName(delivery.relative, images.length - 1, deliveryTotal)
      const deliveredCheck = await resolveWorkspaceWritePath(ctx, deliveredRelative)
      if (!deliveredCheck.ok) {
        throw Object.assign(new Error(deliveredCheck.message), { code: deliveredCheck.code })
      }
      await mkdir(dirname(deliveredCheck.absolute), { recursive: true })
      await writeFileAtomic(deliveredCheck.absolute, storable)
      deliveredPaths.push(deliveredCheck.relative)
    }
  }

  // 媒体类型：视频任务整批只有 1 段视频；图片任务保持 image（旧数据零迁移）。
  const primaryMediaType = results.some((result) => result?.mediaType === 'video') ? 'video' : 'image'
  const meta = {
    version: 1,
    mediaType: primaryMediaType,
    jobId: job.id,
    presetId: job.presetId,
    modelId: job.modelId ?? null,
    // 出处：真正执行本次任务的算力来源与设备。旧产物没有这两个字段，读取端按 null 处理。
    provider: PROVIDER_IDS.includes(job.provider) ? job.provider : null,
    device: typeof job.device === 'string' && job.device.trim() ? job.device.trim() : null,
    deviceCount: Number.isFinite(job.deviceCount) ? job.deviceCount : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? new Date().toISOString(),
    params: job.params,
    images: records,
  }
  // 交付路径写进 meta：历史条目与「复现同一组图」时可以知道文件也落在工作区哪里。
  if (deliveredPaths.length) meta.deliveredPaths = [...deliveredPaths]
  // 通道清单（GPU 后处理算子）：有通道时才写；没有该字段的旧产物读取端按空数组处理。
  if (channels.length) meta.channels = channels
  // 图生图（M3）：产物记录参考图出处与重绘强度，便于画廊回看「这张是从哪张图重绘的」。
  // 纯 image（前端上传）来源没有工作区路径，sourceImage 记 null；扩图（Phase B）的
  // image 来源会带客户端给的 sourcePath，因此同样能溯源。
  // 局部重绘再记 inpaint=true：meta 是「本目录已完成」的提交标记，复现时不必再解析 params。
  // 版本树（阶段十三）：rootImage 记录根作品路径，O(1) 归组整棵树；父作品 meta 有就继承，
  // 旧父作品（无 rootImage）按 sourceImage 链回溯 ≤8 层，读不到 meta 时退回来源图本身。
  // 上传来源没有可归组的根，sourceImage / rootImage 都显式写 null，客户端不必猜字段是否存在。
  if (job.params?.reference) {
    const sourceImage =
      typeof job.params.reference.sourcePath === 'string' ? job.params.reference.sourcePath : null
    meta.sourceImage = sourceImage
    meta.rootImage = sourceImage ? await resolveRootImage(ctx, sourceImage) : null
    meta.strength = job.params.reference.strength
    if (job.params.reference.mask) meta.inpaint = true
  }
  // 阶段十五 Phase B：高清放大 / 扩图的派生类型标记。
  //  - upscale：记录倍数与源图尺寸，versionPanel 可显示「高清放大 ×2」而不用再解码图片；
  //  - outpaint：扩图在远端是普通局部重绘（meta.inpaint 仍按蒙版逻辑为 true），另记标记
  //    供版本树区分「扩图」与「涂抹重绘」；outpaintContent 记录原图在画布里的内容框
  //    （归一化 0~1），「对比原图」拉帘按它把原图放回真实位置。
  //    旧产物没有这些字段，读取端按 false / null 处理。
  const tool = job.tool ?? 'generate'
  if (tool === 'upscale') {
    const primary = results.find((result) => typeof result?.image_b64 === 'string' || typeof result?.tempPath === 'string') ?? results[0] ?? {}
    const numberOr = (value, fallback) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback
    meta.upscale = true
    meta.upscaleScale = numberOr(primary.scale, UPSCALE.factor)
    meta.upscaleSource = {
      width: numberOr(primary.sourceWidth, null),
      height: numberOr(primary.sourceHeight, null),
    }
  }
  if (tool === 'outpaint') {
    meta.outpaint = true
    // 落盘前再归一一次：meta 是历史接口的源头，不能让脏对象绕过校验进产物；
    // 旧客户端 / 没带内容框的请求显式写 null，客户端不必判断字段是否存在。
    const content = normalizeOutpaintContent(job.params?.reference?.outpaintContent)
    meta.outpaintContent = content.ok ? content.value : null
  }
  // 资产工坊 GPU 后处理算子（M4.2）：工具 id 用契约 WORKSHOP.tools 的写法
  // （remove-bg 产物的工具 id 是 cutout，pbr 保持 pbr），并补 workshop 标记；
  // 读取端与 /api/workshop/save 的本机算子产物共用同一套解析。
  const workshopTool = tool === 'remove-bg' ? 'cutout' : tool === 'pbr' ? 'pbr' : null
  if (workshopTool) {
    meta.workshop = true
    meta.workshopTool = workshopTool
  }
  // 阶段十五 Phase C1：模型原生参考生图的产物记录参考图来源数组（工作区相对路径），
  // 用于溯源；这类产物不折叠进参考图版本树（sourceImage / rootImage 保持 null，每张候选图
  // 各自为根），因此这里只写 referenceSources 与显式 source=ai，不碰版本链字段。
  // 旧产物 / 纯文生图没有该字段，读取端按 null 处理。
  const referenceSources = Array.isArray(job.references)
    ? job.references.filter((value) => typeof value === 'string' && value.trim() !== '')
    : []
  if (referenceSources.length) {
    meta.source = 'ai'
    meta.referenceSources = [...referenceSources]
  }
  const metaAbsolute = join(absoluteDir, 'meta.json')
  await writeFileAtomic(metaAbsolute, JSON.stringify(meta, null, 2), { encoding: 'utf8' })

  return {
    dir: `${outputDirName(ctx)}/${dirName}`,
    metaFile: toRelative(ctx, metaAbsolute),
    images,
    deliveredPaths,
  }
}

/**
 * 读取单个产物目录，归一成 HistoryItem；目录没有可展示的有效记录时返回 null。
 *
 * 有效记录 = 有 meta.json，且至少一张 meta 中登记的图片文件实际存在
 * （图片可能已被用户在画廊里删除）。历史分页的 offset 只统计有效记录。
 *
 * 导出给 `lib/routes/import.js` 复用：导入路由落盘后要返回与 /history 完全同形的条目，
 * 不能维护第二套字段拼装（否则 source / url / absolute 之类容易漂移）。
 */
export async function readHistoryItem(ctx, root, name, memo = null) {
  const absoluteDir = join(root, name)
  let meta
  try {
    meta = JSON.parse(await readFile(join(absoluteDir, 'meta.json'), 'utf8'))
  } catch {
    return null
  }
  const resolvedDir = resolve(absoluteDir)
  const rawImages = Array.isArray(meta?.images) ? meta.images : []
  const isMultiImage = rawImages.length > 1
  const directoryPerception = normalizeWorkshopPerceptionTag(meta?.workshopPerception)
  const perceptionByFile =
    meta?.workshopPerceptions && typeof meta.workshopPerceptions === 'object' && !Array.isArray(meta.workshopPerceptions)
      ? meta.workshopPerceptions
      : null
  const images = (
    await Promise.all(
      rawImages
        .filter((image) => image && image.file)
        .map(async (image) => {
          const targetAbsolute = resolve(resolvedDir, String(image.file ?? ''))
          if (!isWithin(resolvedDir, targetAbsolute)) return null
          const relative = toRelative(ctx, targetAbsolute)
          // 图片可能已被用户在画廊里删除；meta 里还留着记录，这里按实际文件过滤。
          const exists = await stat(targetAbsolute).then(
            (info) => info.isFile(),
            () => false,
          )
          if (!exists) return null
          const fileTag = perceptionByFile ? normalizeWorkshopPerceptionTag(perceptionByFile[image.file]) : null
          return {
            file: image.file,
            path: relative,
            mediaType: image.mediaType === 'video' ? 'video' : 'image',
            // 绝对路径给「复制文件路径」用：客户端拿不到工作区根目录。
            absolute: targetAbsolute,
            url: fileUrl(ctx, relative),
            width: image.width ?? null,
            height: image.height ?? null,
            seed: image.seed ?? null,
            seconds: image.seconds ?? null,
            duration: image.mediaType === 'video' && Number.isFinite(image.duration) ? image.duration : null,
            workshopPerception: fileTag || (!isMultiImage ? directoryPerception : null),
          }
        }),
    )
  ).filter(Boolean)
  if (images.length === 0) return null

  // 版本树字段（阶段十三）：sourceImage / rootImage / inpaint / strength 恒存在，缺省分别是 null / null / false / null。
  // 阶段十五 Phase B 追加 upscale / upscaleScale / outpaint：旧 meta 没有这些字段时自动是
  // false / null / false，客户端不必判断字段是否存在，也不需要迁移旧数据。
  // 新 meta 直接透传 rootImage；0.12 及以前的旧 meta 没有该字段，尽力按 sourceImage 链回溯到根
  // （≤8 层），回溯不到时退回 sourceImage 本身，前端不必自己再拼跨分页的链。
  const sourceImage = outputImagePathOf(meta.sourceImage)
  const rootImage =
    outputImagePathOf(meta.rootImage) ?? (sourceImage ? await resolveRootImage(ctx, sourceImage, { memo }) : null)
  // 工坊场景化引导（M4.2c）：根作品的原生提示词与预设 id 作为场景先验。
  // 两个字段恒存在（旧产物 / 导入图为 null），客户端不必判断字段是否存在；
  // 只读、不参与重现逻辑，`params.prompt` 的既有语义完全不变。
  const rootContext = await resolveRootContext(ctx, rootImage, memo)
  // 扩图内容框：meta 可能被手改 / 来自更早版本，读取时再归一一次；非法或缺失一律 null。
  const outpaintContent = normalizeOutpaintContent(meta?.outpaintContent)

  // 原生参考生图的参考图来源数组（阶段十五 Phase C1）：字段恒存在——有来源时是
  // `outputs/` 内路径数组，旧产物与纯文生图为 null。meta 可能被手改，读取时逐项
  // 过 `outputImagePathOf` 归一，非法项直接丢弃（全部非法时按 null 处理）。
  const referenceSources = Array.isArray(meta.referenceSources)
    ? meta.referenceSources.map(outputImagePathOf).filter(Boolean)
    : []
  // 资产工坊（M4.2）：本机确定性算子产物与 GPU 后处理算子产物共用同一套字段。
  //  - workshop：是否工坊产物（旧产物 false）；
  //  - workshopTool：工具 id，必须命中契约白名单才透传（手改 meta 的脏值按 null）；
  //  - workshopParams：本机算子参数快照，只保留普通对象；
  //  - channels：复合资产包的附属通道，恒为数组，非法项逐项丢弃。
  const workshopTool = WORKSHOP.tools.includes(meta.workshopTool) ? meta.workshopTool : null
  const workshopParams =
    meta.workshopParams && typeof meta.workshopParams === 'object' && !Array.isArray(meta.workshopParams)
      ? meta.workshopParams
      : null
  const channels = await readChannels(ctx, resolvedDir, meta)
  // 感知打标（Phase 2.5）：单图作品沿用 item.workshopPerception，多图批次按 image.workshopPerception
  // 各自独立（item 级置 null 避免同批图片串用）。版本不匹配 / 字段非法一律返回 null。
  const workshopPerception = !isMultiImage
    ? (images[0]?.workshopPerception ?? directoryPerception)
    : null
  return {
    jobId: meta.jobId ?? name,
    dir: `${outputDirName(ctx)}/${name}`,
    createdAt: meta.createdAt ?? null,
    finishedAt: meta.finishedAt ?? null,
    presetId: meta.presetId ?? null,
    // 出处：旧产物没有 provider / device，显示端按未知处理；不猜测、不伪造。
    provider: PROVIDER_IDS.includes(meta.provider) ? meta.provider : null,
    device: typeof meta.device === 'string' && meta.device.trim() ? meta.device.trim() : null,
    deviceCount: Number.isFinite(meta.deviceCount) ? meta.deviceCount : null,
    // 来源（阶段十五 Phase A3）：导入作品标记 import，生成作品一律 ai。
    // 旧 meta 没有 source 字段时按 ai，客户端据此显示「导入」角标。
    source: meta.source === 'import' ? 'import' : 'ai',
    // 资产类型（Plan §五.1）：旧 meta / 图片产物缺省回落 image，为 Phase 2 视频/3D 预留。
    mediaType: meta.mediaType === 'video' || meta.mediaType === 'mesh3d' ? meta.mediaType : 'image',
    // 客户端「带回参数」与舞台提示词需要完整参数；只回显 prompt 会让历史图无法复现。
    params: meta.params ?? null,
    prompt: meta.params?.prompt ?? '',
    images,
    sourceImage,
    rootImage,
    // 根作品先验（M4.2c）：只读溯源字段，供工坊感知层判断场景；不影响参数重现。
    rootPrompt: rootContext.prompt,
    rootPresetId: rootContext.presetId,
    inpaint: meta.inpaint === true,
    // 高清放大：倍数只在 meta 里是有限数字时透传，否则 null（旧数据即 null）。
    upscale: meta.upscale === true,
    upscaleScale:
      typeof meta.upscaleScale === 'number' && Number.isFinite(meta.upscaleScale) ? meta.upscaleScale : null,
    outpaint: meta.outpaint === true,
    // 扩图内容框（原图在画布里的归一化矩形）：恒存在，合法对象或 null（旧产物 / 脏数据）。
    outpaintContent: outpaintContent.ok ? outpaintContent.value : null,
    strength: typeof meta.strength === 'number' && Number.isFinite(meta.strength) ? meta.strength : null,
    // 原生参考生图的参考图来源数组（Phase C1）：恒存在，路径数组或 null（旧产物 / 纯文生图）。
    referenceSources: referenceSources.length > 0 ? referenceSources : null,
    // 资产工坊（M4.2）：字段恒存在；旧产物分别是 false / null / null / []。
    workshop: meta.workshop === true,
    workshopTool,
    workshopParams,
    channels,
    workshopPerception,
  }
}

/** 分页参数的默认值与边界（与 Host 路由共用契约，避免两套钳制口径）。 */
function normalizeHistoryPage(limitOrOptions, maybeOffset) {
  const options = limitOrOptions && typeof limitOrOptions === 'object' ? limitOrOptions : null
  const rawLimit = options ? options.limit : limitOrOptions
  const rawOffset = options ? options.offset : maybeOffset
  const limitNumber = Number(rawLimit)
  const offsetNumber = Number(rawOffset)
  return {
    limit: Number.isFinite(limitNumber)
      ? Math.max(0, Math.min(LIMITS.history.maxLimit, Math.round(limitNumber)))
      : LIMITS.history.defaultLimit,
    offset: Number.isFinite(offsetNumber) ? Math.max(0, Math.round(offsetNumber)) : 0,
  }
}

/**
 * 扫描历史产物（按目录名倒序 = 时间倒序，支持分页）。
 *
 * 兼容两种调用签名：
 *  - `scanHistory(ctx, limit)`：旧签名，等价于 `{ limit }`；
 *  - `scanHistory(ctx, { limit, offset })`：分页，`offset` 跳过最近的 offset 条有效记录。
 *
 * 只读取有效记录（有 meta.json 且至少 1 张现存图片）；`hasMore` 用一个额外有效记录判断，
 * 不改变 `items` 的元素结构。limit=0 时只判断 hasMore、不返回记录。
 *
 * @param {object} ctx 宿主上下文
 * @param {number|{ limit?: number, offset?: number }} [limitOrOptions]
 * @param {number} [maybeOffset] 旧签名可选的 offset
 * @returns {Promise<{ items: object[], hasMore: boolean }>}
 */
export async function scanHistory(ctx, limitOrOptions = LIMITS.history.defaultLimit, maybeOffset = 0) {
  const { limit, offset } = normalizeHistoryPage(limitOrOptions, maybeOffset)

  const root = outputRoot(ctx)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { items: [], hasMore: false }
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()

  const items = []
  const memo = { metas: new Map(), roots: new Map(), contexts: new Map() }
  let validSeen = 0
  let hasMore = false
  for (const name of dirs) {
    const item = await readHistoryItem(ctx, root, name, memo)
    if (!item) continue
    validSeen += 1
    // offset 按「有效记录」计数，跳过被删空或缺失 meta 的目录不会挤掉真实记录。
    if (validSeen <= offset) continue
    if (items.length >= limit) {
      hasMore = true
      break
    }
    items.push(item)
  }
  return { items, hasMore }
}

/** 版本树分页参数：默认取契约 `LIMITS.history.pageSize`（100），钳制到 1..maxLimit。 */
function normalizeTreeLimit(limit) {
  const number = Number(limit)
  if (!Number.isFinite(number)) return LIMITS.history.pageSize
  return Math.max(1, Math.min(LIMITS.history.maxLimit, Math.round(number)))
}

/**
 * 扫描全部有效历史记录（不早停），供 `/history/tree` 按根过滤。
 *
 * 与 scanHistory 共用 readHistoryItem 和同一份 meta / root 缓存，顺序也与 /history 完全一致
 * （目录名倒序 = 时间倒序）。版本树必须看到全部分页才能判断 hasMore，因此这里不做早停。
 */
async function listHistoryItems(ctx) {
  const root = outputRoot(ctx)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()

  const memo = { metas: new Map(), roots: new Map(), contexts: new Map() }
  const items = []
  for (const name of dirs) {
    const item = await readHistoryItem(ctx, root, name, memo)
    if (item) items.push(item)
  }
  return items
}

/**
 * 按根作品路径扫描整棵版本树（跨 /history 分页）。
 *
 * 命中规则（.tmp/plan/INTERFACES.md §3.3）：条目的任一图片路径等于 root，或条目记录的
 * `rootImage` 等于 root；根节点自身通过「图片路径等于 root」命中。结果与 /history 同形，
 * 按目录名倒序；`hasMore` 表示该树还有更早的条目（limit 上限见 LIMITS.history）。
 *
 * root 为空/越界的 400 由 HTTP 路由转成 `invalid_request`；这里只做归一与防御性校验。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ root?: string, limit?: number }} [options]
 * @returns {Promise<{ ok: true, root: string, items: object[], hasMore: boolean }
 *   | { ok: false, code: 'invalid_request', message: string }>}
 */
export async function scanHistoryTree(ctx, { root: requestedRoot, limit } = {}) {
  const root = outputImagePathOf(requestedRoot)
  if (!root) {
    return { ok: false, code: 'invalid_request', message: 'root 必须是 outputs/ 内的作品路径' }
  }
  const pageLimit = normalizeTreeLimit(limit)
  const treeItems = (await listHistoryItems(ctx)).filter(
    (item) => item.rootImage === root || item.images.some((image) => image.path === root),
  )
  return { ok: true, root, items: treeItems.slice(0, pageLimit), hasMore: treeItems.length > pageLimit }
}

