/**
 * 会话状态、阶段、任务状态与云端展示状态的文案查询。
 *
 * 界面上的云端状态只从这里派生：顶栏胶囊、状态条、弹层、对话页徽章共用
 * `computeStatusOf` / `jobProgressText`，避免同一个阶段出现两种说法。
 */

import { PROVIDER_IDS } from '../../shared/contract.js'
import { providerIdOf } from '../../shared/models-guide.js'

import { PHASE_STATE, TRANSIENT_SESSION } from '../constants.js'
import { localized } from '../i18n.js'
import { formatText } from './format.js'
import { queueLevelOf, queuePolicyOf, queueWaitMsOf } from './queue.js'

/**
 * 算力来源专属文案键：`<key>.<provider>`。
 *
 * 约定：字典里的基础键始终写 Kaggle 的口径（历史文案一个字都不改，Kaggle 用户看到的
 * 界面保持原样），Colab / 私有 Worker 的说法确实不同时才补 `<key>.<provider>` 变体。
 * 非法 / 缺失来源按契约默认来源归一，与模型卡门控、生成预检共用一份判定。
 *
 * @param {string} key 基础文案键
 * @param {unknown} provider 算力来源 id
 * @returns {string}
 */
export function providerCopyKeyOf(key, provider) {
  const id = providerIdOf(provider)
  return id === 'kaggle' ? key : `${key}.${id}`
}

/**
 * 取算力来源专属文案：有 `<key>.<provider>` 变体时用变体，否则回落基础键。
 * 两档都没有时返回空串，由调用方决定兜底（与 localized 的语义一致）。
 *
 * @param {(key: string) => string} t
 * @param {string} key 基础文案键
 * @param {unknown} provider 算力来源 id
 * @returns {string}
 */
export function providerText(t, key, provider) {
  const scoped = providerCopyKeyOf(key, provider)
  if (scoped !== key) {
    const text = localized(t, scoped)
    if (text) return text
  }
  return localized(t, key) || ''
}

/**
 * 会话实际所在的算力来源：**会话自己的 provider 优先**。
 *
 * 设置里切换来源后，旧会话可能仍在另一家跑（顶栏也按会话事实展示），
 * 这时阶段与排队文案必须跟着会话走，不能拿设置值去描述一个 Kaggle 会话。
 * 旧宿主快照没有 session.provider 时才回落到调用方给的设置值。
 *
 * @param {object|null} session
 * @param {unknown} [fallback] 当前设置的算力来源
 * @returns {string} 已知来源 id（kaggle / colab / private-worker / local-gpu）
 */
export function sessionProviderOf(session, fallback = '') {
  const own = session && typeof session.provider === 'string' ? session.provider : ''
  return providerIdOf(own || fallback)
}

export function sessionStateText(t, state) {
  const key = state ? `session.state.${state}` : 'session.state.absent'
  return localized(t, key) || (state ? String(state) : t('value.unknown'))
}

export function jobStatusText(t, status) {
  if (!status) return ''
  return localized(t, `job.status.${status}`) || String(status)
}

/**
 * 算力来源展示名：只认契约里登记过的来源，未知值返回空串（旧产物 / 旧宿主不猜）。
 * 顶栏胶囊、舞台出处与画廊角标共用同一份文案；新增来源只需补字典键。
 */
export function providerLabelOf(t, provider) {
  if (!PROVIDER_IDS.includes(provider)) return ''
  return localized(t, `studio.preset.providerName.${provider}`) || ''
}

/** 设备短名：`NVIDIA L4` → `L4`，用于舞台底部的窄条出处行。 */
export function deviceShortOf(device) {
  const text = typeof device === 'string' ? device.trim() : ''
  if (!text) return ''
  return text.replace(/^NVIDIA\s+/i, '').replace(/\s+/g, ' ')
}

export function phaseText(t, phase, provider = '') {
  if (!phase) return ''
  return providerText(t, `session.phase.${phase}`, provider)
}

/** 错误态里的「会话已结束」= 云端自己休眠/退出，不是连接故障，不该按红色异常展示。 */
function isAsleepSession(session) {
  return Boolean(
    session
    && session.state === 'error'
    && session.error
    && session.error.code === 'session_ended',
  )
}

