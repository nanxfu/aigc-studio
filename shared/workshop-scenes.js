/**
 * 工坊感知层的场景口径（Host 与 Client 共用，M4.2c Phase 2）。
 *
 * Phase 1 的 L1 与 Phase 2 的 L2 都会给出六类场景概率；推荐工具顺序和专业倾向度
 * 必须只有一份映射，否则同一张图在 Host / Client 会得到不同排名。本文件只放
 * 不依赖 DOM、模型或文件系统的常量与纯函数；像素特征、提示词先验仍留在 L1 引擎。
 */

import { WORKSHOP } from './contract.js'

/** 场景 → 工具推荐优先级：第一项是首屏主推荐。 */
export const WORKSHOP_SCENE_TOOLS = Object.freeze({
  illustration_or_photo: Object.freeze(['cutout', 'tile', 'vectorize']),
  isolated_prop: Object.freeze(['cutout', 'pbr', 'vectorize']),
  pixel_art: Object.freeze(['pixel-snap', 'sprite-slice', 'tile']),
  sprite_sheet: Object.freeze(['sprite-slice', 'pixel-snap', 'cutout']),
  seamless_texture: Object.freeze(['tile', 'pbr', 'vectorize']),
  flat_icon_logo: Object.freeze(['vectorize', 'cutout', 'tile']),
})

/** 专业资产倾向度的场景权重：像素 / 序列帧 / 材质是典型游戏资产，普通照片几乎为 0。 */
export const WORKSHOP_PROFESSIONAL_WEIGHT = Object.freeze({
  illustration_or_photo: 0.05,
  isolated_prop: 0.55,
  pixel_art: 1,
  sprite_sheet: 1,
  seamless_texture: 0.8,
  flat_icon_logo: 0.2,
})

/** Noul 的固定键顺序（输出归一与测试都按它）。 */
export const WORKSHOP_NOUL_KEYS = Object.freeze([
  'needsCutout',
  'isGridSprite',
  'isPixelGrid',
  'isTileable',
  'isVectorFriendly',
  'wantsPbr',
])

/** 是否为有效场景 id。 */
export function isWorkshopScene(value) {
  return typeof value === 'string' && WORKSHOP.scenes.includes(value)
}

/** 是否为有效工具 id。 */
export function isWorkshopTool(value) {
  return typeof value === 'string' && WORKSHOP.tools.includes(value)
}

/** 场景 → 推荐工具优先级（副本；调用方可以自由排序 / 过滤）。 */
export function workshopToolsForScene(scene) {
  const list = WORKSHOP_SCENE_TOOLS[scene] || WORKSHOP_SCENE_TOOLS.illustration_or_photo
  return [...list]
}

/**
 * 推荐排序：场景优先级 → 去掉已做过的工具、以及不该再抠的图（已有透明通道）→ 最多 3 项。
 *
 * 注意不要因为 `needsCutout` 偏低就把抠图从推荐里摘掉：普通照片本来就没有「白底待抠」的
 * 特征，但工坊对它的首要建议仍是抹除背景（规划 §2.2 的防迷宫默认落点）。
 *
 * @param {string} scene
 * @param {{ doneTools?: Set<string>|string[], hasTransparency?: boolean }} [context]
 * @returns {string[]}
 */
export function workshopRecommendTools(scene, context = {}) {
  const done = context.doneTools instanceof Set ? context.doneTools : new Set(context.doneTools || [])
  const base = workshopToolsForScene(scene)
  const filtered = base.filter((tool) => {
    if (done.has(tool)) return false
    if (tool === 'cutout' && context.hasTransparency) return false
    return true
  })
  return (filtered.length > 0 ? filtered : base).slice(0, 3)
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/** 概率分布归一；非法 / 全零输入回落到均匀分布。 */
export function normalizeWorkshopSceneProbs(value) {
  const probs = Object.fromEntries(WORKSHOP.scenes.map((scene) => [scene, 0]))
  let total = 0
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const scene of WORKSHOP.scenes) {
      const number = Number(value[scene])
      if (!Number.isFinite(number) || number <= 0) continue
      probs[scene] = number
      total += number
    }
  }
  if (total <= 0) {
    for (const scene of WORKSHOP.scenes) probs[scene] = 1 / WORKSHOP.scenes.length
    return probs
  }
  for (const scene of WORKSHOP.scenes) probs[scene] /= total
  return probs
}

/** 最高场景与第二名的差值；用于判断 L2 是否足够可信到可以参与覆盖。 */
export function workshopSceneConfidence(sceneProbs) {
  const sorted = WORKSHOP.scenes
    .map((scene) => [scene, clamp01(sceneProbs?.[scene])])
    .sort((left, right) => right[1] - left[1])
  return {
    scene: sorted[0][0],
    top: sorted[0][1],
    margin: Math.max(0, sorted[0][1] - (sorted[1]?.[1] || 0)),
  }
}

/** 专业资产倾向度：场景概率按固定权重加权。 */
export function workshopProfessionalScore(sceneProbs) {
  const normalized = normalizeWorkshopSceneProbs(sceneProbs)
  return WORKSHOP.scenes.reduce(
    (sum, scene) => sum + normalized[scene] * WORKSHOP_PROFESSIONAL_WEIGHT[scene],
    0,
  )
}

/** Noul 归一：缺失 / 非法值按 0，其余夹到 [0,1]。 */
export function normalizeWorkshopNoul(value) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(WORKSHOP_NOUL_KEYS.map((key) => [key, clamp01(source[key])]))
}
