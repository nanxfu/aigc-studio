/**
 * 对话线程的按工作区持久化（M2.7，sessionStorage）。
 *
 * 与 `sessionSnapshot.js` 同一套降级策略：同标签页刷新 / 切侧栏后恢复最近对话；
 * 测试环境（Node 下无 sessionStorage）静默退化为无操作。
 *
 * 隔离口径：快照带 `workspace`（`/api/state.workspace.current` 的工作区绝对路径），
 * 只有键完全一致才恢复——切工作区不串记录。读取时再做一次轻量清洗：
 *  - 丢弃任务气泡（`kind='job'`）：它绑定服务端 jobId，恢复后可能永远停在「排队」；
 *  - 把中断的「生成中」气泡收敛为完成态，避免刷新后一直转圈；
 *  - 只保留最近 `MAX_MESSAGES` 条，避免长对话把配额撑爆。
 */

export const CHAT_SNAPSHOT_PREFIX = 'our-imagen.studio.chat.v1'

/** 单工作区最多持久化的消息条数（只影响恢复，不影响当前会话）。 */
const MAX_MESSAGES = 50

function storageOf() {
  try {
    if (typeof window !== 'undefined' && window && window.sessionStorage) return window.sessionStorage
  } catch {
    // 隐私模式或受限上下文拒绝访问 storage 时静默退化。
  }
  return null
}

function keyOf(workspace) {
  const value = typeof workspace === 'string' ? workspace.trim() : ''
  return value ? `${CHAT_SNAPSHOT_PREFIX}::${value}` : CHAT_SNAPSHOT_PREFIX
}

/** 中断态收敛：刷新后不应继续显示「生成中」。 */
function settledStage(stage) {
  return stage === 'running' || stage === 'pending' ? 'done' : stage
}

/**
 * 归一可持久化的消息列表：丢掉任务气泡与无效项，收敛中断态，保留最近 N 条。
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function chatMessagesForStore(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (message.kind === 'job') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    out.push({ ...message, stage: settledStage(message.stage) })
  }
  return out.slice(-MAX_MESSAGES)
}

/**
 * 读取某工作区的对话快照；键不匹配 / 无存储 / JSON 损坏时返回 null。
 *
 * @param {string} workspace 当前工作区标识
 * @returns {Array<object>|null}
 */
export function readChatSnapshot(workspace) {
  const storage = storageOf()
  if (!storage || typeof storage.getItem !== 'function') return null
  try {
    const raw = storage.getItem(keyOf(workspace))
    if (!raw || typeof raw !== 'string') return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) return null
    if (typeof parsed.workspace !== 'string' || parsed.workspace !== workspace) return null
    return chatMessagesForStore(parsed.messages)
  } catch {
    return null
  }
}

/**
 * 写入某工作区的对话快照；空线程也写入（用于覆盖旧记录，保证「新建对话」真的清空）。
 *
 * @param {{ workspace: string, messages: Array<object> }} snapshot
 * @returns {boolean}
 */
export function writeChatSnapshot(snapshot) {
  const storage = storageOf()
  const workspace = snapshot && typeof snapshot.workspace === 'string' ? snapshot.workspace.trim() : ''
  if (!storage || typeof storage.setItem !== 'function' || !workspace) return false
  const messages = chatMessagesForStore(snapshot.messages)
  // 空线程不落盘：删除键即代表「这个工作区没有可恢复的对话」，避免「新建对话」后
  // 清掉的键又被一次空写入建回来。
  if (messages.length === 0) {
    try {
      storage.removeItem(keyOf(workspace))
      return true
    } catch {
      return false
    }
  }
  try {
    storage.setItem(keyOf(workspace), JSON.stringify({ workspace, messages }))
    return true
  } catch {
    // 配额超限时退一步只存最近 12 条文本消息，保住「最近聊过什么」。
    try {
      storage.setItem(keyOf(workspace), JSON.stringify({
        workspace,
        messages: messages.slice(-12).map((message) => ({
          id: message.id,
          role: message.role,
          kind: message.kind,
          stage: message.stage,
          text: typeof message.text === 'string' ? message.text.slice(0, 500) : '',
          prompt: typeof message.prompt === 'string' ? message.prompt.slice(0, 500) : '',
          summary: typeof message.summary === 'string' ? message.summary.slice(0, 300) : '',
        })),
      }))
      return true
    } catch {
      return false
    }
  }
}

/** 清空某工作区的对话快照（「新建对话」时调用）。 */
export function clearChatSnapshot(workspace) {
  const storage = storageOf()
  if (!storage || typeof storage.removeItem !== 'function') return false
  try {
    storage.removeItem(keyOf(workspace))
    return true
  } catch {
    return false
  }
}
