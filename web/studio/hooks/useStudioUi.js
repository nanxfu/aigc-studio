/**
 * 工作台界面态域：视图 / 缩放 / 面板形态 / 折叠态 / Toast / 错误 / 剪贴板 /
 * 日志抽屉开关，以及页面隐藏期间的完成提醒。
 *
 * 只持有界面状态，不碰业务数据；error 只存 { code, message }，如何展示由组合层决定。
 */

import React from 'react'

import { TIMEOUTS, UI_STATE } from '../../../shared/contract.js'

import { fetchState, fetchUiState, saveUiState } from '../../api/resources.js'
import { KAGGLE_INSTALL_COMMAND } from '../../logic/guidance.js'
import { activeJobOf } from '../../logic/jobs.js'
import { completionNotice, isCompletion, stripNoticePrefix } from '../../logic/notice.js'
import { buildUiStatePatch, uiStateViewOf } from '../../logic/uiState.js'

/** 单调递增的 Toast 编号，避免同一毫秒连续提示发生 id 碰撞。 */
let nextToastId = 0
/** 单调递增的本地错误编号，保证每次 ui.fail 都生成独立键，不被旧关闭记录屏蔽。 */
let nextErrorId = 0

/** 已关闭指引键的会话级缓存键与保留上限（跨 HMR / 重载保留「已关闭」状态）。 */
export const DISMISSED_GUIDANCE_STORAGE_KEY = 'our-imagen.studio.dismissed.v1'
const MAX_DISMISSED_GUIDANCE_KEYS = 32

function dismissedStorageOf() {
  try {
    if (typeof window !== 'undefined' && window && window.sessionStorage) return window.sessionStorage
  } catch {
    // 隐私模式或受限上下文静默退化为仅内存记录。
  }
  return null
}

function readDismissedGuidanceKeys() {
  const storage = dismissedStorageOf()
  if (!storage || typeof storage.getItem !== 'function') return []
  try {
    const raw = storage.getItem(DISMISSED_GUIDANCE_STORAGE_KEY)
    if (!raw || typeof raw !== 'string') return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => typeof item === 'string' && item && !item.startsWith('local:'))
      .slice(-MAX_DISMISSED_GUIDANCE_KEYS)
  } catch {
    return []
  }
}

function writeDismissedGuidanceKeys(keys) {
  const storage = dismissedStorageOf()
  if (!storage || typeof storage.setItem !== 'function') return
  const persisted = Array.isArray(keys)
    ? keys.filter((item) => typeof item === 'string' && item && !item.startsWith('local:')).slice(-MAX_DISMISSED_GUIDANCE_KEYS)
    : []
  try {
    if (persisted.length === 0 && typeof storage.removeItem === 'function') {
      storage.removeItem(DISMISSED_GUIDANCE_STORAGE_KEY)
    } else {
      storage.setItem(DISMISSED_GUIDANCE_STORAGE_KEY, JSON.stringify(persisted))
    }
  } catch {
    // 存储配额或写保护失败不影响本地状态更新。
  }
}

