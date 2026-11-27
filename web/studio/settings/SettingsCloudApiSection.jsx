/**
 * 「商业生图 API」设置区：只负责连接与凭据——服务商、API Key、接口地址，
 * 以及自定义端点（OpenAI 兼容网关）的模型 ID。
 *
 * 内置服务商（硅基流动 / fal.ai / OpenAI）不在这里选模型：所有已填 Key 的服务商，
 * 其模型都会汇总到创作页顶栏的模型选择器里。
 */

import React from 'react'

import {
  IMAGE_API_VENDORS,
  IMAGE_API_VENDOR_IDS,
  imageApiVendorOf,
} from '../../../shared/image-providers.js'
import { providerLabelOf } from '../../logic/status.js'
import { Icon } from '../icons.jsx'
import { ProviderIcon } from './providerIcons.jsx'

export function SettingsCloudApiSection({ t, form, view, onPatch }) {
  const [baseUrlOpen, setBaseUrlOpen] = React.useState(false)
  if (!form) return null
  const vendor = imageApiVendorOf(form.vendor) ?? IMAGE_API_VENDORS[IMAGE_API_VENDOR_IDS[0]]
  const configuredVendors = Array.isArray(view?.apiKeysConfigured) ? view.apiKeysConfigured : []
  const keyConfigured = configuredVendors.includes(form.vendor) || (view?.vendor === form.vendor && view?.hasApiKey === true)
  const showCustomModel = vendor.dynamicModel === true
  const showBaseUrl = vendor.id === 'custom' || baseUrlOpen || Boolean(form.baseUrl && form.baseUrl.trim())
  const apiKeyUrl = vendor.apiKeyUrl || ''

  return (
    <div className="ofs-settings-subpanel ofs-cloud-api">
      <div className="ofs-settings-block-head">
        <span className="ofs-settings-block-mark" aria-hidden="true">
          <ProviderIcon id="cloud-api" size={17} />
        </span>
        <span className="ofs-settings-block-copy">
          <span className="ofs-settings-block-title">{providerLabelOf(t, 'cloud-api')}</span>
          <span className="ofs-settings-block-sub">
            {vendor.freeQuota === true ? t('studio.settings.cloudApi.sub.modelscope') : t('studio.settings.cloudApi.sub')}
          </span>
        </span>
      </div>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('studio.settings.cloudApi.vendor')}</span>
        <div className="ofs-settings-options" role="radiogroup" aria-label={t('studio.settings.cloudApi.vendor')}>
          {IMAGE_API_VENDOR_IDS.map((id) => {
            const hasVendorKey = configuredVendors.includes(id)
            return (
              <label key={id} className={`ofs-settings-option${form.vendor === id ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  name="ofs-image-api-vendor"
                  value={id}
                  checked={form.vendor === id}
                  onChange={() => onPatch({ vendor: id })}
                />
                <span>{t(`studio.settings.cloudApi.vendorName.${id}`)}</span>
                {/* 已配标记只在「没选中」时需要：选中项的 Key 状态就写在下面那一行。 */}
                {hasVendorKey && form.vendor !== id ? (
                  <span className="ofs-cloud-api-keytag">{t('studio.settings.cloudApi.vendorKeyReady')}</span>
                ) : null}
              </label>
            )
          })}
        </div>
        {/* 内置服务商没有模型输入框，才需要交代「模型去哪选」；custom 的模型字段自带说明。 */}
        {showCustomModel ? null : <p className="ofs-settings-muted">{t('studio.settings.cloudApi.modelHint')}</p>}
      </div>

      {showCustomModel ? (
        <div className="ofs-settings-field">
          <span className="ofs-settings-label">{t('studio.settings.cloudApi.model')}</span>
          <input
            className="ofs-settings-input"
            type="text"
            autoComplete="off"
            aria-label={t('studio.settings.cloudApi.model')}
            value={form.model}
            placeholder={t('studio.settings.cloudApi.modelPlaceholder')}
            onChange={(event) => onPatch({ model: event.target.value })}
          />
          <p className="ofs-settings-muted">{t('studio.settings.cloudApi.customModelHint')}</p>
        </div>
      ) : null}

      <div className="ofs-settings-field">
        <div className="ofs-settings-label-row">
          <div className="ofs-settings-inline">
            <span className="ofs-settings-label">{t('studio.settings.cloudApi.apiKey')}</span>
            {apiKeyUrl ? (
              <a
                className="ofs-settings-text-btn ofs-cloud-api-link"
                href={apiKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('studio.settings.cloudApi.getKeyLink')}
              </a>
            ) : null}
          </div>
          {keyConfigured ? (
            form.clearApiKey ? (
              <span className="ofs-settings-muted">{t('studio.settings.cloudApi.clearPending')}</span>
            ) : (
              <div className="ofs-settings-inline">
                {/* 服务商已经在上一行选中，这里不必再念一遍名字。 */}
                <span className="ofs-settings-muted">{t('studio.settings.cloudApi.keyConfigured')}</span>
                <button
                  type="button"
                  className="ofs-settings-text-btn"
                  onClick={() => onPatch({ apiKey: '', clearApiKey: true })}
                >
                  {t('studio.settings.cloudApi.clearKey')}
                </button>
              </div>
            )
          ) : null}
        </div>
        <input
          className="ofs-settings-input"
          type="password"
          autoComplete="off"
          aria-label={t('studio.settings.cloudApi.apiKey')}
          value={form.apiKey}
          placeholder={keyConfigured
            ? t('studio.settings.cloudApi.keyPlaceholderSet')
            : t('studio.settings.cloudApi.keyPlaceholder')}
          onChange={(event) => onPatch({ apiKey: event.target.value, clearApiKey: false })}
        />
        <p className="ofs-settings-muted">{t('studio.settings.cloudApi.keyHint')}</p>
      </div>

      {/* 接口地址默认折叠收起；custom 端点或用户主动展开时显示 */}
      <div className="ofs-settings-field">
        <div className="ofs-settings-label-row">
          <div className="ofs-settings-inline ofs-settings-endpoint-row">
            <span className="ofs-settings-label">{t('studio.settings.cloudApi.baseUrl')}</span>
            {!showBaseUrl && vendor.baseUrl ? (
              <span className="ofs-settings-endpoint" title={vendor.baseUrl}>{vendor.baseUrl}</span>
            ) : null}
          </div>
          {vendor.id === 'custom' ? null : (
            <button
              type="button"
              className="ofs-settings-text-btn"
              onClick={() => setBaseUrlOpen((value) => !value)}
            >
              {showBaseUrl ? t('studio.settings.cloudApi.baseUrlHide') : t('studio.settings.cloudApi.baseUrlEdit')}
            </button>
          )}
        </div>
        {showBaseUrl ? (
          <>
            <input
              className="ofs-settings-input"
              type="url"
              autoComplete="off"
              aria-label={t('studio.settings.cloudApi.baseUrl')}
              value={form.baseUrl}
              placeholder={vendor.baseUrl || t('studio.settings.cloudApi.baseUrlPlaceholder')}
              onChange={(event) => onPatch({ baseUrl: event.target.value })}
            />
            <p className="ofs-settings-muted">
              {vendor.id === 'custom' ? t('studio.settings.cloudApi.baseUrlRequired') : t('studio.settings.cloudApi.baseUrlHint')}
            </p>
          </>
        ) : null}
      </div>

      <p className="ofs-cloud-api-note">
        <Icon name="alert" size={13} />
        <span>
          {vendor.freeQuota === true
            ? t('studio.settings.cloudApi.scopeNote.modelscope')
            : t('studio.settings.cloudApi.scopeNote')}
        </span>
      </p>
    </div>
  )
}
