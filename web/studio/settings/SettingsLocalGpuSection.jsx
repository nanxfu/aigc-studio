/**
 * 「本机 GPU（Vulkan / stable-diffusion.cpp）」可视化配置与只读探测面板。
 *
 * 与远程 Worker 彻底分离：
 *  - 不填 URL / Token，只管本机 `sd-server` 可执行文件、GGUF 模型权重与可选 VAE；
 *  - 支持 Electron 原生文件选择框与浏览器手填路径；
 *  - 「探测本机环境」直接调 `/api/local-gpu/probe`，未保存的草稿也能先验证文件与显卡。
 */

import React from 'react'

import { desktop } from '../../runtime.js'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'
import { ProviderIcon } from './providerIcons.jsx'

export function SettingsLocalGpuSection({
  t,
  form,
  view,
  probe,
  probing,
  setup = null,
  setupWorking = false,
  connecting = false,
  onSetup = null,
  onCancelSetup = null,
  disabled = false,
  onPatch,
  onProbe,
  onOpenLocalModels = null,
}) {
  if (!form) return null
  const bridge = desktop()
  const canPickFile = Boolean(bridge && typeof bridge.pickFile === 'function')
  const configured = Boolean(view && view.ok)
  const overrideByEnv = Boolean(view && view.overrideByEnv)
  const probeOk = Boolean(probe && probe.ok === true)
  const probeFailed = Boolean(probe && probe.ok === false)
  const gpuName = probe?.gpu?.name || ''
  const probeErrors = Array.isArray(probe?.errors) ? probe.errors : []
  const probeWarnings = Array.isArray(probe?.warnings) ? probe.warnings : []
  const setupBusy = setupWorking || connecting || ['probing', 'checking', 'downloading', 'saving'].includes(setup?.phase)
  const managedEngine = Boolean(view?.useBundledEngine)
  const setupPercent = setup?.totalBytes > 0 ? Math.min(100, Math.round(100 * setup.downloadedBytes / setup.totalBytes)) : 0
  const downloadedGb = (Number(setup?.downloadedBytes || 0) / (1024 ** 3)).toFixed(1)
  const totalGb = (Number(setup?.totalBytes || 0) / (1024 ** 3)).toFixed(1)

  async function pickPath(field, title, extensions) {
    if (!canPickFile) return
    const picked = await bridge.pickFile({
      title,
      filters: [{ name: title, extensions }],
    })
    if (picked) onPatch({ [field]: picked })
  }

  return (
    <div className="ofs-settings-subpanel ofs-local-gpu-panel" data-testid="local-gpu-settings">
      <div className="ofs-settings-block-head">
        <span className="ofs-settings-block-mark" aria-hidden="true">
          <ProviderIcon id="local-gpu" size={17} />
        </span>
        <span className="ofs-settings-block-copy">
          <span className="ofs-settings-block-title">{t('studio.settings.localGpu.title')}</span>
          <span className="ofs-settings-block-sub">{t('studio.settings.localGpu.sub')}</span>
        </span>
        <span className={`ofs-settings-block-badge ${configured ? 'is-ok' : ''}`.trim()}>
          {t(configured ? 'studio.compute.localGpu.ready' : 'studio.compute.localGpu.missing')}
        </span>
      </div>

      {overrideByEnv ? (
        <p className="ofs-settings-hint">{t('studio.settings.localGpu.envLocked')}</p>
      ) : null}

      {setup?.supported && (!configured || setupBusy || setup?.phase === 'error' || setup?.requiresSwitch) ? (
        <section className="ofs-local-gpu-setup" aria-label={t('studio.settings.localGpu.setupTitle')}>
          <div className="ofs-local-gpu-setup-copy">
            <span className="ofs-local-gpu-setup-title">{t('studio.settings.localGpu.setupTitle')}</span>
          <span className="ofs-settings-muted">
            {setup.freeBytes !== null && setup.freeBytes !== undefined
              ? formatText(t('studio.settings.localGpu.setupDisk'), {
                  free: (setup.freeBytes / (1024 ** 3)).toFixed(1),
                  required: ((setup.totalBytes + 200 * 1024 ** 2) / (1024 ** 3)).toFixed(1),
                })
              : t('studio.settings.localGpu.setupHint')}
          </span>
          </div>
          <div className="ofs-local-gpu-setup-actions">
            {setupBusy ? (
              <button type="button" className="ofs-chip" onClick={onCancelSetup} disabled={setupWorking || connecting}>
                {t('studio.settings.localGpu.setupCancel')}
              </button>
            ) : (
              <button type="button" className="ofs-btn is-primary" onClick={onSetup} disabled={disabled}>
                {setup?.requiresSwitch
                  ? t('studio.settings.localGpu.setupConnect')
                  : setup?.phase === 'error'
                    ? t('studio.settings.localGpu.setupRetry')
                    : t('studio.settings.localGpu.setupStart')}
              </button>
            )}
          </div>
          {setupBusy ? (
            <div className="ofs-local-gpu-setup-progress" role="status">
              <div className="ofs-local-gpu-setup-progress-head">
                <span>{connecting ? t('studio.settings.localGpu.setupConnecting') : t(`studio.settings.localGpu.setupPhase.${setup?.phase || 'checking'}`)}</span>
                {setup?.phase === 'downloading' ? <span>{setupPercent}% · {downloadedGb} / {totalGb} GB</span> : null}
              </div>
              {setup?.phase === 'downloading' ? (
                <progress max={setup.totalBytes} value={setup.downloadedBytes} aria-label={t('studio.settings.localGpu.setupProgress')} />
              ) : null}
            </div>
          ) : null}
          {setup?.phase === 'error' ? <p className="ofs-settings-error" role="alert">{setup.message}</p> : null}
          {setup?.phase === 'ready' ? (
            <p className="ofs-settings-status is-ready" role="status">
              {t(setup.requiresSwitch ? 'studio.settings.localGpu.setupSwitchHint' : 'studio.settings.localGpu.setupReady')}
            </p>
          ) : null}
        </section>
      ) : null}

      <label className="ofs-settings-field">
        <span className="ofs-settings-label">{t('studio.settings.localGpu.serverPath')}</span>
        <div className="ofs-local-models-dir-row">
          <input
            className="ofs-settings-input ofs-grow"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('studio.settings.localGpu.serverPath')}
            placeholder={t('studio.settings.localGpu.serverPlaceholder')}
            value={form.serverPath}
            onChange={(event) => onPatch({ serverPath: event.target.value })}
          />
          {canPickFile ? (
            <button
              type="button"
              className="ofs-chip"
              onClick={() => void pickPath('serverPath', t('studio.settings.localGpu.serverPath'), ['exe', 'bin', 'app'])}
            >
              <Icon name="folderOpen" size={13} />
              {t('studio.settings.localGpu.browse')}
            </button>
          ) : null}
        </div>
      </label>

      <label className="ofs-settings-field">
        <span className="ofs-settings-label">{t('studio.settings.localGpu.modelPath')}</span>
        <div className="ofs-local-models-dir-row">
          <input
            className="ofs-settings-input ofs-grow"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('studio.settings.localGpu.modelPath')}
            placeholder={t('studio.settings.localGpu.modelPlaceholder')}
            value={form.modelPath}
            onChange={(event) => onPatch({ modelPath: event.target.value })}
          />
          {canPickFile ? (
            <button
              type="button"
              className="ofs-chip"
              onClick={() => void pickPath('modelPath', t('studio.settings.localGpu.modelPath'), ['gguf', 'safetensors'])}
            >
              <Icon name="folderOpen" size={13} />
              {t('studio.settings.localGpu.browse')}
            </button>
          ) : null}
        </div>
      </label>

      <label className="ofs-settings-field">
        <span className="ofs-settings-label">{t('studio.settings.localGpu.vaePath')}</span>
        <div className="ofs-local-models-dir-row">
          <input
            className="ofs-settings-input ofs-grow"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('studio.settings.localGpu.vaePath')}
            placeholder={t('studio.settings.localGpu.vaePlaceholder')}
            value={form.vaePath}
            onChange={(event) => onPatch({ vaePath: event.target.value })}
          />
          {canPickFile ? (
            <button
              type="button"
              className="ofs-chip"
              onClick={() => void pickPath('vaePath', t('studio.settings.localGpu.vaePath'), ['safetensors', 'pt', 'ckpt'])}
            >
              <Icon name="folderOpen" size={13} />
              {t('studio.settings.localGpu.browse')}
            </button>
          ) : null}
        </div>
      </label>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('studio.settings.localGpu.paramsBackend')}</span>
        <select
          className="ofs-settings-select"
          aria-label={t('studio.settings.localGpu.paramsBackend')}
          value={form.paramsBackend}
          onChange={(event) => onPatch({ paramsBackend: event.target.value === 'cpu' ? 'cpu' : 'disk' })}
        >
          <option value="disk">{t('studio.settings.localGpu.paramsBackend.disk')}</option>
          <option value="cpu">{t('studio.settings.localGpu.paramsBackend.cpu')}</option>
        </select>
      </div>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('studio.settings.localGpu.idleTimeoutSec')}</span>
        <input
          className="ofs-settings-input ofs-settings-idle-input"
          type="number"
          inputMode="numeric"
          min={60}
          max={3600}
          step={30}
          aria-label={t('studio.settings.localGpu.idleTimeoutSec')}
          value={form.idleTimeoutSec}
          onChange={(event) => onPatch({ idleTimeoutSec: event.target.value })}
        />
      </div>

      <label className="ofs-settings-inline">
        <input
          type="checkbox"
          checked={form.vaeTiling !== false}
          onChange={(event) => onPatch({ vaeTiling: event.target.checked })}
        />
        <span className="ofs-settings-label">{t('studio.settings.localGpu.vaeTiling')}</span>
      </label>

      <div className="ofs-settings-inline">
        <button
          type="button"
          className="ofs-chip"
          onClick={onProbe}
          disabled={probing}
          aria-busy={probing}
        >
          {probing ? t('studio.settings.localGpu.probing') : t('studio.settings.localGpu.probe')}
        </button>
        {onOpenLocalModels ? (
          <button type="button" className="ofs-settings-text-btn" onClick={onOpenLocalModels}>
            {t('studio.settings.localGpu.openHardware')}
          </button>
        ) : null}
        <span className="ofs-settings-muted">{t('studio.settings.localGpu.probeHint')}</span>
      </div>

      {probeOk ? (
        <div className="ofs-settings-status is-ready" role="status">
          <i className="ofs-dot is-ok" aria-hidden="true" />
          <span className="ofs-settings-status-text">
            {formatText(t('studio.settings.localGpu.probeOk'), { gpu: gpuName || 'Vulkan GPU' })}
          </span>
        </div>
      ) : null}
      {probeOk && probeWarnings.length > 0 ? (
        <p className="ofs-settings-muted" role="status">{probeWarnings.join(' · ')}</p>
      ) : null}
      {probeFailed ? (
        <p className="ofs-settings-error" role="alert">
          {t('studio.settings.localGpu.probeFailed')}
          {probeErrors.length > 0 ? ` · ${probeErrors.join('；')}` : ''}
        </p>
      ) : null}

      {view && view.configPath ? (
        <p className="ofs-settings-muted">
          {formatText(t('studio.settings.localGpu.configPath'), { path: view.configPath })}
        </p>
      ) : null}
    </div>
  )
}
