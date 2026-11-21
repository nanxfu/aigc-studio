/**
 * 客户端版本更新提示的派生逻辑（纯函数，不依赖 React / DOM）。
 *
 * 数据来源是 `/api/state` 的 `update` 字段（`server/update-check.js` 的快照）：
 *  - 只在 `hasUpdate === true` 且版本号非空时返回提示对象，客户端据此显示顶栏红点与弹层提示；
 *  - 不做版本比较（比较在服务端完成），这里只做形状归一与链接安全校验。
 *
 * @typedef {{
 *   latest: string,
 *   current: string,
 *   releaseUrl: string,
 *   checkedAt: string | null,
 * }} UpdateNotice
 */

/** Release 链接只接受 https，避免快照被篡改后跳转到非预期地址。 */
function safeUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return ''
  return value
}

/**
 * 从宿主状态派生「有新版本」提示。
 *
 * @param {object | null | undefined} state `/api/state` 响应
 * @returns {UpdateNotice | null}
 */
export function updateOf(state) {
  const input = state && typeof state === 'object' ? state.update : null
  if (!input || typeof input !== 'object') return null
  if (input.hasUpdate !== true) return null
  const latest = typeof input.latest === 'string' ? input.latest.trim() : ''
  if (!latest) return null
  const current = typeof input.current === 'string' && input.current.trim()
    ? input.current.trim()
    : typeof state.version === 'string' ? state.version : ''
  const checkedAt = typeof input.checkedAt === 'string' && input.checkedAt.trim() ? input.checkedAt.trim() : null
  return {
    latest,
    current,
    releaseUrl: safeUrl(input.releaseUrl),
    checkedAt,
  }
}
