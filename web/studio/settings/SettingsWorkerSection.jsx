/**
 * 「私有 Worker」连接配置：地址、Token、测试连接与只读诊断。
 *
 * 与 Kaggle / Colab 的区别：
 *  - Token 只存本机加密凭据（credentials/workers.json），界面永远拿不到原文；
 *  - 「测试连接」直接打 /api/worker/probe，不需要先保存；
 *  - 不展示空闲关机 / 加速器 / 预挂载 Dataset——这些都由 Worker 侧启动参数决定。
 */

import React from 'react'

import { errorText } from '../../logic/error.js'
import { providerLabelOf } from '../../logic/status.js'
import { formatText } from '../../logic/format.js'
import { ProviderIcon } from './providerIcons.jsx'

function vramTextOf(hardware) {
  const mb = Number(hardware && hardware.vram_total_mb)
  if (!Number.isFinite(mb) || mb <= 0) return ''
  return mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${Math.round(mb)} MB`
}

export function SettingsWorkerSection({ t, form, view, probe, probing, onPatch, onProbe }) {
  if (!form) return null
  const configured = Boolean(view && view.tokenConfigured)
  const probeOk = Boolean(probe && probe.ok === true)
  const probeFailed = Boolean(probe && probe.ok === false)
  const hardware = probe && probe.hardware ? probe.hardware : null
  const gpuName = hardware && typeof hardware.gpu_name === 'string' ? hardware.gpu_name : ''
  const vram = vramTextOf(hardware)
  const protocol = probe && typeof probe.protocolVersion === 'string' ? probe.protocolVersion : ''
  const phase = probe && typeof probe.phase === 'string' ? probe.phase : ''
  const probeError = probeFailed && probe.error ? errorText(t, probe.error) : ''

  return (
    <div className="ofs-settings-subpanel">
      <div className="ofs-settings-block-head">
        <span className="ofs-settings-block-mark" aria-hidden="true">
          <ProviderIcon id="private-worker" size={17} />
        </span>
        <span className="ofs-settings-block-copy">
          <span className="ofs-settings-block-title">{providerLabelOf(t, 'private-worker')}</span>
          <span className="ofs-settings-block-sub">{t('studio.settings.worker.sub')}</span>
        </span>
      </div>

      <label className="ofs-settings-field">
        <span className="ofs-settings-label">{t('studio.settings.worker.endpoint.label')}</span>
        <input
          className="ofs-settings-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-label={t('studio.settings.worker.endpoint.label')}
          placeholder={t('studio.settings.worker.endpoint.placeholder')}
          value={form.endpointUrl}
          onChange={(event) => onPatch({ endpointUrl: event.target.value })}
        />
        <small className="ofs-settings-hint">{t('studio.settings.worker.endpoint.hint')}</small>
      </label>

      <div className="ofs-settings-field">
        <div className="ofs-settings-label-row">
          <span className="ofs-settings-label">{t('studio.settings.worker.token.label')}</span>
          {configured && !form.clearToken ? (
            <div className="ofs-settings-inline">
              <span className="ofs-settings-muted">{t('studio.settings.worker.token.saved')}</span>
              <button
                type="button"
                className="ofs-settings-text-btn"
                onClick={() => onPatch({ token: '', clearToken: true })}
              >
                {t('studio.settings.worker.token.clear')}
              </button>
            </div>
          ) : null}
          {form.clearToken ? (
            <span className="ofs-settings-muted">{t('studio.settings.worker.token.clearPending')}</span>
          ) : null}
        </div>
        <input
          className="ofs-settings-input"
          type="password"
          autoComplete="off"
          aria-label={t('studio.settings.worker.token.label')}
          placeholder={configured
            ? t('studio.settings.worker.token.placeholderSet')
            : t('studio.settings.worker.token.placeholder')}
          value={form.token}
          onChange={(event) => onPatch({ token: event.target.value, clearToken: false })}
        />
        <small className="ofs-settings-hint">{t('studio.settings.worker.token.hint')}</small>
      </div>

      <div className="ofs-settings-inline">
        <button
          type="button"
          className="ofs-chip"
          onClick={onProbe}
          disabled={probing}
          aria-busy={probing}
        >
          {probing ? t('studio.settings.worker.probing') : t('studio.settings.worker.probe')}
        </button>
        <span className="ofs-settings-muted">{t('studio.settings.worker.probeHint')}</span>
      </div>

      {probeOk ? (
        <div className="ofs-settings-status is-ready" role="status">
          <i className="ofs-dot is-ok" aria-hidden="true" />
          <span className="ofs-settings-status-text">
            {gpuName
              ? formatText(t('studio.settings.worker.probeOk'), {
                  protocol: protocol || '—',
                  gpu: vram ? `${gpuName} · ${vram}` : gpuName,
                })
              : formatText(t('studio.settings.worker.probeOkNoGpu'), { protocol: protocol || '—' })}
          </span>
        </div>
      ) : null}
      {probeOk && phase && phase !== 'ready' ? (
        <p className="ofs-settings-muted" role="status">
          {formatText(t('studio.settings.worker.probePhase'), { phase })}
        </p>
      ) : null}
      {probeFailed ? (
        <p className="ofs-settings-error" role="alert">
          {t('studio.settings.worker.probeFailed')}
          {probeError ? ` · ${probeError}` : ''}
        </p>
      ) : null}
    </div>
  )
}