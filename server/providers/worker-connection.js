/**
 * 长驻 Worker 的连接判定：地址归一、/health 探测、协议与能力校验。
 *
 * 三个调用点共用这一份口径：
 *  - `private-worker.js`：真实连接器（provision / checkAlive / readLogs）；
 *  - `fake-worker.js`：离线测试替身（M3.0 起就靠它跑会话状态机）；
 *  - `server/routes/worker.js`：设置抽屉的「测试连接」。
 *
 * 约束：
 *  - 诊断结果只暴露 phase / protocol / hardware / capabilities，不回传 Token 或原始响应；
 *  - 失败一律抛 `ProviderError`（code 见 PROVIDER_ERROR_CODES），由调用方决定文案；
 *  - 不在此模块创建定时器，只做单次请求。
 *
 * @module server/providers/worker-connection
 */

import { PROTOCOL_VERSION, TIMEOUTS } from '../../shared/contract.js'
import { fetchHealth } from '../remote.js'
import { ProviderError } from './provider.js'
import { normalizeWorkerEndpoint } from './worker-url.js'

/** 取语义化版本的主版本号；不可解析返回 null。 */
export function protocolMajorOf(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const first = text.split('.')[0]
  return /^[0-9]+$/.test(first) ? Number(first) : null
}

/** Host 当前期望的协议主版本（私有 Worker 必须先对齐主版本）。 */
export const EXPECTED_PROTOCOL_MAJOR = protocolMajorOf(PROTOCOL_VERSION) ?? 2

/** 从 httpText / fetchHealth 的错误信息里区分鉴权失败与网络失败。 */
export function classifyWorkerHealthError(error) {
  const text = String(error?.message ?? error)
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(text)) return 'worker_unauthorized'
  return 'worker_unreachable'
}

/** 不可达错误：地址无法解析、DNS、拒绝连接、超时都归这一类。 */
function unreachable(message, cause = null) {
  return new ProviderError('worker_unreachable', message, { cause })
}

/**
 * 单次 GET /health，失败时抛出带错误码的 ProviderError。
 *
 * @param {{ ctx?: object, endpointUrl: string, token?: string, timeoutMs?: number }} input
 * @returns {Promise<object>} Worker /health 原始载荷（调用方只取白名单字段）
 */
export async function fetchWorkerHealth({
  ctx = null,
  endpointUrl,
  token = '',
  timeoutMs = TIMEOUTS.remoteHealthMs,
} = {}) {
  const normalized = normalizeWorkerEndpoint(endpointUrl)
  if (!normalized.ok) throw unreachable(normalized.message)
  try {
    const payload = await fetchHealth(normalized.endpointUrl, token, timeoutMs, ctx)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw unreachable('私有 Worker /health 返回了非对象响应')
    }
    return payload
  } catch (error) {
    if (error?.name === 'ProviderError') throw error
    const code = classifyWorkerHealthError(error)
    const message = code === 'worker_unauthorized'
      ? '私有 Worker 鉴权失败：Token 缺失或不正确'
      : `私有 Worker 不可达：${error?.message ?? error}`
    throw new ProviderError(code, message, { cause: error })
  }
}

/**
 * 协议主版本与必需能力校验。
 *
 * 次版本允许 Worker 更高（忽略未知 capability），主版本必须一致；
 * Worker 显式声明 tools 时必须包含 generate，否则视为能力缺失而不是网络错误。
 *
 * @param {object} payload /health 载荷
 * @returns {null | { code: string, message: string }}
 */
export function workerCompatibilityErrorOf(payload, expectedMajor = EXPECTED_PROTOCOL_MAJOR) {
  const remote = payload?.protocol_version
  const remoteMajor = protocolMajorOf(remote)
  if (remoteMajor === null) {
    return {
      code: 'protocol_mismatch',
      message: '私有 Worker 未上报 protocol_version：请升级到支持协议 v2 的 Worker',
    }
  }
  if (remoteMajor !== expectedMajor) {
    return {
      code: 'protocol_mismatch',
      message: `私有 Worker 协议版本 ${String(remote)} 与客户端不兼容（需要 ${expectedMajor}.x）：请升级 Worker 或客户端`,
    }
  }
  const tools = payload?.capabilities?.tools
  if (Array.isArray(tools) && tools.length > 0 && !tools.includes('generate')) {
    return {
      code: 'capability_missing',
      message: '私有 Worker 未声明 generate 能力：请检查 Worker 侧推理依赖与模型加载器',
    }
  }
  return null
}

