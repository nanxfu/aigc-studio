/**
 * SaladCloud 设置区（M3.6）：API Key / Org / Project / 稳定性档位。
 *
 * 显卡目录不在这里展开：Host 按模型显存与档位从隐藏卡池里选择。用户只需要
 * 在「更稳 / 更便宜」之间选一档，并可在保存前做一次只读连接测试。
 */

import React from 'react'

import { SALAD } from '../../../shared/contract.js'
import { errorText } from '../../logic/error.js'
import { formatText } from '../../logic/format.js'
import { providerLabelOf } from '../../logic/status.js'
import { Tooltip } from '../../components/Tooltip.jsx'
import { ProviderIcon } from './providerIcons.jsx'

export function SettingsSaladSection({ t, form, view, probe, probing, onPatch, onProbe }) {
  if (!form) return null
  const configured = Boolean(view && view.hasApiKey)
  const probeOk = Boolean(probe && probe.ok === true)
  const probeFailed = Boolean(probe && probe.ok === false)
  const probeError = probeFailed && probe.error ? errorText(t, probe.error) : ''

  return (
    <div className="ofs-settings-subpanel ofs-salad">
      <div className="ofs-settings-block-head">
        <span className="ofs-settings-block-mark" aria-hidden="true">
          <ProviderIcon id="salad" size={17} />
        </span>
        <span className="ofs-settings-block-copy">
          <span className="ofs-settings-block-title">{providerLabelOf(t, 'salad')}</span>
          <span className="ofs-settings-block-sub">{t('studio.settings.salad.sub')}</span>
        </span>
      </div>

      <div className="ofs-salad-ids">
        <label className="ofs-settings-field">
          <span className="ofs-settings-label">{t('studio.settings.salad.org')}</span>
          <input
            className="ofs-settings-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('studio.settings.salad.org')}
            placeholder={t('studio.settings.salad.orgPlaceholder')}
            value={form.org}
            onChange={(event) => onPatch({ org: event.target.value })}
          />
        </label>
        <label className="ofs-settings-field">
          <span className="ofs-settings-label">{t('studio.settings.salad.project')}</span>
          <input
            className="ofs-settings-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('studio.settings.salad.project')}
            placeholder={SALAD.defaultProject}
            value={form.project}
            onChange={(event) => onPatch({ project: event.target.value })}
          />
        </label>
      </div>
      <p className="ofs-settings-muted">{t('studio.settings.salad.idsHint')}</p>

      <div className="ofs-settings-field">
        <div className="ofs-settings-label-row">
          <div className="ofs-settings-inline">
            <span className="ofs-settings-label">{t('studio.settings.salad.apiKey')}</span>
            <a
              className="ofs-settings-text-btn"
              href="https://portal.salad.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('studio.settings.salad.portal')}
            </a>
          </div>
          {configured ? (
            form.clearApiKey ? (
              <span className="ofs-settings-muted">{t('studio.settings.salad.clearPending')}</span>
            ) : (
              <div className="ofs-settings-inline">
                <span className="ofs-settings-muted">{t('studio.settings.salad.keyConfigured')}</span>
                <button
                  type="button"
                  className="ofs-settings-text-btn"
                  onClick={() => onPatch({ apiKey: '', clearApiKey: true })}
                >
                  {t('studio.settings.salad.clearKey')}
                </button>
              </div>
            )
          ) : null}
        </div>
        <input
          className="ofs-settings-input"
          type="password"
          autoComplete="off"
          aria-label={t('studio.settings.salad.apiKey')}
          value={form.apiKey}
          placeholder={configured
            ? t('studio.settings.salad.keyPlaceholderSet')
            : t('studio.settings.salad.keyPlaceholder')}
          onChange={(event) => onPatch({ apiKey: event.target.value, clearApiKey: false })}
        />
        <p className="ofs-settings-muted">{t('studio.settings.salad.keyHint')}</p>
      </div>

      <div className="ofs-settings-row">
        <div className="ofs-settings-label-row">
          <div className="ofs-settings-inline">
            <span className="ofs-settings-label">{t('studio.settings.salad.tier')}</span>
            <Tooltip text={t('studio.settings.salad.tierTip')} side="bottom" />
          </div>
          <span className="ofs-settings-muted">{t('studio.settings.salad.tierHint')}</span>
        </div>
        <div className="ofs-settings-options" role="radiogroup" aria-label={t('studio.settings.salad.tier')}>
          {SALAD.tierIds.map((id) => (
            <label key={id} className={`ofs-settings-option${form.tier === id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="ofs-salad-tier"
                value={id}
                checked={form.tier === id}
                onChange={() => onPatch({ tier: id })}
              />
              <span>{t(`studio.settings.salad.tier.${id}`)}</span>
              {id === SALAD.defaultTier ? (
                <span className="ofs-settings-block-badge">{t('studio.settings.salad.recommended')}</span>
              ) : null}
            </label>
          ))}
        </div>
        <p className="ofs-settings-muted">
          {formatText(t('studio.settings.salad.selectedTier'), {
            tier: t(`studio.settings.salad.tier.${form.tier}`),
          })}
        </p>
      </div>

      <div className="ofs-settings-inline">
        <button
          type="button"
          className="ofs-chip"
          onClick={onProbe}
          disabled={probing}
          aria-busy={probing}
        >
          {probing ? t('studio.settings.salad.probing') : t('studio.settings.salad.probe')}
        </button>
        <span className="ofs-settings-muted">{t('studio.settings.salad.probeHint')}</span>
      </div>

      {probeOk ? (
        <div className="ofs-settings-status is-ready" role="status">
          <i className="ofs-dot is-ok" aria-hidden="true" />
          <span className="ofs-settings-status-text">
            {formatText(t('studio.settings.salad.probeOk'), {
              org: probe.org || form.org,
              project: probe.project || form.project,
              used: probe.quota?.replicasUsed ?? 0,
              total: probe.quota?.replicasQuota ?? '?',
            })}
          </span>
        </div>
      ) : null}
      {probeFailed ? (
        <p className="ofs-settings-error" role="alert">
          {t('studio.settings.salad.probeFailed')}
          {probeError ? ` · ${probeError}` : ''}
        </p>
      ) : null}

      <p className="ofs-cloud-api-note">
        <span aria-hidden="true">·</span>
        <span>{t('studio.settings.salad.scopeNote')}</span>
      </p>
    </div>
  )
}
