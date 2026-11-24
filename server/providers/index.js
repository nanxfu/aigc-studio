/**
 * 算力来源注册表：把「来源 id → provider 实现」的构造收在一处。
 *
 * 为什么需要这一层（M3.0）：
 *  - 会话状态机（`server/session.js`）此前在 `providerFor()` / `applyProviderSettings()` /
 *    `provision()` 里写死 `kaggle` / `colab` 二选一，新增来源必须改状态机本身；
 *  - 私有 Worker 与 notebook 型的差异（长驻、固定地址、无排队/会合、默认不关机）属于
 *    provider 内部细节，状态机只应依赖 `PROVIDERS[id].kind` 与能力位；
 *  - 能力位单源在 `shared/contract.js` 的 `PROVIDERS`（纯数据，Client 也能读），
 *    这里只负责「按 id 造对象」，不复制第二份元数据。
 *
 * 约束：
 *  - 未登记的 id 直接抛普通 Error（这是编程错误，不是用户可修复的失败，不占用错误码）；
 *  - 构造 provider 不得产生 I/O：真实网络动作全部在 `provision/checkAlive/...` 里；
 *  - 测试可以继续通过 `new SessionManager({ deps: { provider } })` 注入替身，
 *    注入时状态机不会调用本文件（见 session.js 的 providerFor / applyProviderSettings）。
 */

import { PROVIDER_IDS, PROVIDERS } from '../../shared/contract.js'
import { ColabProvider } from '../colab/provider.js'
import { createCloudApiProvider } from './cloud-api.js'
import { KaggleProvider } from './kaggle.js'
import { createLocalGpuProvider } from './local-gpu.js'
import { createPrivateWorkerProvider } from './private-worker.js'

export { PROVIDERS, PROVIDER_IDS }

/** 全部已知来源 id（含尚未开放选择的），返回新数组。 */
export function providerIds() {
  return [...PROVIDER_IDS]
}

/** 来源能力位；未登记返回 null（调用方自行决定回退）。 */
export function providerMetaOf(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null
}

/** `notebook` / `worker` / `cloud-api`；未登记按 notebook 处理（保守回退）。 */
export function providerKindOf(id) {
  const kind = providerMetaOf(id)?.kind
  return kind === 'worker' || kind === 'cloud-api' ? kind : 'notebook'
}

/** 是否长驻 Worker 型来源（决定 provision 是否跳过 Kernel/会合/空闲关机）。 */
export function isWorkerProvider(id) {
  return providerKindOf(id) === 'worker'
}

/** 是否商业生图 API（无会话、0 秒就绪、按张计费）。 */
export function isCloudApiProvider(id) {
  return providerKindOf(id) === 'cloud-api'
}

/** 该来源是否由 Host 自己管理进程（本机 GPU）；共享私有 Worker 为 false。 */
export function isOwnedProvider(id) {
  return providerMetaOf(id)?.owned === true
}

/**
 * 「实例/连接已不可用」的用户文案：notebook 说「唤醒」，worker 说「连接」。
 *
 * 顶栏与指引卡的动作名跟着来源走（M3.1 会把「唤醒/关机」改成「连接/断开」），
 * 错误文案必须同步，否则用户会被指向一个不存在的按钮。
 */
export function instanceLostMessage(providerId) {
  if (isCloudApiProvider(providerId)) {
    return '商业生图 API 调用失败：请检查设置里的服务商、API Key 与账户余额后重试'
  }
  if (providerId === 'local-gpu') {
    return '本机 GPU 未连接或 sd-server 已退出：请检查 local-gpu.json 中的路径、显存 / 内存占用后重新连接'
  }
  return isWorkerProvider(providerId)
    ? '无法连接私有 Worker：请检查 Worker 进程、地址、防火墙或 SSH 隧道后点「连接」重试'
    : '远端实例已不存在或已停止，点「唤醒」可重新启动会话'
}

/**
 * 按 id 构造 provider。
 *
 * @param {'kaggle'|'colab'|'private-worker'|'local-gpu'} id
 * @param {{ ctx?: object, deps?: object, log?: object, manager?: object, options?: object }} input
 *   - `deps`：沿用既有 Kaggle 注入表（测试零改动）；
 *   - `manager`：SessionManager（补清理 / 落盘需要）；
 *   - `options`：provider 需要的运行参数（colabGpu / trustedTunnelDomains 等）。
 */
export function createProvider(id, { ctx, deps = {}, log, manager = null, options = {} } = {}) {
  switch (id) {
    case 'kaggle':
      return new KaggleProvider({ ctx, deps, log, manager })
    case 'colab':
      return new ColabProvider({ ctx, log, manager, options })
    case 'private-worker':
      return createPrivateWorkerProvider({ ctx, log, manager, options })
    case 'local-gpu':
      return createLocalGpuProvider({ ctx, log, manager, options })
    case 'cloud-api':
      return createCloudApiProvider({ ctx, log, manager, options })
    default:
      throw new Error(`未注册的算力来源：${String(id)}（可选：${PROVIDER_IDS.join(' / ')}）`)
  }
}
