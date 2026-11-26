import React from 'react'

import { fetchAppSettings, fetchLlmModels, saveAppSettings } from '../../api/resources.js'
import { appSettingsViewOf, buildLlmPatch, llmFormOf, providerMetaFromView, providerSwitchPatch } from '../../logic/appSettings.js'
import { settingsErrorText } from '../../logic/settings.js'
import { Icon } from '../icons.jsx'
import { StudioIcon } from '../StudioIcon.jsx'
import { WindowControls } from '../WindowControls.jsx'
import { SettingsLlmSection } from '../settings/SettingsAppSections.jsx'
import { DEMO_FEATURES, OnboardingDemo } from './OnboardingDemo.jsx'
import { OnboardingCompute } from './OnboardingCompute.jsx'

const STEPS = ['discover', 'compute', 'connect', 'create']

export function Onboarding({ t, onClose, defaultStep = 0, defaultFeature = 'translate', compute = {}, ui = {} }) {
  const [step, setStep] = React.useState(defaultStep)
  const [feature, setFeature] = React.useState(defaultFeature)
  const [view, setView] = React.useState(null)
  const [form, setForm] = React.useState(null)
  const [status, setStatus] = React.useState('loading')
  const [error, setError] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [models, setModels] = React.useState([])
  const [modelsLoading, setModelsLoading] = React.useState(false)
  const [modelsError, setModelsError] = React.useState(null)
  const [modelsWarning, setModelsWarning] = React.useState('')
  const [reload, setReload] = React.useState(0)
  const [assistantSaved, setAssistantSaved] = React.useState(false)
  const [selectedPath, setSelectedPath] = React.useState(compute.onboardingProvider || '')
  const [computeBusy, setComputeBusy] = React.useState(false)
  const [reducedMotion, setReducedMotion] = React.useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
  const headingRef = React.useRef(null)
  const mounted = React.useRef(true)
  const busy = React.useRef(false)
  const modelSeq = React.useRef(0)

  React.useEffect(() => {
    mounted.current = true
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const onMotion = () => setReducedMotion(media?.matches === true)
    media?.addEventListener?.('change', onMotion)
    return () => { mounted.current = false; media?.removeEventListener?.('change', onMotion) }
  }, [])

  React.useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  React.useEffect(() => {
    let alive = true
    setStatus('loading')
    fetchAppSettings().then((result) => {
      if (!alive) return
      const next = appSettingsViewOf(result)
      if (!next) { setStatus('error'); setError(result); return }
      const draft = llmFormOf(next)
      draft.model ||= providerMetaFromView(next, draft.provider).defaultModel
      setView(next)
      setForm(draft)
      setAssistantSaved(result.data.settings.llm?.configured === true)
      setStatus('ready')
      setError(null)
    }).catch(() => { if (alive) { setStatus('error'); setError({ code: 'network_error' }) } })
    return () => { alive = false }
  }, [reload])

  function patchForm(patch) {
    modelSeq.current += 1
    setModelsLoading(false)
    setModelsError(null)
    setModelsWarning('')
    setAssistantSaved(false)
    setError(null)
    if (patch.selectProvider) {
      setModels([])
      setForm((previous) => ({ ...previous, ...providerSwitchPatch(view, patch.provider), apiKey: '', clearApiKey: false }))
    } else {
      if ('baseUrl' in patch || 'apiKey' in patch) setModels([])
      setForm((previous) => ({ ...previous, ...patch }))
    }
  }

  async function loadModels() {
    if (!form || modelsLoading || saving) return
    const seq = ++modelSeq.current
    setModelsLoading(true)
    setModelsError(null)
    try {
      const result = await fetchLlmModels(form)
      if (!mounted.current || seq !== modelSeq.current) return
      if (result.ok && Array.isArray(result.data?.models)) {
        setModels(result.data.models)
        setModelsWarning(result.data.warning || '')
      } else setModelsError(result)
    } catch { if (mounted.current && seq === modelSeq.current) setModelsError({ code: 'network_error' }) }
    finally { if (mounted.current && seq === modelSeq.current) setModelsLoading(false) }
  }

  async function saveAssistant() {
    if (!form || busy.current) return
    const meta = providerMetaFromView(view, form.provider)
    if (meta.requiresKey && !form.apiKey.trim() && (!view.llm.hasApiKey || form.clearApiKey || form.provider !== view.llm.provider)) {
      setError({ message: t('onboarding.connect.keyRequired') }); return
    }
    if (!form.model.trim()) {
      setError({ message: t('onboarding.connect.modelRequired') }); return
    }
    if (!form.baseUrl.trim() && !meta.defaultBaseUrl) {
      setError({ message: t('onboarding.connect.urlRequired') }); return
    }
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const result = await saveAppSettings(buildLlmPatch(form, view))
      if (!mounted.current) return
      const next = appSettingsViewOf(result)
      if (!next) { setError(result); return }
      setView(next)
      setForm({ ...llmFormOf(next), model: next.llm.model || providerMetaFromView(next, next.llm.provider).defaultModel })
      setAssistantSaved(result.data.settings.llm?.configured === true)
      setStep(3)
    } catch { if (mounted.current) setError({ code: 'network_error' }) }
    finally { busy.current = false; if (mounted.current) setSaving(false) }
  }

  async function finish(skipped = false, settingsTab) {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      const result = await saveAppSettings({ onboarding: { version: 1, status: skipped ? 'skipped' : 'completed' } })
      if (!mounted.current) return
      if (!appSettingsViewOf(result)) { setError(result); return }
      onClose?.({ settingsTab })
    } catch { if (mounted.current) setError({ code: 'network_error' }) }
    finally { busy.current = false; if (mounted.current) setSaving(false) }
  }

  const errorText = error?.message || (error ? settingsErrorText(t, error) : '') || (error ? t('onboarding.error') : '')

  return (
    <div className="ofs-onboarding">
      <header className="ofs-onboarding-header">
        <span className="ofs-onboarding-brand"><StudioIcon size={23} /><span>AIGC Studio</span></span>
        <div className="ofs-onboarding-header-actions">
          <button type="button" className="ofs-onboarding-text-btn" disabled={saving || computeBusy} onClick={() => finish(true)}>{t('onboarding.skip')}</button>
          <WindowControls t={t} />
        </div>
      </header>

      <div className="ofs-onboarding-scroll">
        <div className="ofs-onboarding-shell">
          <nav aria-label={t('onboarding.progress')}>
            <ol className="ofs-onboarding-progress">
              {STEPS.map((id, index) => (
                <li key={id} className={index === step ? 'is-current' : index < step ? 'is-done' : ''} aria-current={index === step ? 'step' : undefined}>
                  <span>{index < step ? <Icon name="check" size={13} /> : index + 1}</span>{t(`onboarding.step.${id}`)}
                </li>
              ))}
            </ol>
          </nav>

          <main className={`ofs-onboarding-content${step === 3 ? ' is-finish' : ''}${step === 1 ? ' is-compute' : ''}${step === 0 ? ' is-discover' : ''}`}>
            <div className="ofs-onboarding-copy">
              <h1 ref={headingRef} tabIndex={-1}>{t(`onboarding.${STEPS[step]}.title`)}</h1>
              <p className="ofs-onboarding-intro">{t(`onboarding.${STEPS[step]}.description`)}</p>

              {step === 0 ? (
                <div className="ofs-onboarding-features" role="group" aria-label={t('onboarding.features')}>
                  {DEMO_FEATURES.map(({ id, icon }) => (
                    <button key={id} type="button" className={feature === id ? 'is-selected' : ''} aria-pressed={feature === id} onClick={() => setFeature(id)}>
                      <span className="ofs-onboarding-feature-icon"><Icon name={icon} size={19} /></span>
                      <span><strong>{t(`onboarding.feature.${id}.title`)}</strong><span>{t(`onboarding.feature.${id}.description`)}</span></span>
                      <Icon name="chevronRight" size={16} />
                    </button>
                  ))}
                </div>
              ) : null}

              {step === 2 ? (
                <>
                  <fieldset className="ofs-onboarding-form" disabled={saving}>
                    <SettingsLlmSection t={t} status={status} loadError={error} onRetry={() => setReload((value) => value + 1)} view={view} form={form} onPatch={patchForm} models={models} modelsLoading={modelsLoading} modelsError={modelsError} modelsWarning={modelsWarning} onFetchModels={loadModels} />
                  </fieldset>
                  <p className="ofs-onboarding-key-help">{t('onboarding.connect.keyHelp')}</p>
                  <p className="ofs-onboarding-key-help"><Icon name="lock" size={14} />{t('onboarding.connect.privacy')}</p>
                </>
              ) : null}

              {step === 3 ? (
                <>
                  <div className="ofs-onboarding-path-summary"><Icon name={selectedPath ? 'check' : 'clock'} size={19} /><span>{selectedPath ? `${t(`onboarding.path.${selectedPath}.title`)} · ${t('onboarding.compute.saved')}` : t('onboarding.compute.deferred')}</span></div>
                  <div className="ofs-onboarding-assistant-status" role="status">
                    <Icon name={assistantSaved ? 'check' : 'clock'} size={18} />
                    <div><strong>{t(assistantSaved ? 'onboarding.create.connected' : 'onboarding.create.later')}</strong><p>{t(assistantSaved ? 'onboarding.create.connectedHint' : 'onboarding.create.laterHint')}</p></div>
                  </div>
                  <h2>{t('onboarding.create.firstTitle')}</h2>
                  <p className="ofs-onboarding-intro">{t('onboarding.create.firstDescription')}</p>
                  <div className="ofs-onboarding-compute-options">
                    {!selectedPath ? ['local', 'cloud', 'api'].map((id) => (
                      <button type="button" key={id} disabled={saving} onClick={() => finish(false, id === 'local' ? { tab: 'compute', provider: 'local-gpu' } : id === 'api' ? { tab: 'compute', provider: 'cloud-api' } : 'compute')}>
                        <Icon name={id === 'local' ? 'monitor' : id === 'cloud' ? 'cloud' : 'globe'} size={20} />
                        <span><strong>{t(`onboarding.compute.${id}.title`)}</strong><span>{t(`onboarding.compute.${id}.description`)}</span></span>
                        <Icon name="chevronRight" size={16} />
                      </button>
                    )) : <p className="ofs-onboarding-ready-note">{t('onboarding.create.readyNote')}</p>}
                  </div>
                </>
              ) : null}
            </div>

            {step === 0 || step === 2 ? (
              <div className="ofs-onboarding-preview">
                <OnboardingDemo t={t} feature={feature} reducedMotion={reducedMotion} />
                <p>{t(`onboarding.feature.${feature}.caption`)}</p>
              </div>
            ) : null}
            {step === 1 ? <OnboardingCompute t={t} compute={compute} ui={ui} appView={view} initialProvider={selectedPath} onError={setError} onBusyChange={setComputeBusy} onDone={(provider) => { setSelectedPath(provider); compute.refreshState?.(); setError(null); setStep(2) }} /> : null}
          </main>
        </div>
      </div>

      <footer className="ofs-onboarding-footer">
        <div>
          <button type="button" className="ofs-onboarding-text-btn" disabled={step === 0 || saving || computeBusy} onClick={() => { setError(null); setStep((value) => value - 1) }}><Icon name="chevronLeft" size={15} />{t('onboarding.back')}</button>
          {errorText ? <p className="ofs-onboarding-error" role="alert">{errorText}</p> : <span className="ofs-onboarding-footer-hint">{t('onboarding.footerHint')}</span>}
          <div className="ofs-onboarding-footer-actions">
            {step === 1 || step === 2 ? <button type="button" className="ofs-onboarding-text-btn" disabled={saving || computeBusy} onClick={() => { setError(null); setStep((value) => value + 1) }}>{t(step === 1 ? 'onboarding.compute.later' : 'onboarding.connect.later')}</button> : null}
            {step !== 1 ? <button type="button" className="ofs-onboarding-primary" disabled={saving || (step === 2 && status !== 'ready')} onClick={() => step === 0 ? setStep(1) : step === 2 ? saveAssistant() : finish()}>
              {saving ? t('onboarding.saving') : t(`onboarding.${STEPS[step]}.action`)}<Icon name="chevronRight" size={16} />
            </button> : null}
          </div>
        </div>
      </footer>
    </div>
  )
}
