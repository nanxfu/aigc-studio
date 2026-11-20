/**
 * [Phase 2 预留] 私有远程 Worker / Docker / SSH 隧道算力来源。
 *
 * 本文件只建立**契约占位**，不实现具体逻辑（Phase 1 只接 Kaggle / Colab）。
 * 目的：把「长驻 Worker 型」算力来源的接口形状提前固定下来，避免 Phase 2 再改会话状态机。
 *
 * 与 notebook 临时型（kaggle / colab）的差异（见 docs/AIGC_STUDIO_STANDALONE_PLAN.md §五.3）：
 *  - 长驻进程：worker 已在用户自建 Linux GPU 服务器 / Docker 容器里运行，
 *    不需要「申请实例 + 打包推送 + 会合隧道 + 空闲关机」这一整套；
 *  - 直连健康检查：`provision` 只做一次可达性校验并返回稳定 handle；
 *  - 进度流：Phase 2 计划走 SSE / WebSocket 推送任务进度，而不是单次长轮询；
 *  - 产物拉取：Phase 2 计划用二进制 multipart / HTTP Range，而不是 base64 JSON 回传。
 *
 * 契约（与 server/providers/provider.js 的 ComputeProvider 对齐）：
 *   id: 'private-worker'
 *   provision(run, options)              → Promise<handle>（可序列化）
 *   pollEndpoint(run, handle)            → Promise<{ endpointUrl } | null>
 *   checkAlive(run, handle)              → Promise<{ alive, status?, missing?, queued? }>
 *   keepAlive(run, handle)               → Promise<{ ok, detail? }>
 *   teardown(run, handle, context?)      → Promise<{ ok, detail? }>
 *   cleanupPending(record)               → Promise<boolean | null>
 *   readLogs(run, handle, options?)      → Promise<string | null>
 *
 * @module server/providers/private-worker
 */

/** 稳定错误码：调用方据此给出可读提示，而不是把「未实现」当成网络错误。 */
export const PRIVATE_WORKER_NOT_IMPLEMENTED = 'not_implemented'

/** 统一的未实现错误（Phase 1 不注册该 provider，正常路径不会触达）。 */
function notImplemented(operation) {
  return Object.assign(
    new Error(`private-worker 算力来源尚未实现（${operation}）；Phase 1 请使用 kaggle / colab`),
    { code: PRIVATE_WORKER_NOT_IMPLEMENTED, provider: 'private-worker' },
  )
}

/**
 * 创建 private-worker provider 的占位实例。
 *
 * @returns {object} 形状完整的 provider 对象，各方法均抛出 not_implemented。
 */
export function createPrivateWorkerProvider() {
  const fail = (operation) => async () => {
    throw notImplemented(operation)
  }
  return {
    id: 'private-worker',
    label: '私有 Worker（Phase 2）',
    provision: fail('provision'),
    pollEndpoint: fail('pollEndpoint'),
    checkAlive: fail('checkAlive'),
    keepAlive: fail('keepAlive'),
    teardown: fail('teardown'),
    cleanupPending: fail('cleanupPending'),
    readLogs: fail('readLogs'),
  }
}

export default createPrivateWorkerProvider
