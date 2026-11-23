/**
 * 工坊左侧参数区：按当前工具渲染参数控件与运行按钮。
 *
 * 纯展示组件：所有状态与动作由 Workshop 主组件持有，这里只做输入 → setter 的转发，
 * 保证「参数面板」与「预览 / 保存」共用同一份状态，不出现两套读数。
 */

import React from 'react'

import { WORKSHOP } from '../../../shared/contract.js'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'

/** 数字输入：空值回落到最小值，避免受控组件拿到 NaN。 */
function numberValue(event, min) {
  const value = Number(event && event.target ? event.target.value : '')
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.round(value))
}

/** 选择一项模型时同时展示协议标签（质量 / 许可 / 备注），下游按 id 提交。 */
function ModelSelect(props) {
  const { t, labelKey, models, value, onChange } = props
  const list = Array.isArray(models) ? models : []
  const current = list.find((model) => model && model.id === value) || list[0] || null
  return (
    <>
      <label className="ofs-field">
        <span>{t(labelKey)}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {list.map((model) => (
            <option key={model.id} value={model.id}>
              {`${model.label} · ${model.grade}`}
            </option>
          ))}
        </select>
      </label>
      {current ? (
        <p className="ofs-workshop-model-note" data-license={current.licenseKind}>
          {formatText(t('studio.workshop.modelLicense'), {
            license: current.license,
            note: current.note,
          })}
        </p>
      ) : null}
    </>
  )
}

