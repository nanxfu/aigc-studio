/**
 * 「云端算力」页内容：算力来源、空闲自动关机、加速器、HF Token 与高级预挂载。
 *
 * 收敛原则：
 *  - 「空闲自动关机」把快捷档位与「自定义」收进同一排，只有选自定义或非标准数值时才展开数字框；
 *  - 「GPU 加速器」只在算力来源为 Kaggle 时出现（Colab 的显卡在「Colab GPU」里选），
 *    避免两套显卡选项同时摆着让人各选一次；
 *  - HF Token 的来源提示与清除操作内联到标签行右侧，减少垂直碎块；
 *  - Colab 授权用一张带状态胶囊与三步进度的卡片，等待 / 手动兜底 / 失败 / 已授权共用一套布局；
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
import { Icon } from '../icons.jsx'
import { ProviderIcon } from './providerIcons.jsx'
import { SettingsAdvancedSection } from './SettingsAdvancedSection.jsx'
import { SettingsWorkerSection } from './SettingsWorkerSection.jsx'

/**
 * Google / Colab 授权卡：一张卡讲清「现在什么状态、走到哪一步、下一步做什么」。
 *
 * 旧版只有一行灰字 + 一个胶囊，等待授权时突然长出一段说明文字，既看不出进度，
 * 也不知道浏览器到底有没有打开。现在用状态胶囊 + 三步进度 + 就地兜底输入，
 * 把 browser / manual / failed / done 四种状态收进同一套视觉。
 */
