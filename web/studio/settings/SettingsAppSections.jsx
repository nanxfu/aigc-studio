/**
 * 设置抽屉的独立客户端区块：「创作助手模型」与「界面」。
 *
 * 数据来自 GET/POST /api/app-settings（与运行设置 /api/settings 分开）：
 *  - 模型区块有独立保存按钮，只提交改动字段；apiKey 留空保持不变，清除走 clearLlmApiKey；
 *  - 界面区块选完即保存（语言 / 主题是短值），保存失败回退到服务端已确认的值并展示错误。
 *
 * 只负责渲染与字段变更回调，读取 / 保存的请求编排在 SettingsDrawer 里。
 */

import React from 'react'

import {
  APP_LANGUAGES,
  APP_THEMES,
  LLM_PROVIDERS,
} from '../../logic/appSettings.js'
import { settingsErrorText } from '../../logic/settings.js'

/** API Key 来源 → 文案键；未知来源按「已配置」处理，不展示原始值。 */
const API_KEY_SOURCE_KEYS = {
  settings: 'settings.llm.apiKey.source.settings',
  config: 'settings.llm.apiKey.source.config',
  none: 'settings.llm.apiKey.source.none',
}

function errorDetail(t, error) {
  const text = settingsErrorText(t, error)
  return text ? ` · ${text}` : ''
}

/** 「创作助手模型」：provider / Base URL / Model / API Key（密码框 + 已配置提示 + 清除）。 */
export function SettingsLlmSection({
  t,
  status,
  form,
  view,
  saving,
  error,
  canSave,
  onPatch,
  onSave,
}) {
  const llm = view && view.llm && typeof view.llm === 'object' ? view.llm : {}
  const hasApiKey = llm.hasApiKey === true
  const sourceKey = API_KEY_SOURCE_KEYS[llm.apiKeySource] || API_KEY_SOURCE_KEYS.settings

  return (
    <section className="ofs-settings-section">
      <h3 className="ofs-settings-section-title">{t('settings.llm.title')}</h3>

      {status === 'loading' ? <p className="ofs-settings-muted">{t('settings.llm.loading')}</p> : null}

      {status === 'ready' && form ? (
        <>
          <p className="ofs-settings-muted">{t('settings.llm.hint')}</p>

          <label className="ofs-settings-field">
            <span className="ofs-settings-label">{t('settings.llm.provider.label')}</span>
            <select
              className="ofs-settings-input"
              value={form.provider}
              onChange={(event) => onPatch({ provider: event.target.value })}
              aria-label={t('settings.llm.provider.label')}
            >
              {LLM_PROVIDERS.map((id) => (
                <option key={id} value={id}>{t(`settings.llm.provider.${id}`)}</option>
              ))}
            </select>
          </label>

          <label className="ofs-settings-field">
            <span className="ofs-settings-label">{t('settings.llm.baseUrl.label')}</span>
            <input
              className="ofs-settings-input"
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={form.baseUrl}
              placeholder={t('settings.llm.baseUrl.placeholder')}
              onChange={(event) => onPatch({ baseUrl: event.target.value })}
            />
          </label>

          <label className="ofs-settings-field">
            <span className="ofs-settings-label">{t('settings.llm.model.label')}</span>
            <input
              className="ofs-settings-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={form.model}
              placeholder={t('settings.llm.model.placeholder')}
              onChange={(event) => onPatch({ model: event.target.value })}
            />
          </label>

          <label className="ofs-settings-field">
            <span className="ofs-settings-label">{t('settings.llm.apiKey.label')}</span>
            <input
              className="ofs-settings-input"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              placeholder={hasApiKey ? t('settings.llm.apiKey.placeholderSet') : t('settings.llm.apiKey.placeholder')}
              onChange={(event) => onPatch({ apiKey: event.target.value, clearApiKey: false })}
            />
          </label>

          {hasApiKey ? (
            <div className="ofs-settings-inline">
              <span className="ofs-settings-muted">
                {t('settings.llm.apiKey.configured')} · {t(sourceKey)}
              </span>
              {form.clearApiKey ? (
                <span className="ofs-settings-muted">{t('settings.llm.apiKey.clearPending')}</span>
              ) : (
                <button
                  type="button"
                  className="ofs-chip ofs-settings-clear"
                  onClick={() => onPatch({ apiKey: '', clearApiKey: true })}
                >
                  {t('settings.llm.apiKey.clear')}
                </button>
              )}
            </div>
          ) : (
            <p className="ofs-settings-muted">{t('settings.llm.apiKey.hint')}</p>
          )}

          {error ? (
            <p className="ofs-settings-error" role="alert">
              {t('settings.llm.saveFailed')}
              {errorDetail(t, error)}
            </p>
          ) : null}

          <div className="ofs-settings-inline">
            <span className="ofs-grow" />
            <button
              type="button"
              className="ofs-btn is-primary ofs-settings-save"
              disabled={!canSave}
              aria-busy={saving}
              onClick={onSave}
            >
              {saving ? t('studio.settings.saving') : t('settings.llm.save')}
            </button>
          </div>
        </>
      ) : null}
    </section>
  )
}

