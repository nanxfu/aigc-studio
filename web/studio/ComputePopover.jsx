/**
 * 顶栏云端状态弹层（.ofs-compute-popover）。
 *
 * 四段，从上到下只回答四个问题：现在是什么状态、额度还剩多少、环境检查过没过、能做什么。
 * 所有读数都来自宿主快照；读不到就写读不到，不拿占位数字凑版面。
 * 从 TopBar 拆出：顶栏只留触发胶囊，弹层自己的取数、节流刷新与呈现都在这里。
 */

import React from 'react'

import { Tooltip } from '../components/Tooltip.jsx'
import { useNow } from '../hooks/useNow.js'
import { formatDuration, formatSeconds, formatText } from '../logic/format.js'
import { KAGGLE_ACCOUNT_URL } from '../logic/guidance.js'
import { elapsedMsSince, formatClockTime, quotaText } from '../logic/logs.js'
import { accountStatusOf, accessMethodKey, accessStatusKey, accessStatusOf, probeStatusOf } from '../logic/probe.js'
import { idleShutdownOf, providerLabelOf, providerText } from '../logic/status.js'
import { Icon } from './icons.jsx'
import { ProviderIcon } from './settings/providerIcons.jsx'
import { usePresence } from './hooks/usePresence.js'
import { useHostSnapshot } from './hooks/useStudioLogs.js'

const RING_RADIUS = 24
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
/** 额度静默刷新的节流窗口：弹层反复开合不重复打远端。 */
const REFRESH_STALE_MS = 120_000

const cloudVendorName = (t, id) => t(`studio.settings.cloudApi.vendorName.${id}`)

