/**
 * 工坊「类 Jev（System One）」感知层的 L1 基线引擎（M4.2c Phase 1）。
 *
 * 设计目标：不生成自然语言、不加载模型、不联网，用**闭合问题原语**回答「这张图现在适合
 * 用哪个工具」。三路信号融合成同一份确定性输出，供工坊页决定首屏工具、分组展开、场景标签
 * 与工作流接力：
 *
 *  - **Choice**：`sceneProbs` —— 六类场景的概率分布（和为 1）与最高命中场景 `scene`；
 *  - **Noul**：`noul` —— 六个具体动作的 0~1 概率（要不要抠图 / 是不是网格序列帧 / ……）；
 *  - **Score**：`professionalScore` —— 专业资产倾向度，低于契约阈值按「普通通用图」处理。
 *
 * 三路信号来源（见 docs/WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md §3.2）：
 *  A. 模型出身：`preset.sceneTags`（可选字段）与 `rootPresetId`；
 *  B. 原生提示词语义：优先 `rootPrompt`，其次当前作品 `prompt`；本地导入图直接跳过；
 *  C. 图像客观特征：采样到长边 ≤256px 后提取 Alpha 占比、外框纯色度、主体色数、
 *     3×3 分块均匀度、周期像素格、序列帧空白格线等零依赖特征。
 *
 * 本文件只做纯计算：不 import DOM / canvas / React，也不 import `node:*`，Node 单测可直接调用。
 * 像素输入统一是 `{ width, height, data }` 的 RGBA（`Uint8Array` 或普通数组均可）。
 */

import { WORKSHOP } from '../../shared/contract.js'
import {
  normalizeWorkshopPerceptionTag,
  normalizeWorkshopNoul,
  normalizeWorkshopSceneProbs,
  workshopProfessionalScore,
  workshopRecommendTools,
  workshopSceneConfidence,
  workshopToolsForScene,
} from '../../shared/workshop-scenes.js'
import { detectPixelGrid, seamMae } from './workshop.js'

/** 六类场景 id（与 `WORKSHOP.scenes` 同源，单独导出便于 UI 直接遍历）。 */
export const WORKSHOP_SCENES = WORKSHOP.scenes

/**
 * 感知采样长边上限：超过它按步长抽样后再算特征。
 *
 * 256px 已足够判断「是否纯色外框 / 色彩是否集中 / 有无周期网格」，而特征计算量与图幅解耦，
 * 保证 4K 图也不会拖慢首屏（这是 L1 `<10ms` 目标的前提）。
 */
export const SAMPLE_MAX_EDGE = 256

/**
 * 工具领域分栏（只做展示分组，不改 `WORKSHOP.tools` 契约）：
 * `平面与提取` 面向所有人，`游戏与 3D` 面向专业管线。两栏在顶栏里**同时平铺**，
 * 不做折叠或二级切换——分栏只负责「同类相邻」，不负责隐藏能力。
 */
const TOOL_GROUPS = {
  plane: Object.freeze(['cutout', 'vectorize', 'tile']),
  game3d: Object.freeze(['pixel-snap', 'sprite-slice', 'pbr']),
}

/** 附属通道角色 → 已经做过哪个工具（避免对派生图重复推荐同一个工具）。 */
const CHANNEL_TOOL = {
  cutout: 'cutout',
  albedo: 'pbr',
  normal: 'pbr',
  roughness: 'pbr',
  metallic: 'pbr',
  svg: 'vectorize',
  atlas: 'sprite-slice',
  spritesheet: 'sprite-slice',
  pixel: 'pixel-snap',
  tile: 'tile',
}

/**
 * 提示词关键词表（信号 B）：英文词组按 `server/intent.js` 规范化后的口径匹配。
 *
 * 权重统一为 1，命中多个词组才累加；较长词组命中后会占位，防止 `sprite` 在
 * `sprite sheet` 里被重复计数（见 `scorePromptSignal`）。
 */
const PROMPT_TERMS = [
  [
    'sprite_sheet',
    [
      'sprite sheet',
      'spritesheet',
      'sprite-sheets',
      'animation frames',
      'walk cycle',
      'turnaround',
      'character sheet',
      '4x4 sprite',
      '4×4 sprite',
      '4x4',
      '4×4',
    ],
  ],
  [
    'seamless_texture',
    ['seamless', 'tileable', 'tiling', 'texture', 'seamless texture', 'tileable texture', 'pbr texture', 'repeating texture', 'pbr', 'material map', 'brick', 'wood grain', 'cobblestone', 'grass texture'],
  ],
  [
    'flat_icon_logo',
    ['icon', 'logo', 'badge', 'emblem', 'flat design', 'minimalist vector', 'ui button', 'glyph'],
  ],
  [
    'isolated_prop',
    [
      'isolated on white',
      'isolated',
      'game asset',
      'game item',
      'potion',
      'sword',
      'treasure chest',
      'isometric prop',
      'white background',
      'transparent background',
    ],
  ],
  ['pixel_art', ['pixel art', '8-bit', '16-bit', 'pixelated', 'sprite', 'pixel']],
]

/** 提示词证据封顶权重：单个词组不足以把场景顶死，图像特征缺席时才允许它决定场景。 */
const PROMPT_EVIDENCE_CAP = 0.5

/** 每个命中词组的加分。 */
const PROMPT_TERM_WEIGHT = 0.14

/**
 * 无像素、无硬标签时的普通图基线。
 *
 * 不能因为一条海报提示词里的 "paper grain texture" / "brick wall" 就在图片解码前把
 * 场景拉成材质：0.32 的基线与 0.12 的 softmax 温度配合，单个（甚至两个）普通关键词
 * 只形成微调，不足以越过 `professionalThreshold`。preset.sceneTags 与 doneTools
 * 属于确定性硬先验，不套这条基线。
 */
const NO_PIXEL_PROMPT_BASELINE = 0.32

/** Softmax 温度：0.12 让 0.1 的证据差拉开约 2.3 倍，既不过度自信也不会一片平均。 */
const SCENE_TEMPERATURE = 0.12

/** 模型 `sceneTags` 命中的加分：比提示词强，但仍弱于「图像拍了什么」。 */
const PRESET_TAG_WEIGHT = 0.45

/** 像素格的最小格数：少于 8×8 格的「周期」是大色块边界，不是像素画网格。 */
const MIN_PIXEL_GRID_CELLS = 8

/**
 * 场景证据项：[特征名, 权重]；最终 raw 分 = Σ(权重 × 证据) / Σ权重，天然落在 0~1。
 *
 * 提示词与模型出身**不进这张表**：它们是可选的加分项（见 `scoreScenes`），
 * 缺席时不该稀释图像证据——否则「没有 prompt 的本地导入图」会被系统性压低所有场景分。
 */
