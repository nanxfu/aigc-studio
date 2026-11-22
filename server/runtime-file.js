/**
 * `runtime.json`：本地服务的「发现文件」，供 MCP Server 等外部进程找到端口与 Token。
 *
 * 为什么需要它（M3.3）：
 *  - 端口是启动时随机分配的，外部进程无法猜；Token 每次启动随机，不能写进固定配置；
 *  - 外部进程不应该 import `server/app.js`（会复制队列/会话状态），只通过已鉴权的
 *    `http://127.0.0.1:<port>/api/*` 调用；
 *  - 文件必须原子写（同目录临时文件 + rename）与 0600，避免读到半截 JSON 或让同机
 *    其它用户拿到 Token。
 *
 * 生命周期：服务监听成功后写入；正常退出时删除。崩溃残留由 MCP 侧用 `pid` 存活检查
 * 识别为 stale——**不自动删除**，避免误删正在启动的新实例刚写入的文件。
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from './fs-atomic.js'

/** 发现文件 schema 版本：字段只增不改，客户端忽略不认识的字段。 */
export const RUNTIME_SCHEMA = 1

export function runtimeFilePath(dataDir) {
  return join(dataDir, 'runtime.json')
}

/**
 * 写入发现文件（0600）。
 *
 * @param {string} dataDir 应用全局数据目录
 * @param {object} payload `{ pid, port, origin, token, version, protocol, workspace, startedAt }`
 */
export async function writeRuntimeFile(dataDir, payload) {
  const body = {
    schema: RUNTIME_SCHEMA,
    pid: process.pid,
    port: Number(payload.port),
    origin: String(payload.origin ?? ''),
    token: String(payload.token ?? ''),
    version: String(payload.version ?? ''),
    protocol: String(payload.protocol ?? ''),
    workspace: typeof payload.workspace === 'string' ? payload.workspace : null,
    startedAt: String(payload.startedAt ?? new Date().toISOString()),
  }
  await writeFileAtomic(runtimeFilePath(dataDir), `${JSON.stringify(body, null, 2)}\n`, {
    ensureDir: true,
    dirMode: 0o700,
    fileMode: 0o600,
    encoding: 'utf8',
    cleanStale: true,
    tempPrefix: 'runtime.json.tmp-',
  })
  return body
}

/**
 * 删除发现文件；只删自己写的（`pid` 不一致说明文件已属于新实例，不能动）。
 *
 * @param {string} dataDir
 * @param {number} [pid] 默认当前进程
 */
export async function removeRuntimeFile(dataDir, pid = process.pid) {
  const file = runtimeFilePath(dataDir)
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    if (Number(parsed?.pid) !== Number(pid)) return false
  } catch {
    // 文件不存在 / 内容损坏：都按「不需要删」处理，避免误删。
    return false
  }
  await rm(file, { force: true }).catch(() => {})
  return true
}
