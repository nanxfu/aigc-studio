/**
 * 设置弹窗的独立客户端页面：「创作助手」与「外观与通用」（数据来自 /api/app-settings）。
 *
 * 设计原则（去噪、降负、单次聚焦）：
 *  - 「创作助手」只保留 1 条状态摘要 + 服务商 / API Key / 模型三个核心字段，
 *    接口地址（Base URL）等低频选项收进可折叠行；删除装饰性副标题与多层提示胶囊。
 *  - 11 家服务商均配单色矢量品牌图标（ProviderIcon），提升扫描与辨识度。
 *  - 「外观与通用」语言与主题点选即保存生效，不设置多余保存按钮。
 */

import React from 'react'

import {
  APP_LANGUAGES,
  APP_THEMES,
  LLM_PROVIDER_GROUPS,
  effectiveBaseUrlOf,
  groupedProviders,
  isCustomBaseUrl,
  providerMetaFromView,
  searchProviders,
} from '../../logic/appSettings.js'
import { formatText } from '../../logic/format.js'
import { settingsErrorText } from '../../logic/settings.js'
import { Icon } from '../icons.jsx'
import { ProviderIcon } from './providerIcons.jsx'

/** 模型列表来源 → 文案键（仅在拉取警告或错误时按需补充）。 */
const MODEL_SOURCE_KEYS = {
  remote: 'settings.llm.model.source.remote',
  catalog: 'settings.llm.model.source.catalog',
  mixed: 'settings.llm.model.source.mixed',
}

function errorDetail(t, error) {
  const text = settingsErrorText(t, error)
  return text ? ` · ${text}` : ''
}

function groupLabelKey(groupId) {
  const known = LLM_PROVIDER_GROUPS.some((group) => group.id === groupId)
  return `settings.llm.group.${known ? groupId : 'local'}`
}

/**
 * 可模糊搜索的 Provider 选择器（带品牌图标）。
 */
