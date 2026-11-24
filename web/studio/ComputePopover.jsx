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
  } = props
  const presence = usePresence(open, 150)
  const snapshot = useHostSnapshot(open)
  const now = useNow(open)
  const [switching, setSwitching] = React.useState(false)

  const activeProviderId = providerId || (compute && compute.provider) || SETTINGS.defaultProvider
  const isCloudApi = activeProviderId === 'cloud-api'
  const isLocalGpu = activeProviderId === 'local-gpu'
  const isRemoteWorker = activeProviderId === 'private-worker'
  const isWorkerLike = isRemoteWorker || isLocalGpu
  const isColab = activeProviderId === 'colab'
  const hasProviderBadge = activeProviderId === 'kaggle' || isColab || isWorkerLike || isCloudApi
  // 弹层标题用完整来源名，不背胶囊里为省宽度加的（GPU 型号）后缀——型号在下面的读数行里。
  const providerName = providerLabelOf(t, activeProviderId)
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
        val: modelReady ? localGpu.modelName || t('studio.compute.localGpu.ready') : t('studio.compute.localGpu.missing'),
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

  const hasCloudKey = Boolean(
    (compute && compute.imageApi && compute.imageApi.hasApiKey)
    || (compute && compute.imageApi && Array.isArray(compute.imageApi.apiKeysConfigured) && compute.imageApi.apiKeysConfigured.length > 0),
  )

  const isProviderConfigured = (id) => {
    if (id === 'kaggle') return configuredProviderSet ? configuredProviderSet.has('kaggle') : true
    if (id === 'colab') return Boolean((colabAuth && colabAuth.authorized === true) || configuredProviderSet?.has('colab'))
    if (id === 'cloud-api') return Boolean(hasCloudKey || configuredProviderSet?.has('cloud-api'))
    if (id === 'local-gpu') return Boolean(localGpu?.ok || configuredProviderSet?.has('local-gpu'))
    if (id === 'private-worker') return Boolean(worker?.endpointUrl || configuredProviderSet?.has('private-worker'))
    return Boolean(configuredProviderSet?.has(id))
  }

  async function handleSwitchProvider(nextId) {
    if (!nextId || nextId === activeProviderId || switching || busy) return
    if (typeof onSwitchProvider !== 'function') return
    setSwitching(true)
    try {
      await onSwitchProvider(nextId)
    } finally {
      setSwitching(false)
    }
  }

  const needsSetupAction =
    (isLocalGpu && (!localGpu || !localGpu.ok))
    || (isRemoteWorker && !worker)
    || (isCloudApi && !hasCloudKey)
  const setupActionLabel = isLocalGpu
    ? t('studio.compute.localGpu.openSettings')
    : isRemoteWorker
      ? t('studio.compute.worker.openSettings')
      : t('studio.compute.cloudApi.openSettings')

  const actionKind = status.canStart ? 'start' : 'stop'
  const actionDisabled = Boolean(busy) || switching || (actionKind === 'start' ? !status.canStart : !status.canStop)
  const hasMeters = Boolean(quotaPanel || quotaUnavailable || idleShutdown)

  return (
    <div
      className="ofs-popover ofs-compute-popover"
      id="ofs-compute-popover"
      data-exiting={presence.exiting ? 'true' : undefined}
      role="dialog"
      aria-label={statusTitle}
    >
      {/* 1. 现在是什么状态 */}
      <div className="ofs-popover-head ofs-compute-head">
        <span className="ofs-compute-head-status">
          {hasProviderBadge ? (
            <ProviderIcon id={activeProviderId} size={14} className="ofs-compute-provider" />
          ) : null}
          <i className={`ofs-dot is-${status.tone}`} aria-hidden="true" />
          <b>{statusTitle}</b>
          <Tooltip text={status.tooltip} side="bottom" />
        </span>
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

      {/* 1.5 算力后端直接切换（方案 A：哪跑在这里切，模型卡只选模型） */}
      <div className="ofs-compute-switch" role="radiogroup" aria-label={t('studio.settings.provider.label')}>
        <span className="ofs-compute-switch-title">{t('studio.compute.switchTitle')}</span>
        <div className="ofs-compute-switch-grid">
          {SETTINGS.providers.map((id) => {
            const selected = id === activeProviderId
            const configured = isProviderConfigured(id)
            const label = providerLabelOf(t, id)
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected ? 'true' : 'false'}
                className={`ofs-compute-switch-item${selected ? ' is-on' : ''}${!configured ? ' is-unconfigured' : ''}`}
                disabled={Boolean(busy) || switching || (!selected && typeof onSwitchProvider !== 'function')}
                onClick={() => handleSwitchProvider(id)}
                title={!configured ? t('studio.compute.unconfiguredProviderHint') : label}
              >
                <ProviderIcon id={id} size={12} className="ofs-compute-switch-icon" />
                <span className="ofs-compute-switch-name">{label}</span>
                {!configured ? <i className="ofs-dot is-idle" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      </div>

      {/* 2. 额度还能用多久 */}
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
            {t('studio.settings.open')}
          </button>
        </div>
      </div>
    </div>
  )
}