/** 「界面」：语言（zh/en）与主题（light/dark/system），选择即保存。 */
export function SettingsUiSection({ t, status, form, saving, error, onChange }) {
  if (status !== 'ready' || !form) return null
  return (
    <section className="ofs-settings-section">
      <h3 className="ofs-settings-section-title">{t('settings.ui.title')}</h3>
      <p className="ofs-settings-muted">{t('settings.ui.hint')}</p>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('settings.ui.language.label')}</span>
        <div className="ofs-settings-options" role="radiogroup" aria-label={t('settings.ui.language.label')}>
          {APP_LANGUAGES.map((id) => (
            <label key={id} className={`ofs-settings-option${form.lang === id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="ofs-app-language"
                value={id}
                checked={form.lang === id}
                disabled={saving}
                onChange={() => onChange({ lang: id })}
              />
              <span>{t(`settings.ui.language.${id}`)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('settings.ui.theme.label')}</span>
        <div className="ofs-settings-options" role="radiogroup" aria-label={t('settings.ui.theme.label')}>
          {APP_THEMES.map((id) => (
            <label key={id} className={`ofs-settings-option${form.theme === id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="ofs-app-theme"
                value={id}
                checked={form.theme === id}
                disabled={saving}
                onChange={() => onChange({ theme: id })}
              />
              <span>{t(`settings.ui.theme.${id}`)}</span>
            </label>
          ))}
        </div>
      </div>

      {error ? (
        <p className="ofs-settings-error" role="alert">
          {t('settings.ui.saveFailed')}
          {errorDetail(t, error)}
        </p>
      ) : null}
    </section>
  )
}

/** 两个独立客户端区块的组合：读取失败时只替换成「读取失败 + 重试」，不影响运行设置表单。 */
export function SettingsAppSections(props) {
  const { t, status, loadError, onRetry } = props
  if (status === 'error') {
    return (
      <div className="ofs-settings-form">
        <section className="ofs-settings-section">
          <h3 className="ofs-settings-section-title">{t('settings.llm.title')}</h3>
          <p className="ofs-settings-error" role="alert">
            {t('settings.llm.loadFailed')}
            {errorDetail(t, loadError)}
          </p>
          <button type="button" className="ofs-chip ofs-settings-clear" onClick={onRetry}>
            {t('studio.settings.retry')}
          </button>
        </section>
      </div>
    )
  }
  return (
    <div className="ofs-settings-form">
      <SettingsLlmSection
        t={t}
        status={status}
        form={props.form}
        view={props.view}
        saving={props.saving}
        error={props.error}
        canSave={props.canSave}
        onPatch={props.onPatch}
        onSave={props.onSave}
      />
      <SettingsUiSection
        t={t}
        status={status}
        form={props.uiForm}
        saving={props.uiSaving}
        error={props.uiError}
        onChange={props.onChangeUi}
      />
    </div>
  )
}