export function ComputePopover(props) {
  const { t, open, status, providerId, sessionState, session, quota, presets, form, probe, probeReport, compute, probing, busy } = props
  const presence = usePresence(open, 150)
  const snapshot = useHostSnapshot(open)
  const now = useNow(open)

  const isCloudApi = providerId === 'cloud-api'
  const isLocalGpu = providerId === 'local-gpu'
  const isRemoteWorker = providerId === 'private-worker'
  const isWorkerLike = isRemoteWorker || isLocalGpu
  const isColab = providerId === 'colab'
  const hasProviderBadge = providerId === 'kaggle' || isColab || isWorkerLike || isCloudApi
  // 弹层标题用完整来源名，不背胶囊里为省宽度加的（GPU 型号）后缀——型号在下面的读数行里。
  const providerName = providerLabelOf(t, providerId)
  const statusTitle = providerName ? `${providerName} · ${status.label}` : status.label

  const localGpu = (compute && compute.localGpu) || (snapshot && snapshot.localGpu) || null
  const hardware = (compute && compute.hardware) || (snapshot && snapshot.hardware) || null
  const worker = (compute && compute.worker) || (snapshot && snapshot.privateWorker) || null
  const workerEndpointHost = (() => {
    try {
      return worker && worker.endpointUrl ? new URL(worker.endpointUrl).host : ''
    } catch {
      return ''
    }
  })()

  // ── 额度 ────────────────────────────────────────────────────
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
  const quotaUsed = !isColab && !isWorkerLike && quota && Number.isFinite(quota.usedHours) ? quota.usedHours : null
  const quotaTotal = !isColab && !isWorkerLike && quota && Number.isFinite(quota.totalHours) ? quota.totalHours : null
  const hasKaggleQuota = !isColab && quotaUsed !== null && quotaTotal !== null && quotaTotal > 0
  const kaggleRemainingHours = hasKaggleQuota ? Math.max(0, quotaTotal - quotaUsed) : null
  const kaggleRemainingRatio = hasKaggleQuota ? Math.min(1, Math.max(0, kaggleRemainingHours / quotaTotal)) : null
  const hasColabUsage = isColab && colabUsage && Number.isFinite(colabUsage.balance)
  const colabBalance = hasColabUsage ? colabUsage.balance : null
  const colabRate = hasColabUsage && Number.isFinite(colabUsage.rate) && colabUsage.rate > 0 ? colabUsage.rate : null
  const colabEstimateHours = colabBalance !== null && colabRate !== null ? colabBalance / colabRate : null
  // 环形仪表只用在真有分母的地方（Kaggle 每周额度）；Colab 的 CCU 没有总量，用读数位。
  const ringRatio = hasKaggleQuota ? kaggleRemainingRatio : null
  const ringTone = hasKaggleQuota
    ? (kaggleRemainingRatio <= 0.04 ? 'error' : kaggleRemainingRatio <= 0.15 ? 'warn' : 'normal')
    : 'empty'
  const ringDashOffset = ringRatio !== null ? RING_CIRCUMFERENCE * (1 - ringRatio) : 0
  // Colab 没有总量可画，余额偏低时只把数字染色（语义色仍只占一小块）。
  const colabTone = hasColabUsage && colabBalance < 3 ? 'is-error' : hasColabUsage && colabBalance < 15 ? 'is-warn' : ''

  // ── 环境检查 ────────────────────────────────────────────────
  const probePayload = probe
    || (snapshot && snapshot.probe)
    || (probeReport && probeReport.probe && probeReport.probe.provider !== 'colab' ? probeReport.probe : null)
    || null
  const probeInfo = !isColab && !isWorkerLike && !isCloudApi ? probeStatusOf(probePayload) : null
  const accountStatus = isWorkerLike
    ? (sessionState === 'ready' ? 'ok' : 'unknown')
    : isColab
      ? ((colabAuth && colabAuth.authorized === true) || (colabProbe && colabProbe.auth && colabProbe.auth.ok === true) || sessionState === 'ready'
        ? 'ok'
        : (colabProbe && colabProbe.auth && colabProbe.auth.ok === false) || (colabAuth && colabAuth.authorized === false)
          ? 'failed'
          : 'unknown')
      : accountStatusOf(probePayload, sessionState)
  const kaggleTransport = compute && compute.kaggleTransport === 'direct' ? 'direct' : 'cli'
  const accessStatus = probeInfo ? accessStatusOf(probeInfo, kaggleTransport) : ''
  const probeToneOf = (value) => {
    if (value === 'ok' || value === 'directOk') return 'ok'
    if (value === 'failed' || value === 'directLoginRequired') return 'error'
    return 'idle'
  }
  const probeFailed = probeReport && probeReport.status && probeReport.status !== 'ok' ? probeReport : null
  const quotaUnavailable = !isColab && !isWorkerLike && !isCloudApi && Boolean(probeFailed || (probeInfo && probeInfo.quota !== 'ok'))
  const lastGood = (snapshot && snapshot.probeLastGood) || null
  const lastCheckTime = formatClockTime(snapshot && snapshot.probeLastGoodAt)
  const lastGoodQuota = quotaText(lastGood && lastGood.quota)
  const sessionRunMs = session ? elapsedMsSince(session.startedAt, now) : null
  const statusText = (value) => {
    if (value === 'ok') return t('value.ok')
    if (value === 'failed') return t('value.failed')
    if (value === 'unavailable') return t('value.quotaUnavailable')
    return t('value.unknown')
  }
  const canCheck = !isWorkerLike && !isCloudApi

  // ── 状态行与读数 ────────────────────────────────────────────
  const loadedPreset = (Array.isArray(presets) ? presets : []).find((item) => item.id === (session && session.presetId))
    || (Array.isArray(presets) ? presets : []).find((item) => item.id === form.presetId)
    || null
  const steadyRaw = loadedPreset && loadedPreset.steadySeconds !== undefined
    ? loadedPreset.steadySeconds
    : loadedPreset && loadedPreset.measured ? loadedPreset.measured.steadySeconds : null
  const steadySeconds = Number.isFinite(steadyRaw) ? steadyRaw : null
  // 会话真的存在时才谈「闲置关机」：未启动的实例没有可关的东西，写出来只会误导。
  const hasLiveSession = Boolean(session && typeof session.state === 'string' && session.state !== 'absent')
  const idleShutdown = idleShutdownOf(session)
  const idleMinutes = hasLiveSession && session.idleTimeoutSec ? Math.round(session.idleTimeoutSec / 60) : 0
  const idleRatio = idleShutdown && idleShutdown.totalMinutes > 0
    ? Math.min(1, Math.max(0, idleShutdown.idleMinutes / idleShutdown.totalMinutes))
    : null
  const idlePercent = idleRatio !== null ? Math.round(idleRatio * 100) : null
  const idleTone = idleRatio !== null ? (idleRatio >= 0.9 ? 'error' : idleRatio >= 0.7 ? 'warn' : 'normal') : 'normal'
  const tunnelProvider = session && session.tunnelProvider ? session.tunnelProvider : ''
  const tunnelLabel = tunnelProvider === 'cloudflare'
    ? t('studio.compute.tunnel.cloudflare')
    : tunnelProvider === 'custom'
      ? t('studio.compute.tunnel.custom')
      : ''
  // 一行读数：设备 · 实测速度 · 闲置关机阈值（已有倒计时时让位给下方的进度条）。
  const metaParts = []
  if (!isCloudApi) {
    // 私有 Worker / 本机 GPU 的型号是主读数，这里不重复。
    if (!isWorkerLike && session && session.device) metaParts.push(session.device)
    if (status.ready && steadySeconds !== null) metaParts.push(`${formatSeconds(t, steadySeconds)}/${t('studio.compute.cloudApi.perImageUnit')}`)
    if (tunnelLabel) metaParts.push(`${t('studio.compute.tunnel')} ${tunnelLabel}`)
    if (!idleShutdown && idleMinutes > 0) metaParts.push(formatText(t('studio.compute.idleMeta'), { minutes: idleMinutes }))
  }

  // 打开即静默刷一次额度（2 分钟节流，失败不弹错）。
  const refreshedRef = React.useRef(false)
  React.useEffect(() => {
    if (!open) {
      refreshedRef.current = false
      return
    }
    if (refreshedRef.current) return
    refreshedRef.current = true
    if (isWorkerLike || isCloudApi || probing || !compute || typeof compute.silentProbe !== 'function') return
    const currentNow = Date.now()
    if (isColab) {
      if (!colabAuth || colabAuth.authorized !== true) return
      const lastAt = Number(compute.colabUsageAt || (snapshot && snapshot.colabUsageAt) || 0)
      if (!hasColabUsage || currentNow - lastAt > REFRESH_STALE_MS) compute.silentProbe()
      return
    }
    const lastAt = Number(compute.probeAt || (snapshot && snapshot.probeAt) || 0)
    if (!hasKaggleQuota || currentNow - lastAt > REFRESH_STALE_MS) compute.silentProbe()
  }, [open])

  if (!presence.mounted) return null

  // 环境检查区：全部通过时收成一行结论，只有出问题的那几项才单独占行。
  let checkRows = []
  let checkMessages = []
  if (isCloudApi) {
    const configured = compute && compute.imageApi && Array.isArray(compute.imageApi.apiKeysConfigured)
      ? compute.imageApi.apiKeysConfigured
      : []
    const hasCloudKey = Boolean((compute && compute.imageApi && compute.imageApi.hasApiKey) || configured.length > 0)
    checkRows = [{
      tone: hasCloudKey ? 'ok' : 'idle',
      key: t('studio.compute.cloudApi.vendorsLabel'),
      val: configured.length > 0
        ? configured.map((id) => cloudVendorName(t, id)).join(' / ')
        : t('studio.compute.cloudApi.missingKey'),
    }]
  } else if (isLocalGpu) {
    const serverReady = Boolean(localGpu && localGpu.serverPath)
    const modelReady = Boolean(localGpu && localGpu.modelPath)
    const vramGb = hardware?.evaluation?.profile?.vramGb
    checkRows = [
      {
        tone: serverReady && localGpu?.ok ? 'ok' : 'idle',
        key: t('studio.compute.localGpu.serverLabel'),
        val: serverReady ? t('studio.compute.localGpu.ready') : t('studio.compute.localGpu.missing'),
        title: localGpu?.serverPath || undefined,
      },
      {
        tone: modelReady && localGpu?.ok ? 'ok' : 'idle',
        key: t('studio.compute.localGpu.modelLabel'),
        val: (localGpu && localGpu.modelName) || t('studio.compute.localGpu.missing'),
        title: localGpu?.modelPath || undefined,
      },
    ]
    if (Number.isFinite(Number(vramGb)) && Number(vramGb) > 0) {
      checkRows.push({
        tone: 'ok',
        key: t('studio.compute.localGpu.vramBudget'),
        val: `${vramGb} GB · ${hardware.evaluation.profile.backend || 'Vulkan'}`,
      })
    }
    if (!localGpu || !localGpu.ok) {
      checkMessages = [{
        tone: 'idle',
        text: (localGpu?.errors && localGpu.errors[0]) || t('studio.compute.localGpu.configureHint'),
      }]
    }
  } else if (isRemoteWorker) {
    checkRows = [
      {
        tone: status.tone === 'ok' ? 'ok' : 'idle',
        key: t('studio.compute.worker.endpoint'),
        val: workerEndpointHost || t('studio.compute.worker.unconfigured'),
        title: worker && worker.endpointUrl ? worker.endpointUrl : undefined,
      },
      {
        tone: worker && worker.tokenConfigured ? 'ok' : 'idle',
        key: t('studio.compute.worker.token'),
        val: worker && worker.tokenConfigured ? t('studio.compute.worker.tokenSet') : t('studio.compute.worker.tokenMissing'),
      },
    ]
    if (!worker) checkMessages = [{ tone: 'idle', text: t('studio.compute.worker.configureHint') }]
  } else if (isColab) {
    const email = (colabAuth && colabAuth.email) || ''
    const authorized = accountStatus === 'ok'
    checkRows = [{
      tone: probeToneOf(accountStatus),
      // 邮箱就是账号本身：授权成功时省掉「账号」两个字，把整行宽度留给地址（否则长邮箱会被截断）。
      key: authorized ? '' : t('studio.probe.account'),
      val: authorized
        ? (email || t('studio.compute.colabAuthOk'))
        : accountStatus === 'failed'
          ? t('studio.compute.colabAuthMissing')
          : statusText(accountStatus),
    }]
  } else {
    const probeNote = probeInfo && probeInfo.notes.length > 0 ? probeInfo.notes[0] : ''
    const allOk = Boolean(probeInfo) && accessStatus === 'ok' && accountStatus === 'ok' && probeInfo.quota === 'ok'
    if (allOk) {
      // 通过时只留结论：CLI 版本之类的来历放进 title，不占这一行。
      checkRows = [{ tone: 'ok', summary: true, key: t('studio.probe.ok'), title: probeInfo.notes.join(' · ') || undefined }]
    } else {
      if (probeInfo && accessStatus !== 'ok') {
        checkRows.push({
          tone: probeToneOf(accessStatus),
          key: t(accessMethodKey(kaggleTransport)),
          val: t(accessStatusKey(kaggleTransport, accessStatus)),
        })
      }
      if (probeInfo && probeInfo.quota !== 'ok' && !quotaUnavailable) {
        checkRows.push({ tone: probeToneOf(probeInfo.quota), key: t('studio.probe.quota'), val: statusText(probeInfo.quota) })
      }
      if (!probeInfo || accountStatus !== 'ok') {
        checkRows.push({
          tone: probeToneOf(accountStatus),
          key: t('studio.probe.account'),
          val: statusText(accountStatus),
          caveat: true,
        })
      }
    }
    // 检查进行中由那一行右侧的按钮转圈说明，不再补一句同义文案。
    if (!probing) {
      if (probeFailed) {
        checkMessages = [{
          tone: 'error',
          text: `${probeFailed.status === 'timeout' ? t('studio.probe.timeout') : t('studio.probe.failed')}${probeFailed.message ? ` · ${probeFailed.message}` : ''}`,
          title: probeFailed.message || undefined,
        }]
      } else if (!allOk && probeNote) {
        checkMessages = [{ tone: 'idle', text: probeNote, title: probeInfo ? probeInfo.notes.join(' · ') : probeNote }]
      }
    }
  }

  // 额度面板：Kaggle 是环形仪表，其余来源用 56px 数字砖块（没有总量可画成分数）。
  const cloudApiPanel = (() => {
    const activePreset = (Array.isArray(presets) ? presets : []).find((item) => item.id === form.presetId) || null
    const unitCost = activePreset && activePreset.cloud ? Number(activePreset.cloud.estCostPerImage) : NaN
    const hasCost = Number.isFinite(unitCost) && unitCost > 0
    const count = Math.max(1, Math.round(Number(form.count) || 1))
    const unitStr = hasCost ? unitCost.toFixed(unitCost < 0.01 ? 3 : 2) : ''
    const batch = unitCost * count
    const batchStr = hasCost ? batch.toFixed(batch < 0.01 ? 3 : 2) : ''
    const hasKey = Boolean(
      (compute && compute.imageApi && compute.imageApi.hasApiKey)
      || (compute && compute.imageApi && Array.isArray(compute.imageApi.apiKeysConfigured) && compute.imageApi.apiKeysConfigured.length > 0),
    )
    return {
      tile: <ProviderIcon id="cloud-api" size={20} />,
      title: t('studio.compute.cloudApi.billingTitle'),
      primary: hasCost
        ? (count > 1
            ? formatText(t('studio.compute.cloudApi.billingBatch'), { unit: unitStr, count, total: batchStr })
            : formatText(t('studio.compute.cloudApi.billingUnit'), { cost: unitStr }))
        : (hasKey ? t('studio.compute.cloudApi.billingDynamic') : t('studio.compute.cloudApi.missingKey')),
      // 没有单价时上面那行已经把话说完了，不再补一句同义说明。
      sub: hasCost ? t('studio.compute.cloudApi.noQuota') : '',
    }
  })()

  // 额度面板：每个来源只讲它真有的那个数，缺哪一段就少一行，不再用兜底文案去填。
  const quotaPanel = (() => {
    if (isCloudApi) return cloudApiPanel
    if (isLocalGpu) {
      const hwProfile = hardware?.evaluation?.profile
      return {
        tile: <ProviderIcon id="local-gpu" size={20} />,
        title: t('studio.compute.localGpu.title'),
        primary: (session && session.device) || hwProfile?.shortName || t('studio.compute.localGpu.backendVulkan'),
        sub: (localGpu && localGpu.modelName) || t('studio.compute.localGpu.backendVulkan'),
      }
    }
    if (isRemoteWorker) {
      return {
        tile: <Icon name="cube" size={20} />,
        title: t('studio.compute.worker.title'),
        primary: (session && session.device) || t('studio.compute.worker.notConnected'),
        sub: '',
      }
    }
    // 环形仪表只给真有分母的 Kaggle 额度；Colab 的 CCU 是余额，用数字位。
    const base = {
      ring: !isColab,
      title: isColab ? t('studio.compute.quotaTitle.colab') : t('studio.compute.quotaTitle.kaggle'),
    }
    if (hasKaggleQuota) {
      // 环上讲剩余，文字讲已用 / 总量。
      return { ...base, primary: formatText(t('studio.compute.quotaUsedLine'), { used: quotaUsed, total: quotaTotal }), sub: '' }
    }
    if (isColab) {
      // 余额读到了就是读到了：耗速 / 可用时长各自独立，缺一个不影响另一个。
      if (!hasColabUsage) {
        return { ...base, primary: '', sub: probing ? t('studio.compute.quotaLoading') : t('studio.compute.quotaEmpty') }
      }
      return {
        ...base,
        primary: colabRate !== null ? formatText(t('studio.compute.ccuRate'), { rate: colabRate.toFixed(2) }) : '',
        sub: colabEstimateHours !== null ? formatText(t('studio.compute.ccuEstimate'), { hours: colabEstimateHours.toFixed(1) }) : '',
      }
    }
    // Kaggle 没读到额度：回退块会把话说清，这里不再补一句同义的占位。
    return { ...base, primary: '', sub: quotaUnavailable ? '' : (probing ? t('studio.compute.quotaLoading') : t('studio.compute.quotaEmpty')) }
  })()

  const actionKind = status.canStart ? 'start' : 'stop'
  const actionDisabled = Boolean(busy) || (actionKind === 'start' ? !status.canStart : !status.canStop)

  return (
    <div
      className="ofs-popover ofs-compute-popover"
      data-exiting={presence.exiting ? 'true' : undefined}
      role="menu"
    >
      {/* 1. 现在是什么状态 */}
      <div className="ofs-popover-head ofs-compute-head">
        <span className="ofs-compute-head-status">
          <i className={`ofs-dot is-${status.tone}${status.tone === 'ok' || status.tone === 'warn' ? ' is-live' : ''}`} aria-hidden="true" />
          {hasProviderBadge ? (
            <ProviderIcon id={providerId} size={14} className="ofs-compute-provider" />
          ) : null}
          <b>{statusTitle}</b>
          <Tooltip text={status.tooltip} side="bottom" />
        </span>
        {metaParts.length > 0 ? (
          <p className="ofs-compute-meta" title={metaParts.join(' · ')}>{metaParts.join(' · ')}</p>
        ) : null}
        {/* 就绪态不必再解释「可以生成」；只有排队 / 连接 / 出错才需要一句原因。 */}
        {!status.ready && status.hint ? <p className="ofs-compute-hint">{status.hint}</p> : null}
      </div>

      {/* 2. 额度还能用多久 */}
      <div className="ofs-compute-meters">
        {quotaUnavailable ? null : (
          <div className="ofs-quota-panel">
            {quotaPanel.ring ? (
              <div className={`ofs-quota-ring is-${ringTone}`} aria-hidden="true">
                <svg className="ofs-quota-ring-svg" width="56" height="56" viewBox="0 0 60 60">
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
                      <strong>{Number.isInteger(kaggleRemainingHours) ? kaggleRemainingHours : kaggleRemainingHours.toFixed(1)}h</strong>
                      <span>{t('studio.compute.remaining')}</span>
                    </>
                  ) : (
                    <strong>—</strong>
                  )}
                </div>
              </div>
            ) : (
              <div className={`ofs-quota-slot${isColab && colabTone ? ` ${colabTone}` : ''}`} aria-hidden="true">
                {isColab
                  ? (hasColabUsage ? (<><strong>{colabBalance.toFixed(1)}</strong><span>CCU</span></>) : <strong>—</strong>)
                  : quotaPanel.tile}
              </div>
            )}
            <div className="ofs-quota-meta">
              <span className="ofs-quota-title">{quotaPanel.title}</span>
              {quotaPanel.primary ? <strong className="ofs-quota-primary">{quotaPanel.primary}</strong> : null}
              {quotaPanel.sub ? <span className="ofs-quota-sub">{quotaPanel.sub}</span> : null}
            </div>
          </div>
        )}

        {quotaUnavailable ? (
          <div className="ofs-popover-fallback">
            <span className="ofs-popover-fallback-title">{t('studio.compute.quotaFallback')}</span>
            <span>
              {lastCheckTime
                ? `${t('studio.compute.lastGood')} ${lastCheckTime} · ${t('studio.compute.quota')} ${lastGoodQuota}`
                : t('studio.compute.neverChecked')}
            </span>
            {sessionRunMs !== null ? (
              <span>{t('studio.compute.sessionRan')} {formatDuration(t, sessionRunMs)}</span>
            ) : null}
            <a className="ofs-popover-link" href={KAGGLE_ACCOUNT_URL} target="_blank" rel="noreferrer" role="menuitem">
              {t('studio.compute.kaggleSettings')}
            </a>
          </div>
        ) : null}

        {idleShutdown ? (
          <div className="ofs-compute-idle">
            <span className="ofs-muted">
              {formatText(t('studio.compute.idleCountdown'), { idle: idleShutdown.idleMinutes, total: idleShutdown.totalMinutes })}
            </span>
            <div className={`ofs-meter${idleTone !== 'normal' ? ` is-${idleTone}` : ''}`} aria-hidden="true">
              <div className="ofs-meter-fill" style={{ width: `${idlePercent}%` }} />
            </div>
          </div>
        ) : null}
      </div>

      {/* 3. 环境检查：通过就一行结论，没过只列没过的项 */}
      <div className="ofs-compute-check">
        {checkRows.map((row, index) => (
          <div
            className={`ofs-check-row${row.summary ? ' is-summary' : ''}`}
            key={`${row.key}-${index}`}
            title={row.summary ? row.title : undefined}
          >
            <span className="ofs-check-key">
              <i className={`ofs-dot is-${row.tone}`} aria-hidden="true" />
              {row.key}
            </span>
            {row.val ? (
              <>
                {row.key ? <span className="ofs-check-sep"> · </span> : null}
                <span className="ofs-check-val" title={row.title || row.val}>{row.val}</span>
              </>
            ) : null}
            {row.caveat ? <Tooltip text={t('studio.compute.authTooltip')} tone="warn" side="bottom" /> : null}
            {canCheck && index === 0 ? (
              <button
                type="button"
                role="menuitem"
                className="ofs-check-btn"
                onClick={props.onCheck}
                disabled={Boolean(busy) || probing}
                aria-busy={probing}
              >
                <Icon name="refresh" size={12} className={probing ? 'ofs-spin' : ''} />
                {probing ? t('action.probing') : t('studio.compute.check')}
              </button>
            ) : null}
          </div>
        ))}
        {checkMessages.map((message, index) => (
          <p
            className={`ofs-check-msg${message.tone === 'error' ? ' is-error' : ''}`}
            key={`msg-${index}`}
            title={message.title || undefined}
          >
            {message.text}
          </p>
        ))}
      </div>

      {/* 4. 能做什么：一个主动作 + 两个出口 */}
      <div className="ofs-compute-actions">
        {!isCloudApi ? (
          <button
            type="button"
            role="menuitem"
            className={`ofs-popover-row ofs-popover-action${actionKind === 'start' ? ' is-primary' : ''}`}
            onClick={actionKind === 'start' ? props.onStart : props.onStop}
            disabled={actionDisabled}
          >
            <Icon name={actionKind === 'start' ? 'cloud' : 'clock'} size={14} />
            {providerText(t, actionKind === 'start' ? 'studio.compute.start' : 'studio.compute.stop', providerId)}
          </button>
        ) : null}
        <button
          type="button"
          role="menuitem"
          className="ofs-popover-row"
          onClick={props.onOpenLogs}
        >
          <Icon name="message" size={15} />
          {t('studio.logs.open')}
        </button>
        <button
          type="button"
          role="menuitem"
          className="ofs-popover-row"
          onClick={props.onOpenSettings}
        >
          <Icon name="sliders" size={15} />
          {t('studio.settings.open')}
        </button>
      </div>
    </div>
  )
}