const SCENE_EVIDENCE = {
  // 普通摄影 / 插画：色彩丰富、外框不纯、纹理细碎、没有周期网格，而且四边接不上。
  illustration_or_photo: [
    ['richPalette', 0.3],
    ['lowBorderUniformity', 0.2],
    ['photoLikeTexture', 0.2],
    ['noGrid', 0.1],
    ['noGridSprite', 0.1],
    ['noSeamless', 0.25],
  ],
  // 白底 / 纯色底上的单个主体：外框纯色、主体内部有明暗层次、没有序列帧格线。
  isolated_prop: [
    ['borderUniformity', 0.3],
    ['paletteRichness', 0.3],
    ['opaque', 0.2],
    ['noGridSprite', 0.15],
    ['centerFocus', 0.05],
  ],
  // 像素画：强周期网格 + 极少颜色 + 大量纯色像素。
  pixel_art: [
    ['pixelGrid', 0.6],
    ['smallPalette', 0.15],
    ['flatPixels', 0.15],
  ],
  // 序列帧：横纵两轴都有内部空白格线，且间距规整。
  sprite_sheet: [
    ['gridSprite', 0.6],
    ['gridSpriteSpacing', 0.15],
  ],
  // 材质贴图：四边接得上，且九个分块的纹理能量均匀铺满（不是居中单主体）。
  seamless_texture: [
    ['seamlessTexture', 0.55],
    ['noCenterFocus', 0.13],
  ],
  // 扁平图标 / Logo：主体仅几种颜色、几乎没有过渡、没有周期网格。
  flat_icon_logo: [
    ['fewColors', 0.35],
    ['subjectConcentration', 0.25],
    ['flatPixels', 0.2],
    ['noPixelGrid', 0.15],
    ['borderUniformity', 0.1],
  ],
}

/** 是否为有效场景 id。 */
export function isWorkshopScene(value) {
  return typeof value === 'string' && WORKSHOP_SCENES.includes(value)
}

/** 是否为有效工具 id。 */
export function isWorkshopTool(value) {
  return typeof value === 'string' && WORKSHOP.tools.includes(value)
}

/** 两层工具分组（只做展示分组，不改动 `WORKSHOP.tools` 契约与保存链路）。 */
export function workshopToolGroups() {
  return { plane: [...TOOL_GROUPS.plane], game3d: [...TOOL_GROUPS.game3d] }
}

/** 场景 → 推荐工具优先级（副本；调用方可以自由排序 / 过滤）。 */
export function toolsForScene(scene) {
  return workshopToolsForScene(scene)
}

/**
 * 按「最近作品」条目推断已经做过哪些工具。
 *
 * 两个来源：`item.workshopTool`（工坊产物自身）与 `item.channels[].role`（复合资产包的通道，
 * 例如 PBR 四通道说明已经拆过材质）。旧产物没有这些字段时返回空集合。
 */
export function derivedToolsOf(item) {
  const done = new Set()
  if (!item || typeof item !== 'object') return done
  if (isWorkshopTool(item.workshopTool)) done.add(item.workshopTool)
  const channels = Array.isArray(item.channels) ? item.channels : []
  for (const channel of channels) {
    const tool = channel && typeof channel === 'object' ? CHANNEL_TOOL[channel.role] : null
    if (tool) done.add(tool)
  }
  return done
}

// ── 采样与像素特征 ────────────────────────────────────────────────────────

/** Host 根作品字段优先；旧记录从已加载图库按 rootImage 精确补齐先验。 */
export function resolveWorkshopRootContext(item, works = []) {
  const text = (value) => typeof value === 'string' && value.trim() ? value : null
  const context = {
    rootPrompt: text(item && item.rootPrompt),
    rootPresetId: text(item && item.rootPresetId),
  }
  if (!item || item.source === 'import') return { rootPrompt: null, rootPresetId: null }
  if (!item.rootImage || !Array.isArray(works)) return context
  if (context.rootPrompt && context.rootPresetId) return context
  const root = works.find((entry) => entry && entry.image && entry.image.path === item.rootImage)
  const rootItem = root && root.item
  if (!rootItem || rootItem.source === 'import') return context
  // 工坊保存的 prompt 是作品名，不能当作原生意图。
  const prompt = text(rootItem.rootPrompt) || (
    !rootItem.workshop && !isWorkshopTool(rootItem.prompt) ? text(rootItem.prompt) : null
  )
  return {
    rootPrompt: context.rootPrompt || prompt,
    rootPresetId: context.rootPresetId || text(rootItem.rootPresetId) || text(rootItem.presetId),
  }
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  if (number <= 0) return 1e-6
  if (number >= 1) return 1 - 1e-6
  return number
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000
}

/**
 * 长边步长采样到 `maxEdge` 以内：直接取整数步长的像素（最近邻），不做插值。
 *
 * 最近邻是刻意选择：插值会把像素画的硬边抹成渐变，反而破坏「纯色像素占比」这类特征。
 *
 * @param {{ width?: number, height?: number, data?: ArrayLike<number> }} pixels
 * @param {number} [maxEdge]
 * @returns {{ width: number, height: number, data: ArrayLike<number>, step: number } | null}
 */
export function samplePixels(pixels, maxEdge = SAMPLE_MAX_EDGE) {
  const width = Math.max(0, Math.round(Number(pixels && pixels.width) || 0))
  const height = Math.max(0, Math.round(Number(pixels && pixels.height) || 0))
  const data = pixels ? pixels.data : null
  if (!width || !height || !data || typeof data.length !== 'number') return null
  if (data.length < width * height * 4) return null
  const limit = Math.max(8, Math.round(Number(maxEdge) || SAMPLE_MAX_EDGE))
  const step = Math.max(1, Math.ceil(Math.max(width, height) / limit))
  if (step === 1) return { width, height, data, step }
  const outWidth = Math.max(1, Math.floor(width / step))
  const outHeight = Math.max(1, Math.floor(height / step))
  const out = new Uint8Array(outWidth * outHeight * 4)
  for (let y = 0; y < outHeight; y += 1) {
    const sourceRow = Math.min(height - 1, y * step) * width
    for (let x = 0; x < outWidth; x += 1) {
      const source = (sourceRow + Math.min(width - 1, x * step)) * 4
      const target = (y * outWidth + x) * 4
      out[target] = data[source]
      out[target + 1] = data[source + 1]
      out[target + 2] = data[source + 2]
      out[target + 3] = data[source + 3]
    }
  }
  return { width: outWidth, height: outHeight, data: out, step }
}

/** 4-bit 量化色键（16 级 × 3 通道 = 4096 桶）：够区分「少色图标」与「照片级渐变」。 */
function quantColorKey(r, g, b) {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
}

