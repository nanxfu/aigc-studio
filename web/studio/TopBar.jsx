/** 工作台顶栏：品牌、视图切换、云端状态与配额、模型预设。 */

import React from 'react'

import { PROVIDER_IDS } from '../../shared/contract.js'

import { useSlidingThumb } from './hooks/useSlidingThumb.js'
import { usePresence } from './hooks/usePresence.js'
import { fetchWorkspace, switchWorkspace } from '../api/resources.js'
import { formatText } from '../logic/format.js'
import { computeStatusOf, deviceShortOf, idleShutdownOf, providerLabelOf } from '../logic/status.js'
import { presetProviderRestrictionOf } from '../logic/preset.js'
import { normalizeWorkspaceView, workspaceLabelOf, workspaceViewOf } from '../logic/workspace.js'
import { desktop } from '../runtime.js'
import { ComputePopover } from './ComputePopover.jsx'
import { Icon } from './icons.jsx'
import { ModelCardPicker } from './ModelCardPicker.jsx'
import { QueuePopover } from './QueuePopover.jsx'
import { ProviderIcon } from './settings/providerIcons.jsx'
import { StudioIcon } from './StudioIcon.jsx'
import { UpdateEntry } from './UpdateEntry.jsx'
import { WindowControls } from './WindowControls.jsx'

