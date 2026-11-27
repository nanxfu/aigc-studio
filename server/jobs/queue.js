/**
 * 出图任务队列（协议见 docs/SPEC.md 第 2.2 节）。
 *
 * 远端是单张 GPU 的常驻进程，并发提交只会互相排队并放大 OOM 概率，
 * 因此 Host 侧固定串行：同一时刻最多一个 running job。
 *
 * 从 `lib/jobs.js` 拆出：本文件只放 `JobQueue` 状态机（入队、串行执行、取消、
 * 产物持久化、`waitFor` 长轮询通知）；参数校验在 `./validator.js`，
 * 错误归因在 `./errors.js`，参考图读取在 `./reference-loader.js`。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LIMITS, OUTPAINT, OUTPAINT_ENGINE, PROVIDER_IDS, TIMEOUTS, UPSCALE, WORKSHOP } from '../../shared/contract.js'
import { applyLoraTriggerPrompt, supportsStyleLora } from '../../shared/game-styles.js'
import { cloudPresetOfConfig, imageApiVendorOf } from '../../shared/image-providers.js'
import {
  workshopCloudProvider,
  workshopComputeProfileOf,
} from '../../shared/workshop-compute.js'
import { presetProvidersOf } from '../../shared/models-guide.js'
import { FULL_VARIANT_ID, resolveVariant } from '../../shared/variants.js'
import { generateCloudImage } from '../image-api.js'
import { createLogger } from '../log.js'
import { saveJobOutput } from '../output.js'
import { normalizeSaveTo, resolveOutputPath } from '../paths.js'
import { presetById } from '../presets.js'
import { isCloudApiProvider, providerMetaOf } from '../providers/index.js'
import { logText } from '../redact.js'
import { downloadArtifact, openEvents, submitGenerate, waitForJob } from '../remote.js'
import { generateCloudVideo as requestCloudVideo, nominalVideoSize, pickVideoRatio } from '../video-api.js'
import { JobCancelled, describeJobError, errorKind, isCancellation, isoNow } from './errors.js'
import { resolveReferenceImagesPayload, resolveReferencePayload } from './reference-loader.js'
import {
  WORKSHOP_TOOLS,
  clampInt,
  clampNumber,
  normalizeDimension,
  normalizeLoraRequest,
  normalizeReference,
  normalizeReferences,
  normalizeTool,
  normalizeUpscaleRequest,
  normalizeWorkshopOp,
} from './validator.js'

const log = createLogger({ scope: 'jobs' })

/** 测试替身可能没有 snapshot()：取状态失败时退化为 unknown，不影响任务路径。 */
function sessionStateOf(session) {
  try {
    return session?.snapshot?.()?.state ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const SESSION_STAGE = {
  provisioning: '排队中',
  connecting: '建立隧道',
  warming: '加载模型',
  ready: '生成中',
  stopping: '正在停止',
  error: '会话失败',
}

/** 任务终态：进入后所有等待者立即唤醒，不再继续等（cancelled 也是终态）。 */
const TERMINAL_STATUS = new Set(['done', 'failed', 'cancelled'])

/**
 * 会话仍在启动、还没有生成可用连接的状态。
 *
 * absent / stopping 也包含在内：取消可能发生在 start() 的异步清理刚结束、还没写回
 * provisioning 的窗口里，此时仍要作废这一轮启动，不能让进度条之后又冒出来。
 */
const STARTING_SESSION_STATES = new Set(['absent', 'stopping', 'provisioning', 'connecting', 'warming'])

/**
 * 该 tool 是否需要走「扩散预设能力门控」（providers 白名单 / 预设加载器）。
 *
 * upscale 与工坊 GPU 算子（remove-bg / pbr / depth / relight）都没有扩散预设语义：它们的 presetId 只是
 * 模型标识，`presetById()` 会回落到默认预设，用默认预设的 providers 去门控没有意义。
 */
function usesPresetTool(tool) {
  return tool !== 'upscale' && !WORKSHOP_TOOLS.includes(tool)
}

/**
 * 工坊算子的结果通道顺序（契约唯一来源，顺序即落盘/展示顺序）。
 *
 * - remove-bg：单通道 `cutout`（透明底主图）；
 * - pbr：`WORKSHOP.pbr.channels` 四通道；
 * - depth：`WORKSHOP.depth.channels`（depth / normal）；
 * - relight：`relit` 单通道。
 */
export function workshopChannelOrderOf(tool) {
  if (tool === WORKSHOP.cutout.op) return ['cutout']
  if (tool === WORKSHOP.pbr.op) {
    const channels = Array.isArray(WORKSHOP.pbr.channels) ? WORKSHOP.pbr.channels : []
    // 契约缺 channels 时用同值兜底（正常不会走到：WORKSHOP.pbr.channels 是必填常量）。
    return channels.length > 0 ? [...channels] : ['albedo', 'normal', 'roughness', 'metallic']
  }
  if (tool === WORKSHOP.depth.op) {
    const channels = Array.isArray(WORKSHOP.depth.channels) ? WORKSHOP.depth.channels : []
    return channels.length > 0 ? [...channels] : ['depth', 'normal']
  }
  if (tool === WORKSHOP.relight.op) return ['relit']
  return []
}

/**
 * 归一工坊算子的远端 results：校验数量 / 通道，并按契约顺序重排后透传 `channel`。
 *
 * 为什么在队列里做而不是落盘侧：落盘（server/output.js）只负责按 `result.channel` 命名
 * `<role>.png` 与登记 meta.channels[]，通道语义（几张、什么顺序、缺了算不算失败）属于
 * 协议层。inline 模式 results 直接带 channel；binary 模式 daemon 的元数据里若省略了
 * channel，则按 artifact 列表顺序映射回契约顺序（索引即通道）。
 *
 * @param {unknown} results 远端 results 数组（inline 带 image_b64 / binary 带 sha256+tempPath）
 * @param {string} tool 'remove-bg' | 'pbr'
 * @returns {Array<object>} 按契约通道顺序排列、且每项带 `channel` 的结果数组
 */
export function normalizeWorkshopResults(results, tool) {
  const list = Array.isArray(results) ? results.filter((item) => item && typeof item === 'object') : []
  const expected = workshopChannelOrderOf(tool)
  if (expected.length === 0) {
    throw Object.assign(new Error(`不支持工坊结果归一的 tool：${tool}`), { code: 'invalid_request' })
  }
  if (list.length === 0) {
    throw Object.assign(new Error('远端没有返回图片'), { code: 'empty_result' })
  }
  if (list.length !== expected.length) {
    throw Object.assign(
      new Error(`工坊算子返回 ${list.length} 张结果，契约要求 ${expected.length} 张（${expected.join(' / ')}）`),
      { code: 'generation_failed' },
    )
  }
  const byChannel = new Map()
  list.forEach((item, index) => {
    const declared = typeof item.channel === 'string' ? item.channel.trim() : ''
    const channel = declared || expected[index]
    if (!expected.includes(channel)) {
      throw Object.assign(
        new Error(`远端返回未知通道 ${channel}（契约通道：${expected.join(' / ')}）`),
        { code: 'generation_failed' },
      )
    }
    if (byChannel.has(channel)) {
      throw Object.assign(new Error(`远端返回重复通道 ${channel}`), { code: 'generation_failed' })
    }
    byChannel.set(channel, { ...item, channel })
  })
  const missing = expected.filter((channel) => !byChannel.has(channel))
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`远端缺少通道：${missing.join(' / ')}（契约要求 ${expected.join(' / ')}）`),
      { code: 'generation_failed' },
    )
  }
  return expected.map((channel) => byChannel.get(channel))
}

/**
 * 算力来源门控（Host 兜底）。
 *
 * 模型资产可选 `providers`（如 `flux2-klein-9b` 仅 `colab`）：当前来源不在列表里时返回拒绝载荷，
 * 否则返回 `null` 放行。纯函数，便于离线测试；`submit` 与 Agent 工具路径共用同一口径。
 *
 * @param {object|null} preset 预设对象（可含 `providers` / `id` / `label`）
 * @param {unknown} provider 当前算力来源 id
 * @returns {null | { ok: false, code: 'invalid_request', message: string }}
 */
export function providerGateOf(preset, provider, { localGpuPresets = [] } = {}) {
  if (!preset || typeof preset !== 'object' || typeof provider !== 'string') return null
  // 与模型卡 / 生成预检共用 `presetProvidersOf` 的缺省语义：本地 diffusion 模型
  // 只属于 Kaggle / Colab / 私有 Worker / 本机 GPU，商业生图 API 必须显式声明。
  if (provider === 'local-gpu' && Array.isArray(localGpuPresets) && localGpuPresets.includes(preset.id)) {
    return null
  }
  const required = presetProvidersOf(preset)
  if (required.includes(provider)) return null
  return {
    ok: false,
    code: 'invalid_request',
    message:
      `「${preset.label ?? preset.id}」只能运行在 ${required.join(' / ')} 上，` +
      `当前算力来源是 ${provider}；请切换算力来源或改用其他模型`,
  }
}

export class JobQueue {
  constructor({ ctx, session, defaultPreset, options = {} }) {
    this.ctx = ctx
    this.session = session
    this.defaultPreset = defaultPreset
    this.options = {
      sessionWaitMs: TIMEOUTS.sessionWaitMs,
      generateTimeoutMs: TIMEOUTS.remoteJobMs,
      // 取消感知等待的轮询间隔：生产 1s；测试可调小以加速离线回归。
      sessionPollMs: 1000,
      ...options,
    }
    // 商业生图 API 的连接配置 getter（app-config 注入）；缺省表示未配置。
    if (typeof this.options.getImageApiConfig !== 'function') this.options.getImageApiConfig = () => null
    this.jobs = []
    this.pending = []
    this.running = null
    this.disposed = false
    this.abortController = new AbortController()
    // 取消最后一个等待启动的任务后，后台回收自动拉起的会话；后续任务必须等它
    // 收尾后再启动，避免新旧两轮实例的 teardown / start 交叉。
    this.releasingAutoSession = null
    // waitFor 的等待者：jobId → Set<唤醒函数>。注册在任务进入终态前完成，
    // 唤醒由 runNext 的收尾路径与 dispose() 统一触发（不再按固定间隔轮询）。
    this.waiters = new Map()
  }

  // ---- 读取 ---------------------------------------------------------------

  list(limit = 20) {
    return this.jobs.slice(-limit).reverse().map((job) => this.publicView(job))
  }

  get(id) {
    const job = this.jobs.find((item) => item.id === id)
    return job ? this.publicView(job) : null
  }

  get lastFinished() {
    for (let index = this.jobs.length - 1; index >= 0; index -= 1) {
      const job = this.jobs[index]
      if (TERMINAL_STATUS.has(job.status)) return this.publicView(job)
    }
    return null
  }

  queueStats() {
    return { running: this.running?.id ?? null, pending: this.pending.length }
  }

  /**
   * 结构化阶段标识（稳定英文，客户端按它选本地化文案，不再解析中文 `stage`）。
   *
   * 取值域：queued / waiting-session / loading / running / done / failed / cancelled。
   * `loading` 专指会话已就绪但远端仍在加载模型（`sessionState === 'warming'`），
   * 与「等 Kernel 排队」区分开，英文界面才能分别显示等待与加载。
   */
  stageCodeOf(job) {
    if (job.status === 'running' && job.localStage === 'loading') return 'loading'
    if (job.status === 'waiting-session') {
      return job.sessionState === 'warming' ? 'loading' : 'waiting-session'
    }
    if (job.status === 'running' || job.status === 'done' || job.status === 'failed') return job.status
    if (job.status === 'cancelled') return 'cancelled'
    return 'queued'
  }

  /**
   * 结构化分张进度：只在 running 时给 `{ done, total }`，其他状态为 null。
   *
   * `done` 是「已完成的张数」（0 起）。旧的 `stage` 文本用 `done + 1` 表示「正在出第
   * 几张」，语义不同且要向后兼容，所以 stage 保持原样，客户端用本字段做精确进度。
   */
  progressOf(job) {
    if (job.status !== 'running') return null
    const total = Math.max(1, Math.round(Number(job.progress?.total ?? job.params?.count) || 1))
    const done = Math.round(Number(job.progress?.done) || 0)
    return { done: Math.min(total, Math.max(0, done)), total }
  }