/** 亮度（Rec. 709 权重）。 */
function lumaOf(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * 提取零依赖图像特征（信号 C）。
 *
 * @param {{ width?: number, height?: number, data?: ArrayLike<number> }} pixels RGBA 像素
 * @param {{ maxEdge?: number }} [options]
 * @returns {{
 *   width: number, height: number, step: number,
 *   alphaRatio: number,
 *   borderUniformity: number,
 *   colorBins: number,
 *   colorConcentration: number,
 *   subjectColorBins: number,
 *   subjectConcentration: number,
 *   flatPixelRatio: number,
 *   meanGradient: number,
 *   centerEnergyRatio: number,
 *   regionUniformity: number,
 *   gridSprite: { rows: number, cols: number, confidence: number, cell: number },
 * } | null}
 */
export function extractPixelFeatures(pixels, options = {}) {
  const sample = samplePixels(pixels, options.maxEdge || SAMPLE_MAX_EDGE)
  if (!sample) return null
  return featuresOfSample(sample)
}

/**
 * 从已采样像素提取特征。
 *
 * 与 `extractPixelFeatures` 拆开是为了让 `perceiveWorkshopWork` 只采样一次：
 * 周期网格与接缝评估也跑在这份 ≤256px 的副本上，特征计算量与图幅彻底解耦
 * （全分辨率跑一次 `detectPixelGrid` 在 1024px 上就要 20ms 量级）。
 */
function featuresOfSample(sample) {
  const { width, height, data, step } = sample
  const total = width * height

  // 1) Alpha 占比：判断是否已经抠过图（needsCutout 归零的关键依据）。
  let transparent = 0
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 250) transparent += 1
  }
  const alphaRatio = transparent / total

  // 2) 主色调（4-bit 桶出现次数最多的颜色，取其桶内均值）：既是「背景色」，也是
  //    「主体像素」的判据基准。白底道具 / 图标 / 序列帧都是大面积单色背景。
  const background = dominantColor(sample)

  // 3) 全图与主体两套色彩统计：全图看「照片级丰富度」，主体看「是不是少色扁平图形」。
  const histogram = new Map()
  const subjectHistogram = new Map()
  let subjectPixels = 0
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 16) continue
    const key = quantColorKey(data[index], data[index + 1], data[index + 2])
    histogram.set(key, (histogram.get(key) || 0) + 1)
    if (isBackgroundLike(data, index, background)) continue
    subjectPixels += 1
    subjectHistogram.set(key, (subjectHistogram.get(key) || 0) + 1)
  }
  const colorBins = histogram.size
  const colorConcentration = topCoverage(histogram, 16)
  const subjectColorBins = subjectHistogram.size
  const subjectConcentration = topCoverage(subjectHistogram, 8)

  // 4) 纯色像素占比与平均梯度：图标 / 像素画几乎全是纯色块，照片几乎没有。
  let flatPixels = 0
  let gradientTotal = 0
  let compared = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      let maxDelta = 0
      if (x > 0) {
        const left = index - 4
        maxDelta = Math.max(
          maxDelta,
          Math.abs(data[index] - data[left]),
          Math.abs(data[index + 1] - data[left + 1]),
          Math.abs(data[index + 2] - data[left + 2]),
        )
      }
      if (y > 0) {
        const up = index - width * 4
        maxDelta = Math.max(
          maxDelta,
          Math.abs(data[index] - data[up]),
          Math.abs(data[index + 1] - data[up + 1]),
          Math.abs(data[index + 2] - data[up + 2]),
        )
      }
      if (maxDelta === 0) flatPixels += 1
      gradientTotal += maxDelta
      compared += 1
    }
  }
  const flatPixelRatio = flatPixels / Math.max(1, compared)
  const meanGradient = gradientTotal / Math.max(1, compared)

  // 5) 外框纯色度：最外一圈与「四条边均值色」的平均色差 < 12 的比例。
  const ring = Math.max(1, Math.round(4 / Math.max(1, step)))
  const borderUniformity = measureBorderUniformity(data, width, height, ring, 12)

  // 6) 构图能量：3×3 分块偏差 → 主体居中程度与九宫格均匀度。
  const regions = measureRegions(data, width, height)

  // 7) 序列帧网格：内部空白行列谷值 → 行 × 列。
  const gridSprite = detectGridSprite(sample, background)

  return {
    width,
    height,
    step,
    alphaRatio: round3(alphaRatio),
    borderUniformity: round3(borderUniformity),
    colorBins,
    colorConcentration: round3(colorConcentration),
    subjectColorBins,
    subjectConcentration: round3(subjectConcentration),
    flatPixelRatio: round3(flatPixelRatio),
    meanGradient: round3(meanGradient),
    centerEnergyRatio: round3(regions.centerEnergyRatio),
    regionUniformity: round3(regions.regionUniformity),
    gridSprite,
  }
}

/** 取直方图里覆盖率最高的前 N 个桶所占比例。 */
function topCoverage(histogram, count) {
  if (histogram.size === 0) return 0
  const values = [...histogram.values()].sort((left, right) => right - left).slice(0, count)
  const covered = values.reduce((sum, value) => sum + value, 0)
  const all = [...histogram.values()].reduce((sum, value) => sum + value, 0) || 1
  return covered / all
}

/** 与背景色的 RGB 绝对差之和是否在容差内。 */
function isBackgroundLike(data, index, background, tolerance = 48) {
  const delta = Math.abs(data[index] - background[0])
    + Math.abs(data[index + 1] - background[1])
    + Math.abs(data[index + 2] - background[2])
  return delta <= tolerance
}

/** 出现次数最多的量化色，取其桶内实际的像素均值作为背景色。 */
function dominantColor(sample) {
  const { data } = sample
  const counts = new Map()
  let bestKey = 0
  let bestCount = -1
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 32) continue
    const key = quantColorKey(data[index], data[index + 1], data[index + 2])
    const next = (counts.get(key) || 0) + 1
    counts.set(key, next)
    if (next > bestCount) {
      bestCount = next
      bestKey = key
    }
  }
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 32) continue
    if (quantColorKey(data[index], data[index + 1], data[index + 2]) !== bestKey) continue
    r += data[index]
    g += data[index + 1]
    b += data[index + 2]
    count += 1
  }
  if (count === 0) return [255, 255, 255]
  return [r / count, g / count, b / count]
}

/** 外框纯色度：四条边的平均色作为参照，统计整圈边框与其色差不超过阈值的比例。 */
function measureBorderUniformity(data, width, height, ring, tolerance) {
  if (width < 3 || height < 3) return 0
  const edges = [
    edgeMean(data, width, height, 'top', ring),
    edgeMean(data, width, height, 'bottom', ring),
    edgeMean(data, width, height, 'left', ring),
    edgeMean(data, width, height, 'right', ring),
  ]
  let matched = 0
  let seen = 0
  for (let y = 0; y < height; y += 1) {
    const inRing = y < ring || y >= height - ring
    for (let x = 0; x < width; x += 1) {
      if (!inRing && x >= ring && x < width - ring) continue
      const index = (y * width + x) * 4
      if (data[index + 3] < 16) {
        seen += 1
        matched += 1
        continue
      }
      let best = Number.POSITIVE_INFINITY
      for (const edge of edges) {
        const delta = Math.abs(data[index] - edge[0])
          + Math.abs(data[index + 1] - edge[1])
          + Math.abs(data[index + 2] - edge[2])
        if (delta < best) best = delta
      }
      seen += 1
      if (best <= tolerance) matched += 1
    }
  }
  return seen === 0 ? 0 : matched / seen
}

/** 取某条边（厚度 ring）的平均 RGB。 */
function edgeMean(data, width, height, side, ring) {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  const depth = Math.min(ring, Math.min(width, height))
  const span = side === 'top' || side === 'bottom' ? width : height
  for (let depthIndex = 0; depthIndex < depth; depthIndex += 1) {
    for (let index = 0; index < span; index += 1) {
      let x
      let y
      if (side === 'top') {
        x = index
        y = depthIndex
      } else if (side === 'bottom') {
        x = index
        y = height - 1 - depthIndex
      } else if (side === 'left') {
        x = depthIndex
        y = index
      } else {
        x = width - 1 - depthIndex
        y = index
      }
      const offset = (y * width + x) * 4
      if (data[offset + 3] < 16) continue
      r += data[offset]
      g += data[offset + 1]
      b += data[offset + 2]
      count += 1
    }
  }
  return count === 0 ? [0, 0, 0] : [r / count, g / count, b / count]
}