/** 接收 { t, ui, compute, form, library }；ui/compute/form/library 是领域对象。 */
export function TopBar(props) {
  const { t, isEn, ui, compute, library, actions } = props
  const { form: fields, patchForm, selectPreset } = props.form
  const { view, setView, openLogs, openSettings } = ui
  const { session, sessionState, presets } = compute
  const list = Array.isArray(presets) ? presets : []
  const hasVideoPresets = list.some((item) => item && item.mediaType === 'video')
  const creationMode = props.form?.creationMode || (fields.mediaType === 'video' ? 'video' : 'image')

  // 顶栏跟随当前选择的算力来源（compute.provider），确保在下拉里切换后端后立刻反映到胶囊与弹层；
  // 若旧会话仍在另一家后端运行，通过 pendingSwitchFrom 在弹层内提示「下次生成或启动时自动切换」。
  const configuredProviderId = (compute && compute.provider) || ''
  const liveSessionProvider = session && session.state && session.state !== 'absent' && session.provider
    ? session.provider
    : ''
  const sessionProviderId = configuredProviderId || liveSessionProvider || (session && session.provider) || ''
  const pendingSwitchFrom = liveSessionProvider && sessionProviderId && liveSessionProvider !== sessionProviderId
    ? liveSessionProvider
    : ''
  const isCloudApi = sessionProviderId === 'cloud-api'
  const hasCloudKey = Boolean(
    compute?.imageApi?.hasApiKey
    || (Array.isArray(compute?.imageApi?.apiKeysConfigured) && compute.imageApi.apiKeysConfigured.length > 0),
  )
  const effectiveSession = isCloudApi
    ? (session?.provider === 'cloud-api' ? session : { state: hasCloudKey ? 'ready' : 'absent', provider: 'cloud-api' })
    : (!session || !session.provider || session.provider === sessionProviderId ? session : null)
  const rawStatus = compute.status || computeStatusOf(t, { session: effectiveSession, provider: sessionProviderId, queuePolicy: compute.queuePolicy })
  const status = (isCloudApi && session?.provider !== 'cloud-api') || pendingSwitchFrom
    ? computeStatusOf(t, { session: effectiveSession, provider: sessionProviderId, queuePolicy: compute.queuePolicy })
    : rawStatus
  const sessionProvider = providerLabelOf(t, sessionProviderId)
  const computeSourceLabel = sessionProvider || providerLabelOf(t, 'kaggle')
  // 胶囊只显示来源，但宽度要覆盖全部已知来源：隐藏候选留在同一网格单元里参与
  // intrinsic sizing，切换来源时不会牵动右侧模型卡与队列入口。
  const computeSourceLabels = React.useMemo(
    () => [...new Set(PROVIDER_IDS.map((id) => providerLabelOf(t, id)).filter(Boolean))],
    [t],
  )
  const isWorker = sessionProviderId === 'private-worker' || sessionProviderId === 'local-gpu'
  // 私有 Worker 没有配额：胶囊里补上真实 GPU 型号，让「连上的到底是哪台机器」一眼可见。
  const workerDevice = isWorker && status.ready && effectiveSession && effectiveSession.device
    ? `（${deviceShortOf(effectiveSession.device)}）`
    : ''
  const computeStatusLabel = sessionProvider
    ? `${sessionProvider} · ${status.label}${workerDevice}`
    : `${status.label}${workerDevice}`
  // 空闲倒计时只认宿主快照里的真实读数：胶囊上的休眠预警与弹层共用同一份派生。
  const idleShutdown = idleShutdownOf(session)
  const idleRatio = idleShutdown && idleShutdown.totalMinutes > 0
    ? Math.min(1, Math.max(0, idleShutdown.idleMinutes / idleShutdown.totalMinutes))
    : null
  const idleTone = idleRatio !== null ? (idleRatio >= 0.9 ? 'error' : idleRatio >= 0.7 ? 'warn' : 'normal') : 'normal'
  const idleApproaching = Boolean(status.ready && idleRatio !== null && idleRatio >= 0.7)
  const hasProviderBadge = sessionProviderId === 'kaggle' || sessionProviderId === 'colab' || isWorker || isCloudApi

  // defaultOpen 只给预览 / 渲染测试用，正式界面从关闭态开始。
  const [open, setOpen] = React.useState(Boolean(props.defaultOpen))
  // 模型卡、算力弹层与任务队列互斥：三者同时只允许一个展开。
  const [modelOpen, setModelOpen] = React.useState(Boolean(props.defaultModelOpen))
  // 正式界面把队列开关提升到界面域，供「舞台已自动展示完成结果」时判断是否可静默移出；
  // 单独挂载 TopBar 的测试 / 预览没有界面域开关时，退回组件内本地状态。
  const controlledQueue = ui && typeof ui.queueOpen === 'boolean' && typeof ui.setQueueOpen === 'function'
  const [localQueueOpen, setLocalQueueOpen] = React.useState(Boolean(props.defaultQueueOpen))
  const queueOpen = controlledQueue ? ui.queueOpen : localQueueOpen
  const setQueueOpen = controlledQueue ? ui.setQueueOpen : setLocalQueueOpen
  const wrapRef = React.useRef(null)
  const pillRef = React.useRef(null)
  const queueWrapRef = React.useRef(null)
  const queueBtnRef = React.useRef(null)
  const tabsRef = React.useRef(null)
  const creationMenuRef = React.useRef(null)
  const creationTriggerRef = React.useRef(null)
  const [creationMenuOpen, setCreationMenuOpen] = React.useState(false)
  const creationMenuPresence = usePresence(creationMenuOpen, 150)
  const pendingJobs = Array.isArray(compute.pendingJobs) ? compute.pendingJobs : []
  const retainedJobs = Array.isArray(compute.retainedJobs) ? compute.retainedJobs : []
  const queueJobs = Array.isArray(compute.queueJobs) ? compute.queueJobs : pendingJobs
  const justQueued = Boolean(actions && actions.justQueuedAt)
  const queueFlying = Boolean(actions && actions.queueFly)
  const showQueue = queueJobs.length > 0
    || Boolean(status.transient)
    || Boolean(compute.queueNotice)
    || justQueued
    || queueFlying
    || queueOpen
  const queueBadgeCount = pendingJobs.length > 0 ? pendingJobs.length : retainedJobs.length
  const retainedHasFailure = retainedJobs.some((job) => job && job.status === 'failed')
  // 三段式导航（M4.2a）：创作（含下拉类型菜单）/ 工坊 / 作品库。菜单展开时高亮仍落在「创作」上。
  const creationActive = creationMenuOpen || view === 'studio'
  useSlidingThumb(
    tabsRef,
    creationMenuOpen ? 'studio' : (view === 'workshop' ? 'workshop' : view === 'gallery' ? 'gallery' : 'studio'),
  )

  // 菜单：Esc 与点击外部都关闭。
  React.useEffect(() => {
    if (!open && !queueOpen && !creationMenuOpen) return undefined
    function onKey(event) {
      if (event.key === 'Escape') {
        if (creationMenuOpen) {
          setCreationMenuOpen(false)
          creationTriggerRef.current?.focus()
        }
        if (open) {
          setOpen(false)
          pillRef.current?.focus({ preventScroll: true })
        }
        if (queueOpen) {
          setQueueOpen(false)
          queueBtnRef.current?.focus({ preventScroll: true })
        }
      }
    }
    function onDown(event) {
      const target = event.target
      const insideCreationMenu = creationMenuRef.current && creationMenuRef.current.contains(target)
      const insideCreationTrigger = creationTriggerRef.current && creationTriggerRef.current.contains(target)
      if (creationMenuOpen && !insideCreationMenu && !insideCreationTrigger) setCreationMenuOpen(false)
      const node = wrapRef.current
      if (open && node && !node.contains(target)) setOpen(false)
      const queueNode = queueWrapRef.current
      if (queueOpen && queueNode && !queueNode.contains(target)) setQueueOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, queueOpen, creationMenuOpen])

  React.useEffect(() => {
    if (!creationMenuOpen) return
    const menu = creationMenuRef.current
    if (!menu) return
    const active = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button:not(:disabled)')
    if (active) active.focus()
  }, [creationMenuOpen])

  function selectCreationMode(mode) {
    setCreationMenuOpen(false)
    creationTriggerRef.current?.focus()
    setView('studio')
    if (actions && typeof actions.switchCreationMode === 'function') actions.switchCreationMode(mode)
  }

  function handleCreationMenuKeyDown(event) {
    const items = Array.from(creationMenuRef.current?.querySelectorAll('[role="menuitemradio"]') || [])
      .filter((item) => !item.disabled)
    if (!items.length) return
    const current = items.indexOf(document.activeElement)
    let next = -1
    if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next < 0) return
    event.preventDefault()
    items[next].focus()
  }

  // ── 当前工作区（独立客户端 Phase 1 新增）────────────────────────────
  // 首选 /state 下发的 workspace:{current,recent,switchable}；字段未就绪（旧服务端 /
  // 启动早期）时用 GET /api/workspace 兜底一次，等 /state 带上该字段后就不再重复请求。
  const hostWorkspace = compute && compute.workspace && typeof compute.workspace === 'object' ? compute.workspace : null
  const hostWorkspaceView = hostWorkspace ? normalizeWorkspaceView(hostWorkspace) : null
  const hostWorkspaceCurrent = hostWorkspaceView ? hostWorkspaceView.current : ''
  const [fallbackWorkspace, setFallbackWorkspace] = React.useState(null)
  const [workspaceOverride, setWorkspaceOverride] = React.useState(null)
  const [workspaceOpen, setWorkspaceOpen] = React.useState(Boolean(props.defaultWorkspaceOpen))
  const [workspaceBusy, setWorkspaceBusy] = React.useState(false)
  const [workspaceError, setWorkspaceError] = React.useState('')
  const workspaceWrapRef = React.useRef(null)
  const workspacePopoverPresence = usePresence(workspaceOpen, 150)
  // 切换成功后先展示本次返回的视图（override），等 /state 快照追上新的 current 再清掉。
  const workspace = workspaceOverride || hostWorkspaceView || fallbackWorkspace
  const workspaceCurrent = workspace ? workspace.current : ''
  const workspaceLabel = workspaceCurrent ? workspaceLabelOf(workspaceCurrent) : t('topbar.workspace.none')
  const workspaceLabelCandidates = React.useMemo(
    () => [...new Set([
      workspaceLabel,
      ...(workspace && Array.isArray(workspace.recent) ? workspace.recent.map(workspaceLabelOf) : []),
    ].filter(Boolean))],
    [workspaceLabel, workspace],
  )
  // 后端报告有活跃任务时不允许切换（switchable:false），入口保持可见但置灰。
  const workspaceSwitchable = !workspace || workspace.switchable !== false

  React.useEffect(() => {
    if (workspaceOverride && hostWorkspaceCurrent && hostWorkspaceCurrent === workspaceOverride.current) {
      setWorkspaceOverride(null)
    }
  }, [hostWorkspaceCurrent, workspaceOverride])

  React.useEffect(() => {
    if (hostWorkspaceView) {
      setFallbackWorkspace(null)
      return undefined
    }
    let alive = true
    fetchWorkspace().then((result) => {
      if (!alive) return
      const view = workspaceViewOf(result)
      if (view) setFallbackWorkspace(view)
    })
    return () => {
      alive = false
    }
  }, [hostWorkspaceCurrent])

  // 工作区菜单：Esc 与点击外部都关闭。
  React.useEffect(() => {
    if (!workspaceOpen) return undefined
    function onKey(event) {
      if (event.key === 'Escape') setWorkspaceOpen(false)
    }
    function onDown(event) {
      const node = workspaceWrapRef.current
      if (node && !node.contains(event.target)) setWorkspaceOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [workspaceOpen])

  /** 切换工作区成功后刷新宿主快照：/state 里的 workspace 与作品列表都会随之更新。 */
  function refreshHostState() {
    if (compute && typeof compute.refreshState === 'function') compute.refreshState()
    else if (compute && typeof compute.refresh === 'function') compute.refresh()
  }

  /** POST /api/workspace { path }；失败只在菜单里展示原因，不打断工作台。 */
  async function applyWorkspace(nextPath) {
    const target = typeof nextPath === 'string' ? nextPath.trim() : ''
    if (!target || workspaceBusy) return
    setWorkspaceBusy(true)
    setWorkspaceError('')
    const result = await switchWorkspace(target)
    setWorkspaceBusy(false)
    const view2 = workspaceViewOf(result)
    if (!view2) {
      setWorkspaceError(t('topbar.workspace.switchFailed'))
      return
    }
    setWorkspaceOverride(view2)
    setFallbackWorkspace(null)
    setWorkspaceOpen(false)
    // 拉一次 /state：workspace 与作品列表都要按新工作区刷新。
    refreshHostState()
  }

  /**
   * 选择新工作区：Electron 走原生目录选择（desktop().pickDirectory()），
   * 浏览器开发态退回 window.prompt 输入绝对路径。
   */
  async function chooseWorkspace() {
    if (workspaceBusy || !workspaceSwitchable) return
    const bridge = desktop()
    let picked = ''
    try {
      if (bridge && typeof bridge.pickDirectory === 'function') {
        picked = (await bridge.pickDirectory()) || ''
      } else if (typeof window.prompt === 'function') {
        picked = window.prompt(t('topbar.workspace.prompt'), workspaceCurrent || '') || ''
      }
    } catch {
      picked = ''
    }
    if (!picked) return
    await applyWorkspace(picked)
  }

  return (
    <header className="ofs-topbar">
      <div className="ofs-brand" title={t('studio.nav.label')}>
        <span className="ofs-brand-mark" aria-hidden="true">
          <StudioIcon size={18} />
        </span>
        <span className="ofs-brand-name">{t('studio.brand')}</span>
        <span className="ofs-brand-sub">{t('studio.brandSub')}</span>
      </div>

      <nav className="ofs-tabs ofs-primary-nav" ref={tabsRef} aria-label={t('studio.tabs')}>
        <span className="ofs-tabs-thumb" aria-hidden="true" />
        <div
          className="ofs-creation-menu-wrap"
          ref={creationMenuRef}
          data-thumb-active={creationActive ? 'true' : undefined}
          data-thumb-key="studio"
        >
          <button
            ref={creationTriggerRef}
            type="button"
            className={creationActive ? 'ofs-tab is-on' : 'ofs-tab'}
            aria-current={creationActive ? 'page' : undefined}
            aria-haspopup="menu"
            aria-expanded={creationMenuOpen}
          onClick={() => {
            // 从作品库 / 工坊返回：保留上一次的创作模式（生图或视频）直接切回工作台，
            // 不弹类型菜单——回到工作台是一次导航，不需要「先选类型」的二次确认。
            if (view !== 'studio') {
              setCreationMenuOpen(false)
              setView('studio')
              return
            }
            // 已在创作页时点「创作」：只负责开合类型菜单（用于切换生图 / 视频）。
            setCreationMenuOpen((value) => !value)
          }}
          >
            <Icon name="sparkles" size={15} />
            {t('studio.tab.studio')}
            <Icon name="chevronDown" size={13} />
          </button>
          {creationMenuPresence.mounted ? (
            <div
              className="ofs-popover ofs-creation-menu"
              data-exiting={creationMenuPresence.exiting ? 'true' : undefined}
              role="menu"
              aria-label={t('studio.creationTypes')}
              onKeyDown={handleCreationMenuKeyDown}
            >
              <div className="ofs-popover-head"><span>{t('studio.creationTypes')}</span></div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={creationMode === 'image'}
                className="ofs-popover-row"
                onClick={() => selectCreationMode('image')}
              >
                <Icon name="image" size={15} />
                <span className="ofs-creation-menu-label">{t('studio.creationType.image')}</span>
                {creationMode === 'image' ? <Icon name="check" size={15} /> : null}
              </button>
              {hasVideoPresets ? (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={creationMode === 'video'}
                  className="ofs-popover-row"
                  onClick={() => selectCreationMode('video')}
                >
                  <Icon name="film" size={15} />
                  <span className="ofs-creation-menu-label">{t('studio.creationType.video')}</span>
                  {creationMode === 'video' ? <Icon name="check" size={15} /> : null}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          data-thumb-key="workshop"
          data-thumb-active={view === 'workshop' ? 'true' : undefined}
          className={view === 'workshop' ? 'ofs-tab is-on' : 'ofs-tab'}
          aria-current={view === 'workshop' ? 'page' : undefined}
          onClick={() => {
            setCreationMenuOpen(false)
            if (actions && typeof actions.openWorkshop === 'function') {
              actions.openWorkshop(library && library.selected ? library.selected : null)
            } else {
              setView('workshop')
            }
          }}
        >
          <Icon name="frame" size={15} />
          {t('studio.tab.workshop')}
        </button>
        <button
          type="button"
          data-thumb-key="gallery"
          data-thumb-active={view === 'gallery' ? 'true' : undefined}
          className={view === 'gallery' ? 'ofs-tab is-on' : 'ofs-tab'}
          aria-current={view === 'gallery' ? 'page' : undefined}
          onClick={() => {
            setCreationMenuOpen(false)
            setView('gallery')
          }}
        >
          <Icon name="images" size={15} />
          {t('studio.tab.gallery')}
        </button>
      </nav>

      {/* 当前工作区：显示末尾两段路径（title 是全路径），点击展开切换菜单。
          Electron 用原生目录选择，浏览器开发态用 prompt 输入绝对路径。 */}
      <div className="ofs-pill-wrap ofs-workspace" ref={workspaceWrapRef}>
        <button
          type="button"
          className="ofs-workspace-btn"
          title={workspaceCurrent || t('topbar.workspace.none')}
          aria-label={workspaceCurrent || t('topbar.workspace.none')}
          aria-expanded={workspaceOpen}
          aria-haspopup="menu"
          onClick={() => setWorkspaceOpen((value) => !value)}
        >
          <Icon name="folder" size={14} />
          <span className="ofs-workspace-name ofs-width-stack">
            {workspaceLabelCandidates.map((label) => (
              <span
                key={label}
                className="ofs-width-stack-ghost"
                aria-hidden="true"
                data-measure-only="true"
              >
                {label}
              </span>
            ))}
            <span className="ofs-width-stack-value">{workspaceLabel}</span>
          </span>
          <span className="ofs-pill-caret" aria-hidden="true">
            <Icon name="chevronDown" size={13} />
          </span>
        </button>

        {workspacePopoverPresence.mounted ? (
          <div
            className="ofs-popover ofs-workspace-popover"
            data-exiting={workspacePopoverPresence.exiting ? 'true' : undefined}
            role="menu"
          >
            <div className="ofs-workspace-current">
              {workspaceCurrent ? (
                <>
                  <span className="ofs-workspace-current-label">{t('topbar.workspace.current')}</span>
                  <span className="ofs-workspace-full" title={workspaceCurrent}>
                    {workspaceCurrent}
                  </span>
                </>
              ) : (
                <span className="ofs-workspace-empty">{t('topbar.workspace.none')}</span>
              )}
            </div>

            {!workspaceSwitchable ? <p className="ofs-popover-hint">{t('topbar.workspace.busy')}</p> : null}

            <button
              type="button"
              role="menuitem"
              className="ofs-popover-row"
              onClick={chooseWorkspace}
              disabled={workspaceBusy || !workspaceSwitchable}
            >
              <Icon name="folder" size={15} />
              {workspaceBusy ? t('topbar.workspace.switching') : t('topbar.workspace.choose')}
            </button>

            {compute.openFolder ? (
              <button
                type="button"
                role="menuitem"
                className="ofs-popover-row"
                onClick={() => {
                  setWorkspaceOpen(false)
                  compute.openFolder()
                }}
              >
                <Icon name="folderOpen" size={15} />
                {t('topbar.workspace.openFolder')}
              </button>
            ) : null}

            {workspace && workspace.recent.length > 0 ? (
              <>
                <div className="ofs-popover-head">
                  <span>{t('topbar.workspace.recent')}</span>
                </div>
                {workspace.recent.slice(0, 6).map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="menuitem"
                    className="ofs-popover-row"
                    title={path}
                    disabled={workspaceBusy || path === workspaceCurrent}
                    onClick={() => applyWorkspace(path)}
                  >
                    <Icon name="folder" size={14} />
                    <span className="ofs-workspace-recent">{workspaceLabelOf(path)}</span>
                  </button>
                ))}
              </>
            ) : null}

            {workspaceError ? (
              <p className="ofs-popover-hint ofs-workspace-error" role="alert">{workspaceError}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="ofs-topbar-actions">
        <div className="ofs-topbar-utilities">

          {/* 应用自身更新：独立入口，不再塞进算力胶囊（M2.8 阶段 B）。 */}
          <UpdateEntry
            t={t}
            openSettings={openSettings}
            onDisconnect={compute.stopSession}
            stateOverride={props.updateState}
            defaultOpen={Boolean(props.defaultUpdateOpen)}
          />

          {openSettings ? (
            <button
              type="button"
              className="ofs-icon-btn ofs-topbar-settings"
              onClick={(event) => openSettings(event.currentTarget)}
              title={t('studio.settings.open')}
              aria-label={t('studio.settings.open')}
            >
              <Icon name="sliders" size={16} />
            </button>
          ) : null}

        </div>
        <div className="ofs-topbar-resources">
          <div className="ofs-pill-wrap ofs-compute-wrap" ref={wrapRef}>
            <button
              ref={pillRef}
              type="button"
              className={`ofs-compute is-${status.tone}`}
              title={computeStatusLabel}
              onClick={() => {
                setOpen((value) => {
                  if (!value) {
                    setModelOpen(false)
                    setQueueOpen(false)
                  }
                  return !value
                })
              }}
              aria-expanded={open}
              aria-haspopup="dialog"
              aria-controls="ofs-compute-popover"
              aria-label={computeStatusLabel}
            >
              <i className={`ofs-dot is-${status.tone}${status.tone === 'ok' || status.tone === 'warn' ? ' is-live' : ''}`} aria-hidden="true" />
              {hasProviderBadge ? (
                <ProviderIcon id={sessionProviderId} size={13} className="ofs-compute-provider" />
              ) : null}
              <span className="ofs-compute-label ofs-width-stack">
                {computeSourceLabels.map((label) => (
                  <span
                    key={label}
                    className="ofs-width-stack-ghost"
                    aria-hidden="true"
                    data-measure-only="true"
                  >
                    {label}
                  </span>
                ))}
                <span className="ofs-width-stack-value" data-provider-id={sessionProviderId || 'kaggle'}>
                  {computeSourceLabel}
                </span>
              </span>
              {idleApproaching ? (
                <span
                  className={`ofs-compute-idle-alert is-${idleTone}`}
                  title={formatText(t('studio.compute.idleCountdown'), {
                    idle: idleShutdown.idleMinutes,
                    total: idleShutdown.totalMinutes,
                  })}
                >
                  <Icon name="clock" size={11} />
                </span>
              ) : null}
              <span className="ofs-pill-caret" aria-hidden="true">
                <Icon name="chevronDown" size={13} />
              </span>
            </button>

            <ComputePopover
              t={t}
              open={open}
              status={status}
              providerId={sessionProviderId}
              pendingSwitchFrom={pendingSwitchFrom}
              configuredProviders={compute.configuredProviders}
              sessionState={effectiveSession ? effectiveSession.state : 'absent'}
              session={effectiveSession}
              quota={compute.quota}
              presets={presets}
              form={fields}
              probe={compute.probe}
              probeReport={compute.probeReport}
              compute={compute}
              probing={compute.probing}
              busy={compute.busy}
              onSwitchProvider={compute.switchProvider || null}
              onStart={compute.startSession}
              onStop={compute.stopSession}
              onCheck={compute.runProbe}
              onOpenLogs={() => {
                setOpen(false)
                // 菜单收起后这一行会卸载，焦点交还给常驻的算力按钮（与日志入口同一约定）。
                if (openLogs) openLogs(pillRef.current)
              }}
              onOpenSettings={(targetProviderId) => {
                setOpen(false)
                const focusProvider = typeof targetProviderId === 'string' && targetProviderId ? targetProviderId : sessionProviderId
                if (openSettings) openSettings(pillRef.current, 'compute', focusProvider ? { provider: focusProvider } : null)
              }}
            />
          </div>

          {showQueue ? (
            <div className="ofs-pill-wrap ofs-queue-wrap" ref={queueWrapRef}>
              <button
                ref={queueBtnRef}
                type="button"
                className={`ofs-queue-btn${pendingJobs.length > 0 ? ' is-busy' : ''}${compute.queueNotice ? ' is-stalled' : ''}`}
                data-queue-target="true"
                data-just-queued={justQueued ? 'true' : undefined}
                title={t('studio.queue.title')}
                aria-label={t('studio.queue.title')}
                aria-expanded={queueOpen}
                aria-haspopup="dialog"
                aria-controls="ofs-queue-popover"
                onClick={() => {
                  setQueueOpen((value) => {
                    if (!value) {
                      setOpen(false)
                      setModelOpen(false)
                    }
                    return !value
                  })
                }}
              >
                {pendingJobs.length > 0 || status.transient || compute.queueNotice || justQueued || queueFlying ? (
                  <i className={`ofs-dot ${compute.queueNotice ? 'is-warn' : 'is-warn is-live'}`} aria-hidden="true" />
                ) : retainedJobs.length > 0 ? (
                  <i className={`ofs-dot ${retainedHasFailure ? 'is-error' : 'is-ok'}`} aria-hidden="true" />
                ) : (
                  <Icon name="clock" size={14} />
                )}
                <span className="ofs-queue-btn-label">{t('studio.queue.button')}</span>
                {queueBadgeCount > 0 ? (
                  <span className="ofs-queue-badge">{queueBadgeCount}</span>
                ) : null}
                <span className="ofs-pill-caret" aria-hidden="true">
                  <Icon name="chevronDown" size={13} />
                </span>
              </button>

              <QueuePopover
                t={t}
                open={queueOpen}
                compute={compute}
                library={library}
                actions={actions}
                guidance={props.guidance}
                dismissedKey={ui.dismissed}
                onClose={() => setQueueOpen(false)}
              />
            </div>
          ) : null}

          <ModelCardPicker
            t={t}
            isEn={isEn}
            presets={presets}
            value={fields.presetId}
            defaultPreset={compute.defaultPreset}
            // 算力来源门控与生成前预检共用组合层唯一归一的 provider，不在这里再推导。
            provider={compute.provider}
            configuredProviders={compute.configuredProviders}
            session={compute.session}
            imageApi={compute.imageApi}
            localGpu={compute.localGpu}
            hardware={compute.hardware}
            onSwitchProvider={compute.switchProvider || null}
            open={modelOpen}
            onOpenChange={(next) => {
              setModelOpen(next)
              if (next) {
                setOpen(false)
                setQueueOpen(false)
              }
            }}
            onOpenSettings={(targetPreset, meta) => {
              setModelOpen(false)
              if (!openSettings) return
              const target = targetPreset?.cloud?.vendor
                ? { provider: 'cloud-api', vendor: targetPreset.cloud.vendor }
                : { provider: meta?.provider || (compute.provider === 'local-gpu' ? 'local-gpu' : (presetProviderRestrictionOf(targetPreset) || undefined)) }
              openSettings(pillRef.current, 'compute', target)
            }}
            onChange={(next, meta) => {
              const targetProvider = meta && meta.switchToProvider ? meta.switchToProvider : ''
              if (actions && typeof actions.applyModePreset === 'function') {
                actions.applyModePreset(next, targetProvider)
              } else {
                // 切换预设统一走表单域的 selectPreset：参数与负向提示词跟随规则在一处维护。
                if (selectPreset) selectPreset(next, targetProvider ? { provider: targetProvider } : undefined)
                else patchForm({ presetId: next.id })
                if (targetProvider && typeof compute.switchProvider === 'function') {
                  void compute.switchProvider(targetProvider)
                  if (ui && typeof ui.showToast === 'function') {
                    ui.showToast(formatText(t('studio.preset.autoSwitchedProvider'), {
                      provider: providerLabelOf(t, targetProvider) || targetProvider,
                      model: next.short || next.label || next.id,
                    }))
                  }
                }
              }
              setModelOpen(false)
            }}
          />

      </div>
      </div>
      {/* 顶栏兼作标题栏：右端是自绘的最小化 / 最大化 / 关闭（浏览器态不渲染）。 */}
      <WindowControls t={t} />
    </header>
  )
}
