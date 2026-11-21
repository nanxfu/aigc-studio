/**
 * 更新状态订阅 / 动作 hook。
 *
 * 优先级（规格 §3.2）：
 *  1. 桌面端主进程桥接 `window.aigcStudio.updater`：完整检查 / 下载 / 安装；
 *  2. 没有桥接（浏览器直连 / 主进程未初始化）时回退轮询 `/api/state.update`，
 *     只能查看与打开下载页，不能下载安装。
 *
 * 两套状态不得同时驱动 UI：一旦桥接存在，就完全忽略轮询。
 */

import React from 'react'

import { checkUpdate, fetchState } from '../../api/resources.js'
import { desktop } from '../../runtime.js'
import {
  normalizeUpdateState,
  updateActionsOf,
  updateStateOf,
} from '../../logic/update.js'

/** 只读回退的轮询周期（与主进程 5 秒 /api/state 轮询错开，避免同时打服务）。 */
const FALLBACK_POLL_MS = 60_000

export function useUpdate(options = {}) {
  const bridge = desktop()?.updater ?? null
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : FALLBACK_POLL_MS
  const [state, setState] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  /** 最近一次「立即安装」被护栏拦下的原因（session_active / queue_active / ...）。 */
  const [gate, setGate] = React.useState(null)
  const mountedRef = React.useRef(true)

  React.useEffect(() => {
    mountedRef.current = true
    const apply = (next) => {
      if (!mountedRef.current) return
      setState(normalizeUpdateState(next))
    }

    if (bridge && typeof bridge.getState === 'function') {
      Promise.resolve(bridge.getState()).then(apply).catch(() => {})
      const off = typeof bridge.onStateChange === 'function' ? bridge.onStateChange(apply) : null
      // 只读形态（便携 / 解压 / 开发）没有主进程事件推送，靠低频拉取发现后台检查结果；
      // NSIS 形态下这只是读本地状态，没有网络开销。
      const timer = setInterval(() => {
        Promise.resolve(bridge.getState()).then(apply).catch(() => {})
      }, pollMs)
      return () => {
        mountedRef.current = false
        clearInterval(timer)
        if (typeof off === 'function') off()
      }
    }

    let timer = null
    const load = async () => {
      const result = await fetchState()
      if (!mountedRef.current || !result?.ok) return
      const next = updateStateOf(result.data?.update)
      if (next) setState(next)
    }
    void load()
    timer = setInterval(load, pollMs)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [bridge, pollMs])

  /** 统一吞掉桥接调用异常：错误以状态 / 返回值表达，不打断界面。 */
  const invoke = React.useCallback(async (action) => {
    if (typeof action !== 'function') return null
    try {
      return await action()
    } catch {
      return null
    }
  }, [])

  const check = React.useCallback(async () => {
    if (busy) return null
    setBusy(true)
    setGate(null)
    try {
      if (bridge && typeof bridge.check === 'function') {
        const next = await invoke(() => bridge.check())
        if (next) setState(normalizeUpdateState(next))
        return next
      }
      const result = await checkUpdate()
      if (result?.ok) {
        const next = updateStateOf(result.data?.update)
        if (next) setState(next)
        return next
      }
      return null
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [bridge, busy, invoke])

  const download = React.useCallback(async () => {
    if (busy || !bridge || typeof bridge.download !== 'function') return null
    setBusy(true)
    try {
      const next = await invoke(() => bridge.download())
      if (next) setState(normalizeUpdateState(next))
      return next
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [bridge, busy, invoke])

  const install = React.useCallback(async () => {
    if (busy || !bridge || typeof bridge.install !== 'function') {
      return { ok: false, reason: 'unsupported_form' }
    }
    setBusy(true)
    setGate(null)
    try {
      const result = await invoke(() => bridge.install())
      const gateResult = result && typeof result === 'object' ? result : { ok: false, reason: 'unknown' }
      if (!gateResult.ok && mountedRef.current) setGate(gateResult.reason ?? 'unknown')
      return gateResult
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [bridge, busy, invoke])

  const setInstallOnQuit = React.useCallback(async (value) => {
    if (!bridge || typeof bridge.setInstallOnQuit !== 'function') return null
    const next = await invoke(() => bridge.setInstallOnQuit(value === true))
    if (next) {
      setState(normalizeUpdateState(next))
      // 选了「退出时安装」就不再强调刚才的拦截原因。
      if (value === true) setGate(null)
    }
    return next
  }, [bridge, invoke])

  const openRelease = React.useCallback(async (url) => {
    const target = typeof url === 'string' && url.startsWith('https://') ? url : ''
    if (!target) return false
    if (bridge && typeof bridge.openRelease === 'function') {
      return (await invoke(() => bridge.openRelease(target))) === true
    }
    try {
      window.open(target, '_blank', 'noreferrer')
      return true
    } catch {
      return false
    }
  }, [bridge, invoke])

  const actions = React.useMemo(() => updateActionsOf(state, { busy }), [state, busy])

  return {
    state,
    /** 'bridge'：主进程可自动更新；'readonly'：只读（便携 / 解压 / 开发 / 浏览器）。 */
    mode: bridge ? 'bridge' : 'readonly',
    busy,
    gate,
    actions,
    check,
    download,
    install,
    setInstallOnQuit,
    openRelease,
  }
}
