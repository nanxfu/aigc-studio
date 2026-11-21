/**
 * 顶栏独立更新入口（M2.8 阶段 B）。
 *
 * 从「算力胶囊 + 红点」中独立出来：更新是应用自身的事，和云端 GPU 状态无关。
 * 弹层按状态给出：检查 / 下载 / 立即重启安装 / 退出时安装 / 打开发布页；
 * 只读形态（便携 / 解压 / 开发 / macOS 未签名 / AppImage）只提示与跳转下载页。
 */

import React from 'react'

import { Icon } from './icons.jsx'
import { formatText } from '../logic/format.js'
import {
  installGateText,
  normalizeUpdateState,
  progressPercentOf,
  progressTextOf,
  updateActionsOf,
  updateAvailableText,
  updateErrorText,
} from '../logic/update.js'
import { usePresence } from './hooks/usePresence.js'
import { useUpdate } from './hooks/useUpdate.js'

/** 只读形态 → 说明文案键。 */
const FORM_KEYS = {
  portable: 'studio.update.form.portable',
  unpacked: 'studio.update.form.unpacked',
  dev: 'studio.update.form.dev',
  'mac-unsigned': 'studio.update.form.macUnsigned',
  'linux-appimage': 'studio.update.form.linuxAppimage',
  unsupported: 'studio.update.form.unsupported',
}

/**
 * @param {object} props
 * @param {(key: string) => string} props.t
 * @param {(anchor: HTMLElement | null) => void} [props.openSettings]
 * @param {object} [props.stateOverride] 预览 / 渲染测试用的固定状态（正式界面不传）
 * @param {boolean} [props.defaultOpen] 预览 / 渲染测试用：弹层默认展开
 */