function ColabAuthCard({ t, colabAuth, colabLogin, copyText }) {
  if (!colabLogin) return null
  const loginView = colabLogin.login && typeof colabLogin.login === 'object' ? colabLogin.login : {}
  const state = typeof loginView.state === 'string' ? loginView.state : 'idle'
  const pending = state === 'pending' || Boolean(colabLogin.pending)
  const manual = loginView.mode === 'manual'
  const hasCredentials = Boolean((colabAuth && colabAuth.authorized === true) || state === 'done')
  // 已有旧凭据时点「重新授权」，等待与失败态必须压过旧的已连接态，避免右上角亮绿标、下方却报失败/等待。
  const failed = !pending && state === 'failed'
  const cancelled = !pending && !failed && state === 'cancelled' && !hasCredentials
  const authorized = !pending && !failed && !cancelled && hasCredentials
  const email = (typeof loginView.username === 'string' && loginView.username)
    || (colabAuth && typeof colabAuth.email === 'string' && colabAuth.email)
    || ''
  const statusTone = authorized ? 'ok' : pending ? 'warn' : failed ? 'error' : 'idle'
  const statusLabel = authorized
    ? t('studio.settings.colabAuth.status.ready')
    : pending
      ? t(manual ? 'studio.settings.colabAuth.status.manual' : 'studio.settings.colabAuth.status.pending')
      : failed
        ? t('studio.settings.colabAuth.status.failed')
        : cancelled
          ? t('studio.settings.colabAuth.status.cancelled')
          : t('studio.settings.colabAuth.status.idle')
  const subtitle = authorized
    ? (email || t('studio.settings.colabAuth.readyAnon'))
    : pending
      ? t(manual ? 'studio.settings.colabAuth.sub.manual' : 'studio.settings.colabAuth.sub.pending')
      : failed
        ? t('studio.settings.colabAuth.sub.failed')
        : cancelled
          ? t('studio.settings.colabAuth.sub.cancelled')
          : t('studio.settings.colabAuth.sub.idle')
  // 步骤只在「浏览器授权」这条主链上推进；manual 兜底时用户还停在第一步（打开链接）。
  const currentStep = authorized ? 3 : pending ? (manual ? 1 : 2) : 1
  const steps = [
    t('studio.settings.colabAuth.step.browser'),
    t('studio.settings.colabAuth.step.grant'),
    t('studio.settings.colabAuth.step.ready'),
  ]
  const reason = colabLogin.errorKey
    ? t(colabLogin.errorKey)
    : (typeof loginView.message === 'string' && loginView.message)
      || t('studio.guidance.auth.reason.unknown')

  return (
    <section className={`ofs-colab-card is-${statusTone}`} aria-label={t('studio.settings.colabAuth.label')}>
      <header className="ofs-colab-head">
        <span className="ofs-colab-mark" aria-hidden="true">
          <ProviderIcon id="colab" size={18} />
        </span>
        <span className="ofs-colab-id">
          <span className="ofs-colab-title">{t('studio.settings.colabAuth.label')}</span>
          <span className="ofs-colab-sub" title={subtitle}>{subtitle}</span>
        </span>
        <span className={`ofs-colab-badge is-${statusTone}`}>
          <i className={`ofs-dot is-${statusTone}${pending ? ' is-live' : ''}`} aria-hidden="true" />
          {statusLabel}
        </span>
      </header>

      <ol className="ofs-colab-steps">
        {steps.map((label, index) => {
          const stepNo = index + 1
          const stepState = authorized
            ? 'done'
            : stepNo < currentStep
              ? 'done'
              : stepNo === currentStep
                ? (failed ? 'error' : 'active')
                : 'todo'
          return (
            <li key={label} className={`ofs-colab-step is-${stepState}`}>
              <span className="ofs-colab-step-mark" aria-hidden="true">
                {stepState === 'done' ? <Icon name="check" size={10} /> : stepNo}
              </span>
              <span className="ofs-colab-step-text">{label}</span>
            </li>
          )
        })}
      </ol>

      <div className="ofs-colab-body">
        {pending ? (
          <p className="ofs-colab-note is-waiting">
            <span className="ofs-colab-pulse" aria-hidden="true" />
            {t(manual ? 'studio.settings.colabAuth.waiting.manual' : 'studio.settings.colabAuth.waiting.browser')}
          </p>
        ) : null}
        {failed ? (
          <p className="ofs-colab-note is-error" role="alert">
            {formatText(t('studio.guidance.auth.failed'), { reason })}
          </p>
        ) : null}
        {!authorized && !pending && !failed ? (
          <p className="ofs-colab-note">{t('studio.settings.colabAuth.hint')}</p>
        ) : null}
        {authorized ? (
          <p className="ofs-colab-note">{t('studio.settings.colabAuth.readyHint')}</p>
        ) : null}
        {pending && manual ? (
          <OAuthManualPanel
            t={t}
            login={colabLogin}
            copyText={copyText}
            provider="colab"
            showNotes={false}
          />
        ) : null}
      </div>

      <footer className="ofs-colab-actions">
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
            className={hasCredentials ? 'ofs-chip' : 'ofs-btn is-primary ofs-colab-action'}
            disabled={Boolean(colabLogin.busy)}
            onClick={colabLogin.start}
          >
            {t(hasCredentials || failed ? 'studio.settings.colabAuth.relogin' : 'studio.settings.colabAuth.login')}
          </button>
        )}
        <span className="ofs-grow" />
        <span className="ofs-colab-foot-note">
          {t(hasCredentials ? 'studio.settings.colabAuth.stored' : 'studio.settings.colabAuth.oneTime')}
        </span>
      </footer>
    </section>
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
  worker,
  workerView,
  workerProbe,
  workerProbing,
  patchWorkerForm,
  onProbeWorker,
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

      {view && view.provider && form.provider !== view.provider ? (
        <p className="ofs-settings-switch-hint" role="status">
          {formatText(t('studio.settings.provider.switchHint'), {
            current: t(`studio.settings.provider.${view.provider}`),
            next: t(`studio.settings.provider.${form.provider}`),
          })}
        </p>
      ) : null}

      {form.provider === 'private-worker' ? (
        <SettingsWorkerSection
          t={t}
          form={worker}
          view={workerView}
          probe={workerProbe}
          probing={workerProbing}
          onPatch={patchWorkerForm}
          onProbe={onProbeWorker}
        />
      ) : null}

      {form.provider === 'colab' ? (
        <div className="ofs-settings-subpanel">
          <div className="ofs-colab-provider-head">
            <span className="ofs-colab-provider-mark" aria-hidden="true">
              <ProviderIcon id="colab" size={16} />
            </span>
            <span className="ofs-colab-provider-copy">
              <span className="ofs-colab-provider-title">{t('studio.settings.provider.colab')}</span>
              <span className="ofs-colab-provider-sub">{t('studio.settings.colab.sub')}</span>
            </span>
          </div>
          {/* 授权是使用 Colab 的前置条件：先看到状态与下一步，再选显卡。 */}
          <ColabAuthCard t={t} colabAuth={colabAuth} colabLogin={colabLogin} copyText={copyText} />
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
        </div>
      ) : null}

      {/* Kaggle 加速器（2×T4 / P100）只对 Kaggle 有意义：Colab 的显卡在上面的
          「Colab GPU」里选，两套同时出现会让人以为要各选一次。 */}
      {form.provider === 'kaggle' ? (
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
      ) : null}

      {/* 私有 Worker 的空闲退出由 Worker 侧 --idle-timeout 决定，Host 不再下发。 */}
      {form.provider !== 'private-worker' ? (
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
      ) : null}

      {/* HF Token 只用于 Kaggle/Colab 的 daemon 注入；私有 Worker 在容器侧自行配置。 */}
      {form.provider !== 'private-worker' ? (
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
      ) : null}

      {form.provider !== 'private-worker' ? (
      <SettingsAdvancedSection
        t={t}
        provider={form.provider}
        form={form}
        patchForm={patchForm}
        advancedOpen={advancedOpen}
        onToggleAdvanced={onToggleAdvanced}
        validationErrors={validation.errors}
      />
      ) : null}
    </div>
  )
}
