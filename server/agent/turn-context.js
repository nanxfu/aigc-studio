/**
 * 单轮对话上下文（AsyncLocalStorage）。
 *
 * Agent 工具注册在全局注册表里，但「当前舞台选中哪张图」「本轮是哪个 Provider」
 * 这类信息是**每轮请求**的。用 AsyncLocalStorage 把请求级上下文挂在当前异步链上：
 *  - `runWithTurnContext(ctx, fn)` 在 Agent 运行时里包住 `prompt()/continue()`；
 *  - 工具执行（含并行调度）在同一个异步链里，`currentTurnContext()` 能读到最新值。
 *
 * 不引入全局可变单例：同一进程里多个 SSE 请求并发时互不干扰。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage()

/**
 * @template T
 * @param {object} context
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTurnContext(context, fn) {
  return storage.run(context && typeof context === 'object' ? context : {}, fn)
}

/** 当前轮次的上下文快照（没有上下文时返回空对象，调用方按缺省处理）。 */
export function currentTurnContext() {
  return storage.getStore() ?? {}
}

/** 就地补充当前轮次上下文（例如工具执行后记录 jobId）。无上下文时静默忽略。 */
export function patchTurnContext(patch) {
  const store = storage.getStore()
  if (!store || !patch || typeof patch !== 'object') return
  Object.assign(store, patch)
}