/**
 * 把当前阶段翻译成"正在做什么、还要等多久"的一句话提示。
 * 没有对应文案时返回空串，由调用方回落到远端 detail / 错误说明。
 *
 * provider 只决定用哪一档文案：Colab 没有排队、也不在网页上留 Kernel，
 * 沿用 Kaggle 的「等待分配 GPU / 去 Kaggle 网页停 Kernel」会直接说错。
 *
 * @param {(key: string) => string} t
 * @param {object|null} session 宿主快照里的会话
 * @param {unknown} [provider] 当前设置的算力来源（会话自带 provider 时以会话为准）
 */
export function phaseHint(t, session, provider = '') {
  if (!session) return ''
  const state = typeof session.state === 'string' ? session.state : ''
  const phase = typeof session.phase === 'string' ? session.phase : ''
  const source = sessionProviderOf(session, provider)
  // 老快照可能没有 state，只有 phase：按 phase 回落到所属会话态。
  const resolved = state || PHASE_STATE[phase] || ''
  if (resolved === 'provisioning') {
    const key = phase === 'push'
      ? 'session.hint.push'
      : phase === 'queue'
        ? 'session.hint.queue'
        : 'session.hint.provisioning'
    return providerText(t, key, source)
  }
  if (isAsleepSession(session)) return localized(t, 'session.hint.asleep') || ''
  return resolved ? providerText(t, `session.hint.${resolved}`, source) : ''
}

/** 语义色调，与 CSS 的 .is-ok / .is-warn / .is-error / .is-idle 一一对应。 */
function toneOf(state, asleep) {
  if (asleep) return 'idle'
  if (state === 'ready') return 'ok'
  if (state === 'error') return 'error'
  if (TRANSIENT_SESSION[state] === true) return 'warn'
  return 'idle'
}

/** 错误态按错误码给短标签：比统一的「云端异常」更容易定位，长原因仍交给指引卡。 */
const ERROR_LABEL_KEY = {
  auth_required: 'session.state.errorAuth',
  cli_missing: 'session.state.errorCli',
  push_failed: 'session.state.errorPush',
  queue_timeout: 'session.state.errorTimeout',
  tunnel_timeout: 'session.state.errorTimeout',
  session_timeout: 'session.state.errorTimeout',
  // 私有 Worker 的三类可执行错误：不可达 / 鉴权 / 协议 / 能力。
  worker_unreachable: 'session.state.errorUnreachable',
  worker_unauthorized: 'session.state.errorUnauthorized',
  protocol_mismatch: 'session.state.errorProtocol',
  capability_missing: 'session.state.errorCapability',
  artifact_failed: 'session.state.errorArtifact',
}

/** 胶囊短标签的文案键：申请 GPU 阶段再按 phase 细分推送与排队。 */
function labelKeyOf(state, phase, session, asleep) {
  if (asleep) return 'session.state.asleep'
  // 用户主动关机后会话停在 absent；和「从未启动」分开说，避免误导成可自动启动。
  if (state === 'absent' && session && session.stoppedByUser === true) return 'session.state.asleep'
  if (state === 'provisioning') {
    if (phase === 'push') return 'session.state.push'
    // Colab 的 queue 阶段是「启动远端运行时」，没有排队等 GPU 这回事。
    if (phase === 'queue') return 'session.state.queue'
  }
  if (state === 'error') {
    const code = session && session.error && session.error.code
    return ERROR_LABEL_KEY[code] || 'session.state.error'
  }
  return `session.state.${state}`
}

/**
 * 云端展示状态：胶囊标签、语义色调、阶段、等待提示与可执行动作。
 *
 * 排队分级只影响等待提示：超过慢档把「正在排队」换成「排队比平时久」，
 * 卡片（10 分钟档）由组合层另行派生，不改变胶囊标签与色调。
 *
 * @param {(key: string) => string} t
 * @param {{
 *   session?: object|null,
 *   provider?: string,
 *   queuePolicy?: { slowMs: number, stalledMs: number },
 *   now?: number,
 * }} input 宿主快照里的会话（或 compute.session）、当前算力来源、排队阈值与当前时刻
 */
