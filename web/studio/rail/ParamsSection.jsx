/**
 * 左栏第 4 节：排除项（仅在模型消费负向词时显示）与高级参数（步数、CFG、种子）。
 *
 * 两节都是「可折叠小节」：标题行自己就是开关（见 rail/Fieldset.jsx），
 * 折叠时右侧读数是这一节的摘要，展开时读数字段本身就是说明。
 * 因此这里不再需要「卡片里再放一个带标题的折叠行」——一节一个开关，不会出现
 * 两层箭头，也不会出现「高级设置」像在给第一张卡片当标签。
 */

import React from 'react'

import { LIMITS } from '../../../shared/contract.js'
import { stepModeOf, stepTierOf } from '../../../shared/models-guide.js'

import { Tooltip } from '../../components/Tooltip.jsx'
import { formatText } from '../../logic/format.js'
import {
  activeQualityModeOf,
  effectivePresetForVariant,
  modeSwitchPatch,
  precisionOptionsForMode,
  precisionOptionsOf,
  qualityModesOf,
  variantLabelOf,
  variantModeAllowedForProvider,
  videoRatioDimensions,
} from '../../logic/preset.js'
import { useSlidingThumb } from '../hooks/useSlidingThumb.js'
import { Drawer, useAnimateOpen } from './Drawer.jsx'
import { Fieldset } from './Fieldset.jsx'

