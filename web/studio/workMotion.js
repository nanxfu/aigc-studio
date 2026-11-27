/** One short-lived handoff between views. Pixels never leave the current document. */
let handoff = null

export function motionAllowed() {
  return typeof document !== 'undefined'
    && !document.hidden
    && typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function imageRect(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return null
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

export function captureWorkMotion(path, element) {
  handoff = null
  if (!path || !motionAllowed()) return
  const rect = imageRect(element)
  if (rect) handoff = { path, rect, createdAt: performance.now() }
}

export function takeWorkMotion(path) {
  const current = handoff
  handoff = null
  return current && current.path === path && performance.now() - current.createdAt < 1800
    ? current.rect : null
}

/** FLIP on the actual image; callers keep a usable static result when WAAPI is absent. */
export function animateWorkArrival(element, from, duration = 240) {
  if (!from || !motionAllowed() || typeof element?.animate !== 'function') return null
  const to = imageRect(element)
  if (!to) return null
  const x = from.left + from.width / 2 - to.left - to.width / 2
  const y = from.top + from.height / 2 - to.top - to.height / 2
  return element.animate([
    { transform: `translate3d(${x}px, ${y}px, 0) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: .7, borderRadius: '8px' },
    { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1, borderRadius: '3px' },
  ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
}
