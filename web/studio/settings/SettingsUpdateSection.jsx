/**
 * 设置抽屉 →「版本与更新」（M2.8 阶段 B）。
 *
 * 数据分两半：
 *  - 配置（自动检查 / 更新源 / 镜像地址）写 `/api/app-settings` 的 `update` 段，
 *    不跟随工作区；切换即时保存，不设底部保存条；
 *  - 运行状态（版本 / 进度 / 错误）来自 `useUpdate`（主进程桥接或 `/api/state`）。
 */

import React from 'react'

import { saveAppSettings } from '../../api/resources.js'
import { appSettingsViewOf } from '../../logic/appSettings.js'
import { formatText } from '../../logic/format.js'
import { settingsErrorText } from '../../logic/settings.js'
import {
  installGateText,
  progressPercentOf,
  progressTextOf,
  updateAvailableText,
  updateErrorText,
  updateStatusKey,
} from '../../logic/update.js'
import { useUpdate } from '../hooks/useUpdate.js'

/** 只读形态 → 说明文案键（与顶栏弹层同一套）。 */
const FORM_KEYS = {
  portable: 'studio.update.form.portable',
  unpacked: 'studio.update.form.unpacked',
  dev: 'studio.update.form.dev',
  'mac-unsigned': 'studio.update.form.macUnsigned',
  'linux-appimage': 'studio.update.form.linuxAppimage',
  unsupported: 'studio.update.form.unsupported',
}

function lastCheckedText(checkedAt) {
  if (!checkedAt) return ''
  const time = Date.parse(checkedAt)
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleString()
}

