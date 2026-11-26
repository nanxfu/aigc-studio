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

function fullResult(preset) {
  const option = optionOf(preset, FULL_VARIANT_ID)
  return {
    ok: true,
    id: FULL_VARIANT_ID,
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
  return {
    ok: true,
    id: variant.id,
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

  if (!raw) return fullResult(preset)
  if (raw === AUTO_VARIANT_ID) {
    const full = fullResult(preset)
    const compact = variants.find((item) => providerAllowedOf(preset, item, effectiveProvider))
    if (
      effectiveProvider === 'salad'
      && compact
      && Number.isFinite(Number(full.downloadGb))
      && Number(full.downloadGb) >= 24
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
