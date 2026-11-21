/**
 * 「云端算力」页内容：算力来源、空闲自动关机、加速器、HF Token 与高级预挂载。
 *
 * 收敛原则：
 *  - 「空闲自动关机」把快捷档位与「自定义」收进同一排，只有选自定义或非标准数值时才展开数字框；
 *  - HF Token 的来源提示与清除操作内联到标签行右侧，减少垂直碎块；
 *  - 不在内部自建 footer，由弹窗统一底栏负责保存 / 取消与行级报错。
 */

import React from 'react'

import { SETTINGS } from '../../../shared/contract.js'

import { formatText } from '../../logic/format.js'
import {
  IDLE_MAX_MINUTES,
  IDLE_MIN_MINUTES,
  quickIdleMinutes,
} from '../../logic/settings.js'
import { OAuthManualPanel } from '../guidance/DirectLoginCard.jsx'
import { SettingsAdvancedSection } from './SettingsAdvancedSection.jsx'

function ColabAuthRow({ t, colabAuth, colabLogin, copyText }) {
  if (!colabLogin) return null
  const loginView = colabLogin.login && typeof colabLogin.login === 'object' ? colabLogin.login : {}
  const state = typeof loginView.state === 'string' ? loginView.state : 'idle'
  const pending = state === 'pending' || Boolean(colabLogin.pending)
  const authorized = Boolean((colabAuth && colabAuth.authorized === true) || state === 'done')
  const email = (typeof loginView.username === 'string' && loginView.username)
    || (colabAuth && typeof colabAuth.email === 'string' && colabAuth.email)
    || ''
  const statusText = authorized
    ? (email ? formatText(t('studio.settings.colabAuth.ready'), { email }) : t('studio.settings.colabAuth.readyAnon'))
    : t('studio.settings.colabAuth.missing')

  return (
    <div className="ofs-settings-row ofs-settings-colab-auth">
      <span className="ofs-settings-label">{t('studio.settings.colabAuth.label')}</span>
      <div className="ofs-settings-inline">
        <span className="ofs-settings-muted">{statusText}</span>
        {pending ? (
          <button
            type="button"
            className="ofs-chip is-on"
            disabled={Boolean(colabLogin.busy)}
            onClick={colabLogin.cancel}
          >
            {t('studio.guidance.auth.cancel')}
          </button>
        ) : (
          <button
            type="button"
            className={authorized ? 'ofs-chip' : 'ofs-chip is-on'}
            disabled={Boolean(colabLogin.busy)}
            onClick={colabLogin.start}
          >
            {t(authorized ? 'studio.settings.colabAuth.relogin' : 'studio.settings.colabAuth.login')}
          </button>
        )}
      </div>
      {state !== 'idle' ? (
        <OAuthManualPanel t={t} login={colabLogin} copyText={copyText} provider="colab" />
      ) : null}
    </div>
  )
}

