/**
 * 远端会话生命周期（协议见 docs/SPEC.md 第 1、2 节）。
 *
 * 一次会话 = 一个常驻 Kaggle Kernel + 一条 Cloudflare 隧道：
 *   push → 排队 → 隧道上报 → health 握手 → ready
 * 模型只在 Kernel 内加载一次，后续出图复用同一进程，避免重复排队。
 *
 * 并发模型：start / stop / dispose 都会让「启动代次（epoch）」递增。任何跨越
 * await 的异步步骤（push、轮询、心跳恢复）在恢复执行时都必须校验代次；过期
 * 流程只做清理，不得再写会话状态、不得重新挂轮询定时器——否则用户点「关机」
 * 之后，还在飞的 push 会把会话复活成僵尸轮询。
 *
 * 状态机本体（启动编排、定时器与代次管理、停止与失败收敛）在本类里，
 * 协作者与纯数据/纯协议逻辑拆分在 ./session/ 下，便于按职责阅读与离线断言：
 *  - ./session/state.js           会话快照形状、字段初始值、失败状态写入、隧道通道归一
 *  - ./session/persistence.js     会话记录的原子读写（`.aigc-studio/session.json`）
 *  - ./session/pending-cleanup.js 卸载未关机补清理记录（`.aigc-studio/pending-cleanup.json`）
 *  - ./session/provisioner.js     下发给 daemon 的注入配置（纯函数）
 *  - ./session/rendezvous.js      ntfy 会合消息解析与超时判定（纯函数）
 *  - ./session/health.js          /health 响应解释与掉线恢复决策（纯函数）
 *  - ./session/tunnel-watcher.js  ntfy 会合轮询与建连超时监控
 *  - ./session/health-monitor.js  /health 心跳探活、掉线恢复与 Kernel 状态轮询
 *  - ./session/restorer.js        启动恢复与 pending-cleanup 补关机
 *
 * 会话记录用于 DSH 重启 / 插件热重载后的恢复：启动流程在关键节点把 kernelId、token、
 * topic、endpoint 等写入工作区，`restore()` 在下次启动时先探活、再决定重连或清理远端，
 * 避免内存状态丢失后 Kaggle GPU 继续空烧配额。token 只落盘，不进日志、不进快照。
 *
 * 卸载路径的取舍：`dispose()` 不阻塞卸载，关机通知只是 best-effort；通知没发出或失败时，
 * 同步把「待清理会话」写入工作区，下次启动由 `cleanupPendingSession()` 先补发一次关机，
 * 再执行 `restore()`，避免 Kernel 空烧每周 GPU 配额。
 */

import { randomBytes } from 'node:crypto'

import { PROVIDER_IDS, SETTINGS, TIMEOUTS } from '../shared/contract.js'
import { normalizeModelSource } from '../shared/validation.js'
import { resolveVariant } from '../shared/variants.js'
import { kaggleUsername, kernelLogs, kernelStatus, pushKernel } from './kaggle.js'
import { buildKernelFolder, removeKernelFolder } from './kernel.js'
import { createLogger } from './log.js'
import { presetById } from './presets.js'
import { createProvider, instanceLostMessage, isCloudApiProvider, isWorkerProvider, providerMetaOf } from './providers/index.js'
import { ProviderError, providerIdOf } from './providers/provider.js'
import { logText } from './redact.js'
import { isTrustedEndpoint, requestShutdown } from './remote.js'
import { isKernelAlive, isKernelQueued } from './session/health.js'
import { applyHealthDetails as writeHealthDetails, applyHealthState as writeHealthState, checkHealth } from './session/health-monitor.js'
import { buildSessionRecord, clearSessionRecord, readSessionRecord, writeSessionRecord } from './session/persistence.js'
import { buildPendingCleanupRecord, clearPendingCleanup, writePendingCleanupSync } from './session/pending-cleanup.js'
import { buildKernelConfig } from './session/provisioner.js'
import { cleanupPendingSession as runPendingCleanup, runRestore as executeRestore } from './session/restorer.js'
import { ACTIVE_STATES, createSessionFields, emptySession, isoNow, normalizeTunnelProvider, snapshotOf, writeFailure } from './session/state.js'

// 时序与阈值统一取自 shared/contract.js 的 TIMEOUTS（唯一来源），本文件不再保留默认值：
//  - kernelPollMs：ready 之后仍要低频轮询 Kernel 状态 —— daemon 空闲退出 / 被平台回收时，
//    只有 Kernel 状态能证明会话已经结束（隧道断了 health 只是失败，不说明原因）；
//  - readyHealthMissesBeforeCheck：ready 阶段心跳连续失败多少次才去查 Kernel，避免一次网络抖动就重置隧道；
//  - reconnectMaxAttempts：ready 阶段允许的「重取隧道地址」轮数；超过即判定会话失效，不再无限抖动；
//  - recoveryMs：ready 失联后的单轮恢复窗口；只要向 Kaggle 确认 Kernel 仍 RUNNING 就按
//    recoveryMaxRenewals 续期，续期用尽才 health_failed（不再一次超时就放弃）；
//  - remoteShutdownMs：best-effort 关机通知的最长等待时间（不阻塞调用方）。

/**
 * 远端调用默认实现。测试可用 `new SessionManager({ deps })` 注入假实现，
 * 这样会话状态机可以离线回归（不需要 kaggle CLI / Kaggle 队列 / GPU）。
 */
