/**
 * 居中双栏设置弹窗：左侧分类导航（创作助手 / 云端算力 / 外观与通用），右侧表单与统一保存条。
 *
 * 重构要点：
 *  - 告别窄抽屉的垂直长香肠瀑布流与双保存按钮打架；
 *  - 每个页签聚焦一件事，统一使用单一底部操作栏（外观页选完即保存，不放多余按钮）；
 *  - 两组数据继续独立走 `/api/app-settings`（助手模型 / 外观）与 `/api/settings`（云端算力）。
 *
 * 兼容：保留 `SettingsDrawer` 导出名与既有 props（defaultAdvancedOpen / defaultDraft 仍生效）。
 */

import React from 'react'

import { Icon } from './icons.jsx'
import { controlLocalGpuSetup, fetchLocalGpuConfig, fetchLocalGpuSetup, fetchLocalHardware, probeLocalGpuConfig } from '../api/localModels.js'
import { fetchAppSettings, fetchLlmModels, fetchSettings, probeSalad, probeWorker, saveAppSettings, saveSettings } from '../api/resources.js'
import { setLanguage } from '../i18n.js'
import { useFocusTrap } from './hooks/useFocusTrap.js'
import { useSlidingThumb } from './hooks/useSlidingThumb.js'
import { SettingsLlmSection, SettingsUiSection } from './settings/SettingsAppSections.jsx'
import { SettingsForm } from './settings/SettingsForm.jsx'
import { SettingsLocalModelsSection } from './settings/SettingsLocalModelsSection.jsx'
import { SettingsUpdateSection } from './settings/SettingsUpdateSection.jsx'
import { formatText } from '../logic/format.js'
import { normalizeLocalGpuView } from '../logic/localGpu.js'
import {
  appSettingsViewOf,
  buildImageApiPatch,
  buildLlmPatch,
  buildSaladPatch,
  buildUiPatch,
  buildWorkerPatch,
  hasAppSettingsChanges,
  imageApiFormOf,
  imageApiVendorSwitchPatch,
  llmFormOf,
  providerSwitchPatch,
  saladFormOf,
  uiFormOf,
  workerFormOf,
} from '../logic/appSettings.js'
import {
  buildSettingsPayload,
  formFromSettings,
  hasSettingsChanges,
  hfTokenSourceKey,
  settingsErrorText,
  settingsViewOf,
  validateSettingsForm,
} from '../logic/settings.js'

const SETTINGS_TABS = [
  { id: 'assistant', icon: 'sparkles', labelKey: 'settings.nav.assistant' },
  { id: 'compute', icon: 'sliders', labelKey: 'settings.nav.compute' },
  { id: 'local-models', icon: 'folder', labelKey: 'settings.nav.localModels' },
  { id: 'appearance', icon: 'sun', labelKey: 'settings.nav.appearance' },
  { id: 'update', icon: 'download', labelKey: 'settings.nav.update' },
]

