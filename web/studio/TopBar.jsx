/** 工作台顶栏：品牌、视图切换、云端状态与配额、模型预设。 */

import React from 'react'

import { Tooltip } from '../components/Tooltip.jsx'
import { useNow } from '../hooks/useNow.js'
import { usePresence } from './hooks/usePresence.js'
import { useSlidingThumb } from './hooks/useSlidingThumb.js'
import { fetchWorkspace, switchWorkspace } from '../api/resources.js'
import { formatDuration, formatSeconds, formatText } from '../logic/format.js'
import { elapsedMsSince, formatClockTime, quotaText } from '../logic/logs.js'
import { computeStatusOf, idleShutdownOf } from '../logic/status.js'
import { normalizeWorkspaceView, workspaceLabelOf, workspaceViewOf } from '../logic/workspace.js'
import { desktop } from '../runtime.js'
import { Icon } from './icons.jsx'
import { ModelCardPicker } from './ModelCardPicker.jsx'
import { StudioIcon } from './StudioIcon.jsx'
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
    update,
    startSession,
    stopSession,
    runProbe,
    openFolder,
  } = compute
  // 云端状态只走 computeStatusOf：顶栏胶囊与状态条、弹层共用同一份标签与提示。
  const status = compute.status || computeStatusOf(t, { session })
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
  // Colab 没有每周配额，改用 CCU 余额/速率（provider 保活时刷新）。
  const providerUsage = session && session.provider === 'colab' ? session.providerUsage : null
  const quotaUsed = quota && Number.isFinite(quota.usedHours) ? quota.usedHours : null
  const quotaTotal = quota && Number.isFinite(quota.totalHours) ? quota.totalHours : null
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
  const probePayload = probe || (snapshot && snapshot.probe) || (probeReport && probeReport.probe) || null
  const probeInfo = probeStatusOf(probePayload)
  // 账号状态不只看探测：会话能启动、能出图同样证明凭据有效；从未探测时显示「未检查」，
  // 不能默认成「不可用」（可出图却提示账号不可用属于误报）。
  const accountStatus = accountStatusOf(probePayload, sessionState)
  const probeFailed = probeReport && probeReport.status && probeReport.status !== 'ok' ? probeReport : null
  const probeNote = probeInfo && probeInfo.notes.length > 0 ? probeInfo.notes[0] : ''
  // 配额不可读（接口不可用或本次检测失败）时改用本地统计回退展示。
  const quotaUnavailable = Boolean(probeFailed || (probeInfo && probeInfo.quota !== 'ok'))
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
          <Icon name="folder" size={16} />
        </button>
      ) : null}

      {library.loadHistory ? (
        <button type="button" className="ofs-icon-btn" onClick={library.loadHistory} title={t('studio.refresh')} aria-label={t('studio.refresh')}>
          <Icon name="refresh" size={16} />
        </button>
      ) : null}

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
              if (next) setModelOpen(false)
              return next
            })
          }}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <i className={`ofs-dot is-${status.tone}${status.tone === 'ok' || status.tone === 'warn' ? ' is-live' : ''}`} aria-hidden="true" />
          <span>{status.label}</span>
          {quotaUsed !== null && quotaTotal !== null ? (
            <em>
              {quotaUsed} / {quotaTotal} {t('unit.hour')}
            </em>
          ) : null}
          {providerUsage && Number.isFinite(providerUsage.balance) ? (
            <em>
              {formatText(t('studio.compute.ccu'), { balance: providerUsage.balance.toFixed(1) })}
            </em>
          ) : null}
          {/* 插件自身有新版本：只在胶囊上点一个红点，详情在弹层里（不打断出图）。 */}
          {update ? (
            <span
              className="ofs-update-dot"
              role="img"
              aria-label={t('studio.update.badge')}
              title={formatText(t('studio.update.available'), { latest: update.latest, current: update.current })}
            />
          ) : null}
          <span className="ofs-pill-caret" aria-hidden="true">
            <Icon name="chevronDown" size={13} />
          </span>
        </button>

        {computePopoverPresence.mounted ? (
          <div
            className="ofs-popover"
            data-exiting={computePopoverPresence.exiting ? 'true' : undefined}
            role="menu"
          >
            <div className="ofs-popover-head">
              <span>
                <i className={`ofs-dot is-${status.tone}${status.tone === 'ok' || status.tone === 'warn' ? ' is-live' : ''}`} aria-hidden="true" />
                <b>{status.label}</b>
                <Tooltip text={status.tooltip} side="bottom" />
              </span>
              <span className="ofs-muted">
                {t('studio.compute.quota')} {quotaUsed !== null && quotaTotal !== null ? `${quotaUsed} / ${quotaTotal} ${t('unit.hour')}` : '—'}
              </span>
              {status.phaseLabel ? <span className="ofs-muted">{t('studio.compute.phase')} · {status.phaseLabel}</span> : null}
              {status.ready && steadySeconds !== null ? (
                <span className="ofs-muted">{t('studio.compute.speedLine')} {formatSeconds(t, steadySeconds)}</span>
              ) : null}
              {idleShutdown ? (
                <span className="ofs-muted">
                  {formatText(t('studio.compute.idleCountdown'), {
                    idle: idleShutdown.idleMinutes,
                    total: idleShutdown.totalMinutes,
                  })}
                </span>
              ) : idleMinutes > 0 ? (
                <span className="ofs-muted">{t('studio.compute.idleFor')} {idleMinutes} {t('unit.min')}</span>
              ) : null}
              {session && session.device ? <span className="ofs-muted">{session.device}</span> : null}
              {tunnelLabel ? <span className="ofs-muted">{t('studio.compute.tunnel')} · {tunnelLabel}</span> : null}
            </div>

            {/* 当前阶段的一句话说明：排队/连接/预热分别是不同的等待原因，不能混用同一条提示。 */}
            {status.hint ? <p className="ofs-popover-hint">{status.hint}</p> : null}

            {/* 客户端版本：服务端只读 Releases 并缓存在本地，这里只提示与给说明链接。 */}
            {update ? (
              <div className="ofs-popover-fallback ofs-popover-update">
                <span className="ofs-popover-fallback-title">
                  {formatText(t('studio.update.available'), { latest: update.latest, current: update.current })}
                </span>
                <span>{t('studio.update.hint')}</span>
                {update.releaseUrl ? (
                  <a
                    className="ofs-popover-link"
                    href={update.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    role="menuitem"
                  >
                    {t('studio.update.notes')}
                  </a>
                ) : null}
              </div>
            ) : null}

            <div className="ofs-popover-note">
              {probing ? <span>{t('action.probing')}</span> : null}
              {probeInfo ? (
                <>
                  <span>
                    {t(accessMethodKey(kaggleTransport))} · {t(accessStatusKey(kaggleTransport, accessStatusOf(probeInfo, kaggleTransport)))}
                  </span>
                  <span>{t('studio.probe.quota')} · {statusText(probeInfo.quota)}</span>
                </>
              ) : null}
              {/* 手机号绑定警告在任何状态下都要能查到，所以账号行常驻；状态由探测与会话结果共同判定。 */}
              <span>
                {t('studio.probe.account')} · {statusText(accountStatus)}
                <Tooltip text={t('studio.compute.authTooltip')} tone="warn" side="bottom" />
              </span>
              {probeFailed ? (
                <span title={probeFailed.message || undefined}>
                  {probeFailed.status === 'timeout' ? t('studio.probe.timeout') : t('studio.probe.failed')}
                  {probeFailed.message ? ` · ${probeFailed.message}` : ''}
                </span>
              ) : null}
              {probeNote ? <span title={probeInfo.notes.join(' · ')}>{probeNote}</span> : null}
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

            <button type="button" role="menuitem" className="ofs-popover-row" onClick={startSession} disabled={!!busy || !status.canStart}>
              <Icon name="cloud" size={15} />
              {t('studio.compute.start')}
            </button>
            <button type="button" role="menuitem" className="ofs-popover-row" onClick={stopSession} disabled={!!busy || !status.canStop}>
              <Icon name="clock" size={15} />
              {t('studio.compute.stop')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="ofs-popover-row"
              onClick={runProbe}
              disabled={!!busy || probing}
              aria-busy={probing}
            >
              <Icon name="refresh" size={15} />
              {probing ? t('action.probing') : t('studio.compute.check')}
            </button>
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
                if (openSettings) openSettings(pillRef.current)
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
        open={modelOpen}
        onOpenChange={(next) => {
          setModelOpen(next)
          if (next) setOpen(false)
        }}
        onChange={(next) => {
          // 切换预设统一走表单域的 selectPreset：参数与负向提示词跟随规则在一处维护。
          if (selectPreset) selectPreset(next)
          else patchForm({ presetId: next.id })
          setModelOpen(false)
        }}
      />

      {/* 顶栏兼作标题栏：右端是自绘的最小化 / 最大化 / 关闭（浏览器态不渲染）。 */}
      <WindowControls t={t} />
    </header>
  )
}