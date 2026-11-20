/**
 * 桌面壳层日志（electron/ 进程专用）。
 *
 * 职责边界：只记录壳层视角的事件（服务子进程启停、窗口生命周期、托盘、崩溃重启），
 * 不接管本地服务的业务日志（服务自己写 <dataDir>/logs/）。
 *
 * 输出目标：
 *  - 终端：info/debug 走 stdout，warn/error 走 stderr（开发态与冒烟脚本据此观察关键行）；
 *  - 文件：<dataDir>/logs/electron.log，超过 5 MB 轮转为 electron.log.1（只保留一份历史）。
 *
 * 任何写入失败都静默忽略：日志不能影响应用主流程。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_MESSAGE_CHARS = 4000

let logFilePath = ''

/**
 * 初始化壳层日志文件路径（幂等）。
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {string} 日志文件绝对路径；初始化失败时为空串。
 */
export function initShellLogger({ dataDir } = {}) {
  if (!dataDir || typeof dataDir !== 'string') return ''
  try {
    const dir = join(dataDir, 'logs')
    mkdirSync(dir, { recursive: true })
    logFilePath = join(dir, 'electron.log')
    rotateIfNeeded(logFilePath)
    return logFilePath
  } catch {
    logFilePath = ''
    return ''
  }
}

/** 当前日志文件路径（未初始化时为空串）。 */
export function shellLogPath() {
  return logFilePath
}

function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_LOG_BYTES) return
    renameSync(file, `${file}.1`)
  } catch {
    // 轮转失败只影响历史留存，不影响继续写日志。
  }
}

function format(level, scope, message, error) {
  let text = String(message ?? '')
  if (error instanceof Error) text += ` | ${error.stack || error.message}`
  else if (error !== undefined) text += ` | ${String(error)}`
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}…(截断)`
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`
}

function sink(level, line) {
  // 终端输出：打包后的 GUI 进程可能没有可用 stdout/stderr，写入失败直接忽略。
  try {
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
    else process.stdout.write(`${line}\n`)
  } catch {
    // ignore
  }
  if (!logFilePath) return
  try {
    appendFileSync(logFilePath, `${line}\n`, 'utf8')
  } catch {
    // ignore
  }
}

/**
 * 创建一个带作用域名的日志器。
 *
 * @param {string} [scope]
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, filePath: Function }}
 */
export function createLogger(scope = 'app') {
  return {
    debug(message, error) {
      sink('debug', format('debug', scope, message, error))
    },
    info(message, error) {
      sink('info', format('info', scope, message, error))
    },
    warn(message, error) {
      sink('warn', format('warn', scope, message, error))
    },
    error(message, error) {
      sink('error', format('error', scope, message, error))
    },
    filePath() {
      return logFilePath
    },
  }
}