/** 3×3 分块偏差：给出「主体居中程度」与「九宫格能量均匀度」。 */
function measureRegions(data, width, height) {
  const deviations = []
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const x0 = Math.floor((width * column) / 3)
      const x1 = Math.floor((width * (column + 1)) / 3)
      const y0 = Math.floor((height * row) / 3)
      const y1 = Math.floor((height * (row + 1)) / 3)
      // 两遍扫描而不是先攒数组：分块数据的临时数组是这条热路径上最大的分配来源。
      let total = 0
      let count = 0
      for (let y = y0; y < y1; y += 1) {
        const rowOffset = y * width
        for (let x = x0; x < x1; x += 1) {
          const offset = (rowOffset + x) * 4
          total += lumaOf(data[offset], data[offset + 1], data[offset + 2])
          count += 1
        }
      }
      if (count === 0) {
        deviations.push(0)
        continue
      }
      const mean = total / count
      let spread = 0
      for (let y = y0; y < y1; y += 1) {
        const rowOffset = y * width
        for (let x = x0; x < x1; x += 1) {
          const offset = (rowOffset + x) * 4
          spread += Math.abs(lumaOf(data[offset], data[offset + 1], data[offset + 2]) - mean)
        }
      }
      deviations.push(spread / count)
    }
  }
  const totalDeviation = deviations.reduce((sum, value) => sum + value, 0)
  const centerEnergyRatio = totalDeviation > 0 ? deviations[4] / totalDeviation : 0
  const maxDeviation = Math.max(...deviations)
  const minDeviation = Math.min(...deviations)
  const regionUniformity = maxDeviation <= 0 ? 0 : minDeviation / maxDeviation
  return {
    centerEnergyRatio: clamp01(centerEnergyRatio),
    regionUniformity: clamp01(regionUniformity),
  }
}

/**
 * 序列帧网格探测：行 / 列投影里的「内部空白谷值」。
 *
 * 做法：以主色为背景，逐列 / 逐行统计「墨量」（与背景差异显著的像素占比），
 * 连续的低墨量游程就是格间空白；夹在两侧内容之间的空白游程数 + 1 就是格数。
 * 只有「横纵两轴都找到内部空白」且间距规整时才给置信度，否则返回 1×1。
 *
 * @returns {{ rows: number, cols: number, confidence: number, cell: number }}
 */
function detectGridSprite(sample, background) {
  const { width, height, data, step } = sample
  const empty = { rows: 1, cols: 1, confidence: 0, cell: 0 }
  if (width < 16 || height < 16) return empty

  const columnInk = new Float64Array(width)
  const rowInk = new Float64Array(height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (data[offset + 3] < 32) continue
      if (isBackgroundLike(data, offset, background)) continue
      columnInk[x] += 1
      rowInk[y] += 1
    }
  }
  for (let x = 0; x < width; x += 1) columnInk[x] /= height
  for (let y = 0; y < height; y += 1) rowInk[y] /= width

  const columns = guttersOf(columnInk, width)
  const rows = guttersOf(rowInk, height)
  if (!columns || !rows) return empty
  const cell = Math.min(Math.round(width / columns.count), Math.round(height / rows.count))
  // 单帧太小（根图 <8px）时无法可靠切分，按非序列帧处理（与契约 minFrameEdge 口径一致）。
  if (cell * step < WORKSHOP.sprite.minFrameEdge) return empty
  return {
    rows: rows.count,
    cols: columns.count,
    confidence: round3(clamp01((columns.score + rows.score) / 2)),
    cell,
  }
}

/**
 * 从墨量投影里找内部空白谷值。
 *
 * @param {Float64Array} ink 每列 / 每行的墨量（0~1）
 * @param {number} length 列数 / 行数
 * @returns {{ count: number, score: number } | null} 格数 = 内部空白数 + 1；找不到内部空白返回 null
 */
function guttersOf(ink, length) {
  const threshold = 0.04
  const runs = []
  let start = -1
  for (let index = 0; index <= length; index += 1) {
    const isGutter = index < length && ink[index] <= threshold
    if (isGutter && start === -1) start = index
    if (!isGutter && start !== -1) {
      runs.push({ start, end: index - 1 })
      start = -1
    }
  }
  // 只保留夹在内容之间的空白：贴边的游程是画布留白，不构成格线。
  const inner = runs.filter((run) => run.start > 0 && run.end < length - 1)
  if (inner.length === 0) return null
  const centers = inner.map((run) => (run.start + run.end) / 2)
  const spacings = []
  for (let index = 1; index < centers.length; index += 1) spacings.push(centers[index] - centers[index - 1])
  let regularity = 1
  if (spacings.length > 1) {
    const mean = spacings.reduce((sum, value) => sum + value, 0) / spacings.length
    const variance = spacings.reduce((sum, value) => sum + (value - mean) ** 2, 0) / spacings.length
    const deviation = Math.sqrt(variance)
    regularity = mean > 0 ? clamp01(1 - (deviation / mean) * 2) : 0
  }
  // 谷值越深越可信：空白里几乎不该有墨量。
  const gutterDepth = inner.reduce((sum, run) => {
    let total = 0
    for (let index = run.start; index <= run.end; index += 1) total += ink[index]
    return sum + total / (run.end - run.start + 1)
  }, 0) / inner.length
  const depth = clamp01(1 - gutterDepth / threshold)
  return { count: inner.length + 1, score: clamp01(0.6 * regularity + 0.4 * depth) }
}

// ── 提示词与模型出身信号 ──────────────────────────────────────────────────

/**
 * 原生提示词语义打分（信号 B）。
 *
 * 英文词组按长度降序匹配并占位，长词组命中后其中的短词不再重复计分——否则
 * `sprite sheet` 会同时算进 `sprite`，把序列帧图误判成单张像素画。
 *
 * @param {string} text 已规范化的英文提示词（`rootPrompt` 优先）
 * @returns {Record<string, number>} 场景 → 0~`PROMPT_EVIDENCE_CAP` 的证据分
 */
export function scorePromptSignal(text) {
  const scores = Object.fromEntries(WORKSHOP_SCENES.map((scene) => [scene, 0]))
  const haystack = typeof text === 'string' ? text.toLowerCase() : ''
  if (!haystack.trim()) return scores
  const covered = new Uint8Array(haystack.length)
  const terms = []
  for (const [scene, list] of PROMPT_TERMS) {
    for (const term of list) terms.push({ scene, term })
  }
  terms.sort((left, right) => right.term.length - left.term.length)
  for (const { scene, term } of terms) {
    let from = 0
    let hits = 0
    for (;;) {
      const at = haystack.indexOf(term, from)
      if (at === -1) break
      from = at + 1
      let free = true
      for (let index = at; index < at + term.length; index += 1) {
        if (covered[index]) {
          free = false
          break
        }
      }
      if (!free) continue
      for (let index = at; index < at + term.length; index += 1) covered[index] = 1
      hits += 1
    }
    if (hits > 0) {
      scores[scene] = Math.min(PROMPT_EVIDENCE_CAP, scores[scene] + PROMPT_TERM_WEIGHT * hits)
    }
  }
  return scores
}

/** 归一化模型出身信号：`preset.sceneTags` 命中的场景给予强加权。 */
function scorePresetSignal(preset) {
  const scores = Object.fromEntries(WORKSHOP_SCENES.map((scene) => [scene, 0]))
  const tags = preset && Array.isArray(preset.sceneTags) ? preset.sceneTags : []
  for (const tag of tags) {
    if (isWorkshopScene(tag)) scores[tag] = PRESET_TAG_WEIGHT
  }
  return scores
}

// ── 融合与输出 ────────────────────────────────────────────────────────────

function softmax(raws) {
  const keys = Object.keys(raws)
  const max = Math.max(...keys.map((key) => raws[key]))
  const weights = {}
  let total = 0
  for (const key of keys) {
    const weight = Math.exp((raws[key] - max) / SCENE_TEMPERATURE)
    weights[key] = weight
    total += weight
  }
  const probs = {}
  for (const key of keys) probs[key] = total > 0 ? weights[key] / total : 0
  return probs
}

