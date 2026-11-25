/**
 * 工坊左侧参数区：控件优先的参数卡。
 *
 * 纯展示组件：所有状态与动作由 Workshop 主组件持有，这里只做输入 → setter 的转发，
 * 保证「参数面板」与「预览 / 应用即落盘」共用同一份状态，不出现两套读数。
 *
 * 版式原则（M4.2c Phase 1b 收束）：
 *  - **控件优先**：说明与示意图仅在用户收起时隐藏，无本地偏好时默认展开并可通过标题栏 `?` 收起；
 *  - **单行轻提示**：像素格距、接缝 MAE、帧尺寸这类客观读数保持一行，不圈成灰底教学块；
 *  - **协议信息就近**：模型许可放在「模型」标签行右侧；只有选中受限 / 需授权模型时才补一条
 *    紧凑警告，默认的免登录模型保持干净。
 */

import React from 'react'

import { WORKSHOP } from '../../../shared/contract.js'
import { formatText } from '../../logic/format.js'
import { confidenceLevelKey } from '../../logic/workshopPerception.js'
import { useSlidingThumb } from '../hooks/useSlidingThumb.js'
import { usePresence } from '../hooks/usePresence.js'
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
 * 读取规则：**没有本地记录时默认展开**——让工坊工具用途与输入/输出案例直接可见，
 * 用户也可点 `?` 收起并记住偏好。
 */
const GUIDE_OPEN_KEY = 'aigc_studio_workshop_guide_open'

/** 说明面板是否展开（无记录 = 展开）。 */
export function readGuideOpen() {
  if (typeof window === 'undefined' || !window.localStorage) return true
  try {
    return window.localStorage.getItem(GUIDE_OPEN_KEY) !== '0'
  } catch {
    return true
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
          <WorkshopSample tool={tool} t={t} />
          <figcaption className="ofs-workshop-guide-legend">
            <span>{t(`studio.workshop.guide.input.${tool}`)}</span>
            <span>{t(`studio.workshop.guide.result.${tool}`)}</span>
          </figcaption>
        </figure>
      ) : null}
    </div>
  )
}

/**
 * 工作室分段切换器：复用全局 `.ofs-seg` + `useSlidingThumb` 弹性滑块。
 */