/** 协议不兼容时直接抛 ProviderError。 */
export function assertWorkerCompatible(payload, expectedMajor = EXPECTED_PROTOCOL_MAJOR) {
  const problem = workerCompatibilityErrorOf(payload, expectedMajor)
  if (problem) throw new ProviderError(problem.code, problem.message)
  return payload
}

/** 可序列化的 Worker 句柄；token 由调用方单独保管，绝不放进 handle。 */
export function workerHandleOf(payload, { endpointUrl, provider = 'private-worker', owned = false, workerId: forcedId = '' } = {}) {
  let workerId = typeof forcedId === 'string' ? forcedId.trim() : ''
  if (!workerId && typeof payload?.worker_id === 'string') workerId = payload.worker_id.trim()
  if (!workerId) {
    try {
      workerId = new URL(endpointUrl).host || 'worker'
    } catch {
      workerId = 'worker'
    }
  }
  return {
    kind: 'worker',
    provider,
    workerId,
    endpointUrl,
    protocolVersion: typeof payload?.protocol_version === 'string' ? payload.protocol_version : null,
    owned: owned === true,
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null
}

function finiteNumberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** 诊断白名单：GPU / 显存 / 驱动 / CUDA / 数量。 */
export function publicHardwareOf(payload) {
  const hardware = payload && typeof payload.hardware === 'object' && payload.hardware ? payload.hardware : null
  if (!hardware) return null
  return {
    gpu_name: stringOrNull(hardware.gpu_name),
    vram_total_mb: finiteNumberOrNull(hardware.vram_total_mb),
    driver: stringOrNull(hardware.driver),
    cuda: stringOrNull(hardware.cuda),
    count: finiteNumberOrNull(hardware.count),
  }
}

/** 诊断白名单：结果模式 / 事件 / Range / 工具 / 加载器 / 参考与重绘能力。 */
export function publicCapabilitiesOf(payload) {
  const capabilities = payload && typeof payload.capabilities === 'object' && payload.capabilities ? payload.capabilities : null
  if (!capabilities) return null
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  return {
    result_modes: strings(capabilities.result_modes),
    events: capabilities.events === true,
    artifact_range: capabilities.artifact_range === true,
    tools: strings(capabilities.tools),
    loaders: strings(capabilities.loaders),
    reference: capabilities.reference === true,
    inpaint: capabilities.inpaint === true,
  }
}

/**
 * 设置抽屉「测试连接」：把一次 /health 收敛成可展示结果，永不抛异常。
 *
 * 返回形状固定，失败也带 phase / hardware（如果 Worker 已经回了 JSON），
 * 便于界面在协议不匹配时仍能显示 Worker 版本与 GPU。
 *
 * @param {{ ctx?: object, endpointUrl: string, token?: string, timeoutMs?: number }} input
 * @returns {Promise<{
 *   ok: boolean, phase: string|null, protocolVersion: string|null,
 *   hardware: object|null, capabilities: object|null, modelId: string|null,
 *   error: { code: string, message: string } | null,
 * }>}
 */
export async function probeWorkerConnection({
  ctx = null,
  endpointUrl,
  token = '',
  timeoutMs = TIMEOUTS.workerProbeMs,
} = {}) {
  const failure = (code, message) => ({
    ok: false,
    phase: null,
    protocolVersion: null,
    hardware: null,
    capabilities: null,
    modelId: null,
    error: { code, message },
  })
  const normalized = normalizeWorkerEndpoint(endpointUrl)
  if (!normalized.ok) return failure('invalid_request', normalized.message)

  let payload
  try {
    payload = await fetchWorkerHealth({ ctx, endpointUrl: normalized.endpointUrl, token, timeoutMs })
  } catch (error) {
    return failure(error?.code ?? 'worker_unreachable', error?.message ?? String(error))
  }

  const problem = workerCompatibilityErrorOf(payload)
  return {
    ok: !problem,
    phase: stringOrNull(payload.phase),
    protocolVersion: stringOrNull(payload.protocol_version),
    hardware: publicHardwareOf(payload),
    capabilities: publicCapabilitiesOf(payload),
    modelId: stringOrNull(payload.model_id),
    error: problem,
  }
}