/**
 * 创作助手对话历史存储：`<workspace>/.aigc-studio/chat.json`。
 *
 * 按工作区落盘持久化，解决 Electron 每次启动端口变化导致浏览器 storage 失效的问题；
 * 读取与写入任何异常都不会阻塞出图主链路。
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { CHAT_HISTORY } from '../shared/contract.js'
import { createSerialQueue, removeStaleTemps, writeFileAtomic } from './fs-atomic.js'
import { META_DIR, workspaceRoot } from './paths.js'

const CHAT_FILE = 'chat.json'
const TEMP_PREFIX = `${CHAT_FILE}.tmp-`
const serialize = createSerialQueue()

/** 对话历史文件的绝对路径。 */
export function chatHistoryPath(ctx) {
  return join(workspaceRoot(ctx), META_DIR, CHAT_FILE)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function settledStage(stage) {
  return stage === 'running' || stage === 'pending' ? 'done' : stage
}

/** 归一待落盘的消息列表：剔除任务气泡，收敛中断态，保留最近 N 条。 */
export function normalizeStoredChatMessages(raw) {
  const out = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isPlainObject(item)) continue
    if (item.kind === 'job') continue
    if (item.role !== 'user' && item.role !== 'assistant') continue
    const next = { ...item }
    if (next.stage !== undefined) next.stage = settledStage(next.stage)
    out.push(next)
  }
  return out.slice(-CHAT_HISTORY.maxMessages)
}

function serializeWithinBudget(messages) {
  let list = messages
  while (list.length > 0) {
    const text = `${JSON.stringify({ version: CHAT_HISTORY.version, messages: list })}\n`
    if (Buffer.byteLength(text, 'utf8') <= CHAT_HISTORY.maxBytes) {
      return { messages: list, text }
    }
    list = list.slice(1)
  }
  return { messages: [], text: '' }
}

async function readChatUnlocked(ctx) {
  const path = chatHistoryPath(ctx)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return []
  if (info.size > CHAT_HISTORY.maxBytes) {
    await rm(path, { force: true }).catch(() => {})
    await removeStaleTemps(dirname(path), TEMP_PREFIX)
    return []
  }

  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!isPlainObject(parsed) || parsed.version !== CHAT_HISTORY.version || !Array.isArray(parsed.messages)) {
    await rm(path, { force: true }).catch(() => {})
    await removeStaleTemps(dirname(path), TEMP_PREFIX)
    return []
  }
  return normalizeStoredChatMessages(parsed.messages)
}

async function writeChatUnlocked(ctx, rawMessages) {
  const path = chatHistoryPath(ctx)
  const normalized = normalizeStoredChatMessages(rawMessages)
  const fitted = serializeWithinBudget(normalized)
  if (fitted.messages.length === 0) {
    await rm(path, { force: true }).catch(() => {})
    await removeStaleTemps(dirname(path), TEMP_PREFIX)
    return []
  }

  await writeFileAtomic(path, fitted.text, {
    ensureDir: true,
    dirMode: 0o700,
    fileMode: 0o600,
    cleanStale: true,
    tempPrefix: TEMP_PREFIX,
    encoding: 'utf8',
  })
  return fitted.messages
}

/** 读取当前工作区的对话历史（损坏或超限回落空数组，不抛异常）。 */
export function readChatHistory(ctx) {
  return readChatUnlocked(ctx)
}

/** 原子写入当前工作区的对话历史；空数组等价清空文件。 */
export function writeChatHistory(ctx, messages) {
  return serialize(() => writeChatUnlocked(ctx, messages))
}
