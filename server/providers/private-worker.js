/**
 * 私有远程 Worker / 本机 GPU 算力来源（M3.1-b）。
 *
 * 与 notebook 型 provider 的差异全部收在这里：
 *  - 长驻服务，没有 Kernel、队列与会合；连接 = 一次 /health + 协议校验；
 *  - 共享 Worker 的 teardown 只断开本地连接，绝不发 /shutdown；
 *  - 地址与 Token 来自 app-config 的 `compute.privateWorker` + 加密凭据，不进入会话记录
 *    之外的任何位置（记录本身也是 0600 私有文件）；
 *  - `/health` 的 booting / installing / loading 不是失败：返回句柄后由状态机的心跳轮询
 *    等它推进到 ready；只有 phase=error 才直接失败。
 *
 * 连接判定的公共部分在 `./worker-connection.js`，与测试替身和 /api/worker/probe 共用。
 *
 * @module server/providers/private-worker
 */

import { TIMEOUTS } from '../../shared/contract.js'
import { logText } from '../redact.js'
import { requestLogs, requestShutdown } from '../remote.js'
import { ProviderError } from './provider.js'
import { normalizeWorkerEndpoint } from './worker-url.js'
import {
  assertWorkerCompatible,
  fetchWorkerHealth,
  workerHandleOf,
} from './worker-connection.js'

/** 地址不可用 / 未配置时的统一文案（调用方按 worker_unreachable 展示）。 */
function endpointError(message, cause = null) {
  return new ProviderError('worker_unreachable', message, { cause })
}

/**
 * 创建 worker 型 provider。
 *
 * `options.getWorkerConfig()` 由装配层注入，必须返回 `{ endpointUrl, token }`：
 * 用 getter 而不是构造时快照，设置抽屉保存后下一次「连接」即可生效，无需重启。
 *
 * @param {{ id?: string, ctx?: object, log?: object, manager?: object, options?: object }} [input]
 */
