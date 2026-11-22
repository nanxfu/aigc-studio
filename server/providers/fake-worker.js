/**
 * Worker 型 provider 的测试替身（只用于离线回归，不参与产品运行时）。
 *
 * 为什么需要它：M3.0 要把「长驻 Worker」接进会话状态机（`kind === 'worker'`：
 * 无 Kernel、无排队、无 ntfy 会合、断开不关机），但真正的私有 Worker 连接器
 * 要到 M3.1 才落地。先用一个行为等价、可指向本机 mock HTTP 服务的替身，
 * 把 `SessionManager.start / stop / restore` 与记录 v2 的路径跑通。
 *
 * 行为（与 M3_PRIVATE_WORKER_AND_MCP_PLAN.md §5.3 对齐）：
 *  - `provision`：归一 endpoint → `GET /health` → 鉴权/协议主版本/能力位校验 →
 *    返回 `{ handle, token }`（token 由外部注入，不写进 handle）；
 *  - `pollEndpoint`：长驻地址固定，恒返回 null（状态机拿到 endpoint 后直接进健康轮询）；
 *  - `checkAlive`：单次 `/health`；401 / 网络失败按 `alive:false` + status 返回；
 *  - `teardown`：共享 Worker 只断开、不发 `/shutdown`（避免误关别人机器）；
 *  - `cleanupPending` / `buildPendingCleanupRecord`：共享 Worker 没有需要补清理的远端资源。
 *
 * M3.1-b 起健康 / 协议判定已抽到 `worker-connection.js`，真实连接器与探针路由共用；
 * 本文件只保留「token/endpoint 由测试注入」的替身能力。
 *
 * @module server/providers/fake-worker
 */

import { TIMEOUTS } from '../../shared/contract.js'
import { ProviderError } from './provider.js'
import { normalizeWorkerEndpoint } from './worker-url.js'
import { assertWorkerCompatible, fetchWorkerHealth, protocolMajorOf, workerHandleOf } from './worker-connection.js'

/**
 * @param {object} input
 * @param {string} input.endpointUrl Worker 基地址（测试里指向本机 mock 服务）
 * @param {string} input.token 访问令牌（Bearer）
 * @param {string} [input.id] 来源 id（默认 private-worker；local-gpu 复用）
 * @param {string} [input.workerId] 可序列化句柄里的实例标识
 * @param {string} [input.protocolVersion] Host 侧期望的协议版本（默认取契约）
 * @param {boolean} [input.owned] 是否由 Host 管理进程（本机 GPU）
 * @param {object} [input.log] 日志器（缺省静默）
 */
export function createFakeWorkerProvider({
  endpointUrl,
  token,
  id = 'private-worker',
  workerId = 'fake-worker-1',
  protocolVersion = null,
  owned = false,
  log = null,
} = {}) {
  const rawBase = typeof endpointUrl === 'string' ? endpointUrl.trim() : ''
  let base = ''
  const expectedMajor = protocolMajorOf(protocolVersion) ?? 2

  /** 归一地址并做 HTTPS / 凭据 / query 校验；非法地址直接给可执行错误。 */
  function endpoint() {
    if (base) return base
    const normalized = normalizeWorkerEndpoint(rawBase)
    if (!normalized.ok) throw new ProviderError('worker_unreachable', normalized.message)
    base = normalized.endpointUrl
    return base
  }

  /** 一次 /health；失败抛 ProviderError（与真实连接器同一套分类）。 */
  async function health() {
    return fetchWorkerHealth({ endpointUrl: endpoint(), token, timeoutMs: TIMEOUTS.remoteHealthMs })
  }

  /** 协议与能力位校验：主版本必须一致，声明了 tools 时必须能出图。 */
  function assertCompatible(payload) {
    return assertWorkerCompatible(payload, expectedMajor)
  }

  function handleOf(payload) {
    return workerHandleOf(payload, {
      endpointUrl: endpoint(),
      provider: id,
      owned,
      workerId,
    })
  }

  return {
    id,
    kind: 'worker',
    label: '测试用 Worker',

    /**
     * 连接并校验；返回 `{ handle, token }`。
     * 状态机识别 `{ handle, token }` 形态（Kaggle/Colab 仍直接返回 handle）。
     */
    async provision(run, { onProgress = () => {} } = {}) {
      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        throw new ProviderError('stale', '启动流程已作废')
      }
      const payload = await health()
      if (payload?.phase === 'error') {
        throw new ProviderError('remote_error', `私有 Worker 处于错误状态：${payload?.detail ?? payload?.last_error ?? '未知'}`)
      }
      assertCompatible(payload)
      onProgress({ phase: 'push', detail: '已连接私有 Worker', persist: true })
      log?.info?.(`worker_provision ok id=${id} workerId=${workerId} phase=${payload?.phase ?? 'unknown'}`)
      return { handle: handleOf(payload), token: token ?? null }
    },

    /** 长驻地址固定：状态机不需要轮询会合。 */
    async pollEndpoint() {
      return null
    },

    async checkAlive() {
      try {
        const payload = await health()
        return { alive: true, status: payload?.phase ?? 'ready' }
      } catch (error) {
        return { alive: false, status: error?.code ?? 'worker_unreachable', missing: false }
      }
    },

    async keepAlive() {
      return { ok: true, detail: 'worker: noop' }
    },

    /**
     * 断开：共享 Worker 只断开连接，不发 /shutdown；owned（本机 GPU）才真正停机。
     * 幂等：重复调用返回 ok。
     */
    async teardown() {
      return { ok: true, detail: owned ? 'owned worker stopped' : 'worker disconnected' }
    },

    async cleanupPending() {
      return null
    },

    buildPendingCleanupRecord() {
      return null
    },

    async readLogs() {
      return null
    },

    /** 进程重启后按记录接管：/health 可达即返回 handle，否则 null（由调用方决定清理/报错）。 */
    async attach(record = {}) {
      const payload = await health()
      assertCompatible(payload)
      return handleOf(payload)
    },

    async releaseRecord() {
      return true
    },
  }
}

export default createFakeWorkerProvider