function argmaxOf(probs, order) {
  let best = order[0]
  for (const key of order) {
    if (probs[key] > probs[best]) best = key
  }
  return best
}

/**
 * 有效像素格置信度：`detectPixelGrid` 只保证「有周期性」，一块大色块的边界也会被它
 * 判成周期。像素画网格至少要有 8×8 格，低于这个密度按「没有像素格」处理。
 */
function effectiveGrid(grid, features) {
  if (!grid || grid.cell < 2 || grid.confidence <= 0) return { cell: 1, confidence: 0 }
  // `grid.cell` 是原图尺度，特征里记的是采样副本尺寸，换算回原图再算格数。
  const shortEdge = features ? Math.min(features.width, features.height) * (features.step || 1) : 0
  if (shortEdge > 0 && shortEdge / grid.cell < MIN_PIXEL_GRID_CELLS) return { cell: 1, confidence: 0 }
  return grid
}

/** 场景证据表：把具体特征摊平成 0~1 的证据值（不含提示词 / 模型出身）。 */
function buildEvidence(features, grid, seam) {
  const gridConfidence = grid.cell > 1 ? clamp01(grid.confidence) : 0
  const sprite = features ? features.gridSprite : { rows: 1, cols: 1, confidence: 0, cell: 0 }
  const spriteConfidence = clamp01(sprite.confidence)
  const border = features ? clamp01(features.borderUniformity) : 0
  const colorBins = features ? features.colorBins : 256
  const subjectBins = features ? features.subjectColorBins : 256
  const subjectConcentration = features ? clamp01(features.subjectConcentration) : 0
  const flat = features ? clamp01(features.flatPixelRatio) : 0
  const centerFocus = features ? clamp01(features.centerEnergyRatio / 0.35) : 0
  const regionUniformity = features ? clamp01(features.regionUniformity) : 0
  const seamless = Boolean(seam && seam.isSeamless)
  return {
    richPalette: clamp01((colorBins - 16) / 96),
    lowBorderUniformity: 1 - border,
    photoLikeTexture: 1 - flat,
    noGrid: gridConfidence >= 0.55 ? 0.1 : 1,
    noGridSprite: 1 - spriteConfidence,
    noSeamless: seamless ? 0 : 1,
    borderUniformity: border,
    paletteRichness: clamp01((subjectBins - 4) / 12),
    opaque: 1 - (features ? clamp01(features.alphaRatio * 4) : 0),
    centerFocus,
    // 像素格必须伴随大面积纯色像素：照片 / 平滑贴图的「周期」多半是结构线，不是像素格子。
    pixelGrid: clamp01(clamp01((flat - 0.2) / 0.5) * (gridConfidence >= 0.45 ? gridConfidence : gridConfidence * 0.25)),
    noPixelGrid: gridConfidence >= 0.55 ? 0.05 : 1,
    smallPalette: clamp01((48 - Math.min(48, colorBins)) / 40),
    flatPixels: flat,
    gridSprite: spriteConfidence,
    gridSpriteSpacing: sprite.rows > 1 && sprite.cols > 1 ? 1 : 0,
    // 接得上 + 九宫格能量均匀才算材质贴图：白底图标四边也接得上，但四角几乎没有纹理。
    seamlessTexture: seamless ? regionUniformity : 0,
    noCenterFocus: 1 - centerFocus,
    fewColors: clamp01((12 - subjectBins) / 8),
    subjectConcentration,
  }
}

/**
 * 场景 raw 分 = 归一化的图像证据 + 提示词加分 + 模型出身加分。
 *
 * 提示词 / 场景标签只做加分（上限见 `PROMPT_EVIDENCE_CAP` 与 `PRESET_TAG_WEIGHT`），
 * 所以「图上一眼看不出像素格」时，哪怕 prompt 写了 `pixel art` 也不会一票定场景——
 * 这正是 AI 生图 prompt 与成图结构不一致时的兜底。
 */
function scoreScenes(evidence, promptScores, presetScores) {
  const raws = {}
  for (const scene of WORKSHOP_SCENES) {
    const rows = SCENE_EVIDENCE[scene] || []
    let weighted = 0
    let weights = 0
    for (const [name, weight] of rows) {
      weighted += weight * clamp01(evidence[name])
      weights += weight
    }
    const base = weights > 0 ? weighted / weights : 0
    // 加分项可以越过 1：softmax 只看相对高低，封顶反而会让「图像已满 + 标签同向」失去区分度。
    raws[scene] = Math.max(0, base) + (promptScores[scene] || 0) + (presetScores[scene] || 0)
  }
  return raws
}

/** 置信度分档文字键（供参数区把数字翻成白话）。 */
export function confidenceLevelKey(confidence) {
  const value = Number(confidence)
  if (!Number.isFinite(value) || value < 0.55) return 'studio.workshop.guide.level.low'
  if (value < 0.78) return 'studio.workshop.guide.level.medium'
  return 'studio.workshop.guide.level.high'
}

/**
 * 工坊感知主入口：三路信号融合 → 标准 `WorkshopPerceptionResult`。
 *
 * 场景分类**只由引擎判定**：Phase 1b 起前台不再提供「6 选 1」的手动覆盖，
 * 用户要纠偏就自己点工具 Tab（推荐点只提示、不锁定）。
 *
 * @param {{
 *   pixels?: { width: number, height: number, data: ArrayLike<number> } | null,
 *   item?: object | null,
 *   preset?: object | null,
 *   rootPrompt?: string,
 *   gridDetected?: { cell: number, confidence: number } | null,
 *   seam?: { maxSeamMae: number, isSeamless: boolean, threshold: number } | null,
 *   maxEdge?: number,
 * }} [input]
 * @returns {{
 *   source: 'l1-heuristic',
 *   latencyMs: number,
 *   scene: string,
 *   sceneProbs: Record<string, number>,
 *   noul: {
 *     needsCutout: number, isGridSprite: number, isPixelGrid: number,
 *     isTileable: number, isVectorFriendly: number, wantsPbr: number,
 *   },
 *   professionalScore: number,
 *   recommendedTools: string[],
 *   showStudioReturnHint: boolean,
 *   reasonKey: string,
 *   reasonParams: Record<string, unknown>,
 *   features: object | null,
 *   derived: { doneTools: string[], hasTransparency: boolean, priorTool: string | null },
 * }}
 */
