/**
 * 工坊左侧参数区：控件优先的参数卡。
 *
 * 纯展示组件：所有状态与动作由 Workshop 主组件持有，这里只做输入 → setter 的转发，
 * 保证「参数面板」与「预览 / 应用即落盘」共用同一份状态，不出现两套读数。
 *
 * 版式原则（M4.2c Phase 1b 收束）：
 *  - **控件优先**：说明与示意图默认折叠，只在标题栏 `?` 被点开时才展开，首屏把高度让给参数；
 *  - **单行轻提示**：像素格距、接缝 MAE、帧尺寸这类客观读数保持一行，不圈成灰底教学块；
 *  - **协议信息就近**：模型许可放在「模型」标签行右侧；只有选中受限 / 需授权模型时才补一条
 *    紧凑警告，默认的免登录模型保持干净。
 */

import React from 'react'

import { WORKSHOP } from '../../../shared/contract.js'
import { formatText } from '../../logic/format.js'
import { confidenceLevelKey } from '../../logic/workshopPerception.js'
import { Icon } from '../icons.jsx'
import { WorkshopSample, hasWorkshopSample } from './samples.jsx'

/** 数字输入：空值回落到最小值，避免受控组件拿到 NaN。 */
function numberValue(event, min) {
  const value = Number(event && event.target ? event.target.value : '')
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.round(value))
}

/**
 * 参数说明折叠偏好的存储键。
 *
 * 读取规则：**没有本地记录时默认折叠**——第一次进工坊的默认版式必须先把控件露出来，
 * 想了解工具的人点一次 `?` 即可，之后按用户的选择记住。
 */
const GUIDE_OPEN_KEY = 'aigc_studio_workshop_guide_open'

