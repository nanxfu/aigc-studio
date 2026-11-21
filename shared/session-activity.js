/**
 * 「云端算力是否仍在消耗」的唯一判定（纯函数，不依赖 Electron / DOM）。
 *
 * 两处消费，必须同一口径：
 *  - 主进程：窗口关闭拦截、托盘文案、更新安装护栏（`electron/updater.mjs`）；
 *  - 安装护栏不能只信 5 秒前的缓存，会先重新拉一次 `/api/state` 再判定。
 *
 * 状态取值与 `server/session/state.js` 的状态机对齐；同时兼容规范文档里的
 * `session.status` 写法和部分快照的 `jobs` 列表（旧宿主 / 启动早期）。
 */

/** 视为「云端仍有算力在消耗」的会话状态。 */
export const ACTIVE_SESSION_STATES = Object.freeze([
  'provisioning',
  'connecting',
  'warming',
  'ready',
  'stopping',
  'running',
  'starting',
])

const ACTIVE_SET = new Set(ACTIVE_SESSION_STATES)

/** 归一化会话状态：优先 session.state，其次 session.status，缺省 absent。 */
export function normalizeSessionState(snapshot) {
  const raw = snapshot?.session?.state ?? snapshot?.session?.status ?? 'absent'
  const state = String(raw ?? 'absent').trim().toLowerCase()
  return state || 'absent'
}

/** 会话本身是否处于「云端正在消耗算力」的状态（不含队列 / 任务）。 */
export function isSessionRunning(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false
  return ACTIVE_SET.has(normalizeSessionState(snapshot))
}

/** 队列里是否有正在跑或待跑的任务。 */
export function isQueueBusy(snapshot) {
  const queue = snapshot?.queue
  if (!queue || typeof queue !== 'object') return false
  if (queue.running) return true
  const pending = Number(queue.pending)
  return Number.isFinite(pending) && pending > 0
}

/** 任务列表里是否有 queued / running / waiting-session 的任务（旧快照兜底）。 */
export function hasActiveJobs(snapshot) {
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : []
  return jobs.some((job) => {
    const status = String(job?.status ?? '').toLowerCase()
    return status === 'running' || status === 'queued' || status === 'waiting-session'
  })
}

/**
 * 判断是否有活跃云端会话或任务（防烧额度判断的唯一入口）。
 *
 * @param {any} snapshot GET /api/state 的响应（可能为 null）
 * @returns {boolean}
 */
export function isSessionActive(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false
  if (ACTIVE_SET.has(normalizeSessionState(snapshot))) return true
  if (isQueueBusy(snapshot)) return true
  return hasActiveJobs(snapshot)
}