export function perceiveWorkshopWork(input = {}) {
  const started = nowMs()
  const pixels = input.pixels || null
  const item = input.item && typeof input.item === 'object' ? input.item : {}
  // 只采样一次：特征、周期网格、接缝评估全部跑在这份 ≤256px 的副本上。
  const sample = samplePixels(pixels, input.maxEdge || SAMPLE_MAX_EDGE)
  const features = sample ? featuresOfSample(sample) : null
  // 纯色 / 空白图（量化后 ≤2 个色桶且几乎全平）不携带任何场景信息：此时把图像证据整体
  // 让位给提示词与模型出身，避免「一张白图」被算成「少色扁平图标」。
  const blank = Boolean(features && features.colorBins <= 2 && features.flatPixelRatio > 0.99)
  const grid = blank
    ? { cell: 1, confidence: 0 }
    : effectiveGrid(normalizeGrid(input.gridDetected) || detectGridOfSample(sample), features)
  const seam = blank ? null : normalizeSeam(input.seam) || seamOfSample(sample)
  const promptText = rootPromptOf(input, item)
  const promptScores = scorePromptSignal(promptText)
  const presetScores = scorePresetSignal(input.preset)
  const doneTools = derivedToolsOf(item)
  const hasPresetSignal = WORKSHOP_SCENES.some((key) => (presetScores[key] || 0) > 0)
  const hasPromptSignal = WORKSHOP_SCENES.some((key) => (promptScores[key] || 0) > 0)
  // 没有像素读数时**不能**套用「默认色数 256」那套兜底：那等于凭空造出满分的「照片证据」。
  const evidence = features && !blank ? buildEvidence(features, grid, seam) : {}
  const raws = scoreScenes(evidence, promptScores, presetScores)
  // 无像素且没有确定性硬先验时，给普通图一条基线，避免单个提示词关键词在 softmax 里
  // 被放大成「专业资产」并把首屏工具先切到 tile / pixel-snap，等像素到位再跳回来。
  if (!features && !hasPresetSignal && doneTools.size === 0 && hasPromptSignal) {
    raws.illustration_or_photo += NO_PIXEL_PROMPT_BASELINE
  }
  const sceneProbs = softmax(raws)
  // 场景只由引擎判定：前台不再提供「6 选 1」的手动覆盖，分类器归内部实现。
  const scene = argmaxOf(sceneProbs, WORKSHOP_SCENES)

  // 一点信号都没有时不能拿「均匀分布的期望值」冒充专业度：直接判为普通图。
  const strongest = Math.max(...WORKSHOP_SCENES.map((key) => raws[key]))
  const professionalScore = strongest <= 0
    ? 0
    : round3(workshopProfessionalScore(sceneProbs))

  const hasTransparency = Boolean(features && features.alphaRatio > 0.02)
  const sprite = features ? features.gridSprite : { rows: 1, cols: 1, confidence: 0, cell: 0 }
  const noul = {
    needsCutout: round3(needsCutoutOf(evidence, features, doneTools)),
    isGridSprite: round3(clamp01(blank ? 0 : sprite.confidence)),
    isPixelGrid: round3(clamp01(grid.cell > 1 ? grid.confidence : 0)),
    isTileable: round3(blank ? 0 : tileableOf(seam, evidence)),
    isVectorFriendly: round3(blank ? 0 : clamp01(
      (0.55 * subjectConcentrationOf(features) + 0.45 * flatOf(features))
      * (features && features.subjectColorBins <= 24 ? 1 : 0.45),
    )),
    wantsPbr: round3(blank ? 0 : clamp01(
      0.45 * promptScores.seamless_texture
      + 0.3 * sceneProbs.seamless_texture
      + 0.3 * sceneProbs.isolated_prop,
    )),
  }

  const recommendedTools = workshopRecommendTools(scene, { doneTools, hasTransparency })
  // 「返回创作台」提示只在**真的读过像素**时给：工坊首屏像素还没到位时按最普通场景兜底，
  // 这时弹劝退提示只会让人以为系统误判了他的图（也会造成一次可见的闪烁）。
  const hasImageSignal = Boolean(features) && !blank
  const showStudioReturnHint = hasImageSignal
    && item.workshop !== true
    && doneTools.size === 0
    && !hasTransparency
    && scene === 'illustration_or_photo'
    && professionalScore < WORKSHOP.professionalThreshold

  return {
    source: 'l1-heuristic',
    latencyMs: Math.round((nowMs() - started) * 100) / 100,
    scene,
    sceneProbs,
    noul,
    professionalScore,
    recommendedTools,
    showStudioReturnHint,
    reasonKey: `studio.workshop.scene.reason.${scene}`,
    reasonParams: { scene, score: professionalScore },
    features,
    derived: {
      doneTools: [...doneTools],
      hasTransparency,
      priorTool: isWorkshopTool(item.workshopTool) ? item.workshopTool : null,
      // 冷启动只能立即采信这些硬先验；纯 prompt 必须等真实像素参与后再落焦点。
      hardPrior: doneTools.size > 0 || hasPresetSignal,
    },
  }
}

// ── L2 视觉语义的渐进融合 ──────────────────────────────────────────────────

/**
 * L1 是否已有「像素级硬证据」。这些证据优先于 CLIP 语义：例如实际有透明通道、
 * 检测到 8×8 以上的像素格、序列帧空白格线或可平铺接缝时，L2 不允许把场景改走。
 */
function hasPixelExactEvidence(l1) {
  const features = l1 && l1.features
  const noul = l1 && l1.noul ? l1.noul : {}
  if (!features) return false
  if ((noul.isPixelGrid || 0) >= 0.55) return true
  if ((noul.isGridSprite || 0) >= 0.55) return true
  if ((noul.isTileable || 0) >= 0.6) return true
  if (Number(features.alphaRatio) >= 0.02) return true
  const sprite = features.gridSprite || {}
  if (Number(sprite.confidence) >= 0.55) return true
  return Number(features.borderUniformity) >= 0.78
    && Number(features.subjectConcentration) >= 0.45
}

/**
 * L2 场景是否能在 L1 之上的「安全覆盖」。
 *
 * CLIP 对全幅照片、海报和小图标的分界并不稳定；这里只在两种情况放行：
 *  1. L1 还没读过像素（没有 features），L2 是唯一图像证据；
 *  2. L1 只给出了最普通的 `illustration_or_photo`，且像素特征支持 L2 的专业场景判断。
 *
 * 已经命中像素格 / 序列帧 / 接缝 / 透明通道的图，以及已经有明确专业场景的图，
 * 都保持 L1，不让一个 22MB 的小模型推翻确定性的像素证据。
 */
function canAdoptVisionScene(l1, visionScene) {
  if (!isWorkshopScene(visionScene)) return false
  const features = l1 && l1.features
  if (!features) return true
  if (hasPixelExactEvidence(l1)) {
    // 唯一安全升级：已经确认是像素画，但 L2 明确看到规则网格序列帧。
    return l1.scene === 'pixel_art' && visionScene === 'sprite_sheet'
  }
  if (l1.scene !== 'illustration_or_photo' || visionScene === 'illustration_or_photo') return false

  const flat = Number(features.flatPixelRatio) || 0
  const colors = Number(features.colorBins) || 0
  const subjectColors = Number(features.subjectColorBins) || 0
  if (visionScene === 'pixel_art') return flat >= 0.3 && colors <= 96
  if (visionScene === 'sprite_sheet') {
    return Number(features.gridSprite?.confidence) >= 0.35 || flat >= 0.45
  }
  if (visionScene === 'seamless_texture') {
    return Number(features.regionUniformity) >= 0.55
  }
  if (visionScene === 'isolated_prop') {
    return Number(features.borderUniformity) >= 0.6
      || Number(features.subjectConcentration) >= 0.6
  }
  if (visionScene === 'flat_icon_logo') {
    return flat >= 0.55 && subjectColors <= 24
  }
  return false
}

/**
 * 把 Host 的 L2 语义结果渐进融合进 L1 基线。
 *
 * 契约保证：输入同一份像素时，L1 先同步出结果；L2 只用于「补语义、调推荐」。
 * 本函数是纯函数，不关心请求时序——「手动选工具后丢弃 L2」「换图后丢弃旧响应」
 * 由 Workshop.jsx 的键控 effect 处理。
 *
 * @param {object} l1 `perceiveWorkshopWork()` 的完整结果
 * @param {object|null} vision `/api/workshop/perceive` 返回的 L2 结果
 * @returns {object} 同一 `WorkshopPerceptionResult` 形状（`source: 'l1+l2'`）
 */