export function SettingsForm({
  t,
  view,
  form,
  patchForm,
  validation,
  tokenSource,
  advancedOpen,
  onToggleAdvanced,
  colabAuth,
  colabLogin,
  copyText,
}) {
  const activeQuick = quickIdleMinutes(form.idleMinutes)
  const [customIdleOpen, setCustomIdleOpen] = React.useState(activeQuick === null)
  const showCustomIdle = customIdleOpen || activeQuick === null

  return (
    <div className="ofs-settings-pane">
      {view && view.effectiveOnNextSession === true ? (
        <p className="ofs-settings-effective" role="status">{t('studio.settings.effectiveNext')}</p>
      ) : null}

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('studio.settings.provider.label')}</span>
        <div className="ofs-settings-options" role="radiogroup" aria-label={t('studio.settings.provider.label')}>
          {SETTINGS.providers.map((id) => (
            <label key={id} className={`ofs-settings-option${form.provider === id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="ofs-provider"
                value={id}
                checked={form.provider === id}
                onChange={() => patchForm({ provider: id })}
              />
              <span>{t(`studio.settings.provider.${id}`)}</span>
            </label>
          ))}
        </div>
      </div>

      {form.provider === 'colab' ? (
        <div className="ofs-settings-subpanel">
          <div className="ofs-settings-row">
            <span className="ofs-settings-label">{t('studio.settings.colabGpu.label')}</span>
            <div className="ofs-settings-options" role="radiogroup" aria-label={t('studio.settings.colabGpu.label')}>
              {SETTINGS.colabGpus.map((id) => (
                <label key={id} className={`ofs-settings-option${form.colabGpu === id ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name="ofs-colab-gpu"
                    value={id}
                    checked={form.colabGpu === id}
                    onChange={() => patchForm({ colabGpu: id })}
                  />
                  <span>{t(`studio.settings.colabGpu.${id}`)}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="ofs-settings-inline">
            <input
              type="checkbox"
              checked={form.colabHighRam === true}
              onChange={(event) => patchForm({ colabHighRam: event.target.checked })}
            />
            <span className="ofs-settings-label">{t('studio.settings.colabHighRam.label')}</span>
          </label>
          <p className="ofs-settings-muted">{t('studio.settings.colabHighRam.hint')}</p>
          <ColabAuthRow t={t} colabAuth={colabAuth} colabLogin={colabLogin} copyText={copyText} />
        </div>
      ) : null}

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('studio.settings.accelerator.label')}</span>
        <div className="ofs-settings-options" role="radiogroup" aria-label={t('studio.settings.accelerator.label')}>
          {SETTINGS.accelerators.map((id) => (
            <label
              key={id}
              className={`ofs-settings-option${form.accelerator === id ? ' is-on' : ''}`}
            >
              <input
                type="radio"
                name="ofs-accelerator"
                value={id}
                checked={form.accelerator === id}
                onChange={() => patchForm({ accelerator: id })}
              />
              <span>{t(`studio.settings.accelerator.${id}`)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('studio.settings.idle.label')}</span>
        <div className="ofs-settings-quick" role="group" aria-label={t('studio.settings.idle.label')}>
          {SETTINGS.idleTimeoutSec.quickMinutes.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={`ofs-chip ofs-settings-quick-item${!customIdleOpen && activeQuick === minutes ? ' is-on' : ''}`}
              aria-pressed={!customIdleOpen && activeQuick === minutes}
              onClick={() => {
                setCustomIdleOpen(false)
                patchForm({ idleMinutes: String(minutes) })
              }}
            >
              {formatText(t('studio.settings.idle.quick'), { minutes })}
            </button>
          ))}
          <button
            type="button"
            className={`ofs-chip ofs-settings-quick-item${showCustomIdle ? ' is-on' : ''}`}
            aria-pressed={showCustomIdle}
            onClick={() => setCustomIdleOpen((value) => !value)}
          >
            {t('studio.settings.idle.customButton')}
          </button>
        </div>
        {showCustomIdle ? (
          <input
            className="ofs-settings-input ofs-settings-idle-input"
            type="number"
            inputMode="numeric"
            aria-label={formatText(t('studio.settings.idle.custom'), { min: IDLE_MIN_MINUTES, max: IDLE_MAX_MINUTES })}
            min={IDLE_MIN_MINUTES}
            max={IDLE_MAX_MINUTES}
            step={1}
            value={form.idleMinutes}
            onChange={(event) => patchForm({ idleMinutes: event.target.value })}
          />
        ) : null}
      </div>

      <div className="ofs-settings-field">
        <div className="ofs-settings-label-row">
          <span className="ofs-settings-label">{t('studio.settings.hfToken.label')}</span>
          {view && view.hasHfToken === true ? (
            form.clearHfToken ? (
              <span className="ofs-settings-muted">{t('studio.settings.hfToken.clearPending')}</span>
            ) : (
              <div className="ofs-settings-inline">
                <span className="ofs-settings-muted">
                  {formatText(t('studio.settings.hfToken.source'), { source: tokenSource })}
                </span>
                <button
                  type="button"
                  className="ofs-settings-text-btn"
                  onClick={() => patchForm({ hfToken: '', clearHfToken: true })}
                >
                  {t('studio.settings.hfToken.clear')}
                </button>
              </div>
            )
          ) : null}
        </div>
        <input
          className="ofs-settings-input"
          type="password"
          autoComplete="off"
          aria-label={t('studio.settings.hfToken.label')}
          value={form.hfToken}
          placeholder={view && view.hasHfToken === true
            ? t('studio.settings.hfToken.placeholderSet')
            : t('studio.settings.hfToken.placeholder')}
          onChange={(event) => patchForm({ hfToken: event.target.value, clearHfToken: false })}
        />
      </div>

      <SettingsAdvancedSection
        t={t}
        form={form}
        patchForm={patchForm}
        advancedOpen={advancedOpen}
        onToggleAdvanced={onToggleAdvanced}
        validationErrors={validation.errors}
      />
    </div>
  )
}
