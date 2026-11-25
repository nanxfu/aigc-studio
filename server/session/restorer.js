/**
 * 启动恢复与卸载补清理协作器（Restorer）：从 `SessionManager` 拆出的本地会话恢复、
 * 失效记录清理与 `pending-cleanup.json` 启动补关机逻辑。
 */

import { stat } from 'node:fs/promises'

import { TIMEOUTS } from '../../shared/contract.js'
import { isWorkerProvider } from '../providers/index.js'
import { providerIdOf } from '../providers/provider.js'
import { logText } from '../redact.js'
import { fetchHealth, isTrustedEndpoint } from '../remote.js'
import { fetchWorkerHealth, workerCompatibilityErrorOf } from '../providers/worker-connection.js'
import { isKernelEnded, isKernelQueued } from './health.js'
import { applyHealthDetails, applyHealthState } from './health-monitor.js'
import { readPendingCleanup } from './pending-cleanup.js'
import { readSessionRecord, sessionRecordPath } from './persistence.js'
import { ACTIVE_STATES, emptySession, isoNow } from './state.js'

/** 会话记录文件是否已存在（restore 用来区分「无记录」与「记录损坏已清理」）。 */
async function sessionRecordExists(ctx) {
  try {
    const path = sessionRecordPath(ctx)
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** 把本地记录里的会话字段写回实例；endpoint 为 null 表示需要重新会合。 */
function applyRecord(mgr, record, endpoint) {
  const from = mgr.session.state
  const fromPhase = mgr.session.phase ?? null
  // 记录自己的来源优先于静态 options：v2 worker 记录恢复后，快照与后续轮询都必须
  // 指向同一来源（否则界面显示 Kaggle、实际连的是 Worker）。
  const providerId = providerIdOf(record)
  mgr.secret = { token: record.token, topic: record.topic }
  mgr.session = {
    ...emptySession({ ...mgr.options, provider: providerId }),
    presetId: record.presetId ?? mgr.defaultPreset,
    kernelId: record.kernelId,
    kernelUrl: record.kernelUrl,
    kernelStatus: record.kernelStatus,
    endpointUrl: endpoint,
    device: record.device,
    deviceCount: record.deviceCount,
    modelId: record.modelId,
    tunnelProvider: record.tunnelProvider,
    startedAt: record.startedAt ?? isoNow(),
    readyAt: record.readyAt,
    idleTimeoutSec: record.idleTimeoutSec ?? mgr.options.idleTimeoutSec,
    state: 'connecting',
    phase: 'tunnel',
    detail: '正在恢复已保存的会话',
  }
  mgr.healthMisses = 0
  mgr.reconnectAttempts = 0
  mgr.livenessCheck = null
  mgr.recoveringFromReady = false
  mgr.recoveryStartedAt = 0
  mgr.recoveryRenewals = 0
  mgr.recoveryBeganAt = 0
  mgr.stoppedByUser = false
  // session 被整体替换，transition() 看不到 from，这里显式补记恢复接管的那次跃迁。
  mgr.logTransition(from, mgr.session.state, { fromPhase, phase: mgr.session.phase })
}

/**
 * 恢复时确认远端不可再用：尽力关机（仅对已确认可信的地址发送 token）并删除记录。
 * 恢复过程被 start()/stop() 作废时不清理，避免误删新一轮会话刚写下的记录。
 */
async function cleanupRecordedSession(mgr, record, endpoint, epoch, detail, provider = mgr.provider) {
  if (mgr.isStale(epoch)) return null
  if (endpoint && record.token && typeof provider.shutdownEndpoint === 'function') {
    await Promise.resolve()
      .then(() => provider.shutdownEndpoint(endpoint, record.token))
      .catch((error) => {
        mgr.log.debug('恢复清理时关机通知失败（忽略）', logText(error?.message ?? error, 200))
        return false
      })
    if (mgr.isStale(epoch)) return null
  }
  await mgr.clearPersistedSession()
  if (mgr.isStale(epoch)) return null
  mgr.session.detail = detail
  return null
}

/**
 * 启动补清理：补发上次卸载失败的关机通知，释放 Kernel 占用的每周 GPU 配额。
 *
 * @param {import('../session.js').SessionManager} mgr
 * @returns {Promise<boolean | null>} null=无记录；true=补发成功；false=失败/已丢弃
 */
export async function cleanupPendingSession(mgr) {
  let record
  try {
    record = await readPendingCleanup(mgr.ctx)
  } catch (error) {
    mgr.log.debug('读取待清理记录失败（忽略）', logText(error?.message ?? error, 200))
    return null
  }
  if (!record) return null
  // 记录有效性（TTL / 尝试次数 / 隧道域名可信）与释放动作都由 provider 判断：
  // 公共层不预设「必须有 endpointUrl」，Colab 的补清理只需要 endpoint + 令牌。
  // 记录可能来自另一个后端（用户先在 Colab 异常退出、之后切回 Kaggle 启动）：
  // 必须按记录自己的 provider 分派，否则会拿 Kaggle 的校验规则把 Colab 记录丢掉，漏掉 unassign。
  return mgr.providerFor(record).cleanupPending(record)
}

/**
 * 从 `<workspace>/.aigc-studio/session.json` 恢复上次运行中的会话（对应 `SessionManager.restore`）。
 *
 * @param {import('../session.js').SessionManager} mgr
 */
export async function runRestore(mgr) {
  const epoch = mgr.epoch
  // 已有活跃会话或用户已主动关机时不覆盖。
  if (mgr.stoppedByUser || mgr.isStale(epoch) || ACTIVE_STATES.has(mgr.session.state)) return mgr.snapshot()
  // readSessionRecord 对「损坏记录」会清理后返回 null，先探一次文件存在性才能区分分支。
  const hadRecordFile = await sessionRecordExists(mgr.ctx)
  if (mgr.stoppedByUser || mgr.isStale(epoch) || ACTIVE_STATES.has(mgr.session.state)) return mgr.snapshot()
  const record = await readSessionRecord(mgr.ctx)
  if (mgr.stoppedByUser || mgr.isStale(epoch) || ACTIVE_STATES.has(mgr.session.state)) return mgr.snapshot()
  if (!record) {
    mgr.log.info(
      `restore ${hadRecordFile ? 'invalid_record' : 'no_record'}（${hadRecordFile ? '记录损坏或版本过旧，已清理' : '没有本地会话记录'}）`,
    )
    return null
  }

  // 本机 GPU 的 sd-server 是 Host 自己拉起的短生命周期子进程：应用重启后旧端口必然失效，
  // 不能按私有 Worker 的「保留记录等恢复」语义处理，否则用户会看到一条无法修复的不可达错误。
  // 遗留进程由 runtime 的 local-gpu-runtime.json 在下次连接时回收。
  if (record.provider === 'local-gpu') {
    mgr.log.info(`restore_local_gpu_skip endpoint=${record.endpointUrl ?? 'none'}`)
    await mgr.clearPersistedSession()
    return null
  }

  // 记录属于另一个来源时，后续轮询必须换成记录自己的实现（Colab / Worker 都不是 Kaggle）。
  const recordProvider = mgr.providerFor(record)
  if (mgr.provider.id !== recordProvider.id) {
    mgr.log.info(`restore_provider ${mgr.provider.id} -> ${recordProvider.id}`)
    mgr.provider = recordProvider
  }

  // Worker 型（长驻服务）：地址固定，先 /health 确认；不可达时保留记录并给出可读错误，
  // 让用户在 Worker 恢复后点「连接」继续用同一份配置（共享 Worker 不能被误判成会话已死）。
  if (isWorkerProvider(record.provider)) {
    let health = null
    try {
      health = await fetchWorkerHealth({
        ctx: mgr.ctx,
        endpointUrl: record.endpointUrl,
        token: record.token,
        timeoutMs: TIMEOUTS.remoteHealthMs,
      })
    } catch (error) {
      mgr.log.debug('恢复时私有 Worker 不可达', logText(error?.message ?? error, 200))
      if (mgr.stoppedByUser || mgr.isStale(epoch)) return mgr.snapshot()
      const code = error?.code === 'worker_unauthorized' ? 'worker_unauthorized' : 'worker_unreachable'
      const salad = record.provider === 'salad'
      const message = code === 'worker_unauthorized'
        ? (salad
          ? '已保存的 Salad Worker 鉴权失败：容器已创建但 Token 不匹配，请停止后重新连接'
          : '已保存的私有 Worker 鉴权失败：请在设置里重新填写 Token 后点「连接」重试')
        : (salad
          ? '已保存的 Salad 容器当前不可达：下次启动会继续尝试删除残留容器组，请点「连接」重新创建'
          : '已保存的私有 Worker 当前不可达：请检查地址、容器、防火墙或 SSH 隧道后点「连接」重试')
      mgr.log.warn(`worker_restore_unreachable endpoint=${record.endpointUrl} workerId=${record.handle?.workerId ?? 'none'}`)
      return mgr.fail(code, message)
    }
    if (mgr.stoppedByUser || mgr.isStale(epoch)) return mgr.snapshot()
    const protocolProblem = workerCompatibilityErrorOf(health)
    if (protocolProblem) {
      mgr.log.warn(`worker_restore_protocol endpoint=${record.endpointUrl} error=${protocolProblem.code}`)
      return mgr.fail(protocolProblem.code, protocolProblem.message)
    }
    applyRecord(mgr, record, record.endpointUrl)
    mgr.handle = {
      kind: 'worker',
      workerId: record.handle?.workerId ?? null,
      endpointUrl: record.endpointUrl,
      protocolVersion: record.handle?.protocolVersion ?? null,
      owned: record.handle?.owned === true,
    }
    mgr.session.kernelId = null
    mgr.clearTimers()
    applyHealthDetails(mgr, health)
    applyHealthState(mgr, health)
    if (health.phase !== 'ready') {
      // warming / installing / loading：保持健康轮询，等 Worker 自己推进到 ready。
      mgr.every(() => mgr.pollHealth(), mgr.options.tickMs)
    }
    mgr.session.detail = health.phase === 'ready' ? '已从本地记录恢复私有 Worker 连接' : '已连接私有 Worker，等待就绪'
    mgr.persistSession({ force: true })
    return mgr.snapshot()
  }

  // Colab 记录：按 assignment 重新接管（不重新申请实例），拿不到就释放并清记录。
  if (record.provider === 'colab') {
    const provider = recordProvider
    const handle = await Promise.resolve(provider.attach(record)).catch((error) => {
      mgr.log.debug('Colab 记录接管失败', logText(error?.message ?? error, 200))
      return null
    })
    if (mgr.stoppedByUser || mgr.isStale(epoch)) return mgr.snapshot()
    if (!handle) {
      const released = await Promise.resolve(provider.releaseRecord(record)).catch(() => false)
      if (released) await mgr.clearPersistedSession()
      mgr.log.info(`colab_record_stale endpoint=${record.handle?.assignmentEndpoint ?? 'none'} released=${released}`)
      return null
    }
    applyRecord(mgr, record, null)
    mgr.handle = handle
    mgr.session.kernelId = handle.kernelId ?? record.kernelId
    mgr.session.detail = '正在重新会合 Colab 会话'
    mgr.watch()
    mgr.persistSession({ force: true })
    return mgr.snapshot()
  }

  // 不可信地址不发 token：既不做探活，也不做关机通知（防止会合消息/记录被篡改后泄露凭据）。
  const endpoint = isTrustedEndpoint(record.endpointUrl, mgr.options.trustedTunnelDomains) ? record.endpointUrl : null
  let health = null
  if (endpoint) {
    health = await fetchHealth(endpoint, record.token, undefined, mgr.ctx).catch((error) => {
      // 地址不可达是恢复的常见路径（隧道重建/进程重启），交给 topic 重新会合。
      mgr.log.debug('恢复时会话地址探活失败，尝试重新会合', logText(error?.message ?? error, 200))
      return null
    })
    if (mgr.stoppedByUser || mgr.isStale(epoch) || ACTIVE_STATES.has(mgr.session.state)) return mgr.snapshot()
  }

  if (health) {
    mgr.log.info(`probe_health_ok phase=${health.phase ?? 'unknown'}`)
    applyRecord(mgr, record, endpoint)
    mgr.clearTimers()
    applyHealthDetails(mgr, health)
    if (health.phase === 'ready') {
      applyHealthState(mgr, health)
      mgr.session.detail = '已从本地记录恢复会话'
    } else {
      // warming / installing：保持会合轮询节奏，让现有心跳逻辑继续推进到 ready。
      mgr.every(() => mgr.pollHealth(), mgr.options.tickMs)
      mgr.every(() => mgr.pollKernelStatus(), mgr.options.kernelPollMs)
      applyHealthState(mgr, health)
    }
    mgr.persistSession({ force: true })
    return mgr.snapshot()
  }

  // 地址不可用又没有任何会合信息：远端已无法利用，清理记录避免每次启动重复尝试。
  if (!record.topic) {
    mgr.log.info('kernel_ended_cleanup reason=no_topic（记录没有隧道会合信息，清理本地记录）')
    return cleanupRecordedSession(mgr, record, endpoint, epoch, '已清理上次中断的会话记录', recordProvider)
  }

  // 有 topic：先确认 Kernel 是否还活着，已结束就不必再等会合（仍尽力通知远端退出）。
  const status = record.kernelId
    ? await recordProvider.status(record.kernelId).catch((error) => {
        mgr.log.debug('恢复时查询 Kernel 状态失败（按未知处理）', logText(error?.message ?? error, 200))
        return null
      })
    : null
  if (mgr.stoppedByUser || mgr.isStale(epoch) || ACTIVE_STATES.has(mgr.session.state)) return mgr.snapshot()
  // Kernel 已被删除（403/404）：记录里的 kernelStatus 是旧值，不能再拿它去会合点空等。
  if (status?.missing) {
    mgr.log.info(`kernel_missing_cleanup kernelId=${record.kernelId ?? 'none'}（记录的 Kernel 已不存在）`)
    return cleanupRecordedSession(mgr, record, endpoint, epoch, '上次会话的 Kernel 已不存在，已清理本地记录', recordProvider)
  }
  const kernelStatus = status?.ok ? status.status : record.kernelStatus
  if (isKernelEnded(kernelStatus) || kernelStatus === 'CANCEL_REQUESTED') {
    mgr.log.info(`kernel_ended_cleanup reason=kernel_ended status=${kernelStatus ?? 'unknown'}`)
    return cleanupRecordedSession(mgr, record, endpoint, epoch, '上次会话的 Kernel 已结束，已清理本地记录', recordProvider)
  }

  // Kernel 可能仍在排队或运行：回会合点重新取隧道地址。按新会话重新计时，
  // 旧 startedAt 可能早已超过排队/隧道超时窗口，不能再用它判定超时。
  mgr.log.info(`ntfy_rejoin kernelStatus=${kernelStatus ?? 'unknown'}`)
  applyRecord(mgr, record, null)
  mgr.session.kernelStatus = kernelStatus
  if (isKernelQueued(kernelStatus)) {
    mgr.transition('provisioning', { phase: 'queue' })
    mgr.session.detail = `已恢复等待队列（${kernelStatus}）`
  } else {
    mgr.session.detail = '正在重新会合已保存的会话'
  }
  mgr.session.startedAt = isoNow()
  mgr.session.readyAt = null
  mgr.watch()
  mgr.persistSession({ force: true })
  return mgr.snapshot()
}