export function mergeWorkshopPerception(l1, vision) {
  if (!l1 || typeof l1 !== 'object') return vision || null
  if (!vision || typeof vision !== 'object' || !isWorkshopScene(vision.scene)) return l1

  const l1Probs = normalizeWorkshopSceneProbs(l1.sceneProbs)
  const l2Probs = normalizeWorkshopSceneProbs(vision.sceneProbs)
  const l2Confidence = vision.confidence && Number.isFinite(Number(vision.confidence.top))
    ? {
      scene: isWorkshopScene(vision.confidence.scene) ? vision.confidence.scene : vision.scene,
      top: clamp01(vision.confidence.top),
      margin: Math.max(0, Number(vision.confidence.margin) || 0),
    }
    : workshopSceneConfidence(l2Probs)
  const sceneUsable = l2Confidence.top >= WORKSHOP.vision.sceneMinConfidence
    && l2Confidence.margin >= WORKSHOP.vision.sceneMinMargin
    && canAdoptVisionScene(l1, vision.scene)

  const scene = sceneUsable ? vision.scene : l1.scene
  const sceneProbs = sceneUsable ? l2Probs : l1Probs
  const features = l1.features || null
  const derived = l1.derived && typeof l1.derived === 'object'
    ? l1.derived
    : { doneTools: [], hasTransparency: false, priorTool: null }
  const doneTools = new Set(Array.isArray(derived.doneTools) ? derived.doneTools : [])
  const hasTransparency = Boolean(derived.hasTransparency)
  const l2Noul = normalizeWorkshopNoul(vision.noul)
  const noul = { ...normalizeWorkshopNoul(l1.noul) }
  const trusted = (key) => {
    const value = l2Noul[key]
    return Math.max(value, 1 - value) >= WORKSHOP.vision.noulMinConfidence
  }

  // needsCutout：只有在场景确实像「白底单主体」时才接受 L2 的加分；已有透明通道 /
  // 已抠过图的派生图始终归零。普通全幅照片不因 CLIP 的误判被推荐抠图。
  if (doneTools.has('cutout') || hasTransparency) {
    noul.needsCutout = 0
  } else if (
    trusted('needsCutout')
    && l2Noul.needsCutout >= 0.7
    && (scene === 'isolated_prop' || vision.scene === 'isolated_prop')
  ) {
    noul.needsCutout = round3(Math.max(noul.needsCutout, l2Noul.needsCutout * 0.9))
  }

  // 序列帧 / 像素格：L1 的确定性检测优先；L2 只在语义场景一致时补足 L1 漏检。
  if (
    trusted('isGridSprite')
    && l2Noul.isGridSprite >= 0.65
    && (scene === 'sprite_sheet' || vision.scene === 'sprite_sheet')
  ) {
    noul.isGridSprite = round3(Math.max(noul.isGridSprite, l2Noul.isGridSprite))
  }
  if (
    trusted('isPixelGrid')
    && l2Noul.isPixelGrid >= 0.65
    && (scene === 'pixel_art' || scene === 'sprite_sheet')
    && (!features || Number(features.flatPixelRatio) >= 0.25)
  ) {
    noul.isPixelGrid = round3(Math.max(noul.isPixelGrid, l2Noul.isPixelGrid))
  }

  // 接缝 / 矢量化 / PBR 都以 L1 的特征边界为前提，避免整幅照片被当成材质或图标。
  if (
    noul.isTileable < 0.6
    && trusted('isTileable')
    && l2Noul.isTileable >= 0.65
    && (scene === 'seamless_texture' || vision.scene === 'seamless_texture')
  ) {
    noul.isTileable = round3(Math.max(noul.isTileable, l2Noul.isTileable * 0.9))
  }
  const vectorEvidenceOk = !features
    || (Number(features.flatPixelRatio) >= 0.4 && Number(features.subjectColorBins) <= 32)
  if (
    vectorEvidenceOk
    && trusted('isVectorFriendly')
    && l2Noul.isVectorFriendly >= 0.7
    && (scene === 'flat_icon_logo' || scene === 'pixel_art' || scene === 'sprite_sheet')
  ) {
    noul.isVectorFriendly = round3(Math.max(noul.isVectorFriendly, l2Noul.isVectorFriendly * 0.9))
  }
  if (doneTools.has('pbr')) {
    noul.wantsPbr = 0
  } else if (
    trusted('wantsPbr')
    && l2Noul.wantsPbr >= 0.7
    && (scene === 'isolated_prop' || scene === 'seamless_texture')
  ) {
    noul.wantsPbr = round3(Math.max(noul.wantsPbr, l2Noul.wantsPbr * 0.85))
  }

  const professionalScore = round3(workshopProfessionalScore(sceneProbs))
  const recommendedTools = workshopRecommendTools(scene, { doneTools, hasTransparency })
  const showStudioReturnHint = Boolean(l1.showStudioReturnHint)
    && Boolean(features)
    && doneTools.size === 0
    && !hasTransparency
    && scene === 'illustration_or_photo'
    && professionalScore < WORKSHOP.professionalThreshold
  return {
    ...l1,
    source: 'l1+l2',
    scene,
    sceneProbs,
    noul,
    professionalScore,
    recommendedTools,
    showStudioReturnHint,
    reasonKey: `studio.workshop.scene.reason.${scene}`,
    reasonParams: { scene, score: professionalScore },
    vision: {
      model: typeof vision.model === 'string' ? vision.model : WORKSHOP.vision.model,
      latencyMs: Math.max(0, Number(vision.latencyMs) || 0),
      confidence: l2Confidence,
      appliedScene: sceneUsable,
    },
  }
}

/**
 * 把已持久化的轻量标签还原成 UI 可直接消费的 `WorkshopPerceptionResult`。
 *
 * 标签没有 `sceneProbs` / `features`，这两项仍由当前 L1 结果提供；已定型的最终决策
 * （场景、Noul、专业度、推荐、提示开关）原样覆盖，保证切图首帧与上次离开时一致。
 *
 * @param {object} l1 当前作品的 L1 结果（像素可能尚未到位）
 * @param {object} tag `meta.workshopPerception` 或内存缓存中的标签
 * @returns {object} L1 结果；标签非法时原样返回 `l1`
 */
export function applyWorkshopPerceptionTag(l1, tag) {
  const normalized = normalizeWorkshopPerceptionTag(tag)
  if (!l1 || typeof l1 !== 'object' || !normalized) return l1
  const remainder = (1 - 0.82) / Math.max(1, WORKSHOP_SCENES.length - 1)
  const sceneProbs = Object.fromEntries(
    WORKSHOP_SCENES.map((scene) => [scene, scene === normalized.scene ? 0.82 : remainder]),
  )
  return {
    ...l1,
    source: normalized.source,
    scene: normalized.scene,
    sceneProbs,
    noul: normalized.noul,
    professionalScore: normalized.professionalScore,
    recommendedTools: normalized.recommendedTools,
    showStudioReturnHint: normalized.showStudioReturnHint,
    reasonKey: `studio.workshop.scene.reason.${normalized.scene}`,
    reasonParams: { scene: normalized.scene, score: normalized.professionalScore },
    vision: normalized.source === 'l1+l2'
      ? {
        model: normalized.model,
        latencyMs: 0,
        confidence: null,
        appliedScene: true,
        cached: true,
      }
      : l1.vision,
    perceptionTag: normalized,
  }
}

