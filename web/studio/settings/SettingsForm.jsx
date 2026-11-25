/**
 * 「云端算力」页内容：算力来源、空闲自动关机、加速器、HF Token 与高级预挂载。
 *
 * 收敛原则：
 *  - 选项即控件：来源 / 加速器 / 显卡用同一套选中胶囊，不再在胶囊里再塞一个原生单选点；
 *  - 每个来源只在选中时展开自己那一块（私有 Worker / 商业 API / Colab），
 *    且只有一层容器（`.ofs-settings-subpanel`），里面直接是字段，不再套第二张卡；
 *  - 「空闲自动关机」把快捷档位与「自定义」收进同一排，只有选自定义或非标准数值时才展开数字框；
 *  - HF Token 的来源提示与清除操作内联到标签行右侧，减少垂直碎块；
 *  - 不在内部自建 footer，由弹窗统一底栏负责保存 / 取消与行级报错。
 */

import React from 'react'

import { PROVIDER_GROUPS, SETTINGS } from '../../../shared/contract.js'

import { formatText } from '../../logic/format.js'
import { providerLabelOf } from '../../logic/status.js'
import {
  IDLE_MAX_MINUTES,
  IDLE_MIN_MINUTES,
  quickIdleMinutes,
} from '../../logic/settings.js'
import { OAuthManualPanel } from '../guidance/DirectLoginCard.jsx'
import { Icon } from '../icons.jsx'
import { ProviderIcon } from './providerIcons.jsx'
import { SettingsAdvancedSection } from './SettingsAdvancedSection.jsx'
import { SettingsCloudApiSection } from './SettingsCloudApiSection.jsx'
import { SettingsLocalGpuSection } from './SettingsLocalGpuSection.jsx'
import { SettingsSaladSection } from './SettingsSaladSection.jsx'
import { SettingsWorkerSection } from './SettingsWorkerSection.jsx'

/**
 * 单选组：整块胶囊就是控件，选中态只由底色与描边表达。
 *
 * hintOf 给每一项补一行小字（「需 Google 授权」这类选择依据）：名字与限定词分两行，
 * 限定词退到次级，四个来源才能并排成一行，而不是两行等宽的长胶囊。
 */
