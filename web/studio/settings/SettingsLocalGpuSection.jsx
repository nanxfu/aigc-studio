/**
 * 「本机 GPU」设置区只做三件事：
 *  1. 展示显卡与推理引擎状态；
 *  2. 检测本机显卡并给出直白结论；
 *  3. 复用全局本机模型目录。
 *
 * 模型选择与权重下载已迁到顶栏模型卡；正式界面不再暴露引擎 / 模型 / VAE 路径，
 * 但 local-gpu.json 与 AIGC_STUDIO_LOCAL_GPU_* 环境变量仍完全保留。
 */

import React from 'react'

import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'
import { LocalModelStorageField } from './LocalModelStorageField.jsx'
import { ProviderIcon } from './providerIcons.jsx'

export function SettingsLocalGpuSection({
  t,
  view,
  probe,
  probing,
  hardware = null,
  setup = null,
  setupWorking = false,
  onSetup = null,
  onCancelSetup = null,
  disabled = false,
  onProbe,
}) {
  const engineReady = Boolean(view && (view.engineReady || view.ok))
  const setupBusy = setupWorking || ['probing', 'checking', 'downloading', 'saving'].includes(setup?.phase)
  const gpuName = hardware?.evaluation?.profile?.shortName || probe?.gpu?.name || ''
  const profile = hardware?.evaluation?.profile || null
  const tier = hardware?.evaluation?.tier || null
  const probeErrors = Array.isArray(probe?.errors) ? probe.errors : []
  const setupPercent = setup?.totalBytes > 0
    ? Math.min(100, Math.round(100 * setup.downloadedBytes / setup.totalBytes))
    : 0

  return (
    <div className="ofs-settings-subpanel ofs-local-gpu-panel" data-testid="local-gpu-settings">
      <div className="ofs-settings-block-head">
        <span className="ofs-settings-block-mark" aria-hidden="true">
          <ProviderIcon id="local-gpu" size={17} />
        </span>
        <span className="ofs-settings-block-copy">
          <span className="ofs-settings-block-title">{t('studio.settings.localGpu.title')}</span>
          <span className="ofs-settings-block-sub" role="status">
            {t(engineReady ? 'studio.settings.localGpu.engineReady' : 'studio.settings.localGpu.engineMissing')}
          </span>
        </span>
      </div>

      {view?.overrideByEnv ? (
        <p className="ofs-settings-hint">{t('studio.settings.localGpu.envLocked')}</p>
      ) : null}

      {setupBusy || (!engineReady && setup?.supported) ? (
        <section className="ofs-local-gpu-setup" aria-label={t('studio.settings.localGpu.engineSetupTitle')}>
          <div className="ofs-local-gpu-setup-copy">
            <span className="ofs-settings-muted">
              {t('studio.settings.localGpu.engineSetupHint')}
            </span>
          </div>
          <div className="ofs-local-gpu-setup-actions">
            {setupBusy ? (
              <button type="button" className="ofs-chip" onClick={onCancelSetup} disabled={setupWorking}>
                {t('studio.settings.localGpu.setupCancel')}
              </button>
            ) : (
              <button type="button" className="ofs-btn is-quiet" onClick={onSetup} disabled={disabled || probing}>
                {t(setup?.phase === 'error' ? 'studio.settings.localGpu.setupRetry' : 'studio.settings.localGpu.engineSetupStart')}
              </button>
            )}
          </div>
          {setupBusy ? (
            <div className="ofs-local-gpu-setup-progress" role="status">
              <div className="ofs-local-gpu-setup-progress-head">
                <span>{t(`studio.settings.localGpu.setupPhase.${setup?.phase || 'checking'}`)}</span>
                {setup?.phase === 'downloading' && setup.totalBytes > 0 ? <span>{setupPercent}%</span> : null}
              </div>
              {setup?.phase === 'downloading' ? (
                <progress
                  max={setup.totalBytes > 0 ? setup.totalBytes : undefined}
                  value={setup.totalBytes > 0 ? setup.downloadedBytes : undefined}
                  aria-label={t('studio.settings.localGpu.setupProgress')}
                />
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {setup?.phase === 'error' ? <p className="ofs-settings-error" role="alert">{setup.message}</p> : null}
      {!engineReady && setup && setup.supported === false ? (
        <p className="ofs-settings-hint">{t('studio.settings.localGpu.setupUnavailable')}</p>
      ) : null}

      <div className="ofs-local-gpu-device">
        <div className="ofs-local-gpu-device-copy" role="status">
          <span className="ofs-settings-label">
            {gpuName || t('studio.settings.localGpu.gpuUnknown')}
          </span>
          {gpuName && (profile?.vramGb || tier?.badge) ? (
            <span className="ofs-settings-muted">
              {profile?.vramGb ? formatText(t('studio.settings.localGpu.vramBudget'), { vram: profile.vramGb }) : null}
              {profile?.vramGb && tier?.badge ? ' · ' : null}
              {tier?.badge}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="ofs-chip"
          onClick={onProbe}
          disabled={probing || setupBusy}
          aria-busy={probing}
        >
          <Icon name="refresh" size={12} className={probing ? 'ofs-spin' : ''} />
          {probing ? t('studio.settings.localGpu.probing') : t('studio.settings.localGpu.probe')}
        </button>
      </div>

      {probe && probe.ok === false ? (
        <p className="ofs-settings-error" role="alert">
          {t('studio.settings.localGpu.probeFailed')}
          {probeErrors.length > 0 ? ` · ${probeErrors.join(' · ')}` : ''}
        </p>
      ) : null}

      <LocalModelStorageField t={t} collapsible />
    </div>
  )
}