export function useStudioUi({ t, initialView, initialPanelMode, initialCompareOpen = false, initialQueueOpen = false }) {
  // 初始视图与面板形态可由 props 指定（预览与测试用），由组合层算好后传入。
  const [view, setView] = React.useState(initialView)
  // 折叠态先按契约默认值收起；挂载后读一次宿主保存的界面态再覆盖。
  const [advancedOpen, setAdvancedOpen] = React.useState(UI_STATE.defaults.advancedOpen)
  const [negativeOpen, setNegativeOpen] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [dismissedKeys, setDismissedKeys] = React.useState(() => readDismissedGuidanceKeys())
  const dismissed = dismissedKeys[dismissedKeys.length - 1] || ''
  const [toast, setToast] = React.useState(null)
  const [panelMode, setPanelMode] = React.useState(initialPanelMode)
  const [zoom, setZoom] = React.useState(false)
  // 队列弹层是顶栏与队列生命周期共同依赖的界面态：打开时延后「自动视为已查看」的静默移出，
  // 避免任务刚完成就从正在查看的面板里闪没。
  const [queueOpen, setQueueOpen] = React.useState(Boolean(initialQueueOpen))
  // 派生作品的「对比原图」拉帘开关（阶段十五 Phase A）：由舞台按钮与助手结果卡胶囊共同控制。
  const [compareOpen, setCompareOpen] = React.useState(Boolean(initialCompareOpen))
  // 站内作品拖拽态（底部作品条 / 版本面板起拖时写入，用于全局可放置区域两层高亮）。
  const [draggingWork, setDraggingWork] = React.useState(null)
  const [logsOpen, setLogsOpen] = React.useState(false)
  // 打开日志抽屉前的焦点位置：关闭后还回去（通常是顶栏算力按钮）。
  const logsReturnRef = React.useRef(null)
  // 运行设置抽屉与日志抽屉同一套焦点归还约定，两者独立开关。
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  // 打开设置时定位到哪一页；受限模型 / 缺 Token 等指引可直接落到「云端算力」。
  const [settingsTab, setSettingsTab] = React.useState('assistant')
  const [settingsTarget, setSettingsTarget] = React.useState(null)
  const settingsReturnRef = React.useRef(null)
  // 提示词双栏对比弹窗：挂载在 Studio 根部（脱离左栏 backdrop-filter/overflow 限制）。
  const [promptCompareOpen, setPromptCompareOpen] = React.useState(false)
  const promptCompareReturnRef = React.useRef(null)
  const advancedOpenRef = React.useRef(advancedOpen)
  advancedOpenRef.current = advancedOpen

  function showToast(text) {
    nextToastId += 1
    setToast({ text, id: nextToastId })
  }

  // 界面态只是体验优化：挂载时读一次，失败静默回落默认值（收起），不弹错误提示。
  React.useEffect(() => {
    let alive = true
    Promise.resolve(fetchUiState()).then((result) => {
      if (!alive) return
      const saved = uiStateViewOf(result)
      if (saved) {
        advancedOpenRef.current = saved.advancedOpen
        setAdvancedOpen(saved.advancedOpen)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 展开 / 收起「高级设置」：先更新本地状态，再 fire-and-forget 保存。
   * 保存失败不回滚、不提示——界面态丢失不影响出图。
   */
  function toggleAdvancedOpen() {
    setAdvancedOpen((prev) => !prev)
    const next = !advancedOpenRef.current
    advancedOpenRef.current = next
    Promise.resolve(saveUiState(buildUiStatePatch({ advancedOpen: next }))).catch(() => {})
  }

  // 新的本地错误出现时，附带递增序号，确保不会被之前收起的旧错误键屏蔽。
  function fail(code, message) {
    nextErrorId += 1
    setError({ code, message: message ?? '', id: nextErrorId })
  }

  function isGuidanceDismissed(guidanceKey) {
    return Boolean(guidanceKey && dismissedKeys.includes(guidanceKey))
  }

  /** 收起指引卡：记录唯一键（非 local 键同步写入 sessionStorage），避免热更新或轮询反复弹出。 */
  function dismissGuidance(guidanceKey) {
    if (guidanceKey) {
      setDismissedKeys((prev) => {
        if (prev.includes(guidanceKey)) return prev
        const next = [...prev, guidanceKey].slice(-MAX_DISMISSED_GUIDANCE_KEYS)
        writeDismissedGuidanceKeys(next)
        return next
      })
    }
    setError(null)
  }

  // Toast 定时消失；卸载时清理定时器，回调不会在卸载后执行。
  React.useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  // 拖拽兜底清理：若源缩略图在拖拽途中卸载、释放到窗口外或按 Esc 取消，确保高亮态复位。
  React.useEffect(() => {
    if (!draggingWork) return undefined
    const clear = () => setDraggingWork(null)
    const doc = typeof document === 'undefined' ? null : document
    const win = typeof window === 'undefined' ? null : window
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('dragend', clear)
      doc.addEventListener('drop', clear)
    }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('blur', clear)
    }
    return () => {
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('dragend', clear)
        doc.removeEventListener('drop', clear)
      }
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('blur', clear)
      }
    }
  }, [Boolean(draggingWork)])

  async function copyText(text, okKey) {
    const value = String(text ?? '').trim()
    if (!value) return
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value)
        showToast(t(okKey))
        return
      }
    } catch {
      // 非安全上下文或不给权限：退化为提示用户手动复制
    }
    showToast(value)
  }

  function copyPath(value) {
    return copyText(value, 'studio.toast.copied')
  }

  function copyInstallCommand() {
    return copyText(KAGGLE_INSTALL_COMMAND, 'studio.guidance.cli.copied')
  }

  /** 打开日志抽屉：记下触发按钮，关闭后把焦点还回去。 */
  function openLogs(trigger) {
    logsReturnRef.current = trigger || (document.activeElement || null)
    setLogsOpen(true)
  }

  function closeLogs() {
    setLogsOpen(false)
    const target = logsReturnRef.current
    logsReturnRef.current = null
    // 触发按钮可能已经随弹层卸载（isConnected 为 false），此时不强行聚焦。
    if (target && typeof target.focus === 'function' && target.isConnected !== false) target.focus()
  }

  /** 打开运行设置抽屉：记下触发元素，关闭后把焦点还回去。tab 可选，默认「创作助手」。 */
  function openSettings(trigger, tab, target = null) {
    settingsReturnRef.current = trigger || (document.activeElement || null)
    setSettingsTab(tab === 'compute' || tab === 'appearance' ? tab : 'assistant')
    setSettingsTarget(target && typeof target === 'object' ? target : null)
    setSettingsOpen(true)
  }

  function closeSettings() {
    setSettingsOpen(false)
    setSettingsTarget(null)
    const target = settingsReturnRef.current
    settingsReturnRef.current = null
    if (target && typeof target.focus === 'function' && target.isConnected !== false) target.focus()
  }

  /** 打开提示词双栏对比编辑弹窗。 */
  function openPromptCompare(trigger) {
    promptCompareReturnRef.current = trigger || (typeof document !== 'undefined' ? document.activeElement : null)
    setPromptCompareOpen(true)
  }

  function closePromptCompare() {
    setPromptCompareOpen(false)
    const target = promptCompareReturnRef.current
    promptCompareReturnRef.current = null
    if (target && typeof target.focus === 'function' && target.isConnected !== false) target.focus()
  }

  return {
    view,
    setView,
    zoom,
    setZoom,
    compareOpen,
    setCompareOpen,
    draggingWork,
    setDraggingWork,
    panelMode,
    setPanelMode,
    queueOpen,
    setQueueOpen,
    advancedOpen,
    // setAdvancedOpen 只给预览 / 测试直接注入折叠态；业务路径请用 toggleAdvancedOpen（会持久化）。
    setAdvancedOpen,
    toggleAdvancedOpen,
    negativeOpen,
    setNegativeOpen,
    toast,
    error,
    setError,
    dismissed,
    isGuidanceDismissed,
    showToast,
    fail,
    dismissGuidance,
    copyText,
    copyPath,
    copyInstallCommand,
    logsOpen,
    openLogs,
    closeLogs,
    settingsOpen,
    settingsTab,
    settingsTarget,
    openSettings,
    closeSettings,
    promptCompareOpen,
    openPromptCompare,
    closePromptCompare,
  }
}