function ProviderCombobox({ t, view, value, onSelect }) {
  const meta = providerMetaFromView(view, value)
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)

  const matched = searchProviders(view, query)
  const groups = groupedProviders(view)
    .map((group) => ({ ...group, providers: group.providers.filter((item) => matched.some((hit) => hit.id === item.id)) }))
    .filter((group) => group.providers.length > 0)
  const flat = groups.flatMap((group) => group.providers)

  React.useEffect(() => {
    if (!open) return
    setActive(0)
  }, [open, query])

  function choose(id) {
    if (!id) return
    onSelect(id)
    setOpen(false)
    setQuery('')
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (flat.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + delta + flat.length) % flat.length)
      return
    }
    if (event.key === 'Enter') {
      if (!open) {
        setOpen(true)
        return
      }
      const target = flat[active]
      if (target) {
        event.preventDefault()
        choose(target.id)
      }
    }
  }

  return (
    <div className="ofs-settings-field ofs-settings-combobox" data-open={open ? '1' : '0'}>
      <span className="ofs-settings-label">{t('settings.llm.provider.label')}</span>
      <div className="ofs-settings-input-wrap">
        <span className="ofs-settings-input-icon">
          <ProviderIcon id={meta.id} size={16} />
        </span>
        <input
          className="ofs-settings-input has-icon"
          type="text"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-label={t('settings.llm.provider.label')}
          value={open ? query : meta.label}
          placeholder={t('settings.llm.provider.search')}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        <span className="ofs-settings-input-chevron" aria-hidden="true">
          <Icon name="chevronDown" size={14} />
        </span>
      </div>
      {open ? (
        <div className="ofs-settings-menu" role="listbox" aria-label={t('settings.llm.provider.label')}>
          {flat.length === 0 ? (
            <p className="ofs-settings-menu-empty">{t('settings.llm.provider.noMatch')}</p>
          ) : null}
          {groups.map((group) => (
            <div className="ofs-settings-menu-group" key={group.id}>
              <span className="ofs-settings-menu-title">{t(groupLabelKey(group.id))}</span>
              {group.providers.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  role="option"
                  aria-selected={item.id === value}
                  data-provider-id={item.id}
                  className={[
                    'ofs-settings-menu-item',
                    item.id === value ? 'is-on' : '',
                    flat[active] && flat[active].id === item.id ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(item.id)
                  }}
                >
                  <ProviderIcon id={item.id} size={15} />
                  <span className="ofs-settings-menu-label">{item.label}</span>
                  <span className="ofs-settings-menu-hint">{item.id}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 模型选择器：可自由输入 + 下拉过滤 + 一键获取模型。
 */
function ModelCombobox({ t, form, models, loading, error, source, warning, onPatch, onFetchModels }) {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const [query, setQuery] = React.useState('')
  const needle = query.trim().toLowerCase()
  const matched = React.useMemo(() => {
    const list = Array.isArray(models) ? models : []
    if (!needle) return list
    return list.filter((item) => (
      item.id.toLowerCase().includes(needle) || String(item.name || '').toLowerCase().includes(needle)
    ))
  }, [models, needle])
  const visible = matched.slice(0, 60)

  React.useEffect(() => {
    setActive(0)
  }, [needle, open])

  function choose(model) {
    if (!model) return
    onPatch({ model: model.id })
    setQuery('')
    setOpen(false)
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open || visible.length === 0) return
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((index) => (index + delta + visible.length) % visible.length)
      return
    }
    if (event.key === 'Enter' && open && visible[active]) {
      event.preventDefault()
      choose(visible[active])
    }
  }

  return (
    <div className="ofs-settings-field ofs-settings-combobox" data-open={open ? '1' : '0'}>
      <div className="ofs-settings-label-row">
        <span className="ofs-settings-label">{t('settings.llm.model.label')}</span>
        {source && MODEL_SOURCE_KEYS[source] ? (
          <span className="ofs-settings-muted">{t(MODEL_SOURCE_KEYS[source])}</span>
        ) : null}
      </div>
      <div className="ofs-settings-inline">
        <input
          className="ofs-settings-input ofs-grow"
          type="text"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-label={t('settings.llm.model.label')}
          value={form.model}
          placeholder={t('settings.llm.model.placeholder')}
          onFocus={() => {
            setQuery('')
            setOpen(true)
          }}
          onChange={(event) => {
            onPatch({ model: event.target.value })
            setQuery(event.target.value)
            setOpen(true)
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="ofs-chip ofs-settings-fetch"
          aria-busy={loading}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setOpen(true)
            if (typeof onFetchModels === 'function') onFetchModels()
          }}
          disabled={loading}
        >
          {loading ? t('settings.llm.model.fetching') : t('settings.llm.model.fetch')}
        </button>
      </div>

      {open && visible.length > 0 ? (
        <div className="ofs-settings-menu" role="listbox" aria-label={t('settings.llm.model.label')}>
          {visible.map((model, index) => (
            <button
              type="button"
              key={model.id}
              role="option"
              aria-selected={model.id === form.model}
              data-model-id={model.id}
              className={[
                'ofs-settings-menu-item',
                model.id === form.model ? 'is-on' : '',
                index === active ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              onMouseDown={(event) => {
                event.preventDefault()
                choose(model)
              }}
            >
              <span className="ofs-settings-menu-label">{model.name || model.id}</span>
              {model.reasoning ? <span className="ofs-settings-menu-flag">{t('settings.llm.model.reasoning')}</span> : null}
              {model.vision ? <span className="ofs-settings-menu-flag">{t('settings.llm.model.vision')}</span> : null}
              <span className="ofs-settings-menu-hint">{model.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      {warning ? <p className="ofs-settings-muted ofs-settings-warning">{warning}</p> : null}
      {error ? (
        <p className="ofs-settings-error" role="alert">
          {t('settings.llm.model.fetchFailed')}
          {errorDetail(t, error)}
        </p>
      ) : null}
    </div>
  )
}

/**
 * 「创作助手」页内容（无独立保存按钮，由弹窗统一底部操作 bar 提交）。
 */
export function SettingsLlmSection({
  t,
  status,
  loadError = null,
  onRetry = null,
  form,
  view,
  onPatch,
  models = [],
  modelsLoading = false,
  modelsError = null,
  modelsSource = '',
  modelsWarning = '',
  onFetchModels = null,
}) {
  const [baseUrlOpen, setBaseUrlOpen] = React.useState(false)

  if (status === 'error') {
    return (
      <div className="ofs-settings-error-state">
        <p className="ofs-settings-error" role="alert">
          {t('settings.llm.loadFailed')}
          {errorDetail(t, loadError)}
        </p>
        {onRetry ? (
          <button type="button" className="ofs-chip" onClick={onRetry}>
            {t('studio.settings.retry')}
          </button>
        ) : null}
      </div>
    )
  }

  if (status !== 'ready' || !form) {
    return <p className="ofs-settings-note">{t('settings.llm.loading')}</p>
  }

  const llm = view && view.llm && typeof view.llm === 'object' ? view.llm : {}
  const hasApiKey = llm.hasApiKey === true
  const savedMeta = providerMetaFromView(view, llm.provider || form.provider)
  const configured = typeof llm.configured === 'boolean'
    ? llm.configured
    : Boolean(llm.model && (hasApiKey || savedMeta.requiresKey === false))
  const meta = providerMetaFromView(view, form.provider)
  const baseUrlCustom = isCustomBaseUrl(meta, form.baseUrl)
  const showBaseUrl = baseUrlOpen || baseUrlCustom || form.provider === 'custom'
  const effectiveBaseUrl = effectiveBaseUrlOf(meta, form.baseUrl)

  return (
    <div className="ofs-settings-pane">
      {/* 顶部一行连通状态：代替大段解释文案 */}
      <div className={`ofs-settings-status${configured ? ' is-ready' : ''}`}>
        <span className={`ofs-dot ${configured ? 'is-ok' : 'is-idle'}`} aria-hidden="true" />
        {configured ? <ProviderIcon id={savedMeta.id} size={14} /> : null}
        <span className="ofs-settings-status-text">
          {configured
            ? formatText(t('settings.llm.status.ready'), { provider: savedMeta.label, model: llm.model })
            : t('settings.llm.status.unconfigured')}
        </span>
      </div>

      <ProviderCombobox
        t={t}
        view={view}
        value={form.provider}
        onSelect={(id) => onPatch({ provider: id, selectProvider: true })}
      />

      <div className="ofs-settings-field">
        <div className="ofs-settings-label-row">
          <span className="ofs-settings-label">{t('settings.llm.apiKey.label')}</span>
          {meta.requiresKey === false ? (
            <span className="ofs-settings-muted">{t('settings.llm.optional')}</span>
          ) : form.clearApiKey ? (
            <span className="ofs-settings-muted">{t('settings.llm.apiKey.clearPending')}</span>
          ) : hasApiKey ? (
            <button
              type="button"
              className="ofs-settings-text-btn"
              onClick={() => onPatch({ apiKey: '', clearApiKey: true })}
            >
              {t('settings.llm.apiKey.clear')}
            </button>
          ) : null}
        </div>
        <input
          className="ofs-settings-input"
          type="password"
          autoComplete="off"
          aria-label={t('settings.llm.apiKey.label')}
          value={form.apiKey}
          placeholder={hasApiKey ? t('settings.llm.apiKey.placeholderSet') : t('settings.llm.apiKey.placeholder')}
          onChange={(event) => onPatch({ apiKey: event.target.value, clearApiKey: false })}
          onBlur={() => {
            const typed = typeof form.apiKey === 'string' ? form.apiKey.trim() : ''
            if (typed && typeof onFetchModels === 'function' && models.length === 0) onFetchModels()
          }}
        />
      </div>

      <ModelCombobox
        t={t}
        form={form}
        models={models}
        loading={modelsLoading}
        error={modelsError}
        source={modelsSource}
        warning={modelsWarning}
        onPatch={onPatch}
        onFetchModels={onFetchModels}
      />

      {/* 接口地址折叠：默认收起，只给一条轻链接按需覆盖 */}
      <div className="ofs-settings-field">
        <div className="ofs-settings-label-row">
          <button
            type="button"
            className="ofs-settings-text-btn"
            onClick={() => setBaseUrlOpen((value) => !value)}
          >
            {showBaseUrl ? t('settings.llm.baseUrl.hide') : t('settings.llm.baseUrl.edit')}
          </button>
          {!showBaseUrl && effectiveBaseUrl ? (
            <span className="ofs-settings-muted ofs-settings-endpoint">{effectiveBaseUrl}</span>
          ) : null}
        </div>
        {showBaseUrl ? (
          <input
            className="ofs-settings-input"
            type="url"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('settings.llm.baseUrl.label')}
            value={form.baseUrl}
            placeholder={effectiveBaseUrl || t('settings.llm.baseUrl.placeholder')}
            onChange={(event) => onPatch({ baseUrl: event.target.value })}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * 「外观与通用」页内容：语言与主题，点选即生效保存。
 */
export function SettingsUiSection({ t, status, loadError = null, onRetry = null, form, saving, error, onChange }) {
  if (status === 'error') {
    return (
      <div className="ofs-settings-error-state">
        <p className="ofs-settings-error" role="alert">
          {t('settings.llm.loadFailed')}
          {errorDetail(t, loadError)}
        </p>
        {onRetry ? (
          <button type="button" className="ofs-chip" onClick={onRetry}>
            {t('studio.settings.retry')}
          </button>
        ) : null}
      </div>
    )
  }

  if (status !== 'ready' || !form) {
    return <p className="ofs-settings-note">{t('settings.llm.loading')}</p>
  }

  return (
    <div className="ofs-settings-pane">
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
              <span className={`ofs-theme-swatch is-${id}`} aria-hidden="true" />
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
    </div>
  )
}
