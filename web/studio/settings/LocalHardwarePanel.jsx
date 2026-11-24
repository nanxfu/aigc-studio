/**
 * 「本机模型」页签内的算力画像、模型适配评估与显卡天梯面板（纯本地只读探测，不上传外网）。
 */

import React from 'react'

import {
  SELECTABLE_GPU_PRESETS,
  buildFocusedLadderSegments,
  evaluateDeviceCapability,
  matchGpuProfile,
} from '../../../shared/gpu-benchmark.js'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'

function verdictOfItem(item) {
  if (item.verdict) return item.verdict
  if (item.status === 'fp16-ready') return 'ready'
  if (item.status === 'tight' || item.status === 'gguf-planned') return 'tight'
  return 'unsupported'
}

function verdictBadgeClass(verdict) {
  if (verdict === 'ready') return 'is-ok'
  if (verdict === 'tight') return 'is-warn'
  return 'is-muted'
}

const VERDICT_ORDER = { ready: 0, tight: 1, unsupported: 2 }

export function LocalHardwarePanel({ t, hardware, hardwareLoading, runtimeInfo, onRefresh }) {
  const [simPresetId, setSimPresetId] = React.useState('')
  const [ladderExpanded, setLadderExpanded] = React.useState(false)

  const diskFreeGb = hardware?.disk?.freeGb ?? null
  const activeEval = React.useMemo(() => {
    if (simPresetId) {
      const simProfile = matchGpuProfile({ presetId: simPresetId })
      return evaluateDeviceCapability(simProfile, { diskFreeGb })
    }
    if (hardware?.evaluation) {
      return hardware.evaluation
    }
    const fallbackProfile = matchGpuProfile({
      adapterLabel: runtimeInfo?.adapterLabel || '',
    })
    return evaluateDeviceCapability(fallbackProfile, { diskFreeGb })
  }, [simPresetId, hardware, runtimeInfo, diskFreeGb])

  const { profile, tier, score, modelStatuses, ladder } = activeEval
  const sourceKey = profile.vramSource === 'measured'
    ? 'measured'
    : profile.vramSource === 'unified-estimate'
      ? 'unified'
      : profile.vramSource === 'dictionary'
        ? 'dict'
        : profile.vramSource === 'manual'
          ? 'manual'
          : 'unknown'

  const vramText = `${profile.vramGb} GB · ${t(`settings.localModels.hw.source.${sourceKey}`)}`
  const speedText = `${score.speedVsT4}x vs T4 · ${formatText(t('settings.localModels.hw.beatPct'), { pct: score.percentile })}`
  const unlockText = formatText(t('settings.localModels.hw.unlockSummary'), {
    ready: score.readyCount ?? score.unlockedGguf ?? 0,
    tight: score.tightCount ?? 0,
    total: score.totalModels,
  })
  const sortedModels = React.useMemo(() => {
    return [...modelStatuses].sort((a, b) => (VERDICT_ORDER[verdictOfItem(a)] ?? 9) - (VERDICT_ORDER[verdictOfItem(b)] ?? 9))
  }, [modelStatuses])
  const diskText = score.diskFreeGb !== null
    ? `${score.diskFreeGb} GB`
    : t('settings.localModels.hw.diskUnknown')

  const ladderSegments = React.useMemo(() => {
    if (ladderExpanded) return ladder.map((row) => ({ type: 'row', row }))
    return buildFocusedLadderSegments(ladder, { topCount: 3, aroundSelf: 1, tailCount: 1 })
  }, [ladder, ladderExpanded])

  return (
    <div className="ofs-settings-section ofs-hw-section" data-testid="local-hardware-panel">
      <div className="ofs-settings-block-head">
        <div className="ofs-settings-block-copy">
          <span className="ofs-settings-block-title">{t('settings.localModels.hw.title')}</span>
          <span className="ofs-settings-block-sub">{t('settings.localModels.hw.hint')}</span>
        </div>
        <span className={`ofs-settings-block-badge ${score.unlockedGguf >= 5 ? 'is-ok' : 'is-warn'}`}>
          {tier.badge}
        </span>
      </div>

      <div className="ofs-hw-summary-card">
        <div className="ofs-hw-summary-top">
          <div className="ofs-hw-device-info">
            <span className="ofs-hw-device-name">{profile.displayName}</span>
            <span className="ofs-hw-device-note">{tier.summary}</span>
          </div>
          <div className="ofs-hw-controls">
            <select
              className="ofs-settings-select ofs-hw-preset-select"
              aria-label={t('settings.localModels.hw.simulateLabel')}
              value={simPresetId}
              onChange={(event) => setSimPresetId(event.target.value)}
            >
              <option value="">{t('settings.localModels.hw.useDetected')}</option>
              {SELECTABLE_GPU_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ofs-chip"
              disabled={hardwareLoading}
              onClick={() => {
                setSimPresetId('')
                onRefresh?.()
              }}
            >
              <Icon name="refresh" size={12} />
              {hardwareLoading ? t('settings.localModels.hw.probing') : t('studio.refresh')}
            </button>
          </div>
        </div>

        <div className="ofs-hw-metrics">
          <div className="ofs-hw-metric">
            <span className="ofs-hw-metric-label">{t('settings.localModels.hw.metricVram')}</span>
            <span className="ofs-hw-metric-val">{vramText}</span>
          </div>
          <div className="ofs-hw-metric">
            <span className="ofs-hw-metric-label">{t('settings.localModels.hw.metricSpeed')}</span>
            <span className="ofs-hw-metric-val">{speedText}</span>
          </div>
          <div className="ofs-hw-metric">
            <span className="ofs-hw-metric-label">{t('settings.localModels.hw.metricUnlock')}</span>
            <span className="ofs-hw-metric-val">{unlockText}</span>
          </div>
          <div className="ofs-hw-metric">
            <span className="ofs-hw-metric-label">{t('settings.localModels.hw.metricDisk')}</span>
            <span className="ofs-hw-metric-val">{diskText}</span>
          </div>
        </div>
      </div>

      <div className="ofs-hw-subhead">
        <span className="ofs-hw-subtitle">{t('settings.localModels.hw.modelsTitle')}</span>
        <span className="ofs-hw-subhint">{t('settings.localModels.hw.modelsHint')}</span>
      </div>
      <div className="ofs-hw-model-grid">
        {sortedModels.map((item) => {
          const verdict = verdictOfItem(item)
          const needGb = item.needVramGb ?? item.peakVramGb
          return (
            <div key={item.id} className={`ofs-hw-model-row is-${verdict}`} data-model-fit={item.id}>
              <div className="ofs-hw-model-main">
                <span className="ofs-hw-model-name">{item.label}</span>
                <span className="ofs-hw-model-meta">
                  {`${needGb} GB · ~${item.estSeconds}s${item.diskWarning ? ` · ${t('settings.localModels.hw.diskTight')}` : ''}`}
                </span>
              </div>
              <span
                className={`ofs-settings-block-badge ${verdictBadgeClass(verdict)}`.trim()}
                title={item.reason}
              >
                {t(`settings.localModels.hw.verdict.${verdict}`)}
              </span>
            </div>
          )
        })}
      </div>

      <div className="ofs-hw-subhead">
        <div className="ofs-hw-subtitle-wrap">
          <span className="ofs-hw-subtitle">{t('settings.localModels.hw.ladderTitle')}</span>
          <span className="ofs-hw-subhint">{t('settings.localModels.hw.ladderHint')}</span>
        </div>
        <button
          type="button"
          className="ofs-chip"
          onClick={() => setLadderExpanded((prev) => !prev)}
        >
          {ladderExpanded
            ? t('settings.localModels.hw.collapseLadder')
            : formatText(t('settings.localModels.hw.expandLadder'), { count: ladder.length })}
        </button>
      </div>

      <div className="ofs-hw-ladder" role="table" aria-label={t('settings.localModels.hw.ladderTitle')}>
        {ladderSegments.map((seg) => {
          if (seg.type === 'gap') {
            const ghost = seg.previewRows[0]
            return (
              <button
                key={`gap-${seg.fromRank}-${seg.toRank}`}
                type="button"
                className="ofs-hw-ladder-gap"
                onClick={() => setLadderExpanded(true)}
                title={formatText(t('settings.localModels.hw.expandLadder'), { count: ladder.length })}
              >
                {ghost ? (
                  <div className="ofs-hw-gap-ghost" aria-hidden="true">
                    <span className="ofs-hw-rank">#{ghost.rank}</span>
                    <span className="ofs-hw-row-name">{ghost.shortName}</span>
                    <span className="ofs-hw-speed-val">{`${ghost.speedVsT4}x`}</span>
                  </div>
                ) : null}
                <div className="ofs-hw-gap-mask">
                  <span className="ofs-hw-gap-label">
                    {formatText(t('settings.localModels.hw.foldedRanks'), {
                      from: seg.fromRank,
                      to: seg.toRank,
                      count: seg.hiddenCount,
                    })}
                  </span>
                </div>
              </button>
            )
          }

          const row = seg.row
          const pctWidth = Math.min(100, Math.max(8, Math.round((row.speedVsT4 / 5.8) * 100)))
          return (
            <div
              key={row.id}
              role="row"
              className={`ofs-hw-ladder-row ${row.isCurrentUser ? 'is-self' : ''} ${row.isCloudRef ? 'is-cloud' : ''}`.trim()}
            >
              <span className="ofs-hw-rank" role="cell">#{row.rank}</span>
              <div className="ofs-hw-name-col" role="cell">
                <span className="ofs-hw-row-name">
                  {row.isCurrentUser ? `★ ${t('settings.localModels.hw.selfPrefix')}${row.shortName}` : row.shortName}
                </span>
                <span className="ofs-hw-row-meta">{`${row.vramGb} GB · ${row.backend}`}</span>
              </div>
              <div className="ofs-hw-bar-col" role="cell">
                <span className="ofs-hw-bar-track">
                  <span className="ofs-hw-bar-fill" style={{ width: `${pctWidth}%` }} />
                </span>
                <span className="ofs-hw-speed-val">{`${row.speedVsT4}x`}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