const DEFAULT_DEPS = {
  buildKernelFolder,
  removeKernelFolder,
  kaggleUsername,
  pushKernel,
  kernelStatus,
  kernelLogs,
  requestShutdown,
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 模块级日志器：会话状态机的关键事件默认从 Host 日志出口落盘（文件 sink 由 lib/log.js
 * 进程级安装，写入时查询安装状态）。测试注入 `deps.log` 时以注入的 sink 为准。
 */
const log = createLogger({ scope: 'session' })

/** 失败现场抢救的 Kernel 日志尾上限：约 30 行 / 4000 字符。 */
const KERNEL_TAIL_MAX_LINES = 30
const KERNEL_TAIL_MAX_CHARS = 4000

/**
 * 再次 start() 时允许先检查并接管原 Kernel 的错误码：
 * 仅限等待/连通类异常（远端可能仍在排队或正常运行）；push_failed / auth_required /
 * gpu_unavailable / remote_error / session_ended 均直接走新推流程。
 */
const REATTACHABLE_ERROR_CODES = new Set(['queue_timeout', 'tunnel_timeout', 'health_failed'])

/** 轮询期间的会话记录写盘节流：状态没变化时不值得每拍都写一次文件。 */
const PERSIST_THROTTLE_MS = 60 * 1000

export class SessionManager {
  constructor({ ctx, defaultPreset, options = {}, deps = {} }) {
    this.ctx = ctx
    this.defaultPreset = defaultPreset
    this.deps = { ...DEFAULT_DEPS, ...deps }
    // 测试注入 deps.log 时沿用注入 sink；生产走模块级 logger（文件 sink 由 lib/log.js 统一接管）。
    this.log = deps.log ? createLogger({ scope: 'session', sink: deps.log }) : log
    this.options = {
      accelerator: 'NvidiaTeslaT4',
      kernelTimeoutSec: TIMEOUTS.kernelRunMaxSec,
      idleTimeoutSec: TIMEOUTS.idleShutdownSec,
      provisionTimeoutMs: TIMEOUTS.provisionMs,
      tunnelTimeoutMs: TIMEOUTS.tunnelMs,
      healthyIntervalMs: TIMEOUTS.healthyPollMs,
      // ready 阶段失联后允许的重新会合时长，超过即判定会话失效。
      recoveryTimeoutMs: TIMEOUTS.recoveryMs,
      // 恢复窗口续期轮数：每次确认 Kernel 仍 RUNNING 续一轮，用尽才放弃。
      recoveryMaxRenewals: TIMEOUTS.recoveryMaxRenewals,
      // 会合/健康轮询与 Kernel 状态轮询的间隔，测试可调小以加速离线回归。
      tickMs: TIMEOUTS.sessionTickMs,
      kernelPollMs: TIMEOUTS.kernelPollMs,
      // 排队分级阈值（下发给客户端做「3 分钟软提示 / 10 分钟重排卡片」）。
      queueSlowMs: TIMEOUTS.queueSlowMs,
      queueStalledMs: TIMEOUTS.queueStalledMs,
      ntfyBase: 'https://ntfy.sh',
      devEndpoint: null,
      devToken: null,
      sourcePath: null,
      enableGpu: true,
      // 备用隧道（自建 FRP 等）的域名后缀，用于 Host 侧校验会合地址可信。
      trustedTunnelDomains: [],
      ...options,
    }
    // 字段初始值来自 state.js，但仍挂在实例上（测试直接断言这些字段）。
    Object.assign(this, createSessionFields(this.options))
    // 轮询单飞表：同一轮询上一拍还在飞时复用同一个 Promise（见 singleFlight）。
    this.polling = new Map()
    // 心跳恢复代数：每次 /health 恢复即递增，使并发中的 handleReadyHealthLoss 失效。
    this.healthEpoch = 0
    // 失败现场抢救去重：同一个 Kernel 只拉一次日志尾，避免失败路径重复打远端。
    this.rescuedKernels = new Set()
    // 远端能力协商（协议 v2）：/health.capabilities 的内存快照，不进对外 state。
    // JobQueue 用它决定 binary / SSE 是否可用；旧 daemon 没有该字段时保持 null。
    this.remoteCapabilities = null
    // 远端算力 Provider：默认按静态配置里的来源；`deps.provider` 可由测试直接注入。
    // 现有 deps 键名原样透传，所以 `new SessionManager({ deps: { pushKernel } })` 仍然有效。
    // 来源与实现的映射统一走注册表（server/providers/index.js），状态机不再认识具体类名。
    this.provider =
      deps.provider ??
      createProvider(this.desiredProviderId(this.options), {
        ctx,
        deps: this.deps,
        log: this.log,
        manager: this,
        options: this.options,
      })
    // 每次启动/停止换代都换一只 AbortController：provider 用它立刻掐断在飞的请求与 WS。
    this.abortController = new AbortController()
    // provider 私有句柄（kernelId / folderDir 等）；M1 只驻留内存，落盘格式保持不变。
    this.handle = null
    // 最近一次真正发起启动的调用方：'job' 表示由生成队列自动拉起。
    // 最后一个等待启动的任务被取消时，队列据此回收不再需要的实例；
    // 用户手动唤醒的会话不会被任务取消路径误伤。
    this.startInitiator = null
  }

  snapshot() {
    const value = snapshotOf(this.session)
    // 用户主动关机标记：客户端据此区分「从未启动」与「已手动关闭」，不再承诺自动启动。
    value.stoppedByUser = this.stoppedByUser === true
    return value
  }

  /** 供任务执行器取用的一次性连接信息；不进入任何对外快照。 */
  connection() {
    return { endpoint: this.session.endpointUrl, token: this.secret.token }
  }

  /**
   * 远端能力位（协议 v2）：`/health.capabilities` 的只读快照。
   * 旧 daemon 没有该字段时返回 null；调用方必须按「不支持」处理，不能假设 binary / SSE。
   */
  capabilities() {
    return this.remoteCapabilities && typeof this.remoteCapabilities === 'object'
      ? this.remoteCapabilities
      : null
  }

  get isActive() {
    return ACTIVE_STATES.has(this.session.state)
  }

  get isReady() {
    return this.session.state === 'ready'
  }

  /** 当前这一轮启动是否由生成队列发起（只读，用于取消任务时判断实例归属）。 */
  get startedByJob() {
    return this.startInitiator === 'job'
  }

  /**
   * 排队分级阈值（`/state.queuePolicy` 下发客户端）。
   *
   * 两档都可以被插件配置覆盖（index.js 的 queueSlowMinutes / queueStalledMinutes）；
   * 非法值回落到契约默认值，且保证「卡住」不早于「变慢」。
   */
  queuePolicy() {
    const slow = Number(this.options.queueSlowMs)
    const stalled = Number(this.options.queueStalledMs)
    const slowMs = Number.isFinite(slow) && slow > 0 ? slow : TIMEOUTS.queueSlowMs
    const stalledMs = Number.isFinite(stalled) && stalled > 0 ? stalled : TIMEOUTS.queueStalledMs
    return { slowMs, stalledMs: Math.max(slowMs, stalledMs) }
  }

  /**
   * 删除一个已经放弃的 Kernel（best-effort）。
   *
   * 排队超时 / 主动关机 / 强制重排时调用：旧 Kernel 还留在 Kaggle 队列里，之后可能被
   * 调度到并空转（最长 idleShutdownSec）。删除后就不会再有可执行任务；删除失败只记
   * 日志，由远端 claim 超时兜底（daemon 启动后无人接管会自行退出）。
   *
   * provider.deleteKernel 未实现（离线测试的假 provider）时直接跳过，不产生任何 I/O。
   *
   * @param {string | null | undefined} kernelId
   * @param {string} reason 日志归因（queue_timeout / force_new / requeue / stop_queued）
   * @returns {Promise<boolean>} 是否确认已删除（已不存在也算成功）
   */
  discardStaleKernel(kernelId, reason = 'abandoned') {
    const id = typeof kernelId === 'string' ? kernelId.trim() : ''
    if (!id || this.options.devEndpoint) return Promise.resolve(false)
    if (typeof this.provider.deleteKernel !== 'function') return Promise.resolve(false)
    return Promise.resolve()
      .then(() => this.provider.deleteKernel(id))
      .then((result) => {
        if (result?.ok) {
          this.log.info(`stale_kernel_deleted kernelId=${id} reason=${reason} missing=${Boolean(result.missing)}`)
          return true
        }
        this.log.warn(
          `stale_kernel_delete_failed kernelId=${id} reason=${reason} detail=${logText(result?.output ?? 'unknown', 200)}`,
        )
        return false
      })
      .catch((error) => {
        this.log.debug(`stale_kernel_delete_error kernelId=${id} reason=${reason}`, logText(error?.message ?? error, 200))
        return false
      })
  }

  // ---- 运行设置 -----------------------------------------------------------

  /**
   * 把配置 / 快照里的来源归一成已登记的 id；未知值回退契约默认来源。
   *
   * 允许「已登记但尚未开放选择」的来源（M3.0 的 private-worker / local-gpu）：
   * 设置里暂时选不到，但静态 config 或测试注入可以提前走通状态机。
   */
  desiredProviderId(source) {
    const raw = typeof source === 'string' ? source : source?.provider
    return PROVIDER_IDS.includes(raw) ? raw : SETTINGS.defaultProvider
  }

  /**
   * 启动前读取最新合并设置（工作台设置抽屉的覆盖项 + 插件静态 config）。
   *
   * `deps.getSettings` 是可选注入：测试不传时完全沿用 this.options，行为与改造前一致。
   * 读取本身或返回值异常时整体回退 options；缺字段按字段回退，绝不让设置读取影响启动流程。
   */
  effectiveSettings() {
    const options = this.options ?? {}
    const fallbackIdle = Number.isFinite(options.idleTimeoutSec)
      ? Math.min(SETTINGS.idleTimeoutSec.max, Math.max(SETTINGS.idleTimeoutSec.min, Math.round(options.idleTimeoutSec)))
      : TIMEOUTS.idleShutdownSec
    const fallback = {
      idleTimeoutSec: fallbackIdle,
      accelerator: options.accelerator,
      hfToken: typeof options.hfToken === 'string' && options.hfToken.trim() ? options.hfToken.trim() : null,
      modelSource: normalizeModelSource(options.modelSource),
      datasetSources: Array.isArray(options.datasetSources) ? options.datasetSources : [],
      localModels:
        options.localModels && typeof options.localModels === 'object' && !Array.isArray(options.localModels)
          ? options.localModels
          : null,
      pipConstraints: Array.isArray(options.pipConstraints) ? options.pipConstraints : [],
      provider: PROVIDER_IDS.includes(options.provider) ? options.provider : SETTINGS.defaultProvider,
      colabGpu: SETTINGS.colabGpus.includes(options.colabGpu) ? options.colabGpu : SETTINGS.defaultColabGpu,
      colabHighRam: options.colabHighRam === true,
    }

    let raw
    try {
      raw = typeof this.deps.getSettings === 'function' ? this.deps.getSettings() : null
    } catch {
      return fallback
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback

    const idle = Number(raw.idleTimeoutSec)
    return {
      idleTimeoutSec: Number.isFinite(idle)
        ? Math.min(SETTINGS.idleTimeoutSec.max, Math.max(SETTINGS.idleTimeoutSec.min, Math.round(idle)))
        : fallback.idleTimeoutSec,
      accelerator:
        typeof raw.accelerator === 'string' && SETTINGS.accelerators.includes(raw.accelerator)
          ? raw.accelerator
          : fallback.accelerator,
      hfToken:
        raw.hfToken === undefined
          ? fallback.hfToken
          : typeof raw.hfToken === 'string' && raw.hfToken.trim()
            ? raw.hfToken.trim()
            : null,
      modelSource:
        raw.modelSource === undefined
          ? fallback.modelSource
          : normalizeModelSource(raw.modelSource),
      datasetSources: Array.isArray(raw.datasetSources)
        ? raw.datasetSources.filter((item) => typeof item === 'string')
        : fallback.datasetSources,
      localModels:
        raw.localModels === undefined
          ? fallback.localModels
          : raw.localModels && typeof raw.localModels === 'object' && !Array.isArray(raw.localModels)
            ? raw.localModels
            : null,
      pipConstraints: Array.isArray(raw.pipConstraints)
        ? raw.pipConstraints.filter((item) => typeof item === 'string')
        : fallback.pipConstraints,
      provider: SETTINGS.providers.includes(raw.provider) ? raw.provider : fallback.provider,
      colabGpu: SETTINGS.colabGpus.includes(raw.colabGpu) ? raw.colabGpu : fallback.colabGpu,
      colabHighRam: raw.colabHighRam === true || (fallback.colabHighRam && raw.colabHighRam !== false),
    }
  }

  // ---- 状态跃迁打点 -------------------------------------------------------

  /**
   * 统一状态/阶段写入点（状态机的所有跃迁都必须经过这里）。
   *
   * 收口目的：`transition(from -> to, phase, epoch, presetId, elapsedMs)` 不漏记；
   * 日志只写状态与时长，不写 detail/错误正文，避免把 token 或用户路径带进 Host 日志。
   *
   * @param {string} nextState 目标状态
   * @param {{ phase?: string | null, elapsedMs?: number }} [options]
   *   phase 省略时保留当前阶段；显式传 null 表示进入无阶段状态。
   */
  transition(nextState, { phase = undefined, elapsedMs = undefined } = {}) {
    const from = this.session.state
    const fromPhase = this.session.phase ?? null
    this.session.state = nextState
    if (phase !== undefined) this.session.phase = phase ?? null
    const toPhase = this.session.phase ?? null
    // 状态与阶段都没变时不重复记（同一拍重复调用 transition 不应刷屏）。
    if (from === nextState && fromPhase === toPhase) return
    this.logTransition(from, nextState, { fromPhase, phase: toPhase, elapsedMs })
  }

  /** 只记一条跃迁日志：用于 `this.session` 被整体替换（stop 清理 / restore 接管记录）的场景。 */
  logTransition(from, to, { fromPhase = null, phase = null, elapsedMs = undefined } = {}) {
    const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : this.elapsedMs()
    this.log.info(
      `transition ${from ?? 'null'} -> ${to} phase=${phase ?? 'null'} fromPhase=${fromPhase ?? 'null'} ` +
        `epoch=${this.epoch} presetId=${this.session.presetId ?? this.defaultPreset ?? '-'} ` +
        `elapsedMs=${Math.max(0, Math.round(Number(elapsed) || 0))}`,
    )
  }

  // ---- 代次与定时器 -------------------------------------------------------

  /** 该代次是否已被 stop / dispose / 新的 start 作废。 */
  isStale(epoch) {
    return this.disposed || epoch !== this.epoch
  }

  /** 过期的异步结果不允许再写会话状态（尤其不能覆盖 error）。 */
  canPoll(epoch) {
    return !this.isStale(epoch) && this.session.state !== 'error'
  }

  /**
   * 挂一个轮询循环：上一拍的 Promise settle 后才安排下一拍（单飞自调度延时链）。
   *
   * 不用 setInterval：网络慢或 kaggle.exe 慢时，固定间隔会让下一拍与上一拍重叠执行、
   * 叠加子进程。这里每拍结束后才排下一次，且 handle.active 由 clearTimers() 关闭，
   * 保证 clearTimers() 之后即使正在飞的一拍结束也不会重新排期。
   * 返回的句柄放进 this.timers（每个循环 1 个条目），clearTimers() 统一取消。
   */
  every(fn, ms) {
    const handle = { timer: null, active: true }
    const tick = () => {
      handle.timer = null
      if (!handle.active) return
      Promise.resolve()
        .then(fn)
        .catch((error) => this.log.warn('轮询异常（已忽略，状态保持不变）', logText(error?.message ?? error, 200)))
        .then(() => {
          if (!handle.active) return
          handle.timer = setTimeout(tick, ms)
        })
    }
    handle.timer = setTimeout(tick, ms)
    this.timers.add(handle)
    return handle
  }

  clearTimers() {
    for (const handle of this.timers) {
      handle.active = false
      if (handle.timer) clearTimeout(handle.timer)
    }
    this.timers.clear()
  }

  /**
   * 轮询单飞：同名轮询上一拍还在飞时复用同一个 Promise，避免立即首拍与已排期的一拍
   * （或切换轮询节奏时残留的一拍）重叠执行。
   *
   * 异常原样上抛给 every() 的 catch 记录 warn，不在这里吞掉；finally 清掉占位，
   * 保证某一拍失败后，后续拍不会被「永远在飞」的旧 Promise 挡住。
   */
  singleFlight(name, run) {
    const pending = this.polling.get(name)
    if (pending) return pending
    const promise = Promise.resolve()
      .then(run)
      .finally(() => {
        if (this.polling.get(name) === promise) this.polling.delete(name)
      })
    this.polling.set(name, promise)
    return promise
  }

  // ---- 本地持久化 ---------------------------------------------------------

  /**
   * 把当前会话关键字段写入 `<workspace>/.aigc-studio/session.json`。
   *
   * 轮询中默认按 60s 节流（force 用于启动流程的关键节点）。写入失败只记 debug：
   * 记录只是恢复的辅助信息，不能反过来影响会话状态机。返回写入链，便于测试等待。
   */
  persistSession({ force = false } = {}) {
    // 商业生图 API 没有可恢复的远端会话：记录里只有 API Key，绝不能写进 session.json。
    if (isCloudApiProvider(this.provider.id)) return this.persistChain
    const now = Date.now()
    if (!force && now - this.lastPersistAt < PERSIST_THROTTLE_MS) return this.persistChain
    const record = buildSessionRecord(this.session, this.secret, { provider: this.provider.id, handle: this.handle })
    if (!record) return this.persistChain
    this.lastPersistAt = now
    this.persistChain = this.persistChain
      .then(() => writeSessionRecord(this.ctx, record))
      .catch((error) => {
        this.log.debug('会话记录写入失败（不影响会话状态）', logText(error?.message ?? error, 200))
      })
    return this.persistChain
  }

  /** 删除本地会话记录（best-effort）。先等挂起的写入结束，避免删除后被迟到的写入复活。 */
  clearPersistedSession() {
    return Promise.resolve(this.persistChain)
      .catch(() => undefined)
      .then(() => clearSessionRecord(this.ctx))
  }

  /**
   * 卸载：不阻塞、不 await（卸载路径必须立刻返回）。
   *
   * 关机通知是 best-effort：先同步把「待清理会话」写入
   * `<workspace>/.aigc-studio/pending-cleanup.json`（进程随时可能退出，异步写来不及），
   * 再尽力通知远端退出。收尾规则：
   *  - 关机成功：清掉待清理记录与会话记录；
   *  - 关机失败：保留待清理记录（下次启动优先补发一次关机），并清掉会话记录
   *    （用户明确是「退出」，不要让下次启动的 restore() 去接手 / 长等会合）；
   *  - 没有可清理信息且关机未成功：保留会话记录，交给下次启动的 restore() 兜底。
   *
   * 重复调用是幂等的（只执行第一次），测试与宿主多次卸载不会重复补发。
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.epoch += 1
    this.renewAbort()
    this.starting = null
    this.startingEpoch = null
    this.clearTimers()
    // 同步落盘：dispose() 返回后进程可能立刻退出，异步写没有机会完成。
    const record = this.pendingCleanupRecord()
    const handedOff = record ? writePendingCleanupSync(this.ctx, record) : false
    // DSH 退出 / 插件热重载前尽力通知远端退出，否则 Kernel 会继续烧每周 GPU 配额。
    const pending = this.shutdownRemote()
    this.disposeCleanup = Promise.resolve(pending)
      .then(async (ok) => {
        if (ok) await clearPendingCleanup(this.ctx)
        // 关机成功，或失败但已把「补发关机」责任移交下次启动：都删掉会话记录。
        if (ok || handedOff) await this.clearPersistedSession()
        return null
      })
      .catch((error) => {
        this.log.debug('卸载时清理本地记录失败（忽略）', logText(error?.message ?? error, 200))
        return null
      })
  }

  /**
   * 组装卸载时的待清理记录（只含补发 /shutdown 所需的最小信息）。
   *
   * 开发模式直连本地 Daemon，没有 Kaggle 配额风险，不落盘待清理记录。
   * 返回 null 表示没有可清理的远端信息（或不需要补清理）。
   */
  pendingCleanupRecord() {
    if (this.options.devEndpoint) return null
    // 能力位：共享私有 Worker 没有需要补清理的远端资源（默认只断开、不关机），
    // 不落盘待清理记录；notebook 与本机 GPU（owned）由 provider 生成记录。
    if (providerMetaOf(this.provider.id)?.pendingCleanup === false) return null
    // 记录有效性由 provider 决定：Kaggle 需要 endpointUrl + token，
    // Colab 只需要 assignment endpoint（拿到隧道地址前卸载也能回收实例）。
    if (typeof this.provider.buildPendingCleanupRecord === 'function') {
      return this.provider.buildPendingCleanupRecord(this.session, this.secret)
    }
    // 通用记录是 notebook 形状（v1：kernelId/topic/endpointUrl）：worker 型必须自带记录构造，
    // 不能把 Worker 地址写成 Kaggle 记录（否则下次启动会按 Kaggle 规则误处理）。
    if (providerMetaOf(this.provider.id)?.kind !== 'notebook') return null
    return buildPendingCleanupRecord(this.session, this.secret)
  }

  /**
   * 通知远端关机（best-effort，不阻塞）。
   * 返回是否送达：`dispose()` 据此决定是否清掉待清理记录与会话记录。
   */
  shutdownRemote() {
    const handle = this.handle
    const endpoint = this.session.endpointUrl ?? handle?.endpointUrl ?? null
    const token = this.secret.token
    // Colab 在拿到隧道地址前就可能已经在计费：只要有 provider 句柄就必须释放，
    // 不能因为 endpointUrl 为空就跳过 unassign。
    if (!endpoint && !handle?.assignmentEndpoint && !handle?.groupName) return Promise.resolve(false)
    try {
      const pending = this.provider.teardown(this, { ...(handle ?? {}), endpointUrl: endpoint, token }, {
        reason: 'dispose',
        removeFolder: false,
      })
      return Promise.resolve(pending).then(
        (result) => Boolean(result?.ok ?? result),
        (error) => {
          this.log.debug('best-effort 关机通知失败', logText(error?.message ?? error, 200))
          return false
        },
      )
    } catch (error) {
      // best-effort：关机通知失败不影响本地状态机。
      this.log.debug('best-effort 关机通知异常', logText(error?.message ?? error, 200))
      return Promise.resolve(false)
    }
  }

  // ---- 启动补清理 ---------------------------------------------------------

  /**
   * 启动补清理：补发上次卸载失败的关机通知，释放 Kernel 占用的每周 GPU 配额。
   * 由 index.js 在 `restore()` 之前顺序调用，避免与恢复流程抢同一个远端会话。
   *
   * @returns {Promise<boolean | null>} null=无记录；true=补发成功；false=失败/已丢弃
   */
  cleanupPendingSession() {
    return runPendingCleanup(this)
  }

  // ---- 启动 ---------------------------------------------------------------

  /**
   * 启动 / 手动唤醒前的精度档归一。
   *
   * `auto` 必须按本次实际 provider 收敛成具体档位：Salad 的选卡与容器规格看的是
   * variant 的权重体积与显存，若把 `auto` 原样传下去，`requiredVramGbOf()` 找不到
   * 同名 variant 就会回落到满血规格，先手动「唤醒」的实例会比任务实际要的更大、更慢。
   * 未传 variantId 时保持旧端行为（返回空串，由任务入队时再决定）；显式档位非法时抛
   * ProviderError，由调用方转成明确的 400，而不是静默按满血启动。
   */
  resolveStartVariant(presetId, variantId, provider) {
    const requested = typeof variantId === 'string' ? variantId.trim() : ''
    if (!requested) return ''
    const resolved = resolveVariant(presetById(presetId), requested, provider)
    if (!resolved.ok) throw new ProviderError(resolved.code, resolved.message)
    return resolved.id
  }

  async start(
    presetId = this.defaultPreset,
    { forceNew = false, replace = false, initiator = 'user', provider, variantId } = {},
  ) {
    // 设置里换了算力来源时，下一次启动必须换到新来源：活跃会话仍属于旧来源，
    // 不能命中下面的幂等快照（否则用户在设置里切到 Colab 后，排队任务仍会在
    // 正在运行的 Kaggle 会话上出图，界面却已经显示 Colab）。
    const effective = { ...this.effectiveSettings(), ...(provider ? { provider } : {}) }
    const desiredProvider = this.deps.provider
      ? this.provider.id
      : this.desiredProviderId(effective.provider)
    const providerChanged = ACTIVE_STATES.has(this.session.state)
      && typeof this.session.provider === 'string'
      && this.session.provider !== desiredProvider
    const shouldReplace = replace || providerChanged

    // replace=true 是「换新实例重排」：允许在 provisioning/connecting 等活跃状态下强制
    // 放弃当前会话并重新推送一个 Kernel（普通 start 命中活跃态直接返回快照，保持幂等）。
    if (!shouldReplace && ACTIVE_STATES.has(this.session.state)) return this.snapshot()
    // 同一代次的启动只允许一份；stop 之后代次变化，新的 start 必须重新发起，
    // 不能被上一轮尚未结束的启动承诺挡住。
    if (!shouldReplace && this.starting && this.startingEpoch === this.epoch) return this.starting

    // 精度档在真正发起启动前归一：非法档位直接拒绝，不再放弃旧会话 / 拉起新实例。
    const resolvedVariantId = this.resolveStartVariant(presetId, variantId, desiredProvider)

    // 只有真正进入这一轮启动时才记录发起方；命中上面的幂等分支说明会话已经有主，
    // 后续任务复用它时不能被误记成「任务新拉起的实例」。
    this.startInitiator = initiator === 'job' ? 'job' : 'user'
    // 用户主动启动（面板「唤起」/Agent start）清除「已关机」标记。
    this.stoppedByUser = false
    // 先递增代次并把整条「放弃旧会话 → 新推」挂进 this.starting，再跨越 await：
    // 否则 abandonActiveSession 等待远端关机期间，this.session 仍是旧来源且 this.starting 为空，
    // 并发 start() 会重复触发放弃并拉起两轮 provision。
    const epoch = (this.epoch += 1)
    this.renewAbort()
    this.startingEpoch = epoch
    const abandonReason = providerChanged && !replace ? 'provider_switch' : 'requeue'
    const run = (async () => {
      if (shouldReplace) {
        // 这次放弃是新一轮启动的一部分：保留新启动的发起方，直到启动真正完成；
        // 否则排队任务取消时无法判断当前实例是否需要回收。
        await this.abandonActiveSession(abandonReason, { keepEpoch: true, keepInitiator: true })
      }
      if (this.isStale(epoch)) return this.snapshot()
      return this.provision(presetId, epoch, { forceNew: forceNew || shouldReplace, provider, variantId: resolvedVariantId })
    })().finally(() => {
      if (this.startingEpoch === epoch) {
        this.starting = null
        this.startingEpoch = null
      }
    })
    this.starting = run
    return run
  }

  /**
   * 放弃当前会话（「换新实例重排 / 切换算力来源 / 取消最后一个任务」专用）：
   * 停掉轮询与在飞流程，清理旧会话与远端实例。
   *
   * 与 stop() 的区别：**不置 stoppedByUser**。排队中的任务看到会话进入新一轮
   * provisioning 后继续等待，不会因为这次重排被判 stopped。
   *
   * @param {string} reason 日志归因
   * @param {{ keepEpoch?: boolean, keepInitiator?: boolean }} [options]
   *   keepEpoch：由 start() 内部调用时保留新代次；
   *   keepInitiator：由 start() 内部调用时保留新一轮启动的发起方
   */
  async abandonActiveSession(reason = 'requeue', { keepEpoch = false, keepInitiator = false } = {}) {
    const before = this.session.state
    const kernelId = this.session.kernelId
    const endpoint = this.session.endpointUrl
    const token = this.secret.token
    const handle = this.handle
    const folderDir = this.kernelFolder
    const oldProvider = this.provider
    // 直接调用时递增代次：在飞的 push / 轮询从这一刻起全部失效，不能再写回旧会话状态；
    // 由 start() 调用时代次与 this.starting 已在调用方预先推进，不再重复清掉新代次的 starting。
    if (!keepEpoch) {
      this.epoch += 1
      this.renewAbort()
      this.starting = null
      this.startingEpoch = null
    }
    this.clearTimers()
    if (!keepInitiator) this.startInitiator = null
    this.livenessCheck = null
    this.healthMisses = 0
    this.reconnectAttempts = 0
    this.recoveringFromReady = false
    this.recoveryStartedAt = 0
    this.recoveryRenewals = 0
    this.recoveryBeganAt = 0
    // 在任何 await 之前先同步重置本地会话与句柄，防止并发请求读到未清理的旧来源快照。
    this.kernelFolder = null
    this.handle = null
    this.secret = { token: null, topic: null }
    this.session = emptySession({ ...this.options, provider: oldProvider?.id ?? this.options.provider })
    this.logTransition(before, 'absent', { phase: null })
    this.log.info(`session_abandon from=${before} kernelId=${kernelId ?? 'none'} reason=${reason}`)

    // 已经建立隧道且来源允许远端关机时，先尽力通知远端退出。
    // `remoteShutdown === false`（共享私有 Worker）绝不能发 /shutdown：那是别人的长驻服务，
    // 断开只应释放本地连接。Kaggle 由下面 teardown 统一发关机通知，这里保持原样跳过。
    const remoteShutdown = providerMetaOf(oldProvider?.id)?.remoteShutdown !== false
    if (remoteShutdown && endpoint && token && (oldProvider?.id !== 'kaggle' || typeof oldProvider?.teardown !== 'function')) {
      const ok = await this.deps
        .requestShutdown(endpoint, token, TIMEOUTS.remoteShutdownMs, this.ctx)
        .catch((error) => {
          this.log.debug('放弃会话时远端关机通知失败（忽略）', logText(error?.message ?? error, 200))
          return false
        })
      if (!ok) this.log.debug('放弃会话时远端关机未送达，继续释放实例')
    }
    // 必须调用 provider.teardown：Colab 需要关闭 WS 并 unassign 释放 VM（否则会持续烧 CCU），
    // Kaggle 也会一并清理含 token 的临时目录。
    if (typeof oldProvider?.teardown === 'function') {
      await oldProvider
        .teardown(
          this,
          { ...(handle ?? {}), endpointUrl: endpoint, token, folderDir },
          { reason, removeFolder: true },
        )
        .catch((error) => {
          this.log.debug('放弃会话时释放远端实例失败（忽略）', logText(error?.message ?? error, 200))
        })
    }
    // 排队条目可能留在 Kaggle 队列里之后才被调度到，删掉旧 Kernel 避免空转烧配额。
    if (kernelId) void this.discardStaleKernel(kernelId, reason)

    await this.clearPersistedSession()
  }

  /**
   * 从当前错误态提取可检查接管的旧 Kernel 信息；不满足条件返回 null。
   * 仅当 error 态下确实保留了已推送成功的 kernelId + token + topic 时才尝试接管。
   */
  reattachCandidate(fallbackPresetId) {
    if (this.options.devEndpoint) return null
    if (this.session.state !== 'error') return null
    const errorCode = this.session.error?.code ?? null
    if (!REATTACHABLE_ERROR_CODES.has(errorCode)) return null
    if (!this.session.kernelId || !this.secret.token || !this.secret.topic) return null
    return {
      kernelId: this.session.kernelId,
      kernelUrl: this.session.kernelUrl,
      kernelStatus: this.session.kernelStatus,
      presetId: this.session.presetId ?? fallbackPresetId,
      idleTimeoutSec: this.session.idleTimeoutSec ?? this.options.idleTimeoutSec,
      errorCode,
      token: this.secret.token,
      topic: this.secret.topic,
    }
  }

  /**
   * 唤醒前检查并尝试接管仍在 Kaggle 排队或运行中的旧 Kernel，避免盲目推送第二个
   * 随机 slug 导致孤儿队列浪费配额。
   *
   * @returns {Promise<{ kind: 'reattached', snapshot: object } | { kind: 'stale' } | { kind: 'push_new' }>}
   */
  async tryReattachCandidate(candidate, epoch) {
    this.clearTimers()
    this.healthMisses = 0
    this.reconnectAttempts = 0
    this.livenessCheck = null
    this.recoveringFromReady = false
    this.recoveryStartedAt = 0
    this.recoveryRenewals = 0
    this.recoveryBeganAt = 0

    this.session.error = null
    this.session.endpointUrl = null
    this.session.startedAt = isoNow()
    if (candidate.errorCode === 'queue_timeout') {
      this.transition('provisioning', { phase: 'queue' })
      this.session.detail = '正在确认原 Kernel 队列状态'
    } else {
      this.transition('connecting', { phase: 'tunnel' })
      this.session.detail = '正在确认原 Kernel 状态'
    }

    const statusRes = await this.provider.status(candidate.kernelId).catch((error) => {
      this.log.debug('唤醒前查询原 Kernel 状态失败', logText(error?.message ?? error, 200))
      return null
    })
    if (this.isStale(epoch)) return { kind: 'stale' }

    const status = statusRes?.ok ? statusRes.status : null
    // 删除后再查 Kernel 返回 403 PERMISSION_DENIED（不是 404）：传输层用 missing 归一，
    // 这里兼容旧传输返回的文本判定。已不存在的 Kernel 不允许再「乐观保留原队列」。
    const notFound = statusRes?.missing === true || /not\s*found|\b404\b/i.test(String(statusRes?.output ?? ''))
    const aliveConfirmed = Boolean(status && isKernelAlive(status))
    // 队列超时后若暂未查到状态（临时网络抖动，且非 404 已删），宁可继续跟踪原队列也不要盲目双推。
    const optimisticQueueKeep = candidate.errorCode === 'queue_timeout' && !statusRes?.ok && !notFound

    if (!aliveConfirmed && !optimisticQueueKeep) {
      this.log.info(
        `reattach_skipped kernelId=${candidate.kernelId} status=${status ?? 'unknown'} ok=${Boolean(statusRes?.ok)}`,
      )
      return { kind: 'push_new' }
    }

    const nextStatus = status ?? candidate.kernelStatus ?? 'QUEUED'
    this.secret = { token: candidate.token, topic: candidate.topic }
    this.session = {
      ...emptySession(this.options),
      presetId: candidate.presetId,
      kernelId: candidate.kernelId,
      kernelUrl: candidate.kernelUrl,
      kernelStatus: nextStatus,
      idleTimeoutSec: candidate.idleTimeoutSec,
      startedAt: isoNow(),
    }
    if (isKernelQueued(nextStatus)) {
      this.transition('provisioning', { phase: 'queue' })
      this.session.detail = aliveConfirmed
        ? `已接管原队列（${nextStatus}），继续等待 GPU`
        : '暂未确认队列状态，继续等待原 Kernel'
    } else {
      this.transition('connecting', { phase: 'tunnel' })
      this.session.detail = '原 Kernel 仍在运行，正在重新获取隧道地址'
    }
    this.persistSession({ force: true })
    this.watch()
    this.log.info(
      `reattach_existing_kernel kernelId=${candidate.kernelId} status=${nextStatus} fromError=${candidate.errorCode}`,
    )
    return { kind: 'reattached', snapshot: this.snapshot() }
  }

  /**
   * 跑一次启动流程；返回快照。任何异常都在内部收敛为可重试的 error 状态。
   *
   * @param {string} presetId 预设 id
   * @param {number} epoch 本次启动的代次
   * @param {{ forceNew?: boolean }} [options]
   */
  async provision(presetId, epoch, { forceNew = false, provider, variantId } = {}) {
    try {
      // 启动前先读最新设置：工作台切换算力来源后（哪怕上一轮停在 error 态，不走 abandonActiveSession），
      // 也绝不能再去接管旧来源的残留 Kernel（例如 Kaggle queue_timeout 后切到 Colab 再唤醒）。
      const effective = { ...this.effectiveSettings(), ...(provider ? { provider } : {}) }
      const wantedProvider = this.deps.provider
        ? this.provider.id
        : this.desiredProviderId(effective.provider)
      const switchedProvider = !this.deps.provider
        && typeof this.session.provider === 'string'
        && this.session.provider !== wantedProvider
      // 进入新推流程前先记住旧 Kernel：forceNew / 换源 / 接管失败时它已经没用了，稍后 best-effort 删除。
      const previousKernelId = this.session.kernelId
      const candidate = !forceNew && !switchedProvider ? this.reattachCandidate(presetId) : null
      if (candidate) {
        const outcome = await this.tryReattachCandidate(candidate, epoch)
        if (outcome.kind === 'stale') return this.snapshot()
        if (outcome.kind === 'reattached') return outcome.snapshot
        // 旧 Kernel 已结束 / 已不存在：不重复接管，走新推流程并清掉旧记录。
        if (outcome.kind === 'push_new') void this.discardStaleKernel(candidate.kernelId, 'reattach_dead')
      } else if ((forceNew || switchedProvider) && previousKernelId) {
        // 先用旧 provider 清理旧 Kernel，再切换到新 provider。
        void this.discardStaleKernel(previousKernelId, switchedProvider ? 'provider_switch' : 'force_new')
      }

      this.clearTimers()
      this.healthMisses = 0
      this.reconnectAttempts = 0
      this.livenessCheck = null
      this.recoveringFromReady = false
      this.recoveryStartedAt = 0
      this.recoveryRenewals = 0
      this.recoveryBeganAt = 0
      // 运行时切换：设置抽屉改了算力来源后，下一次「连接/唤醒」就换 provider（不需要重载插件）。
      this.applyProviderSettings(effective)
      // Worker 型（长驻服务）：跳过 Kernel 目录、ntfy 会合、空闲关机与 dataset 挂载，
      // 只做「连接 + 协议校验 + 健康轮询」；具体连接细节由 provider 负责。
      // 以实际生效的 provider 为准（而不是请求值），避免设置归一差异导致走错分支。
      const worker = isWorkerProvider(this.provider.id)
      // 商业生图 API：没有可管理的远端会话，状态机只做「凭据校验 → ready」，
      // 不挂健康轮询、不落会话记录、不参与空闲关机。
      const cloudApi = isCloudApiProvider(this.provider.id)
      this.session = emptySession({ ...this.options, provider: this.provider.id })
      // 新会话的能力位从零开始：/health 到达前不假设 binary / SSE 可用。
      this.remoteCapabilities = null
      // 快照反映真正下发给远端的空闲关机秒数（不是构造时的静态 options）。
      // Worker 没有 Host 侧空闲关机（由 Worker 自己的 --idle-timeout 决定），保留 null 表示不适用。
      this.session.idleTimeoutSec = worker || cloudApi ? null : effective.idleTimeoutSec
      this.session.presetId = presetId
      this.session.variantId = typeof variantId === 'string' && variantId ? variantId : null
      this.transition('provisioning', { phase: 'push' })
      this.session.detail = worker
        ? (this.provider.id === 'salad' ? '正在创建 Salad 容器' : '正在连接私有 Worker')
        : cloudApi
          ? '正在校验生图 API 凭据'
          : '正在准备 Kernel 目录'
      this.session.startedAt = isoNow()

      if (this.options.devEndpoint) {
        this.secret = { token: this.options.devToken ?? '', topic: null }
        this.session.endpointUrl = this.options.devEndpoint
        this.transition('ready', { phase: null })
        this.session.readyAt = isoNow()
        this.session.detail = '开发模式：直连本地 Daemon'
        this.session.modelId = 'local-mock'
        return this.snapshot()
      }

      // 商业生图 API（M3.5）：provider 只校验配置并返回厂商 / 模型；不产生 endpoint，
      // 也不写 session.json（Key 不落盘、刷新后重新读设置即可），直接 ready。
      if (cloudApi) {
        const provisioned = await this.provider.provision(this.provisionRun(epoch), {
          presetId,
          variantId,
          onProgress: (event) => this.applyProvisionProgress(event),
        })
        if (this.isStale(epoch)) return this.abandonStart(null, null)
        this.handle = provisioned?.handle ?? null
        // Key 只在会话 secret 里短暂停留（队列取用），不进入 handle / 快照 / 记录。
        this.secret = { token: provisioned?.token ?? null, topic: null }
        this.session.endpointUrl = null
        this.session.device = this.handle?.label ?? this.handle?.vendor ?? null
        this.transition('ready', { phase: null })
        this.session.readyAt = isoNow()
        this.session.detail = `商业生图 API 已就绪（${this.handle?.label ?? this.handle?.vendor ?? 'cloud'}）`
        this.session.modelId = this.handle?.model ?? null
        return this.snapshot()
      }

      // 长驻 Worker：地址与令牌由 provider 从设置/凭据里取，Host 不再生成会话 token，
      // 也不下发 daemon 注入配置（Worker 自己决定加载哪个模型）。
      if (worker) {
        const provisioned = await this.provider.provision(this.provisionRun(epoch), {
          presetId,
          variantId,
          onProgress: (event) => this.applyProvisionProgress(event),
        })
        const handle = provisioned?.handle ?? provisioned
        const endpointUrl = handle?.endpointUrl ?? null
        this.handle = handle
        // 连接令牌返回在 provision 结果外层：handle 会落盘，不能让 token 混进句柄。
        this.secret = { token: provisioned?.token ?? null, topic: null }
        // 用户可能在 provision 返回前已点停止：此时 stop() 拿不到刚创建的远端句柄，
        // 这里补一次 teardown，避免 Salad 等按秒计费容器成为孤儿（provider 幂等）。
        if (this.isStale(epoch)) {
          await Promise.resolve()
            .then(() => this.provider.teardown(this, { ...(handle ?? {}) }, { reason: 'abandoned_start' }))
            .catch((error) => {
              this.log.warn('作废启动的远端清理失败（已交由待清理记录兜底）', logText(error?.message ?? error, 240))
            })
          this.handle = null
          this.secret = { token: null, topic: null }
          return this.snapshot()
        }
        // Salad 这类「Host 创建、平台异步调度」的 Worker 先返回容器组句柄，地址要等
        // pollEndpoint 确认节点 running 后才交回状态机；待清理记录已在 provider 创建
        // 容器前同步落盘，因此这里即使没有 endpoint 也能在异常退出后释放计费资源。
        if (!endpointUrl && handle?.awaitEndpoint === true) {
          this.transition('provisioning', { phase: 'queue' })
          this.session.detail = handle?.detail ?? 'Salad 容器创建中，等待节点与镜像就绪'
          this.watch()
          return this.snapshot()
        }
        if (!endpointUrl) {
          throw new ProviderError('worker_unreachable', '私有 Worker 未返回可用地址：请检查设置里的地址')
        }
        this.session.endpointUrl = endpointUrl
        this.transition('connecting', { phase: 'tunnel' })
        this.session.detail = this.provider.id === 'salad'
          ? 'Salad 节点已就绪，正在等待 Worker 握手'
          : '已连接私有 Worker，正在握手'
        this.persistSession({ force: true })
        this.startHealthLoop()
        return this.snapshot()
      }

      const token = randomBytes(24).toString('hex')
      const topic = `imagen-${randomBytes(8).toString('hex')}`
      this.secret = { token, topic }

      // daemon 注入配置对两个平台同构（token / 预设 pipeline / 契约 / 可选加固项）：
      // 由状态机组装，provider 只负责把它送到远端。
      const daemonConfig = buildKernelConfig({
        presetId,
        token,
        topic,
        idleTimeoutSec: effective.idleTimeoutSec,
        hfToken: effective.hfToken,
        modelSource: effective.modelSource,
        pipConstraints: effective.pipConstraints,
        fallbackTunnelCommand: this.options.fallbackTunnelCommand,
        fallbackTunnelUrlRegex: this.options.fallbackTunnelUrlRegex,
        localModels: effective.localModels,
      })

      const handle = await this.provider.provision(this.provisionRun(epoch), {
        variantId,
        daemonConfig,
        // 预挂载 Kaggle Dataset（P2.1）：由 kernel-metadata 的 dataset_sources 挂到
        // /kaggle/input，权重目录映射见 effective.localModels → daemon 的 local_models。
        datasetSources: effective.datasetSources ?? [],
        enableGpu: this.options.enableGpu !== false,
        accelerator: this.options.enableGpu === false ? null : effective.accelerator,
        timeoutSec: this.options.kernelTimeoutSec,
        sourcePath: this.options.sourcePath,
        colabGpu: effective.colabGpu,
        colabHighRam: effective.colabHighRam,
        onProgress: (event) => this.applyProvisionProgress(event),
      })
      this.handle = handle
      this.kernelFolder = handle?.folderDir ?? null
      if (this.isStale(epoch)) return this.abandonStart(null, handle?.kernelId ?? null)

      this.watch()
      return this.snapshot()
    } catch (error) {
      // 作废（换代）与 provider 主动中止同一条路径：只清理，不写状态。
      if (this.isStale(epoch) || error?.code === 'stale') {
        return this.abandonStart(null, error?.kernelId ?? null)
      }
      // provider 已经把临时目录清干净，这里只需丢弃本地引用。
      if (error?.name === 'ProviderError') {
        this.kernelFolder = null
        return this.fail(error.code, error.message, { logsTail: error.logsTail })
      }
      // 兜底：任何未预期的异常都必须收敛为可重试的 error 状态并清理临时目录，
      // 绝不能让会话停在 provisioning（那时没有定时器，start() 又会直接命中 ACTIVE_STATES）。
      const folderDir = this.kernelFolder
      this.kernelFolder = null
      if (folderDir) {
        await this.provider.removeFolder(folderDir).catch((removeError) => {
          this.log.warn(
            '临时 Kernel 目录清理失败（目录内 daemon.py 含 token）',
            logText(removeError?.message ?? removeError, 200),
          )
        })
      }
      return this.fail('push_failed', `启动会话失败：${error?.message ?? error}`)
    }
  }

  /**
   * 记录属于哪个来源：按记录自己的 provider 分派（补清理 / 恢复必须用对「那台机器」
   * 的连接方式），v1 记录没有 provider 字段时按 Kaggle 处理。
   */
  providerFor(record) {
    // 测试显式注入 provider 时不做替换（保持既有注入语义）。
    if (this.deps.provider) return this.provider
    const wanted = providerIdOf(record)
    if (wanted === this.provider.id) return this.provider
    return createProvider(wanted, {
      ctx: this.ctx,
      deps: this.deps,
      log: this.log,
      manager: this,
      options: this.options,
    })
  }

  /** 按当前设置切换 provider；deps.provider 注入（测试/宿主固定）时保持不变。 */
  applyProviderSettings(effective) {
    if (this.deps.provider) return
    const wanted = providerIdOf(effective)
    if (this.provider.id === wanted) return
    this.log.info(`provider_switch ${this.provider.id} -> ${wanted}`)
    this.provider = createProvider(wanted, {
      ctx: this.ctx,
      deps: this.deps,
      log: this.log,
      manager: this,
      options: this.options,
    })
  }

  /**
   * 交给 provider 的只读运行上下文：只暴露「还是不是当前代次」与日志/选项，
   * 避免 provider 直接改会话状态（状态推进统一走 `applyProvisionProgress`）。
   */
  provisionRun(epoch) {
    return {
      ctx: this.ctx,
      options: this.options,
      log: this.log,
      signal: this.abortController.signal,
      isCurrent: () => !this.isStale(epoch),
    }
  }

  /** 换代：作废旧信号并换一只新的 AbortController（stop/dispose/新 start 都走这里）。 */
  renewAbort() {
    const previous = this.abortController
    this.abortController = new AbortController()
    try {
      previous?.abort()
    } catch {}
    return this.abortController.signal
  }

  /**
   * provider 的启动进度落回状态机。
   *
   * 事件字段与原有写入顺序一一对应：kernelId/kernelUrl → phase → detail → persist。
   */
  applyProvisionProgress(event = {}) {
    if (!event || typeof event !== 'object') return
    if (event.kernelId) {
      this.session.kernelId = event.kernelId
      this.session.kernelUrl = event.kernelUrl ?? this.session.kernelUrl
      if (event.folderDir !== undefined) this.kernelFolder = event.folderDir
    }
    if (event.kernelStatus) this.session.kernelStatus = event.kernelStatus
    if (event.phase) this.transition('provisioning', { phase: event.phase })
    if (event.detail) this.session.detail = event.detail
    if (event.persist) this.persistSession({ force: true })
  }

  /**
   * 作废的启动流程只做清理：删掉本次的临时 Kernel 目录（内含 token），
   * 不写任何会话状态、不挂定时器，返回当前（可能已是新一轮/已关机）的快照。
   *
   * @param {string | null} folderDir 临时 Kernel 目录
   * @param {string | null} [kernelId] 已经推送成功的 Kernel（作废时它可能仍在 Kaggle 队列里）
   */
  async abandonStart(folderDir, kernelId = null) {
    if (folderDir && this.kernelFolder === folderDir) this.kernelFolder = null
    if (folderDir) {
      await this.provider.removeFolder(folderDir).catch((error) => {
        this.log.warn('临时 Kernel 目录清理失败（目录内 daemon.py 含 token）', logText(error?.message ?? error, 200))
      })
    }
    // 目录清理后再删远端 Kernel：push 成功但代次已过期的 Kernel 不会有人接管，
    // 留着只会在 Kaggle 队列里等到被调度后空转。
    if (kernelId) void this.discardStaleKernel(kernelId, 'abandoned_start')
    return this.snapshot()
  }

  // ---- 会合轮询 -----------------------------------------------------------

  /** 会合阶段：轮询隧道地址 + 低频查 Kernel 状态。 */
  watch() {
    this.clearTimers()
    this.every(() => this.pollTunnel(), this.options.tickMs)
    this.every(() => this.pollKernelStatus(), this.options.kernelPollMs)
  }

  elapsedMs() {
    const started = this.session.startedAt ? Date.parse(this.session.startedAt) : Date.now()
    return Date.now() - started
  }

  /** 会合轮询的一拍：具体协议由 provider 决定（Kaggle=ntfy，Colab=Jupyter 通道）。 */
  pollTunnel() {
    // Kaggle 的超时收敛与日志尾在 tunnel-watcher 里；其它 provider 只在这里做通用超时判定。
    if (
      this.provider.id !== 'kaggle' &&
      this.session.state === 'provisioning' &&
      this.elapsedMs() > this.options.provisionTimeoutMs
    ) {
      const minutes = Math.round(this.options.provisionTimeoutMs / 60000)
      this.fail('queue_timeout', `等待远端实例超时（${minutes} 分钟），点「唤醒」重试`)
      return Promise.resolve(null)
    }
    return Promise.resolve(this.provider.pollEndpoint(this, this.handle))
      .then((found) => {
        if (!found?.endpointUrl || this.session.endpointUrl) return found
        // provider 只负责"拿到地址"；状态跃迁与轮询切换仍由状态机决定（与 Kaggle 同一条路径）。
        this.session.endpointUrl = found.endpointUrl
        this.session.tunnelProvider = normalizeTunnelProvider(found.channel) ?? 'cloudflare'
        this.session.detail = '已获取推理地址，正在握手'
        this.transition('connecting', { phase: 'tunnel' })
        // 地址拿到就落盘：Host 重启后至少能凭记录找回实例并释放。
        this.persistSession({ force: true })
        this.startHealthLoop()
        return found
      })
      .catch((error) => {
        if (error?.name === 'ProviderError' && error.code) {
          this.fail(error.code, error.message, { logsTail: error.logsTail })
          return null
        }
        throw error
      })
  }

  // ---- 健康轮询与掉线恢复 -------------------------------------------------

  /** 挂上健康轮询与 Kernel 状态轮询，并立刻打第一拍。 */
  startHealthLoop() {
    this.clearTimers()
    this.every(() => this.pollHealth(), this.options.tickMs)
    // Worker 型没有 Kernel 状态：/health 心跳已经覆盖「连不上 / 鉴权失败」，
    // 再跑 pollKernelStatus 只会重复探测并把连接问题误判成 session_ended。
    if (!isWorkerProvider(this.provider.id)) this.every(() => this.pollKernelStatus(), this.options.kernelPollMs)
    void this.pollHealth()
  }

  /** 健康轮询入口（单飞）：立即首拍与已排期的一拍不会重叠。 */
  pollHealth() {
    // 保活由状态机的定时器驱动（provider 不自建 interval）：Kaggle 是空操作，
    // Colab 在这里发 WS 心跳并续代理令牌。失败只记 debug，下一拍重试。
    void this.singleFlight('keepalive', () => this.provider.keepAlive(this, this.handle))
      .then((result) => {
        // Colab 的余额/速率随保活顺带返回，写进快照供顶栏展示（其它 provider 没有这个字段）。
        if (result?.usage) this.session.providerUsage = result.usage
      })
      .catch((error) => {
      this.log.debug('保活失败（下一拍重试）', logText(error?.message ?? error, 200))
    })
    return this.singleFlight('health', () => checkHealth(this))
  }

  /** 把 `/health` 里的设备、模型与隧道通道写进快照（供外部/单测直接调用）。 */
  applyHealthDetails(health) {
    return writeHealthDetails(this, health)
  }

  /** 依据 `/health` 的 phase 推进会话状态（供外部/单测直接调用）。 */
  applyHealthState(health) {
    return writeHealthState(this, health)
  }

  /**
   * 恢复窗口是否已到期。
   *
   * 只看「最近一次续期」之后的 `recoveryTimeoutMs`：恢复期每次向 Kaggle 确认 Kernel
   * 仍 RUNNING 都会把起点推到当下（见 health-monitor.js），所以隧道重建时间超过
   * 单轮窗口也不会判死，直到续期轮数用尽。
   */
  recoveryWindowExpired() {
    return this.recoveryStartedAt > 0 && Date.now() - this.recoveryStartedAt > this.options.recoveryTimeoutMs
  }

  /** Kernel 状态轮询入口（单飞）：kaggle CLI 慢时避免叠加子进程。 */
  pollKernelStatus() {
    return this.singleFlight('kernel', async () => {
      const result = await this.provider.checkAlive(this, this.handle)
      // provider 只回答实例还在不在；会话收尾必须由状态机做。Colab 的实例被回收时
      // 没有 Kernel 状态可轮询，只能靠这里收敛，否则会一直停在 ready 反复报错。
      if (result && result.alive === false && this.session.state !== 'error') {
        this.log.warn(`provider_instance_gone provider=${this.provider.id} missing=${Boolean(result.missing)}`)
        // Worker 型不走这条轮询（见 startHealthLoop），这里保留兜底分类，避免误报「云端口令已关闭」。
        const code = isWorkerProvider(this.provider.id)
          ? (result.status === 'worker_unauthorized' ? 'worker_unauthorized' : 'worker_unreachable')
          : 'session_ended'
        const message = code === 'worker_unauthorized'
          ? '私有 Worker 鉴权失败：请在设置里重新填写 Token 后点「连接」重试'
          : instanceLostMessage(this.provider.id)
        this.fail(code, message)
      }
      return result
    })
  }

  // ---- 停止 ---------------------------------------------------------------

  async stop() {
    const before = this.session.state
    const kernelId = this.session.kernelId
    this.log.info(`stop_requested from=${before} kernelId=${kernelId ?? 'none'}`)
    // 递增代次：在飞的启动 / 轮询从这一刻起全部失效，不能再写回状态或挂定时器。
    this.epoch += 1
    this.renewAbort()
    this.starting = null
    this.startingEpoch = null
    this.startInitiator = null
    // 「用户已关机」标记保持到下一次 start 清除；排队任务不得再自动拉起 Kernel。
    this.stoppedByUser = true
    this.clearTimers()
    this.livenessCheck = null
    const stoppingElapsedMs = this.elapsedMs()
    this.transition('stopping')

    // 关机通知：优先用内存里的连接信息；内存里没有（例如上次进程留下的记录还没被
    // restore() 接管）时从记录里取一次，尽力关掉远端，别让 Kernel 继续烧配额。
    let shutdownEndpoint = this.session.endpointUrl
    let shutdownToken = this.secret.token
    if (!shutdownEndpoint || !shutdownToken) {
      const record = await readSessionRecord(this.ctx)
      if (record && isTrustedEndpoint(record.endpointUrl, this.options.trustedTunnelDomains)) {
        shutdownEndpoint = record.endpointUrl
        shutdownToken = record.token
      }
    }
    // 排队阶段主动关机：Kernel 可能仍在 Kaggle 队列里排队，删除它避免之后被调度到空转。
    if (before === 'provisioning' && kernelId && !this.options.devEndpoint) {
      void this.discardStaleKernel(kernelId, 'stop_while_queued')
    }
    // 关机通知与临时目录清理统一交给 provider（幂等，重复调用不会报错）。
    await this.provider.teardown(
      this,
      { ...(this.handle ?? {}), endpointUrl: shutdownEndpoint, token: shutdownToken, folderDir: this.kernelFolder },
      { removeFolder: true },
    )
    this.kernelFolder = null
    this.handle = null
    this.secret = { token: null, topic: null }
    this.healthMisses = 0
    this.reconnectAttempts = 0
    this.recoveringFromReady = false
    this.recoveryStartedAt = 0
    this.recoveryRenewals = 0
    this.recoveryBeganAt = 0

    this.session = emptySession({ ...this.options, provider: this.provider.id })
    // transition 的 from 是进入 stopping 前的状态；这里 session 已整体替换，只能显式补记。
    this.logTransition('stopping', this.session.state, { phase: null, elapsedMs: stoppingElapsedMs })
    this.session.detail =
      before === 'provisioning'
        ? (this.provider.id === 'salad'
          ? '已停止 Salad 容器创建并请求删除容器组；删除失败时下次启动会继续补清理'
          : `已放弃这次排队并清理旧 Kernel（${kernelId ?? '未知'}）；若清理失败，Kernel 上线后无人接管会自行退出`)
        : before === 'absent'
          ? null
          : isCloudApiProvider(this.provider.id)
            ? '已断开商业生图 API（云端无需关机，可随时重新连接）'
            : isWorkerProvider(this.provider.id)
              ? (this.provider.id === 'salad'
                ? '已停止 Salad 容器并结束按秒计费'
                : '已断开与私有 Worker 的连接（共享 Worker 继续运行）')
              : '已关机'
    // 用户主动关机后不再需要启动恢复；记录里的 token 也一并从磁盘清掉。
    await this.clearPersistedSession()
    return this.snapshot()
  }

  // ---- 启动恢复 -----------------------------------------------------------

  /**
   * 从 `<workspace>/.aigc-studio/session.json` 恢复上次运行中的会话（委托给 ./session/restorer.js）。
   * 没有记录、记录损坏、开发模式或被 start()/stop() 作废时返回 null。
   */
  async restore() {
    if (this.disposed) return null
    // 开发模式直连本地 Daemon：本地进程没有 Kaggle 配额风险，不恢复历史远端会话。
    if (this.options.devEndpoint) return null
    if (this.restoring) return this.restoring

    const run = executeRestore(this).finally(() => {
      if (this.restoring === run) this.restoring = null
    })
    this.restoring = run
    return run
  }

  // ---- 等待 ---------------------------------------------------------------

  async ensureReady({ timeoutMs = 30 * 60 * 1000, onTick = null } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.disposed) throw Object.assign(new Error('插件已卸载'), { code: 'disposed' })
      const state = this.session.state
      if (state === 'ready') return this.snapshot()
      if (state === 'error') {
        throw Object.assign(new Error(this.session.error?.message ?? '会话失败'), {
          code: this.session.error?.code ?? 'session_error',
        })
      }
      if (state === 'absent' || state === 'stopping') {
        throw Object.assign(new Error('会话未启动'), { code: 'session_absent' })
      }
      onTick?.(this.snapshot())
      await sleep(1000)
    }
    throw Object.assign(new Error('等待会话就绪超时'), { code: 'session_timeout' })
  }

  /**
   * 进入 error 状态。
   *
   * @param {string} code 失败码
   * @param {string} message 给用户看的原因（可能含远端日志尾）
   * @param {{ logsTail?: string | null }} [context]
   *   调用方已经拉到的 Kernel 日志尾：失败现场抢救直接复用它，避免再打一次远端。
   */
  fail(code, message, { logsTail = null } = {}) {
    // 会话已判死：取消在飞请求并让 provider 立刻断开长连接（Colab 的 WS 心跳）。
    this.renewAbort()
    const from = this.session.state
    const elapsedMs = this.elapsedMs()
    const text = String(message ?? '未知错误')
    this.clearTimers()
    this.starting = null
    this.startingEpoch = null
    writeFailure(this.session, code, text)
    this.log.warn(
      `fail code=${code} from=${from} elapsedMs=${Math.max(0, Math.round(elapsedMs))} message=${logText(text)}`,
    )
    // 记录保留：失败/超时后远端 Kernel 可能仍在运行，下次启动 restore() 才能据此清理。
    this.persistSession({ force: true })
    // 失败时远端可能仍在运行（push 超时 / 隧道超时后 Kernel 还活着）：尽力通知它退出，
    // 不要等到下一个用户操作或空闲超时，白烧 GPU 配额。
    this.shutdownRemote()
    // 失败现场抢救：远端容器销毁后 Host 日志仍有直接线索（best-effort，不阻塞失败路径）。
    this.rescueKernelLogs(logsTail)
    return this.snapshot()
  }

  /**
   * 失败现场抢救（best-effort）。
   *
   * 会话进入 error（含 session_ended / health_failed）时，把 Kernel 日志尾部约 30 行写入
   * Host 日志，保证远端容器销毁后仍有直接线索。约束：
   *  - 同步部分绝不抛异常，异步失败只记 debug；
   *  - 每个 Kernel 只抢救一次；调用方已拉到日志尾时直接复用，不重复拉取；
   *  - 不 await、不挂定时器，不影响状态机时序。
   */
  rescueKernelLogs(tail = null) {
    try {
      const kernelId = this.session.kernelId
      if (!kernelId) return
      if (this.rescuedKernels.has(kernelId)) return
      this.rescuedKernels.add(kernelId)
      if (typeof tail === 'string' && tail.trim()) {
        this.writeKernelLogTail(kernelId, tail)
        return
      }
      if (typeof this.provider.logs !== 'function') return
      Promise.resolve()
        .then(() => this.provider.logs(kernelId))
        .then((logs) => this.writeKernelLogTail(kernelId, logs?.tail))
        .catch((error) => {
          this.log.debug('失败现场 Kernel 日志抢救失败（忽略）', logText(error?.message ?? error, 200))
        })
    } catch (error) {
      // best-effort：抢救不能影响失败路径。
      try {
        this.log.debug('失败现场 Kernel 日志抢救异常（忽略）', logText(error?.message ?? error, 200))
      } catch {}
    }
  }

  /** 把 Kernel 日志尾写进 Host 日志：约 30 行 / 4000 字符上限，逐行脱敏。 */
  writeKernelLogTail(kernelId, tail) {
    try {
      const text = String(tail ?? '')
      if (!text.trim()) return
      const lines = text
        .split(/\r?\n/)
        .map((line) => logText(line, 500))
        .filter((line) => line.length > 0)
        .slice(-KERNEL_TAIL_MAX_LINES)
      const body = lines.join('\n').slice(0, KERNEL_TAIL_MAX_CHARS)
      if (!body) return
      this.log.warn(`kernel_log_tail_on_failure kernelId=${kernelId} lines=${lines.length}\n${body}`)
    } catch {
      // best-effort：日志抢救失败不能影响失败路径。
    }
  }
}
