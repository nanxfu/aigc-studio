/**
 * 「本机 GPU」设置区：状态、一键准备与显卡检测。
 *
 * 主视图不暴露引擎与权重路径；自带模型、源码调试或非自动准备环境所需的
 * 三个路径项收纳在默认折叠的「自定义路径」区，底层调优参数仍只走配置文件。
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
  const [customPathsOpen, setCustomPathsOpen] = React.useState(false)
  const configured = Boolean(view && view.ok)
  const autoOpenCustomPaths = setup?.supported === false && !configured

  React.useEffect(() => {
    if (autoOpenCustomPaths) setCustomPathsOpen(true)
  }, [autoOpenCustomPaths])

  if (!form) return null
  const bridge = desktop()
  const canPickFile = Boolean(bridge && typeof bridge.pickFile === 'function')
  const overrideByEnv = Boolean(view && view.overrideByEnv)
  const probeOk = Boolean(probe && probe.ok === true)
  const probeFailed = Boolean(probe && probe.ok === false)
  const gpuName = probe?.gpu?.name || ''
  const probeErrors = Array.isArray(probe?.errors) ? probe.errors : []
  const setupBusy = setupWorking || connecting || ['probing', 'checking', 'downloading', 'saving'].includes(setup?.phase)
  const showSetup = Boolean(
    setup?.supported &&
    (!configured || setupBusy || setup?.phase === 'error' || setup?.requiresSwitch),
  )
  const showReadySummary = configured && !setupBusy
  const setupTitleKey = setup?.phase === 'error'
    ? 'studio.settings.localGpu.setupRetryTitle'
    : setup?.requiresSwitch
      ? 'studio.settings.localGpu.setupSwitchTitle'
      : 'studio.settings.localGpu.setupTitle'
  const setupPercent = setup?.totalBytes > 0 ? Math.min(100, Math.round(100 * setup.downloadedBytes / setup.totalBytes)) : 0
  const downloadedGb = (Number(setup?.downloadedBytes || 0) / (1024 ** 3)).toFixed(1)
  const totalGb = (Number(setup?.totalBytes || 0) / (1024 ** 3)).toFixed(1)
  const requiredGb = (
    Math.ceil(((Number(setup?.totalBytes || 0) + 200 * 1024 ** 2) / (1024 ** 3)) * 10) / 10
  ).toFixed(1)
  const hasCustomPaths = Boolean(
    String(form.modelPath || '').trim() ||
    String(form.vaePath || '').trim() ||
    String(form.serverPath || '').trim(),
  )
  const showResetHint = !configured && Boolean(setup?.supported) && hasCustomPaths

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
          {t(configured ? 'studio.settings.localGpu.statusReady' : 'studio.settings.localGpu.statusUnconfigured')}
        </span>
      </div>

      {overrideByEnv ? (
        <p className="ofs-settings-hint">{t('studio.settings.localGpu.envLocked')}</p>
      ) : null}

      {showSetup ? (
        <section className="ofs-local-gpu-setup" aria-label={t(setupTitleKey)}>
          <div className="ofs-local-gpu-setup-copy">
            <span className="ofs-local-gpu-setup-title">{t(setupTitleKey)}</span>
            <span className="ofs-settings-muted">
              {setup.freeBytes !== null && setup.freeBytes !== undefined
                ? formatText(t('studio.settings.localGpu.setupDisk'), {
                    free: (setup.freeBytes / (1024 ** 3)).toFixed(1),
                    required: requiredGb,
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
                <span>
                  {connecting
                    ? t('studio.settings.localGpu.setupConnecting')
                    : t(`studio.settings.localGpu.setupPhase.${setup?.phase || 'checking'}`)}
                </span>
                {setup?.phase === 'downloading' ? <span>{setupPercent}% · {downloadedGb} / {totalGb} GB</span> : null}
              </div>
              {setup?.phase === 'downloading' ? (
                <progress
                  max={setup.totalBytes}
                  value={setup.downloadedBytes}
                  aria-label={t('studio.settings.localGpu.setupProgress')}
                />
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

      {showReadySummary ? (
        <div className="ofs-settings-status is-ready" role="status">
          <i className="ofs-dot is-ok" aria-hidden="true" />
          <span className="ofs-settings-status-text">
            {view?.modelName
              ? formatText(t('studio.settings.localGpu.readySummary'), { model: view.modelName })
              : t('studio.settings.localGpu.readySummaryNoModel')}
          </span>
        </div>
      ) : null}

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
      </div>

      {probeOk ? (
        <div className="ofs-settings-status is-ready" role="status">
          <i className="ofs-dot is-ok" aria-hidden="true" />
          <span className="ofs-settings-status-text">
            {gpuName
              ? formatText(t('studio.settings.localGpu.probeOk'), { gpu: gpuName })
              : t('studio.settings.localGpu.probeOkNoGpu')}
          </span>
        </div>
      ) : null}
      {probeFailed ? (
        <p className="ofs-settings-error" role="alert">
          {t('studio.settings.localGpu.probeFailed')}
          {probeErrors.length > 0 ? ` · ${probeErrors.join(' · ')}` : ''}
        </p>
      ) : null}

      <section className="ofs-local-gpu-custom">
        <button
          type="button"
          className="ofs-settings-advanced-toggle"
          aria-expanded={customPathsOpen}
          aria-controls="ofs-local-gpu-custom-paths"
          onClick={() => setCustomPathsOpen((open) => !open)}
        >
          <span>{t('studio.settings.localGpu.customPaths')}</span>
          <span className={`ofs-chevron${customPathsOpen ? ' is-open' : ''}`}>
            <Icon name="chevronDown" size={13} />
          </span>
        </button>

        {customPathsOpen ? (
          <div id="ofs-local-gpu-custom-paths" className="ofs-local-gpu-custom-body">
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
              {view?.useBundledEngine === true || setup?.supported ? (
                <small className="ofs-settings-hint">{t('studio.settings.localGpu.customEngineHint')}</small>
              ) : null}
            </label>

            {showResetHint ? (
              <p className="ofs-settings-hint">{t('studio.settings.localGpu.customPathsResetHint')}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}