export function SettingsDrawer(props) {
  const { t, ui, colabAuth = null, colabLogin = null, copyText = null, onClose, onSaved = null, onAppearanceChange = null, exiting } = props
  const { defaultAdvancedOpen, defaultDraft, defaultTab } = props
  const panelRef = React.useRef(null)
  const closeRef = React.useRef(null)
  const navRef = React.useRef(null)
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  // 显式指定 defaultTab 优先；预览/测试传入云端高级区或运行设置草稿时自动定位到「云端算力」。
  const initialTab = defaultTab || (defaultAdvancedOpen || defaultDraft ? 'compute' : 'assistant')
  const [activeTab, setActiveTab] = React.useState(initialTab)
  const hasSwitchedTabRef = React.useRef(false)
  useSlidingThumb(navRef, activeTab)

  const [status, setStatus] = React.useState('loading')
  const [view, setView] = React.useState(null)
  const [form, setForm] = React.useState(null)
  const [loadError, setLoadError] = React.useState(null)
  const [saveError, setSaveError] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [advancedOpen, setAdvancedOpen] = React.useState(Boolean(defaultAdvancedOpen))
  const [reloadKey, setReloadKey] = React.useState(0)

  const [appStatus, setAppStatus] = React.useState('loading')
  const [appView, setAppView] = React.useState(null)
  const [appLoadError, setAppLoadError] = React.useState(null)
  const [appReloadKey, setAppReloadKey] = React.useState(0)
  const [llmForm, setLlmForm] = React.useState(null)
  const [llmSaving, setLlmSaving] = React.useState(false)
  const [llmError, setLlmError] = React.useState(null)
  const [uiForm, setUiForm] = React.useState(null)
  const [uiSaving, setUiSaving] = React.useState(false)
  const [uiError, setUiError] = React.useState(null)
  const [workerForm, setWorkerForm] = React.useState(null)
  const [imageApiForm, setImageApiForm] = React.useState(null)
  const [saladForm, setSaladForm] = React.useState(null)
  const [workerProbe, setWorkerProbe] = React.useState(null)
  const [workerProbing, setWorkerProbing] = React.useState(false)
  const [saladProbe, setSaladProbe] = React.useState(null)
  const [saladProbing, setSaladProbing] = React.useState(false)
  const [localGpuView, setLocalGpuView] = React.useState(null)
  const [localGpuProbe, setLocalGpuProbe] = React.useState(null)
  const [localGpuProbing, setLocalGpuProbing] = React.useState(false)
  const [localGpuSetup, setLocalGpuSetup] = React.useState(null)
  const [localGpuSetupWorking, setLocalGpuSetupWorking] = React.useState(false)
  const [localGpuHardware, setLocalGpuHardware] = React.useState(null)
  const [llmModels, setLlmModels] = React.useState([])
  const [llmModelsLoading, setLlmModelsLoading] = React.useState(false)
  const [llmModelsError, setLlmModelsError] = React.useState(null)
  const [llmModelsSource, setLlmModelsSource] = React.useState('')
  const [llmModelsWarning, setLlmModelsWarning] = React.useState('')
  const modelFetchKeyRef = React.useRef('')
  const modelFetchSeqRef = React.useRef(0)

  React.useEffect(() => {
    let alive = true
    setStatus('loading')
    setLoadError(null)
    fetchSettings().then((result) => {
      if (!alive) return
      const next = settingsViewOf(result)
      if (next) {
        setView(next)
        const base = formFromSettings(next)
        const targetProvider = ui?.settingsTarget?.provider
        const merged = defaultDraft && typeof defaultDraft === 'object' ? { ...base, ...defaultDraft } : base
        setForm(targetProvider ? { ...merged, provider: targetProvider } : merged)
        setStatus('ready')
        return
      }
      setStatus('error')
      setLoadError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
    })
    return () => {
      alive = false
    }
  }, [reloadKey])

  React.useEffect(() => {
    let alive = true
    setAppStatus('loading')
    setAppLoadError(null)
    fetchAppSettings().then((result) => {
      if (!alive) return
      const next = appSettingsViewOf(result)
      if (!next) {
        setAppStatus('error')
        setAppLoadError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
        return
      }
      setAppView(next)
      setLlmForm(llmFormOf(next))
      setUiForm(uiFormOf(next))
      setWorkerForm(workerFormOf(next))
      setSaladForm(saladFormOf(next))
      const baseImageApi = imageApiFormOf(next)
      const targetVendor = ui?.settingsTarget?.vendor
      setImageApiForm(
        targetVendor
          ? { ...baseImageApi, ...imageApiVendorSwitchPatch(targetVendor, next.imageApi) }
          : baseImageApi,
      )
      setAppStatus('ready')
    })
    fetchLocalGpuConfig().then((result) => {
      if (!alive || !result || !result.ok || !result.config) return
      const normalized = normalizeLocalGpuView(result.config)
      setLocalGpuView(normalized)
    }).catch(() => {})
    fetchLocalGpuSetup().then((result) => {
      if (alive && result?.ok && result.setup) setLocalGpuSetup(result.setup)
    }).catch(() => {})
    fetchLocalHardware().then((result) => {
      if (alive && result?.ok && result.hardware) setLocalGpuHardware(result.hardware)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [appReloadKey])

  React.useEffect(() => {
    if (!localGpuSetup || !['probing', 'checking', 'downloading', 'saving'].includes(localGpuSetup.phase)) return undefined
    let alive = true
    let timer = null
    const poll = async () => {
      const result = await fetchLocalGpuSetup()
      if (!alive) return
      if (result?.ok && result.setup) {
        setLocalGpuSetup(result.setup)
        if (['probing', 'checking', 'downloading', 'saving'].includes(result.setup.phase)) timer = setTimeout(poll, 1000)
      } else {
        timer = setTimeout(poll, 2000)
      }
    }
    timer = setTimeout(poll, 450)
    return () => { alive = false; clearTimeout(timer) }
  }, [localGpuSetup?.phase])

  React.useEffect(() => {
    if (localGpuSetup?.phase !== 'ready') return
    let alive = true
    fetchLocalGpuConfig().then((result) => {
      if (!alive || !result?.ok || !result.config) return
      setLocalGpuView(normalizeLocalGpuView(result.config))
    }).catch(() => {})
    return () => { alive = false }
  }, [localGpuSetup?.phase])

  useFocusTrap({ panelRef, initialFocusRef: closeRef, onClose: exiting ? undefined : onClose })

  function patchForm(patch) {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous))
  }

  function patchLlmForm(patch) {
    if (patch && patch.selectProvider === true) {
      const { selectProvider: _ignored, ...rest } = patch
      setLlmForm((previous) => (previous ? { ...previous, ...providerSwitchPatch(appView, rest.provider) } : previous))
      modelFetchKeyRef.current = ''
      modelFetchSeqRef.current += 1
      setLlmModels([])
      setLlmModelsLoading(false)
      setLlmModelsError(null)
      setLlmModelsSource('')
      setLlmModelsWarning('')
      return
    }
    setLlmForm((previous) => (previous ? { ...previous, ...patch } : previous))
  }

  function patchWorkerForm(patch) {
    setWorkerForm((previous) => (previous ? { ...previous, ...patch } : previous))
    setWorkerProbe(null)
  }

  function patchSaladForm(patch) {
    setSaladForm((previous) => (previous ? { ...previous, ...patch } : previous))
    setSaladProbe(null)
  }

  async function testLocalGpu() {
    if (localGpuProbing) return
    setLocalGpuProbing(true)
    setLocalGpuProbe(null)
    const result = await probeLocalGpuConfig({})
    const hardware = await fetchLocalHardware({ refresh: true })
    setLocalGpuProbing(false)
    if (hardware?.ok && hardware.hardware) setLocalGpuHardware(hardware.hardware)
    if (result && result.ok && result.probe) {
      setLocalGpuProbe(result.probe)
      return
    }
    setLocalGpuProbe({
      ok: false,
      errors: [result?.message || t('studio.settings.localGpu.probeFailed')],
      warnings: [],
    })
  }

  async function prepareLocalGpu() {
    if (localGpuSetupWorking || localGpuProbing || saving) return
    setLocalGpuSetupWorking(true)
    const result = await controlLocalGpuSetup('start')
    setLocalGpuSetupWorking(false)
    if (!result?.ok || !result.setup) {
      setLocalGpuSetup((previous) => ({ ...previous, phase: 'error', message: result?.message || t('studio.settings.localGpu.setupUnavailable') }))
      return
    }
    setLocalGpuSetup(result.setup)
    const next = await fetchLocalGpuConfig()
    if (next?.ok && next.config) {
      const normalized = normalizeLocalGpuView(next.config)
      setLocalGpuView(normalized)
    }
  }

  async function cancelLocalGpuSetup() {
    if (localGpuSetupWorking) return
    setLocalGpuSetupWorking(true)
    const result = await controlLocalGpuSetup('cancel')
    setLocalGpuSetupWorking(false)
    if (result?.ok && result.setup) setLocalGpuSetup(result.setup)
  }

  /**
   * 商业生图 API 表单补丁：切换服务商时同时重置模型 / 端点 / Key 输入，
   * 避免把上一家的模型 id 或凭据带到新服务商下。
   */
  function patchImageApiForm(patch) {
    setImageApiForm((previous) => {
      if (!previous) return previous
      if (patch && typeof patch.vendor === 'string') {
        return { ...previous, ...imageApiVendorSwitchPatch(patch.vendor, appView?.imageApi) }
      }
      return { ...previous, ...patch }
    })
  }

  /** 测试连接：直接打 /api/worker/probe；未保存的地址 / Token 也能先验证。 */
  async function testWorker() {
    if (!workerForm || workerProbing) return
    setWorkerProbing(true)
    setWorkerProbe(null)
    const result = await probeWorker({
      endpointUrl: workerForm.endpointUrl,
      token: workerForm.token,
    })
    setWorkerProbing(false)
    const probe = result && result.ok && result.data && result.data.probe && typeof result.data.probe === 'object'
      ? result.data.probe
      : null
    if (probe) {
      setWorkerProbe(probe)
      return
    }
    setWorkerProbe({
      ok: false,
      phase: null,
      protocolVersion: null,
      hardware: null,
      capabilities: null,
      modelId: null,
      error: {
        code: (result && result.code) || 'worker_unreachable',
        message: (result && result.message) || '',
      },
    })
  }

  /** Salad 连接测试：可用未保存的 Key / org / project，只读查询配额。 */
  async function testSalad() {
    if (!saladForm || saladProbing) return
    setSaladProbing(true)
    setSaladProbe(null)
    const result = await probeSalad({
      apiKey: saladForm.apiKey,
      org: saladForm.org,
      project: saladForm.project,
    })
    setSaladProbing(false)
    const probe = result && result.ok && result.data && result.data.probe && typeof result.data.probe === 'object'
      ? result.data.probe
      : null
    if (probe) {
      setSaladProbe(probe)
      return
    }
    setSaladProbe({
      ok: false,
      error: {
        code: (result && result.code) || 'remote_error',
        message: (result && result.message) || '',
      },
    })
  }

  async function fetchModels() {
    if (!llmForm || llmModelsLoading) return
    const key = `${llmForm.provider}|${llmForm.baseUrl || ''}|${llmForm.apiKey ? 'typed' : 'saved'}`
    modelFetchKeyRef.current = key
    const seq = (modelFetchSeqRef.current += 1)
    setLlmModelsLoading(true)
    setLlmModelsError(null)
    setLlmModelsWarning('')
    const result = await fetchLlmModels({
      provider: llmForm.provider,
      baseUrl: llmForm.baseUrl,
      apiKey: llmForm.apiKey,
    })
    if (seq !== modelFetchSeqRef.current || modelFetchKeyRef.current !== key) return
    setLlmModelsLoading(false)
    if (!result.ok) {
      setLlmModels([])
      setLlmModelsSource('')
      setLlmModelsError({ code: result.code || 'internal_error', message: result.message || '' })
      return
    }
    const data = result.data && typeof result.data === 'object' ? result.data : {}
    setLlmModels(Array.isArray(data.models) ? data.models : [])
    setLlmModelsSource(typeof data.source === 'string' ? data.source : '')
    setLlmModelsWarning(typeof data.warning === 'string' ? data.warning : '')
  }

  const validation = form ? validateSettingsForm(form) : { ok: true, errors: [], localModels: {} }
  const payload = form && view ? buildSettingsPayload(form, view) : {}
  const computeDirty = hasSettingsChanges(payload)
  const workerPatch = workerForm && appView ? buildWorkerPatch(workerForm, appView) : {}
  const workerDirty = hasAppSettingsChanges(workerPatch)
  const imageApiPatch = imageApiForm && appView ? buildImageApiPatch(imageApiForm, appView) : {}
  const imageApiDirty = hasAppSettingsChanges(imageApiPatch)
  const saladPatch = saladForm && appView ? buildSaladPatch(saladForm, appView) : {}
  const saladDirty = hasAppSettingsChanges(saladPatch)
  // 私有 Worker 的地址 / Token 与商业生图 API 的服务商 / Key 都走 /api/app-settings
  // （全局加密凭据），本机 GPU 配置走 /api/local-gpu/config，其余算力项走 /api/settings。
  const workerNeedsAppView = Boolean(
    form && (form.provider === 'private-worker' || form.provider === 'cloud-api' || form.provider === 'salad'),
  )
  const canSaveCompute = status === 'ready'
    && Boolean(form)
    && !saving
    && (computeDirty || workerDirty || imageApiDirty || saladDirty)
    && validation.ok
    && (!workerNeedsAppView || appStatus === 'ready')
  const tokenSource = view ? t(hfTokenSourceKey(view.hfTokenSource)) : ''

  const llmPatch = llmForm && appView ? buildLlmPatch(llmForm, appView) : {}
  const assistantDirty = hasAppSettingsChanges(llmPatch)
  const canSaveAssistant = appStatus === 'ready' && Boolean(llmForm) && !llmSaving && assistantDirty

  async function submit() {
    if (!canSaveCompute) return
    setSaving(true)
    setSaveError(null)

    if (workerDirty) {
      const workerResult = await saveAppSettings(workerPatch)
      const nextApp = appSettingsViewOf(workerResult)
      if (!nextApp) {
        setSaving(false)
        setSaveError({
          code: (workerResult && workerResult.code) || 'internal_error',
          message: (workerResult && workerResult.message) || '',
        })
        return
      }
      setAppView(nextApp)
      setWorkerForm(workerFormOf(nextApp))
      setWorkerProbe(null)
    }

    if (imageApiDirty) {
      const imageResult = await saveAppSettings(imageApiPatch)
      const nextApp = appSettingsViewOf(imageResult)
      if (!nextApp) {
        setSaving(false)
        setSaveError({
          code: (imageResult && imageResult.code) || 'internal_error',
          message: (imageResult && imageResult.message) || '',
        })
        return
      }
      setAppView(nextApp)
      setImageApiForm(imageApiFormOf(nextApp))
    }

    if (saladDirty) {
      const saladResult = await saveAppSettings(saladPatch)
      const nextApp = appSettingsViewOf(saladResult)
      if (!nextApp) {
        setSaving(false)
        setSaveError({
          code: (saladResult && saladResult.code) || 'internal_error',
          message: (saladResult && saladResult.message) || '',
        })
        return
      }
      setAppView(nextApp)
      setSaladForm(saladFormOf(nextApp))
      setSaladProbe(null)
    }

    if (computeDirty) {
      const result = await saveSettings(payload)
      const next = settingsViewOf(result)
      if (!next) {
        setSaving(false)
        setSaveError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
        return
      }
      setView(next)
      setForm(formFromSettings(next))
    }
    // 只改了生图 API 的服务商 / 模型或本机 GPU 路径时也要刷新宿主快照：/state 会同步最新 configuredProviders 与 localGpu。
    if (typeof onSaved === 'function' && (computeDirty || workerDirty || imageApiDirty || saladDirty)) void onSaved()

    setSaving(false)
    if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.settings.saved'))
  }

  async function submitLlm() {
    if (!canSaveAssistant) return
    setLlmSaving(true)
    setLlmError(null)
    const result = await saveAppSettings(llmPatch)
    const next = appSettingsViewOf(result)
    setLlmSaving(false)
    if (!next) {
      setLlmError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
      return
    }
    setAppView(next)
    setLlmForm(llmFormOf(next))
    setUiForm(uiFormOf(next))
    modelFetchKeyRef.current = ''
    if (ui && typeof ui.showToast === 'function') ui.showToast(t('settings.llm.saved'))
  }

  async function changeUi(next) {
    if (!uiForm || uiSaving) return
    const target = { ...uiForm, ...next }
    setUiForm(target)
    setUiError(null)
    const patch = buildUiPatch(target)
    if (!hasAppSettingsChanges(patch)) return
    setUiSaving(true)
    const result = await saveAppSettings(patch)
    setUiSaving(false)
    const nextView = appSettingsViewOf(result)
    if (!nextView) {
      setUiError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
      setUiForm(uiFormOf(appView || {}))
      return
    }
    setAppView(nextView)
    setUiForm(uiFormOf(nextView))
    setLlmForm((previous) => previous || llmFormOf(nextView))
    if (ui && typeof ui.showToast === 'function') ui.showToast(t('settings.ui.saved'))
    if (typeof onAppearanceChange === 'function') {
      onAppearanceChange({ lang: nextView.ui.lang, theme: nextView.ui.theme })
    } else {
      setLanguage(nextView.ui.lang)
    }
  }

  function renderComputeLoadError() {
    return (
      <div className="ofs-settings-error-state">
        <p className="ofs-settings-error" role="alert">
          {t('studio.settings.loadFailed')}
          {loadError && (loadError.code || loadError.message) ? ` · ${settingsErrorText(t, loadError)}` : ''}
        </p>
        <button type="button" className="ofs-chip" onClick={() => setReloadKey((value) => value + 1)}>
          {t('studio.settings.retry')}
        </button>
      </div>
    )
  }

  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab) || SETTINGS_TABS[0]
  const tabDirty = {
    assistant: assistantDirty,
    compute: computeDirty || workerDirty || imageApiDirty || saladDirty,
    'local-models': false,
    appearance: false,
    update: false,
  }

  const showFooter =
    (activeTab === 'assistant' && appStatus === 'ready') ||
    (activeTab === 'compute' && status === 'ready')
  const footerSaving = activeTab === 'assistant' ? llmSaving : saving
  const footerCanSave = activeTab === 'assistant' ? canSaveAssistant : canSaveCompute
  const footerSaveLabel = footerSaving
    ? t('studio.settings.saving')
    : activeTab === 'assistant'
      ? t('settings.llm.save')
      : t('studio.settings.save')
  const footerSaveHandler = activeTab === 'assistant' ? submitLlm : submit

  return (
    <div
      className="ofs-settings"
      data-exiting={exiting ? 'true' : undefined}
      role="presentation"
      onClick={() => !exiting && onCloseRef.current && onCloseRef.current()}
    >
      <div
        className="ofs-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('studio.settings.title')}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="ofs-settings-sidebar">
          <div className="ofs-settings-sidebar-head">
            <span className="ofs-settings-title">{t('studio.settings.title')}</span>
          </div>
          <nav className="ofs-settings-nav" ref={navRef} aria-label={t('studio.settings.title')}>
            <span className="ofs-settings-nav-thumb" aria-hidden="true" />
            {SETTINGS_TABS.map((tab) => {
              const isOn = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-settings-tab={tab.id}
                  data-thumb-active={isOn ? 'true' : undefined}
                  aria-current={isOn ? 'page' : undefined}
                  className={`ofs-settings-nav-item${isOn ? ' is-on' : ''}`}
                  onClick={() => {
                    if (tab.id !== activeTab) hasSwitchedTabRef.current = true
                    setActiveTab(tab.id)
                  }}
                >
                  <Icon name={tab.icon} size={15} />
                  <span className="ofs-grow">{t(tab.labelKey)}</span>
                  {tabDirty[tab.id] ? <span className="ofs-dot is-warn" aria-hidden="true" /> : null}
                </button>
              )
            })}
          </nav>
        </aside>

        <div className="ofs-settings-main">
          <header className="ofs-settings-head">
            <h2 className="ofs-settings-head-title">{t(activeTabMeta.labelKey)}</h2>
            <span className="ofs-grow" />
            <button
              ref={closeRef}
              type="button"
              className="ofs-icon-btn"
              onClick={() => !exiting && onCloseRef.current && onCloseRef.current()}
              title={t('studio.settings.close')}
              aria-label={t('studio.settings.close')}
            >
              <Icon name="close" size={16} />
            </button>
          </header>

          <div className="ofs-settings-body">
            <div key={activeTab} className="ofs-settings-pane-wrap" data-pane-enter={hasSwitchedTabRef.current ? 'true' : undefined}>
            {activeTab === 'assistant' ? (
              <SettingsLlmSection
                t={t}
                status={appStatus}
                loadError={appLoadError}
                onRetry={() => setAppReloadKey((value) => value + 1)}
                view={appView}
                form={llmForm}
                onPatch={patchLlmForm}
                models={llmModels}
                modelsLoading={llmModelsLoading}
                modelsError={llmModelsError}
                modelsSource={llmModelsSource}
                modelsWarning={llmModelsWarning}
                onFetchModels={fetchModels}
              />
            ) : null}

            {activeTab === 'compute' ? (
              <>
                {status === 'loading' ? <p className="ofs-settings-note">{t('studio.settings.loading')}</p> : null}
                {status === 'error' ? renderComputeLoadError() : null}
                {status === 'ready' && form ? (
                  <SettingsForm
                    t={t}
                    view={view}
                    form={form}
                    patchForm={patchForm}
                    validation={validation}
                    tokenSource={tokenSource}
                    advancedOpen={advancedOpen}
                    onToggleAdvanced={() => setAdvancedOpen((value) => !value)}
                    colabAuth={colabAuth}
                    colabLogin={colabLogin}
                    copyText={copyText || (ui && ui.copyText) || null}
                    worker={workerForm}
                    workerView={appView && appView.worker ? appView.worker : null}
                    workerProbe={workerProbe}
                    workerProbing={workerProbing}
                    patchWorkerForm={patchWorkerForm}
                    onProbeWorker={testWorker}
                    imageApi={imageApiForm}
                    imageApiView={appView && appView.imageApi ? appView.imageApi : null}
                    patchImageApi={patchImageApiForm}
                    salad={saladForm}
                    saladView={appView && appView.salad ? appView.salad : null}
                    saladProbe={saladProbe}
                    saladProbing={saladProbing}
                    patchSalad={patchSaladForm}
                    onProbeSalad={testSalad}
                    localGpuView={localGpuView}
                    localGpuProbe={localGpuProbe}
                    localGpuProbing={localGpuProbing}
                    localGpuHardware={localGpuHardware}
                    localGpuSetup={localGpuSetup}
                    localGpuSetupWorking={localGpuSetupWorking}
                    saving={saving}
                    onProbeLocalGpu={testLocalGpu}
                    onPrepareLocalGpu={prepareLocalGpu}
                    onCancelLocalGpuSetup={cancelLocalGpuSetup}
                  />
                ) : null}
              </>
            ) : null}

            {activeTab === 'local-models' ? (
              <SettingsLocalModelsSection t={t} />
            ) : null}

            {activeTab === 'appearance' ? (
              <SettingsUiSection
                t={t}
                status={appStatus}
                loadError={appLoadError}
                onRetry={() => setAppReloadKey((value) => value + 1)}
                form={uiForm}
                saving={uiSaving}
                error={uiError}
                onChange={changeUi}
              />
            ) : null}

            {activeTab === 'appearance' && props.onOpenOnboarding ? (
              <div className="ofs-settings-row ofs-onboarding-reopen">
                <div>
                  <span className="ofs-settings-label">{t('onboarding.reopen.title')}</span>
                  <p className="ofs-settings-muted">{t('onboarding.reopen.description')}</p>
                </div>
                <button type="button" className="ofs-chip" onClick={props.onOpenOnboarding}>
                  {t('onboarding.reopen.action')}
                </button>
              </div>
            ) : null}

            {activeTab === 'update' ? (
              <SettingsUpdateSection
                t={t}
                status={appStatus}
                view={appView}
                onView={setAppView}
                onRetry={() => setAppReloadKey((value) => value + 1)}
              />
            ) : null}
            </div>
          </div>

          {showFooter ? (
            <footer className="ofs-settings-foot">
              {activeTab === 'compute' && !validation.ok ? (
                <p className="ofs-settings-error" role="alert">
                  {formatText(t('studio.settings.invalid'), { count: validation.errors.length })}
                </p>
              ) : null}
              {activeTab === 'compute' && saveError ? (
                <p className="ofs-settings-error" role="alert">{settingsErrorText(t, saveError)}</p>
              ) : null}
              {activeTab === 'assistant' && llmError ? (
                <p className="ofs-settings-error" role="alert">
                  {t('settings.llm.saveFailed')}
                  {settingsErrorText(t, llmError) ? ` · ${settingsErrorText(t, llmError)}` : ''}
                </p>
              ) : null}
              <span className="ofs-grow" />
              <button
                type="button"
                className="ofs-chip"
                onClick={() => onCloseRef.current && onCloseRef.current()}
              >
                {t('studio.settings.cancel')}
              </button>
              <button
                type="button"
                className="ofs-btn is-primary ofs-settings-save"
                disabled={!footerCanSave}
                aria-busy={footerSaving}
                onClick={footerSaveHandler}
              >
                {footerSaveLabel}
              </button>
            </footer>
          ) : null}
        </div>
      </div>
    </div>
  )
}
