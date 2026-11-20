/**
 * 设置抽屉：运行设置 + 独立客户端设置（创作助手模型 / 界面），风格对齐 LogsDrawer。
 *
 * 两组数据互相独立：
 *  - 运行设置走 /api/settings：打开时 GET 一次脱敏视图（不轮询），失败给可重试的错误态；
 *    三段落：常规运行 / 模型下载与限流防护 / 高级（默认折叠）；保存只提交真正变化的字段。
 *  - 创作助手模型与界面走 /api/app-settings：与运行设置并行读取，失败只影响这两个新加区块；
 *    模型区块独立保存（apiKey 留空保持不变），界面区块选择即保存。
 *
 * Esc / 遮罩 / 关闭按钮都能关，Tab 在抽屉内循环，关闭后焦点由 useStudioUi 还给触发元素。
 *
 * 接收 { t, ui, onClose } 领域对象；语言 / 主题保存成功后通过 onAppearanceChange 通知入口层
 * （main.jsx 更新 <html lang> 与 data-theme，并重渲染整棵界面）。
 */

import React from 'react'

import { Icon } from './icons.jsx'
import { fetchAppSettings, fetchSettings, saveAppSettings, saveSettings } from '../api/resources.js'
import { setLanguage } from '../i18n.js'
import { useFocusTrap } from './hooks/useFocusTrap.js'
import { SettingsAppSections } from './settings/SettingsAppSections.jsx'
import { SettingsForm } from './settings/SettingsForm.jsx'
import {
  appSettingsViewOf,
  buildLlmPatch,
  buildUiPatch,
  hasAppSettingsChanges,
  llmFormOf,
  uiFormOf,
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

export function SettingsDrawer(props) {
  const { t, ui, colabAuth = null, colabLogin = null, copyText = null, onClose, onAppearanceChange = null } = props
  // 预览 / 渲染测试用：预展开高级区、预填一份未保存的草稿（正式界面不传）。
  const { defaultAdvancedOpen, defaultDraft } = props
  const panelRef = React.useRef(null)
  const closeRef = React.useRef(null)
  // onClose 每次父渲染都会变；用 ref 持有，避免抽屉内部状态变化时重复抢焦点。
  const onCloseRef = React.useRef(onClose)
  onCloseRef.current = onClose

  const [status, setStatus] = React.useState('loading')
  const [view, setView] = React.useState(null)
  const [form, setForm] = React.useState(null)
  const [loadError, setLoadError] = React.useState(null)
  const [saveError, setSaveError] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [advancedOpen, setAdvancedOpen] = React.useState(Boolean(defaultAdvancedOpen))
  const [reloadKey, setReloadKey] = React.useState(0)

  // 全局应用设置（创作助手模型 / 界面）：与运行设置一起读取，但状态与错误互相独立。
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

  // 打开即取一次运行设置；重试由 reloadKey 推进。组件卸下后不再写状态。
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
        setForm(defaultDraft && typeof defaultDraft === 'object' ? { ...base, ...defaultDraft } : base)
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

  // 打开即取一次全局应用设置；失败时新区块自己给「读取失败 + 重试」，不阻塞运行设置。
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
      setAppStatus('ready')
    })
    return () => {
      alive = false
    }
  }, [appReloadKey])

  // Esc 关闭 + Tab 在抽屉内循环；打开时焦点落到关闭按钮。
  useFocusTrap({ panelRef, initialFocusRef: closeRef, onClose })

  function patchForm(patch) {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous))
  }

  function patchLlmForm(patch) {
    setLlmForm((previous) => (previous ? { ...previous, ...patch } : previous))
  }

  const validation = form ? validateSettingsForm(form) : { ok: true, errors: [], localModels: {} }
  const payload = form && view ? buildSettingsPayload(form, view) : {}
  const dirty = hasSettingsChanges(payload)
  const canSave = status === 'ready' && Boolean(form) && !saving && dirty && validation.ok
  const tokenSource = view ? t(hfTokenSourceKey(view.hfTokenSource)) : ''

  // 创作助手模型：只提交真正变化的字段，apiKey 留空表示保持不变。
  const llmPatch = llmForm && appView ? buildLlmPatch(llmForm, appView) : {}
  const llmCanSave = appStatus === 'ready' && Boolean(llmForm) && !llmSaving && hasAppSettingsChanges(llmPatch)

  async function submit() {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    const result = await saveSettings(payload)
    const next = settingsViewOf(result)
    setSaving(false)
    if (next) {
      setView(next)
      setForm(formFromSettings(next))
      if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.settings.saved'))
      return
    }
    setSaveError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
  }

  /** 保存「创作助手模型」：成功后用服务端脱敏视图重建表单（apiKey 继续从空串开始）。 */
  async function submitLlm() {
    if (!llmCanSave) return
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
    if (ui && typeof ui.showToast === 'function') ui.showToast(t('settings.llm.saved'))
  }

  /**
   * 切换语言 / 主题：界面是短值，选完即保存。
   * 失败时回退到服务端已确认的值并展示错误；成功时通知入口层应用语言与主题。
   */
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
    const view = appSettingsViewOf(result)
    if (!view) {
      setUiError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
      setUiForm(uiFormOf(appView || {}))
      return
    }
    setAppView(view)
    setUiForm(uiFormOf(view))
    setLlmForm((previous) => previous || llmFormOf(view))
    if (ui && typeof ui.showToast === 'function') ui.showToast(t('settings.ui.saved'))
    if (typeof onAppearanceChange === 'function') {
      onAppearanceChange({ lang: view.ui.lang, theme: view.ui.theme })
    } else {
      // 独立渲染（预览 / 测试）没有入口层回调时至少更新模块级语言，主题保持原样。
      setLanguage(view.ui.lang)
    }
  }

  /** 错误态：请求失败原因 + 重试按钮，保持抽屉结构可用。 */
  function renderLoadError() {
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

  return (
    <div className="ofs-settings" role="presentation" onClick={() => onCloseRef.current && onCloseRef.current()}>
      <div
        className="ofs-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('studio.settings.title')}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ofs-settings-head">
          <span className="ofs-settings-title">{t('studio.settings.title')}</span>
          <span className="ofs-grow" />
          <button
            ref={closeRef}
            type="button"
            className="ofs-icon-btn"
            onClick={() => onCloseRef.current && onCloseRef.current()}
            title={t('studio.settings.close')}
            aria-label={t('studio.settings.close')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="ofs-settings-body">
          {/* 独立客户端设置：创作助手模型 + 界面（数据来自 /api/app-settings）。 */}
          <SettingsAppSections
            t={t}
            status={appStatus}
            loadError={appLoadError}
            onRetry={() => setAppReloadKey((value) => value + 1)}
            view={appView}
            form={llmForm}
            onPatch={patchLlmForm}
            saving={llmSaving}
            error={llmError}
            canSave={llmCanSave}
            onSave={submitLlm}
            uiForm={uiForm}
            uiSaving={uiSaving}
            uiError={uiError}
            onChangeUi={changeUi}
          />
          {status === 'loading' ? <p className="ofs-settings-note">{t('studio.settings.loading')}</p> : null}
          {status === 'error' ? renderLoadError() : null}
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
              saveError={saveError}
              saving={saving}
              canSave={canSave}
              colabAuth={colabAuth}
              colabLogin={colabLogin}
              copyText={copyText || (ui && ui.copyText) || null}
              onCancel={() => onCloseRef.current && onCloseRef.current()}
              onSubmit={submit}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
