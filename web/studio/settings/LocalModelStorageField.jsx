/**
 * 全局本机模型目录的唯一编辑控件。
 *
 * 「生图算力」与「本机模型」两个页签共用同一份 /api/local-models/dir，
 * 避免用户在两处看到不同的默认目录或各自维护一套路径。
 */

import React from 'react'

import { fetchLocalModels, saveLocalModelsDir } from '../../api/localModels.js'
import { formatText } from '../../logic/format.js'
import { desktop } from '../../runtime.js'
import { Icon } from '../icons.jsx'

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 MB'
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function LocalModelStorageField({ t, onChanged = null, collapsible = false }) {
  const [expanded, setExpanded] = React.useState(false)
  const fieldId = React.useId()
  const [data, setData] = React.useState({ dir: '', defaultDir: '', customDir: '', overrideDir: '', models: [] })
  const [draft, setDraft] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const bridge = desktop()
  const canPickDirectory = Boolean(bridge && typeof bridge.pickDirectory === 'function')

  const apply = React.useCallback((next) => {
    setData({
      dir: next.dir || '',
      defaultDir: next.defaultDir || '',
      customDir: next.customDir || '',
      overrideDir: next.overrideDir || '',
      models: Array.isArray(next.models) ? next.models : [],
    })
    setDraft(next.customDir || '')
  }, [])

  React.useEffect(() => {
    let alive = true
    fetchLocalModels().then((res) => {
      if (!alive) return
      if (res.ok) apply(res)
      else setError(res.message || t('settings.localModels.dirLoadFailed'))
    }).catch(() => {})
    return () => { alive = false }
  }, [apply, t])

  async function save(nextDir) {
    if (saving) return
    setSaving(true)
    setError('')
    const res = await saveLocalModelsDir(nextDir)
    setSaving(false)
    if (!res.ok) {
      setError(res.message || t('settings.localModels.dirSaveFailed'))
      return
    }
    apply(res)
    onChanged?.(res)
  }

  async function pickDirectory() {
    if (!canPickDirectory || saving) return
    const picked = await bridge.pickDirectory()
    if (!picked) return
    setDraft(picked)
    await save(picked)
  }

  const readyBytes = data.models
    .filter((item) => item.status === 'ready')
    .reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)

  return (
    <div className="ofs-settings-field" data-testid="local-model-storage">
      {collapsible ? (
        <button
          type="button"
          className="ofs-settings-advanced-toggle ofs-local-gpu-storage-toggle"
          aria-expanded={expanded}
          aria-controls={fieldId}
          onClick={() => setExpanded((open) => !open)}
        >
          <span>{t('settings.localModels.dirTitle')}</span>
          <span className="ofs-local-gpu-storage-summary">
            <span className="ofs-settings-muted">
              {formatText(t('settings.localModels.diskUsage'), { size: formatBytes(readyBytes) })}
            </span>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
          </span>
        </button>
      ) : (
        <div className="ofs-settings-label-row">
          <span className="ofs-settings-label">{t('settings.localModels.dirTitle')}</span>
          <span className="ofs-settings-muted">
            {formatText(t('settings.localModels.diskUsage'), { size: formatBytes(readyBytes) })}
          </span>
        </div>
      )}
      <div id={fieldId} hidden={collapsible && !expanded}>
        <div className="ofs-local-models-dir-row">
          <input
            type="text"
            className="ofs-settings-input ofs-grow"
            value={draft}
            disabled={saving || Boolean(data.overrideDir)}
            placeholder={data.defaultDir || t('settings.localModels.dirPlaceholder')}
            aria-label={t('settings.localModels.dirTitle')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              const trimmed = draft.trim()
              if (trimmed !== (data.customDir || '')) void save(trimmed)
            }}
          />
          {canPickDirectory ? (
            <button
              type="button"
              className="ofs-chip"
              disabled={saving || Boolean(data.overrideDir)}
              onClick={() => void pickDirectory()}
            >
              <Icon name="folderOpen" size={13} />
              {t('settings.localModels.browse')}
            </button>
          ) : null}
          {data.customDir && !data.overrideDir ? (
            <button
              type="button"
              className="ofs-chip"
              disabled={saving}
              onClick={() => void save('')}
            >
              {t('settings.localModels.resetDir')}
            </button>
          ) : null}
        </div>
        {!collapsible || data.overrideDir ? (
          <small className="ofs-settings-hint">
            {data.overrideDir
              ? t('settings.localModels.overrideHint')
              : formatText(t('settings.localModels.effectiveDir'), {
                  dir: data.dir || data.defaultDir || '—',
                })}
          </small>
        ) : null}
      </div>
      {error ? <p className="ofs-settings-error" role="alert">{error}</p> : null}
    </div>
  )
}