function StepSlider({
  label,
  readout,
  readoutFixed = false,
  tooltip = '',
  min,
  max,
  step = 1,
  value,
  disabled = false,
  onChange,
  children = null,
}) {
  const [dragging, setDragging] = React.useState(false)
  const pct = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 100

  return (
    <div className="ofs-field">
      <div className="ofs-step-head">
        <span className="ofs-field-label">
          {label}
          {tooltip ? <Tooltip text={tooltip} /> : null}
        </span>
        <span className={readoutFixed ? 'ofs-step-readout is-fixed' : 'ofs-step-readout'}>
          {readout}
        </span>
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
          value={value}
          disabled={disabled}
          aria-label={label}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onBlur={() => setDragging(false)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      {children}
    </div>
  )
}

function AdvancedParamsGrid({
  t,
  isEn,
  fields,
  activePreset,
  effectivePreset,
  activeMode,
  hasModes,
  patchForm,
  applyCfg,
  resetSeed,
  seedText,
}) {
  const precisionOptions = hasModes
    ? precisionOptionsForMode(activePreset, activeMode)
    : precisionOptionsOf(activePreset)
  const currentVariant = typeof fields.variantId === 'string' ? fields.variantId.trim() : ''
  const activeVariant = currentVariant === 'auto' || precisionOptions.some((item) => item.id === currentVariant)
    ? currentVariant || 'auto'
    : 'auto'
  const stepMode = stepModeOf(effectivePreset)
  const stepTier = stepTierOf(effectivePreset, fields.steps)
  const stepRange = stepMode === 'range' ? effectivePreset.stepRange : null
  const displayedSteps = stepMode === 'fixed' && Number.isFinite(Number(effectivePreset?.steps))
    ? Number(effectivePreset.steps)
    : Number(fields.steps) || 1
  const onResetSeed = typeof resetSeed === 'function' ? resetSeed : () => patchForm({ seed: '' })
  const onCfgChange = typeof applyCfg === 'function'
    ? applyCfg
    : (value) => patchForm({ cfg: Number(value) })
  const ticksRef = React.useRef(null)
  useSlidingThumb(ticksRef, stepTier)

  const sliderMin = stepRange ? stepRange.min : displayedSteps
  const sliderMax = stepRange ? stepRange.max : displayedSteps

  return (
    <div className="ofs-param-stack">
      {precisionOptions.length > 1 ? (
        <div className="ofs-field">
          <div className="ofs-step-head">
            <span className="ofs-field-label">
              {t('studio.precision')}
              <Tooltip text={t('studio.precisionTooltip')} />
            </span>
            <span className="ofs-step-readout">
              {activeVariant === 'auto'
                ? t('studio.precisionAuto')
                : variantLabelOf(precisionOptions.find((item) => item.id === activeVariant), isEn)}
            </span>
          </div>
          {/* 选项 = 「自动」+ precisionOptions；列数必须按实际按钮数算，
              否则 3 个按钮铺进 2 列会换行（panel.css 的默认 3 列也会被内联样式覆盖）。 */}
          <div
            className="ofs-step-ticks"
            style={{ gridTemplateColumns: `repeat(${precisionOptions.length + 1}, minmax(0, 1fr))` }}
          >
            {[{ id: 'auto', label: null, precision: '' }, ...precisionOptions].map((item) => {
              const id = item.id
              const selected = activeVariant === id
              return (
                <button
                  key={id}
                  type="button"
                  className={selected ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                  aria-pressed={selected}
                  onClick={() => patchForm({ variantId: id })}
                >
                  {id === 'auto'
                    ? t('studio.precisionAuto')
                    : variantLabelOf(item, isEn)}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
      <StepSlider
        label={t('studio.steps')}
        tooltip={t(stepMode === 'fixed' ? 'studio.stepsFixedTooltip' : 'studio.stepsTooltip')}
        readout={formatText(t('studio.stepsReadout'), {
          steps: displayedSteps,
          tier: t(`studio.stepsTier.${stepTier}`),
        })}
        readoutFixed={stepMode === 'fixed'}
        min={sliderMin}
        max={sliderMax}
        step={stepRange ? stepRange.step : 1}
        value={displayedSteps}
        disabled={stepMode === 'fixed'}
        onChange={(value) => patchForm({ steps: value })}
      >
        {stepRange ? (
          <div className="ofs-step-ticks" ref={ticksRef}>
            <span className="ofs-seg-thumb ofs-step-thumb" aria-hidden="true" />
            {(['fast', 'balanced', 'fine']).map((key) => (
              <button
                key={key}
                type="button"
                data-thumb-active={stepTier === key ? 'true' : undefined}
                className={stepTier === key ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                onClick={() => patchForm({ steps: stepRange[key] })}
              >
                {`${t(`studio.stepsTier.${key}`)} ${stepRange[key]}`}
              </button>
            ))}
          </div>
        ) : null}
      </StepSlider>

      <div className="ofs-field">
        <span className="ofs-field-label">
          {t('studio.cfg')}
          <Tooltip text={t('studio.cfgTooltip')} />
        </span>
        <input
          type="number"
          min={LIMITS.cfg.min}
          max={LIMITS.cfg.max}
          step={0.5}
          value={fields.cfg}
          aria-label={t('studio.cfg')}
          onChange={(event) => onCfgChange(Number(event.target.value))}
        />
      </div>

      <div className="ofs-field">
        <span className="ofs-field-label">{t('studio.seed')}</span>
        <div className="ofs-seed-row">
          <input
            type="text"
            inputMode="numeric"
            value={fields.seed}
            placeholder={t('studio.random')}
            aria-label={t('studio.seed')}
            onChange={(event) => patchForm({ seed: event.target.value })}
          />
          <button
            type="button"
            className="ofs-text-action ofs-seed-reset"
            onClick={onResetSeed}
            disabled={!seedText}
          >
            {t('studio.seed.reset')}
          </button>
        </div>
      </div>
    </div>
  )
}

function VideoParamsGrid({ t, fields, activePreset, patchForm, resetSeed, seedText }) {
  const video = activePreset && activePreset.video && typeof activePreset.video === 'object'
    ? activePreset.video
    : {}
  const duration = video.duration && typeof video.duration === 'object' ? video.duration : null
  const supportsDuration = video.supportsDuration === true && duration !== null
  const durationValue = Number.isFinite(Number(fields.duration))
    ? Math.round(Number(fields.duration))
    : (duration?.default ?? 5)
  const resolutions = Array.isArray(video.resolutions) ? video.resolutions : []
  const activeResolution = resolutions.includes(fields.resolution)
    ? fields.resolution
    : (video.defaultResolution || resolutions[0] || '')
  const ticks = supportsDuration
    ? [...new Set([duration.min, Math.round((duration.min + duration.max) / 2), duration.max])]
    : []
  const durationTicksRef = React.useRef(null)
  const resolutionTicksRef = React.useRef(null)
  useSlidingThumb(durationTicksRef, supportsDuration && ticks.includes(durationValue) ? durationValue : '')
  useSlidingThumb(resolutionTicksRef, activeResolution)

  return (
    <div className="ofs-param-stack">
      {supportsDuration ? (
        <StepSlider
          label={t('studio.video.duration')}
          readout={formatText(t('studio.video.seconds'), { seconds: durationValue })}
          min={duration.min}
          max={duration.max}
          step={duration.step ?? 1}
          value={durationValue}
          onChange={(value) => patchForm({ duration: value })}
        >
          <div
            className="ofs-step-ticks"
            ref={durationTicksRef}
            style={{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }}
          >
            <span className="ofs-seg-thumb ofs-step-thumb" aria-hidden="true" />
            {ticks.map((value) => (
              <button
                key={value}
                type="button"
                data-thumb-key={value}
                data-thumb-active={durationValue === value ? 'true' : undefined}
                className={durationValue === value ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                onClick={() => patchForm({ duration: value })}
              >
                {formatText(t('studio.video.seconds'), { seconds: value })}
              </button>
            ))}
          </div>
        </StepSlider>
      ) : (
        <div className="ofs-field">
          <div className="ofs-step-head">
            <span className="ofs-field-label">{t('studio.video.duration')}</span>
            <span className="ofs-step-readout is-fixed">{t('studio.video.durationFixed')}</span>
          </div>
        </div>
      )}

      {resolutions.length > 0 ? (
        <div className="ofs-field">
          <span className="ofs-field-label">{t('studio.video.resolution')}</span>
          <div
            className="ofs-step-ticks"
            ref={resolutionTicksRef}
            style={{ gridTemplateColumns: `repeat(${resolutions.length}, minmax(0, 1fr))` }}
          >
            <span className="ofs-seg-thumb ofs-step-thumb" aria-hidden="true" />
            {resolutions.map((id) => (
              <button
                key={id}
                type="button"
                data-thumb-key={id}
                data-thumb-active={activeResolution === id ? 'true' : undefined}
                className={activeResolution === id ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                onClick={() => {
                  const ratio = fields.ratio || video.defaultRatio || '16:9'
                  const nextSize = videoRatioDimensions(ratio, id)
                  patchForm({ resolution: id, width: nextSize.width, height: nextSize.height })
                }}
              >
                {id}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="ofs-field">
        <span className="ofs-field-label">{t('studio.seed')}</span>
        <div className="ofs-seed-row">
          <input
            type="text"
            inputMode="numeric"
            value={fields.seed}
            placeholder={t('studio.random')}
            aria-label={t('studio.seed')}
            onChange={(event) => patchForm({ seed: event.target.value })}
          />
          <button
            type="button"
            className="ofs-text-action ofs-seed-reset"
            onClick={() => (typeof resetSeed === 'function' ? resetSeed() : patchForm({ seed: '' }))}
            disabled={!seedText}
          >
            {t('studio.seed.reset')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ParamsSection({
  t,
  isEn,
  fields,
  activePreset,
  provider = '',
  patchForm,
  applyCfg,
  resetSeed,
  showNegative,
  negativeOpen,
  setNegativeOpen,
  negativePlaceholder,
  advancedOpen,
  toggleAdvanced,
  negativeChanged = false,
  advancedChanged = false,
}) {
  // 高级设置折叠态读数：一眼看清将用什么参数生成，不必展开。
  const animateOpen = useAnimateOpen()
  const isVideo = Boolean(activePreset && activePreset.mediaType === 'video')
  const modesInfo = !isVideo ? qualityModesOf(activePreset) : { hasModes: false, modes: [] }
  const activeMode = modesInfo.hasModes ? activeQualityModeOf(activePreset, fields.variantId) : 'fast'
  const effectivePreset = modesInfo.hasModes
    ? effectivePresetForVariant(activePreset, fields.variantId)
    : activePreset
  const qualityAllowed = !modesInfo.hasModes || variantModeAllowedForProvider(activePreset, 'quality', provider)
  const modeTicksRef = React.useRef(null)
  useSlidingThumb(modeTicksRef, modesInfo.hasModes ? activeMode : '')
  const stepsValue = Number.isFinite(Number(fields.steps)) ? Math.round(Number(fields.steps)) : LIMITS.steps.min
  const cfgValue = Number.isFinite(Number(fields.cfg)) ? Number(fields.cfg) : LIMITS.cfg.min
  const seedText = String(fields.seed ?? '').trim()
  const negativeText = String(fields.negative ?? '').trim()
  const paramsReadout = isVideo
    ? [
        activePreset?.video?.supportsDuration === true
          ? formatText(t('studio.video.seconds'), {
              seconds: Number.isFinite(Number(fields.duration))
                ? Math.round(Number(fields.duration))
                : (activePreset?.video?.duration?.default ?? 5),
            })
          : t('studio.video.durationFixed'),
        fields.resolution ? String(fields.resolution) : '',
        seedText ? `${t('studio.meta.seed')} ${seedText}` : t('studio.seed'),
      ].filter(Boolean).join(' · ')
    : [
        `${stepsValue} ${t('studio.preset.stepsUnit')}`,
        `CFG ${cfgValue}`,
        seedText ? `${t('studio.meta.seed')} ${seedText}` : t('studio.seed'),
      ].join(' · ')

  return (
    <>
      {/* 排除项只在当前模型 + CFG 真的消费负向词时出现；隐藏时不写、不提交。
          它是一段「不要什么」的文案，所以自成一节，读数和排除项原文一起收在标题行里。 */}
      {showNegative ? (
        <Fieldset
          title={t('studio.negative')}
          changed={negativeChanged}
          action={(
            <>
              {negativeOpen || !negativeText
                ? null
                : <span className="ofs-fieldset-readout">{negativeText}</span>}
              <Tooltip text={t('studio.negativeTooltip')} />
            </>
          )}
          toggle={() => setNegativeOpen((open) => !open)}
          open={negativeOpen}
        >
          <Drawer open={negativeOpen} animate={animateOpen}>
            <textarea
              className="ofs-negative-input"
              rows={3}
              value={fields.negative}
              placeholder={negativePlaceholder}
              spellCheck={false}
              aria-label={t('studio.negative')}
              onChange={(event) => patchForm({ negative: event.target.value })}
            />
          </Drawer>
        </Fieldset>
      ) : null}

      {modesInfo.hasModes ? (
        <Fieldset
          title={t('studio.qualityMode')}
          changed={advancedChanged}
          action={<Tooltip text={t('studio.qualityMode.tooltip')} />}
        >
          <div className="ofs-param-stack">
            <div
              className="ofs-step-ticks"
              ref={modeTicksRef}
              style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
            >
              <span className="ofs-seg-thumb ofs-step-thumb" aria-hidden="true" />
              {modesInfo.modes.map((modeKey) => {
                const selected = activeMode === modeKey
                const disabled = modeKey === 'quality' && !qualityAllowed
                return (
                  <button
                    key={modeKey}
                    type="button"
                    data-thumb-key={modeKey}
                    data-thumb-active={selected ? 'true' : undefined}
                    className={selected ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => patchForm(modeSwitchPatch(activePreset, modeKey, fields, provider))}
                  >
                    {t(`studio.qualityMode.${modeKey}`)}
                  </button>
                )
              })}
            </div>
            {!qualityAllowed ? (
              <p className="ofs-hint">{t('studio.qualityMode.providerUnsupported')}</p>
            ) : activeMode === 'quality' ? (
              <p className="ofs-hint">{t('studio.qualityMode.reloadHint')}</p>
            ) : null}
          </div>
        </Fieldset>
      ) : null}

      {isVideo ? (
        <Fieldset
          title={t('studio.rail.video')}
          changed={advancedChanged}
          action={<span className="ofs-fieldset-readout">{paramsReadout}</span>}
        >
          <VideoParamsGrid
            t={t}
            fields={fields}
            activePreset={activePreset}
            patchForm={patchForm}
            resetSeed={resetSeed}
            seedText={seedText}
          />
        </Fieldset>
      ) : (
        <Fieldset
          title={t('studio.rail.advanced')}
          changed={advancedChanged}
          action={advancedOpen ? null : <span className="ofs-fieldset-readout">{paramsReadout}</span>}
          toggle={toggleAdvanced}
          open={advancedOpen}
        >
          <Drawer open={advancedOpen} animate={animateOpen}>
            <AdvancedParamsGrid
              t={t}
              isEn={isEn}
              fields={fields}
              activePreset={activePreset}
              effectivePreset={effectivePreset}
              activeMode={activeMode}
              hasModes={modesInfo.hasModes}
              patchForm={patchForm}
              applyCfg={applyCfg}
              resetSeed={resetSeed}
              seedText={seedText}
            />
          </Drawer>
        </Fieldset>
      )}
    </>
  )
}