/**
 * 完成提醒：页面隐藏期间任务完成 → 标签页标题加「● 生成完成 · 」前缀；
 * 回到页面时恢复原标题并 toast 一次。首次挂载只记录基线，不提示。
 *
 * 宿主状态轮询在页面隐藏时会暂停，所以这里在「有进行中任务且页面隐藏」时
 * 用同样的活跃轮询间隔补一条轻量 /state 请求，才能及时改标题。
 */
export function useCompletionNotice({ t, ui, job, activeJob }) {
  // undefined = 还没挂载过；null = 已知的「无任务」快照。
  const previousRef = React.useRef(undefined)
  const pendingRef = React.useRef(false)
  const hiddenJobRef = React.useRef(null)
  const returningRef = React.useRef(null)
  const tRef = React.useRef(t)
  const uiRef = React.useRef(ui)
  tRef.current = t
  uiRef.current = ui

  const judge = React.useCallback((nextJob) => {
    const previous = previousRef.current
    previousRef.current = nextJob || null
    if (previous === undefined) return
    const decision = completionNotice({
      previous,
      next: nextJob,
      hidden: Boolean(document.hidden),
      title: document.title,
    })
    if (decision.notify) {
      pendingRef.current = true
      document.title = decision.title
      return
    }
    if (!decision.completed) return
    // 隐藏期间完成、但没赶上标题前缀（例如隐藏轮询失败）：回到页面后补一次 toast。
    if (returningRef.current && isCompletion(returningRef.current, nextJob)) {
      returningRef.current = null
      uiRef.current.showToast(tRef.current('studio.toast.generationDone'))
    }
  }, [])

  // 常规轮询带来的任务快照变化。
  React.useEffect(() => {
    judge(job)
  }, [judge, job && job.id, job && job.status, job && (job.finishedAt ?? '')])

  // 可见性切换：隐藏时补轮询，返回时恢复标题并提示。
  React.useEffect(() => {
    let timer = null
    let alive = true

    function stop() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    async function tick() {
      timer = null
      const result = await fetchState()
      if (!alive) return
      const state = result && result.ok && result.data && typeof result.data === 'object' ? result.data : null
      if (state) judge(state.lastJob || null)
      // 队列彻底空下来就停止补轮询；还有排队/生成任务时继续，直到用户回到页面。
      const busy = Boolean(activeJob) || Boolean(state && activeJobOf(state))
      if (alive && document.hidden && busy) timer = setTimeout(tick, TIMEOUTS.clientStateActivePollMs)
    }

    function rememberHidden() {
      hiddenJobRef.current = previousRef.current ?? null
    }

    function onVisibility() {
      if (document.hidden) {
        rememberHidden()
        if (activeJob && timer === null) tick()
        return
      }
      stop()
      const hiddenJob = hiddenJobRef.current
      hiddenJobRef.current = null
      if (pendingRef.current) {
        pendingRef.current = false
        returningRef.current = null
        document.title = stripNoticePrefix(document.title)
        uiRef.current.showToast(tRef.current('studio.toast.generationDone'))
        return
      }
      if (hiddenJob) returningRef.current = hiddenJob
    }

    document.addEventListener('visibilitychange', onVisibility)
    // 挂载时页面已在后台（例如从后台标签打开）也按隐藏处理，开始补轮询。
    if (document.hidden && activeJob) {
      rememberHidden()
      tick()
    }
    return () => {
      alive = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [activeJob && activeJob.id, judge])
}
