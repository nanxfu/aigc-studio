/**
 * 会话记录的本地持久化：`<workspace>/.aigc-studio/session.json`。
 *
 * 目的：Host 重启 / 插件热重载后仍能找回正在运行的远端会话，避免远端 GPU
 * 空烧配额。记录里含远端 Bearer Token，因此：
 *  - 只写工作区私有目录，目录 0700、文件 0600（Windows 忽略 mode 差异）；
 *  - 落盘用「同目录临时文件 + rename」原子替换，崩溃只会留下可忽略的临时文件；
 *  - 读取时校验版本与关键字段，损坏 / 旧版本记录直接清理，不抛异常；
 *  - token 只在这里落盘，不进入任何日志或对外快照。
 *
 * 版本策略（M3.0）：
 *  - **v1**：Kaggle / Colab 等 notebook 型来源。扁平字段 + 可选 `provider`/`handle`，
 *    与本改造前完全同形，旧客户端可读；
 *  - **v2**：长驻 Worker 型来源（`private-worker` / `local-gpu`）。显式 `provider` 与
 *    `handle{workerId, protocolVersion}`，`kernelId/kernelUrl/topic` 为空；
 *  - 新客户端同时读 v1/v2；v2 里的未知 provider 按无效记录清理，**绝不猜成 Kaggle**
 *    （旧客户端的 `normalizeRecord` 只认 v1，读到 v2 会安全拒绝）。
 */

import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PROVIDERS } from '../../shared/contract.js'
import { removeStaleTemps, writeFileAtomic } from '../fs-atomic.js'
import { META_DIR, workspaceRoot } from '../paths.js'

/** 当前写入版本：worker 型写 2，notebook 型仍写 1（旧客户端可读）。 */
export const SESSION_RECORD_VERSION = 2
/** notebook 型记录的版本号（Kaggle / Colab），保持与 M2 一致。 */
export const SESSION_RECORD_VERSION_NOTEBOOK = 1

const SESSION_FILE = 'session.json'
const TEMP_PREFIX = `${SESSION_FILE}.tmp-`

