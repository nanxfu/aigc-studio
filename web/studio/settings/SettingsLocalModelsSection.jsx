/**
 * 「本机模型」页签：只负责离线辅助组件与统一存储目录。
 *
 * 生图算力硬件、引擎状态与绘画权重下载都在「生图算力」页签和顶栏模型卡中，
 * 这里保留视觉感知 / 抠图 ONNX 组件和只读内置能力清单，不与算力设置互相跳转。
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

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 MB'
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function SettingsLocalModelsSection({ t }) {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [models, setModels] = React.useState([])
  const [busyId, setBusyId] = React.useState('')

  const refresh = React.useCallback(async () => {
    const res = await fetchLocalModels()
    setLoading(false)
    if (!res.ok) {
      setError(res.message || t('studio.settings.loadFailed'))
      return
    }
    setError('')
    setModels(res.models)
  }, [t])

  React.useEffect(() => { void refresh() }, [refresh])

  const hasDownloading = models.some((item) => item.status === 'downloading')
  React.useEffect(() => {
    if (!hasDownloading) return undefined
    const timer = setInterval(() => { void refresh() }, 500)
    return () => clearInterval(timer)
  }, [hasDownloading, refresh])

  async function run(id, action) {
    if (busyId) return
    setBusyId(id)
    setError('')
    const res = await action(id)
    setBusyId('')
    if (!res.ok) setError(res.message || t('studio.settings.loadFailed'))
    await refresh()
  }

  async function handleToggle(item) {
    if (busyId || item.disabledBy === 'env') return
    setBusyId(item.id)
    setError('')
    const res = await toggleLocalModel(item.id, Boolean(item.disabled))
    setBusyId('')
    if (!res.ok) setError(res.message || t('settings.localModels.toggleFailed'))
    await refresh()
  }

  return (
    <div className="ofs-settings-pane ofs-local-models">
      <LocalModelStorageField t={t} onChanged={() => void refresh()} />

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
            disabled={loading}
            onClick={() => void refresh()}
          >
            {t('studio.refresh')}
          </button>
        </div>

        {loading ? <p className="ofs-settings-note">{t('studio.settings.loading')}</p> : null}

        <div className="ofs-local-models-list">
          {models.map((item) => {
            const pct = item.totalBytes > 0
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
                  ? formatText(t('settings.localModels.status.downloading'), { pct })
                  : item.status === 'error'
                    ? t('settings.localModels.status.error')
                    : t('settings.localModels.status.missing')
            return (
              <div key={item.id} className="ofs-local-model-card" data-model-id={item.id}>
                <div className="ofs-local-model-head">
                  <div className="ofs-local-model-title-wrap">
                    <span className="ofs-local-model-title">{item.label}</span>
                    <span className="ofs-local-model-meta">
                      {`${formatBytes(item.bytes)} · ${item.grade || item.runtime} · ${item.license?.name || ''}`}
                    </span>
                  </div>
                  <span className={`ofs-settings-block-badge ${badgeClass}`.trim()}>{statusText}</span>
                </div>
                {item.status === 'downloading' ? (
                  <div className="ofs-local-model-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <span className="ofs-local-model-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                ) : null}
                {item.status === 'error' && item.error ? (
                  <p className="ofs-local-model-err">{item.error}</p>
                ) : null}
                <div className="ofs-local-model-foot">
                  <span className="ofs-local-model-repo">{item.repo}</span>
                  <div className="ofs-local-model-actions">
                    {item.optional ? (
                      <button
                        type="button"
                        className="ofs-chip"
                        disabled={busyId === item.id || item.disabledBy === 'env'}
                        onClick={() => void handleToggle(item)}
                      >
                        {item.disabled ? t('settings.localModels.enable') : t('settings.localModels.disable')}
                      </button>
                    ) : null}
                    {item.status === 'ready' ? (
                      <button
                        type="button"
                        className="ofs-chip"
                        disabled={busyId === item.id}
                        onClick={() => void run(item.id, deleteLocalModel)}
                      >
                        <Icon name="trash" size={12} />
                        {t('settings.localModels.delete')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ofs-chip"
                        disabled={busyId === item.id || item.status === 'downloading' || item.disabled}
                        onClick={() => void run(item.id, downloadLocalModel)}
                      >
                        <Icon name="download" size={12} />
                        {item.status === 'downloading'
                          ? t('settings.localModels.downloadingBtn')
                          : t('settings.localModels.download')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="ofs-settings-section">
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