function OptionGroup({ name, label, value, options, labelOf, hintOf, onChange, columns }) {
  return (
    <div
      className={`ofs-settings-options${columns ? ' is-grid' : ''}${columns === 4 ? ' is-quad' : ''}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((id) => (
        <label
          key={id}
          className={`ofs-settings-option${hintOf ? ' is-stacked' : ''}${value === id ? ' is-on' : ''}`}
        >
          <input
            type="radio"
            name={name}
            value={id}
            checked={value === id}
            onChange={() => onChange(id)}
          />
          <span>{labelOf(id)}</span>
          {hintOf ? <span className="ofs-settings-option-hint">{hintOf(id)}</span> : null}
        </label>
      ))}
    </div>
  )
}

/**
 * Google / Colab 授权块：一整块讲清「现在什么状态、下一步做什么」。
 *
 * 它在「云端算力」的来源区块里，所以不再自带卡片表面：状态胶囊挂在来源标题行右端，
 * 三步进度只在还没授权时出现（已授权时三枚对勾只是复述结论）。
 */
function ColabAuthSection({ t, colabAuth, colabLogin, copyText }) {
  if (!colabLogin) return null
  const loginView = colabLogin.login && typeof colabLogin.login === 'object' ? colabLogin.login : {}
  const state = typeof loginView.state === 'string' ? loginView.state : 'idle'
  const pending = state === 'pending' || Boolean(colabLogin.pending)
  const manual = loginView.mode === 'manual'
  const hasCredentials = Boolean((colabAuth && colabAuth.authorized === true) || state === 'done')
  // 已有旧凭据时点「重新授权」，等待与失败态必须压过旧的已连接态，避免亮着绿标却报失败 / 等待。
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
    <>
      <div className="ofs-settings-block-head">
        <span className="ofs-settings-block-mark" aria-hidden="true">
          <ProviderIcon id="colab" size={17} />
        </span>
        <span className="ofs-settings-block-copy">
          {/* 标题用与顶栏胶囊、状态弹层同一个来源名，副标题承担「现在什么状态」。 */}
          <span className="ofs-settings-block-title">{providerLabelOf(t, 'colab')}</span>
          <span className="ofs-settings-block-sub" title={subtitle}>{subtitle}</span>
        </span>
        <span className={`ofs-settings-block-badge is-${statusTone}`}>
          <i className={`ofs-dot is-${statusTone}${pending ? ' is-live' : ''}`} aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

      <div className="ofs-colab-body">
        {authorized ? null : (
          <ol className="ofs-colab-steps" aria-label={t('studio.settings.colabAuth.label')}>
            {steps.map((label, index) => {
              const stepNo = index + 1
              const stepState = stepNo < currentStep ? 'done' : stepNo === currentStep ? (failed ? 'error' : 'active') : 'todo'
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
        )}
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
        {authorized ? <p className="ofs-colab-note">{t('studio.settings.colabAuth.readyHint')}</p> : null}
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

      <div className="ofs-colab-actions">
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
      </div>
    </>
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
  imageApi,
  imageApiView,
  patchImageApi,
  salad,
  saladView,
  saladProbe,
  saladProbing,
  patchSalad,
  onProbeSalad,
  localGpu,
  localGpuView,
  localGpuProbe,
  localGpuProbing,
  patchLocalGpuForm,
  onProbeLocalGpu,
  onPrepareLocalGpu,
  onCancelLocalGpuSetup,
  localGpuSetup,
  localGpuSetupWorking,
  localGpuConnecting,
  saving,
  onOpenLocalModels,
}) {
  const activeQuick = quickIdleMinutes(form.idleMinutes)
  const [customIdleOpen, setCustomIdleOpen] = React.useState(activeQuick === null)
  const showCustomIdle = customIdleOpen || activeQuick === null
  // 空闲关机 / HF Token / 权重预挂载只对 notebook 与自有 Worker 有意义：
  // 商业生图 API 与本机 GPU（自有配置面板）不展示 Kaggle/Colab 通用段。
  const workerLike = form.provider === 'private-worker' || form.provider === 'local-gpu' || form.provider === 'salad'
  const usesRemoteDaemon = !workerLike && form.provider !== 'cloud-api'
  const providerName = (id) => providerLabelOf(t, id)
  const providerGroups = React.useMemo(() => {
    const enabled = new Set(SETTINGS.providers)
    return PROVIDER_GROUPS
      .map((group) => ({
        ...group,
        providers: group.providers.filter((id) => enabled.has(id)),
      }))
      .filter((group) => group.providers.length > 0)
  }, [])

  return (
    <div className="ofs-settings-pane">
      {view && view.effectiveOnNextSession === true ? (
        <p className="ofs-settings-effective" role="status">{t('studio.settings.effectiveNext')}</p>
      ) : null}

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('studio.settings.provider.label')}</span>
        <div className="ofs-provider-groups" role="radiogroup" aria-label={t('studio.settings.provider.label')}>
          {providerGroups.map((group) => (
            <div key={group.id} className="ofs-provider-group" data-provider-group={group.id}>
              <div className="ofs-provider-group-head">
                <span className="ofs-provider-group-title">{t(`studio.settings.providerGroup.${group.id}`)}</span>
                <span className="ofs-provider-group-hint">{t(`studio.settings.providerGroup.${group.id}.hint`)}</span>
              </div>
              <div className={`ofs-settings-options is-grid${group.providers.length >= 3 ? ' is-quad' : ''}${group.providers.length === 1 ? ' is-single' : ''}`}>
                {group.providers.map((id) => (
                  <label
                    key={id}
                    className={`ofs-settings-option is-stacked${form.provider === id ? ' is-on' : ''}`}
                  >
                    <input
                      type="radio"
                      name="ofs-provider"
                      value={id}
                      checked={form.provider === id}
                      onChange={() => patchForm({ provider: id })}
                    />
                    <span className="ofs-settings-option-title">
                      <ProviderIcon id={id} size={14} />
                      <span>{providerName(id)}</span>
                    </span>
                    <span className="ofs-settings-option-hint">{t(`studio.settings.provider.${id}.hint`)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {view && view.provider && form.provider !== view.provider ? (
        <p className="ofs-settings-switch-hint" role="status">
          {formatText(t('studio.settings.provider.switchHint'), {
            current: providerName(view.provider),
            next: providerName(form.provider),
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

      {form.provider === 'cloud-api' ? (
        <SettingsCloudApiSection
          t={t}
          form={imageApi}
          view={imageApiView}
          onPatch={patchImageApi}
        />
      ) : null}

      {form.provider === 'salad' ? (
        <SettingsSaladSection
          t={t}
          form={salad}
          view={saladView}
          probe={saladProbe}
          probing={saladProbing}
          onPatch={patchSalad}
          onProbe={onProbeSalad}
        />
      ) : null}

      {form.provider === 'local-gpu' ? (
        <SettingsLocalGpuSection
          t={t}
          form={localGpu}
          view={localGpuView}
          probe={localGpuProbe}
          probing={localGpuProbing}
          setup={localGpuSetup}
          setupWorking={localGpuSetupWorking}
          connecting={localGpuConnecting}
          onSetup={onPrepareLocalGpu}
          onCancelSetup={onCancelLocalGpuSetup}
          disabled={saving}
          onPatch={patchLocalGpuForm}
          onProbe={onProbeLocalGpu}
          onOpenLocalModels={onOpenLocalModels}
        />
      ) : null}

      {form.provider === 'colab' ? (
        <div className="ofs-settings-subpanel">
          {/* 授权是使用 Colab 的前置条件：先看到状态与下一步，再选显卡。 */}
          <ColabAuthSection t={t} colabAuth={colabAuth} colabLogin={colabLogin} copyText={copyText} />
          <div className="ofs-settings-row">
            <span className="ofs-settings-label">{t('studio.settings.colabGpu.label')}</span>
            <OptionGroup
              name="ofs-colab-gpu"
              label={t('studio.settings.colabGpu.label')}
              value={form.colabGpu}
              options={SETTINGS.colabGpus}
              labelOf={(id) => t(`studio.settings.colabGpu.${id}`)}
              onChange={(id) => patchForm({ colabGpu: id })}
            />
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
          <OptionGroup
            name="ofs-accelerator"
            label={t('studio.settings.accelerator.label')}
            value={form.accelerator}
            options={SETTINGS.accelerators}
            labelOf={(id) => t(`studio.settings.accelerator.${id}`)}
            onChange={(id) => patchForm({ accelerator: id })}
          />
        </div>
      ) : null}

      {/* 私有 Worker 的空闲退出由 Worker 侧 --idle-timeout 决定，Host 不再下发。 */}
      {usesRemoteDaemon ? (
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
      {usesRemoteDaemon ? (
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

      {usesRemoteDaemon ? (
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
