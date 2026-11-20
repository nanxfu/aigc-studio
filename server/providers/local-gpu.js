/**
 * [Phase 2+ 预留] 本机 GPU 算力来源（nvidia-smi 探测 + uv 隔离环境）。
 *
 * 本文件只建立**契约占位**，不实现具体逻辑（Phase 1 只接 Kaggle / Colab）。
 * 目的：把「本机显卡运行时管理」的接口形状提前固定下来，避免 Phase 2+ 再改会话状态机。
 *
 * 计划中的实现边界（见 docs/AIGC_STUDIO_STANDALONE_PLAN.md §五.3）：
 *  - 显卡探测：`nvidia-smi --query-gpu=name,memory.total,memory.free` 解析为能力位；
 *  - 运行时隔离：用 `uv` 创建独立 Python 环境，避免与用户全局环境互相污染；
 *  - 进程托管：拉起本机 worker（见 worker/worker_server.py 预留入口），健康检查后直接出图；
 *  - 产物回传：本机路径直接落盘，不需要隧道与 base64。
 *
 * 契约（与 server/providers/provider.js 的 ComputeProvider 对齐）：
 *   id: 'local-gpu'
 *   provision(run, options)              → Promise<handle>
 *   pollEndpoint(run, handle)            → Promise<{ endpointUrl } | null>
 *   checkAlive(run, handle)              → Promise<{ alive, status?, missing?, queued? }>
 *   keepAlive(run, handle)               → Promise<{ ok, detail? }>
 *   teardown(run, handle, context?)      → Promise<{ ok, detail? }>
 *   cleanupPending(record)               → Promise<boolean | null>
 *   readLogs(run, handle, options?)      → Promise<string | null>
 *   capability()                         → Promise<object>（Phase 2+：显卡型号/显存）
 *
 * @module server/providers/local-gpu
 */

/** 稳定错误码：调用方据此给出可读提示，而不是把「未实现」当成网络错误。 */
export const LOCAL_GPU_NOT_IMPLEMENTED = 'not_implemented'

/** 统一的未实现错误（Phase 1 不注册该 provider，正常路径不会触达）。 */
function notImplemented(operation) {
  return Object.assign(
    new Error(`local-gpu 算力来源尚未实现（${operation}）；Phase 1 请使用 kaggle / colab`),
    { code: LOCAL_GPU_NOT_IMPLEMENTED, provider: 'local-gpu' },
  )
}

/**
 * 创建 local-gpu provider 的占位实例。
 *
 * @returns {object} 形状完整的 provider 对象，各方法均抛出 not_implemented。
 */
export function createLocalGpuProvider() {
  const fail = (operation) => async () => {
    throw notImplemented(operation)
  }
  return {
    id: 'local-gpu',
    label: '本机 GPU（Phase 2+）',
    provision: fail('provision'),
    pollEndpoint: fail('pollEndpoint'),
    checkAlive: fail('checkAlive'),
    keepAlive: fail('keepAlive'),
    teardown: fail('teardown'),
    cleanupPending: fail('cleanupPending'),
    readLogs: fail('readLogs'),
    capability: fail('capability'),
  }
}

export default createLocalGpuProvider