/**
 * 从一次已收敛的感知结果提取可持久化标签。
 *
 * 只保留最终决策摘要：不包含 features / sceneProbs / embedding，避免把像素统计写进
 * `meta.json`。L2 已参与时记模型 id；纯 L1 时 model 为 null。
 *
 * @param {object} perception
 * @param {{ now?: string|number|Date }} [options]
 * @returns {object|null}
 */
export function workshopPerceptionTagFromResult(perception, options = {}) {
  if (!perception || typeof perception !== 'object') return null
  const withVision = perception.source === 'l1+l2'
  const now = options.now === undefined ? Date.now() : options.now
  return normalizeWorkshopPerceptionTag({
    version: WORKSHOP.perception.tagVersion,
    source: withVision ? 'l1+l2' : 'l1-heuristic',
    model: withVision
      ? (perception.vision && typeof perception.vision.model === 'string'
        ? perception.vision.model
        : WORKSHOP.vision.model)
      : null,
    scene: perception.scene,
    professionalScore: perception.professionalScore,
    recommendedTools: perception.recommendedTools,
    showStudioReturnHint: perception.showStudioReturnHint,
    noul: perception.noul,
    updatedAt: new Date(now).toISOString(),
  })
}

function flatOf(features) {
  return features ? clamp01(features.flatPixelRatio) : 0
}

function subjectConcentrationOf(features) {
  return features ? clamp01(features.subjectConcentration) : 0
}

/** 是否需要先抠图：白底 / 纯色底是最强信号，已有透明像素或已抠过则归零。 */
function needsCutoutOf(evidence, features, doneTools) {
  if (doneTools.has('cutout')) return 0
  const border = clamp01(evidence.borderUniformity)
  const center = clamp01(evidence.centerFocus)
  let value = 0.9 * border + 0.1 * center
  if (features && features.alphaRatio > 0.02) value *= 0.1
  return clamp01(value)
}

/** 可平铺程度：接缝已达标时看九宫格均匀度，不达标时按超出阈值的倍数快速衰减。 */
function tileableOf(seam, evidence) {
  if (!seam) return 0
  if (seam.isSeamless) return clamp01(0.75 + 0.25 * clamp01(evidence.seamlessTexture))
  const threshold = Number(seam.threshold) > 0 ? Number(seam.threshold) : 12
  const ratio = Number(seam.maxSeamMae) / threshold
  return clamp01(0.3 * (1 - Math.min(1, ratio / 6)))
}

/**
 * 工作流接力建议：一次加工往往引出下一步。
 *
 * 返回 `[{ tool, reasonKey }]`，`reasonKey` 供界面加一句「为什么推荐」的白话说明。
 * 只覆盖规划里点名的五条链路，其余工具（PBR / 序列帧产物）视为终点，返回空数组。
 *
 * @param {{ tool?: string, perception?: object | null }} input
 * @returns {Array<{ tool: string, reasonKey: string }>}
 */
export function nextToolSuggestions(input = {}) {
  const tool = isWorkshopTool(input.tool) ? input.tool : ''
  const perception = input.perception && typeof input.perception === 'object' ? input.perception : null
  const noul = perception && perception.noul ? perception.noul : {}
  const scene = perception && isWorkshopScene(perception.scene) ? perception.scene : ''
  if (tool === 'cutout') {
    if (scene === 'sprite_sheet' || (noul.isGridSprite || 0) >= 0.5) {
      return [{ tool: 'sprite-slice', reasonKey: 'studio.workshop.handoff.reason.sprite' }]
    }
    if (scene === 'flat_icon_logo') {
      return [{ tool: 'vectorize', reasonKey: 'studio.workshop.handoff.reason.vector' }]
    }
    if (scene === 'pixel_art') {
      return [{ tool: 'pixel-snap', reasonKey: 'studio.workshop.handoff.reason.pixel' }]
    }
    return [
      { tool: 'pbr', reasonKey: 'studio.workshop.handoff.reason.pbr' },
      { tool: 'vectorize', reasonKey: 'studio.workshop.handoff.reason.vector' },
    ]
  }
  if (tool === 'pixel-snap') {
    const suggestions = [{ tool: 'sprite-slice', reasonKey: 'studio.workshop.handoff.reason.sprite' }]
    if ((noul.isTileable || 0) >= 0.6) {
      suggestions.push({ tool: 'tile', reasonKey: 'studio.workshop.handoff.reason.tile' })
    }
    return suggestions
  }
  if (tool === 'tile') {
    return [{ tool: 'pbr', reasonKey: 'studio.workshop.handoff.reason.pbr' }]
  }
  if (tool === 'vectorize') {
    return [{ tool: 'cutout', reasonKey: 'studio.workshop.handoff.reason.cutout' }]
  }
  return []
}

// ── 内部工具 ──────────────────────────────────────────────────────────────

function nowMs() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/**
 * 原生图先验：`rootPrompt` 优先，其次当前作品 `prompt`；本地导入图没有语义先验。
 *
 * 单看当前 `prompt` 不可靠——工坊保存会把 `params.prompt` 覆写成作品名或工具 id，
 * 所以优先用沿版本树溯源出来的 `rootPrompt`（见 server/output.js 的 `rootPrompt`）。
 */
function rootPromptOf(input, item) {
  const explicit = typeof input.rootPrompt === 'string' ? input.rootPrompt : ''
  if (explicit.trim()) return explicit
  if (item && item.source === 'import') return ''
  const root = typeof item.rootPrompt === 'string' ? item.rootPrompt : ''
  if (root.trim()) return root
  const prompt = typeof item.prompt === 'string' ? item.prompt : ''
  // 工坊产物把 prompt 写成了作品名 / 工具 id，这类文本没有语义信息，不能当成先验。
  if (isWorkshopTool(prompt.trim())) return ''
  return prompt
}

function normalizeGrid(value) {
  if (!value || typeof value !== 'object') return null
  const cell = Number(value.cell)
  const confidence = Number(value.confidence)
  if (!Number.isFinite(cell) || !Number.isFinite(confidence)) return null
  return { cell: Math.max(1, Math.round(cell)), confidence: Math.max(0, Math.min(1, confidence)) }
}

function normalizeSeam(value) {
  if (!value || typeof value !== 'object') return null
  const mae = Number(value.maxSeamMae)
  const threshold = Number(value.threshold)
  if (!Number.isFinite(mae) || !Number.isFinite(threshold)) return null
  return { maxSeamMae: mae, threshold, isSeamless: value.isSeamless === true || mae <= threshold }
}

/**
 * 在采样副本上探测周期像素格，并把格距换算回原图尺度。
 *
 * 采样是整数步长抽取，格距会按步长等比缩小（真值 16px、步长 4 → 副本上 4px），
 * 所以乘回 `step` 即可。这里只服务「是不是像素画」的判定；`pixel-snap` 工具自身的
 * 格距探测仍然走全分辨率（见 `web/studio/workshop/Workshop.jsx`）。
 */
function detectGridOfSample(sample) {
  if (!sample) return null
  try {
    const found = normalizeGrid(detectPixelGrid(sample.data, sample.width, sample.height, {}))
    if (!found) return null
    return { cell: Math.max(1, found.cell * sample.step), confidence: found.confidence }
  } catch {
    return null
  }
}

function seamOfSample(sample) {
  if (!sample) return null
  try {
    return normalizeSeam(seamMae(sample.data, sample.width, sample.height))
  } catch {
    return null
  }
}


