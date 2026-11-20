/**
 * 状态色映射。
 *
 * 颜色只引用工作台自己的设计变量（web/styles/tokens.css 的 `--ofs-*`），
 * 不再依赖 DSH 宿主的 `--dsw-*` 变量；纯逻辑层不碰 DOM，返回 CSS var() 字符串即可。
 */

/** 语义状态 → 工作台设计变量。 */
export const STATUS_COLORS = Object.freeze({
  ok: 'var(--ofs-ok)',
  warn: 'var(--ofs-warn)',
  error: 'var(--ofs-error)',
  idle: 'var(--ofs-idle)',
  brand: 'var(--ofs-accent)',
})

/** 云端状态的语义色调 → 状态色（与 computeStatusOf().tone 对应）。 */
export function toneColor(tone) {
  if (tone === 'ok') return STATUS_COLORS.ok
  if (tone === 'warn') return STATUS_COLORS.warn
  if (tone === 'error') return STATUS_COLORS.error
  return STATUS_COLORS.idle
}

export function jobColor(status) {
  if (status === 'done') return STATUS_COLORS.ok
  if (status === 'failed') return STATUS_COLORS.error
  if (status === 'running') return STATUS_COLORS.brand
  if (status === 'queued' || status === 'waiting-session') return STATUS_COLORS.warn
  return STATUS_COLORS.idle
}
