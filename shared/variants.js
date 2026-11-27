/**
 * 模型精度档（variants）的唯一判定口径。
 *
 * 资产层只描述“同一模型有哪些可选精度档”；Host 在入队时决定本次实际加载哪一档，
 * Worker 只认最终下发的 pipeline，不自行猜测。这样旧客户端不传 variantId 时仍能保持
 * 原来的满血路径，新 UI 传 `auto` 时才按 provider 自动路由。
 *
 * 该模块不 import React / Node / 模型目录，Host 与 Client 可共用。
 */

export const FULL_VARIANT_ID = 'full'
export const AUTO_VARIANT_ID = 'auto'

/** 公开精度选项（构建期生成；缺省返回空数组，旧资产不需要补字段）。 */
export function precisionOptionsOf(preset) {
  return Array.isArray(preset?.precisionOptions) ? preset.precisionOptions : []
}

/** 精度选项的展示名；缺省回退到 precision / id。 */
export function variantLabelOf(option, isEn = false) {
  if (!option || typeof option !== 'object') return ''
  const label = option.label
  if (label && typeof label === 'object') {
    const preferred = isEn ? label.en : label.zh
    if (typeof preferred === 'string' && preferred.trim()) return preferred.trim()
  }
  return typeof option.precision === 'string' ? option.precision : String(option.id || '')
}

/** 请求值是否是一个明确的精度档 id（不是 auto / 空）。 */
export function isExplicitVariantId(value) {
  return typeof value === 'string' && value.trim() !== '' && value.trim() !== AUTO_VARIANT_ID
}

/**
 * 新客户端提交前的精度档归一：有多个档位时，空值 / 非法值一律回落到 `auto`，
 * 让“界面显示自动”和“Host 实际路由”保持一致；没有档位的模型返回空串（不下发字段）。
 */
export function variantRequestOf(preset, current) {
  const options = precisionOptionsOf(preset)
  if (options.length <= 1) return ''
  const id = typeof current === 'string' ? current.trim() : ''
  if (id === AUTO_VARIANT_ID || options.some((item) => item && item.id === id)) return id
  return AUTO_VARIANT_ID
}

/** 取某个具体 variant（不含 full）；未知返回 null。 */
export function variantOf(preset, variantId) {
  const id = typeof variantId === 'string' ? variantId.trim() : ''
  if (!id || id === FULL_VARIANT_ID) return null
  const list = Array.isArray(preset?.variants) ? preset.variants : []
  return list.find((item) => item && item.id === id) || null
}

function providerOf(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'kaggle'
}

function providerAllowedOf(preset, variant, provider) {
  const list = Array.isArray(variant?.providers)
    ? variant.providers
    : Array.isArray(preset?.providers)
      ? preset.providers
      : []
  return list.length === 0 || list.includes(provider)
}

