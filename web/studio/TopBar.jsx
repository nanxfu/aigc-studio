/** 工作台顶栏：品牌、视图切换、云端状态与配额、模型预设。 */

import React from 'react'

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
import { ProviderIcon } from './settings/providerIcons.jsx'
import { StudioIcon } from './StudioIcon.jsx'
import { UpdateEntry } from './UpdateEntry.jsx'
import { WindowControls } from './WindowControls.jsx'

/** 接收 { t, ui, compute, form, library }；ui/compute/form/library 是领域对象。 */
export function TopBar(props) {
  const { t, isEn, ui, compute, library } = props
  const { form: fields, patchForm, selectPreset } = props.form
  const { view, setView, openLogs, openSettings } = ui
  const { session, sessionState, presets } = compute

  // 当前会话真正跑在哪个来源：设置里切换来源后旧会话可能仍在另一家，
  // 这里显示会话事实而不是设置值，避免「设置 Colab、实际 Kaggle 出图」的错觉。
  // 商业 API 走无状态 HTTPS（不占用后台 Colab/Kaggle 会话），切到 cloud-api 时直接按商业 API 口径展示。
  const sessionProviderId = compute?.provider === 'cloud-api'
    ? 'cloud-api'
    : ((session && session.state && session.state !== 'absent' && session.provider)
        || (compute && compute.provider)
        || (session && session.provider))
  const isCloudApi = sessionProviderId === 'cloud-api'
  const hasCloudKey = Boolean(
    compute?.imageApi?.hasApiKey
    || (Array.isArray(compute?.imageApi?.apiKeysConfigured) && compute.imageApi.apiKeysConfigured.length > 0),
  )
  const rawStatus = compute.status || computeStatusOf(t, { session, provider: compute.provider })
  const status = isCloudApi && session?.provider !== 'cloud-api'
    ? computeStatusOf(t, { session: { state: hasCloudKey ? 'ready' : 'absent', provider: 'cloud-api' }, provider: 'cloud-api' })
    : rawStatus
  const sessionProvider = providerLabelOf(t, sessionProviderId)
  const isWorker = sessionProviderId === 'private-worker' || sessionProviderId === 'local-gpu'
  // 私有 Worker 没有配额：胶囊里补上真实 GPU 型号，让「连上的到底是哪台机器」一眼可见。
  const workerDevice = isWorker && status.ready && session && session.device
    ? `（${deviceShortOf(session.device)}）`
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
  // 模型卡与算力弹层互斥：两者同时只允许一个展开。
  const [modelOpen, setModelOpen] = React.useState(Boolean(props.defaultModelOpen))
  const wrapRef = React.useRef(null)
  const pillRef = React.useRef(null)
  const tabsRef = React.useRef(null)
  useSlidingThumb(tabsRef, view)

  // 菜单：Esc 与点击外部都关闭。
  React.useEffect(() => {
    if (!open) return undefined
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    function onDown(event) {
      const node = wrapRef.current
      if (node && !node.contains(event.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  // ── 当前工作区（独立客户端 Phase 1 新增）────────────────────────────
  // 首选 /state 下发的 workspace:{current,recent,switchable}；字段未就绪（旧服务端 /
  // 启动早期）时用 GET /api/workspace 兜底一次，等 /state 带上该字段后就不再重复请求。
  const hostWorkspace = compute && compute.workspace && typeof compute.workspace === 'object' ? compute.workspace : null
  const hostWorkspaceView = hostWorkspace ? normalizeWorkspaceView(hostWorkspace) : null
  const hostWorkspaceCurrent = hostWorkspaceView ? hostWorkspaceView.current : ''
  const [fallbackWorkspace, setFallbackWorkspace] = React.useState(null)
  const [workspaceOverride, setWorkspaceOverride] = React.useState(null)
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false)
  const [workspaceBusy, setWorkspaceBusy] = React.useState(false)
  const [workspaceError, setWorkspaceError] = React.useState('')
  const workspaceWrapRef = React.useRef(null)
  const workspacePopoverPresence = usePresence(workspaceOpen, 150)
  // 切换成功后先展示本次返回的视图（override），等 /state 快照追上新的 current 再清掉。
  const workspace = workspaceOverride || hostWorkspaceView || fallbackWorkspace
  const workspaceCurrent = workspace ? workspace.current : ''
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

      <nav className="ofs-tabs" ref={tabsRef} aria-label={t('studio.tabs')}>
        <span className="ofs-tabs-thumb" aria-hidden="true" />
        <button
          type="button"
          data-thumb-active={view === 'studio' ? 'true' : undefined}
          className={view === 'studio' ? 'ofs-tab is-on' : 'ofs-tab'}
          onClick={() => setView('studio')}
        >
          <Icon name="sparkles" size={15} />
          {t('studio.tab.studio')}
        </button>
        <button
          type="button"
          data-thumb-active={view === 'gallery' ? 'true' : undefined}
          className={view === 'gallery' ? 'ofs-tab is-on' : 'ofs-tab'}
          onClick={() => setView('gallery')}
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
          aria-expanded={workspaceOpen}
          aria-haspopup="menu"
          onClick={() => setWorkspaceOpen((value) => !value)}
        >
          <Icon name="folder" size={14} />
          <span className="ofs-workspace-name">
            {workspaceCurrent ? workspaceLabelOf(workspaceCurrent) : t('topbar.workspace.none')}
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
            <div className="ofs-popover-head">
              <span>{t('topbar.workspace.current')}</span>
              <span className="ofs-workspace-full" title={workspaceCurrent || undefined}>
                {workspaceCurrent || t('topbar.workspace.none')}
              </span>
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

      <span className="ofs-grow" />

      {compute.openFolder ? (
        <button
          type="button"
          className="ofs-icon-btn"
          onClick={compute.openFolder}
          title={t('studio.action.openFolder')}
          aria-label={t('studio.action.openFolder')}
        >
          <Icon name="folderOpen" size={16} />
        </button>
      ) : null}

      {library.loadHistory ? (
        <button type="button" className="ofs-icon-btn" onClick={library.loadHistory} title={t('studio.refresh')} aria-label={t('studio.refresh')}>
          <Icon name="refresh" size={16} />
        </button>
      ) : null}

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

      <div className="ofs-pill-wrap" ref={wrapRef}>
        <button
          ref={pillRef}
          type="button"
          className={`ofs-compute is-${status.tone}`}
          onClick={() => {
            setOpen((value) => {
              if (!value) setModelOpen(false)
              return !value
            })
          }}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <i className={`ofs-dot is-${status.tone}${status.tone === 'ok' || status.tone === 'warn' ? ' is-live' : ''}`} aria-hidden="true" />
          {hasProviderBadge ? (
            <ProviderIcon id={sessionProviderId} size={13} className="ofs-compute-provider" />
          ) : null}
          <span className="ofs-compute-label">{computeStatusLabel}</span>
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
          sessionState={sessionState}
          session={session}
          quota={compute.quota}
          presets={presets}
          form={fields}
          probe={compute.probe}
          probeReport={compute.probeReport}
          compute={compute}
          probing={compute.probing}
          busy={compute.busy}
          onStart={compute.startSession}
          onStop={compute.stopSession}
          onCheck={compute.runProbe}
          onOpenLogs={() => {
            setOpen(false)
            // 菜单收起后这一行会卸载，焦点交还给常驻的算力按钮（与日志入口同一约定）。
            if (openLogs) openLogs(pillRef.current)
          }}
          onOpenSettings={() => {
            setOpen(false)
            if (openSettings) openSettings(pillRef.current, isWorker ? 'compute' : undefined)
          }}
        />
      </div>

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
        open={modelOpen}
        onOpenChange={(next) => {
          setModelOpen(next)
          if (next) setOpen(false)
        }}
        onOpenSettings={(targetPreset) => {
          setModelOpen(false)
          if (!openSettings) return
          const target = targetPreset?.cloud?.vendor
            ? { provider: 'cloud-api', vendor: targetPreset.cloud.vendor }
            : { provider: presetProviderRestrictionOf(targetPreset) || undefined }
          openSettings(pillRef.current, 'compute', target)
        }}
        onChange={(next, meta) => {
          const targetProvider = meta && meta.switchToProvider ? meta.switchToProvider : ''
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
          setModelOpen(false)
        }}
      />

      {/* 顶栏兼作标题栏：右端是自绘的最小化 / 最大化 / 关闭（浏览器态不渲染）。 */}
      <WindowControls t={t} />
    </header>
  )
}
