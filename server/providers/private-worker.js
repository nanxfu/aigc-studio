/**
 * 私有远程 Worker / 本机 GPU 算力来源（草案占位，M3.1 / M3.4 实现）。
 *
 * M3.0 只把「长驻 Worker 型」接进 Provider 注册表与状态机（能力位见
 * `shared/contract.js` 的 `PROVIDERS`），真正的连接逻辑留给 M3.1：
 *  - `provision`：归一 endpoint → `GET /health` → 校验协议主版本 → 返回稳定 handle；
 *  - `teardown`：共享 Worker 只断开、不发 /shutdown（避免误关别人的机器）；
 *  - 本机 GPU（`local-gpu`）复用同一套连接逻辑，另加 `owned` 的进程托管。
 *
 * 在 M3.1 落地前，本文件必须保持「构造不报错、调用明确报未实现」：
 * 设置里暂时选不到这些来源（`PROVIDERS[id].enabled === false`），正常路径不会触达。
 *
 * 契约（与 server/providers/provider.js 的 ComputeProvider 对齐）：
 *   id: 'private-worker' | 'local-gpu'
 *   provision(run, options)              → Promise<handle | { handle, token }>
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

/** 统一的未实现错误（M3.0 不注册为可选来源，正常路径不会触达）。 */
function notImplemented(operation, id) {
  return Object.assign(
    new Error(`${id} 算力来源尚未实现（${operation}）；当前请使用 kaggle / colab`),
    { code: PRIVATE_WORKER_NOT_IMPLEMENTED, provider: id },
  )
}

/**
 * 创建 worker 型 provider 的占位实例。
 *
 * @param {{ ctx?: object, log?: object, manager?: object, options?: object, id?: string }} [input]
 * @returns {object} 形状完整的 provider 对象，各方法均抛出 not_implemented。
 */
export function createPrivateWorkerProvider({ id = 'private-worker' } = {}) {
  const fail = (operation) => async () => {
    throw notImplemented(operation, id)
  }
  return {
    id,
    kind: 'worker',
    label: id === 'local-gpu' ? '本机 GPU（M3.4）' : '私有 Worker（M3.1）',
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