function optionOf(preset, variantId) {
  const options = precisionOptionsOf(preset)
  return options.find((item) => item && item.id === variantId) || null
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function baseModeOf(preset) {
  return preset?.tier === 'usable' ? 'quality' : 'fast'
}

function fullResult(preset) {
  const option = optionOf(preset, FULL_VARIANT_ID)
  return {
    ok: true,
    id: FULL_VARIANT_ID,
    mode: option?.mode || baseModeOf(preset),
    precisionTier: option?.precisionTier || 'full',
    tier: preset?.tier ?? 'fast',
    steps: Number.isFinite(Number(preset?.steps)) ? Number(preset.steps) : null,
    cfg: Number.isFinite(Number(preset?.cfg)) ? Number(preset.cfg) : null,
    cfgRange: preset?.cfgRange ?? null,
    stepRange: preset?.stepRange ?? null,
    precision: typeof option?.precision === 'string' ? option.precision : 'BF16',
    precisionLabel: option?.label ?? null,
    pipeline: preset?.pipeline ?? null,
    downloadGb: firstFiniteNumber(
      option?.downloadGb,
      preset?.downloadGb,
      preset?.pipeline?.downloadGb,
      preset?.measured?.downloadGb,
    ),
    peakVramMb: firstFiniteNumber(
      option?.peakVramMb,
      preset?.peakVramMb,
      preset?.pipeline?.peakVramMb,
      preset?.measured?.peakVramMb,
    ),
    quantizationScheme: null,
    variant: null,
  }
}

function variantResult(preset, variant) {
  const option = optionOf(preset, variant.id)
  const pipeline = variant?.pipeline && typeof variant.pipeline === 'object' ? variant.pipeline : null
  const steps = variant.steps !== undefined ? variant.steps : option?.steps
  const cfg = variant.cfg !== undefined ? variant.cfg : option?.cfg
  const cfgRange = variant.cfgRange !== undefined ? variant.cfgRange : option?.cfgRange
  const stepRange = variant.stepRange !== undefined ? variant.stepRange : option?.stepRange
  const tier = variant.tier || option?.tier || preset?.tier || 'fast'
  return {
    ok: true,
    id: variant.id,
    mode: variant.mode || option?.mode || baseModeOf(preset),
    precisionTier: variant.precisionTier || option?.precisionTier || null,
    tier,
    steps: Number.isFinite(Number(steps)) ? Number(steps) : (Number.isFinite(Number(preset?.steps)) ? Number(preset.steps) : null),
    cfg: Number.isFinite(Number(cfg)) ? Number(cfg) : (Number.isFinite(Number(preset?.cfg)) ? Number(preset.cfg) : null),
    cfgRange: cfgRange !== undefined ? cfgRange : (preset?.cfgRange ?? null),
    stepRange: stepRange !== undefined ? stepRange : (preset?.stepRange ?? null),
    precision: typeof option?.precision === 'string' ? option.precision : String(variant.precision || ''),
    precisionLabel: option?.label ?? variant.label ?? null,
    pipeline,
    downloadGb: firstFiniteNumber(
      variant.downloadGb,
      option?.downloadGb,
      pipeline?.downloadGb,
      variant.measured?.downloadGb,
    ),
    peakVramMb: firstFiniteNumber(
      variant.peakVramMb,
      option?.peakVramMb,
      pipeline?.peakVramMb,
      variant.measured?.peakVramMb,
    ),
    quantizationScheme: typeof pipeline?.quantization?.scheme === 'string'
      ? pipeline.quantization.scheme
      : null,
    variant,
  }
}

/**
 * 解析本次任务的精度档。
 *
 * 语义（Q-05 不允许静默回退）：
 *  - `undefined` / `null` / 空串：旧客户端行为，走满血 full；
 *  - `auto`：按 provider 自动选；Salad 上重模型优先轻量，其它来源优先满血；
 *  - 具体 id：必须命中，且 variant.providers 必须允许当前 provider；否则返回错误。
 *
 * @param {object|null} preset 完整预设（Host 侧含 pipeline / variants）
 * @param {unknown} requestedVariantId 请求里的 variantId
 * @param {unknown} provider 当前算力来源
 * @returns {{ok: true, id: string, precision: string, precisionLabel: object|null,
 *   pipeline: object|null, downloadGb: number|null, peakVramMb: number|null,
 *   quantizationScheme: string|null, variant: object|null} |
 *   {ok: false, code: string, message: string}}
 */
export function resolveVariant(preset, requestedVariantId, provider) {
  if (!preset || typeof preset !== 'object') {
    return { ok: false, code: 'invalid_request', message: '未知模型，无法选择精度档' }
  }
  if (
    requestedVariantId !== undefined
    && requestedVariantId !== null
    && typeof requestedVariantId !== 'string'
  ) {
    return { ok: false, code: 'invalid_request', message: 'variantId 必须是字符串' }
  }
  const raw = typeof requestedVariantId === 'string' ? requestedVariantId.trim() : ''
  const effectiveProvider = providerOf(provider)
  const variants = Array.isArray(preset.variants) ? preset.variants.filter((item) => item && item.id) : []
  if (effectiveProvider === 'local-gpu' && preset.id === 'flux2-klein-4b') {
    const localId = !raw || ['auto', 'full'].includes(raw) ? 'local-q4' : raw
    if (localId === 'quality') return { ok: false, code: 'invalid_request', message: '本机质量挡请选择 Base Q4 或 Q8' }
    const local = variantOf(preset, localId)
    if (local && providerAllowedOf(preset, local, effectiveProvider)) return variantResult(preset, local)
  }

  if (!raw) return fullResult(preset)
  if (raw === AUTO_VARIANT_ID) {
    const full = fullResult(preset)
    const defaultMode = baseModeOf(preset)
    const precisionPool = variants.filter(
      (item) => (item.mode || defaultMode) === defaultMode && providerAllowedOf(preset, item, effectiveProvider),
    )
    const compact = precisionPool[0] || null
    if (
      compact
      && (
        !providerAllowedOf(preset, { providers: preset.providers }, effectiveProvider)
        || (
          effectiveProvider === 'salad'
          && Number.isFinite(Number(full.downloadGb))
          && Number(full.downloadGb) >= 24
        )
      )
    ) {
      return variantResult(preset, compact)
    }
    return full
  }
  if (raw === FULL_VARIANT_ID) return fullResult(preset)

  const variant = variantOf(preset, raw)
  if (!variant) {
    return {
      ok: false,
      code: 'invalid_request',
      message: `未知精度档：${raw}（该模型可选：full / auto${variants.map((item) => ` / ${item.id}`).join('')}）`,
    }
  }
  if (!providerAllowedOf(preset, variant, effectiveProvider)) {
    return {
      ok: false,
      code: 'invalid_request',
      message: `精度档 ${raw} 不支持当前算力来源 ${effectiveProvider}`,
    }
  }
  if (!variant.pipeline || typeof variant.pipeline !== 'object') {
    return {
      ok: false,
      code: 'invalid_request',
      message: `精度档 ${raw} 缺少 pipeline 加载描述`,
    }
  }
  return variantResult(preset, variant)
}

/**
 * 将所选精度/模式挡位合并成有效的预设视图（steps / cfg / stepRange / tier）。
 * 未传或选 `auto` / `full` 时原样返回预设，不影响既有调用方。
 */
export function effectivePresetForVariant(preset, variantId) {
  if (!preset || typeof preset !== 'object') return preset
  const raw = typeof variantId === 'string' ? variantId.trim() : ''
  if (!raw || raw === AUTO_VARIANT_ID || raw === FULL_VARIANT_ID) return preset
  const option = optionOf(preset, raw) || variantOf(preset, raw)
  if (!option || typeof option !== 'object') return preset
  const hasOverride = option.tier !== undefined
    || option.steps !== undefined
    || option.cfg !== undefined
    || option.cfgRange !== undefined
    || option.stepRange !== undefined
  if (!hasOverride) return preset
  return {
    ...preset,
    ...(option.tier !== undefined ? { tier: option.tier } : {}),
    ...(option.steps !== undefined ? { steps: option.steps } : {}),
    ...(option.cfg !== undefined ? { cfg: option.cfg } : {}),
    ...(option.cfgRange !== undefined ? { cfgRange: option.cfgRange } : {}),
    ...(option.stepRange !== undefined ? { stepRange: option.stepRange } : {}),
  }
}

/** 识别模型是否同时具备「极速 / 质量」双出图挡位。 */
export function qualityModesOf(preset) {
  const options = precisionOptionsOf(preset)
  const fastOptions = options.filter((item) => item && item.mode === 'fast')
  const qualityOptions = options.filter((item) => item && item.mode === 'quality')
  const hasModes = fastOptions.length > 0 && qualityOptions.length > 0
  return {
    hasModes,
    modes: hasModes ? ['fast', 'quality'] : [],
    fastOptions,
    qualityOptions,
  }
}

/** 当前表单选中的出图挡位（'fast' | 'quality'）。 */
export function activeQualityModeOf(preset, variantId) {
  const raw = typeof variantId === 'string' ? variantId.trim() : ''
  const option = raw && raw !== AUTO_VARIANT_ID ? (optionOf(preset, raw) || variantOf(preset, raw)) : null
  if (option && option.mode === 'quality') return 'quality'
  return baseModeOf(preset)
}

/** 筛选当前出图挡位下的可用精度选项（单挡位模型保持完整列表）。 */
export function precisionOptionsForMode(preset, mode) {
  const info = qualityModesOf(preset)
  if (!info.hasModes) return precisionOptionsOf(preset)
  return mode === 'quality' ? info.qualityOptions : info.fastOptions
}

/** 当前算力来源是否允许运行指定出图挡位。 */
export function variantModeAllowedForProvider(preset, mode, provider) {
  const effectiveProvider = providerOf(provider)
  const options = precisionOptionsForMode(preset, mode)
  if (options.length === 0) return providerAllowedOf(preset, { providers: preset?.providers }, effectiveProvider)
  return options.some((item) => providerAllowedOf(preset, item, effectiveProvider))
}

function clampStepValue(value, stepRange, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  const rounded = Math.round(num)
  if (stepRange && Number.isFinite(Number(stepRange.min)) && Number.isFinite(Number(stepRange.max))) {
    return Math.min(Number(stepRange.max), Math.max(Number(stepRange.min), rounded))
  }
  return rounded
}

/**
 * 「极速 ↔ 质量」挡位切换补丁：
 *  - 切到 fast：记忆此前质量挡的 steps/cfg，并将当前步数/CFG 切到极速甜点；
 *  - 切到 quality：切到质量挡位，恢复此前记忆的质量步数/CFG（首次取质量挡默认值）。
 */
export function modeSwitchPatch(preset, nextMode, form = {}, provider = '') {
  const info = qualityModesOf(preset)
  if (!info.hasModes) return {}
  const currentMode = activeQualityModeOf(preset, form?.variantId)
  if (nextMode === 'fast') {
    const fastOptions = precisionOptionsForMode(preset, 'fast')
    const allowedFast = fastOptions.filter((item) => providerAllowedOf(preset, item, providerOf(provider)))
    const variantId = allowedFast.length > 1 ? AUTO_VARIANT_ID : (allowedFast[0]?.id || FULL_VARIANT_ID)
    const patch = {
      variantId,
      steps: Number.isFinite(Number(preset?.steps)) ? Number(preset.steps) : 4,
      cfg: Number.isFinite(Number(preset?.cfg)) ? Number(preset.cfg) : 1,
    }
    if (currentMode === 'quality') {
      if (Number.isFinite(Number(form?.steps))) patch.qualitySteps = Number(form.steps)
      if (Number.isFinite(Number(form?.cfg))) patch.qualityCfg = Number(form.cfg)
    }
    return patch
  }
  if (nextMode === 'quality') {
    const effectiveProvider = providerOf(provider)
    const qualityOptions = precisionOptionsForMode(preset, 'quality')
    const target = qualityOptions.find((item) => providerAllowedOf(preset, item, effectiveProvider))
      || qualityOptions[0]
    if (!target) return {}
    const defaultSteps = Number.isFinite(Number(target.steps)) ? Number(target.steps) : 32
    const defaultCfg = Number.isFinite(Number(target.cfg)) ? Number(target.cfg) : 4
    const steps = clampStepValue(form?.qualitySteps, target.stepRange, defaultSteps)
    const cfg = form?.qualityCfg !== null && form?.qualityCfg !== undefined && form?.qualityCfg !== '' && Number.isFinite(Number(form.qualityCfg)) ? Number(form.qualityCfg) : defaultCfg
    return {
      variantId: target.id,
      steps,
      cfg,
    }
  }
  return {}
}
