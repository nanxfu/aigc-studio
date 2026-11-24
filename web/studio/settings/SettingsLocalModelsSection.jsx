/**
 * 设置弹窗 →「本机模型」（统一查阅与管理全部本机推理模型、加速后端与内置算子）。
 *
 * 覆盖：
 *  1. 硬件与统一管线探测卡片（WebGPU 适配器状态 + Web Worker 推理管线状态）；
 *  2. 全局本机模型存储目录（默认 `<userData>/models`，可自定义到非系统盘或由环境变量接管）；
 *  3. 按需下载型 ONNX 模型列表（MobileCLIP-S0、RMBG-1.4 FP16 / INT8）：
 *     支持启用/停用开关、预下载（实时进度条）、清理释放空间、查看体积与授权协议；
 *  4. 随包内置（零下载）与规划中的本机计算引擎总览（VTracer SVG、Canvas 确定性算子、Vulkan GGUF）。
 */

import React from 'react'

import { BUILTIN_LOCAL_ENGINES } from '../../../shared/local-models.js'
import {
  deleteLocalModel,
  downloadLocalModel,
  fetchLocalModels,
  saveLocalModelsDir,
  toggleLocalModel,
} from '../../api/localModels.js'
import { formatText } from '../../logic/format.js'
import { probeLocalRuntime } from '../../logic/localInference.js'
import { desktop } from '../../runtime.js'
import { Icon } from '../icons.jsx'

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 MB'
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function SettingsLocalModelsSection({ t }) {
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [data, setData] = React.useState({ dir: '', defaultDir: '', customDir: '', overrideDir: '', models: [] })
  const [dirDraft, setDirDraft] = React.useState('')
  const [dirSaving, setDirSaving] = React.useState(false)
  const [busyId, setBusyId] = React.useState('')
  const [runtimeInfo, setRuntimeInfo] = React.useState(null)

  const bridge = desktop()
  const canPickDirectory = Boolean(bridge && typeof bridge.pickDirectory === 'function')

  const refresh = React.useCallback(async () => {
    const res = await fetchLocalModels()
    setLoading(false)
    if (!res.ok) {
      setError(res.message || t('studio.settings.loadFailed'))
      return null
    }
    setError('')
    setData({
      dir: res.dir,
      defaultDir: res.defaultDir,
      customDir: res.customDir,
      overrideDir: res.overrideDir,
      models: res.models,
    })
    return res
  }, [t])

  React.useEffect(() => {
    void refresh().then((res) => {
      if (res) setDirDraft(res.customDir || '')
    })
    void probeLocalRuntime().then((info) => {
      setRuntimeInfo(info)
    })
  }, [refresh])

  const hasDownloading = data.models.some((item) => item.status === 'downloading')

  React.useEffect(() => {
    if (!hasDownloading) return undefined
    const timer = setInterval(() => {
      void refresh()
    }, 500)
    return () => clearInterval(timer)
  }, [hasDownloading, refresh])

  async function handleSaveDir(nextDir) {
    if (dirSaving) return
    setDirSaving(true)
    setError('')
    const res = await saveLocalModelsDir(nextDir)
    setDirSaving(false)
    if (!res.ok) {
      setError(res.message || t('settings.localModels.dirSaveFailed'))
      return
    }
    setData({
      dir: res.dir,
      defaultDir: res.defaultDir,
      customDir: res.customDir,
      overrideDir: res.overrideDir,
      models: res.models,
    })
    setDirDraft(res.customDir || '')
  }

  async function handlePickDirectory() {
    if (!canPickDirectory || dirSaving) return
    const picked = await bridge.pickDirectory()
    if (!picked) return
    setDirDraft(picked)
    void handleSaveDir(picked)
  }

  async function handleDownload(id) {
    if (busyId) return
    setBusyId(id)
    setError('')
    const res = await downloadLocalModel(id)
    setBusyId('')
    if (!res.ok) setError(res.message || t('settings.localModels.downloadFailed'))
    await refresh()
  }

  async function handleDelete(id) {
    if (busyId) return
    setBusyId(id)
    setError('')
    const res = await deleteLocalModel(id)
    setBusyId('')
    if (!res.ok) setError(res.message || t('settings.localModels.deleteFailed'))
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

  const readyBytes = data.models
    .filter((item) => item.status === 'ready')
    .reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)

  const webGpuBadge = runtimeInfo
    ? (runtimeInfo.webGpu ? 'is-ok' : 'is-warn')
    : ''
  const webGpuStatusText = !runtimeInfo
    ? t('settings.localModels.runtime.probing')
    : runtimeInfo.webGpu
      ? formatText(t('settings.localModels.runtime.webgpuReady'), {
          adapter: runtimeInfo.adapterLabel || 'WebGPU',
        })
      : t('settings.localModels.runtime.wasmFallback')

  return (
    <div className="ofs-settings-pane ofs-local-models">
      <div className="ofs-settings-section">
        <div className="ofs-settings-block-head">
          <div className="ofs-settings-block-copy">
            <span className="ofs-settings-block-title">{t('settings.localModels.runtimeTitle')}</span>
            <span className="ofs-settings-block-sub">{t('settings.localModels.runtimeHint')}</span>
          </div>
          <span className={`ofs-settings-block-badge ${webGpuBadge}`.trim()}>{webGpuStatusText}</span>
        </div>
      </div>

      <div className="ofs-settings-section">
        <div className="ofs-settings-block-head">
          <div className="ofs-settings-block-copy">
            <span className="ofs-settings-block-title">{t('settings.localModels.dirTitle')}</span>
            <span className="ofs-settings-block-sub">
              {formatText(t('settings.localModels.effectiveDir'), {
                dir: data.dir || data.defaultDir || '—',
              })}
            </span>
          </div>
          <span className="ofs-settings-block-badge">
            {formatText(t('settings.localModels.diskUsage'), { size: formatBytes(readyBytes) })}
          </span>
        </div>

        <div className="ofs-local-models-dir-row">
          <input
            type="text"
            className="ofs-settings-input"
            value={dirDraft}
            disabled={dirSaving || Boolean(data.overrideDir)}
            placeholder={data.defaultDir || t('settings.localModels.dirPlaceholder')}
            aria-label={t('settings.localModels.dirTitle')}
            onChange={(event) => setDirDraft(event.target.value)}
            onBlur={() => {
              const trimmed = dirDraft.trim()
              if (trimmed !== (data.customDir || '')) void handleSaveDir(trimmed)
            }}
          />
          {canPickDirectory ? (
            <button
              type="button"
              className="ofs-chip"
              disabled={dirSaving || Boolean(data.overrideDir)}
              onClick={handlePickDirectory}
            >
              <Icon name="folderOpen" size={13} />
              {t('settings.localModels.browse')}
            </button>
          ) : null}
          {data.customDir && !data.overrideDir ? (
            <button
              type="button"
              className="ofs-chip"
              disabled={dirSaving}
              onClick={() => handleSaveDir('')}
            >
              {t('settings.localModels.resetDir')}
            </button>
          ) : null}
        </div>
        {data.overrideDir ? (
          <p className="ofs-settings-hint">{t('settings.localModels.overrideHint')}</p>
        ) : (
          <p className="ofs-settings-hint">{t('settings.localModels.dirHint')}</p>
        )}
      </div>

      {error ? (
        <p className="ofs-settings-error" role="alert">{error}</p>
      ) : null}

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
          {data.models.map((item) => {
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
                        onClick={() => void handleDelete(item.id)}
                      >
                        <Icon name="trash" size={12} />
                        {t('settings.localModels.delete')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ofs-chip"
                        disabled={busyId === item.id || item.status === 'downloading' || item.disabled}
                        onClick={() => void handleDownload(item.id)}
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
            return (
              <div key={engine.id} className="ofs-local-model-card" data-engine-id={engine.id}>
                <div className="ofs-local-model-head">
                  <div className="ofs-local-model-title-wrap">
                    <span className="ofs-local-model-title">{t(`settings.localModels.engine.${engine.id}`)}</span>
                    <span className="ofs-local-model-meta">{`${engine.packageName} · ${engine.runtime}`}</span>
                  </div>
                  <span className={`ofs-settings-block-badge ${isBuiltin ? 'is-ok' : ''}`.trim()}>
                    {t(isBuiltin ? 'settings.localModels.engineStatus.builtin' : 'settings.localModels.engineStatus.planned')}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
