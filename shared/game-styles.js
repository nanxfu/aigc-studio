/**
 * 风格 LoRA 目录与纯校验辅助（Host / Client / Agent 共用）。
 *
 * 首期面向支持 `pipeline.lora` 挂载的 FLUX.2 家族（如 `flux2-klein-4b`），
 * 涵盖游戏/奇幻/多视角资产与通用风格扩展位，并支持自定义 HF LoRA。
 *
 * 约定：只放纯数据与纯函数，不 import `node:*`。
 */

export const STYLE_LORA_LOADERS = Object.freeze(['flux2'])
export const STYLE_LORA_UNSUPPORTED_PROVIDERS = Object.freeze(['cloud-api'])
export const LORA_SCALE_BOUNDS = Object.freeze({ min: 0.1, max: 1.5, default: 0.9, step: 0.05 })

export const STYLE_LORA_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'all', label: '全部' }),
  Object.freeze({ id: 'game', label: '游戏资产' }),
  Object.freeze({ id: 'illustration', label: '奇幻与插画' }),
  Object.freeze({ id: 'photography', label: '写实摄影' }),
])

const HF_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const WEIGHT_FILE_RE = /^[A-Za-z0-9._/-]+\.safetensors$/i

/** 内置风格 LoRA 清单（均已核实 HF 仓库与文件名，免 gated）。 */
export const GAME_STYLE_LORAS = Object.freeze([
  Object.freeze({
    id: 'none',
    category: 'all',
    repo: '',
    weight: '',
    scale: 1.0,
    trigger: '',
    tags: Object.freeze(['原生', '无', 'base', 'none']),
    compatibleModes: Object.freeze(['fast', 'quality']),
    description: '不挂载额外 LoRA，使用底座原生画风。',
    loaders: STYLE_LORA_LOADERS,
  }),
  Object.freeze({
    id: 'pixel-art',
    category: 'game',
    repo: 'adirik/pixel-art-lora-flux.2-klein-4B',
    weight: 'pixelart_lora.safetensors',
    scale: 0.9,
    trigger: 'PXART4',
    tags: Object.freeze(['像素', '游戏', '精灵', 'pixel', 'sprite', 'game']),
    compatibleModes: Object.freeze(['fast']),
    description: '像素风游戏资产与角色精灵，适合道具、角色与 UI 图标。',
    loaders: STYLE_LORA_LOADERS,
  }),
  Object.freeze({
    id: 'old-gods',
    category: 'illustration',
    repo: 'Norod78/flux2-klein-4b-lora-old-gods',
    weight: 'flux2-klein-4b-lora-old-gods.safetensors',
    scale: 0.8,
    trigger: 'old-gods',
    tags: Object.freeze(['奇幻', '暗黑', '史诗', '克苏鲁', 'fantasy', 'dark']),
    compatibleModes: Object.freeze(['fast', 'quality']),
    description: '暗黑奇幻史诗质感，适合概念场景、怪物与插画氛围。',
    loaders: STYLE_LORA_LOADERS,
  }),
  Object.freeze({
    id: 'spritesheet-2x2',
    category: 'game',
    repo: 'fal/flux-2-klein-4b-spritesheet-lora',
    weight: 'flux-spritesheet-lora.safetensors',
    scale: 1.1,
    trigger: '2x2 sprite sheet',
    tags: Object.freeze(['多视角', '四宫格', '三视图', '设定表', 'spritesheet', '2x2']),
    compatibleModes: Object.freeze(['fast']),
    description: '配合 1 张参考图生成 2×2 等距/侧视/俯视多视角设定图。',
    loaders: STYLE_LORA_LOADERS,
  }),
  Object.freeze({
    id: 'realism-detail',
    category: 'photography',
    repo: 'xocialize/consistence-edit-FLUX.2-klein-4B-lora',
    weight: 'f2k_4B_consist_20260314.safetensors',
    bytes: 385379872,
    sha256: 'bed1e7e8747bc4572a20a7fcef436e82cfbfa5430d0162eda713b55d7a3c7ce4',
    scale: 0.6,
    trigger: 'transform the image to realistic photograph, add realistic details',
    tags: Object.freeze(['写实', '去油', '细节', '摄影', '人像', 'realism', 'photo', 'skin', 'detail']),
    compatibleModes: Object.freeze(['fast']),
    description: '高频写实细节恢复（Apache-2.0），适合配合参考图消除蜡像/油腻感、恢复皮肤与材质纹理。',
    loaders: STYLE_LORA_LOADERS,
  }),
])

/** 通用风格 LoRA 目录别名（向后兼容 GAME_STYLE_LORAS）。 */
export const STYLE_LORAS = GAME_STYLE_LORAS

export function gameStyleById(id) {
  const target = typeof id === 'string' ? id.trim() : ''
  return GAME_STYLE_LORAS.find((item) => item.id === target) || null
}

export const styleLoraById = gameStyleById