export function UpdateEntry({ t, openSettings, onDisconnect = null, stateOverride = null, defaultOpen = false }) {
  const update = useUpdate()
  const [open, setOpen] = React.useState(Boolean(defaultOpen))
  const [installOnQuit, setInstallOnQuitLocal] = React.useState(false)
  const wrapRef = React.useRef(null)
  const buttonRef = React.useRef(null)
  const presence = usePresence(open, 150)

  // 预览 / 测试可以固定状态；其余情况以 hook（桥接或轮询）为准。
  const state = React.useMemo(
    () => (stateOverride ? normalizeUpdateState(stateOverride) : update.state),
    [stateOverride, update.state],
  )
  const actions = React.useMemo(
    () => (stateOverride ? updateActionsOf(state, { busy: update.busy }) : update.actions),
    [stateOverride, state, update.busy, update.actions],
  )
  const busy = update.busy

  // 主进程状态里带 installOnQuit；本地开关跟随它（切换是异步落状态，先乐观更新）。
  React.useEffect(() => {
    if (state) setInstallOnQuitLocal(state.installOnQuit === true)
  }, [state?.installOnQuit, state?.status])

  React.useEffect(() => {
    if (!open) return undefined
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    function onDown(event) {
      const node = wrapRef.current
      if (node && !node.contains(event.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  const status = state?.status ?? 'idle'
  const checking = status === 'checking'
  const downloading = status === 'downloading'
  const percent = progressPercentOf(state)
  const formKey = state ? FORM_KEYS[state.form] : null
  const readonly = !state || !state.canAutoUpdate

  function statusLine() {
    if (!state) return t('studio.update.status.idle')
    if (status === 'error') return t('studio.update.status.error')
    if (status === 'checking') return t('studio.update.status.checking')
    if (status === 'downloading') return t('studio.update.status.downloading')
    if (status === 'downloaded') return t('studio.update.status.downloaded')
    if (state.hasUpdate) return updateAvailableText(t, state)
    if (status === 'up-to-date') {
      return formatText(t('studio.update.status.upToDate'), { version: state.latest || state.current || '—' })
    }
    return t('studio.update.status.idle')
  }

  async function onPrimary() {
    if (actions.primary === 'download') return update.download()
    if (actions.primary === 'install') return update.install()
    if (actions.primary === 'open-release') return update.openRelease(state?.releaseUrl)
    return update.check()
  }

  function primaryLabel() {
    if (actions.primary === 'download') return t('studio.update.action.download')
    if (actions.primary === 'install') return t('studio.update.action.installNow')
    if (actions.primary === 'open-release') return t('studio.update.action.openRelease')
    return checking ? t('studio.update.status.checking') : t('studio.update.action.check')
  }

  async function toggleInstallOnQuit() {
    const next = !installOnQuit
    setInstallOnQuitLocal(next)
    const result = await update.setInstallOnQuit(next)
    if (result) setInstallOnQuitLocal(result.installOnQuit === true)
  }

  return (
    <div className="ofs-update-entry" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="ofs-icon-btn ofs-topbar-update"
        onClick={() => setOpen((value) => !value)}
        title={t('studio.update.open')}
        aria-label={t('studio.update.open')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="download" size={16} className={checking || downloading ? 'ofs-spin' : ''} />
        {state?.hasUpdate ? <span className="ofs-update-dot ofs-update-entry-dot" aria-hidden="true" /> : null}
      </button>

      {presence.mounted ? (
        <div
          className="ofs-popover ofs-update-popover"
          data-exiting={presence.exiting ? 'true' : undefined}
          role="menu"
          aria-label={t('studio.update.title')}
        >
          <div className="ofs-popover-head ofs-update-head">
            <span>{t('studio.update.title')}</span>
            <span className="ofs-update-version">
              {formatText(t('studio.update.currentVersion'), { version: state?.current || '—' })}
            </span>
          </div>

          <div className="ofs-update-body">
            <p className={`ofs-update-status is-${status}`} role="status">
              {statusLine()}
            </p>

            {status === 'error' && state?.error ? (
              <p className="ofs-update-error" role="alert">
                {updateErrorText(t, state)}
              </p>
            ) : null}

            {downloading ? (
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

            {update.gate ? (
              <p className="ofs-update-error" role="alert">{installGateText(t, update.gate)}</p>
            ) : null}

            {state?.status === 'downloaded' ? (
              <label className="ofs-update-quit-option">
                <input
                  type="checkbox"
                  checked={installOnQuit}
                  onChange={toggleInstallOnQuit}
                  disabled={busy}
                />
                <span>{t('studio.update.action.installOnQuit')}</span>
              </label>
            ) : null}

            {readonly && formKey ? (
              <p className="ofs-update-readonly">{t(formKey)}</p>
            ) : null}

            {state?.releaseName && state.hasUpdate ? (
              <p className="ofs-update-release-name">{state.releaseName}</p>
            ) : null}
          </div>

          <div className="ofs-update-actions">
            <button
              type="button"
              role="menuitem"
              className="ofs-popover-row ofs-popover-action is-primary"
              onClick={onPrimary}
              disabled={busy || actions.primary === 'none'}
              aria-busy={busy || checking || downloading}
            >
              <Icon
                name={actions.primary === 'download' ? 'download' : actions.primary === 'install' ? 'check' : 'refresh'}
                size={14}
                className={busy || checking ? 'ofs-spin' : ''}
              />
              {primaryLabel()}
            </button>

            {actions.canOpenRelease && actions.primary !== 'open-release' ? (
              <button
                type="button"
                role="menuitem"
                className="ofs-popover-row"
                onClick={() => update.openRelease(state?.releaseUrl)}
              >
                <Icon name="cloud" size={14} />
                {t('studio.update.action.openRelease')}
              </button>
            ) : null}

            {/* 安装被会话 / 任务拦下时，给「先断开算力」这个直接出口。 */}
            {typeof onDisconnect === 'function' && (update.gate === 'session_active' || update.gate === 'queue_active') ? (
              <button
                type="button"
                role="menuitem"
                className="ofs-popover-row"
                onClick={() => {
                  setOpen(false)
                  onDisconnect()
                }}
              >
                <Icon name="cloud" size={14} />
                {t('studio.update.action.disconnect')}
              </button>
            ) : null}

            {openSettings ? (
              <button
                type="button"
                role="menuitem"
                className="ofs-popover-row"
                onClick={() => {
                  setOpen(false)
                  openSettings(buttonRef.current)
                }}
              >
                <Icon name="sliders" size={14} />
                {t('studio.update.action.settings')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
