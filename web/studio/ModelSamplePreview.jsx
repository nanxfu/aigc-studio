/**
 * 模型选择卡左侧悬浮的极简暗房样片预览面板（Contact Sheet）。
 *
 * 设计克制原则：
 *  - 画面为主角（占比 ≥80%），无多余徽标、文字药丸与底栏废话；
 *  - 默认「大主图 + 底部一行 9 格真图胶片条」，悬停/点击胶片条或滚动滚轮即可丝滑切题；
 *  - 右上角提供极轻的 3×3 九宫格全景切换，点击任意格即放大回单图。
 */

import React from 'react'

import { formatSeconds } from '../logic/format.js'

function shortOf(preset) {
  return preset?.short || preset?.label || preset?.id || ''
}

function dimShortOf(dim, isEn) {
  return isEn ? dim.shortEn : dim.shortZh
}

function dimTitleOf(dim, isEn) {
  return isEn ? dim.titleEn : dim.titleZh
}

export function ModelSamplePreview({
  t,
  isEn,
  preset,
  samples,
  dims,
  selectedDimId,
  onSelectDim,
  viewMode,
  onViewModeChange,
  onMouseEnter,
}) {
  const [gridHoverDimId, setGridHoverDimId] = React.useState(null)

  if (!preset || !samples || typeof samples !== 'object') return null
  const availableDims = dims.filter((dim) => Boolean(samples[dim.id]))
  if (availableDims.length === 0) return null

  const activeDim =
    availableDims.find((dim) => dim.id === selectedDimId) || availableDims[0]
  const activeSample = samples[activeDim.id]
  const isGrid = viewMode === 'grid'

  const headerDim =
    (isGrid && gridHoverDimId && availableDims.find((d) => d.id === gridHoverDimId)) ||
    activeDim
  const headerSample = headerDim ? samples[headerDim.id] : activeSample

  function stepDim(delta) {
    if (availableDims.length <= 1) return
    const idx = availableDims.findIndex((d) => d.id === activeDim.id)
    const nextIdx = (idx + delta + availableDims.length) % availableDims.length
    onSelectDim(availableDims[nextIdx].id)
  }

  return (
    <div
      className="ofs-model-preview"
      role="region"
      aria-label={`${shortOf(preset)} ${t('studio.preset.previewTitle')}`}
      onMouseEnter={onMouseEnter}
      onMouseDown={(event) => event.preventDefault()}
      onWheel={(event) => {
        if (isGrid || Math.abs(event.deltaY) < 4) return
        event.preventDefault()
        event.stopPropagation()
        stepDim(event.deltaY > 0 ? 1 : -1)
      }}
    >
      <div className="ofs-model-preview-head">
        <div className="ofs-model-preview-title">
          <span className="ofs-model-preview-name">{shortOf(preset)}</span>
          <span className="ofs-model-preview-sep" aria-hidden="true">·</span>
          <span className="ofs-model-preview-dim">{dimShortOf(headerDim, isEn)}</span>
        </div>
        <div className="ofs-model-preview-actions">
          {Number.isFinite(Number(headerSample?.seconds)) ? (
            <span className="ofs-model-preview-sec">
              {formatSeconds(t, headerSample.seconds)}
            </span>
          ) : null}
          <button
            type="button"
            className={`ofs-model-preview-toggle${isGrid ? ' is-on' : ''}`}
            aria-pressed={isGrid ? 'true' : 'false'}
            aria-label={isGrid ? t('studio.preset.previewDetail') : t('studio.preset.previewGrid')}
            title={isGrid ? t('studio.preset.previewDetail') : t('studio.preset.previewGrid')}
            onClick={() => onViewModeChange(isGrid ? 'detail' : 'grid')}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <rect x="1.5" y="1.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="5.5" y="1.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="9.5" y="1.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="1.5" y="5.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="5.5" y="5.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="9.5" y="5.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="1.5" y="9.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="5.5" y="9.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
              <rect x="9.5" y="9.5" width="3" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.25" />
            </svg>
          </button>
        </div>
      </div>

      {isGrid ? (
        <div
          className="ofs-model-preview-matrix"
          onMouseLeave={() => setGridHoverDimId(null)}
        >
          {dims.map((dim) => {
            const sample = samples[dim.id]
            if (!sample) {
              return <div key={dim.id} className="ofs-model-preview-cell is-empty" aria-hidden="true" />
            }
            const isCurrent = dim.id === activeDim.id
            return (
              <button
                key={dim.id}
                type="button"
                className={`ofs-model-preview-cell${isCurrent ? ' is-on' : ''}`}
                title={dimTitleOf(dim, isEn)}
                onMouseEnter={() => setGridHoverDimId(dim.id)}
                onClick={() => {
                  onSelectDim(dim.id)
                  onViewModeChange('detail')
                }}
              >
                <img
                  src={sample.url}
                  alt={`${shortOf(preset)} · ${dimTitleOf(dim, isEn)}`}
                  loading="lazy"
                  draggable="false"
                />
              </button>
            )
          })}
        </div>
      ) : (
        <>
          <div className="ofs-model-preview-stage">
            <img
              key={`${preset.id}:${activeDim.id}`}
              src={activeSample.url}
              alt={`${shortOf(preset)} · ${dimTitleOf(activeDim, isEn)}`}
              draggable="false"
            />
          </div>
          <div
            className="ofs-model-preview-strip"
            role="tablist"
            aria-label={t('studio.preset.previewDims')}
          >
            {dims.map((dim) => {
              const sample = samples[dim.id]
              const isCurrent = dim.id === activeDim.id
              return (
                <button
                  key={dim.id}
                  type="button"
                  role="tab"
                  disabled={!sample}
                  aria-selected={isCurrent ? 'true' : 'false'}
                  className={`ofs-model-preview-thumb${isCurrent ? ' is-on' : ''}`}
                  title={dimTitleOf(dim, isEn)}
                  onMouseEnter={() => {
                    if (sample) onSelectDim(dim.id)
                  }}
                  onClick={() => {
                    if (sample) onSelectDim(dim.id)
                  }}
                >
                  {sample ? (
                    <img src={sample.url} alt="" loading="lazy" draggable="false" />
                  ) : null}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
