/**
 * 退场动效生命周期 Hook（有进有退）。
 *
 * 原则：
 *  - 真实浏览器且未开启 `prefers-reduced-motion: reduce` 时，关闭瞬间先进入 `exiting`
 *    态并等待退场动画播完再真正卸载 DOM；若期间重新打开则立即取消退场。
 *  - 测试渲染器（无 `window.matchMedia` / `requestAnimationFrame`）或减弱动态模式下，
 *    同步跟随 `open` 立即挂载/卸载，保证断言零延迟且不留定时器。
 */

import React from 'react'

export function canAnimatePresence() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function usePresence(open, exitDurationMs = 180) {
  const isOpen = Boolean(open)
  const [state, setState] = React.useState(() => ({
    mounted: isOpen,
    exiting: false,
  }))
  const prevOpenRef = React.useRef(isOpen)

  React.useEffect(() => {
    const animate = canAnimatePresence()
    if (isOpen) {
      prevOpenRef.current = true
      setState((prev) => (prev.mounted && !prev.exiting ? prev : { mounted: true, exiting: false }))
      return undefined
    }

    const wasOpen = prevOpenRef.current
    prevOpenRef.current = false

    if (!animate || !wasOpen) {
      setState((prev) => (!prev.mounted && !prev.exiting ? prev : { mounted: false, exiting: false }))
      return undefined
    }

    setState({ mounted: true, exiting: true })
    const timer = setTimeout(() => {
      setState({ mounted: false, exiting: false })
    }, Math.max(0, Number(exitDurationMs) || 0))
    return () => clearTimeout(timer)
  }, [isOpen, exitDurationMs])

  if (!canAnimatePresence()) {
    return { mounted: isOpen, exiting: false }
  }

  return {
    mounted: isOpen || state.mounted,
    exiting: !isOpen && state.exiting,
  }
}

/**
 * 退场期间保留最后一份非空数据（用于 Toast / 通知在滑出动画过程中继续显示原文案）。
 */
export function useRetainedValue(value, active) {
  const ref = React.useRef(value)
  if (value) ref.current = value
  else if (!active) ref.current = value
  return value || (active ? ref.current : value)
}