export function WorkshopParams(props) {
  const {
    t,
    tool,
    pixel,
    setPixel,
    sprite,
    setSprite,
    tile,
    setTile,
    vector,
    setVector,
    cutoutModel,
    setCutoutModel,
    pbrModel,
    setPbrModel,
    pbrSteps,
    setPbrSteps,
    detected,
    seam,
    spriteFrames,
    busy,
    canApply,
    canRunGpu,
    onDetect,
    onApply,
    onVectorize,
    onRunGpu,
    modelReady,
  } = props

  const disabled = busy !== ''

  if (tool === 'pixel-snap') {
    return (
      <div className="ofs-workshop-params-grid">
        <p className="ofs-workshop-readout">
          {detected && detected.confidence > 0
            ? formatText(t('studio.workshop.detected'), {
                cell: detected.cell,
                confidence: detected.confidence,
              })
            : t('studio.workshop.detectedNone')}
        </p>
        <div className="ofs-workshop-param-row">
          <label className="ofs-field">
            <span>{t('studio.workshop.grid')}</span>
            <input
              type="number"
              min={WORKSHOP.pixel.grid.min}
              max={WORKSHOP.pixel.grid.max}
              value={pixel.cell}
              onChange={(event) => setPixel({ cell: numberValue(event, WORKSHOP.pixel.grid.min) })}
            />
          </label>
          <label className="ofs-field">
            <span>{t('studio.workshop.colors')}</span>
            <input
              type="number"
              min={WORKSHOP.pixel.colors.min}
              max={WORKSHOP.pixel.colors.max}
              value={pixel.colors}
              onChange={(event) => setPixel({ colors: numberValue(event, WORKSHOP.pixel.colors.min) })}
            />
          </label>
        </div>
        <div className="ofs-workshop-param-row">
          <label className="ofs-field">
            <span>{t('studio.workshop.alphaThreshold')}</span>
            <input
              type="number"
              min={WORKSHOP.pixel.alphaThreshold.min}
              max={WORKSHOP.pixel.alphaThreshold.max}
              value={pixel.alphaThreshold}
              onChange={(event) => setPixel({ alphaThreshold: numberValue(event, WORKSHOP.pixel.alphaThreshold.min) })}
            />
          </label>
          <label className="ofs-field">
            <span>{t('studio.workshop.scale')}</span>
            <input
              type="number"
              min={WORKSHOP.pixel.scale.min}
              max={WORKSHOP.pixel.scale.max}
              value={pixel.scale}
              onChange={(event) => setPixel({ scale: numberValue(event, WORKSHOP.pixel.scale.min) })}
            />
          </label>
        </div>
        <div className="ofs-workshop-actions">
          <button type="button" className="ofs-chip ofs-workshop-detect" disabled={disabled} onClick={onDetect}>
            {t('studio.workshop.detect')}
          </button>
          <button type="button" className="ofs-workshop-apply" disabled={disabled || !canApply} onClick={onApply}>
            {t('studio.workshop.apply')}
          </button>
        </div>
      </div>
    )
  }

  if (tool === 'sprite-slice') {
    const frameCount = spriteFrames && Array.isArray(spriteFrames.frames) ? spriteFrames.frames.length : 0
    const frameSize = spriteFrames && spriteFrames.atlas && spriteFrames.atlas.meta
      ? spriteFrames.atlas.meta.frameSize
      : null
    return (
      <div className="ofs-workshop-params-grid">
        <div className="ofs-workshop-param-row">
          <label className="ofs-field">
            <span>{t('studio.workshop.rows')}</span>
            <input
              type="number"
              min={WORKSHOP.sprite.rows.min}
              max={WORKSHOP.sprite.rows.max}
              value={sprite.rows}
              onChange={(event) => setSprite({ rows: numberValue(event, WORKSHOP.sprite.rows.min) })}
            />
          </label>
          <label className="ofs-field">
            <span>{t('studio.workshop.cols')}</span>
            <input
              type="number"
              min={WORKSHOP.sprite.cols.min}
              max={WORKSHOP.sprite.cols.max}
              value={sprite.cols}
              onChange={(event) => setSprite({ cols: numberValue(event, WORKSHOP.sprite.cols.min) })}
            />
          </label>
        </div>
        <label className="ofs-field">
          <span>{t('studio.workshop.frameMs')}</span>
          <input
            type="number"
            min={WORKSHOP.sprite.frameMs.min}
            max={WORKSHOP.sprite.frameMs.max}
            value={sprite.frameMs}
            onChange={(event) => setSprite({ frameMs: numberValue(event, WORKSHOP.sprite.frameMs.min) })}
          />
        </label>
        <label className="ofs-workshop-check">
          <input
            type="checkbox"
            checked={sprite.trimAlpha === true}
            onChange={(event) => setSprite({ trimAlpha: Boolean(event.target.checked) })}
          />
          <span>{t('studio.workshop.trimAlpha')}</span>
        </label>
        {frameSize ? (
          <p className="ofs-workshop-readout">
            {formatText(t('studio.workshop.framesReadout'), {
              count: frameCount,
              width: frameSize.w,
              height: frameSize.h,
            })}
          </p>
        ) : null}
        <div className="ofs-workshop-actions">
          <button type="button" className="ofs-workshop-apply" disabled={disabled || !canApply} onClick={onApply}>
            {t('studio.workshop.apply')}
          </button>
        </div>
      </div>
    )
  }

  if (tool === 'tile') {
    return (
      <div className="ofs-workshop-params-grid">
        {seam ? (
          <p className="ofs-workshop-readout">
            {formatText(t('studio.workshop.seamReadout'), {
              mae: seam.maxSeamMae,
              threshold: seam.threshold,
            })}
            <span className={seam.isSeamless ? 'ofs-workshop-seam is-ok' : 'ofs-workshop-seam is-bad'}>
              {t(seam.isSeamless ? 'studio.workshop.seamOk' : 'studio.workshop.seamBad')}
            </span>
          </p>
        ) : null}
        <label className="ofs-workshop-check">
          <input
            type="checkbox"
            checked={tile.blend === true}
            onChange={(event) => setTile({ blend: Boolean(event.target.checked) })}
          />
          <span>{t('studio.workshop.blend')}</span>
        </label>
        <label className="ofs-field">
          <span>{t('studio.workshop.blendRatio')}</span>
          <input
            className="ofs-workshop-range"
            type="range"
            min={WORKSHOP.tile.blendRatio.min}
            max={WORKSHOP.tile.blendRatio.max}
            step="0.01"
            value={tile.blendRatio}
            onChange={(event) => setTile({ blendRatio: Number(event.target.value) || WORKSHOP.tile.blendRatio.default })}
          />
        </label>
        <div className="ofs-workshop-actions">
          <button type="button" className="ofs-workshop-apply" disabled={disabled || !canApply} onClick={onApply}>
            {t('studio.workshop.apply')}
          </button>
        </div>
      </div>
    )
  }

  if (tool === 'vectorize') {
    return (
      <div className="ofs-workshop-params-grid">
        <div className="ofs-workshop-param-row">
          <label className="ofs-field">
            <span>{t('studio.workshop.colorPrecision')}</span>
            <input
              type="number"
              min={WORKSHOP.vector.colorPrecision.min}
              max={WORKSHOP.vector.colorPrecision.max}
              value={vector.colorPrecision}
              onChange={(event) => setVector({ colorPrecision: numberValue(event, WORKSHOP.vector.colorPrecision.min) })}
            />
          </label>
          <label className="ofs-field">
            <span>{t('studio.workshop.filterSpeckle')}</span>
            <input
              type="number"
              min={WORKSHOP.vector.filterSpeckle.min}
              max={WORKSHOP.vector.filterSpeckle.max}
              value={vector.filterSpeckle}
              onChange={(event) => setVector({ filterSpeckle: numberValue(event, WORKSHOP.vector.filterSpeckle.min) })}
            />
          </label>
        </div>
        <label className="ofs-field">
          <span>{t('studio.workshop.colormode')}</span>
          <select value={vector.colormode} onChange={(event) => setVector({ colormode: event.target.value })}>
            {WORKSHOP.vector.colormode.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <div className="ofs-workshop-param-row">
          <label className="ofs-field">
            <span>{t('studio.workshop.hierarchy')}</span>
            <select value={vector.hierarchy} onChange={(event) => setVector({ hierarchy: event.target.value })}>
              {WORKSHOP.vector.hierarchy.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="ofs-field">
            <span>{t('studio.workshop.mode')}</span>
            <select value={vector.mode} onChange={(event) => setVector({ mode: event.target.value })}>
              {WORKSHOP.vector.mode.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="ofs-workshop-actions">
          <button
            type="button"
            className="ofs-workshop-apply ofs-workshop-vectorize"
            disabled={disabled || !canApply}
            onClick={onVectorize}
          >
            <Icon name="sparkles" size={14} />
            {busy === 'vectorize' ? t('studio.workshop.vectorizeBusy') : t('studio.workshop.vectorizeRun')}
          </button>
        </div>
      </div>
    )
  }

  if (tool === 'cutout') {
    return (
      <div className="ofs-workshop-params-grid">
        <ModelSelect
          t={t}
          labelKey="studio.workshop.model"
          models={WORKSHOP.cutout.models}
          value={cutoutModel}
          onChange={setCutoutModel}
        />
        <p className="ofs-workshop-hint">{t('studio.workshop.cutoutHint')}</p>
        <div className="ofs-workshop-actions">
          <button
            type="button"
            className="ofs-workshop-apply ofs-workshop-run"
            disabled={disabled || !canApply || !canRunGpu || !modelReady}
            onClick={onRunGpu}
          >
            <Icon name="focus" size={14} />
            {t('studio.workshop.runCutout')}
          </button>
        </div>
      </div>
    )
  }

  if (tool === 'pbr') {
    return (
      <div className="ofs-workshop-params-grid">
        <ModelSelect
          t={t}
          labelKey="studio.workshop.model"
          models={WORKSHOP.pbr.models}
          value={pbrModel}
          onChange={setPbrModel}
        />
        <label className="ofs-field">
          <span>{t('studio.workshop.steps')}</span>
          <input
            type="number"
            min={WORKSHOP.pbr.steps.min}
            max={WORKSHOP.pbr.steps.max}
            value={pbrSteps}
            onChange={(event) => setPbrSteps(numberValue(event, WORKSHOP.pbr.steps.min))}
          />
        </label>
        <p className="ofs-workshop-hint">{t('studio.workshop.pbrHint')}</p>
        <div className="ofs-workshop-actions">
          <button
            type="button"
            className="ofs-workshop-apply ofs-workshop-run"
            disabled={disabled || !canApply || !canRunGpu || !modelReady}
            onClick={onRunGpu}
          >
            <Icon name="cube" size={14} />
            {t('studio.workshop.runPbr')}
          </button>
        </div>
      </div>
    )
  }

  return null
}
