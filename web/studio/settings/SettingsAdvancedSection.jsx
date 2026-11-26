/**
 * 运行设置抽屉的「高级：预挂载与依赖锁定」可折叠节。
 *
 * Kaggle 专属项（访问方式 / 预挂载 Dataset）按当前算力来源隐藏：
 * 这两项在 Colab 上没有对应物（不跑 kaggle CLI，也没有 /kaggle/input 挂载），
 * 一起显示只会让人以为 Colab 也要配一遍。本地模型映射与 pip 约束两种来源都适用。
 */

import React from 'react'

import { SETTINGS } from '../../../shared/contract.js'

import { formatText } from '../../logic/format.js'
import { KAGGLE_CREDENTIAL_PATH } from '../../logic/guidance.js'
import {
  IDLE_MAX_MINUTES,
  IDLE_MIN_MINUTES,
  kaggleTransportLabelKey,
  quickIdleMinutes,
} from '../../logic/settings.js'
import { providerText } from '../../logic/status.js'
import { Icon } from '../icons.jsx'

export function SettingsAdvancedSection({
  t,
  provider = 'kaggle',
  form,
  patchForm,
  advancedOpen,
  onToggleAdvanced,
  validationErrors,
  view = null,
  tokenSource = '',
}) {
  const kaggleOnly = provider !== 'colab'
  const activeQuick = quickIdleMinutes(form.idleMinutes)
  const [customIdleOpen, setCustomIdleOpen] = React.useState(activeQuick === null)
  const showCustomIdle = customIdleOpen || activeQuick === null
  return (
    <section className="ofs-settings-section">
      <button
        type="button"
        className="ofs-settings-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={onToggleAdvanced}
      >
        <span>{t('studio.settings.advanced.toggle')}</span>
        <span className={`ofs-chevron${advancedOpen ? ' is-open' : ''}`}>
          <Icon name="chevronDown" size={13} />
        </span>
      </button>

      {advancedOpen ? (
        <div className="ofs-settings-advanced">
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

          {!kaggleOnly ? (
            <p className="ofs-settings-muted">{t('studio.settings.advanced.colabHint')}</p>
          ) : null}

          {/* Kaggle 访问方式：cli（默认，调用本机 CLI）/ direct（Node 直连，试验特性）。
              切换在下次唤醒或下次环境检查时生效，与「下次会话生效」提示同一口径。 */}
          {kaggleOnly ? (
            <div className="ofs-settings-row">
              <span className="ofs-settings-label">{t('studio.settings.kaggleTransport.label')}</span>
              <div
                className="ofs-settings-options"
                role="radiogroup"
                aria-label={t('studio.settings.kaggleTransport.label')}
              >
                {SETTINGS.kaggleTransports.map((transport) => (
                  <label
                    key={transport}
                    className={`ofs-settings-option${form.kaggleTransport === transport ? ' is-on' : ''}`}
                  >
                    <input
                      type="radio"
                      name="ofs-kaggle-transport"
                      value={transport}
                      checked={form.kaggleTransport === transport}
                      onChange={() => patchForm({ kaggleTransport: transport })}
                    />
                    <span>{t(kaggleTransportLabelKey(transport))}</span>
                  </label>
                ))}
              </div>
              {form.kaggleTransport === 'direct' ? (
                <small className="ofs-settings-hint">
                  {formatText(t('studio.settings.kaggleTransport.directHint'), {
                    path: KAGGLE_CREDENTIAL_PATH,
                  })}
                </small>
              ) : null}
            </div>
          ) : null}

          {/* 预挂载 Dataset 走 kernel-metadata 的 dataset_sources，只在 Kaggle 侧生效。 */}
          {kaggleOnly ? (
            <label className="ofs-settings-field">
              <span className="ofs-settings-label">{t('studio.settings.dataset.label')}</span>
              <textarea
                className="ofs-settings-textarea"
                rows={3}
                value={form.datasetSourcesText}
                placeholder={t('studio.settings.dataset.placeholder')}
                onChange={(event) => patchForm({ datasetSourcesText: event.target.value })}
              />
              <small className="ofs-settings-hint">
                {formatText(t('studio.settings.dataset.hint'), { max: SETTINGS.maxItems })}
              </small>
            </label>
          ) : null}

          <label className="ofs-settings-field">
            <span className="ofs-settings-label">{t('studio.settings.localModels.label')}</span>
            <textarea
              className="ofs-settings-textarea"
              rows={3}
              value={form.localModelsText}
              // 路径示例要跟着来源走：Kaggle 是 /kaggle/input/...，Colab 是 /content/...。
              placeholder={providerText(t, 'studio.settings.localModels.placeholder', provider)}
              onChange={(event) => patchForm({ localModelsText: event.target.value })}
            />
            <small className="ofs-settings-hint">{t('studio.settings.localModels.hint')}</small>
          </label>
          {validationErrors.length > 0 ? (
            <ul className="ofs-settings-errors">
              {validationErrors.map((error) => (
                <li key={`${error.line}-${error.message}`} className="ofs-settings-error-item">
                  {formatText(t(error.message), { line: error.line, ...(error.params || {}) })}
                </li>
              ))}
            </ul>
          ) : null}

          <label className="ofs-settings-field">
            <span className="ofs-settings-label">{t('studio.settings.pip.label')}</span>
            <textarea
              className="ofs-settings-textarea"
              rows={3}
              value={form.pipConstraintsText}
              placeholder={t('studio.settings.pip.placeholder')}
              onChange={(event) => patchForm({ pipConstraintsText: event.target.value })}
            />
            <small className="ofs-settings-hint">{t('studio.settings.pip.hint')}</small>
          </label>
        </div>
      ) : null}
    </section>
  )
}