/** 说明面板是否展开（无记录 = 折叠）。 */
export function readGuideOpen() {
  if (typeof window === 'undefined' || !window.localStorage) return false
  try {
    return window.localStorage.getItem(GUIDE_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

/** 记住说明面板的展开状态。 */
export function writeGuideOpen(open) {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(GUIDE_OPEN_KEY, open ? '1' : '0')
  } catch {}
}

/**
 * 把当前工具的客观读数翻成一句白话（单行）；没有可读的读数时返回空串（不渲染空行）。
 *
 * 只有 `pixel-snap` 需要翻译：接缝 MAE 与帧尺寸本来就已经是「数字 + 结论」的一行读数，
 * 再翻一遍只会变成第二行废话。
 *
 * @returns {string}
 */
function guideReadout(t, tool, state) {
  if (tool !== 'pixel-snap') return ''
  const detected = state.detected
  if (!detected) return ''
  if (detected.confidence > 0) {
    return formatText(t('studio.workshop.guide.readoutPixel'), {
      cell: detected.cell,
      level: t(confidenceLevelKey(detected.confidence)),
    })
  }
  return formatText(t('studio.workshop.guide.readoutPixelNone'), { cell: detected.cell })
}

/**
 * 说明面板：工具用途与处理前后的效果。内部场景分类不作为用户可见的标签。
 */
function WorkshopGuide(props) {
  const { t, tool } = props
  const showFigure = hasWorkshopSample(tool)
  return (
    <div className="ofs-workshop-guide" id="ofs-workshop-guide">
      <p className="ofs-workshop-guide-text">{t(`studio.workshop.guide.${tool}`)}</p>
      {showFigure ? (
        <figure className="ofs-workshop-guide-figure">
          <WorkshopSample tool={tool} />
          <figcaption className="ofs-workshop-guide-legend">
            <span>{t('studio.workshop.guide.before')}</span>
            <span>{t(`studio.workshop.guide.result.${tool}`)}</span>
          </figcaption>
        </figure>
      ) : null}
    </div>
  )
}

/**
 * 模型选择：许可信息内联在标签行右侧；只有受限 / 需授权模型才额外补一条紧凑警告。
 *
 * @param {{ t: Function, models: Array, value: string, onChange: Function }} props
 */
function ModelSelect(props) {
  const { t, models, value, onChange } = props
  const list = Array.isArray(models) ? models : []
  const current = list.find((model) => model && model.id === value) || list[0] || null
  // `open` 且未 gated 视为「免登录开箱即用」，不需要任何额外提示。
  const warn = Boolean(current && (current.gated === true || current.licenseKind !== 'open'))
  return (
    <>
      <label className="ofs-field">
        <span className="ofs-workshop-field-label">
          {t('studio.workshop.model')}
          {current ? (
            <span className="ofs-workshop-field-note" data-license={current.licenseKind}>
              {formatText(t('studio.workshop.modelLicenseInline'), {
                grade: current.grade,
                license: current.license,
              })}
            </span>
          ) : null}
        </span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {list.map((model) => (
            <option key={model.id} value={model.id}>
              {`${model.label} · ${model.grade}`}
            </option>
          ))}
        </select>
      </label>
      {warn ? (
        <p className="ofs-workshop-model-warn" data-license={current.licenseKind}>
          <Icon name="alert" size={12} />
          <span>{current.note}</span>
        </p>
      ) : null}
    </>
  )
}

export function WorkshopParams(props) {
  const {
    t,
    tool,
    guideOpen,
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
    status,
    onDetect,
    onApply,
    onVectorize,
    onRunGpu,
    modelReady,
  } = props

  const disabled = busy !== ''
  const readout = guideReadout(t, tool, { detected })
  // 参数卡统一结构：说明面板（按需）→ 单行读数（有则显示）→ 控件 → 操作提示（有则显示）。
  // 提示只放排队进度 / 报错这类需要留在页面上的信息，常规成功走全局 Toast。
  const withGuide = (body) => (
    <>
      {guideOpen ? <WorkshopGuide t={t} tool={tool} /> : null}
      {readout ? <p className="ofs-workshop-guide-readout">{readout}</p> : null}
      {body}
      {status ? <p className="ofs-workshop-status" role="status" aria-live="polite">{status}</p> : null}
    </>
  )

  if (tool === 'pixel-snap') {
    return withGuide(
      <div className="ofs-workshop-params-grid">
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
      </div>,
    )
  }

  if (tool === 'sprite-slice') {
    const frameCount = spriteFrames && Array.isArray(spriteFrames.frames) ? spriteFrames.frames.length : 0
    const frameSize = spriteFrames && spriteFrames.atlas && spriteFrames.atlas.meta
      ? spriteFrames.atlas.meta.frameSize
      : null
    return withGuide(
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
      </div>,
    )
  }

  if (tool === 'tile') {
    return withGuide(
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
          <span className="ofs-workshop-field-label">
            <span>{t('studio.workshop.blendRatio')}</span>
            <span className="ofs-workshop-field-note">{`${Math.round((Number(tile.blendRatio) || 0) * 100)}%`}</span>
          </span>
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
      </div>,
    )
  }

  if (tool === 'vectorize') {
    return withGuide(
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
              <option key={value} value={value}>{t(`studio.workshop.vector.colormode.${value}`)}</option>
            ))}
          </select>
        </label>
        <div className="ofs-workshop-param-row">
          <label className="ofs-field">
            <span>{t('studio.workshop.hierarchy')}</span>
            <select value={vector.hierarchy} onChange={(event) => setVector({ hierarchy: event.target.value })}>
              {WORKSHOP.vector.hierarchy.map((value) => (
                <option key={value} value={value}>{t(`studio.workshop.vector.hierarchy.${value}`)}</option>
              ))}
            </select>
          </label>
          <label className="ofs-field">
            <span>{t('studio.workshop.mode')}</span>
            <select value={vector.mode} onChange={(event) => setVector({ mode: event.target.value })}>
              {WORKSHOP.vector.mode.map((value) => (
                <option key={value} value={value}>{t(`studio.workshop.vector.mode.${value}`)}</option>
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
      </div>,
    )
  }

  if (tool === 'cutout') {
    return withGuide(
      <div className="ofs-workshop-params-grid">
        <ModelSelect
          t={t}
          models={WORKSHOP.cutout.models}
          value={cutoutModel}
          onChange={setCutoutModel}
        />
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
      </div>,
    )
  }

  if (tool === 'pbr') {
    return withGuide(
      <div className="ofs-workshop-params-grid">
        <ModelSelect
          t={t}
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
      </div>,
    )
  }

  return withGuide(null)
}
