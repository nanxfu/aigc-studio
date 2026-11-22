/** 工作台顶栏：品牌、视图切换、云端状态与配额、模型预设。 */

import React from 'react'

import { Tooltip } from '../components/Tooltip.jsx'
import { useNow } from '../hooks/useNow.js'
import { usePresence } from './hooks/usePresence.js'
import { useSlidingThumb } from './hooks/useSlidingThumb.js'
import { fetchWorkspace, switchWorkspace } from '../api/resources.js'
import { formatDuration, formatSeconds, formatText } from '../logic/format.js'
import { elapsedMsSince, formatClockTime, quotaText } from '../logic/logs.js'
import { computeStatusOf, deviceShortOf, idleShutdownOf, providerLabelOf, providerText } from '../logic/status.js'
import { presetProviderRestrictionOf } from '../logic/preset.js'
import { normalizeWorkspaceView, workspaceLabelOf, workspaceViewOf } from '../logic/workspace.js'
import { desktop } from '../runtime.js'
import { Icon } from './icons.jsx'
import { ModelCardPicker } from './ModelCardPicker.jsx'
import { ProviderIcon } from './settings/providerIcons.jsx'
import { StudioIcon } from './StudioIcon.jsx'
import { UpdateEntry } from './UpdateEntry.jsx'
import { WindowControls } from './WindowControls.jsx'
import { accountStatusOf, accessMethodKey, accessStatusKey, accessStatusOf, probeStatusOf } from '../logic/probe.js'
import { KAGGLE_ACCOUNT_URL } from '../logic/guidance.js'
import { useHostSnapshot } from './hooks/useStudioLogs.js'