function SegmentedControl(props) {
  const { options, value, onChange, ariaLabel, className = '', disabled = false } = props
  const wrapRef = React.useRef(null)
  useSlidingThumb(wrapRef, value)
  return (
    <div
      ref={wrapRef}
      className={className ? `ofs-seg ofs-workshop-seg ${className}` : 'ofs-seg ofs-workshop-seg'}
      role="group"
      aria-label={ariaLabel}
    >
      <span className="ofs-seg-thumb" aria-hidden="true" />
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            data-thumb-key={option.value}
            className={active ? 'is-on' : undefined}
            aria-pressed={active ? 'true' : 'false'}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 工作室自定义滑块：与创作页 `ParamsSection` 同款的渐变轨道 + 滑块珠 + 可选刻度档位。
 */
function WorkshopSlider(props) {
  const { label, readout, min, max, step = 1, value, disabled = false, onChange, ticks } = props
  const [dragging, setDragging] = React.useState(false)
  const ticksRef = React.useRef(null)
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : min
  const pct = max > min ? Math.max(0, Math.min(100, ((numericValue - min) / (max - min)) * 100)) : 100
  const activeTick = Array.isArray(ticks) ? ticks.find((item) => item.value === numericValue)?.value ?? '' : ''
  useSlidingThumb(ticksRef, activeTick)

  return (
    <div className="ofs-field">
      <div className="ofs-step-head">
        <span className="ofs-field-label">{label}</span>
        {readout ? (
          <span className={disabled ? 'ofs-step-readout is-fixed' : 'ofs-step-readout'}>{readout}</span>
        ) : null}
      </div>
      <div
        className={`ofs-step-slider-wrap${disabled ? ' is-disabled' : ''}${dragging ? ' is-dragging' : ''}`}
        style={{ '--ofs-step-pct': `${pct}%` }}
      >
        <div className="ofs-step-track" aria-hidden="true">
          <span className="ofs-step-track-fill" />
          <span className="ofs-step-knob" />
        </div>
        <input
          type="range"
          className="ofs-step-slider"
          min={min}
          max={max}
          step={step}
          value={numericValue}
          disabled={disabled}
          aria-label={label}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onBlur={() => setDragging(false)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      {Array.isArray(ticks) && ticks.length > 0 ? (
        <div
          className="ofs-step-ticks ofs-workshop-ticks"
          style={{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }}
          ref={ticksRef}
        >
          <span className="ofs-seg-thumb ofs-step-thumb" aria-hidden="true" />
          {ticks.map((item) => {
            const active = item.value === numericValue
            return (
              <button
                key={item.value}
                type="button"
                data-thumb-key={item.value}
                className={active ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                disabled={disabled}
                onClick={() => onChange(item.value)}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 工作室风格切换开关：替代浏览器原生 checkbox。
 */
function WorkshopSwitch(props) {
  const { label, checked, onChange } = props
  return (
    <div className="ofs-workshop-switch-row">
      <span className="ofs-workshop-switch-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked ? 'true' : 'false'}
        aria-label={label}
        className={checked ? 'ofs-workshop-switch is-on' : 'ofs-workshop-switch'}
        onClick={() => onChange(!checked)}
      >
        <span className="ofs-workshop-switch-thumb" aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * 模型 / 挡位选择：使用 `.ofs-seg` 分段控件替代下拉框，许可与对应模型就近展示。
 */
function ModelTierField(props) {
  const { t, fieldLabel, models, value, onChange, labelOf } = props
  const list = Array.isArray(models) ? models : []
  const current = list.find((model) => model && model.id === value) || list[0] || null
  const warn = Boolean(current && (current.gated === true || current.licenseKind !== 'open'))
  const options = list.map((model) => ({
    value: model.id,
    label: typeof labelOf === 'function' ? labelOf(model) : model.label,
  }))
  const inlineLicense = current
    ? formatText(t('studio.workshop.modelLicenseInline'), {
        grade: current.grade,
        license: current.license,
      })
    : ''
  return (
    <>
      <div className="ofs-field">
        <span className="ofs-workshop-field-label">
          <span>{fieldLabel}</span>
          {current ? (
            <span className="ofs-workshop-field-note" data-license={current.licenseKind}>
              {typeof labelOf === 'function' ? `${current.label} · ${inlineLicense}` : inlineLicense}
            </span>
          ) : null}
        </span>
        <SegmentedControl
          ariaLabel={fieldLabel}
          options={options}
          value={current ? current.id : value}
          onChange={onChange}
        />
      </div>
      {warn ? (
        <p className="ofs-workshop-model-warn" data-license={current.licenseKind}>
          <Icon name="alert" size={12} />
          <span>{current.note}</span>
        </p>
      ) : null}
    </>
  )
}

const VECTOR_PRESETS = [
  { id: 'icon', patch: { colorPrecision: 6, filterSpeckle: 4, colormode: 'color', hierarchy: 'stacked', mode: 'spline' } },
  { id: 'illustration', patch: { colorPrecision: 8, filterSpeckle: 2, colormode: 'color', hierarchy: 'stacked', mode: 'spline' } },
  { id: 'lineart', patch: { colorPrecision: 4, filterSpeckle: 6, colormode: 'binary', hierarchy: 'cutout', mode: 'polygon' } },
]

const VECTOR_DETAILS = [
  { id: 'simple', colorPrecision: 4, filterSpeckle: 8 },
  { id: 'balanced', colorPrecision: 6, filterSpeckle: 4 },
  { id: 'fine', colorPrecision: 8, filterSpeckle: 1 },
]

const SPRITE_PRESETS = [
  { rows: 2, cols: 2 },
  { rows: 4, cols: 4 },
  { rows: 1, cols: 4 },
  { rows: 4, cols: 1 },
]

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
    pbrExecution,
    setPbrExecution,
    pbrCapability,
    pbrModel,
    setPbrModel,
    pbrSteps,
    setPbrSteps,
    detected,
    seam,
    spriteFrames,
    svgStats,
    busy,
    canApply,
    canRunGpu,
    status,
    onDetect,
    onApply,
    onVectorize,
    onRunLocalCutout,
    onRunGpu,
    modelReady,
  } = props

  const [vectorAdvOpen, setVectorAdvOpen] = React.useState(false)
  const guidePresence = usePresence(guideOpen, 150)
  const disabled = busy !== ''
  const readout = guideReadout(t, tool, { detected })
  // 说明与控件独立滚动，提交和状态留在固定底部，长内容不推走按钮。
  const withGuide = (body, actions) => (
    <>
      <div className="ofs-workshop-param-content" role="region" aria-label={t(`studio.workshop.tool.${tool}`)} tabIndex={0}>
        {guidePresence.mounted ? (
          <div className="ofs-workshop-guide-reveal" data-exiting={guidePresence.exiting ? 'true' : undefined}>
            <div className="ofs-workshop-guide-clip">
              <WorkshopGuide t={t} tool={tool} />
            </div>
          </div>
        ) : null}
        {readout ? <p className="ofs-workshop-guide-readout">{readout}</p> : null}
        {body}
      </div>
      <div className="ofs-workshop-param-footer">
        {actions}
        {status ? <p className="ofs-workshop-status" role="status" aria-live="polite">{status}</p> : null}
      </div>
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
      </div>,
      <div className="ofs-workshop-actions">
        <button type="button" className="ofs-chip ofs-workshop-detect" disabled={disabled} onClick={onDetect}>
          {t('studio.workshop.detect')}
        </button>
        <button type="button" className="ofs-workshop-apply" disabled={disabled || !canApply} onClick={onApply}>
          {t('studio.workshop.apply')}
        </button>
      </div>,
    )
  }

  if (tool === 'sprite-slice') {
    const frameCount = spriteFrames && Array.isArray(spriteFrames.frames) ? spriteFrames.frames.length : 0
    const totalCells = (Number(sprite.rows) || 1) * (Number(sprite.cols) || 1)
    const frameSize = spriteFrames && spriteFrames.atlas && spriteFrames.atlas.meta
      ? spriteFrames.atlas.meta.frameSize
      : null
    const fps = Math.max(1, Math.round((1000 / Math.max(20, Number(sprite.frameMs) || 120)) * 10) / 10)
    const sliderMin = WORKSHOP.sprite.frameMs.min
    const sliderMax = Math.min(500, WORKSHOP.sprite.frameMs.max)
    const frameMsValue = Math.min(sliderMax, Math.max(sliderMin, Number(sprite.frameMs) || WORKSHOP.sprite.frameMs.default))
    return withGuide(
      <div className="ofs-workshop-params-grid">
        <div className="ofs-field">
          <span className="ofs-workshop-field-label">
            <span>{t('studio.workshop.sprite.preset')}</span>
            <span className="ofs-workshop-field-note">{`${sprite.rows} × ${sprite.cols}`}</span>
          </span>
          <div className="ofs-workshop-presets" role="group" aria-label={t('studio.workshop.sprite.preset')}>
            {SPRITE_PRESETS.map((preset) => {
              const active = sprite.rows === preset.rows && sprite.cols === preset.cols
              return (
                <button
                  key={`${preset.rows}x${preset.cols}`}
                  type="button"
                  className={active ? 'ofs-workshop-preset is-on' : 'ofs-workshop-preset'}
                  aria-pressed={active ? 'true' : 'false'}
                  onClick={() => setSprite({ rows: preset.rows, cols: preset.cols })}
                >
                  {`${preset.rows}×${preset.cols}`}
                </button>
              )
            })}
          </div>
        </div>
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
        <WorkshopSlider
          label={t('studio.workshop.sprite.rate')}
          readout={`${sprite.frameMs}ms · ${formatText(t('studio.workshop.sprite.fps'), { fps })}`}
          min={sliderMin}
          max={sliderMax}
          step={10}
          value={frameMsValue}
          onChange={(next) => setSprite({ frameMs: next })}
          ticks={[
            { value: 80, label: t('studio.workshop.sprite.rate.fast') },
            { value: 120, label: t('studio.workshop.sprite.rate.normal') },
            { value: 200, label: t('studio.workshop.sprite.rate.slow') },
          ]}
        />
        <WorkshopSwitch
          label={t('studio.workshop.trimAlpha')}
          checked={sprite.trimAlpha === true}
          onChange={(next) => setSprite({ trimAlpha: next })}
        />
        {frameSize ? (
          <div className="ofs-workshop-stat-card">
            <div className="ofs-workshop-stat-grid">
              <div className="ofs-workshop-stat-item">
                <span className="ofs-workshop-stat-label">{t('studio.workshop.sprite.validFrames')}</span>
                <strong className="ofs-workshop-stat-val">{`${frameCount} / ${totalCells}`}</strong>
              </div>
              <div className="ofs-workshop-stat-item">
                <span className="ofs-workshop-stat-label">{t('studio.workshop.sprite.frameSizeLabel')}</span>
                <strong className="ofs-workshop-stat-val">{`${frameSize.w} × ${frameSize.h}`}</strong>
              </div>
            </div>
          </div>
        ) : null}
      </div>,
      <div className="ofs-workshop-actions">
        <button type="button" className="ofs-workshop-apply" disabled={disabled || !canApply} onClick={onApply}>
          {t('studio.workshop.apply')}
        </button>
      </div>,
    )
  }

  if (tool === 'tile') {
    const blendPct = Math.round((Number(tile.blendRatio) || WORKSHOP.tile.blendRatio.default) * 100)
    const tileMode = tile.blend === true ? 'blend' : 'original'
    return withGuide(
      <div className="ofs-workshop-params-grid">
        {seam ? (
          <div className="ofs-workshop-stat-card">
            <div className="ofs-workshop-stat-head">
              <span className={seam.isSeamless ? 'ofs-workshop-seam is-ok' : 'ofs-workshop-seam is-bad'}>
                {t(seam.isSeamless ? 'studio.workshop.seamOk' : 'studio.workshop.seamBad')}
              </span>
              <span className="ofs-workshop-field-note">
                {formatText(t('studio.workshop.tile.seamThreshold'), { threshold: seam.threshold })}
              </span>
            </div>
            <div className="ofs-workshop-stat-grid">
              <div className="ofs-workshop-stat-item">
                <span className="ofs-workshop-stat-label">{t('studio.workshop.tile.seamH')}</span>
                <strong className="ofs-workshop-stat-val">{Number(seam.horizontalSeamMae).toFixed(2)}</strong>
              </div>
              <div className="ofs-workshop-stat-item">
                <span className="ofs-workshop-stat-label">{t('studio.workshop.tile.seamV')}</span>
                <strong className="ofs-workshop-stat-val">{Number(seam.verticalSeamMae).toFixed(2)}</strong>
              </div>
            </div>
          </div>
        ) : null}
        <div className="ofs-field">
          <span className="ofs-workshop-field-label">
            <span>{t('studio.workshop.tile.mode')}</span>
          </span>
          <SegmentedControl
            ariaLabel={t('studio.workshop.tile.mode')}
            options={[
              { value: 'original', label: t('studio.workshop.tile.modeOriginal') },
              { value: 'blend', label: t('studio.workshop.tile.modeBlend') },
            ]}
            value={tileMode}
            onChange={(next) => setTile({ blend: next === 'blend' })}
          />
        </div>
        <WorkshopSlider
          label={t('studio.workshop.blendRatio')}
          readout={`${blendPct}%`}
          min={WORKSHOP.tile.blendRatio.min}
          max={WORKSHOP.tile.blendRatio.max}
          step={0.01}
          value={tile.blendRatio}
          disabled={tile.blend !== true}
          onChange={(next) => setTile({ blendRatio: next || WORKSHOP.tile.blendRatio.default })}
        />
      </div>,
      <div className="ofs-workshop-actions">
        <button type="button" className="ofs-workshop-apply" disabled={disabled || !canApply} onClick={onApply}>
          {t('studio.workshop.apply')}
        </button>
      </div>,
    )
  }

  if (tool === 'vectorize') {
    const activePreset = VECTOR_PRESETS.find((preset) =>
      Object.entries(preset.patch).every(([key, val]) => vector[key] === val),
    )?.id || ''
    const activeDetail = VECTOR_DETAILS.find((item) =>
      item.colorPrecision === vector.colorPrecision && item.filterSpeckle === vector.filterSpeckle,
    )?.id || ''
    return withGuide(
      <div className="ofs-workshop-params-grid">
        <div className="ofs-field">
          <span className="ofs-workshop-field-label">
            <span>{t('studio.workshop.vector.preset')}</span>
          </span>
          <div className="ofs-workshop-presets" role="group" aria-label={t('studio.workshop.vector.preset')}>
            {VECTOR_PRESETS.map((preset) => {
              const active = activePreset === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={active ? 'ofs-workshop-preset is-on' : 'ofs-workshop-preset'}
                  aria-pressed={active ? 'true' : 'false'}
                  onClick={() => setVector(preset.patch)}
                >
                  {t(`studio.workshop.vector.preset.${preset.id}`)}
                </button>
              )
            })}
          </div>
        </div>
        <div className="ofs-workshop-param-row">
          <div className="ofs-field">
            <span className="ofs-workshop-field-label">
              <span>{t('studio.workshop.colormode')}</span>
            </span>
            <SegmentedControl
              ariaLabel={t('studio.workshop.colormode')}
              options={WORKSHOP.vector.colormode.map((value) => ({
                value,
                label: t(`studio.workshop.vector.colormode.${value}`),
              }))}
              value={vector.colormode}
              onChange={(next) => setVector({ colormode: next })}
            />
          </div>
          <div className="ofs-field">
            <span className="ofs-workshop-field-label">
              <span>{t('studio.workshop.mode')}</span>
            </span>
            <SegmentedControl
              ariaLabel={t('studio.workshop.mode')}
              options={WORKSHOP.vector.mode.map((value) => ({
                value,
                label: t(`studio.workshop.vector.mode.${value}`),
              }))}
              value={vector.mode}
              onChange={(next) => setVector({ mode: next })}
            />
          </div>
        </div>
        <div className="ofs-field">
          <span className="ofs-workshop-field-label">
            <span>{t('studio.workshop.vector.detail')}</span>
          </span>
          <SegmentedControl
            ariaLabel={t('studio.workshop.vector.detail')}
            options={VECTOR_DETAILS.map((item) => ({
              value: item.id,
              label: t(`studio.workshop.vector.detail.${item.id}`),
            }))}
            value={activeDetail}
            onChange={(id) => {
              const match = VECTOR_DETAILS.find((item) => item.id === id)
              if (match) setVector({ colorPrecision: match.colorPrecision, filterSpeckle: match.filterSpeckle })
            }}
          />
        </div>
        <button
          type="button"
          className="ofs-workshop-adv-toggle"
          aria-expanded={vectorAdvOpen ? 'true' : 'false'}
          onClick={() => setVectorAdvOpen((prev) => !prev)}
        >
          <span>{t('studio.workshop.vector.advanced')}</span>
          <Icon name={vectorAdvOpen ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        {vectorAdvOpen ? (
          <div className="ofs-workshop-adv-box">
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
              <span>{t('studio.workshop.hierarchy')}</span>
              <select value={vector.hierarchy} onChange={(event) => setVector({ hierarchy: event.target.value })}>
                {WORKSHOP.vector.hierarchy.map((value) => (
                  <option key={value} value={value}>{t(`studio.workshop.vector.hierarchy.${value}`)}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        {svgStats ? (
          <div className="ofs-workshop-stat-card">
            <div className="ofs-workshop-stat-head">
              <span className="ofs-workshop-stat-label">{t('studio.workshop.channel.svg')}</span>
              <strong className="ofs-workshop-stat-val">
                {formatText(t('studio.workshop.vector.stats'), svgStats)}
              </strong>
            </div>
          </div>
        ) : null}
      </div>,
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
      </div>,
    )
  }

  if (tool === 'cutout') {
    return withGuide(
      <div className="ofs-workshop-params-grid">
        <p className="ofs-workshop-model-warn" data-license="non-commercial">
          <Icon name="alert" size={12} />
          <span className="ofs-workshop-cutout-note">{t('studio.workshop.cutout.localNote')}</span>
        </p>
      </div>,
      <div className="ofs-workshop-actions">
        <button
          type="button"
          className="ofs-workshop-apply ofs-workshop-run"
          disabled={disabled || !canApply || !modelReady}
          onClick={onRunLocalCutout}
        >
          <Icon name="focus" size={14} />
          {busy === 'cutout' ? t('studio.workshop.cutout.busy') : t('studio.workshop.runCutout')}
        </button>
      </div>,
    )
  }

  if (tool === 'pbr') {
    const pbrTierKey = pbrSteps <= 2 ? 'fast' : (pbrSteps <= 5 ? 'balanced' : 'fine')
    return withGuide(
      <div className="ofs-workshop-params-grid">
        <div className="ofs-field ofs-workshop-compute">
          <span className="ofs-workshop-field-label">{t('studio.workshop.pbr.execution')}</span>
          <SegmentedControl
            ariaLabel={t('studio.workshop.pbr.execution')}
            className="ofs-workshop-compute-seg"
            options={[
              { value: 'local', label: t('studio.workshop.pbr.execution.local'), disabled: !pbrCapability?.available,
                title: !pbrCapability?.available ? t(`studio.workshop.pbr.reason.${pbrCapability?.reason || 'checking'}`) : undefined },
              { value: 'cloud', label: t('studio.workshop.pbr.execution.cloud') },
            ]}
            value={pbrExecution || 'cloud'}
            onChange={setPbrExecution}
            disabled={disabled}
          />
          <p className="ofs-workshop-compute-note" role="status">
            {t(pbrCapability?.available
              ? (pbrExecution === 'local' ? 'studio.workshop.pbr.localNote' : 'studio.workshop.pbr.cloudNote')
              : `studio.workshop.pbr.reason.${pbrCapability?.reason || 'checking'}`)}
          </p>
        </div>
        <ModelTierField
          t={t}
          fieldLabel={t('studio.workshop.model')}
          models={WORKSHOP.pbr.models}
          value={pbrModel}
          onChange={setPbrModel}
        />
        <WorkshopSlider
          label={t('studio.workshop.steps')}
          readout={formatText(t('studio.workshop.pbr.stepsReadout'), {
            steps: pbrSteps,
            tier: t(`studio.workshop.pbr.tier.${pbrTierKey}`),
          })}
          min={WORKSHOP.pbr.steps.min}
          max={WORKSHOP.pbr.steps.max}
          step={1}
          value={pbrSteps}
          onChange={(next) => setPbrSteps(next)}
          ticks={[
            { value: 2, label: `${t('studio.workshop.pbr.tier.fast')} 2` },
            { value: 4, label: `${t('studio.workshop.pbr.tier.balanced')} 4` },
            { value: 8, label: `${t('studio.workshop.pbr.tier.fine')} 8` },
          ]}
        />
        <div className="ofs-field">
          <span className="ofs-workshop-field-label">
            <span>{t('studio.workshop.pbr.outputs')}</span>
          </span>
          <div className="ofs-workshop-output-maps">
            {WORKSHOP.pbr.channels.map((role) => (
              <span key={role} className="ofs-workshop-output-chip">
                {t(`studio.workshop.channel.${role}`)}
              </span>
            ))}
          </div>
        </div>
      </div>,
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
      </div>,
    )
  }

  return withGuide(null)
}