export function createPrivateWorkerProvider({
  id = 'private-worker',
  ctx = null,
  log = null,
  manager = null,
  options = {},
} = {}) {
  const owned = id === 'local-gpu' || options.owned === true

  /** 读取当前生效的连接配置；非法地址直接抛可执行错误。 */
  function connectionConfig() {
    const live = typeof options.getWorkerConfig === 'function' ? options.getWorkerConfig() : null
    const endpointRaw = live?.endpointUrl ?? options.workerEndpoint ?? ''
    const token = typeof live?.token === 'string'
      ? live.token
      : typeof options.workerToken === 'string'
        ? options.workerToken
        : ''
    const normalized = normalizeWorkerEndpoint(endpointRaw)
    if (!normalized.ok) throw endpointError(normalized.message)
    return { endpointUrl: normalized.endpointUrl, token }
  }

  /** 运行中优先使用会话已有地址，其次才读设置（恢复 / 断开时都适用）。 */
  function currentEndpoint(run, handle = {}) {
    const endpoint = handle.endpointUrl ?? run?.session?.endpointUrl
    if (typeof endpoint === 'string' && endpoint) return endpoint
    return connectionConfig().endpointUrl
  }

  function currentToken(run, handle = {}) {
    return handle.token ?? run?.secret?.token ?? connectionConfig().token
  }

  return {
    id,
    kind: 'worker',
    label: id === 'local-gpu' ? '本机 GPU' : '私有 Worker',

    /**
     * 连接并校验协议；返回 `{ handle, token }`（token 不进 handle / 快照）。
     */
    async provision(run, { onProgress = () => {} } = {}) {
      const { endpointUrl, token } = connectionConfig()
      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        throw new ProviderError('stale', '启动流程已作废')
      }
      const payload = await fetchWorkerHealth({ ctx, endpointUrl, token, timeoutMs: TIMEOUTS.remoteHealthMs })
      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        throw new ProviderError('stale', '启动流程已作废')
      }
      if (payload?.phase === 'error') {
        const detail = payload.last_error ?? payload.detail ?? '未知'
        throw new ProviderError('remote_error', `私有 Worker 处于错误状态：${String(detail).slice(0, 700)}`)
      }
      assertWorkerCompatible(payload)
      // 把首次 /health 的能力位（binary / events / loaders）立刻写进会话，避免「刚连上就出图」
      // 的第一个任务因为还没轮到心跳轮询而回退 inline。
      manager?.applyHealthDetails?.(payload)
      const handle = workerHandleOf(payload, { endpointUrl, provider: id, owned })
      onProgress({ phase: 'push', detail: '已连接私有 Worker，正在校验协议' })
      log?.info?.(
        `worker_provision ok id=${id} endpoint=${endpointUrl} workerId=${handle.workerId} ` +
          `protocol=${handle.protocolVersion ?? 'unknown'} phase=${payload?.phase ?? 'unknown'}`,
      )
      return { handle, token }
    },

    /** 长驻地址固定：状态机已经拿到 endpoint，这里只做幂等返回。 */
    async pollEndpoint(run, handle = {}) {
      return { endpointUrl: currentEndpoint(run, handle) }
    },

    /** 单次探测；401 / 网络失败按 alive:false + status 返回，由状态机决定文案。 */
    async checkAlive(run, handle = {}) {
      try {
        const endpointUrl = currentEndpoint(run, handle)
        const payload = await fetchWorkerHealth({
          ctx,
          endpointUrl,
          token: currentToken(run, handle),
          timeoutMs: TIMEOUTS.remoteHealthMs,
        })
        return { alive: true, status: payload?.phase ?? 'ready' }
      } catch (error) {
        return { alive: false, status: error?.code ?? 'worker_unreachable', missing: false }
      }
    },

    /** 长驻服务不需要心跳续命；Host 的 /health 轮询已经足够。 */
    async keepAlive() {
      return { ok: true, detail: 'worker: noop' }
    },

    /**
     * 断开：共享 Worker 只释放本地连接，绝不发 /shutdown；
     * owned（本机 GPU，M3.4）才通知进程退出。幂等。
     */
    async teardown(run, handle = {}) {
      if (!owned) return { ok: true, detail: 'worker disconnected' }
      let endpointUrl
      let token
      try {
        endpointUrl = currentEndpoint(run, handle)
        token = currentToken(run, handle)
      } catch (error) {
        log?.debug?.('本机 Worker 断开时未找到连接配置（忽略）', logText(error?.message ?? error, 200))
        return { ok: true, detail: 'worker config missing' }
      }
      const ok = await requestShutdown(endpointUrl, token, TIMEOUTS.remoteShutdownMs, ctx)
      return { ok, detail: ok ? 'owned worker stopped' : 'shutdown request failed' }
    },

    /** 共享 Worker 没有需要补清理的远端资源；owned 的进程清理由 M3.4 的进程托管负责。 */
    async cleanupPending() {
      return null
    },

    buildPendingCleanupRecord() {
      return null
    },

    /** 日志尾：GET /logs?since=，与 daemon 同形；失败返回 null 不阻断会话。 */
    async readLogs(run, handle = {}, { since = 0 } = {}) {
      let endpointUrl
      let token
      try {
        endpointUrl = currentEndpoint(run, handle)
        token = currentToken(run, handle)
      } catch {
        return null
      }
      try {
        const payload = await requestLogs(endpointUrl, token, since, TIMEOUTS.remoteLogsMs, ctx)
        const lines = Array.isArray(payload?.lines) ? payload.lines.filter((line) => typeof line === 'string') : []
        return lines.length > 0 ? lines.join('\n') : null
      } catch (error) {
        log?.debug?.('读取私有 Worker 日志失败（忽略）', logText(error?.message ?? error, 200))
        return null
      }
    },

    /** 进程重启后按记录接管：可达且协议兼容才返回句柄。 */
    async attach(record = {}) {
      const endpointUrl = normalizeWorkerEndpoint(record.endpointUrl)
      if (!endpointUrl.ok) throw endpointError(endpointUrl.message)
      const payload = await fetchWorkerHealth({
        ctx,
        endpointUrl: endpointUrl.endpointUrl,
        token: record.token,
        timeoutMs: TIMEOUTS.remoteHealthMs,
      })
      assertWorkerCompatible(payload)
      return workerHandleOf(payload, { endpointUrl: endpointUrl.endpointUrl, provider: id, owned })
    },
  }
}

export default createPrivateWorkerProvider