  /**
   * 记录本次任务真正使用的算力来源与设备（进入 meta.json，供画廊 / 舞台展示）。
   * 字段只做展示与溯源，不参与调度；旧快照缺 provider 时写 null，客户端按未知处理。
   */
  captureProvenance(job, { cloud = false } = {}) {
    if (cloud) {
      const cloudPreset = cloudPresetOfConfig(this.imageApiConfig(), job.presetId)
      job.provider = 'cloud-api'
      job.device = cloudPreset?.cloud?.vendor ?? null
      job.deviceCount = null
      return
    }
    const snapshot = this.session.snapshot()
    const provider = snapshot && snapshot.provider
    // 来源按契约登记表归一（含私有 Worker / 本机 GPU）：只做展示与溯源，不参与调度。
    job.provider = PROVIDER_IDS.includes(provider) ? provider : null
    job.device = snapshot && typeof snapshot.device === 'string' && snapshot.device.trim()
      ? snapshot.device.trim()
      : null
    job.deviceCount = Number.isFinite(snapshot?.deviceCount) ? snapshot.deviceCount : null
  }

  publicView(job) {
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      stageCode: this.stageCodeOf(job),
      // 请求类型（generate / upscale / outpaint）：客户端幽灵节点与版本树按它决定展示与归组；
      // 缺省 generate，旧任务与旧客户端读不到该字段时行为不变。
      tool: job.tool ?? 'generate',
      // 产物媒体类型（M4.1）：视频任务在排队卡 / 舞台按视频呈现；旧任务缺省 image。
      mediaType: job.mediaType === 'video' ? 'video' : 'image',
      progress: this.progressOf(job),
      presetId: job.presetId,
      // 本次任务实际运行的算力来源与设备：排队卡 / 舞台进度可据此显示「Colab · L4」。
      provider: job.provider ?? null,
      device: job.device ?? null,
      deviceCount: job.deviceCount ?? null,
      // 精度档：旧任务没有该字段时为 null；新任务在排队卡 / 产物角标显示实际精度。
      variantId: job.variantId ?? null,
      precision: job.precision ?? null,
      downloadGb: job.downloadGb ?? null,
      quantizationScheme: job.quantizationScheme ?? null,
      params: { ...job.params },
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      seconds: job.seconds,
      sessionState: job.sessionState,
      modelId: job.modelId ?? null,
      output: job.output ?? null,
      error: job.error ? { ...job.error } : null,
      // 「是否还有未收敛的取消请求」：running 合作式停止期间为 true；
      // 终态（done / failed / cancelled）与未取消一律 false（字段始终存在，客户端不必猜）。
      // 内部 job.cancelRequested 保留到收尾完成，供等待循环/逐张循环尽早退出。
      cancelRequested: job.cancelRequested === true && !TERMINAL_STATUS.has(job.status),
    }
  }

  // ---- 提交 ---------------------------------------------------------------

  /**
   * 校验并排队。
   *
   * 阶段十五 Phase B 起按 `tool` 分派三类请求（缺省 generate，旧客户端零影响）：
   *  - generate：文生图 / 图生图 / 局部重绘，与拆分前逐字一致；
   *  - upscale：高清放大，跳过扩散预设，固定 1 张，只收一张源图（无蒙版）；
   *  - outpaint：扩图，与 generate 同路径，额外记录客户端给的来源图 `sourcePath`。
   *
   * @param {object} request 见 docs/SPEC.md 第 2.2 节
   * @returns {{ ok: true, job: object } | { ok: false, code: string, message: string }}
   */
  submit(request = {}, meta = {}) {
    const jobSource = meta?.source === 'mcp' ? 'mcp' : 'studio'
    const toolResult = normalizeTool(request.tool)
    if (!toolResult.ok) {
      log.info(`enqueue_rejected code=${toolResult.code} tool=invalid pending=${this.pending.length}`)
      return toolResult
    }
    const tool = toolResult.tool

    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    // 只有文生图要求提示词：高清放大没有提示词语义；扩图的提示词由客户端始终携带，
    // 但 Host 不把它当成硬门槛（远端 inpaint 只要求非空 prompt，空串会由远端拒绝）。
    if (tool === 'generate' && prompt.length === 0) {
      log.info(`enqueue_rejected code=invalid_prompt promptLen=0 tool=${tool} pending=${this.pending.length}`)
      return { ok: false, code: 'invalid_prompt', message: 'prompt 不能为空' }
    }
    if (prompt.length > LIMITS.prompt.maxChars) {
      log.info(
        `enqueue_rejected code=invalid_prompt promptLen=${prompt.length} tool=${tool} pending=${this.pending.length}`,
      )
      return { ok: false, code: 'invalid_prompt', message: `prompt 超过 ${LIMITS.prompt.maxChars} 字符` }
    }
    if (this.pending.length >= LIMITS.queue.maxPending) {
      log.info(
        `enqueue_rejected code=queue_full promptLen=${prompt.length} tool=${tool} pending=${this.pending.length}`,
      )
      return { ok: false, code: 'queue_full', message: '队列已满，请等待当前任务完成' }
    }

    // saveTo 的格式校验放在入队前（同步纯函数）：非法路径不占队列位置，
    // 调用方立刻拿到 invalid_path；符号链接逃逸检查留给落盘时的真实路径校验。
    let saveTo = null
    if (request.saveTo !== undefined && request.saveTo !== null && request.saveTo !== '') {
      const normalizedSaveTo = normalizeSaveTo(request.saveTo)
      if (!normalizedSaveTo.ok) {
        log.info(
          `enqueue_rejected code=invalid_path saveToLen=${String(request.saveTo).length} pending=${this.pending.length}`,
        )
        return normalizedSaveTo
      }
      saveTo = normalizedSaveTo.relative
    }

    const hostProvider =
      typeof this.options.getProvider === 'function' ? this.options.getProvider() : this.options.provider

    // ---- 商业 API（M3.5 生图 / M4.1 视频）----
    // 直达厂商端点：生图不接受蒙版 / 超分；ModelScope 的 FLUX.2 Klein 支持受控的
    // 绿边画布扩图，视频接受参考图槽位映射首帧 / 尾帧。能力不支持时在入队阶段就给出
    // 可执行提示（而不是提交后才 400，也不静默丢参数）。
    const workshopRequested = WORKSHOP_TOOLS.includes(tool)
    const localWorkshopRequested = workshopRequested && request.execution === 'local'
    const cloudWorkshopRequested = workshopRequested && request.execution !== 'local'
    const localWorkshopEngine = this.options.localWorkshop
      ?? (tool === WORKSHOP.pbr.op ? this.options.localPbr : null)
    if (localWorkshopRequested && typeof localWorkshopEngine?.run !== 'function') {
      return { ok: false, code: 'invalid_request', message: '本机 CUDA 执行器不可用，请切换云端。' }
    }
    if (isCloudApiProvider(hostProvider) && !localWorkshopRequested && !cloudWorkshopRequested) {
      if (tool !== 'generate' && tool !== 'outpaint') {
        return {
          ok: false,
          code: 'image_api_unsupported',
          message: '商业 API 目前只支持文生图 / 参考图编辑 / ModelScope 扩图 / 文生视频：高清放大请使用本机端侧或切换到 Kaggle / 私有 Worker',
        }
      }
      const config = this.imageApiConfig()
      const cloudPreset = cloudPresetOfConfig(config, request.presetId)
      if (!cloudPreset) {
        return {
          ok: false,
          code: 'image_api_not_configured',
          message: '尚未配置商业 API 模型：请先在设置中配置服务商或自定义模型后再试',
        }
      }
      const vendorCall = this.resolveCloudVendorCall(config, cloudPreset)
      if (!vendorCall.apiKey) {
        return {
          ok: false,
          code: 'image_api_not_configured',
          message: `尚未填写 ${vendorCall.vendorLabel} 的 API Key：请到 设置 → 云端算力 → 商业 API 配置后再试`,
        }
      }
      const seedInput = Number(request.seed)
      const cloudSeed =
        Number.isFinite(seedInput) && seedInput >= 0
          ? Math.round(seedInput) % LIMITS.seed.max
          : Math.floor(Math.random() * LIMITS.seed.max)

      // ---- 视频（M4.1）----
      if (cloudPreset.mediaType === 'video') {
        if (tool === 'outpaint') {
          return {
            ok: false,
            code: 'image_api_unsupported',
            message: '视频模型不支持扩图：请切换到支持扩图的图像模型',
          }
        }
        if (request.reference !== undefined && request.reference !== null && request.reference !== '') {
          return {
            ok: false,
            code: 'video_api_unsupported',
            message: '视频生成请用参考图槽位（首帧 / 尾帧），不支持单图垫图与重绘蒙版',
          }
        }
        const referencesResult = normalizeReferences(request.references)
        if (!referencesResult.ok) {
          log.info(
            `enqueue_rejected code=${referencesResult.code} tool=video presetId=${cloudPreset.id} pending=${this.pending.length}`,
          )
          return referencesResult
        }
        const references = referencesResult.value || []
        const video = cloudPreset.video || {}
        const maxReferences = Math.max(0, Number(video.maxReferences) || 0)
        if (references.length > maxReferences) {
          return {
            ok: false,
            code: 'video_api_unsupported',
            message:
              maxReferences === 0
                ? '该视频模型不支持参考图：请改用支持首帧的模型，或移除参考图后做文生视频'
                : `该视频模型最多 ${maxReferences} 张参考图（首帧 / 尾帧），当前提交了 ${references.length} 张`,
          }
        }
        if (video.supportsFirstFrame !== true && references.length > 0) {
          return {
            ok: false,
            code: 'video_api_unsupported',
            message: '该视频模型只支持文生视频：请移除参考图，或改用支持首帧的模型',
          }
        }
        const resolution = Array.isArray(video.resolutions) && video.resolutions.length > 0
          ? video.resolutions.includes(request.resolution)
            ? request.resolution
            : video.defaultResolution || video.resolutions[0]
          : null
        const requestedRatio =
          typeof request.ratio === 'string' && Array.isArray(video.ratios) && video.ratios.includes(request.ratio)
            ? request.ratio
            : ''
        const ratio = requestedRatio || pickVideoRatio(video.ratios, request.width, request.height, video.defaultRatio)
        const size = nominalVideoSize(ratio, resolution || '768p')
        const duration = video.supportsDuration && video.duration
          ? clampInt(request.duration, video.duration.min, video.duration.max, video.duration.default)
          : null
        // 交付路径按视频补 .mp4：入队前的通用归一默认补 .png，这里按媒体类型重算一次。
        let videoSaveTo = saveTo
        if (request.saveTo !== undefined && request.saveTo !== null && request.saveTo !== '') {
          const normalizedVideoSaveTo = normalizeSaveTo(request.saveTo, { defaultExtension: 'mp4' })
          if (!normalizedVideoSaveTo.ok) return normalizedVideoSaveTo
          videoSaveTo = normalizedVideoSaveTo.relative
        }
        const videoParams = {
          prompt,
          negativePrompt: cloudPreset.supportsNegative
            ? typeof request.negativePrompt === 'string'
              ? request.negativePrompt.trim().slice(0, LIMITS.negativePrompt.maxChars)
              : ''
            : '',
          width: size.width,
          height: size.height,
          steps: 0,
          cfg: 0,
          seed: cloudSeed,
          count: 1,
          duration,
          resolution,
          ratio,
        }
        const videoJob = {
          id: `j_${randomBytes(4).toString('hex')}`,
          tool: 'generate',
          mediaType: 'video',
          status: 'queued',
          stage: '排队中',
          presetId: cloudPreset.id,
          params: videoParams,
          reference: null,
          references: references.length > 0 ? [...references] : null,
          saveTo: videoSaveTo,
          createdAt: isoNow(),
          startedAt: null,
          finishedAt: null,
          seconds: null,
          sessionState: this.session.snapshot().state,
          modelId: cloudPreset.repo,
          output: null,
          error: null,
          autoStart: request.autoStart !== false,
        }
        this.jobs.push(videoJob)
        this.pending.push(videoJob)
        this.trim()
        log.info(
          `enqueue jobId=${videoJob.id} tool=video provider=cloud-api presetId=${cloudPreset.id} ` +
            `size=${videoParams.width}x${videoParams.height} duration=${videoParams.duration ?? 'fixed'} ` +
            `resolution=${videoParams.resolution} refs=${references.length} promptLen=${prompt.length} ` +
            `pending=${this.pending.length}`,
        )
        void this.runNext()
        return { ok: true, job: this.publicView(videoJob) }
      }

      // ---- 生图（M3.5 Phase A + 魔搭 Base64 参考图编辑 / 扩图）----
      const wantsReference =
        request.reference !== undefined && request.reference !== null && request.reference !== ''
      let cloudReference = null
      if (tool === 'outpaint') {
        if (Array.isArray(request.references) && request.references.length > 0) {
          return {
            ok: false,
            code: 'invalid_request',
            message: '扩图使用 reference.image 合成画布，不能再叠加 references 参考图列表',
          }
        }
        if (cloudPreset.cloud.supportsOutpaint !== true || !cloudPreset.cloud.outpaint) {
          return {
            ok: false,
            code: 'image_api_unsupported',
            message: `${cloudPreset.label || '当前云端模型'} 不支持在线扩图：请切换到 ModelScope · FLUX.2 Klein 4B 或开源自部署模型`,
          }
        }
        if (!wantsReference) {
          return {
            ok: false,
            code: 'invalid_request',
            message: '扩图需要前端合成的绿边画布（reference.image）',
          }
        }
        const referenceResult = normalizeReference(request.reference)
        if (!referenceResult.ok || !referenceResult.value?.imageB64) {
          return referenceResult.ok
            ? { ok: false, code: 'invalid_request', message: '扩图画布必须是 base64 图片（reference.image）' }
            : referenceResult
        }
        cloudReference = referenceResult.value
        if (cloudReference.maskB64) {
          return {
            ok: false,
            code: 'image_api_unsupported',
            message: 'ModelScope 在线扩图不支持像素级蒙版：请使用绿边画布扩图，画笔重绘请切换到 GPU Worker',
          }
        }
        if (!cloudReference.sourcePath) {
          return {
            ok: false,
            code: 'invalid_request',
            message: '扩图需要 sourcePath 记录来源作品，版本树才能正确归组',
          }
        }
      } else if (wantsReference) {
        return {
          ok: false,
          code: 'image_api_unsupported',
          message: '云端 API 不支持单图垫图强度与局部重绘蒙版：请切换到开源自部署模型',
        }
      }
      const wantsReferences = Array.isArray(request.references) && request.references.length > 0
      let cloudReferences = null
      if (wantsReferences) {
        if (cloudPreset.supportsReference !== true) {
          return {
            ok: false,
            code: 'image_api_unsupported',
            message: `${cloudPreset.label || '当前云端模型'} 只支持纯文生图：参考图编辑请改选支持参考图的模型或开源自部署`,
          }
        }
        const referencesResult = normalizeReferences(request.references)
        if (!referencesResult.ok) {
          log.info(
            `enqueue_rejected code=${referencesResult.code} tool=generate presetId=${cloudPreset.id} pending=${this.pending.length}`,
          )
          return referencesResult
        }
        cloudReferences = referencesResult.value
      }
      const capabilities = cloudPreset.cloud
      const isOutpaint = tool === 'outpaint'
      const outpaintWidth = isOutpaint
        ? normalizeDimension(request.width, cloudPreset.size, {
            min: OUTPAINT.minEdge,
            max: OUTPAINT.maxEdge,
            step: LIMITS.width.step,
          })
        : normalizeDimension(request.width, cloudPreset.size, LIMITS.width)
      const outpaintHeight = isOutpaint
        ? normalizeDimension(request.height, cloudPreset.size, {
            min: OUTPAINT.minEdge,
            max: OUTPAINT.maxEdge,
            step: LIMITS.height.step,
          })
        : normalizeDimension(request.height, cloudPreset.size, LIMITS.height)
      if (isOutpaint && outpaintWidth * outpaintHeight > OUTPAINT.maxPixels) {
        return {
          ok: false,
          code: 'invalid_request',
          message: `扩图画布超过 ${OUTPAINT.maxPixels} 像素上限（${outpaintWidth}×${outpaintHeight}）`,
        }
      }
      const triggerPrompt = OUTPAINT_ENGINE.prompt
      const cloudPrompt = isOutpaint
        ? (prompt ? `${triggerPrompt}, ${prompt}` : triggerPrompt).slice(0, LIMITS.prompt.maxChars)
        : prompt
      const cloudParams = {
        prompt: cloudPrompt,
        // 不支持负向词的模型显式记空串：meta 与界面都不展示一份从未生效的参数。
        negativePrompt: capabilities.supportsNegative
          ? typeof request.negativePrompt === 'string'
            ? request.negativePrompt.trim().slice(0, LIMITS.negativePrompt.maxChars)
            : ''
          : '',
        width: outpaintWidth,
        height: outpaintHeight,
        steps: !isOutpaint && capabilities.supportsSteps
          ? clampInt(request.steps, LIMITS.steps.min, LIMITS.steps.max, cloudPreset.steps)
          : 0,
        cfg: !isOutpaint && capabilities.supportsGuidance
          ? clampNumber(request.cfg, LIMITS.cfg.min, LIMITS.cfg.max, cloudPreset.cfg)
          : 0,
        seed: cloudSeed,
        count: isOutpaint ? 1 : clampInt(request.count, LIMITS.count.min, cloudPreset.cloud.maxCount, LIMITS.count.min),
      }
      if (isOutpaint) {
        cloudParams.reference = {
          sourcePath: cloudReference.sourcePath,
          ...(cloudReference.outpaintContent ? { outpaintContent: cloudReference.outpaintContent } : {}),
        }
      }
      const cloudJob = {
        id: `j_${randomBytes(4).toString('hex')}`,
        tool: isOutpaint ? 'outpaint' : 'generate',
        mediaType: 'image',
        status: 'queued',
        stage: '排队中',
        presetId: cloudPreset.id,
        params: cloudParams,
        reference: cloudReference,
        references: cloudReferences,
        saveTo,
        createdAt: isoNow(),
        startedAt: null,
        finishedAt: null,
        seconds: null,
        sessionState: this.session.snapshot().state,
        modelId: cloudPreset.repo,
        output: null,
        error: null,
        autoStart: request.autoStart !== false,
      }
      this.jobs.push(cloudJob)
      this.pending.push(cloudJob)
      this.trim()
      log.info(
        `enqueue jobId=${cloudJob.id} tool=${cloudJob.tool} provider=cloud-api presetId=${cloudPreset.id} ` +
          `size=${cloudParams.width}x${cloudParams.height} steps=${cloudParams.steps} count=${cloudParams.count} ` +
          `promptLen=${prompt.length} pending=${this.pending.length}`,
      )
      void this.runNext()
      return { ok: true, job: this.publicView(cloudJob) }
    }

    // ---- 资产工坊 GPU 后处理（M4.2a / M4.2b：tool = remove-bg / pbr）----
    //
    // 与高清放大同构：固定 1 张、无 prompt / 预设 / 蒙版语义，只把「源图 + 工坊模型」交给
    // 远端 daemon。区别是 job 额外携带 workshopModel / workshopSteps，远端载荷里再带一份
    // `workshop: { model, steps }`（daemon 侧的模型白名单与步数钳制用它）。
    // 云 API 没有工坊算子：上面的 isCloudApiProvider 分支会以 image_api_unsupported 拒绝。
    if (WORKSHOP_TOOLS.includes(tool)) {
      const workshop = normalizeWorkshopOp({ ...request, tool })
      if (!workshop.ok) {
        log.info(
          `enqueue_rejected code=${workshop.code} tool=${tool} pending=${this.pending.length}`,
        )
        return workshop
      }
      if (localWorkshopRequested) {
        const profileInfo = workshopComputeProfileOf(tool, workshop.model)
        if (!profileInfo || profileInfo.tier !== 'hybrid-cuda') {
          return {
            ok: false,
            code: 'invalid_request',
            message: `工坊模型 ${workshop.model} 不支持本机 CUDA 执行，请切换云端。`,
          }
        }
      }
      const workshopReference = workshop.reference
      // 公开视图只暴露源图出处（工作区相对路径），不暴露任何二进制。
      const workshopParams = {
        prompt: workshop.options?.prompt || '',
        negativePrompt: '',
        width: workshop.width,
        height: workshop.height,
        // pbr 的采样步数（remove-bg 无采样语义，固定 0）；与远端载荷 workshop.steps 同值。
        steps: workshop.steps ?? 0,
        cfg: workshop.options?.cfg ?? 0,
        seed: workshop.options?.seed ?? 0,
        count: 1,
        // 与高清放大同形：sourcePath 用于产物 meta 的版本树溯源（工坊产物挂在源作品下）。
        reference: {
          sourcePath: workshopReference.path,
        },
      }
      const workshopJob = {
        id: `j_${randomBytes(4).toString('hex')}`,
        tool,
        status: 'queued',
        stage: '排队中',
        // 工坊模型 id 不是扩散预设：presetById 会回落到默认预设（与 upscale 的处理一致），
        // meta.presetId 记录工坊模型 id，供历史回看知道用了哪个算子模型。
        presetId: workshop.model,
        params: workshopParams,
        // 内部源图（可能带 base64）：与 upscale 的 reference 同形，执行阶段由
        // resolveReferencePayload 统一读盘 / 校验体积与魔数。
        reference: {
          path: workshopReference.path,
          imageB64: workshopReference.imageB64,
          strength: 1,
        },
        references: null,
        // 工坊算子的模型与步数：远端载荷构造与执行分支（generate）都读这两个内部字段。
        workshopModel: workshop.model,
        workshopSteps: workshop.steps,
        workshopOptions: workshop.options,
        execution: localWorkshopRequested ? 'local' : 'cloud',
        workshopProvider: localWorkshopRequested ? null : workshopCloudProvider(hostProvider),
        saveTo,
        createdAt: isoNow(),
        startedAt: null,
        finishedAt: null,
        seconds: null,
        sessionState: this.session.snapshot().state,
        modelId: workshop.modelRepo,
        output: null,
        error: null,
        source: jobSource,
        autoStart: request.autoStart !== false,
      }
      this.jobs.push(workshopJob)
      this.pending.push(workshopJob)
      this.trim()
      log.info(
        `enqueue jobId=${workshopJob.id} tool=${tool} model=${workshop.model} ` +
          `steps=${workshop.steps ?? 0} count=1 pending=${this.pending.length}`,
      )
      void this.runNext()
      return { ok: true, job: this.publicView(workshopJob) }
    }

    // 参考图 / 源图预检：三类 tool 的规则不同，但都在入队前做（非法值不占队列位置），
    // 真正的文件读取与 base64 化留到执行阶段（画廊路径必须先通过 resolveOutputPath 的越界校验）。
    //
    // 原生参考生图（Phase C1）与单图垫图是两条互斥路径：`references` 只用于 generate，
    // 与 `reference` 同时出现直接 400（不挑一条静默忽略，避免用户以为用上了另一条）。
    const referencesResult = normalizeReferences(request.references)
    if (!referencesResult.ok) {
      log.info(
        `enqueue_rejected code=${referencesResult.code} tool=${tool} references=invalid pending=${this.pending.length}`,
      )
      return referencesResult
    }
    const references = referencesResult.value
    const hasReferenceField =
      request.reference !== undefined && request.reference !== null && request.reference !== ''
    if (references && hasReferenceField) {
      log.info(
        `enqueue_rejected code=invalid_request tool=${tool} references=mixed pending=${this.pending.length}`,
      )
      return {
        ok: false,
        code: 'invalid_request',
        message:
          'references（模型原生参考图列表）与 reference（单图垫图 / 局部重绘）不能同时使用：二者是两条互斥路径',
      }
    }
    if (references && tool !== 'generate') {
      log.info(
        `enqueue_rejected code=invalid_request tool=${tool} references=unsupported_tool pending=${this.pending.length}`,
      )
      return {
        ok: false,
        code: 'invalid_request',
        message: `references（模型原生参考图）只支持普通出图（tool=generate），当前 tool=${tool}`,
      }
    }

    let reference = null
    let upscaleExtent = { width: null, height: null }
    if (tool === 'upscale') {
      // 放大只接受一张源图（path 或 image），不接受蒙版；宽高按 UPSCALE.maxInputEdge 预检。
      const upscaleResult = normalizeUpscaleRequest(request)
      if (!upscaleResult.ok) {
        log.info(`enqueue_rejected code=${upscaleResult.code} tool=upscale pending=${this.pending.length}`)
        return upscaleResult
      }
      reference = upscaleResult.reference
      upscaleExtent = { width: upscaleResult.width, height: upscaleResult.height }
    } else {
      const referenceResult = normalizeReference(request.reference)
      if (!referenceResult.ok) {
        log.info(
          `enqueue_rejected code=${referenceResult.code} tool=${tool} img2img=1 pending=${this.pending.length}`,
        )
        return referenceResult
      }
      reference = referenceResult.value
    }

    // 高清放大不走扩散预设：presetId / modelId 固定记超分模型标识（不进模型选择器）。
    const preset = tool === 'upscale' ? null : presetById(request.presetId ?? this.defaultPreset)
    // 算力来源能力位（模型资产可选 `providers`，如 9B 仅 Colab）：客户端模型卡与生成预检已先拦一次，
    // 这里补 Host 侧兜底——Agent 工具、旧客户端或直连 API 都不能绕过它，把注定 OOM 的任务送进远端。
    const localGpuPresets = typeof this.options.getLocalGpuPresets === 'function'
      ? this.options.getLocalGpuPresets()
      : []
    const providerGate = providerGateOf(preset, hostProvider, { localGpuPresets })
    if (providerGate) {
      log.info(
        `enqueue_rejected code=${providerGate.code} presetId=${preset.id} provider=${hostProvider} ` +
          `required=${(preset.providers ?? []).join('|')} pending=${this.pending.length}`,
      )
      return providerGate
    }
    // 精度档解析（Q-03）：显式 variantId 必须精确命中；`auto` 才按 provider 自动选；
    // 完全不传保持旧客户端满血行为。未知 / 当前来源不可用的档位在这里直接拒绝，
    // 不创建会话、不下载任何权重。
    const variant = preset ? resolveVariant(preset, request.variantId, hostProvider) : null
    if (variant && variant.ok === false) {
      log.info(
        `enqueue_rejected code=${variant.code} presetId=${preset?.id ?? 'none'} provider=${hostProvider} ` +
          `variant=${String(request.variantId ?? '')} pending=${this.pending.length}`,
      )
      return variant
    }
    // 只有请求显式带 variantId（auto / full / 具体 id）才把精度写进产物；
    // 旧客户端完全不传时只按满血执行，不改变既有 meta / 画廊形状。
    const variantRecorded = typeof request.variantId === 'string' && request.variantId.trim() !== ''
    // 原生参考生图能力：模型资产 `supportsReference` 是客户端与 Host 共用的能力位；
    // daemon 侧还有一层 loader 白名单兜底（不信任客户端标记）。
    if (references && preset?.supportsReference !== true) {
      log.info(
        `enqueue_rejected code=invalid_request presetId=${preset?.id ?? 'none'} references=unsupported_model pending=${this.pending.length}`,
      )
      return {
        ok: false,
        code: 'invalid_request',
        message: '该模型不支持参考生图：请切换到支持原生参考图的模型（如 FLUX.2 Klein 4B）',
      }
    }
    // 专用 inpaint 权重（inpaintOnly）只能带蒙版使用：缺参考图或蒙版时直接拒，
    // 不占用队列与 GPU（daemon 侧还有一层同等语义的兜底）。
    if (preset && preset.inpaintOnly === true && !(reference && reference.maskB64)) {
      log.info(
        `enqueue_rejected code=invalid_request inpaint_only=1 hasReference=${reference ? 1 : 0} pending=${this.pending.length}`,
      )
      return {
        ok: false,
        code: 'invalid_request',
        message: '该模型只支持局部重绘：请先以此图重绘并涂抹蒙版',
      }
    }
    // 现代扩图（FLUX.2 Klein 4B + Outpaint LoRA，无蒙版绿边画布）走 referenceImages 通道，
    // 提交期提前按 referenceImages.maxBytes（4 MiB）卡一次，防止超大绿边画布打到远端才 400。
    const isModernOutpaint =
      tool === 'outpaint'
      && preset?.id === OUTPAINT_ENGINE.presetId
      && Boolean(reference?.imageB64)
      && !reference?.maskB64
    if (isModernOutpaint && Buffer.from(reference.imageB64, 'base64').length > LIMITS.referenceImages.maxBytes) {
      const limitMb = Math.round((LIMITS.referenceImages.maxBytes / 1024 / 1024) * 10) / 10
      return {
        ok: false,
        code: 'invalid_request',
        message: `扩图画布超过 ${limitMb} MB 上限，请调小画幅后重试`,
      }
    }
    if (hostProvider === 'local-gpu' && tool === 'upscale') {
      log.info(`enqueue_rejected code=capability_missing tool=upscale provider=local-gpu pending=${this.pending.length}`)
      return {
        ok: false,
        code: 'capability_missing',
        message: '本机 GPU 引擎暂不支持远端高清放大：请改用端侧放大，或切换到云端算力来源',
      }
    }
    // 本机 GPU（stable-diffusion.cpp）只有垫图（`init_image`）与蒙版重绘（`mask_image`）：
    // 原生参考图与绿画布扩图都会走到 `ref_images`，引擎侧不支持。在入队阶段拒绝，
    // 避免拉起本机进程、加载权重之后才失败。
    if (hostProvider === 'local-gpu' && (references || isModernOutpaint)) {
      log.info(
        `enqueue_rejected code=capability_missing tool=${tool} provider=local-gpu ` +
          `references=${references ? 'native' : 'none'} modernOutpaint=${isModernOutpaint ? 1 : 0} pending=${this.pending.length}`,
      )
      return {
        ok: false,
        code: 'capability_missing',
        message:
          '本机 GPU 暂不支持模型原生参考图与绿画布扩图：请改用「整图重绘 / 局部重绘」，或切换到云端算力来源',
      }
    }

    const loraResult = normalizeLoraRequest(request.lora)
    if (!loraResult.ok) {
      log.info(`enqueue_rejected code=${loraResult.code} tool=${tool} lora=invalid pending=${this.pending.length}`)
      return loraResult
    }
    const lora = loraResult.value
    if (lora && tool !== 'generate') {
      return {
        ok: false,
        code: 'invalid_request',
        message: `风格 LoRA 锁定只支持普通出图（tool=generate），当前 tool=${tool}`,
      }
    }
    if (lora && !supportsStyleLora(preset, hostProvider)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: '当前模型或算力来源不支持风格 LoRA（商业 API 暂不支持，需使用 FLUX.2 家族与本机/开源云端 GPU）',
      }
    }

    const seedInput = Number(request.seed)
    const seed =
      Number.isFinite(seedInput) && seedInput >= 0
        ? Math.round(seedInput) % LIMITS.seed.max
        : Math.floor(Math.random() * LIMITS.seed.max)

    let params
    if (tool === 'upscale') {
      // 放大没有 steps / cfg / seed 语义：params 里保留 0 供展示，count 固定 1 张。
      // width / height 是源图宽高（客户端带来，缺失时为 null，由远端解码后兜底）。
      params = {
        prompt,
        negativePrompt:
          typeof request.negativePrompt === 'string'
            ? request.negativePrompt.trim().slice(0, LIMITS.negativePrompt.maxChars)
            : '',
        width: upscaleExtent.width,
        height: upscaleExtent.height,
        steps: 0,
        cfg: 0,
        seed: 0,
        count: 1,
        reference: { sourcePath: reference.sourcePath, upscale: true },
      }
    } else {
      params = {
        prompt,
        negativePrompt:
          typeof request.negativePrompt === 'string'
            ? request.negativePrompt.trim().slice(0, LIMITS.negativePrompt.maxChars)
            : '',
        width: normalizeDimension(request.width, preset.size, LIMITS.width),
        height: normalizeDimension(request.height, preset.size, LIMITS.height),
        steps: clampInt(request.steps, LIMITS.steps.min, LIMITS.steps.max, variant?.steps ?? preset.steps),
        cfg: clampNumber(request.cfg, LIMITS.cfg.min, LIMITS.cfg.max, variant?.cfg ?? preset.cfg),
        seed,
        count: clampInt(request.count, LIMITS.count.min, LIMITS.count.max, LIMITS.count.min),
      }
      // 公开视图只暴露参考图出处、强度与「是否带蒙版」，不暴露任何二进制
      // （/state 每 2 秒轮询一次；蒙版 base64 只留在内部 job.reference 里直到执行阶段）。
      if (reference) {
        // 扩图的参考图是前端合成的画布：image 来源没有工作区路径，改用客户端给的
        // sourcePath 记录被扩的原作品，版本树才能把扩图产物归组到来源作品。
        params.reference = {
          sourcePath: tool === 'outpaint' ? reference.sourcePath : reference.path,
          ...(isModernOutpaint ? {} : { strength: reference.strength }),
        }
        // 扩图内容框（原图在画布里的位置）只对 outpaint 有意义：其它 tool 一律忽略，
        // 公开视图只暴露这个小对象（0~1 归一化，客户端据此对齐「对比原图」拉帘）。
        if (tool === 'outpaint' && reference.outpaintContent) {
          params.reference.outpaintContent = reference.outpaintContent
        }
        if (reference.maskB64) params.reference.mask = true
      }
      // 原生参考生图：公开视图只暴露参考图出处（工作区相对路径），不暴露任何二进制；
      // 产物 meta 的 `referenceSources` 与 /history 透传都用这组路径。
      if (references) params.referenceSources = [...references]
      if (lora) params.lora = { ...lora }
    }

    const job = {
      id: `j_${randomBytes(4).toString('hex')}`,
      // 请求类型：远端只认 generate / upscale，outpaint 在 Host 侧展开成普通 inpaint 请求。
      tool,
      status: 'queued',
      stage: '排队中',
      presetId: tool === 'upscale' ? UPSCALE.id : preset.id,
      // 精度档（Q-04）：内部保存完整 variant pipeline 供 taskPayload 使用；
      // publicView 只暴露 id / precision / downloadGb / quantizationScheme，不暴露权重细节。
      variantId: variantRecorded ? variant?.id ?? null : null,
      precision: variantRecorded ? variant?.precision ?? null : null,
      downloadGb: variantRecorded ? variant?.downloadGb ?? null : null,
      quantizationScheme: variantRecorded ? variant?.quantizationScheme ?? null : null,
      variantPipeline: variantRecorded && variant && variant.id !== FULL_VARIANT_ID && variant.pipeline
        ? variant.pipeline
        : null,
      params,
      // 内部参考图（可能带 base64）；不进入 publicView，只用于执行阶段构造远端载荷。
      reference,
      // 模型原生参考图（工作区相对路径数组）：执行阶段读盘并做成远端 referenceImages 载荷；
      // 与 reference 互斥，二者最多一个非空。
      references,
      // 工作区交付目标（已归一成 POSIX 相对路径）；null 表示只写 outputs 归档。
      saveTo,
      createdAt: isoNow(),
      startedAt: null,
      finishedAt: null,
      seconds: null,
      sessionState: this.session.snapshot().state,
      modelId: tool === 'upscale' ? UPSCALE.id : preset.repo,
      output: null,
      error: null,
      source: jobSource,
      autoStart: request.autoStart !== false,
    }

    this.jobs.push(job)
    this.pending.push(job)
    this.trim()
    // 只记 prompt 长度：提示词正文与 negativePrompt 正文不得进日志。
    log.info(
      `enqueue jobId=${job.id} tool=${tool} presetId=${job.presetId} size=${params.width}x${params.height} ` +
        `variant=${job.variantId ?? 'full'} steps=${params.steps} count=${params.count} promptLen=${params.prompt.length} ` +
        `img2img=${reference ? 'on' : 'off'}${reference && tool !== 'upscale' ? ` strength=${reference.strength}` : ''} ` +
        `inpaint=${reference?.maskB64 ? 'on' : 'off'} references=${references ? references.length : 0} ` +
        `pending=${this.pending.length}`,
    )
    void this.runNext()
    return { ok: true, job: this.publicView(job) }
  }

  /**
   * 兼容入口：与 :meth:`submit` 同义（工坊路由按 `queue.enqueue(...)` 命名调用）。
   *
   * 历史调用面（`/api/generate`、Agent 工具）一直用 `submit`；工坊路由的规格书写的是
   * `enqueue`。这里保留一个入口别名而不是让调用方感知两套命名，语义 / 返回形状完全一致。
   *
   * @param {object} request 与 submit 相同的请求体
   * @returns {{ ok: true, job: object } | { ok: false, code: string, message: string }}
   */
  enqueue(request = {}) {
    return this.submit(request)
  }

  trim() {
    while (this.jobs.length > LIMITS.queue.maxKept) {
      const index = this.jobs.findIndex((job) => job.id !== this.running?.id && !this.pending.includes(job))
      if (index === -1) return
      this.jobs.splice(index, 1)
    }
  }

  /** 从待执行队列移除任务（已在执行/已不在队列时为空操作）。 */
  dropFromPending(job) {
    const index = this.pending.indexOf(job)
    if (index >= 0) this.pending.splice(index, 1)
  }

  /**
   * 任务取消后的实例回收：仅当会话由生成队列自动拉起、仍停在启动阶段，
   * 且队列里已经没有后续任务时，放弃这一轮启动。
   *
   * 用户手动唤醒的会话（`startedByJob === false`）保持运行；已有后续任务时
   * 也不回收，让下一个任务继续复用同一次启动。
   */
  releaseAutoStartedSession() {
    if (this.disposed || this.running || this.pending.length > 0) return
    if (!this.session || this.session.startedByJob !== true) return
    if (!STARTING_SESSION_STATES.has(sessionStateOf(this.session))) return
    if (typeof this.session.abandonActiveSession !== 'function') return

    log.info('session_abandon_from_cancel reason=job_cancelled')
    let pending
    try {
      pending = Promise.resolve(this.session.abandonActiveSession('job_cancelled'))
    } catch (error) {
      log.warn(`session_abandon_from_cancel_failed message=${logText(error?.message ?? error)}`)
      return
    }
    const tracked = pending
      .catch((error) => {
        log.warn(`session_abandon_from_cancel_failed message=${logText(error?.message ?? error)}`)
      })
      .finally(() => {
        if (this.releasingAutoSession === tracked) this.releasingAutoSession = null
      })
    this.releasingAutoSession = tracked
  }

  // ---- 取消 ---------------------------------------------------------------

  /**
   * 取消任务（取消语义见 shared/contract.js 的 JOB_CANCEL 与 docs/SPEC.md §2.2）。
   *
   * - `queued`：从 pending 移除并立即置为终态 cancelled；若当前没有 running，
   *   立刻推进后续任务（取消不能把队列卡住）。
   * - `waiting-session`：置 cancelRequested 并立即置终态，同时释放串行槽位——
   *   会话等待循环下一拍（约 1 秒）就会感知取消并退出，不必等满 sessionWaitMs
   *   （45 分钟）才轮到后面的任务（队头阻塞）。
   * - `running`：只置 cancelRequested（合作式）。当前这张远端任务照常出完，
   *   已完成的图片仍落盘，之后不再提交批内剩余张数，任务最终收敛为 cancelled；
   *   远端采样线程不强杀、不改。
   * - `done` / `failed` / `cancelled`：终态不做任何改变，返回 already-finished。
   *
   * @param {string} id 任务 id
   * @returns {{ ok: true, job: object, disposition: 'dequeued'|'cooperative'|'already-finished' }
   *   | { ok: false, code: 'not_found' }}
   */
  cancel(id) {
    const job = this.jobs.find((item) => item.id === id)
    if (!job) return { ok: false, code: 'not_found' }

    if (TERMINAL_STATUS.has(job.status)) {
      return { ok: true, job: this.publicView(job), disposition: 'already-finished' }
    }

    if (job.status === 'queued' || job.status === 'waiting-session') {
      const wasWaitingSession = job.status === 'waiting-session'
      this.dropFromPending(job)
      job.cancelRequested = true
      job.status = 'cancelled'
      job.stage = '已取消'
      job.finishedAt = isoNow()
      job.error = null
      job.sessionState = sessionStateOf(this.session)
      // 等待会话的任务此刻占用串行槽位：立刻让出，后续任务不必等等待循环超时。
      // runNext 的 finally 用 `this.running === job` 守卫，不会误清掉下一个任务的占位。
      if (this.running === job) this.running = null
      // 取消即终态：登记中的 waitFor 等待者立刻拿到 cancelled 快照。
      this.wakeWaiters(job.id)
      // 只记结构化摘要（jobId/张数/disposition），prompt 正文不进日志。
      log.info(
        `job_cancelled jobId=${job.id} disposition=dequeued images=${job.output?.images?.length ?? 0} ` +
          `total=${job.params.count} pending=${this.pending.length}`,
      )
      // 队列已经空了：如果实例是任务自动拉起的，别让用户看着一份没有任务的启动进度。
      if (wasWaitingSession) this.releaseAutoStartedSession()
      if (!this.disposed) void this.runNext()
      return { ok: true, job: this.publicView(job), disposition: 'dequeued' }
    }

    // running：合作式停止。不改 status（客户端继续显示生成中/正在停止），由当前张收尾后收敛。
    if (job.cancelRequested !== true) {
      job.cancelRequested = true
      job.localAbortController?.abort(new JobCancelled())
      log.info(`job_cancel_requested jobId=${job.id} disposition=cooperative total=${job.params.count}`)
    }
    return { ok: true, job: this.publicView(job), disposition: 'cooperative' }
  }

  // ---- 执行 ---------------------------------------------------------------

  /** 队列记账与串行占位：把任务交给 runJob，失败统一折叠成 job.error。 */
  async runNext() {
    if (this.disposed || this.running || this.pending.length === 0) return
    const job = this.pending.shift()
    this.running = job

    try {
      await this.runJob(job)
    } catch (error) {
      // 取消路径的收尾在 runJob / cancel() 内完成，这里绝不能把已取消的任务改成 failed：
      // waiting-session 的取消会让 cancel() 先改状态、runJob 稍后才退出，此时 job 已是终态。
      if (job.status === 'cancelled') {
        job.sessionState = sessionStateOf(this.session)
      } else {
        job.status = 'failed'
        job.stage = '失败'
        job.finishedAt = isoNow()
        job.error = describeJobError(error, this.session.snapshot(), {
          started: Boolean(job.startedAt),
          stoppedByUser: this.session.stoppedByUser === true,
        })
        // 用户手动关机会把底层 session_absent / session_timeout 折叠成 stopped：
        // 单独记一条 canceled_by_stop，便于在 Host 日志里区分「关机取消」和「真实失败」。
        if (job.error.code === 'stopped') {
          log.warn(`canceled_by_stop jobId=${job.id} promptLen=${job.params.prompt.length}`)
        } else {
          this.options.onJobTelemetry?.('generate_fail', {
            tool: job.tool ?? 'generate',
            provider: job.provider ?? '',
            presetId: job.presetId ?? '',
            errorCode: job.error.code ?? 'unknown',
            source: job.source ?? 'studio',
          })
        }
        log.warn(
          `job_failed jobId=${job.id} code=${job.error.code} promptLen=${job.params.prompt.length} message=${logText(job.error.message)}`,
        )
      }
    } finally {
      // 守卫：cancel() 可能已经释放槽位并启动了下一个任务，此时 this.running 不再属于本任务，
      // 不能在这里清掉别人的占位。
      if (this.running === job) this.running = null
      // 二进制产物只在下单张落盘期间需要：无论成功/失败/取消都清掉临时目录，
      // 避免 %TEMP% 随出图数量无限增长。
      void this.cleanupArtifacts(job)
      // 收尾路径统一唤醒等待者：正常路径此时已是终态；dispose / 异常路径也返回当前快照，
      // 不把 waitFor 调用方挂死。放在 runNext 里而不是 runJob 内，保证成功与失败只有一处接管。
      this.wakeWaiters(job.id)
      if (!this.disposed) void this.runNext()
    }
  }

  /**
   * 会话等待 + 逐张远端调用；成功路径的落盘与收尾交给 persistResult，
   * 取消路径交给 finalizeCancelled（已完成的图片照常落盘，状态写成 cancelled）。
   */
  async runJob(job) {
    let startedAt = null
    try {
      if (this.releasingAutoSession) await this.releasingAutoSession
      if (job.cancelRequested) throw new JobCancelled()

      if (WORKSHOP_TOOLS.includes(job.tool) && job.execution === 'local') {
        await this.runLocalWorkshop(job)
        return
      }

      const desiredProvider =
        job.workshopProvider ?? (typeof this.options.getProvider === 'function' ? this.options.getProvider() : this.options.provider)
      const cloud = isCloudApiProvider(desiredProvider)
      if (usesPresetTool(job.tool ?? 'generate') && desiredProvider) {
        const localGpuPresets = typeof this.options.getLocalGpuPresets === 'function'
          ? this.options.getLocalGpuPresets()
          : []
        const gate = providerGateOf(presetById(job.presetId), desiredProvider, { localGpuPresets })
        if (gate) throw Object.assign(new Error(gate.message), { code: gate.code })
      }

      if (cloud) {
        // 商业生图 API 走无状态 HTTPS 请求：无需唤醒或打断后台正在运行的 Colab / Kaggle GPU 会话。
        job.sessionState = 'ready'
      } else {
        if (this.session.isReady) {
          // 设置里的算力来源可能已经在会话运行后被切换：ready 会话属于旧来源时，
          // 下一个任务必须先把会话换到新来源，否则「设置显示 Colab、实际在 Kaggle 出图」。
          const activeProvider = this.session.snapshot()?.provider
          if (desiredProvider && activeProvider && desiredProvider !== activeProvider) {
            log.info(`session_provider_switch jobId=${job.id} from=${activeProvider} to=${desiredProvider}`)
            job.status = 'waiting-session'
            job.stage = '准备远端会话'
            await this.session.start(job.presetId, {
              initiator: 'job',
              provider: job.workshopProvider,
              variantId: job.variantId,
            })
            if (job.cancelRequested) throw new JobCancelled()
            job.sessionState = this.session.snapshot().state
            await this.waitSessionReady(job)
          } else {
            job.sessionState = 'ready'
          }
        } else {
          job.status = 'waiting-session'
          job.stage = '准备远端会话'
          const waitStartedAt = Date.now()
          log.info(
            `wait_session_start jobId=${job.id} autoStart=${job.autoStart !== false} promptLen=${job.params.prompt.length}`,
          )
          try {
            // 用户手动「关机」后，排队中的任务不得自动把 Kernel 拉起来（否则关机按钮形同虚设）。
            // 标记只由 SessionManager.stop() 置位、下一次 start() 清除。
            if (this.session.stoppedByUser === true) {
              throw Object.assign(
                new Error('会话已被手动关闭，未自动启动新的 Kernel；请先在面板点「唤醒」后再试'),
                { code: 'stopped' },
              )
            }
            if (job.autoStart) {
              await this.session.start(job.presetId, {
                initiator: 'job',
                provider: job.workshopProvider,
                variantId: job.variantId,
              })
              // start() 可能耗时（推送 Kernel）；返回后立刻检查取消标记，别再进入等待循环。
              if (job.cancelRequested) throw new JobCancelled()
            }
            job.sessionState = this.session.snapshot().state
            await this.waitSessionReady(job)
            log.info(
              `wait_session_done jobId=${job.id} elapsedMs=${Date.now() - waitStartedAt} state=${sessionStateOf(this.session)}`,
            )
          } catch (error) {
            if (isCancellation(error)) {
              log.info(`wait_session_cancelled jobId=${job.id} elapsedMs=${Date.now() - waitStartedAt}`)
            } else {
              log.warn(
                `wait_session_done jobId=${job.id} elapsedMs=${Date.now() - waitStartedAt} ` +
                  `state=${sessionStateOf(this.session)} code=${errorKind(error)} message=${logText(error?.message)}`,
              )
            }
            throw error
          }
        }

        const { endpoint, token } = this.session.connection()
        if (!endpoint || !token) {
          throw Object.assign(new Error('远端连接不可用'), { code: 'session_absent' })
        }
      }

      // 出处快照：任务可能在会话切换来源前后执行，落盘时以「真正出图的那次来源」为准。
      this.captureProvenance(job, { cloud })
      if (usesPresetTool(job.tool ?? 'generate') && job.provider) {
        const localGpuPresets = typeof this.options.getLocalGpuPresets === 'function'
          ? this.options.getLocalGpuPresets()
          : []
        const gate = providerGateOf(presetById(job.presetId), job.provider, { localGpuPresets })
        if (gate) throw Object.assign(new Error(gate.message), { code: gate.code })
      }
      if (job.quantizationScheme && !this.remoteSupportsQuantization(job.quantizationScheme)) {
        throw Object.assign(
          new Error(
            `远端 Worker 不支持 ${job.quantizationScheme} 精度档：请升级 Worker 镜像或切回满血 BF16`,
          ),
          { code: 'invalid_request' },
        )
      }
      startedAt = Date.now()
      job.status = 'running'
      job.stage = '生成中'
      job.startedAt = isoNow()

      // 远端载荷构造与传输都在本队列的 generate 里，远端协议细节不进路由层。
      const generateStartedAt = Date.now()
      log.info(
        `remote_generate_start jobId=${job.id} tool=${job.tool ?? 'generate'} presetId=${job.presetId} ` +
          `provider=${job.provider ?? 'unknown'} device=${job.device ?? 'unknown'} ` +
          `count=${job.params.count} timeoutMs=${this.options.generateTimeoutMs}`,
      )
      let generated
      try {
        generated = cloud ? await this.generateCloud(job) : await this.generate(job)
      } catch (error) {
        if (isCancellation(error)) {
          log.info(
            `remote_generate_cancelled jobId=${job.id} tool=${job.tool ?? 'generate'} elapsedMs=${Date.now() - generateStartedAt}`,
          )
        } else {
          log.warn(
            `remote_generate_failed jobId=${job.id} tool=${job.tool ?? 'generate'} elapsedMs=${Date.now() - generateStartedAt} ` +
              `count=${job.params.count} code=${errorKind(error)} message=${logText(error?.message)}`,
          )
        }
        throw error
      }
      const { results, modelId } = generated
      log.info(
        `remote_generate_done jobId=${job.id} tool=${job.tool ?? 'generate'} elapsedMs=${Date.now() - generateStartedAt} ` +
          `images=${results.length} cancelled=${generated.cancelled === true}`,
      )

      if (generated.cancelled) {
        await this.finalizeCancelled(job, { startedAt, results, modelId })
        return
      }
      await this.persistResult(job, results, { startedAt, modelId })
      log.info(
        `job_done jobId=${job.id} seconds=${job.seconds} images=${job.output?.images?.length ?? results.length}`,
      )
    } catch (error) {
      if (!isCancellation(error)) throw error
      await this.finalizeCancelled(job, { startedAt, results: [] })
    }
  }

  async runLocalWorkshop(job) {
    const localEngine = this.options.localWorkshop
      ?? (job.tool === WORKSHOP.pbr.op ? this.options.localPbr : null)
    if (typeof localEngine?.run !== 'function') {
      throw Object.assign(new Error('本机 CUDA 执行器不可用，请切换云端。'), { code: 'invalid_request' })
    }
    const controller = new AbortController()
    job.localAbortController = controller
    const signal = AbortSignal.any([controller.signal, this.abortController.signal])
    job.status = 'running'
    job.localStage = 'loading'
    const label = job.tool === WORKSHOP.depth.op
      ? '深度'
      : job.tool === WORKSHOP.relight.op
        ? '重打光'
        : '材质拆解'
    job.stage = `准备本机${label}`
    job.startedAt = isoNow()
    job.provider = 'local-gpu'
    job.deviceCount = 1
    job.sessionState = 'ready'
    const startedAt = Date.now()
    try {
      const source = await resolveOutputPath(this.ctx, job.reference.path)
      if (!source) throw Object.assign(new Error('源图不存在'), { code: 'invalid_path' })
      const generated = await localEngine.run({
        op: job.tool,
        model: job.workshopModel ?? job.presetId,
        sourcePath: source.absolute,
        steps: job.workshopSteps,
        options: job.workshopOptions,
        signal,
        onEvent(event) {
          job.localStage = event.stage === 'inferring' ? 'running' : 'loading'
          job.stage = event.stage === 'inferring' ? `本机${label}中` : `准备本机${label}`
        },
      })
      if (job.cancelRequested || this.disposed) throw new JobCancelled()
      job.device = generated.device ?? null
      const results = normalizeWorkshopResults(generated.results, job.tool)
      await this.persistResult(job, results, { startedAt, modelId: generated.modelId })
    } catch (error) {
      if (signal.aborted || isCancellation(error)) {
        await this.finalizeCancelled(job, { startedAt, results: [] })
      } else throw error
    } finally {
      delete job.localAbortController
    }
  }

  /**
   * 可取消的会话等待（替代不可中断的 `session.ensureReady()`）。
   *
   * 每 `sessionPollMs`（生产约 1 秒）读一次 `session.snapshot()`：
   *  - ready 返回快照；error 抛会话错误；absent / stopping 抛 session_absent；
   *  - 先检查 job.cancelRequested 与 queue.disposed：取消后下一拍即退出，
   *    waiting-session 的取消不会卡满 sessionWaitMs（45 分钟队头阻塞）；
   *  - 超时抛 session_timeout。
   * 保留原 onTick 行为：每拍把会话状态写进 job.sessionState / job.stage（SESSION_STAGE 文案）。
   */
  async waitSessionReady(job) {
    const deadline = Date.now() + this.options.sessionWaitMs
    const pollMs = Math.max(5, Number(this.options.sessionPollMs) || 1000)
    // 等待期间用户可能切换算力来源：按目标来源去重，避免同一轮与 session.start 幂等分支打架，
    // 同时允许 A → B → A 来回切时再次换源。
    let lastSwitchedTo = null
    while (true) {
      if (this.disposed) throw Object.assign(new Error('插件已卸载'), { code: 'disposed' })
      if (job.cancelRequested) throw new JobCancelled()
      const snapshot = this.session.snapshot()
      const state = snapshot?.state ?? 'unknown'
      // 等待中切换来源：旧会话即使刚好 ready 也不能继续用，先换到新来源再重新等待。
      const desiredProvider =
        job.workshopProvider ?? (typeof this.options.getProvider === 'function' ? this.options.getProvider() : this.options.provider)
      if (
        job.autoStart !== false
        && desiredProvider
        && snapshot?.provider
        && snapshot.provider !== desiredProvider
        && lastSwitchedTo !== desiredProvider
      ) {
        lastSwitchedTo = desiredProvider
        log.info(
          `wait_session_provider_switch jobId=${job.id} from=${snapshot.provider} to=${desiredProvider}`,
        )
        await this.session.start(job.presetId, {
          initiator: 'job',
          provider: job.workshopProvider,
          variantId: job.variantId,
        })
        if (job.cancelRequested) throw new JobCancelled()
        continue
      }
      job.sessionState = state
      job.stage = SESSION_STAGE[state] ?? job.stage
      if (state === 'ready') return snapshot
      if (state === 'error') {
        throw Object.assign(new Error(snapshot?.error?.message ?? '会话失败'), {
          code: snapshot?.error?.code ?? 'session_error',
        })
      }
      if (state === 'absent' || state === 'stopping') {
        throw Object.assign(new Error('会话未启动'), { code: 'session_absent' })
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('等待会话就绪超时'), { code: 'session_timeout' })
      }
      await new Promise((resolve) => {
        const signal = this.abortController.signal
        if (signal.aborted) return resolve()
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, pollMs)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  /**
   * 单张任务的远端载荷：`tasks` 只含 1 项，幂等键 `<宿主 job.id>-<两位序号>`。
   *
   * 逐张提交是合作式取消的前提：一张完成后才提交下一张，取消时不再提交剩余张数。
   * daemon 的 jobId 只接受字母/数字/点/下划线/短横线且 ≤64 字符，这里的键满足该约束。
   * 图生图时在 job 级带 `reference: { image_b64, strength }`（一张参考图跑整批）；
   * 局部重绘再带 `reference.mask_b64`（同样整批共用一张蒙版）。
   */
  taskPayload(job, preset, index, reference = null, referenceImages = null, resultMode = 'inline') {
    const params = job.params
    const isModernOutpaint =
      job.tool === 'outpaint'
      && preset?.id === OUTPAINT_ENGINE.presetId
      && Boolean(reference?.image_b64)
      && !reference?.mask_b64
    const selectedPipeline =
      job.variantPipeline && typeof job.variantPipeline === 'object'
        ? job.variantPipeline
        : preset.pipeline
    const styleLora = !isModernOutpaint && params.lora && typeof params.lora === 'object'
      ? params.lora
      : null
    const pipeline = isModernOutpaint
      ? { ...selectedPipeline, lora: OUTPAINT_ENGINE.lora }
      : styleLora
        ? {
            ...selectedPipeline,
            lora: {
              repo: styleLora.repo,
              weight: styleLora.weight,
              scale: styleLora.scale,
            },
          }
        : selectedPipeline
    const prompt = isModernOutpaint
      ? (params.prompt ? `${OUTPAINT_ENGINE.prompt}, ${params.prompt}` : OUTPAINT_ENGINE.prompt)
      : styleLora
        ? applyLoraTriggerPrompt(params.prompt, styleLora.trigger)
        : params.prompt
    const payload = {
      pipeline,
      presetId: preset?.id ?? null,
      modelId: preset?.repo ?? preset?.id ?? null,
      jobId: `${job.id}-${String(index + 1).padStart(2, '0')}`,
      tasks: [
        {
          name: String(index + 1).padStart(2, '0'),
          prompt,
          negative_prompt: isModernOutpaint ? '' : params.negativePrompt,
          // 同批多张按序号递增 seed；超过契约上界时环形回绕，避免远端按 seed>max 直接 400。
          seed: (params.seed + index) % LIMITS.seed.max,
          width: params.width,
          height: params.height,
          steps: params.steps,
          cfg: params.cfg,
        },
      ],
    }
    if (isModernOutpaint) {
      // 现代扩图（Klein 4B + Outpaint LoRA）：纯绿画布走原生 referenceImages，不走蒙版/strength。
      payload.referenceImages = [{ image_b64: reference.image_b64 }]
    } else {
      if (reference) payload.reference = reference
      // 原生参考生图（Phase C1）：job 级 referenceImages 数组，一张（或多张）参考图跑整批；
      // 逐项只含 image_b64（没有 strength / 蒙版），远端按 loader 白名单与契约边界再校验一次。
      if (referenceImages) payload.referenceImages = referenceImages
    }
    // 协议 v2：binary 时远端只回元数据，Host 用 GET /artifact 下载；旧 daemon 忽略该字段。
    if (resultMode === 'binary') payload.result_mode = 'binary'
    return payload
  }

  /**
   * 把任务里的参考图解析成远端载荷：`{ image_b64, strength, mask_b64? }`；没有参考图返回 null。
   *
   * 实现见 `./reference-loader.js`（路径越界校验 + 体积/魔数校验）；这里只负责把
   * 队列作用域的日志器传下去，保持 `reference_read_failed` 的 scope 与文案不变。
   */
  async resolveReferencePayload(job) {
    return resolveReferencePayload(this.ctx, job.reference, { jobId: job.id, log })
  }

  /**
   * 把任务里的原生参考图路径列表读盘并做成远端载荷：`[{ image_b64 }, ...]`；没有参考图返回 null。
   *
   * 与单图垫图一样只在进入生成时解析一次（整批 count 共用）；失败（文件被删、超体积、
   * 总体积超预算）在提交远端请求之前抛出，任务以 `invalid_path` / `invalid_request` 失败。
   */
  async resolveReferenceImagesPayload(job) {
    return resolveReferenceImagesPayload(this.ctx, job.references, { jobId: job.id, log })
  }

  // ---- 协议 v2：能力协商 / 二进制产物 / SSE ----

  /** `/health.capabilities` 快照；旧 daemon / 测试替身没有时返回 null。 */
  remoteCapabilities() {
    const caps = typeof this.session?.capabilities === 'function' ? this.session.capabilities() : null
    return caps && typeof caps === 'object' ? caps : null
  }

  /** 是否走 `result_mode=binary`：provider 能力位 + 远端自报能力双重确认。 */
  remoteBinaryEnabled() {
    const meta = providerMetaOf(this.session?.provider?.id)
    if (!meta?.binary) return false
    const modes = this.remoteCapabilities()?.result_modes
    return Array.isArray(modes) && modes.includes('binary')
  }

  /** 是否订阅 `/events`：同上，缺任一侧就回退轮询。 */
  remoteEventsEnabled() {
    const meta = providerMetaOf(this.session?.provider?.id)
    if (!meta?.events) return false
    return this.remoteCapabilities()?.events === true
  }

  /** 远端是否声明支持指定量化格式；旧 Worker 没有 capabilities 时交给执行期报错。 */
  remoteSupportsQuantization(name) {
    if (!name) return true
    const caps = this.remoteCapabilities()
    if (!caps) return true
    const formats = Array.isArray(caps.quantization) ? caps.quantization : []
    return formats.includes(name)
  }

  /** 本任务的临时产物目录（下载完成后由 saveJobOutput 读取，收尾时整目录删除）。 */
  artifactDirOf(job) {
    return join(tmpdir(), 'aigc-studio', 'artifacts', String(job.id))
  }

  async cleanupArtifacts(job) {
    await rm(this.artifactDirOf(job), { recursive: true, force: true }).catch(() => {})
  }

  /**
   * 把 `/job` 的二进制元数据下载成本地临时文件。
   *
   * 远端在 binary 模式下 `results[]` 只带 `{index,bytes,sha256,media_type}`；这里逐张
   * `GET /artifact` 到 `%TEMP%/aigc-studio/artifacts/<jobId>/`，校验 sha256 后把
   * `tempPath` 挂回结果项（`saveJobOutput` 优先读它）。
   * 单张写盘失败（`artifactError`）仍带 `image_b64`，这里原样保留走 inline 兼容分支。
   */
  async fetchArtifacts(job, remoteJobId, items, { endpoint, token, signal }) {
    const list = Array.isArray(items) ? items : []
    const dir = this.artifactDirOf(job)
    await mkdir(dir, { recursive: true })
    const output = []
    for (const [position, item] of list.entries()) {
      if (!item || typeof item !== 'object') {
        output.push(item)
        continue
      }
      if (typeof item.image_b64 === 'string' && item.image_b64) {
        output.push(item)
        continue
      }
      const sha256 = typeof item.sha256 === 'string' ? item.sha256 : ''
      if (!sha256) {
        output.push(item)
        continue
      }
      const index = Number.isInteger(item.index) ? item.index : position
      const destPath = join(dir, `${remoteJobId}-${index}.png`)
      await downloadArtifact(endpoint, token, remoteJobId, index, {
        destPath,
        sha256,
        signal,
        ctx: this.ctx,
      })
      output.push({ ...item, tempPath: destPath })
    }
    return output
  }

  /**
   * 生成阶段超时错误：逐张提交与高清放大共用同一文案与错误码。
   */
  generateTimeoutError() {
    return Object.assign(
      new Error(`等待远端生成超时（${Math.round(this.options.generateTimeoutMs / 1000)} 秒）`),
      { code: 'generate_failed' },
    )
  }

  /**
   * 提交一张远端任务并轮询到完成（逐张出图与高清放大共用）。
   *
   * 轮询容错、失败退避、同幂等键重投、整体预算全部复用 `waitForJob`：
   * 重投时用同一份 payload（同一 jobId），daemon 命中幂等键返回原 job，不重复出图。
   *
   * @param {object} job 已排队的任务（用于进度与 remoteJobId 记账）
   * @param {object} payload 远端 /generate 请求体（含本张的幂等键）
   * @param {{ endpoint: string, token: string, total: number, done: number, remainingMs: number }} context
   *   done：本张开始前已完成的张数（分张进度与 stage 文本用；0 表示第一张）
   * @returns {Promise<object>} /job 的 done 快照（含 results / model_id）
   */
  async runRemoteImage(job, payload, { endpoint, token, total, done, remainingMs }) {
    const signal = this.abortController.signal
    const submitted = await submitGenerate(endpoint, token, payload, TIMEOUTS.remoteSubmitMs, this.ctx, signal)
    job.remoteJobId = submitted.job_id

    // SSE 进度（协议 v2）：只降低延迟，任务终态仍以 /job 为准；断流或旧 Worker 静默回退轮询。
    // 一个宿主 job 会拆成多张远端 job，事件按 remoteJobId 过滤，避免上一张的步数串到下一张。
    let stream = null
    if (this.remoteEventsEnabled()) {
      stream = openEvents(endpoint, token, {
        signal,
        onEvent: (event) => {
          if (event?.event !== 'job' || event?.data?.id !== job.remoteJobId) return
          const step = Number(event.data?.progress?.step)
          const steps = Number(event.data?.progress?.steps)
          if (!Number.isFinite(step) || !Number.isFinite(steps) || steps <= 0) return
          const current = job.progress ?? { done, total }
          job.progress = {
            ...current,
            step: Math.max(0, Math.min(Math.round(step), Math.round(steps))),
            steps: Math.round(steps),
          }
        },
        onError: () => {},
      })
      await stream.ready.catch(() => {
        // 401/404/网络失败：SSE 只是加速通道，失败不改变任务路径。
        stream = null
      })
    }

    let response
    try {
      response = await waitForJob(endpoint, token, submitted.job_id, {
        timeoutMs: remainingMs,
        // 测试可把这些时序调小；生产不传时由 waitForJob 回落到 contract 默认值。
        // provider 可声明自己的单次轮询超时（Colab 大响应经隧道更慢，8s 不够）。
        requestMs: this.session?.provider?.jobRequestTimeoutMs,
        pollMs: this.options.pollMs,
        failureGraceMs: this.options.pollFailureGraceMs,
        backoffMaxMs: this.options.pollBackoffMaxMs,
        resumeMaxAttempts: this.options.resumeMaxAttempts,
        ctx: this.ctx,
        signal,
        // 隧道重建超过容忍窗口后，用同一张的幂等键重投：命中则接回原 job，不重复入队。
        resubmit: async () => {
          const resumed = await submitGenerate(endpoint, token, payload, TIMEOUTS.remoteSubmitMs, this.ctx, signal)
          job.remoteJobId = resumed.job_id
          log.warn(
            `remote_resume jobId=${job.id} remoteJobId=${resumed.job_id} tool=${job.tool ?? 'generate'} ` +
              `index=${done + 1}/${total}`,
          )
          return resumed.job_id
        },
        onProgress: (snapshot) => {
          const remoteDone = Number(snapshot?.progress?.done)
          const withinImage = Number.isFinite(remoteDone) ? Math.max(0, Math.min(1, Math.round(remoteDone))) : 0
          const completed = Math.min(total, done + withinImage)
          // stage 文本保持旧语义（done+1 表示「正在出第几张」），结构化 progress 给准确完成数。
          // 步数优先取本次 /job 快照（协议 v2 的 progress.step/steps）：这样即使 SSE 被代理
          // 100 秒超时切断（RunPod HTTP proxy）或旧 daemon 不支持 SSE，轮询也能驱动步数进度。
          const snapshotStep = Number(snapshot?.progress?.step)
          const snapshotSteps = Number(snapshot?.progress?.steps)
          const step = Number.isFinite(snapshotStep) ? snapshotStep : job.progress?.step
          const steps = Number.isFinite(snapshotSteps) && snapshotSteps > 0 ? snapshotSteps : job.progress?.steps
          job.progress = {
            done: completed,
            total,
            ...(Number.isFinite(steps) && steps > 0
              ? { step: Math.max(0, Math.min(Math.round(step ?? 0), Math.round(steps))), steps: Math.round(steps) }
              : {}),
          }
          job.stage = total > 1 ? `生成中 ${Math.min(completed + 1, total)}/${total}` : '生成中'
        },
      })
    } finally {
      stream?.close()
    }
    if (this.disposed) {
      throw Object.assign(new Error('插件已卸载'), { code: 'disposed' })
    }
    return response
  }

  /**
   * 商业生图 API 的连接配置（vendor / model / baseUrl / apiKey）。
   *
   * 由 app-config 注入 getter：设置抽屉保存后，下一个任务立即使用新配置。
   * 返回值只在本进程内流转，apiKey 不进入 job 快照 / 日志 / meta。
   */
  imageApiConfig() {
    try {
      const value = this.options.getImageApiConfig()
      return value && typeof value === 'object' ? value : null
    } catch (error) {
      log.warn(`image_api_config_failed message=${logText(error?.message ?? error)}`)
      return null
    }
  }

  /** 解析云端预设对应的服务商端点与 API Key（支持方式 B 多服务商同框切换）。 */
  resolveCloudVendorCall(config, preset) {
    const vendorId = preset?.cloud?.vendor || config?.vendor || ''
    const vendorMeta = imageApiVendorOf(vendorId)
    const keys = config?.keys && typeof config.keys === 'object' ? config.keys : null
    const rawKey = keys && typeof keys[vendorId] === 'string'
      ? keys[vendorId]
      : vendorId === config?.vendor
        ? config?.apiKey
        : ''
    const apiKey = typeof rawKey === 'string' ? rawKey.trim() : ''
    let baseUrl = ''
    if (vendorId === 'custom') {
      baseUrl = config?.customBaseUrl || (config?.vendor === 'custom' ? config?.baseUrl : '') || ''
    } else if (vendorId === config?.vendor && config?.baseUrl) {
      baseUrl = config.baseUrl
    } else {
      baseUrl = vendorMeta?.baseUrl || ''
    }
    return {
      vendor: vendorId,
      vendorLabel: vendorMeta?.label || vendorId || '商业生图 API',
      model: preset?.cloud?.model || '',
      baseUrl,
      apiKey,
    }
  }

  /**
   * 商业生图 API 的逐张生成（M3.5 Phase A）。
   *
   * 与远端路径共用同一套进度、取消与落盘语义：一张完成才提交下一张，取消后不再提交
   * 剩余张数；成图以 `image_b64` 交给 `saveJobOutput`，继续复用本地归档 / 版本树 / 交付。
   * 请求超时与取消由 AbortSignal 控制（用户取消是合作式的，当前这张会自然完成）。
   */
  async generateCloud(job) {
    const config = this.imageApiConfig()
    if (!config) {
      throw Object.assign(
        new Error('尚未填写商业 API 的 Key：请到 设置 → 云端算力 → 商业 API 配置后再试'),
        { code: 'image_api_not_configured' },
      )
    }
    const preset = cloudPresetOfConfig(config, job.presetId)
    if (!preset) {
      throw Object.assign(new Error('商业 API 模型不可用：请重新选择可用的云端模型'), {
        code: 'image_api_unsupported',
      })
    }
    const vendorCall = this.resolveCloudVendorCall(config, preset)
    if (!vendorCall.apiKey) {
      throw Object.assign(
        new Error(`尚未填写 ${vendorCall.vendorLabel} 的 API Key：请到 设置 → 云端算力 → 商业 API 配置后再试`),
        { code: 'image_api_not_configured' },
      )
    }
    // 视频走独立的提交 / 轮询 / 下载链路；落盘仍复用 saveJobOutput。
    if (preset.mediaType === 'video') {
      return this.generateCloudVideo(job, { preset, vendorCall })
    }
    const signal = this.abortController.signal
    const params = job.params
    const isOutpaint = job.tool === 'outpaint'
    const referenceImages = isOutpaint && job.reference?.imageB64
      ? [{ image_b64: job.reference.imageB64 }]
      : (Array.isArray(job.references) && job.references.length > 0
          ? await this.resolveReferenceImagesPayload(job)
          : null)
    const capabilities = isOutpaint && preset.cloud.outpaint
      ? {
          ...preset.cloud,
          maxEdge: preset.cloud.outpaint.maxEdge,
          maxPixels: preset.cloud.outpaint.maxPixels,
          supportsOutpaint: true,
        }
      : preset.cloud
    const total = Math.max(1, Math.min(Number(params.count) || 1, preset.cloud.maxCount || 1))
    const results = []
    job.progress = { done: 0, total }
    const deadline = Date.now() + this.options.generateTimeoutMs

    for (let index = 0; index < total; index += 1) {
      if (job.cancelRequested || this.disposed) break
      if (Date.now() > deadline) throw this.generateTimeoutError()
      job.progress = { done: results.length, total }
      job.stage = total > 1 ? `生成中 ${Math.min(results.length + 1, total)}/${total}` : '生成中'
      let image
      try {
        image = await generateCloudImage({
          config: {
            vendor: vendorCall.vendor,
            model: vendorCall.model,
            baseUrl: vendorCall.baseUrl,
            apiKey: vendorCall.apiKey,
          },
          request: {
            prompt: params.prompt,
            negativePrompt: params.negativePrompt,
            width: params.width,
            height: params.height,
            steps: params.steps,
            cfg: params.cfg,
            // 同批多张按序号递增 seed；模型不支持种子时由适配层自动忽略。
            seed: (params.seed + index) % LIMITS.seed.max,
            referenceImages,
            capabilities,
            outpaint: isOutpaint,
          },
          signal,
          log,
        })
      } catch (error) {
        if (error?.name === 'AbortError' || (signal.aborted && this.disposed)) {
          break
        }
        throw error
      }
      results.push({
        image_b64: image.buffer.toString('base64'),
        width: image.width,
        height: image.height,
        seed: image.seed,
        seconds: image.seconds,
      })
      job.progress = { done: results.length, total }
      log.info(
        `image_api_done jobId=${job.id} index=${results.length}/${total} vendor=${preset.cloud.vendor} ` +
          `model=${preset.cloud.model} seconds=${image.seconds}`,
      )
    }
    return {
      results,
      modelId: preset.repo,
      cancelled: job.cancelRequested === true || this.disposed,
    }
  }

  /**
   * 商业视频 API 的提交 / 轮询 / 下载（M4.1）。
   *
   * 与生图共用任务状态机与落盘：视频先下载到任务级临时目录（`tempPath`），
   * `saveJobOutput` 读文件写成 `01.mp4` 并写 `mediaType: 'video'` 的 meta。
   * 取消是合作式的：提交与轮询期间收到取消会中断轮询，已完成的结果照常收尾。
   */
  async generateCloudVideo(job, { preset, vendorCall }) {
    const signal = this.abortController.signal
    const params = job.params
    job.progress = { done: 0, total: 1 }
    job.stage = '提交视频任务'
    const references = await this.resolveReferenceImagesPayload(job)
    const frames = Array.isArray(references)
      ? references
        .map((item) => (typeof item?.image_b64 === 'string' ? item.image_b64 : ''))
        .filter(Boolean)
      : []
    const tempDir = this.artifactDirOf(job)
    let video
    try {
      video = await requestCloudVideo({
        config: {
          vendor: vendorCall.vendor,
          model: vendorCall.model,
          baseUrl: vendorCall.baseUrl,
          apiKey: vendorCall.apiKey,
        },
        request: {
          prompt: params.prompt,
          negativePrompt: params.negativePrompt,
          width: params.width,
          height: params.height,
          duration: params.duration,
          resolution: params.resolution,
          ratio: params.ratio,
          seed: params.seed,
          frames,
        },
        tempDir,
        signal,
        log,
        onProgress: ({ phase }) => {
          if (phase && phase !== job.stage) job.stage = phase
        },
      })
    } catch (error) {
      if (error?.name === 'AbortError' || (signal.aborted && this.disposed)) {
        return { results: [], modelId: preset.repo, cancelled: true }
      }
      throw error
    }
    job.progress = { done: 1, total: 1 }
    log.info(
      `video_api_done jobId=${job.id} vendor=${preset.cloud.vendor} model=${preset.cloud.model} ` +
        `seconds=${video.seconds} bytes=${video.bytes} duration=${video.duration ?? 'fixed'}`,
    )
    return {
      results: [{
        tempPath: video.tempPath,
        mediaType: 'video',
        ext: video.ext,
        width: video.width,
        height: video.height,
        duration: video.duration,
        seed: video.seed,
        seconds: video.seconds,
      }],
      modelId: preset.repo,
      cancelled: job.cancelRequested === true || this.disposed,
    }
  }

  /**
   * 逐张提交远端异步任务并轮询到完成（每张一个远端 job）；高清放大只有一张。
   *
   * 轮询容错、失败退避、同幂等键重投、整体预算全部复用 `waitForJob`：
   * 重投时用同一张的 payload（同一 jobId），daemon 命中幂等键返回原 job，不重复出图。
   * 每完成一张：results.push、job.progress 更新、job.stage 保持旧语义（done+1 表示正在出第几张）。
   * 每张开始前检查 cancelRequested：已取消就跳出，不再提交剩余张数。
   *
   * upscale（阶段十五 Phase B1）：远端有独立的超分分支，只发 1 个任务、不下发
   * pipeline / tasks / strength，`tool: 'upscale'` + 源图即全部载荷；轮询、取消与
   * 失败语义与普通出图完全一致（取消是合作式的：当前这张放大完成后收尾）。
   *
   * 错误对象与文案固定：session_absent（连接不可用）/ empty_result（无图片）；
   * 远端任务的失败码（oom / load_failed / generation_failed …）原样透传。
   *
   * @param {object} job 已排队的任务（含 tool / presetId / params / id / stage）
   * @returns {Promise<{ results: object[], modelId: string|null, cancelled: boolean }>}
   */
  async generate(job) {
    const { endpoint, token } = this.session.connection()
    if (!endpoint || !token) throw Object.assign(new Error('远端连接不可用'), { code: 'session_absent' })
    const signal = this.abortController.signal

    const params = job.params
    const tool = job.tool ?? 'generate'
    // 高清放大与工坊 GPU 算子都固定只出一张（远端是独立分支，不按 count 拆批）。
    const total = tool === 'upscale' || WORKSHOP_TOOLS.includes(tool) ? 1 : params.count
    const results = []
    let modelId = null
    // 参考图只在进入生成时解析一次：多张出图共用同一张垫图（不重复读盘 / 编码）。
    const referencePayload = await this.resolveReferencePayload(job)
    // 原生参考图同理：整批 count 共用一个 referenceImages 数组（读盘 + base64 只做一次）。
    const referenceImagesPayload = await this.resolveReferenceImagesPayload(job)
    // 进入远端调用即给出 0/N 的结构化进度，客户端不用等第一次轮询才有进度数据。
    job.progress = { done: 0, total }
    // 协议 v2：能力协商通过才请求二进制产物；旧 daemon 自动回退 inline（行为不变）。
    const binary = this.remoteBinaryEnabled()
    // 整体预算：逐张提交只是把一批拆成 N 个远端 job，预算仍按整个宿主任务计算，
    // 避免「每张各自 10 分钟」把整体耗时放大 N 倍。
    const deadline = Date.now() + this.options.generateTimeoutMs

    if (tool === 'upscale') {
      // 源图在入队时已校验；执行阶段读盘失败会走 resolveReferencePayload 的 invalid_path。
      if (!referencePayload?.image_b64) {
        throw Object.assign(new Error('高清放大缺少源图'), { code: 'invalid_request' })
      }
      // 合作式中止点：还没提交远端任务时取消，直接按 cancelled 收尾（与逐张循环的 break 同义）。
      if (job.cancelRequested || this.disposed) {
        return { results, modelId: null, cancelled: true }
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw this.generateTimeoutError()

      // 远端只接受 tool + 源图：不读 pipeline / tasks / strength（幂等键与逐张提交同规则）。
      const payload = {
        tool: 'upscale',
        modelId: UPSCALE.id,
        jobId: `${job.id}-01`,
        reference: { image_b64: referencePayload.image_b64 },
      }
      if (binary) payload.result_mode = 'binary'
      const response = await this.runRemoteImage(job, payload, { endpoint, token, total, done: 0, remainingMs })
      const prepared = binary
        ? await this.fetchArtifacts(job, job.remoteJobId, response.results, { endpoint, token, signal })
        : response.results
      results.push(...(Array.isArray(prepared) ? prepared : []))
      modelId = response.model_id ?? UPSCALE.id
      job.progress = { done: results.length, total }
      return { results, modelId, cancelled: job.cancelRequested === true || this.disposed }
    }

    if (WORKSHOP_TOOLS.includes(tool)) {
      // 工坊 GPU 算子（M4.2a / M4.2b）：与 upscale 同构的独立分支——1 个任务、不读扩散
      // pipeline；远端载荷固定为 `{ tool, model, reference:{image_b64}, workshop:{model,steps} }`。
      // remove-bg 返回 1 个 channel='cutout' 结果，pbr 返回 4 个固定顺序的通道结果。
      if (!referencePayload?.image_b64) {
        throw Object.assign(new Error('工坊算子缺少源图'), { code: 'invalid_request' })
      }
      if (job.cancelRequested || this.disposed) {
        return { results, modelId: null, cancelled: true }
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw this.generateTimeoutError()

      const workshopModel = job.workshopModel ?? job.presetId
      const workshopSteps = Number.isFinite(job.workshopSteps) ? job.workshopSteps : 0
      const workshopOptions = job.workshopOptions && typeof job.workshopOptions === 'object'
        ? job.workshopOptions
        : undefined
      const payload = {
        tool,
        // 模型 id（Host 契约里的 'rmbg-2.0' / 'birefnet' / 'marigold' / 'chord'）与
        // workshop 块同时下发：daemon 按 workshop 块做白名单与步数校验，model 用于展示/日志。
        model: workshopModel,
        jobId: `${job.id}-01`,
        reference: { image_b64: referencePayload.image_b64 },
        workshop: {
          model: workshopModel,
          steps: workshopSteps,
          ...(workshopOptions ? { options: workshopOptions } : {}),
        },
      }
      // 协议 v2：binary 时远端只回元数据，Host 用 GET /artifact 下载；旧 daemon 忽略该字段。
      if (binary) payload.result_mode = 'binary'
      const response = await this.runRemoteImage(job, payload, { endpoint, token, total, done: 0, remainingMs })
      const prepared = binary
        ? await this.fetchArtifacts(job, job.remoteJobId, response.results, { endpoint, token, signal })
        : response.results
      // 结果归一：把 channel 按契约顺序排好（inline / binary 两种 result_mode 都覆盖，
      // binary 时 daemon 元数据缺 channel 也能按 artifact 顺序映射回来），再交给 saveJobOutput。
      results.push(...normalizeWorkshopResults(prepared, tool))
      modelId = response.model_id ?? job.modelId
      job.progress = { done: results.length, total }
      return { results, modelId, cancelled: job.cancelRequested === true || this.disposed }
    }

    const preset = presetById(job.presetId)
    for (let index = 0; index < total; index += 1) {
      // 合作式中止点：一张开始前检查取消标记，置位后剩余张数不再提交。
      if (job.cancelRequested || this.disposed) break

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw this.generateTimeoutError()

      job.progress = { done: results.length, total }
      job.stage = total > 1 ? `生成中 ${Math.min(results.length + 1, total)}/${total}` : '生成中'

      const payload = this.taskPayload(job, preset, index, referencePayload, referenceImagesPayload, binary ? 'binary' : 'inline')
      const response = await this.runRemoteImage(job, payload, {
        endpoint,
        token,
        total,
        done: results.length,
        remainingMs,
      })

      const prepared = binary
        ? await this.fetchArtifacts(job, job.remoteJobId, response.results, { endpoint, token, signal })
        : response.results
      results.push(...(Array.isArray(prepared) ? prepared : []))
      modelId = response.model_id ?? modelId ?? preset.repo
      job.progress = { done: results.length, total }
      job.stage = total > 1 ? `生成中 ${Math.min(results.length + 1, total)}/${total}` : '生成中'
    }

    return { results, modelId, cancelled: job.cancelRequested === true || this.disposed }
  }

  /**
   * 落盘并收尾。
   * 顺序不能改：先写 finishedAt/seconds 再调 saveJobOutput，meta.json 才能带上完成时间；
   * modelId 在落盘之后才覆盖（meta 里保留提交时的 preset.repo，与拆分前一致）。
   */
  async persistResult(job, results, { startedAt, modelId }) {
    if (this.disposed) {
      throw Object.assign(new Error('插件已卸载'), { code: 'disposed' })
    }
    job.finishedAt = isoNow()
    job.seconds = Math.round((Date.now() - startedAt) / 100) / 10
    const output = await saveJobOutput(this.ctx, job, results)
    if (this.disposed) {
      throw Object.assign(new Error('插件已卸载'), { code: 'disposed' })
    }
    job.output = output
    job.modelId = modelId ?? job.modelId
    job.status = 'done'
    job.stage = '完成'
    job.sessionState = this.session.snapshot().state
    this.options.onJobTelemetry?.('generate_done', {
      tool: job.tool ?? 'generate',
      provider: job.provider ?? '',
      presetId: job.presetId ?? '',
      device: job.device ?? '',
      count: job.output?.images?.length ?? job.params?.count ?? 1,
      seconds: job.seconds ?? 0,
      source: job.source ?? 'studio',
    })
  }

  /**
   * 取消收尾。
   *
   * 已完成的图片仍落盘（复用 saveJobOutput，与 persistResult 同一套写盘逻辑），但状态
   * 固定写 cancelled —— 绝不写成 done；一张都没完成时 output 保持 null，不生成空产物目录。
   * queued / waiting-session 的取消已由 cancel() 立即收尾（status 已是 cancelled），
   * 这里只补会话状态，不重复写 finishedAt、不覆盖已有 output。
   *
   * @param {object} job 被取消的任务
   * @param {{ startedAt?: number|null, results?: object[], modelId?: string|null }} [context]
   */
  async finalizeCancelled(job, { startedAt = null, results = [], modelId = null } = {}) {
    job.cancelRequested = true
    if (job.status === 'cancelled') {
      job.sessionState = sessionStateOf(this.session)
      if (job.finishedAt == null) job.finishedAt = isoNow()
      this.wakeWaiters(job.id)
      return
    }

    const completed = Array.isArray(results) ? results : []
    job.finishedAt = isoNow()
    if (Number.isFinite(startedAt)) job.seconds = Math.round((Date.now() - startedAt) / 100) / 10
    if (completed.length > 0 && !this.disposed) {
      job.output = await saveJobOutput(this.ctx, job, completed)
      job.modelId = modelId ?? job.modelId
    }
    job.status = 'cancelled'
    job.stage = '已取消'
    job.error = null
    job.sessionState = sessionStateOf(this.session)
    // 只记结构化摘要（jobId/张数），不记 prompt / negativePrompt 正文。
    log.info(
      `job_cancelled jobId=${job.id} disposition=cooperative images=${job.output?.images?.length ?? 0} ` +
        `total=${job.params.count}`,
    )
    this.wakeWaiters(job.id)
  }

  // ---- 等待 ---------------------------------------------------------------

  /** 唤醒并清理某个任务的全部等待者；同一 jobId 的等待者只唤醒一次。 */
  wakeWaiters(id) {
    const waiters = this.waiters.get(id)
    if (!waiters) return
    this.waiters.delete(id)
    for (const wake of waiters) wake()
  }

  /** 卸载时唤醒全部等待者，避免调用方永远挂在 pending Promise 上。 */
  wakeAllWaiters() {
    for (const id of [...this.waiters.keys()]) this.wakeWaiters(id)
  }

  /** 超时路径解除单个等待者登记（其他等待者不受影响）。 */
  removeWaiter(id, waiter) {
    const waiters = this.waiters.get(id)
    if (!waiters) return
    waiters.delete(waiter)
    if (waiters.size === 0) this.waiters.delete(id)
  }

  /**
   * 等待某个 job 结束；超时不抛错，返回当前快照。
   *
   * 事件驱动：任务进入终态时由 runNext 的收尾路径唤醒全部等待者。
   * 注册前先看一次当前状态（get 同步执行），覆盖「任务在 waitFor 之前已结束」的情况；
   * waitSeconds <= 0 或已终态时立即返回，不挂定时器。
   */
  async waitFor(id, waitSeconds = 0) {
    const current = this.get(id)
    if (!current) return null
    const seconds = Math.max(0, Math.min(600, Number(waitSeconds) || 0))
    if (seconds <= 0 || TERMINAL_STATUS.has(current.status) || this.disposed) return current

    return new Promise((resolve) => {
      let timer = null
      const finish = () => {
        if (timer) clearTimeout(timer)
        resolve(this.get(id))
      }
      timer = setTimeout(() => {
        this.removeWaiter(id, finish)
        finish()
      }, seconds * 1000)
      const waiters = this.waiters.get(id)
      if (waiters) waiters.add(finish)
      else this.waiters.set(id, new Set([finish]))
    })
  }

  dispose() {
    log.info(`dispose pending=${this.pending.length} running=${this.running?.id ?? 'none'}`)
    this.disposed = true
    this.pending = []
    this.abortController.abort(Object.assign(new Error('插件已卸载'), { code: 'disposed' }))
    // 先唤醒等待者再返回：卸载不应该让 waitFor 调用方挂到超时。
    this.wakeAllWaiters()
  }
}
