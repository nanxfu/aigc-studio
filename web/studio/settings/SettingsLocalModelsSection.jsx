/**
 * 「本机模型」页签：统一管理视觉 / 抠图 / 深度 / 超分等端侧 ONNX 与存储目录。
 *
 * 生图算力硬件、引擎状态与绘画权重下载都在「生图算力」页签和顶栏模型卡中，
 * 这里保留全部可下载 ONNX 组件和只读内置能力清单，不与算力设置互相跳转。
 */

import React from 'react'

import { BUILTIN_LOCAL_ENGINES } from '../../../shared/local-models.js'
import {
  deleteLocalModel,
  downloadLocalModel,
  fetchLocalModels,
  toggleLocalModel,
} from '../../api/localModels.js'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'
import { LocalModelStorageField } from './LocalModelStorageField.jsx'
import { settingsErrorText } from '../../logic/settings.js'

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 MB'
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function SettingsLocalModelsSection({ t, onStateChange = null }) {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [models, setModels] = React.useState([])
  const [busyId, setBusyId] = React.useState('')
  const [confirmDeleteId, setConfirmDeleteId] = React.useState('')
  const [storageState, setStorageState] = React.useState({ dirty: false, busy: false, canSave: false })
  const storageActionsRef = React.useRef({})
  const actionLockRef = React.useRef(false)
  const aliveRef = React.useRef(false)
  const refreshSeqRef = React.useRef(0)

  React.useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  const reportStorage = React.useCallback((state) => {
    storageActionsRef.current = state
    setStorageState((previous) => (
      previous.dirty === state.dirty && previous.busy === state.busy && previous.canSave === state.canSave
        ? previous
        : { dirty: state.dirty, busy: state.busy, canSave: state.canSave }
    ))
  }, [])
  React.useEffect(() => {
    onStateChange?.({
      ...storageState,
      busy: storageState.busy || Boolean(busyId),
      save: () => storageActionsRef.current.save?.(),
    })
  }, [storageState.dirty, storageState.canSave, storageState.busy, busyId, onStateChange])

  const refresh = React.useCallback(async () => {
    const seq = ++refreshSeqRef.current
    const res = await fetchLocalModels()
    if (!aliveRef.current || seq !== refreshSeqRef.current) return
    setLoading(false)
    if (!res.ok) {
      setError(settingsErrorText(t, res) || t('studio.settings.loadFailed'))
      return
    }
    setModels(res.models)
  }, [t.lang])

  React.useEffect(() => { void refresh() }, [refresh])

  const hasDownloading = models.some((item) => item.status === 'downloading')
  React.useEffect(() => {
    if (!hasDownloading) return undefined
    const timer = setInterval(() => { void refresh() }, 500)
    return () => clearInterval(timer)
  }, [hasDownloading, refresh])

  async function run(id, action) {
    if (actionLockRef.current) return
    actionLockRef.current = true
    setBusyId(id)
    setError('')
    const res = await action(id)
    await refresh()
    actionLockRef.current = false
    if (!aliveRef.current) return
    setBusyId('')
    setConfirmDeleteId('')
    if (!res.ok) setError(settingsErrorText(t, res) || t('studio.settings.loadFailed'))
  }

  async function handleToggle(item) {
    if (item.disabledBy === 'env') return
    await run(item.id, () => toggleLocalModel(item.id, Boolean(item.disabled)))
  }

  return (
    <div className="ofs-settings-pane ofs-local-models">
      <LocalModelStorageField t={t} onChanged={() => void refresh()} onStateChange={reportStorage} />

      {error ? <p className="ofs-settings-error" role="alert">{error}</p> : null}

      <div className="ofs-settings-section">
        <div className="ofs-settings-block-head">
          <div className="ofs-settings-block-copy">
            <span className="ofs-settings-block-title">{t('settings.localModels.listTitle')}</span>
            <span className="ofs-settings-block-sub">{t('settings.localModels.listHint')}</span>
          </div>
          <button
            type="button"
            className="ofs-chip"
            disabled={loading || Boolean(busyId)}
            onClick={() => { setError(''); void refresh() }}
          >
            <Icon name="refresh" size={12} />
            {t('settings.localModels.refresh')}
          </button>
        </div>

        {loading ? <p className="ofs-settings-note">{t('studio.settings.loading')}</p> : null}

        <div className="ofs-local-models-list">
          {models.map((item) => {
            const knownTotal = Number(item.totalBytes) > 0
            const pct = knownTotal
              ? Math.min(100, Math.round(((item.downloadedBytes || 0) / item.totalBytes) * 100))
              : 0
            const badgeClass = item.disabled
              ? 'is-warn'
              : item.status === 'ready'
                ? 'is-ok'
                : item.status === 'error'
                  ? 'is-error'
                  : item.status === 'downloading'
                    ? 'is-warn'
                    : ''
            const statusText = item.disabled
              ? (item.disabledBy === 'env'
                  ? t('settings.localModels.status.disabledEnv')
                  : t('settings.localModels.status.disabled'))
              : item.status === 'ready'
                ? t('settings.localModels.status.ready')
                : item.status === 'downloading'
                  ? knownTotal ? formatText(t('settings.localModels.status.downloading'), { pct }) : t('settings.localModels.downloadingBtn')
                  : item.status === 'error'
                    ? t('settings.localModels.status.error')
                    : t('settings.localModels.status.missing')
            return (
              <div key={item.id} className="ofs-local-model-card" data-model-id={item.id}>
                <div className="ofs-local-model-head" aria-busy={busyId === item.id}>
                  <div className="ofs-local-model-title-wrap">
                    <span className="ofs-local-model-title">{item.label}</span>
                    <span className="ofs-local-model-meta">
                      {[formatBytes(item.bytes), item.runtime?.toUpperCase(), item.license?.name].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <span className={`ofs-settings-block-badge ${badgeClass}`.trim()}>{statusText}</span>
                </div>
                {item.status === 'downloading' ? (
                  <div className="ofs-local-model-download">
                  <progress className="ofs-local-model-progress" aria-label={formatText(t('settings.localModels.downloadProgress'), { model: item.label })} value={knownTotal ? pct : undefined} max={100} />
                  <span className="ofs-local-model-meta">{formatBytes(item.downloadedBytes)}{knownTotal ? ` / ${formatBytes(item.totalBytes)}` : ''}</span>
                  </div>
                ) : null}
                {item.status === 'error' && item.error ? (
                  <p className="ofs-local-model-err" role="alert">{item.error}</p>
                ) : null}
                <div className="ofs-local-model-foot">
                  <span className="ofs-local-model-repo" title={item.repo}>{item.repo}</span>
                  <div className="ofs-local-model-actions">
                    {item.optional ? (
                      <button
                        type="button"
                        className="ofs-chip"
                        disabled={Boolean(busyId) || item.status === 'downloading' || item.disabledBy === 'env'}
                        onClick={() => void handleToggle(item)}
                      >
                        {item.disabled ? t('settings.localModels.enable') : t('settings.localModels.disable')}
                      </button>
                    ) : null}
                    {item.status === 'ready' ? (
                      <button
                        type="button"
                        className="ofs-chip"
                        disabled={Boolean(busyId)}
                        onClick={() => setConfirmDeleteId(item.id)}
                      >
                        <Icon name="trash" size={12} />
                        {t('settings.localModels.delete')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ofs-chip"
                        disabled={Boolean(busyId) || item.status === 'downloading' || item.disabled}
                        onClick={() => void run(item.id, downloadLocalModel)}
                      >
                        <Icon name="download" size={12} />
                        {item.status === 'downloading'
                          ? t('settings.localModels.downloadingBtn')
                          : item.status === 'error' ? t('studio.settings.retry') : t('settings.localModels.download')}
                      </button>
                    )}
                  </div>
                </div>
                {confirmDeleteId === item.id ? <div className="ofs-local-model-confirm">
                  <p role="alert">{formatText(t('settings.localModels.confirmDelete'), { model: item.label, size: formatBytes(item.bytes) })}</p>
                  <div className="ofs-local-model-actions">
                    <button type="button" className="ofs-chip" disabled={Boolean(busyId)} onClick={() => setConfirmDeleteId('')}>{t('settings.localModels.keep')}</button>
                    <button type="button" className="ofs-chip" disabled={Boolean(busyId)} onClick={() => void run(item.id, deleteLocalModel)}>{t('settings.localModels.confirmClear')}</button>
                  </div>
                </div> : null}
              </div>
            )
          })}
        </div>
        {!loading && models.length === 0 && !error ? <p className="ofs-settings-hint" role="status">{t('settings.localModels.empty')}</p> : null}
      </div>

      <div className="ofs-settings-section ofs-local-builtin-section">
        <div className="ofs-settings-block-head">
          <div className="ofs-settings-block-copy">
            <span className="ofs-settings-block-title">{t('settings.localModels.builtinTitle')}</span>
            <span className="ofs-settings-block-sub">{t('settings.localModels.builtinHint')}</span>
          </div>
        </div>
        <div className="ofs-local-models-list">
          {BUILTIN_LOCAL_ENGINES.map((engine) => {
            const isBuiltin = engine.status === 'builtin'
            const badgeClass = isBuiltin ? 'is-ok' : ''
            const badgeText = isBuiltin
              ? t('settings.localModels.engineStatus.builtin')
              : t('settings.localModels.engineStatus.configurable')
            return (
              <div key={engine.id} className="ofs-local-model-card" data-engine-id={engine.id}>
                <div className="ofs-local-model-head">
                  <div className="ofs-local-model-title-wrap">
                    <span className="ofs-local-model-title">{t(`settings.localModels.engine.${engine.id}`)}</span>
                    <span className="ofs-local-model-meta">{t('settings.localModels.engineMeta')}</span>
                  </div>
                  <span className={`ofs-settings-block-badge ${badgeClass}`.trim()}>{badgeText}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