export function computeStatusOf(t, input = {}) {
  const session = input && input.session ? input.session : null
  const state = session && typeof session.state === 'string' && session.state ? session.state : 'absent'
  const phase = session && typeof session.phase === 'string' ? session.phase : ''
  // 文案跟随会话事实：设置切到 Colab 但旧会话仍在 Kaggle 时，阶段说明不能改成 Colab 口径。
  const provider = sessionProviderOf(session, input && input.provider)
  const asleep = isAsleepSession(session)
  const stopped = state === 'absent' && Boolean(session && session.stoppedByUser === true)
  // 排队分级：阈值来自 /state.queuePolicy，旧宿主缺失时按契约兜底；now 由调用方传入便于测试。
  // 传入值再走一次归一化，避免调用方直接传 0 / 负数时把提示误判成卡住。
  const policy = queuePolicyOf({ queuePolicy: input && input.queuePolicy })
  const queueWaitMs = queueWaitMsOf(session, input && input.now)
  const queueLevel = queueLevelOf(queueWaitMs, policy)
  // 休眠/结束统一用「已关闭」的标签与说明；其余状态与状态机一一对应。
  const label = providerText(t, labelKeyOf(state, phase, session, asleep), provider) || sessionStateText(t, state)
  const baseHint = phaseHint(t, session, provider) || (stopped ? localized(t, 'session.hint.asleep') : '')
  // 排队比平时久：只换这一句提示，不弹卡、不改变状态色调（10 分钟档才给可操作卡片）。
  const hint = queueLevel ? providerText(t, 'session.hint.queueSlow', provider) || baseHint : baseHint
  const errorMessage = session && session.error && typeof session.error.message === 'string'
    ? session.error.message.split('\n')[0].trim()
    : ''
  let tooltip = hint
  if (state === 'ready') tooltip = providerText(t, 'studio.compute.idleTooltip', provider) || hint
  else if (asleep || stopped) tooltip = providerText(t, 'studio.compute.asleepTooltip', provider) || hint
  else if (state === 'absent') tooltip = providerText(t, 'studio.compute.offlineTooltip', provider) || hint
  else if (state === 'error') tooltip = localized(t, 'studio.compute.errorTooltip') || errorMessage
  return {
    state,
    phase,
    asleep,
    stopped,
    tone: toneOf(state, asleep || stopped),
    label,
    hint,
    tooltip,
    phaseLabel: phaseText(t, phase, provider),
    // 排队分级：'slow' 只改提示，'stalled' 由组合层加一张「换新实例重排」横幅。
    queueLevel,
    queueWaitMs,
    // 过渡态：需要持续刷新进度、显示状态条并计时的状态。
    transient: TRANSIENT_SESSION[state] === true,
    // 正在启动/等待云端（stopping 不计时）。
    starting: state === 'provisioning' || state === 'connecting' || state === 'warming',
    ready: state === 'ready',
    canStart: state === 'absent' || state === 'error',
    canStop: state !== 'absent',
  }
}

/**
 * 空闲关机倒计时：只从宿主快照里已经存在的两个字段派生。
 *
 * `session.idleSeconds` 来自远端 /health（仅在有 /health 的会话态才有值），
 * `session.idleTimeoutSec` 是当前生效的自动关机阈值。任一缺失、或空闲不足
 * 一分钟时不展示——宁可暂时不显示，也不给「已空闲 0 分钟」这种假读数。
 *
 * @param {object|null} session 宿主快照里的会话
 * @returns {{ idleSeconds: number, idleMinutes: number, totalMinutes: number } | null}
 */
export function idleShutdownOf(session) {
  if (!session || typeof session !== 'object') return null
  const idleSeconds = Number(session.idleSeconds)
  const timeoutSeconds = Number(session.idleTimeoutSec)
  if (!Number.isFinite(idleSeconds) || !Number.isFinite(timeoutSeconds)) return null
  if (idleSeconds <= 0 || timeoutSeconds <= 0) return null
  const idleMinutes = Math.floor(idleSeconds / 60)
  if (idleMinutes < 1) return null
  return {
    idleSeconds: Math.floor(idleSeconds),
    idleMinutes,
    totalMinutes: Math.max(1, Math.round(timeoutSeconds / 60)),
  }
}

