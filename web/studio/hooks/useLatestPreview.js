import React from 'react'

/** One render in flight, one latest request. Never queue a trail of obsolete GPU frames. */
export function useLatestPreview(render, dependencies, context) {
  const stateRef = React.useRef({ alive: false, running: false, queued: false, timer: null, render, context })
  const schedule = React.useCallback(() => {
    const state = stateRef.current
    if (!state.alive || state.running || state.timer !== null
      || (typeof document !== 'undefined' && document.hidden)) return
    state.timer = setTimeout(async () => {
      state.timer = null
      if (!state.alive) return
      state.running = true
      state.queued = false
      const currentContext = state.context
      try {
        await state.render(() => state.alive && state.context === currentContext)
      } catch {
        // Keep the last usable preview; the next input can recover without an unhandled rejection.
      } finally {
        state.running = false
        if (state.queued) schedule()
      }
    }, 0)
  }, [])
  React.useEffect(() => {
    const state = stateRef.current
    state.alive = true
    const resume = () => { if (!document.hidden && state.queued) schedule() }
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', resume)
    return () => {
      state.alive = false
      if (state.timer !== null) clearTimeout(state.timer)
      state.timer = null
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', resume)
    }
  }, [schedule])
  React.useEffect(() => {
    const state = stateRef.current
    state.render = render
    state.context = context
    state.queued = true
    schedule()
  }, dependencies)
}