/** 记录文件的绝对路径。 */
export function sessionRecordPath(ctx) {
  return join(workspaceRoot(ctx), META_DIR, SESSION_FILE)
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

/** 来源是否是已登记的 worker 型（v2 记录只允许这些来源）。 */
function isWorkerProviderId(id) {
  return typeof id === 'string'
    && Object.prototype.hasOwnProperty.call(PROVIDERS, id)
    && PROVIDERS[id]?.kind === 'worker'
}

/** 句柄只保留可序列化的标量，避免把函数/循环引用写进记录。 */
function sanitizeHandle(handle) {
  if (!handle || typeof handle !== 'object') return null
  const out = {}
  for (const [key, value] of Object.entries(handle)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value
  }
  return out
}

/** v2 句柄只保留恢复必需字段：不把 endpoint/token 重复写进 handle。 */
function workerHandleOf(handle) {
  const clean = sanitizeHandle(handle) ?? {}
  return {
    kind: 'worker',
    workerId: stringOrNull(clean.workerId),
    protocolVersion: stringOrNull(clean.protocolVersion),
    ...(clean.owned === true ? { owned: true } : {}),
  }
}

/**
 * 从会话快照与 secret 组装落盘记录；没有可恢复信息时返回 null。
 *
 * @param {object} session 会话快照
 * @param {{ token?: string | null, topic?: string | null }} secret 会话密钥（只落盘，不进快照）
 * @param {{ provider?: string, handle?: object }} [input]
 *   provider.id 决定记录版本：worker → v2，其余 → v1。
 */
export function buildSessionRecord(session = {}, secret = {}, input = {}) {
  const token = stringOrNull(secret?.token)
  const providerId = stringOrNull(input?.provider) ?? 'kaggle'
  const endpointUrl = stringOrNull(session?.endpointUrl)
  const handle = input?.handle ?? null

  // Worker 型：远端地址是唯一恢复线索，必须有 endpointUrl + token。
  if (isWorkerProviderId(providerId)) {
    if (!token || !endpointUrl) return null
    return {
      version: SESSION_RECORD_VERSION,
      savedAt: new Date().toISOString(),
      provider: providerId,
      endpointUrl,
      token,
      handle: workerHandleOf(handle),
      presetId: stringOrNull(session?.presetId),
      startedAt: stringOrNull(session?.startedAt),
      readyAt: stringOrNull(session?.readyAt),
      idleTimeoutSec: numberOrNull(session?.idleTimeoutSec),
      modelId: stringOrNull(session?.modelId),
      device: stringOrNull(session?.device),
      deviceCount: numberOrNull(session?.deviceCount),
      state: stringOrNull(session?.state),
    }
  }

  const kernelId = stringOrNull(session?.kernelId)
  const topic = stringOrNull(secret?.topic)
  if (!token || (!kernelId && !topic && !endpointUrl)) return null
  return {
    version: SESSION_RECORD_VERSION_NOTEBOOK,
    savedAt: new Date().toISOString(),
    kernelId,
    kernelUrl: stringOrNull(session?.kernelUrl),
    kernelStatus: stringOrNull(session?.kernelStatus),
    token,
    topic,
    endpointUrl,
    presetId: stringOrNull(session?.presetId),
    startedAt: stringOrNull(session?.startedAt),
    readyAt: stringOrNull(session?.readyAt),
    idleTimeoutSec: numberOrNull(session?.idleTimeoutSec),
    modelId: stringOrNull(session?.modelId),
    device: stringOrNull(session?.device),
    deviceCount: numberOrNull(session?.deviceCount),
    tunnelProvider: stringOrNull(session?.tunnelProvider),
    state: stringOrNull(session?.state),
    // 非 Kaggle 才写 provider/handle：Kaggle 记录保持原样，v1 读者不受影响。
    ...(providerId !== 'kaggle' ? { provider: providerId, handle: sanitizeHandle(handle) } : {}),
  }
}

/** 归一 v1 记录（notebook）：保持与改造前逐字段一致。 */
function normalizeNotebookRecord(value) {
  const token = stringOrNull(value.token)
  const kernelId = stringOrNull(value.kernelId)
  const topic = stringOrNull(value.topic)
  const endpointUrl = stringOrNull(value.endpointUrl)
  // 没有 token 无法向远端探活/关机；没有任何地址线索也无法恢复，按无效记录处理。
  if (!token || (!kernelId && !topic && !endpointUrl)) return null
  return {
    version: SESSION_RECORD_VERSION_NOTEBOOK,
    savedAt: stringOrNull(value.savedAt),
    kernelId,
    kernelUrl: stringOrNull(value.kernelUrl),
    kernelStatus: stringOrNull(value.kernelStatus),
    token,
    topic,
    endpointUrl,
    presetId: stringOrNull(value.presetId),
    startedAt: stringOrNull(value.startedAt),
    readyAt: stringOrNull(value.readyAt),
    idleTimeoutSec: numberOrNull(value.idleTimeoutSec),
    modelId: stringOrNull(value.modelId),
    device: stringOrNull(value.device),
    deviceCount: numberOrNull(value.deviceCount),
    tunnelProvider: stringOrNull(value.tunnelProvider),
    state: stringOrNull(value.state),
    ...(value.provider === 'colab' ? { provider: 'colab', handle: sanitizeHandle(value.handle) } : {}),
  }
}

/** 归一 v2 记录（worker）：未知来源 / 缺地址 / 缺 token 一律判无效。 */
function normalizeWorkerRecord(value) {
  const providerId = stringOrNull(value.provider)
  if (!isWorkerProviderId(providerId)) return null
  const token = stringOrNull(value.token)
  const endpointUrl = stringOrNull(value.endpointUrl)
  if (!token || !endpointUrl) return null
  return {
    version: SESSION_RECORD_VERSION,
    savedAt: stringOrNull(value.savedAt),
    provider: providerId,
    endpointUrl,
    token,
    handle: workerHandleOf(value.handle),
    presetId: stringOrNull(value.presetId),
    startedAt: stringOrNull(value.startedAt),
    readyAt: stringOrNull(value.readyAt),
    idleTimeoutSec: numberOrNull(value.idleTimeoutSec),
    modelId: stringOrNull(value.modelId),
    device: stringOrNull(value.device),
    deviceCount: numberOrNull(value.deviceCount),
    state: stringOrNull(value.state),
  }
}

/** 校验并归一化一条记录；版本不符或缺关键字段返回 null。 */
function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version === SESSION_RECORD_VERSION_NOTEBOOK) return normalizeNotebookRecord(value)
  if (value.version === SESSION_RECORD_VERSION) return normalizeWorkerRecord(value)
  return null
}

/** 原子写入会话记录；目录与文件权限尽力收紧（Windows 忽略 mode 差异）。 */
export async function writeSessionRecord(ctx, record) {
  if (!record) return null
  const path = sessionRecordPath(ctx)
  const version = record.version === SESSION_RECORD_VERSION
    ? SESSION_RECORD_VERSION
    : SESSION_RECORD_VERSION_NOTEBOOK
  const text = `${JSON.stringify({ ...record, version, savedAt: new Date().toISOString() }, null, 2)}\n`
  await writeFileAtomic(path, text, {
    dirMode: 0o700,
    fileMode: 0o600,
    cleanStale: true,
    tempPrefix: TEMP_PREFIX,
    encoding: 'utf8',
  })
  return { ...record, version }
}

/** 删除记录文件（best-effort，不抛异常）。 */
export async function clearSessionRecord(ctx) {
  const path = sessionRecordPath(ctx)
  await rm(path, { force: true }).catch(() => {})
  await removeStaleTemps(dirname(path), TEMP_PREFIX)
}

/**
 * 读取会话记录。
 * 无文件 → null（正常首次启动）；JSON 损坏 / 版本过旧 / 缺关键字段 → 清理后返回 null。
 * 所有失败都不抛异常：恢复失败只是少一次机会，不能阻塞 Host 启动。
 */
export async function readSessionRecord(ctx) {
  const path = sessionRecordPath(ctx)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // ENOENT 是正常情况；读取失败（权限等）同样按无记录处理，但不删除文件。
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const record = parsed ? normalizeRecord(parsed) : null
  if (record) return record

  // 损坏 / 旧版本 / 缺关键字段：清理掉，避免每次启动反复解析失败。
  await rm(path, { force: true }).catch(() => {})
  await removeStaleTemps(dirname(path), TEMP_PREFIX)
  return null
}
