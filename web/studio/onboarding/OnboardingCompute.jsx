import React from 'react'

import { controlLocalGpuSetup, fetchLocalGpuSetup } from '../../api/localModels.js'
import { saveAppSettings, saveSettings } from '../../api/resources.js'
import { buildImageApiPatch, imageApiFormOf, imageApiVendorSwitchPatch } from '../../logic/appSettings.js'
import { settingsViewOf } from '../../logic/settings.js'
import { Icon } from '../icons.jsx'
import { ProviderIcon } from '../settings/providerIcons.jsx'
import { SettingsCloudApiSection } from '../settings/SettingsCloudApiSection.jsx'
import { OAuthManualPanel } from '../guidance/DirectLoginCard.jsx'

const OPTIONS = ['kaggle', 'colab', 'local-gpu']
const ACTIVE_SETUP = ['probing', 'checking', 'downloading', 'saving']

/** Only the chosen generation path is configured. GPU sessions are not started here. */
export function OnboardingCompute({ t, compute = {}, ui = {}, appView, initialProvider = '', onSelect, onDone, onError, onBusyChange }) {
  const [selected, setSelected] = React.useState(initialProvider)
  const [saving, setSaving] = React.useState(false)
  const [setup, setSetup] = React.useState(null)
  const [localWorking, setLocalWorking] = React.useState(false)
  const [imageForm, setImageForm] = React.useState(() => imageApiFormOf(appView))
  const mounted = React.useRef(true)
  const pending = React.useRef(false)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  React.useEffect(() => { onBusyChange?.(saving || localWorking); return () => onBusyChange?.(false) }, [saving, localWorking, onBusyChange])

  React.useEffect(() => {
    if (selected !== 'local-gpu') return undefined
    let alive = true
    fetchLocalGpuSetup().then((result) => { if (alive && result.ok) setSetup(result.setup) })
    return () => { alive = false }
  }, [selected])

  React.useEffect(() => {
    if (!ACTIVE_SETUP.includes(setup?.phase)) return undefined
    let alive = true
    let timer
    const poll = async () => {
      const result = await fetchLocalGpuSetup()
      if (!alive) return
      if (result.ok) setSetup(result.setup)
      if (!result.ok || ACTIVE_SETUP.includes(result.setup?.phase)) timer = setTimeout(poll, 1200)
    }
    timer = setTimeout(poll, 1200)
    return () => { alive = false; clearTimeout(timer) }
  }, [setup?.phase])

  const login = selected === 'colab' ? compute.colabLogin : compute.kaggleLogin
  const loginState = login?.login?.state || 'idle'
  const authorized = loginState === 'done'
    || (selected === 'colab' && compute.colabAuth?.authorized === true)
    || (selected === 'kaggle' && compute.probe?.auth?.ok === true)
  const ready = selected === 'local-gpu' ? setup?.phase === 'ready' : selected === 'cloud-api' ? true : authorized
  const setupActive = ACTIVE_SETUP.includes(setup?.phase)

  async function prepareLocal(action) {
    if (pending.current) return
    pending.current = true
    setLocalWorking(true)
    try {
      const result = await controlLocalGpuSetup(action)
      if (!mounted.current) return
      if (result.ok) setSetup(result.setup)
      else onError(result)
    } finally { pending.current = false; if (mounted.current) setLocalWorking(false) }
  }

  async function savePath() {
    if (pending.current || !selected || !ready) return
    if (selected === 'cloud-api' && (imageForm.clearApiKey || (!imageForm.apiKey.trim() && !appView?.imageApi?.apiKeysConfigured?.includes(imageForm.vendor)))) {
      onError({ message: t('onboarding.compute.apiKeyRequired') }); return
    }
    pending.current = true
    setSaving(true)
    try {
      if (selected === 'cloud-api') {
        const saved = await saveAppSettings(buildImageApiPatch(imageForm, appView))
        if (!saved.ok || !saved.data?.settings) { onError(saved); return }
      }
      const result = await saveSettings({
        provider: selected,
        ...(selected === 'kaggle' ? { kaggleTransport: 'direct', accelerator: 'NvidiaTeslaT4' } : {}),
        ...(selected === 'colab' ? { colabGpu: 'T4', colabHighRam: false } : {}),
        ...(['kaggle', 'colab'].includes(selected) ? { idleTimeoutSec: 1800 } : {}),
      })
      if (!mounted.current) return
      if (!settingsViewOf(result)) { onError(result); return }
      onDone(selected)
    } finally { pending.current = false; if (mounted.current) setSaving(false) }
  }

  function selectProvider(id) {
    onError(null)
    setSelected(id)
    onSelect?.(id)
  }

  return (
    <div className="ofs-onboarding-paths">
      <div className="ofs-onboarding-path-choices" role="group" aria-label={t('onboarding.compute.choose')}>
        {OPTIONS.map((id) => (
          <button type="button" key={id} className={selected === id ? 'is-selected' : ''} aria-pressed={selected === id} disabled={saving || localWorking || ACTIVE_SETUP.includes(setup?.phase)} onClick={() => selectProvider(id)}>
            <ProviderIcon id={id} size={27} />
            <span><strong>{t(`onboarding.path.${id}.title`)}</strong><span>{t(`onboarding.path.${id}.description`)}</span></span>
            <Icon name="chevronRight" size={16} />
          </button>
        ))}
        <button type="button" className={`ofs-onboarding-other-path${selected === 'cloud-api' ? ' is-selected' : ''}`} aria-pressed={selected === 'cloud-api'} disabled={saving || localWorking || ACTIVE_SETUP.includes(setup?.phase)} onClick={() => selectProvider('cloud-api')}>
          <ProviderIcon id="cloud-api" size={16} />
          <span>{t('onboarding.compute.other')}</span>
          <Icon name="chevronRight" size={14} />
        </button>
        <p className="ofs-onboarding-path-note">{t('onboarding.compute.onlyOne')}</p>
      </div>

      <section className="ofs-onboarding-path-detail" aria-live="polite">
        {!selected ? (
          <div className="ofs-onboarding-path-orbit" aria-hidden="true">
            <svg viewBox="0 0 440 440"><circle cx="220" cy="220" r="155" /><path d="M110 110q220 0 220 220M110 330q0-220 220-220" /></svg>
            <span className="ofs-onboarding-path-orbit-center"><Icon name="image" size={35} /><strong>{t('onboarding.compute.yourWork')}</strong></span>
            <span className="ofs-onboarding-orbit-name is-kaggle">Kaggle</span><span className="ofs-onboarding-orbit-name is-colab">Colab</span><span className="ofs-onboarding-orbit-name is-local">{t('onboarding.compute.local.title')}</span>
          </div>
        ) : (
          <>
            <span className="ofs-onboarding-path-mark"><ProviderIcon id={selected} size={66} /></span>
            <h2>{t(`onboarding.path.${selected}.setupTitle`)}</h2>
            <p>{t(`onboarding.path.${selected}.setupDescription`)}</p>

            {['kaggle', 'colab'].includes(selected) ? (
              <>
                {authorized && !login?.pending ? <div className="ofs-onboarding-inline-status"><Icon name="check" size={16} />{t('onboarding.compute.authorized')}</div> : null}
                {login?.pending ? <div className="ofs-onboarding-inline-status"><Icon name="clock" size={16} />{t('onboarding.compute.waiting')}</div> : null}
                {login?.errorKey ? <p className="ofs-onboarding-error" role="alert">{t(login.errorKey)}</p> : null}
                <OAuthManualPanel t={t} login={login} provider={selected} copyText={ui.copyText} showNotes={false} />
                <div className="ofs-onboarding-path-actions">
                  {login?.pending ? <button type="button" className="ofs-chip" onClick={login.cancel}>{t('studio.guidance.auth.cancel')}</button>
                    : !authorized ? <button type="button" className="ofs-onboarding-primary" disabled={!login || saving} onClick={login?.start}>{t(`onboarding.path.${selected}.login`)}<Icon name="chevronRight" size={16} /></button>
                      : <button type="button" className="ofs-onboarding-primary" disabled={saving} onClick={savePath}>{t('onboarding.compute.continue')}<Icon name="chevronRight" size={16} /></button>}
                </div>
                <p className="ofs-onboarding-path-defaults">{t(selected === 'kaggle' ? 'onboarding.path.kaggle.defaults' : 'onboarding.path.colab.defaults')}</p>
              </>
            ) : null}

            {selected === 'local-gpu' ? (
              <>
                {setup?.message ? <p className="ofs-onboarding-inline-status" role="status">{setup.message}</p> : null}
                {setupActive ? (
                  <div className="ofs-onboarding-download" role="status">
                    <span>{t(`onboarding.setup.${setup.phase}`)}</span>
                    {setup.totalBytes > 0 ? <><progress value={setup.downloadedBytes || 0} max={setup.totalBytes} /><small>{Math.round(100 * Math.min(1, (setup.downloadedBytes || 0) / setup.totalBytes))}%</small></> : null}
                  </div>
                ) : null}
                {setupActive ? <button type="button" className="ofs-chip" disabled={localWorking} onClick={() => prepareLocal('cancel')}>{t('studio.guidance.auth.cancel')}</button>
                  : <button type="button" className="ofs-onboarding-primary" disabled={saving || localWorking || setup?.supported === false} onClick={() => ready ? savePath() : prepareLocal('start')}>{t(ready ? 'onboarding.compute.continue' : 'onboarding.path.local-gpu.prepare')}<Icon name="chevronRight" size={16} /></button>}
                {setup?.supported === false ? <p className="ofs-onboarding-error">{t('onboarding.setup.unsupported')}</p> : null}
                <p className="ofs-onboarding-path-defaults">{t('onboarding.path.local-gpu.defaults')}</p>
              </>
            ) : null}

            {selected === 'cloud-api' ? (
              <>
                <fieldset disabled={saving} className="ofs-onboarding-form"><SettingsCloudApiSection t={t} form={imageForm} view={appView?.imageApi} onPatch={(patch) => setImageForm((previous) => ({ ...previous, ...(patch.vendor ? imageApiVendorSwitchPatch(patch.vendor, appView?.imageApi) : {}), ...patch }))} /></fieldset>
                <button type="button" className="ofs-onboarding-primary" disabled={saving} onClick={savePath}>{t('onboarding.compute.continue')}<Icon name="chevronRight" size={16} /></button>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}
