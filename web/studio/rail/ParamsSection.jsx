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
import { Drawer, useAnimateOpen } from './Drawer.jsx'
import { Fieldset } from './Fieldset.jsx'

function AdvancedParamsGrid({
  t,
  fields,
  activePreset,
  patchForm,
  applyCfg,
  resetSeed,
  seedText,
}) {
  const stepMode = stepModeOf(activePreset)
  const stepTier = stepTierOf(activePreset, fields.steps)
  const stepRange = stepMode === 'range' ? activePreset.stepRange : null
  const displayedSteps = stepMode === 'fixed' && Number.isFinite(Number(activePreset?.steps))
    ? Number(activePreset.steps)
    : Number(fields.steps) || 1
  const onResetSeed = typeof resetSeed === 'function' ? resetSeed : () => patchForm({ seed: '' })
  const onCfgChange = typeof applyCfg === 'function'
    ? applyCfg
    : (value) => patchForm({ cfg: Number(value) })

  return (
    <div className="ofs-param-stack">
      <div className="ofs-field">
        <div className="ofs-step-head">
          <span className="ofs-field-label">
            {t('studio.steps')}
            <Tooltip text={t(stepMode === 'fixed' ? 'studio.stepsFixedTooltip' : 'studio.stepsTooltip')} />
          </span>
          <span className={stepMode === 'fixed' ? 'ofs-step-readout is-fixed' : 'ofs-step-readout'}>
            {formatText(t('studio.stepsReadout'), {
              steps: displayedSteps,
              tier: t(`studio.stepsTier.${stepTier}`),
            })}
          </span>
        </div>
        <input
          type="range"
          className="ofs-step-slider"
          min={stepRange ? stepRange.min : displayedSteps}
          max={stepRange ? stepRange.max : displayedSteps}
          step={stepRange ? stepRange.step : 1}
          value={displayedSteps}
          disabled={stepMode === 'fixed'}
          aria-label={t('studio.steps')}
          onChange={(event) => patchForm({ steps: Number(event.target.value) })}
        />
        {stepRange ? (
          <div className="ofs-step-ticks">
            {(['fast', 'balanced', 'fine']).map((key) => (
              <button
                key={key}
                type="button"
                className={stepTier === key ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                onClick={() => patchForm({ steps: stepRange[key] })}
              >
                {`${t(`studio.stepsTier.${key}`)} ${stepRange[key]}`}
              </button>
            ))}
          </div>
        ) : null}
      </div>

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
  const ticks = supportsDuration
    ? [...new Set([duration.min, Math.round((duration.min + duration.max) / 2), duration.max])]
    : []

  return (
    <div className="ofs-param-stack">
      <div className="ofs-field">
        <div className="ofs-step-head">
          <span className="ofs-field-label">{t('studio.video.duration')}</span>
          <span className={supportsDuration ? 'ofs-step-readout' : 'ofs-step-readout is-fixed'}>
            {supportsDuration
              ? formatText(t('studio.video.seconds'), { seconds: durationValue })
              : t('studio.video.durationFixed')}
          </span>
        </div>
        {supportsDuration ? (
          <>
            <input
              type="range"
              className="ofs-step-slider"
              min={duration.min}
              max={duration.max}
              step={duration.step ?? 1}
              value={durationValue}
              aria-label={t('studio.video.duration')}
              onChange={(event) => patchForm({ duration: Number(event.target.value) })}
            />
            <div className="ofs-step-ticks">
              {ticks.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={durationValue === value ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                  onClick={() => patchForm({ duration: value })}
                >
                  {formatText(t('studio.video.seconds'), { seconds: value })}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {resolutions.length > 0 ? (
        <div className="ofs-field">
          <span className="ofs-field-label">{t('studio.video.resolution')}</span>
          <div className="ofs-step-ticks">
            {resolutions.map((id) => (
              <button
                key={id}
                type="button"
                className={fields.resolution === id ? 'ofs-step-tick is-on' : 'ofs-step-tick'}
                onClick={() => {
                  const ratio = fields.ratio || video.defaultRatio || '16:9'
                  const [rw, rh] = String(ratio).split(':').map(Number)
                  const rv = rw > 0 && rh > 0 ? rw / rh : 16 / 9
                  const shortEdge = id === '480p' ? 480 : 768
                  const even = (v) => Math.max(2, Math.round(v / 2) * 2)
                  const nextSize = rv >= 1
                    ? { width: even(shortEdge * rv), height: even(shortEdge) }
                    : { width: even(shortEdge), height: even(shortEdge / rv) }
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
  fields,
  activePreset,
  patchForm,
  applyCfg,
  resetSeed,
  showNegative,
  negativeOpen,
  setNegativeOpen,
  negativePlaceholder,
  advancedOpen,
  toggleAdvanced,
}) {
  // 高级设置折叠态读数：一眼看清将用什么参数生成，不必展开。
  const animateOpen = useAnimateOpen()
  const isVideo = Boolean(activePreset && activePreset.mediaType === 'video')
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

      {isVideo ? (
        <Fieldset
          title={t('studio.rail.video')}
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
          action={advancedOpen ? null : <span className="ofs-fieldset-readout">{paramsReadout}</span>}
          toggle={toggleAdvanced}
          open={advancedOpen}
        >
          <Drawer open={advancedOpen} animate={animateOpen}>
            <AdvancedParamsGrid
              t={t}
              fields={fields}
              activePreset={activePreset}
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
