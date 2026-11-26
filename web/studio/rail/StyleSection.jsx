/**
 * 左栏「风格锁定」（Style LoRA）：
 *
 * 面向支持动态 LoRA 的 FLUX.2 底座（如 `flux2-klein-4b`）：
 *  - 提供内置开源风格 LoRA（像素风 / 复古像素 / 2×2 多视角等），及自定义 HF LoRA；
 *  - 支持一键锁定当前风格：点击「新建创作」清空提示词与种子时仍保留所选 LoRA 与强度；
 *  - 若所选 LoRA 带触发词（如 `PXART4`），提交任务时由 Host 自动前置，不污染用户草稿。
 */

import React from 'react'

import {
  STYLE_LORAS,
  LORA_SCALE_BOUNDS,
  STYLE_LORA_LOADERS,
  STYLE_LORA_UNSUPPORTED_PROVIDERS,
  styleLoraById,
} from '../../../shared/game-styles.js'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'
import { Drawer, useAnimateOpen } from './Drawer.jsx'
import { Fieldset } from './Fieldset.jsx'

const STYLE_CHOICES = [
  ...STYLE_LORAS,
  { id: 'custom', repo: '', weight: '', scale: LORA_SCALE_BOUNDS.default, trigger: '' },
]

export function StyleSection({
  t,
  activePreset,
  provider = '',
  styleLora = null,
  styleLocked = false,
  patchForm,
  changed = false,
}) {
  const loader = typeof activePreset?.pipeline?.loader === 'string' ? activePreset.pipeline.loader.trim() : ''
  const supportedModel = Boolean(
    activePreset
    && activePreset.mediaType !== 'video'
    && activePreset.inpaintOnly !== true
    && STYLE_LORA_LOADERS.includes(loader),
  )
  const animateOpen = useAnimateOpen()
  const activeId = styleLora && typeof styleLora === 'object'
    ? (styleLoraById(styleLora.id) ? styleLora.id : 'custom')
    : 'none'
  const activeEntry = activeId !== 'none' && activeId !== 'custom' ? styleLoraById(activeId) : null
  const [open, setOpen] = React.useState(() => activeId !== 'none')

  React.useEffect(() => {
    if (activeId !== 'none') setOpen(true)
  }, [activeId])

  if (!supportedModel) return null

  const providerUnsupported = Boolean(provider && STYLE_LORA_UNSUPPORTED_PROVIDERS.includes(provider))
  const scaleValue = Number.isFinite(Number(styleLora?.scale))
    ? Number(styleLora.scale)
    : LORA_SCALE_BOUNDS.default
  const pct = Math.max(
    0,
    Math.min(100, ((scaleValue - LORA_SCALE_BOUNDS.min) / (LORA_SCALE_BOUNDS.max - LORA_SCALE_BOUNDS.min)) * 100),
  )
  const activeLabel = t(`studio.style.preset.${activeId}`)
  const readout = activeId === 'none'
    ? activeLabel
    : `${activeLabel} ×${scaleValue.toFixed(2).replace(/0$/, '')}`

  function selectStyle(id) {
    if (id === 'none') {
      patchForm({ styleLora: null })
      return
    }
    if (id === 'custom') {
      const currentCustom = activeId === 'custom' && styleLora ? styleLora : null
      patchForm({
        styleLora: {
          id: 'custom',
          repo: currentCustom?.repo || '',
          weight: currentCustom?.weight || '',
          scale: currentCustom?.scale ?? LORA_SCALE_BOUNDS.default,
          trigger: currentCustom?.trigger || '',
        },
      })
      return
    }
    const preset = styleLoraById(id)
    if (!preset) return
    patchForm({
      styleLora: {
        id: preset.id,
        repo: preset.repo,
        weight: preset.weight,
        scale: preset.scale,
        trigger: preset.trigger,
      },
    })
  }

  function updateLoraField(patch) {
    const base = styleLora && typeof styleLora === 'object'
      ? styleLora
      : { id: activeId === 'none' ? 'custom' : activeId, repo: '', weight: '', scale: LORA_SCALE_BOUNDS.default, trigger: '' }
    patchForm({ styleLora: { ...base, ...patch } })
  }

  return (
    <Fieldset
      title={t('studio.style.title')}
      changed={changed}
      open={open}
      toggle={() => setOpen((prev) => !prev)}
      action={(
        <>
          {activeId !== 'none' ? (
            <button
              type="button"
              className={styleLocked ? 'ofs-style-lock is-locked' : 'ofs-style-lock'}
              aria-pressed={styleLocked}
              title={t(styleLocked ? 'studio.style.lockedHint' : 'studio.style.unlockedHint')}
              onClick={(event) => {
                event.stopPropagation()
                patchForm({ styleLocked: !styleLocked })
              }}
            >
              <Icon name="lock" size={11} />
              <span>{t(styleLocked ? 'studio.style.locked' : 'studio.style.lock')}</span>
            </button>
          ) : null}
          {!open ? <span className="ofs-fieldset-readout">{readout}</span> : null}
        </>
      )}
    >
      <Drawer open={open} animate={animateOpen}>
        <div className="ofs-style-stack">
          <div className="ofs-style-chips" role="radiogroup" aria-label={t('studio.style.title')}>
            {STYLE_CHOICES.map((item) => {
              const selected = activeId === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? 'ofs-style-chip is-on' : 'ofs-style-chip'}
                  onClick={() => selectStyle(item.id)}
                >
                  {t(`studio.style.preset.${item.id}`)}
                </button>
              )
            })}
          </div>

          {activeId !== 'none' ? (
            <>
              <div className="ofs-field">
                <div className="ofs-step-head">
                  <span className="ofs-field-label">{t('studio.style.scale')}</span>
                  <span className="ofs-step-readout">{scaleValue.toFixed(2)}</span>
                </div>
                <div className="ofs-step-slider-wrap" style={{ '--ofs-step-pct': `${pct}%` }}>
                  <div className="ofs-step-track" aria-hidden="true">
                    <span className="ofs-step-track-fill" />
                    <span className="ofs-step-knob" />
                  </div>
                  <input
                    type="range"
                    className="ofs-step-slider"
                    min={LORA_SCALE_BOUNDS.min}
                    max={LORA_SCALE_BOUNDS.max}
                    step={LORA_SCALE_BOUNDS.step}
                    value={scaleValue}
                    aria-label={t('studio.style.scale')}
                    onChange={(event) => updateLoraField({ scale: Number(event.target.value) })}
                  />
                </div>
              </div>

              {activeId === 'custom' ? (
                <div className="ofs-style-custom">
                  <input
                    type="text"
                    className="ofs-style-input"
                    value={styleLora?.repo || ''}
                    placeholder={t('studio.style.customRepo')}
                    aria-label={t('studio.style.customRepo')}
                    spellCheck={false}
                    onChange={(event) => updateLoraField({ repo: event.target.value })}
                  />
                  <input
                    type="text"
                    className="ofs-style-input"
                    value={styleLora?.weight || ''}
                    placeholder={t('studio.style.customWeight')}
                    aria-label={t('studio.style.customWeight')}
                    spellCheck={false}
                    onChange={(event) => updateLoraField({ weight: event.target.value })}
                  />
                  <input
                    type="text"
                    className="ofs-style-input"
                    value={styleLora?.trigger || ''}
                    placeholder={t('studio.style.customTrigger')}
                    aria-label={t('studio.style.customTrigger')}
                    spellCheck={false}
                    onChange={(event) => updateLoraField({ trigger: event.target.value })}
                  />
                </div>
              ) : (
                <>
                  {activeId === 'spritesheet-2x2' || activeId === 'realism-detail' ? (
                    <p className="ofs-hint ofs-style-note">{t(`studio.style.hint.${activeId}`)}</p>
                  ) : activeEntry?.description ? (
                    <p className="ofs-hint ofs-style-note">{activeEntry.description}</p>
                  ) : null}
                  {styleLora?.trigger ? (
                    <p className="ofs-hint ofs-style-note">
                      {formatText(t('studio.style.triggerNote'), { trigger: styleLora.trigger })}
                    </p>
                  ) : null}
                </>
              )}

              {providerUnsupported ? (
                <p className="ofs-hint ofs-style-warn" role="status">
                  {t('studio.style.providerUnsupported')}
                </p>
              ) : null}
            </>
          ) : (
            <p className="ofs-hint ofs-style-note">{t('studio.style.hint.none')}</p>
          )}
        </div>
      </Drawer>
    </Fieldset>
  )
}