export function SettingsUpdateSection({ t, status, view, onView, onRetry }) {
  const update = useUpdate()
  const settings = view?.update ?? { updateCheck: false, updateSource: 'github', updateMirrorUrl: '' }
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [sourceDraft, setSourceDraft] = React.useState(settings.updateSource || 'github')
  const [mirror, setMirror] = React.useState(settings.updateMirrorUrl ?? '')

  React.useEffect(() => {
    setSourceDraft(settings.updateSource || 'github')
  }, [settings.updateSource])

  React.useEffect(() => {
    setMirror(settings.updateMirrorUrl ?? '')
  }, [settings.updateMirrorUrl])

  const state = update.state
  const percent = progressPercentOf(state)
  const formKey = state ? FORM_KEYS[state.form] : null

  async function saveUpdatePatch(patch) {
    if (saving) return
    setSaving(true)
    setError(null)
    const result = await saveAppSettings({ update: patch })
    setSaving(false)
    const next = appSettingsViewOf(result)
    if (!next) {
      setError({ code: (result && result.code) || 'internal_error', message: (result && result.message) || '' })
      return
    }
    onView?.(next)
    // 不在这里自动触发检查：配置切换只改变「下次检查用什么源」，
    // 立即检查由用户点按钮（避免关闭自动检查后又被一次强制检查打脸）。
  }

  function toggleAutoCheck() {
    void saveUpdatePatch({ updateCheck: !settings.updateCheck })
  }

  function chooseSource(nextSource) {
    setSourceDraft(nextSource)
    setError(null)
    if (nextSource === 'github') {
      if (settings.updateSource !== 'github') void saveUpdatePatch({ updateSource: 'github' })
      return
    }
    // 从 GitHub 切到自定义且尚未填镜像地址时，先展开输入框让用户填写，不立刻触发 400 死锁。
    const trimmed = mirror.trim()
    if (!trimmed) return
    if (settings.updateSource === 'custom' && trimmed === (settings.updateMirrorUrl ?? '')) return
    void saveUpdatePatch({ updateSource: 'custom', updateMirrorUrl: trimmed })
  }

  function submitMirror() {
    const value = mirror.trim()
    if (sourceDraft !== 'custom') return
    // 尚未切到 custom 且输入框仍为空时（例如失焦未输入），留在草稿态等待输入。
    if (!value && settings.updateSource !== 'custom') return
    if (settings.updateSource === 'custom' && value === (settings.updateMirrorUrl ?? '')) return
    void saveUpdatePatch({ updateSource: 'custom', updateMirrorUrl: value })
  }

  if (status === 'error') {
    return (
      <div className="ofs-settings-error-state">
        <p className="ofs-settings-error" role="alert">
          {t('studio.settings.loadFailed')}
          {error ? ` · ${settingsErrorText(t, error)}` : ''}
        </p>
        {onRetry ? (
          <button type="button" className="ofs-chip" onClick={onRetry}>
            {t('studio.settings.retry')}
          </button>
        ) : null}
      </div>
    )
  }

  if (status !== 'ready' || !view) {
    return <p className="ofs-settings-note">{t('studio.settings.loading')}</p>
  }

  return (
    <div className="ofs-settings-pane ofs-update-settings">
      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('settings.update.current')}</span>
        <div className="ofs-update-setting-value">
          <strong>{state?.current || view.version || '—'}</strong>
          {state?.latest && state.hasUpdate ? (
            <span className="ofs-update-setting-latest">
              {formatText(t('settings.update.latest'), { version: state.latest })}
            </span>
          ) : null}
        </div>
      </div>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('settings.update.autoCheck.label')}</span>
        <div className="ofs-settings-options">
          <label className={`ofs-settings-option${settings.updateCheck ? ' is-on' : ''}`}>
            <input
              type="checkbox"
              checked={settings.updateCheck === true}
              disabled={saving}
              onChange={toggleAutoCheck}
            />
            <span>{settings.updateCheck ? t('settings.update.autoCheck.on') : t('settings.update.autoCheck.off')}</span>
          </label>
        </div>
      </div>
      <p className="ofs-settings-hint">{t('settings.update.autoCheck.hint')}</p>

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('settings.update.source.label')}</span>
        <div className="ofs-settings-options" role="radiogroup" aria-label={t('settings.update.source.label')}>
          {['github', 'custom'].map((id) => (
            <label key={id} className={`ofs-settings-option${sourceDraft === id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="ofs-update-source"
                value={id}
                checked={sourceDraft === id}
                disabled={saving}
                onChange={() => chooseSource(id)}
              />
              <span>{t(`settings.update.source.${id}`)}</span>
            </label>
          ))}
        </div>
      </div>

      {sourceDraft === 'custom' ? (
        <>
          <div className="ofs-settings-row">
            <span className="ofs-settings-label">{t('settings.update.mirror.label')}</span>
            <input
              className="ofs-settings-input"
              type="url"
              inputMode="url"
              spellCheck={false}
              value={mirror}
              placeholder={t('settings.update.mirror.placeholder')}
              disabled={saving}
              onChange={(event) => setMirror(event.target.value)}
              onBlur={submitMirror}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitMirror()
                }
              }}
            />
          </div>
          <p className="ofs-settings-hint">{t('settings.update.mirror.hint')}</p>
        </>
      ) : null}

      <div className="ofs-settings-row">
        <span className="ofs-settings-label">{t('settings.update.checkNow')}</span>
        <div className="ofs-update-setting-actions">
          <button
            type="button"
            className="ofs-chip"
            onClick={() => update.check()}
            disabled={update.busy || update.actions.canCheck === false}
            aria-busy={update.busy}
          >
            {update.busy ? t('settings.update.checking') : t('settings.update.checkNow')}
          </button>
          {state?.releaseUrl && state.hasUpdate ? (
            <button type="button" className="ofs-chip" onClick={() => update.openRelease(state.releaseUrl)}>
              {t('studio.update.action.openRelease')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="ofs-update-setting-status" role="status">
        <span className={`ofs-update-status is-${state?.status ?? 'idle'}`}>{t(updateStatusKey(state))}</span>
        {state?.hasUpdate ? <span>{updateAvailableText(t, state)}</span> : null}
        {state?.checkedAt ? (
          <span className="ofs-update-setting-time">
            {formatText(t('settings.update.lastChecked'), { time: lastCheckedText(state.checkedAt) })}
          </span>
        ) : (
          <span className="ofs-update-setting-time">{t('settings.update.neverChecked')}</span>
        )}
      </div>

      {state?.status === 'downloading' ? (
        <>
          <div
            className="ofs-update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t('studio.update.status.downloading')}
          >
            <span className="ofs-update-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="ofs-update-progress-text">
            {percent}%{progressTextOf(state) ? ` · ${progressTextOf(state)}` : ''}
          </p>
        </>
      ) : null}

      {state?.status === 'downloaded' && state.canAutoUpdate ? (
        <div className="ofs-update-setting-actions">
          <button type="button" className="ofs-btn is-primary" onClick={() => update.install()} disabled={update.busy}>
            {t('studio.update.action.installNow')}
          </button>
          <label className="ofs-update-quit-option">
            <input
              type="checkbox"
              checked={state.installOnQuit === true}
              disabled={update.busy}
              onChange={() => update.setInstallOnQuit(!(state.installOnQuit === true))}
            />
            <span>{t('studio.update.action.installOnQuit')}</span>
          </label>
        </div>
      ) : null}

      {update.gate ? (
        <p className="ofs-settings-error" role="alert">{installGateText(t, update.gate)}</p>
      ) : null}

      {state?.status === 'error' ? (
        <p className="ofs-settings-error" role="alert">{updateErrorText(t, state)}</p>
      ) : null}

      {state && !state.canAutoUpdate && formKey ? (
        <p className="ofs-settings-hint">{t(formKey)}</p>
      ) : null}

      {error ? (
        <p className="ofs-settings-error" role="alert">
          {t('settings.update.saveFailed')}
          {settingsErrorText(t, error) ? ` · ${settingsErrorText(t, error)}` : ''}
        </p>
      ) : null}
    </div>
  )
}