/** 接收 { t, ui, compute, form, library }；ui/compute/form/library 是领域对象。 */
export function TopBar(props) {
  const { t, isEn, ui, compute, library } = props
  const { form: fields, patchForm, selectPreset } = props.form
  const { view, setView, openLogs, openSettings } = ui
  const {
    sessionState,
    session,
    quota,
    presets,
    busy,
    probing,
    probe,
    probeReport,
    startSession,
    stopSession,
    runProbe,
    openFolder,
  } = compute
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
  // defaultOpen 只给预览 / 渲染测试用，正式界面从关闭态开始。
  const [open, setOpen] = React.useState(Boolean(props.defaultOpen))
  // 模型卡与算力弹层互斥：两者同时只允许一个展开。
  const [modelOpen, setModelOpen] = React.useState(Boolean(props.defaultModelOpen))
  const wrapRef = React.useRef(null)
  const pillRef = React.useRef(null)
  const tabsRef = React.useRef(null)
  useSlidingThumb(tabsRef, view)
  // 配额回退与隧道信息需要 /state 里的 probeLastGood 等字段：弹层展开时取一次快照。
  const snapshot = useHostSnapshot(open)
  const now = useNow(open)
  const worker = (compute && compute.worker) || (snapshot && snapshot.privateWorker) || null
  const workerEndpointHost = (() => {
    try {
      return worker && worker.endpointUrl ? new URL(worker.endpointUrl).host : ''
    } catch {
      return ''
    }
  })()

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
  const computePopoverPresence = usePresence(open, 150)
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
    const view = workspaceViewOf(result)
    if (!view) {
      setWorkspaceError(t('topbar.workspace.switchFailed'))
      return
    }
    setWorkspaceOverride(view)
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

  const idleMinutes = session && session.idleTimeoutSec ? Math.round(session.idleTimeoutSec / 60) : 0
  // 空闲倒计时只认宿主快照里的真实读数：idleSeconds 缺失时退回「休眠阈值」一行，不编造余量。
  const idleShutdown = idleShutdownOf(session)
  const isColab = sessionProviderId === 'colab'
  // Colab 没有每周配额，改用 CCU 余额/速率：就绪保活或未唤醒静默探测均可拿到。
  const colabAuth = (compute && compute.colabAuth) || (snapshot && snapshot.colabAuth) || null
  const colabUsage =
    (session && session.provider === 'colab' && session.providerUsage)
    || (compute && compute.colabUsage)
    || (snapshot && snapshot.colabUsage)
    || (probeReport && probeReport.probe && probeReport.probe.provider === 'colab' && probeReport.probe.usage)
    || null
  const colabProbe =
    (compute && compute.colabProbe)
    || (snapshot && snapshot.colabProbe)
    || (probeReport && probeReport.probe && probeReport.probe.provider === 'colab' && probeReport.probe)
    || null
  const quotaUsed = !isColab && !isWorker && quota && Number.isFinite(quota.usedHours) ? quota.usedHours : null
  const quotaTotal = !isColab && !isWorker && quota && Number.isFinite(quota.totalHours) ? quota.totalHours : null
  // 速度只讲实测值，且优先讲云端已加载的模型；没有测量数据的预设不编时间。
  const loadedPreset = presets.find((item) => item.id === (session && session.presetId)) || presets.find((item) => item.id === fields.presetId) || null
  // 客户端预设有两代形状：公开视图是扁平 steadySeconds，旧测试替身放在 measured 里。
  const steadyRaw = loadedPreset && loadedPreset.steadySeconds !== undefined
    ? loadedPreset.steadySeconds
    : loadedPreset && loadedPreset.measured ? loadedPreset.measured.steadySeconds : null
  const steadySeconds = Number.isFinite(steadyRaw) ? steadyRaw : null
  // 访问方式只影响展示：直连模式把「命令行」改为「直连」，状态改为「直连正常 / 直连未登录」。
  const kaggleTransport = compute.kaggleTransport === 'direct' ? 'direct' : 'cli'
  // 状态弹层优先用宿主轮询到的 probe；刚做过检查时用本次结果兜底。
  const probePayload = probe || (snapshot && snapshot.probe) || (probeReport && probeReport.probe && probeReport.probe.provider !== 'colab' ? probeReport.probe : null) || null
  const probeInfo = !isColab && !isWorker ? probeStatusOf(probePayload) : null
  // 账号状态不只看探测：会话能启动、能出图同样证明凭据有效；从未探测时显示「未检查」，
  // 不能默认成「不可用」（可出图却提示账号不可用属于误报）。
  const accountStatus = isWorker
    ? (sessionState === 'ready' ? 'ok' : 'unknown')
    : isColab
      ? ((colabAuth && colabAuth.authorized === true) || (colabProbe && colabProbe.auth && colabProbe.auth.ok === true) || sessionState === 'ready'
        ? 'ok'
        : (colabProbe && colabProbe.auth && colabProbe.auth.ok === false) || (colabAuth && colabAuth.authorized === false)
          ? 'failed'
          : 'unknown')
      : accountStatusOf(probePayload, sessionState)
  const probeFailed = probeReport && probeReport.status && probeReport.status !== 'ok' ? probeReport : null
  const probeNote = !isColab && !isCloudApi && probeInfo && probeInfo.notes.length > 0 ? probeInfo.notes[0] : (colabProbe && Array.isArray(colabProbe.notes) && colabProbe.notes[0]) || ''
  // 配额不可读（接口不可用或本次检测失败）时改用本地统计回退展示（仅 Kaggle）。
  const quotaUnavailable = !isColab && !isWorker && !isCloudApi && Boolean(probeFailed || (probeInfo && probeInfo.quota !== 'ok'))
  const lastGood = (snapshot && snapshot.probeLastGood) || null
  const lastCheckTime = formatClockTime(snapshot && snapshot.probeLastGoodAt)
  const lastGoodQuota = quotaText(lastGood && lastGood.quota)
  const sessionRunMs = session ? elapsedMsSince(session.startedAt, now) : null
  const tunnelProvider = session && session.tunnelProvider ? session.tunnelProvider : ''
  const tunnelLabel =
    tunnelProvider === 'cloudflare'
      ? t('studio.compute.tunnel.cloudflare')
      : tunnelProvider === 'custom'
        ? t('studio.compute.tunnel.custom')
        : ''
  const statusText = (value) => {
    if (value === 'ok') return t('value.ok')
    if (value === 'failed') return t('value.failed')
    if (value === 'unavailable') return t('value.quotaUnavailable')
    return t('value.unknown')
  }
  // 圆形配额仪表环：Kaggle 展示剩余小时比例，Colab 展示 CCU 余额与消耗速率（均无需唤醒即可拉取）。
  const RING_RADIUS = 24
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
  const hasKaggleQuota = !isColab && quotaUsed !== null && quotaTotal !== null && quotaTotal > 0
  const kaggleRemainingHours = hasKaggleQuota ? Math.max(0, quotaTotal - quotaUsed) : null
  const kaggleRemainingRatio = hasKaggleQuota ? Math.min(1, Math.max(0, kaggleRemainingHours / quotaTotal)) : null
  const hasColabUsage = isColab && colabUsage && Number.isFinite(colabUsage.balance)
  const colabBalance = hasColabUsage ? colabUsage.balance : null
  const colabRate = hasColabUsage && Number.isFinite(colabUsage.rate) && colabUsage.rate > 0 ? colabUsage.rate : null
  const colabEstimateHours = colabBalance !== null && colabRate !== null ? colabBalance / colabRate : null
  const ringRatio = hasKaggleQuota
    ? kaggleRemainingRatio
    : hasColabUsage
      ? Math.max(0.12, Math.min(0.88, colabBalance / 100))
      : null
  const ringTone = hasKaggleQuota
    ? (kaggleRemainingRatio <= 0.04 ? 'error' : kaggleRemainingRatio <= 0.15 ? 'warn' : 'normal')
    : hasColabUsage
      ? (colabBalance < 3 ? 'error' : colabBalance < 15 ? 'warn' : 'normal')
      : 'empty'
  const ringDashOffset = ringRatio !== null ? RING_CIRCUMFERENCE * (1 - ringRatio) : 0
  const idleRatio = idleShutdown && idleShutdown.totalMinutes > 0
    ? Math.min(1, Math.max(0, idleShutdown.idleMinutes / idleShutdown.totalMinutes))
    : null
  const idlePercent = idleRatio !== null ? Math.round(idleRatio * 100) : null
  const idleTone = idleRatio !== null
    ? (idleRatio >= 0.9 ? 'error' : idleRatio >= 0.7 ? 'warn' : 'normal')
    : 'normal'
  const idleApproaching = Boolean(status.ready && idleRatio !== null && idleRatio >= 0.7)
  const hasProviderBadge = sessionProviderId === 'kaggle' || sessionProviderId === 'colab' || isWorker || isCloudApi
  const accessStatus = probeInfo ? accessStatusOf(probeInfo, kaggleTransport) : ''
  const probeToneOf = (value) => {
    if (value === 'ok' || value === 'directOk') return 'ok'
    if (value === 'failed' || value === 'directLoginRequired') return 'error'
    return 'idle'
  }

  /** 展开弹层时按需静默刷新当前算力来源的额度（带 2 分钟节流，不弹出报错打断）。 */
  function refreshQuotaOnOpen() {
    if (isWorker || isCloudApi) return
    if (probing || typeof compute.silentProbe !== 'function') return
    const staleMs = 120_000
    const currentNow = Date.now()
    if (isColab) {
      if (!colabAuth || colabAuth.authorized !== true) return
      const lastAt = Number(compute.colabUsageAt || (snapshot && snapshot.colabUsageAt) || 0)
      if (!hasColabUsage || currentNow - lastAt > staleMs) compute.silentProbe()
      return
    }
    const lastAt = Number(compute.probeAt || (snapshot && snapshot.probeAt) || 0)
    if (!hasKaggleQuota || currentNow - lastAt > staleMs) compute.silentProbe()
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

      {openFolder ? (
        <button
          type="button"
          className="ofs-icon-btn"
          onClick={openFolder}
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
        onDisconnect={stopSession}
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
              const next = !value
              if (next) {
                setModelOpen(false)
                refreshQuotaOnOpen()
              }
              return next
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

        {computePopoverPresence.mounted ? (
          <div
            className="ofs-popover ofs-compute-popover"
            data-exiting={computePopoverPresence.exiting ? 'true' : undefined}
            role="menu"
          >
            <div className="ofs-popover-head ofs-compute-head">
              <div className="ofs-compute-head-top">
                <span className="ofs-compute-head-status">
                  <i className={`ofs-dot is-${status.tone}${status.tone === 'ok' || status.tone === 'warn' ? ' is-live' : ''}`} aria-hidden="true" />
                  {hasProviderBadge ? (
                    <ProviderIcon id={sessionProviderId} size={14} className="ofs-compute-provider" />
                  ) : null}
                  <b>{computeStatusLabel}</b>
                  <Tooltip text={status.tooltip} side="bottom" />
                </span>
                {status.phaseLabel ? (
                  <span className="ofs-compute-phase-badge">
                    <span className="ofs-sr-only">{t('studio.compute.phase')} · </span>
                    {status.phaseLabel}
                  </span>
                ) : null}
              </div>

              {!isCloudApi && ((session && session.device) || tunnelLabel) ? (
                <div className="ofs-compute-specs">
                  {session && session.device ? (
                    <span className="ofs-spec-chip">
                      <Icon name="cube" size={11} />
                      <span>{session.device}</span>
                    </span>
                  ) : null}
                  {tunnelLabel ? (
                    <span className="ofs-spec-chip">
                      <Icon name="cloud" size={11} />
                      <span>{t('studio.compute.tunnel')} · {tunnelLabel}</span>
                    </span>
                  ) : null}
                </div>
              ) : null}

              {!isCloudApi && status.ready && steadySeconds !== null ? (
                <div className="ofs-compute-stat-row">
                  <span className="ofs-muted">{t('studio.compute.speedLine')}</span>
                  <strong className="ofs-compute-stat-val">{formatSeconds(t, steadySeconds)}</strong>
                </div>
              ) : null}
            </div>

            <div className="ofs-compute-meters">
              {isCloudApi ? (() => {
                const activeFormPreset = Array.isArray(presets)
                  ? presets.find((item) => item.id === fields.presetId) || null
                  : null
                const cloudUnitCost = activeFormPreset?.cloud ? Number(activeFormPreset.cloud.estCostPerImage) : NaN
                const hasCloudCost = Number.isFinite(cloudUnitCost) && cloudUnitCost > 0
                const cloudCount = Math.max(1, Math.round(Number(fields.count) || 1))
                const cloudUnitCostStr = hasCloudCost ? cloudUnitCost.toFixed(cloudUnitCost < 0.01 ? 3 : 2) : ''
                const cloudBatchCostStr = hasCloudCost ? (cloudUnitCost * cloudCount).toFixed(cloudUnitCost * cloudCount < 0.01 ? 3 : 2) : ''
                const configuredCloudVendorsText = hasCloudKey && Array.isArray(compute?.imageApi?.apiKeysConfigured) && compute.imageApi.apiKeysConfigured.length > 0
                  ? compute.imageApi.apiKeysConfigured.map((v) => t(`studio.settings.cloudApi.vendorName.${v}`)).join(' / ')
                  : ''
                return (
                  <div className="ofs-quota-panel">
                    <div className={`ofs-quota-ring${hasCloudKey ? '' : ' is-empty'}`} aria-hidden="true">
                      <div className="ofs-quota-ring-center">
                        <ProviderIcon id="cloud-api" size={20} />
                      </div>
                    </div>
                    <div className="ofs-quota-meta">
                      <span className="ofs-quota-title">{t('studio.compute.cloudApi.billingTitle')}</span>
                      <strong className="ofs-quota-primary">
                        {hasCloudCost
                          ? (cloudCount > 1
                              ? formatText(t('studio.compute.cloudApi.billingBatch'), {
                                  unit: cloudUnitCostStr,
                                  count: cloudCount,
                                  total: cloudBatchCostStr,
                                })
                              : formatText(t('studio.compute.cloudApi.billingUnit'), { cost: cloudUnitCostStr }))
                          : (hasCloudKey ? t('studio.compute.cloudApi.billingDynamic') : t('studio.compute.cloudApi.missingKey'))}
                      </strong>
                      <span className="ofs-quota-sub">
                        {configuredCloudVendorsText
                          ? `${configuredCloudVendorsText} · ${t('studio.compute.cloudApi.noQuota')}`
                          : t('studio.compute.cloudApi.noQuota')}
                      </span>
                    </div>
                  </div>
                )
              })() : isWorker ? (
                <div className="ofs-quota-panel">
                  <div className={`ofs-quota-ring${status.tone === 'ok' ? '' : ' is-empty'}`} aria-hidden="true">
                    <div className="ofs-quota-ring-center">
                      <Icon name="cube" size={20} />
                    </div>
                  </div>
                  <div className="ofs-quota-meta">
                    <span className="ofs-quota-title">{t('studio.compute.worker.title')}</span>
                    <strong className="ofs-quota-primary">
                      {(session && session.device) || t('studio.compute.worker.notConnected')}
                    </strong>
                    <span className="ofs-quota-sub">
                      {workerEndpointHost || t('studio.compute.worker.unconfigured')}
                    </span>
                  </div>
                </div>
              ) : (
              <div className="ofs-quota-panel">
                <div className={`ofs-quota-ring is-${ringTone}`} aria-hidden="true">
                  <svg className="ofs-quota-ring-svg" width="60" height="60" viewBox="0 0 60 60">
                    <circle className="ofs-quota-ring-track" cx="30" cy="30" r={RING_RADIUS} />
                    {ringRatio !== null ? (
                      <circle
                        className="ofs-quota-ring-fill"
                        cx="30"
                        cy="30"
                        r={RING_RADIUS}
                        strokeDasharray={RING_CIRCUMFERENCE}
                        strokeDashoffset={ringDashOffset}
                      />
                    ) : null}
                  </svg>
                  <div className="ofs-quota-ring-center">
                    {hasKaggleQuota ? (
                      <>
                        <strong>
                          {Number.isInteger(kaggleRemainingHours) ? kaggleRemainingHours : kaggleRemainingHours.toFixed(1)}h
                        </strong>
                        <span>{t('studio.compute.remaining')}</span>
                      </>
                    ) : hasColabUsage ? (
                      <>
                        <strong>{colabBalance.toFixed(1)}</strong>
                        <span>CCU</span>
                      </>
                    ) : (
                      <strong>—</strong>
                    )}
                  </div>
                </div>

                <div className="ofs-quota-meta">
                  <span className="ofs-quota-title">
                    {isColab ? t('studio.compute.quotaTitle.colab') : t('studio.compute.quotaTitle.kaggle')}
                  </span>
                  <strong className="ofs-quota-primary">
                    {hasKaggleQuota
                      ? `${quotaUsed} / ${quotaTotal} ${t('unit.hour')}`
                      : hasColabUsage
                        ? formatText(t('studio.compute.ccu'), { balance: colabBalance.toFixed(1) })
                        : '—'}
                  </strong>
                  <span className="ofs-quota-sub">
                    {hasKaggleQuota
                      ? formatText(t('studio.compute.quotaUsedLine'), { used: quotaUsed, total: quotaTotal })
                      : hasColabUsage && colabRate !== null
                        ? `${formatText(t('studio.compute.ccuRate'), { rate: colabRate.toFixed(2) })} · ${formatText(t('studio.compute.ccuEstimate'), { hours: colabEstimateHours.toFixed(1) })}`
                        : probing
                          ? t('studio.compute.quotaLoading')
                          : t('studio.compute.quotaEmpty')}
                  </span>
                </div>
              </div>
              )}

              {idleShutdown ? (
                <div className="ofs-compute-meter-block">
                  <div className="ofs-compute-meter-head">
                    <span className="ofs-muted">
                      {formatText(t('studio.compute.idleCountdown'), {
                        idle: idleShutdown.idleMinutes,
                        total: idleShutdown.totalMinutes,
                      })}
                    </span>
                  </div>
                  <div className={`ofs-meter is-countdown${idleTone !== 'normal' ? ` is-${idleTone}` : ''}`} aria-hidden="true">
                    <div className="ofs-meter-fill" style={{ width: `${idlePercent}%` }} />
                  </div>
                </div>
              ) : idleMinutes > 0 ? (
                <div className="ofs-compute-stat-row">
                  <span className="ofs-muted">{t('studio.compute.idleFor')} {idleMinutes} {t('unit.min')}</span>
                </div>
              ) : null}
            </div>

            {/* 当前阶段的一句话说明：排队/连接/预热分别是不同的等待原因，不能混用同一条提示。 */}
            {status.hint ? <p className="ofs-popover-hint">{status.hint}</p> : null}

            <div className="ofs-popover-note ofs-health-section">
              {isCloudApi ? (() => {
                const activeFormPreset = Array.isArray(presets)
                  ? presets.find((item) => item.id === fields.presetId) || null
                  : null
                const cloudUnitCost = activeFormPreset?.cloud ? Number(activeFormPreset.cloud.estCostPerImage) : NaN
                const hasCloudCost = Number.isFinite(cloudUnitCost) && cloudUnitCost > 0
                const cloudUnitCostStr = hasCloudCost ? cloudUnitCost.toFixed(cloudUnitCost < 0.01 ? 3 : 2) : ''
                const configuredCloudVendorsText = hasCloudKey && Array.isArray(compute?.imageApi?.apiKeysConfigured) && compute.imageApi.apiKeysConfigured.length > 0
                  ? compute.imageApi.apiKeysConfigured.map((v) => t(`studio.settings.cloudApi.vendorName.${v}`)).join(' / ')
                  : ''
                return (
                  <div className="ofs-health-grid is-single">
                    <div className="ofs-health-card">
                      <span className="ofs-health-key">
                        <i className={`ofs-dot is-${hasCloudKey ? 'ok' : 'idle'}`} aria-hidden="true" />
                        {t('studio.compute.cloudApi.vendorsLabel')}
                      </span>
                      <span className="ofs-sr-only"> · </span>
                      <span className="ofs-health-val">
                        {configuredCloudVendorsText || t('studio.compute.cloudApi.missingKey')}
                      </span>
                    </div>
                    <div className="ofs-health-card">
                      <span className="ofs-health-key">
                        <i className={`ofs-dot is-${activeFormPreset?.cloud ? 'ok' : 'idle'}`} aria-hidden="true" />
                        {t('studio.compute.cloudApi.currentModelLabel')}
                      </span>
                      <span className="ofs-sr-only"> · </span>
                      <span className="ofs-health-val">
                        {activeFormPreset?.cloud
                          ? `${activeFormPreset.short || activeFormPreset.label}${hasCloudCost ? ` · ¥${cloudUnitCostStr}/${t('studio.compute.cloudApi.perImageUnit')}` : ''}`
                          : t('studio.compute.cloudApi.noModelSelected')}
                      </span>
                    </div>
                  </div>
                )
              })() : isWorker ? (
                <div className="ofs-health-grid is-single">
                  <div className="ofs-health-card">
                    <span className="ofs-health-key">
                      <i className={`ofs-dot is-${status.tone}`} aria-hidden="true" />
                      {t('studio.compute.worker.endpoint')}
                    </span>
                    <span className="ofs-sr-only"> · </span>
                    <span className="ofs-health-val" title={worker && worker.endpointUrl ? worker.endpointUrl : undefined}>
                      {workerEndpointHost || t('studio.compute.worker.unconfigured')}
                    </span>
                  </div>
                  <div className="ofs-health-card">
                    <span className="ofs-health-key">
                      <i className={`ofs-dot is-${worker && worker.tokenConfigured ? 'ok' : 'idle'}`} aria-hidden="true" />
                      {t('studio.compute.worker.token')}
                    </span>
                    <span className="ofs-sr-only"> · </span>
                    <span className="ofs-health-val">
                      {worker && worker.tokenConfigured ? t('studio.compute.worker.tokenSet') : t('studio.compute.worker.tokenMissing')}
                    </span>
                  </div>
                </div>
              ) : isColab ? (
                <div className="ofs-health-grid is-single">
                  <div className="ofs-health-card">
                    <span className="ofs-health-key">
                      <i className={`ofs-dot is-${probeToneOf(accountStatus)}`} aria-hidden="true" />
                      {t('studio.probe.account')}
                    </span>
                    <span className="ofs-sr-only"> · </span>
                    <span className="ofs-health-val-row">
                      <span className="ofs-health-val">
                        {accountStatus === 'ok'
                          ? (colabAuth && colabAuth.email ? colabAuth.email : t('studio.compute.colabAuthOk'))
                          : accountStatus === 'failed'
                            ? t('studio.compute.colabAuthMissing')
                            : statusText(accountStatus)}
                      </span>
                    </span>
                  </div>
                </div>
              ) : (
                <div className={`ofs-health-grid${probeInfo ? ' is-three' : ' is-single'}`}>
                  {probeInfo ? (
                    <>
                      <div className="ofs-health-card">
                        <span className="ofs-health-key">
                          <i className={`ofs-dot is-${probeToneOf(accessStatus)}`} aria-hidden="true" />
                          {t(accessMethodKey(kaggleTransport))}
                        </span>
                        <span className="ofs-sr-only"> · </span>
                        <span className="ofs-health-val">{t(accessStatusKey(kaggleTransport, accessStatus))}</span>
                      </div>
                      <div className="ofs-health-card">
                        <span className="ofs-health-key">
                          <i className={`ofs-dot is-${probeToneOf(probeInfo.quota)}`} aria-hidden="true" />
                          {t('studio.probe.quota')}
                        </span>
                        <span className="ofs-sr-only"> · </span>
                        <span className="ofs-health-val">{statusText(probeInfo.quota)}</span>
                      </div>
                    </>
                  ) : null}
                  {/* 手机号绑定警告在任何状态下都要能查到，所以账号行常驻；状态由探测与会话结果共同判定。 */}
                  <div className="ofs-health-card">
                    <span className="ofs-health-key">
                      <i className={`ofs-dot is-${probeToneOf(accountStatus)}`} aria-hidden="true" />
                      {t('studio.probe.account')}
                    </span>
                    <span className="ofs-sr-only"> · </span>
                    <span className="ofs-health-val-row">
                      <span className="ofs-health-val">{statusText(accountStatus)}</span>
                      <Tooltip text={t('studio.compute.authTooltip')} tone="warn" side="bottom" />
                    </span>
                  </div>
                </div>
              )}

              {!isWorker && !isCloudApi && probing ? <span className="ofs-health-msg">{t('action.probing')}</span> : null}
              {!isWorker && !isCloudApi && probeFailed ? (
                <span className="ofs-health-msg is-error" title={probeFailed.message || undefined}>
                  {probeFailed.status === 'timeout' ? t('studio.probe.timeout') : t('studio.probe.failed')}
                  {probeFailed.message ? ` · ${probeFailed.message}` : ''}
                </span>
              ) : null}
              {!isWorker && !isCloudApi && probeNote ? <span className="ofs-health-msg" title={probeInfo ? probeInfo.notes.join(' · ') : probeNote}>{probeNote}</span> : null}
              {isWorker && !worker && (
                <span className="ofs-health-msg">{t('studio.compute.worker.configureHint')}</span>
              )}
            </div>

            {/* 配额不可读时改看本地统计：最近一次成功检查、当时配额与本次会话运行时长。 */}
            {quotaUnavailable ? (
              <div className="ofs-popover-fallback">
                <span className="ofs-popover-fallback-title">{t('studio.compute.quotaFallback')}</span>
                {lastCheckTime ? (
                  <span>
                    {t('studio.compute.lastGood')} {lastCheckTime} · {t('studio.compute.quota')} {lastGoodQuota}
                  </span>
                ) : (
                  <span>{t('studio.compute.neverChecked')}</span>
                )}
                {sessionRunMs !== null ? (
                  <span>{t('studio.compute.sessionRan')} {formatDuration(t, sessionRunMs)}</span>
                ) : null}
                <a
                  className="ofs-popover-link"
                  href={KAGGLE_ACCOUNT_URL}
                  target="_blank"
                  rel="noreferrer"
                  role="menuitem"
                >
                  {t('studio.compute.kaggleSettings')}
                </a>
              </div>
            ) : null}

            {!isCloudApi ? (
              <div className="ofs-popover-btn-grid">
                <button
                  type="button"
                  role="menuitem"
                  className="ofs-popover-row ofs-popover-action is-primary"
                  onClick={startSession}
                  disabled={!!busy || !status.canStart}
                >
                  <Icon name="cloud" size={14} />
                  {providerText(t, 'studio.compute.start', sessionProviderId)}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ofs-popover-row ofs-popover-action"
                  onClick={stopSession}
                  disabled={!!busy || !status.canStop}
                >
                  <Icon name="clock" size={14} />
                  {providerText(t, 'studio.compute.stop', sessionProviderId)}
                </button>
              </div>
            ) : null}
            {!isWorker && !isCloudApi ? (
              <button
                type="button"
                role="menuitem"
                className="ofs-popover-row"
                onClick={runProbe}
                disabled={!!busy || probing}
                aria-busy={probing}
              >
                <Icon name="refresh" size={15} className={probing ? 'ofs-spin' : ''} />
                {probing ? t('action.probing') : t('studio.compute.check')}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="ofs-popover-row"
              onClick={() => {
                setOpen(false)
                // 菜单收起后这一行会卸载，焦点交还给常驻的算力按钮（与日志入口同一约定）。
                if (openLogs) openLogs(pillRef.current)
              }}
            >
              <Icon name="message" size={15} />
              {t('studio.logs.open')}
            </button>
            {/* 运行设置：在弹层底部、紧挨日志入口，避免为它单独占一个顶栏图标位。 */}
            <button
              type="button"
              role="menuitem"
              className="ofs-popover-row"
              onClick={() => {
                setOpen(false)
                if (openSettings) openSettings(pillRef.current, isWorker ? 'compute' : undefined)
              }}
            >
              <Icon name="sliders" size={15} />
              {t('studio.settings.open')}
            </button>
          </div>
        ) : null}
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