/**
 * 宿主的结构化阶段码；缺字段时按 job.status 回落，兼容旧版本宿主。
 *
 * `cancelled` 是终态而非「正在做的事」：它只用于把任务收敛成「已取消」文案，
 * 取消中的 running 任务靠 `cancelRequested` 单独提示「正在停止…」。
 */
const STAGE_CODES = new Set(['queued', 'waiting-session', 'loading', 'running', 'done', 'failed', 'cancelled'])

function stageCodeOf(job) {
  // 任务一旦收敛为 cancelled，即便旧宿主残留 stageCode=running 也按终态展示。
  if (job.status === 'cancelled') return 'cancelled'
  const code = typeof job.stageCode === 'string' ? job.stageCode : ''
  if (STAGE_CODES.has(code)) return code
  // 旧宿主没有 stageCode：status 与阶段码同名，可直接回溯。
  return STAGE_CODES.has(job.status) ? job.status : ''
}

/**
 * 分张进度：宿主只给「已完成张数」，这里换算成「正在出第几张」并夹在 1..total。
 * 单张任务不显示计数（宿主同样只在 total > 1 时给阶段追加计数）。
 */
export function jobCountOf(job) {
  const progress = job && job.progress
  if (!progress || typeof progress !== 'object') return null
  const done = Number(progress.done)
  const total = Number(progress.total)
  if (!Number.isFinite(done) || !Number.isFinite(total)) return null
  const count = Math.floor(total)
  if (count <= 1) return null
  return { done: Math.min(Math.max(0, Math.floor(done)) + 1, count), total: count }
}

/**
 * 「第 N/M 张」文案：流水线生成节点与舞台进度胶囊共用同一份口径，
 * 单张或没有进度时返回空串。
 */
export function jobCountText(t, job) {
  const count = jobCountOf(job)
  if (!count) return ''
  return formatText(localized(t, 'studio.pipeline.count'), count)
}

/**
 * 活动任务的进度文案。
 *
 * 关键区分：「等在云端就绪」和「等前一张图画完」是两件事，不能都说成「正在申请 GPU」。
 * 阶段只认宿主下发的 stageCode：job.stage 是宿主硬编码的中文，英文界面不能直接展示。
 *
 * 取消语义：running 任务收到取消请求后不会再提交剩余张数，但当前这张仍要画完，
 * 因此先给「正在停止…」而不是直接说「已取消」；真正进入终态后才显示「已取消」。
 *
 * @param {(key: string) => string} t
 * @param {object|null} job 进行中的任务
 * @param {string} sessionState 当前会话状态
 */
export function jobProgressText(t, job, sessionState) {
  if (!job) return ''
  const stage = stageCodeOf(job)
  if (stage === 'cancelled') return jobStatusText(t, 'cancelled')
  if (job.cancelRequested === true) return localized(t, 'studio.job.cancelling') || ''
  if (stage === 'running') {
    const progress = jobCountOf(job)
    if (progress) {
      const text = formatText(localized(t, 'studio.progress.generatingCount'), progress)
      if (text) return text
    }
    return localized(t, 'studio.progress.running') || ''
  }
  if (stage === 'loading') {
    return localized(t, 'studio.progress.loading') || localized(t, 'studio.progress.waitingSession') || ''
  }
  if (stage === 'waiting-session') return localized(t, 'studio.progress.waitingSession') || ''
  if (stage === 'queued') {
    const key = sessionState === 'ready' ? 'studio.progress.queued' : 'studio.progress.waitingSession'
    return localized(t, key) || ''
  }
  return jobStatusText(t, job.status)
}

/**
 * 「已等待」时长：只在申请 GPU（push / queue）阶段计时。
 *
 * `startedAt` 是整段会话的起点；会话重连或从本地恢复后它不会重置，
 * 若拿去算 connecting / warming 的等待时长，会显示成小时级的会话运行时长。
 * 申请 GPU 阶段不会中途重连，用它可以得到可信的排队耗时。
 */
export function sessionElapsedMs(session, now) {
  if (!session || session.state !== 'provisioning') return null
  const start = Date.parse(String(session.startedAt ?? ''))
  if (!Number.isFinite(start)) return null
  const current = Number.isFinite(now) ? now : Date.now()
  return Math.max(0, current - start)
}