/** 按关键词 / 分类 / 挡位检索内置风格 LoRA（不含 none 占位）。 */
export function searchStyleLoras({ keyword = '', category = '', mode = '' } = {}) {
  const tokens = String(keyword ?? '')
    .toLowerCase()
    .split(/[\s,，、;；/]+/)
    .filter(Boolean)
  const cat = typeof category === 'string' ? category.trim() : ''
  const targetMode = typeof mode === 'string' ? mode.trim() : ''
  return STYLE_LORAS.filter((item) => {
    if (!item || item.id === 'none') return false
    if (cat && cat !== 'all' && item.category !== cat) return false
    if (targetMode && Array.isArray(item.compatibleModes) && !item.compatibleModes.includes(targetMode)) {
      return false
    }
    if (tokens.length > 0) {
      const hay = [item.id, item.category, item.description, ...(item.tags || [])].join(' ').toLowerCase()
      if (!tokens.every((token) => hay.includes(token))) return false
    }
    return true
  })
}

/** 供 Agent 工具描述使用的内置 LoRA 摘要（一行一条）。 */
export function styleLoraCatalogText() {
  const items = STYLE_LORAS.filter((item) => item && item.id !== 'none')
  if (items.length === 0) return ''
  return items
    .map((item) => `- ${item.id}（${item.category}，默认强度 ${item.scale}）：${item.description}`)
    .join('\n')
}

/**
 * 当前预设与算力来源是否支持动态 LoRA 挂载。
 *
 * 注意：`cloud-api`（商业 API）暂不支持动态挂载自定义 HF LoRA；`local-gpu` 通过 `sd-server` 结构化 LoRA 挂载。
 */
export function supportsStyleLora(preset, provider = '') {
  if (!preset || typeof preset !== 'object') return false
  if (preset.mediaType === 'video' || preset.inpaintOnly === true) return false
  const loader = typeof preset.pipeline?.loader === 'string' ? preset.pipeline.loader.trim() : ''
  if (!STYLE_LORA_LOADERS.includes(loader)) return false
  const p = typeof provider === 'string' ? provider.trim() : ''
  if (p && STYLE_LORA_UNSUPPORTED_PROVIDERS.includes(p)) return false
  return true
}

function clampScale(value, fallback = LORA_SCALE_BOUNDS.default) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  const clamped = Math.min(LORA_SCALE_BOUNDS.max, Math.max(LORA_SCALE_BOUNDS.min, num))
  return Math.round(clamped * 100) / 100
}

/**
 * 归一化并校验请求 / 表单里的 LoRA 规格。
 *
 * - `null` / `undefined` / `''` / `'none'` / `{ id: 'none' }` → `{ ok: true, value: null }`
 * - 字符串 `'pixel-art'` 或 `{ id: 'pixel-art', scale? }` → 展开内置规格
 * - `{ repo, weight, scale?, trigger?, id? }` → 校验 HF repo 与 `.safetensors` 文件名
 */
export function normalizeLoraSpec(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw === 'string') {
    const id = raw.trim()
    if (!id || id === 'none') return { ok: true, value: null }
    const preset = gameStyleById(id)
    if (!preset) return { ok: false, message: `未知的游戏风格 LoRA：${id}` }
    return {
      ok: true,
      value: {
        id: preset.id,
        repo: preset.repo,
        weight: preset.weight,
        scale: preset.scale,
        trigger: preset.trigger,
      },
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'lora 必须是对象或风格标识' }
  }

  const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (rawId === 'none') return { ok: true, value: null }
  const builtin = rawId ? gameStyleById(rawId) : null
  if (builtin) {
    const trigger = typeof raw.trigger === 'string' ? raw.trigger.trim().slice(0, 120) : builtin.trigger
    return {
      ok: true,
      value: {
        id: builtin.id,
        repo: builtin.repo,
        weight: builtin.weight,
        scale: clampScale(raw.scale, builtin.scale),
        trigger,
      },
    }
  }

  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  const weight = typeof raw.weight === 'string' ? raw.weight.trim() : ''
  if (!repo || !weight) {
    return { ok: false, message: '自定义 LoRA 需要 repo 与 weight（.safetensors 文件名）' }
  }
  if (!HF_REPO_RE.test(repo)) {
    return { ok: false, message: 'LoRA repo 格式应为 owner/model-name' }
  }
  if (weight.startsWith('/') || weight.includes('..') || !WEIGHT_FILE_RE.test(weight)) {
    return { ok: false, message: 'LoRA weight 必须是安全的 .safetensors 文件名' }
  }
  const trigger = typeof raw.trigger === 'string' ? raw.trigger.trim().slice(0, 120) : ''
  return {
    ok: true,
    value: {
      id: rawId || 'custom',
      repo,
      weight,
      scale: clampScale(raw.scale, LORA_SCALE_BOUNDS.default),
      trigger,
    },
  }
}

/** 若提示词尚未包含触发词，则自动前置触发词；已有时不重复拼接。 */
export function applyLoraTriggerPrompt(prompt, trigger) {
  const base = typeof prompt === 'string' ? prompt.trim() : ''
  const trig = typeof trigger === 'string' ? trigger.trim() : ''
  if (!trig) return base
  if (!base) return trig
  if (base.toLowerCase().includes(trig.toLowerCase())) return base
  return `${trig}, ${base}`
}
