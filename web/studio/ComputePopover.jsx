/**
 * 顶栏云端状态弹层（.ofs-compute-popover）。
 *
 * 状态、关键读数、环境检查与操作；读数直接呈现，不使用装饰仪表或嵌套卡片。
 * 所有读数都来自宿主快照；读不到就写读不到，不拿占位数字凑版面。
 * 从 TopBar 拆出：顶栏只留触发胶囊，弹层自己的取数、节流刷新与呈现都在这里。
 */

import React from 'react'

import { SETTINGS } from '../../shared/contract.js'
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

/** 额度静默刷新的节流窗口：弹层反复开合不重复打远端。 */
const REFRESH_STALE_MS = 120_000

const cloudVendorName = (t, id) => t(`studio.settings.cloudApi.vendorName.${id}`)

export function ComputePopover(props) {
  const {
    t,
    open,
    status,
    providerId,
    pendingSwitchFrom = '',
    configuredProviders = null,
    sessionState,
    session,
    quota,
    presets,
    form,
    probe,
    probeReport,
    compute,
    probing,
    busy,
    onSwitchProvider = null,
    onOpenModels = null,
  } = props
  const presence = usePresence(open, 150)
  const snapshot = useHostSnapshot(open)
  const now = useNow(open)
  const switchingRef = React.useRef(false)

  const activeProviderId = providerId || (compute && compute.provider) || SETTINGS.defaultProvider
  const isCloudApi = activeProviderId === 'cloud-api'
  const isLocalGpu = activeProviderId === 'local-gpu'
  const isRemoteWorker = activeProviderId === 'private-worker'
  const isSalad = activeProviderId === 'salad'
  const isWorkerLike = isRemoteWorker || isLocalGpu || isSalad
  const isColab = activeProviderId === 'colab'
  const hasProviderBadge = activeProviderId === 'kaggle' || isColab || isWorkerLike || isCloudApi
  // 弹层标题用完整来源名，不背胶囊里为省宽度加的（GPU 型号）后缀——型号在下面的读数行里。
  const providerName = providerLabelOf(t, activeProviderId)
  const statusTitle = providerName ? `${providerName} · ${status.label}` : status.label

  const localGpu = (compute && compute.localGpu) || (snapshot && snapshot.localGpu) || null
  const salad = (compute && compute.salad) || (snapshot && snapshot.salad) || null
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
  const quotaUsed = !isColab && !isWorkerLike && !isCloudApi && quota && Number.isFinite(quota.usedHours) ? quota.usedHours : null
  const quotaTotal = !isColab && !isWorkerLike && !isCloudApi && quota && Number.isFinite(quota.totalHours) ? quota.totalHours : null
  const hasKaggleQuota = !isColab && quotaUsed !== null && quotaTotal !== null && quotaTotal > 0
  const kaggleRemainingHours = hasKaggleQuota ? Math.max(0, quotaTotal - quotaUsed) : null
  const kaggleRemainingRatio = hasKaggleQuota ? Math.min(1, Math.max(0, kaggleRemainingHours / quotaTotal)) : null
  const hasColabUsage = isColab && colabUsage && Number.isFinite(colabUsage.balance)
  const colabBalance = hasColabUsage ? colabUsage.balance : null
  const colabRate = hasColabUsage && Number.isFinite(colabUsage.rate) && colabUsage.rate > 0 ? colabUsage.rate : null
  const colabEstimateHours = colabBalance !== null && colabRate !== null ? colabBalance / colabRate : null
  const quotaTone = hasKaggleQuota
    ? (kaggleRemainingRatio <= 0.04 ? 'error' : kaggleRemainingRatio <= 0.15 ? 'warn' : 'normal')
    : hasColabUsage && colabBalance < 3 ? 'error' : hasColabUsage && colabBalance < 15 ? 'warn' : 'normal'

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
  // 设备与速度只出现一次；本机性能不使用云端实测值。
  const metaParts = []
  if (!isCloudApi) {
    const device = (session && session.device) || (isLocalGpu && hardware?.evaluation?.profile?.shortName)
    if (device) metaParts.push(device)
    if (!isLocalGpu && status.ready && steadySeconds !== null) metaParts.push(`${formatSeconds(t, steadySeconds)}/${t('studio.compute.cloudApi.perImageUnit')}`)
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

  const configuredProviderSet = React.useMemo(() => {
    const raw = Array.isArray(configuredProviders)
      ? configuredProviders
      : (Array.isArray(compute?.configuredProviders) ? compute.configuredProviders : null)
    return raw ? new Set(raw) : null
  }, [configuredProviders, compute?.configuredProviders])

  const localEngineReady = Boolean(localGpu && (localGpu.engineReady === true || localGpu.ok === true))
  const downloadedPresetSet = React.useMemo(
    () => new Set(Array.isArray(localGpu?.configuredPresets) ? localGpu.configuredPresets : []),
    [localGpu?.configuredPresets],
  )
  const activePresetId = (session && session.presetId) || (form && form.presetId) || ''
  const activeLocalModelReady = Boolean(activePresetId && downloadedPresetSet.has(activePresetId))
  const hasCloudKey = Boolean(
    (compute && compute.imageApi && compute.imageApi.hasApiKey)
    || (compute && compute.imageApi && Array.isArray(compute.imageApi.apiKeysConfigured) && compute.imageApi.apiKeysConfigured.length > 0),
  )

  const isProviderConfigured = React.useCallback((id) => {
    if (id === 'kaggle') return configuredProviderSet ? configuredProviderSet.has('kaggle') : true
    if (id === 'colab') return Boolean((colabAuth && colabAuth.authorized === true) || configuredProviderSet?.has('colab'))
    if (id === 'cloud-api') return Boolean(hasCloudKey || configuredProviderSet?.has('cloud-api'))
    if (id === 'local-gpu') return Boolean(localEngineReady || configuredProviderSet?.has('local-gpu'))
    if (id === 'private-worker') return Boolean(worker?.endpointUrl || configuredProviderSet?.has('private-worker'))
    return Boolean(configuredProviderSet?.has(id))
  }, [configuredProviderSet, colabAuth, hasCloudKey, localEngineReady, worker])

  const switchProviderIds = React.useMemo(() => {
    const ids = SETTINGS.providers.filter((id) => isProviderConfigured(id))
    if (activeProviderId && !ids.includes(activeProviderId)) ids.unshift(activeProviderId)
    return ids
  }, [activeProviderId, isProviderConfigured])

  const unconfiguredProviderIds = React.useMemo(
    () => SETTINGS.providers.filter((id) => !switchProviderIds.includes(id)),
    [switchProviderIds],
  )

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
    const gpuName = hardware?.evaluation?.profile?.shortName || ''
    if (!localEngineReady) {
      checkMessages = [{
        tone: 'idle',
        text: t('studio.compute.localGpu.configureHint'),
      }]
    } else {
      checkRows = [{
        tone: 'ok',
        summary: true,
        key: '',
        val: gpuName || t('studio.compute.localGpu.engineReady'),
      }]
      if (activePresetId && !activeLocalModelReady) {
        checkMessages = [{
          tone: 'idle',
          text: t('studio.compute.localGpu.modelNotDownloaded'),
        }]
      }
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
  } else if (isSalad) {
    checkRows = [
      {
        tone: salad?.hasApiKey ? 'ok' : 'idle',
        key: t('studio.compute.salad.apiKey'),
        val: salad?.hasApiKey ? t('studio.compute.worker.tokenSet') : t('studio.compute.worker.tokenMissing'),
      },
      {
        tone: 'ok',
        key: t('studio.compute.salad.tier'),
        val: t(`studio.settings.salad.tier.${salad?.tier || 'medium'}`),
        title: salad?.org ? `${salad.org} / ${salad.project}` : undefined,
      },
    ]
    if (!salad?.org || !salad?.hasApiKey) {
      checkMessages = [{ tone: 'idle', text: t('studio.compute.salad.configureHint') }]
    }
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

  // 按来源呈现真实读数；不重复标题中的来源或已列出的设备与模型。
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
      title: t('studio.compute.cloudApi.billingTitle'),
      primary: hasCost
        ? (count > 1
            ? formatText(t('studio.compute.cloudApi.billingBatch'), { unit: unitStr, count, total: batchStr })
            : formatText(t('studio.compute.cloudApi.billingUnit'), { cost: unitStr }))
        : (hasKey ? t('studio.compute.cloudApi.billingDynamic') : t('studio.compute.cloudApi.missingKey')),
      // 没有单价时上面那行已经把话说完了，不再补一句同义说明。
      sub: '',
    }
  })()

  // 本机与私有 Worker 无额度读数，其配置只在检查区呈现。
  const quotaPanel = (() => {
    if (isCloudApi) return cloudApiPanel
    if (isWorkerLike) return null
    const base = {
      title: isColab ? t('studio.compute.quotaTitle.colab') : t('studio.compute.quotaTitle.kaggle'),
    }
    if (hasKaggleQuota) {
      const remaining = Number.isInteger(kaggleRemainingHours) ? kaggleRemainingHours : kaggleRemainingHours.toFixed(1)
      return {
        ...base,
        primary: formatText(t('studio.compute.quotaRemaining'), { hours: remaining }),
        sub: formatText(t('studio.compute.quotaUsedLine'), { used: quotaUsed, total: quotaTotal }),
      }
    }
    if (isColab) {
      // 余额读到了就是读到了：耗速 / 可用时长各自独立，缺一个不影响另一个。
      if (!hasColabUsage) {
        return { ...base, primary: '', sub: probing ? t('studio.compute.quotaLoading') : t('studio.compute.quotaEmpty') }
      }
      return {
        ...base,
        primary: `${colabBalance.toFixed(1)} CCU`,
        sub: [
          colabRate !== null ? formatText(t('studio.compute.ccuRate'), { rate: colabRate.toFixed(2) }) : '',
          colabEstimateHours !== null ? formatText(t('studio.compute.ccuEstimate'), { hours: colabEstimateHours.toFixed(1) }) : '',
        ].filter(Boolean).join(' · '),
      }
    }
    // Kaggle 没读到额度：回退块会把话说清，这里不再补一句同义的占位。
    return { ...base, primary: '', sub: quotaUnavailable ? '' : (probing ? t('studio.compute.quotaLoading') : t('studio.compute.quotaEmpty')) }
  })()

  async function handleSwitchProvider(nextId) {
    if (!nextId || nextId === activeProviderId || switchingRef.current || busy) return
    if (typeof onSwitchProvider !== 'function') return
    switchingRef.current = true
    try {
      await onSwitchProvider(nextId)
    } finally {
      switchingRef.current = false
    }
  }

  const needsSetupAction =
    (isLocalGpu && !localEngineReady)
    || (isRemoteWorker && !worker)
    || (isSalad && (!salad?.org || !salad?.hasApiKey))
    || (isCloudApi && !hasCloudKey)
  const setupActionLabel = isLocalGpu
    ? t('studio.compute.localGpu.openSettings')
    : isRemoteWorker
      ? t('studio.compute.worker.openSettings')
      : isSalad
        ? t('studio.compute.salad.openSettings')
        : t('studio.compute.cloudApi.openSettings')

  const actionKind = status.canStart ? 'start' : 'stop'
  const needsModelDownloadAction = Boolean(
    isLocalGpu
    && localEngineReady
    && activePresetId
    && !activeLocalModelReady
    && actionKind === 'start',
  )
  const actionDisabled = Boolean(busy) || (actionKind === 'start' ? !status.canStart : !status.canStop)
  const hasMeters = Boolean(quotaPanel || quotaUnavailable || idleShutdown)

  return (
    <div
      className="ofs-popover ofs-compute-popover"
      id="ofs-compute-popover"
      data-exiting={presence.exiting ? 'true' : undefined}
      role="dialog"
      aria-label={statusTitle}
    >
      {/* 1. 现在是什么状态：单行紧凑标题，保证下方算力切换区纵向坐标固定不跳动。 */}
      <div className="ofs-popover-head ofs-compute-head">
        <span className="ofs-compute-head-status">
          {hasProviderBadge ? (
            <ProviderIcon id={activeProviderId} size={14} className="ofs-compute-provider" />
          ) : null}
          <i className={`ofs-dot is-${status.tone === 'warn' && !status.queueLevel ? 'pending' : status.tone}`} aria-hidden="true" />
          <b title={statusTitle}>{statusTitle}</b>
          <Tooltip text={status.tooltip} side="bottom" />
        </span>
      </div>

      {/* 1.5 只展示已配置来源直切；未配置来源作为轻量引导行，避免误点且保留可发现性。 */}
      {switchProviderIds.length > 1 || unconfiguredProviderIds.length > 0 ? (
        <div className="ofs-compute-switch" role="radiogroup" aria-label={t('studio.settings.provider.label')}>
          {switchProviderIds.length > 1 ? (
            <>
              <span className="ofs-compute-switch-title">{t('studio.compute.switchTitle')}</span>
              <div className="ofs-compute-switch-grid" data-count={switchProviderIds.length}>
                {switchProviderIds.map((id) => {
                  const selected = id === activeProviderId
                  const label = providerLabelOf(t, id)
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected ? 'true' : 'false'}
                      className={`ofs-compute-switch-item${selected ? ' is-on' : ''}`}
                      disabled={Boolean(busy) || (!selected && typeof onSwitchProvider !== 'function')}
                      onClick={() => handleSwitchProvider(id)}
                      title={label}
                    >
                      <ProviderIcon id={id} size={12} className="ofs-compute-switch-icon" />
                      <span className="ofs-compute-switch-name">{label}</span>
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}
          {unconfiguredProviderIds.length > 0 ? (
            <div className="ofs-compute-more">
              <span className="ofs-compute-more-label">{t('studio.compute.moreProviders')}</span>
              {unconfiguredProviderIds.map((id, index) => (
                <React.Fragment key={id}>
                  {index > 0 ? <span className="ofs-compute-more-sep" aria-hidden="true">·</span> : null}
                  <button
                    type="button"
                    className="ofs-compute-more-item"
                    onClick={() => props.onOpenSettings?.(id)}
                  >
                    {providerLabelOf(t, id)}
                  </button>
                </React.Fragment>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 2. 详情与状态随切随变，收进稳定高度区，不推挤上方切换按钮 */}
      <div className="ofs-compute-body">
        {(metaParts.length > 0 || (!status.ready && status.hint) || pendingSwitchFrom) ? (
          <div className="ofs-compute-summary">
            {metaParts.length > 0 ? (
              <p className="ofs-compute-meta" title={metaParts.join(' · ')}>{metaParts.join(' · ')}</p>
            ) : null}
            {/* 就绪态不必再解释「可以生成」；只有排队 / 连接 / 出错才需要一句原因。 */}
            {!status.ready && status.hint ? <p className="ofs-compute-hint">{status.hint}</p> : null}
            {pendingSwitchFrom ? (
              <p className="ofs-compute-hint ofs-compute-pending-switch">
                {formatText(t('studio.compute.pendingSwitchHint'), {
                  current: providerLabelOf(t, pendingSwitchFrom),
                  next: providerName,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

      {/* 2.5 额度还能用多久 */}
      {hasMeters ? <div className="ofs-compute-meters">
        {!quotaUnavailable && quotaPanel ? (
          <dl className={`ofs-quota-panel is-${quotaTone}`}>
            <dt className="ofs-quota-title">{quotaPanel.title}</dt>
            <dd className="ofs-quota-meta">
              {quotaPanel.primary ? <strong className="ofs-quota-primary">{quotaPanel.primary}</strong> : null}
              {quotaPanel.sub ? <span className="ofs-quota-sub">{quotaPanel.sub}</span> : null}
              {quotaTone !== 'normal' ? <span className="ofs-quota-warning">{t(quotaTone === 'error' ? 'studio.compute.quotaCritical' : 'studio.compute.quotaLow')}</span> : null}
            </dd>
          </dl>
        ) : null}

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
            <a className="ofs-popover-link" href={KAGGLE_ACCOUNT_URL} target="_blank" rel="noreferrer">
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
      </div> : null}

      {/* 3. 环境检查：通过就一行结论，没过只列没过的项 */}
      <div className="ofs-compute-check">
        {checkRows.map((row, index) => (
          <div
            className={`ofs-check-row${row.summary ? ' is-summary' : ''}`}
            key={`${row.key}-${index}`}
            title={row.summary ? row.title : undefined}
          >
            <div className="ofs-check-content">
              <span className="ofs-check-key">
                <i className={`ofs-dot is-${row.tone}`} aria-hidden="true" />
                {row.key}
              </span>
              {row.val ? (
                <>
                  {row.key ? <span className="ofs-check-sep" aria-hidden="true"> · </span> : null}
                  <span className="ofs-check-val" title={row.title || row.val}>{row.val}</span>
                </>
              ) : null}
            </div>
            {row.caveat ? <Tooltip text={t('studio.compute.authTooltip')} tone="warn" side="bottom" /> : null}
            {canCheck && index === 0 ? (
              <button
                type="button"
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
      {tunnelLabel ? (
        <details className="ofs-compute-details">
          <summary>{t('studio.compute.connectionDetails')}</summary>
          <p>{t('studio.compute.tunnel')} · {tunnelLabel}</p>
        </details>
      ) : null}
      </div>

      {/* 4. 能做什么：一个主动作 + 两个出口 */}
      <div className="ofs-compute-actions">
        {needsSetupAction ? (
          <button
            type="button"
            className="ofs-popover-row ofs-popover-action is-primary"
            onClick={() => props.onOpenSettings?.(activeProviderId)}
          >
            <Icon name="sliders" size={14} />
            {setupActionLabel}
          </button>
        ) : needsModelDownloadAction ? (
          <button
            type="button"
            className="ofs-popover-row ofs-popover-action is-primary"
            disabled={typeof onOpenModels !== 'function'}
            onClick={() => onOpenModels?.()}
          >
            <Icon name="download" size={14} />
            {t('studio.compute.localGpu.openModels')}
          </button>
        ) : !isCloudApi ? (
          <button
            type="button"
            className={`ofs-popover-row ofs-popover-action${actionKind === 'start' ? ' is-primary' : ''}`}
            onClick={actionKind === 'start' ? props.onStart : props.onStop}
            disabled={actionDisabled}
          >
            <Icon name={actionKind === 'start' ? 'cloud' : 'clock'} size={14} />
            {providerText(t, actionKind === 'start' ? 'studio.compute.start' : 'studio.compute.stop', activeProviderId)}
          </button>
        ) : null}
        <div className="ofs-compute-links">
          <button
            type="button"
            className="ofs-popover-row"
            onClick={props.onOpenLogs}
          >
            <Icon name="message" size={15} />
            {t('studio.compute.logs')}
          </button>
          <button
            type="button"
            className="ofs-popover-row"
            onClick={() => props.onOpenSettings?.(activeProviderId)}
          >
            <Icon name="sliders" size={15} />
            {t('studio.compute.manageProviders')}
          </button>
        </div>
      </div>
    </div>
  )
}
