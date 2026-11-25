import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { publicPresets, RATIO_IDS } from '../../shared/contract.js'
import { cloudPresetsFor } from '../../shared/image-providers.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SHOWCASE_DIR = join(ROOT, 'docs/assets/showcase')
const EXAMPLES_DIR = join(ROOT, 'web/studio/workshop/examples')
const OUTPUTS_DIR = join(ROOT, '.aigc-studio-data/workspace/outputs')
const SHOWCASE_URL = '/__preview/showcase'
const LIVE_URL = '/__preview/live'
const EXAMPLES_URL = '/__preview/examples'
const OUTPUTS_URL = '/__preview/outputs'

export const NOW = Date.parse('2026-11-09T05:05:00.000Z')
export const at = (offsetSec) => new Date(NOW + offsetSec * 1000).toISOString()

// ── 占位图：五种中性明度的抽象构图，模拟真实出图的观感（不含主题色） ──
function placeholder(seed, width = 1024, height = 1024) {
  const variant = Math.abs(Math.round(seed * 7.13)) % 5
  const level = (seed * 37) % 5
  const hue = level % 2 === 0 ? 220 : 32
  const sat = 3 + (level % 3)
  const ink = Math.max(16, 42 - level * 5)
  const mid = 62 - level * 6
  const paper = 96 - level * 2
  const id = `p${seed}`
  const defs = `
    <defs>
      <linearGradient id="${id}-bg" x1="0" y1="0" x2="0.9" y2="1">
        <stop offset="0%" stop-color="hsl(${hue} ${sat}% ${paper}%)"/>
        <stop offset="52%" stop-color="hsl(${hue} ${sat}% ${mid}%)"/>
        <stop offset="100%" stop-color="hsl(${hue} ${sat}% ${ink}%)"/>
      </linearGradient>
      <radialGradient id="${id}-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="rgba(255,255,255,0.85)"/>
        <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
      </radialGradient>
      <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="hsl(${hue} ${sat}% ${paper}%)"/>
        <stop offset="100%" stop-color="hsl(${hue} ${sat}% ${Math.max(58, mid - 6)}%)"/>
      </linearGradient>
      <filter id="${id}-blur" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="${Math.max(width, height) * 0.025}"/>
      </filter>
      <filter id="${id}-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
        <feColorMatrix type="saturate" values="0"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.12"/></feComponentTransfer>
      </filter>
    </defs>`

  let scene = ''
  if (variant === 0) {
    scene = `<rect width="${width}" height="${height}" fill="url(#${id}-bg)"/>
      <ellipse cx="${width * 0.7}" cy="${height * 0.34}" rx="${width * 0.22}" ry="${height * 0.22}" fill="url(#${id}-glow)" filter="url(#${id}-blur)"/>
      <circle cx="${width * 0.7}" cy="${height * 0.34}" r="${Math.min(width, height) * 0.18}" fill="url(#${id}-glow)" opacity="0.75"/>`
  } else if (variant === 1) {
    const horizon = height * 0.62
    scene = `<rect width="${width}" height="${height}" fill="url(#${id}-sky)"/>
      <circle cx="${width * 0.68}" cy="${horizon - height * 0.14}" r="${Math.min(width, height) * 0.1}" fill="url(#${id}-glow)" filter="url(#${id}-blur)" opacity="0.9"/>
      <path d="M0 ${horizon} L${width * 0.22} ${horizon - height * 0.16} L${width * 0.4} ${horizon - height * 0.04} L${width * 0.58} ${horizon - height * 0.2} L${width * 0.78} ${horizon - height * 0.07} L${width} ${horizon - height * 0.18} V${height} H0 Z" fill="hsl(${hue} ${sat}% ${Math.max(20, ink + 8)}%)" opacity="0.86"/>
      <path d="M0 ${horizon + height * 0.14} L${width * 0.3} ${horizon + height * 0.02} L${width * 0.62} ${horizon + height * 0.12} L${width} ${horizon - height * 0.02} V${height} H0 Z" fill="hsl(${hue} ${sat}% ${Math.max(12, ink - 6)}%)"/>`
  } else if (variant === 2) {
    const bands = 5
    let paths = ''
    for (let index = 0; index < bands; index += 1) {
      const y = height * (0.3 + index * 0.13)
      const light = Math.max(16, paper - 12 - index * 14)
      paths += `<path d="M0 ${y} C ${width * 0.3} ${y - height * 0.06}, ${width * 0.62} ${y + height * 0.08}, ${width} ${y - height * 0.02} V${height} H0 Z" fill="hsl(${hue} ${sat}% ${light}%)" opacity="${0.9 - index * 0.12}"/>`
    }
    scene = `<rect width="${width}" height="${height}" fill="url(#${id}-bg)"/>${paths}`
  } else if (variant === 3) {
    scene = `<rect width="${width}" height="${height}" fill="hsl(${hue} ${sat}% ${paper}%)"/>
      <path d="M${width * 0.18} ${height} V${height * 0.42} A ${width * 0.32} ${width * 0.32} 0 0 1 ${width * 0.82} ${height * 0.42} V${height} Z" fill="url(#${id}-bg)"/>
      <circle cx="${width * 0.5}" cy="${height * 0.3}" r="${Math.min(width, height) * 0.07}" fill="url(#${id}-glow)" filter="url(#${id}-blur)"/>`
  } else {
    scene = `<rect width="${width}" height="${height}" fill="url(#${id}-bg)"/>
      <path d="M${width * 0.1} ${height * 0.9} C ${width * 0.34} ${height * 0.5}, ${width * 0.46} ${height * 0.36}, ${width * 0.9} ${height * 0.16}" stroke="url(#${id}-glow)" stroke-width="${Math.min(width, height) * 0.22}" fill="none" filter="url(#${id}-blur)" opacity="0.8"/>`
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${defs}
    ${scene}
    <rect width="${width}" height="${height}" filter="url(#${id}-grain)" opacity="0.55"/>
  </svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

async function readShowcase() {
  try {
    const manifest = JSON.parse(await readFile(join(SHOWCASE_DIR, 'manifest.json'), 'utf8'))
    const items = Array.isArray(manifest.items) ? manifest.items : []
    const usable = []
    for (const item of items) {
      const file = item && typeof item.file === 'string' ? item.file : ''
      const width = Number(item && item.width)
      const height = Number(item && item.height)
      if (!file || !(width > 0) || !(height > 0)) continue
      try {
        await access(join(SHOWCASE_DIR, file))
      } catch {
        continue
      }
      usable.push({ ...item, width, height, url: `${SHOWCASE_URL}/${file}` })
    }
    return usable
  } catch {
    return []
  }
}

const SHOWCASE = await readShowcase()
const VECTOR_SAMPLE_SVG = await readFile(join(EXAMPLES_DIR, 'vector-after.svg'), 'utf8').catch(() => '')

// 真机 GPU 实测与工坊工具真实样本，供预览展示完整业务流程。
const SHIELD_SOURCE_IMG = {
  path: 'outputs/live/2026-11-23T15-36-01/01-workshop-source.png',
  file: '01-workshop-source.png',
  url: `${LIVE_URL}/2026-11-23T15-36-01/01-workshop-source.png`,
  seed: 99,
  seconds: 3.5,
  width: 768,
  height: 768,
}
const SHIELD_CUTOUT_CHANNEL = {
  role: 'cutout',
  file: '02-cutout-birefnet.png',
  format: 'png',
  width: 768,
  height: 768,
  url: `${LIVE_URL}/2026-11-23T15-36-01/02-cutout-birefnet.png`,
}
const SHIELD_PBR_CHANNELS = ['albedo', 'normal', 'roughness', 'metallic'].map((role) => ({
  role,
  file: `03-pbr-${role}.png`,
  format: 'png',
  width: 768,
  height: 768,
  url: `${LIVE_URL}/2026-11-23T15-36-01/03-pbr-${role}.png`,
}))

const PIXEL_IMG = {
  path: 'outputs/examples/pixel-before.webp',
  file: 'pixel-sword.png',
  url: `${EXAMPLES_URL}/pixel-before.webp`,
  seed: 101,
  seconds: null,
  width: 96,
  height: 96,
}
const SPRITE_IMG = {
  path: 'outputs/examples/sprite-sheet.webp',
  file: 'sprite-sheet.png',
  url: `${EXAMPLES_URL}/sprite-sheet.webp`,
  seed: 102,
  seconds: null,
  width: 96,
  height: 96,
}
const VECTOR_IMG = {
  path: 'outputs/examples/vector-before.webp',
  file: 'badge-icon.png',
  url: `${EXAMPLES_URL}/vector-before.webp`,
  seed: 103,
  seconds: null,
  width: 32,
  height: 32,
}
const TILE_IMG = {
  path: 'outputs/examples/shield-albedo.webp',
  file: 'oak-texture.png',
  url: `${EXAMPLES_URL}/shield-albedo.webp`,
  seed: 104,
  seconds: null,
  width: 240,
  height: 240,
}

const WORKSHOP_SHIELD_ITEM = {
  jobId: 'live-workshop-shield',
  dir: 'outputs/live/2026-11-23T15-36-01',
  prompt: '中世纪骑士盾牌，拉丝钢与橡木材质，干净浅灰棚拍底，游戏道具',
  rootPrompt: 'stylized medieval knight shield made of brushed steel and oak wood, isolated game prop',
  presetId: 'sdxl-lightning',
  workshop: true,
  workshopTool: 'pbr',
  finishedAt: at(-90),
  channels: [SHIELD_CUTOUT_CHANNEL, ...SHIELD_PBR_CHANNELS],
  images: [SHIELD_SOURCE_IMG],
}

const WORKSHOP_PIXEL_ITEM = {
  jobId: 'workshop-pixel-sword',
  dir: 'outputs/examples',
  prompt: 'pixel art game sword sprite, 16-bit',
  rootPrompt: 'pixel art game sword sprite, 16-bit',
  presetId: null,
  source: 'import',
  finishedAt: at(-240),
  channels: [],
  images: [PIXEL_IMG],
}

const WORKSHOP_SPRITE_ITEM = {
  jobId: 'workshop-sprite-sword',
  dir: 'outputs/examples',
  prompt: '2x2 character weapon sprite sheet, animation frames',
  rootPrompt: '2x2 sprite sheet animation frames',
  presetId: null,
  source: 'import',
  finishedAt: at(-360),
  channels: [],
  images: [SPRITE_IMG],
}

const WORKSHOP_VECTOR_ITEM = {
  jobId: 'workshop-vector-badge',
  dir: 'outputs/examples',
  prompt: 'minimalist flat icon logo',
  rootPrompt: 'minimalist flat icon logo',
  presetId: null,
  source: 'import',
  finishedAt: at(-480),
  channels: VECTOR_SAMPLE_SVG
    ? [{ role: 'svg', file: 'vector-after.svg', format: 'svg', url: `${EXAMPLES_URL}/vector-after.svg` }]
    : [],
  images: [VECTOR_IMG],
}

const WORKSHOP_TILE_ITEM = {
  jobId: 'workshop-tile-oak',
  dir: 'outputs/examples',
  prompt: 'seamless oak wood texture, top-down material',
  rootPrompt: 'seamless oak wood texture',
  presetId: null,
  source: 'import',
  finishedAt: at(-600),
  channels: [],
  images: [TILE_IMG],
}

const LIVE_INPAINT_ITEM = {
  jobId: 'live-inpaint-crane',
  dir: 'outputs/live/2026-11-21T11-49-20',
  prompt: '晨雾荷塘里的红冠鹤，水墨质感',
  presetId: 'sdxl-lightning',
  finishedAt: at(-150),
  images: [{
    path: 'outputs/live/2026-11-21T11-49-20/01.png',
    file: '01.png',
    url: `${LIVE_URL}/2026-11-21T11-49-20/01.png`,
    seed: 42,
    seconds: 12.8,
    width: 1024,
    height: 1024,
  }],
}

const LIVE_OUTPAINT_SOURCE_ITEM = {
  jobId: 'live-outpaint-source',
  dir: 'outputs/live/2026-11-21T12-24-34',
  prompt: '晨雾荷塘里的红冠鹤，中国水墨画',
  presetId: 'sdxl-lightning',
  finishedAt: at(-180),
  images: [{
    path: 'outputs/live/2026-11-21T12-24-34/01-source-content.png',
    file: '01-source-content.png',
    url: `${LIVE_URL}/2026-11-21T12-24-34/01-source-content.png`,
    seed: 42,
    seconds: 10.3,
    width: 864,
    height: 864,
  }],
}

const LIVE_OUTPAINT_RESULT_ITEM = {
  jobId: 'live-outpaint-result',
  dir: 'outputs/live/2026-11-21T12-24-34',
  prompt: '晨雾荷塘里的红冠鹤，16:9 扩图延展两岸芦苇与水雾',
  presetId: 'flux2-klein-4b',
  sourceImage: 'outputs/live/2026-11-21T12-24-34/01-source-content.png',
  rootImage: 'outputs/live/2026-11-21T12-24-34/01-source-content.png',
  outpaintContent: { x: 336 / 1536, y: 0, width: 864 / 1536, height: 1 },
  finishedAt: at(-80),
  images: [{
    path: 'outputs/live/2026-11-21T12-24-34/03-outpaint-lora.png',
    file: '03-outpaint-lora.png',
    url: `${LIVE_URL}/2026-11-21T12-24-34/03-outpaint-lora.png`,
    seed: 42,
    seconds: 20.7,
    width: 1536,
    height: 864,
  }],
}

const LIVE_REF_RESULT_ITEM = {
  jobId: 'live-ref-2refs',
  dir: 'outputs/live/2026-11-21T12-40-47',
  prompt: '融合水墨红冠鹤与山水构图，1024×1024 双图参考生成',
  presetId: 'flux2-klein-4b',
  finishedAt: at(-70),
  images: [{
    path: 'outputs/live/2026-11-21T12-40-47/02-reference-2ref-1024x1024.png',
    file: '02-reference-2ref-1024x1024.png',
    url: `${LIVE_URL}/2026-11-21T12-40-47/02-reference-2ref-1024x1024.png`,
    seed: 42,
    seconds: 24.5,
    width: 1024,
    height: 1024,
  }],
}

const SILICONFLOW_PRESETS = cloudPresetsFor('siliconflow')
const VIDEO_PRESET = SILICONFLOW_PRESETS.find((item) => item.mediaType === 'video') || SILICONFLOW_PRESETS[0]

// 宽高比接近的样张放同一个池：请求 16:9 就从 16:9 的图里轮换，不把竖图塞进横框。
const RATIO_VALUE = Object.fromEntries(
  RATIO_IDS.map((id) => {
    const [w, h] = id.split(':').map(Number)
    return [id, w / h]
  }),
)

function ratioIdOf(width, height) {
  const target = Number(width) / Number(height)
  if (!Number.isFinite(target) || target <= 0) return RATIO_IDS[0]
  let best = RATIO_IDS[0]
  for (const id of RATIO_IDS) {
    if (Math.abs(RATIO_VALUE[id] - target) < Math.abs(RATIO_VALUE[best] - target)) best = id
  }
  return best
}

const SHOWCASE_POOLS = new Map()
for (const entry of SHOWCASE) {
  const id = ratioIdOf(entry.width, entry.height)
  const pool = SHOWCASE_POOLS.get(id) ?? []
  pool.push(entry)
  SHOWCASE_POOLS.set(id, pool)
}

/** manifest 条目 → 组件期望的 image 视图（字段与 /api/history 一致）。 */
const sampleImage = (entry) => {
  const file = entry.file.replace(/\.webp$/, '.png')
  return {
    path: `outputs/showcase/${file}`,
    file,
    url: entry.url,
    seed: entry.seed,
    seconds: entry.seconds,
    width: entry.width,
    height: entry.height,
  }
}

const image = (seed, width = 1024, height = 1024, seconds = 6.2) => {
  const pool = SHOWCASE_POOLS.get(ratioIdOf(width, height))
  if (!pool || pool.length === 0) {
    return {
      path: `outputs/job-${seed}/${seed}.png`,
      file: `${seed}.png`,
      url: placeholder(seed, width, height),
      seed,
      seconds,
      width,
      height,
    }
  }
  // 同一个 seed 永远落到同一张真实图，页面之间不会互相错位。
  return sampleImage(pool[Math.abs(Math.round(seed)) % pool.length])
}

// 预览用的预设来自契约（与 /api/state 的公开视图同形）：直接消费 shared/contract.js 的 publicPresets()。
const allPresets = publicPresets()
const publicPreset = (id) => {
  const found = allPresets.find((item) => item.id === id)
  if (!found) throw new Error(`预览缺少预设：${id}`)
  return found
}
const preset = publicPreset('sdxl-lightning')
const turbo = publicPreset('sana-sprint-1.6b')

// 历史条目的展示文案要与图片内容对应，避免「图是动漫、文案写赛博朋克」的错位。
const SHOWCASE_COPY = {
  '雨夜霓虹街道': '雨夜霓虹街道，湿地面反射灯光，青绿与品红配色，远处有人撑伞',
  '海边老渔民肖像': '海边老渔民的写实肖像，羊毛衫与围巾，侧窗自然光',
  '云端瀑布梦境': '云端浮岛与瀑布，粉与薄荷色天空，绘本感的梦幻插画',
  '高山湖泊的金色黄昏': '高山湖泊的金色黄昏，雪山倒影与前景松林',
  '巴洛克静物': '巴洛克静物，瓷瓶玫瑰、葡萄与黄铜烛台，深色木桌侧光',
  '赤月下的武士': '赤月下的武士剪影，深色天空与高对比极简构图',
  '极简京都旅行海报': '极简京都旅行海报，红色鸟居与竹林，顶部 KYOTO 字样',
  '樱花巷口的少女': '樱花巷口的动漫少女，校服与飘落花瓣，柔和春日光线',
  '薰衣草花田的黄昏': '薰衣草花田里的白裙少女，日落暖金光，手绘插画感',
  '水墨山水小舟': '水墨山水与江上一叶小舟，大面积留白，角上一枚红印',
  '兔耳双马尾少女': '兔耳双马尾少女坐在圆舱里挥手，白裙与蓝色蝴蝶结，梦幻感的动漫插画',
  '舱中的少女': '灰发绿眼的少女坐在圆舱里挥手，浅蓝色上衣，明快的动漫配色',
  '哥特教堂': '黄昏的哥特教堂，银发少女穿白裙站在彩窗前，石板地面反光',
  '兔耳蓝裙少女': '兔耳发饰的金发双马尾少女，蓝白蝴蝶结裙，明亮柔光',
  '浪与舟': '浮世绘风格的巨浪与一叶小舟，红橙色调，浪尖上的红衣船夫',
  '红日与浪': '红日下的巨浪与一叶小舟，远山与红橙色调的国风海报',
  '初音未来': '初音未来坐在窗边，蓝绿色长双马尾，自然光',
  'Q 版角色四格': '四格 Q 版角色贴纸，赛车帽、独角兽角、海军帽与王冠',
  '荧光森林': '荧光蘑菇撑起树冠的奇幻森林，青绿色微光，漂浮的孢子',
  '和室里的少女': '和室里的黑发少女，白色和服与红色腰带，纸门透光',
  '白发少女': '白发绿眼的动漫少女半身，浅绿色上衣，柔和室内光',
  '和服少女肖像': '和服少女肖像，红色腰带与樱花发饰，浅色背景与竖排题字',
}

const SHOWCASE_ASK = {
  '雨夜霓虹街道': '画一张横版的雨夜霓虹街道，要电影感',
  '极简京都旅行海报': '画一张横版的京都旅行海报，红鸟居和竹林',
  '兔耳双马尾少女': '画一张横版的兔耳双马尾少女',
}

const copyOf = (entry) => SHOWCASE_COPY[entry.title] || entry.prompt

function intentOf(item) {
  const raw = String(item.rawPrompt || '').trim()
  if (!raw) return item.prompt
  if (!/^[\x20-\x7E]+$/.test(raw.slice(0, 24))) return item.prompt
  const head = raw.slice(0, 60)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf(', '))
  return stop > 25 ? head.slice(0, stop) : head
}

const DAY_SECONDS = 24 * 3600

function finishedAtOf(index) {
  if (index < 4) return at(-180 - index * 720)
  if (index < 8) return at(-6 * 3600 - (index - 4) * 18 * 3600)
  return at(-(2 + (index - 8)) * DAY_SECONDS - 1800)
}

function buildShowcaseHistory(entries) {
  const [hero, ...rest] = entries
  const ordered = [
    hero,
    ...rest.filter((entry) => entry.width > entry.height),
    ...rest.filter((entry) => entry.width === entry.height),
    ...rest.filter((entry) => entry.width < entry.height),
  ]
  return ordered.map((entry, index) => ({
    jobId: `job-${9001 + index}`,
    dir: `outputs/showcase-${index + 1}`,
    title: entry.title,
    prompt: copyOf(entry),
    rawPrompt: entry.prompt,
    presetId: entry.presetId,
    finishedAt: finishedAtOf(index),
    images: [sampleImage(entry)],
  }))
}

const fallbackHistory = [
  {
    jobId: 'job-9001',
    dir: 'outputs/20261109-120301-job-9001',
    prompt: '黄昏的赛博朋克街道，湿润地面反射霓虹灯，电影感构图',
    presetId: 'sdxl-lightning',
    finishedAt: at(-180),
    images: [image(902, 1152, 648), image(901, 1152, 648), image(903, 648, 1152), image(904, 1024, 1024)],
  },
  {
    jobId: 'job-9000',
    dir: 'outputs/20261109-115900-job-9000',
    prompt: '东方水墨风格的远山与孤舟，大面积留白',
    presetId: 'sana-sprint-1.6b',
    finishedAt: at(-9 * 3600),
    images: [image(900), image(910, 648, 1152)],
  },
  {
    jobId: 'job-8999',
    dir: 'outputs/20261108-190000-job-8999',
    prompt: '3D 黏土质感的小熊，柔和棚拍光',
    presetId: 'sdxl-lightning',
    finishedAt: at(-30 * 3600),
    images: [image(899), image(898)],
  },
  {
    jobId: 'job-8998',
    dir: 'outputs/20261105-161500-job-8998',
    prompt: '极简主义的建筑光影，米白墙面与斜射晨光',
    presetId: 'z-image-turbo',
    finishedAt: at(-4 * 24 * 3600),
    images: [image(897, 1152, 648), image(896, 1024, 1024), image(895, 648, 1152)],
  },
]

async function loadUserOutputs(limit = 20) {
  try {
    const dirs = (await readdir(OUTPUTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse()
    const items = []
    for (const dir of dirs) {
      if (items.length >= limit) break
      try {
        const meta = JSON.parse(await readFile(join(OUTPUTS_DIR, dir, 'meta.json'), 'utf8'))
        if (meta?.imported || meta?.source === 'import') continue
        const first = Array.isArray(meta?.images) ? meta.images[0] : null
        const file = first?.file || first?.filename
        if (!file) continue
        await access(join(OUTPUTS_DIR, dir, file))
        const prompt = meta.params?.prompt || first?.prompt || meta.prompt || ''
        if (!prompt) continue
        items.push({
          jobId: meta.jobId || dir,
          dir: `outputs/${dir}`,
          prompt,
          presetId: meta.presetId || 'sdxl-lightning',
          finishedAt: meta.finishedAt || NOW - items.length * 3600_000,
          images: [{
            ...first,
            path: `${dir}/${file}`,
            url: `${OUTPUTS_URL}/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`,
          }],
        })
      } catch {
        // skip incomplete entries
      }
    }
    return items
  } catch {
    return []
  }
}

const USER_OUTPUTS = await loadUserOutputs(12)

export const historyItems = [
  ...(SHOWCASE.length > 0 ? buildShowcaseHistory(SHOWCASE) : fallbackHistory),
  ...USER_OUTPUTS,
]

const WORKSHOP_HISTORY = [
  WORKSHOP_SHIELD_ITEM,
  WORKSHOP_PIXEL_ITEM,
  WORKSHOP_SPRITE_ITEM,
  WORKSHOP_VECTOR_ITEM,
  WORKSHOP_TILE_ITEM,
  ...historyItems,
]

const HERO_ITEM = historyItems[0]
export const HERO_PROMPT = HERO_ITEM.prompt
export const CHAT_ITEM =
  historyItems.find((item) => item.title === '极简京都旅行海报') ||
  historyItems.find((item) => item.images[0].width > item.images[0].height) ||
  HERO_ITEM
export const CHAT_IMAGE = CHAT_ITEM.images[0]
export const CHAT_ASK = SHOWCASE_ASK[CHAT_ITEM.title] || `帮我画一张：${CHAT_ITEM.prompt}`
export const CHAT_INTENT = intentOf(CHAT_ITEM)

/**
 * 裸本地导入图（M2.6 预览用）：只有文件名与像素，没有任何扩散参数。
 * 放在历史最前面 → 工作台默认选中它，左栏进入导入图锁定态。
 */
export const IMPORT_ITEM = {
  jobId: 'import-20261122-preview',
  dir: 'outputs/import-preview',
  prompt: 'seaside-house.png',
  presetId: null,
  source: 'import',
  sourceImage: null,
  rootImage: null,
  finishedAt: at(-60),
  params: { prompt: 'seaside-house.png', width: 1024, height: 1024, count: 1, source: 'import' },
  images: [{ ...image(950), seed: null, seconds: null }],
}

export const states = {  ready: {
    defaultPreset: 'sdxl-lightning',
    presets: allPresets,
    session: { state: 'ready', modelId: 'sdxl-lightning', device: 'Tesla T4', idleTimeoutSec: 1800, error: null },
    jobs: [],
    lastJob: null,
    probe: {
      provider: 'kaggle',
      cli: { present: true, version: '1.6.17' },
      auth: { ok: true },
      quota: { available: true, usedHours: 3, totalHours: 30 },
      notes: ['kaggle CLI 1.6.17', '账号接入正常'],
    },
  },
  empty: {
    defaultPreset: 'sdxl-lightning',
    presets: allPresets,
    session: { state: 'absent', error: null },
    jobs: [],
    lastJob: null,
  },
  queued: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset],
    session: { state: 'provisioning', phase: 'queue', startedAt: at(-120), error: null },
    jobs: [{ id: 'job-x', status: 'waiting-session', startedAt: at(-60), params: { prompt: '荧光森林（排队中）' } }],
    lastJob: null,
  },
  queueTwo: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset],
    session: { state: 'ready', modelId: 'sdxl-lightning', device: 'Tesla T4', idleTimeoutSec: 1800, error: null },
    jobs: [
      { id: 'job-two', status: 'queued', createdAt: at(-5), startedAt: null, params: { prompt: '哥特街道（等待中）' } },
      { id: 'job-one', status: 'running', createdAt: at(-30), startedAt: at(-8), params: { prompt: '兔耳双马尾少女（生成中）' } },
    ],
    lastJob: null,
  },
  pushing: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset],
    session: { state: 'provisioning', phase: 'push', startedAt: at(-20), error: null },
    jobs: [{ id: 'job-p', status: 'waiting-session', startedAt: at(-10), params: { prompt: '正在推送任务：荧光森林' } }],
    lastJob: null,
  },
  connecting: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset],
    session: { state: 'connecting', phase: 'tunnel', startedAt: at(-150), error: null },
    jobs: [{ id: 'job-c', status: 'waiting-session', startedAt: at(-60), params: { prompt: '正在建立隧道：和室里的少女' } }],
    lastJob: null,
  },
  warming: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset],
    session: { state: 'warming', phase: 'warm', startedAt: at(-330), device: 'Tesla T4', error: null },
    jobs: [{ id: 'job-w', status: 'waiting-session', startedAt: at(-200), params: { prompt: '正在装载模型：兔耳蓝裙少女' } }],
    lastJob: null,
  },
  asleep: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset],
    session: { state: 'error', error: { code: 'session_ended', message: 'Kernel 已结束（COMPLETE），点「唤醒」可重新启动会话' } },
    jobs: [],
    lastJob: null,
  },
  stopped: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset],
    session: { state: 'absent', stoppedByUser: true, error: null },
    jobs: [],
    lastJob: null,
  },
  guidance: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset, turbo],
    session: { state: 'ready', modelId: 'sdxl-lightning', device: 'Tesla T4', error: null },
    jobs: [
      {
        id: 'job-oom',
        status: 'failed',
        startedAt: at(-40),
        finishedAt: at(-30),
        params: { prompt: '过大的画面：4096 × 4096' },
        error: { code: 'oom', message: 'CUDA out of memory' },
        output: { images: [] },
      },
    ],
    lastJob: null,
  },
  cli: {
    defaultPreset: 'sdxl-lightning',
    presets: [preset, turbo],
    session: {
      state: 'error',
      phase: null,
      error: { code: 'cli_missing', message: '未找到 kaggle CLI，请先安装：pip install -U kaggle' },
    },
    jobs: [],
    lastJob: null,
    probe: {
      provider: 'kaggle',
      cli: { present: false, error: 'command not found' },
      auth: { ok: false, errorCode: 'cli_missing' },
      quota: { available: false },
      notes: ['未找到 kaggle CLI，请先安装：pip install -U kaggle'],
    },
  },
}

export const libraryResponse = {
  favorites: [historyItems[0]?.images[0]?.path, historyItems[2]?.images[0]?.path].filter(Boolean),
  deleted: [],
}

export const portraitHistory = (() => {
  const index = historyItems.findIndex((item) => {
    const first = item.images[0]
    return first && first.height > first.width
  })
  if (index <= 0) return historyItems
  const portrait = historyItems[index]
  return [portrait, ...historyItems.filter((item) => item !== portrait)]
})()

export const freshHistory = [
  { ...historyItems[0], finishedAt: at(-5) },
  ...historyItems.slice(1),
]

export const CHAT_MESSAGES = [
  { id: 1, role: 'user', text: CHAT_ASK },
  {
    id: 2,
    role: 'assistant',
    kind: 'intent',
    prompt: CHAT_INTENT,
    summary: '极简京都旅行海报：红色鸟居与竹林，顶部 KYOTO 字样，横版构图',
    ratioId: '16:9',
    negative: '',
    count: 1,
    lockSeed: false,
    clarify: null,
    modelHint: null,
    source: 'model',
  },
  { id: 3, role: 'user', text: '可以，就这样生成' },
  {
    id: 4,
    role: 'assistant',
    kind: 'job',
    jobId: CHAT_ITEM.jobId,
    stage: 'done',
    text: '已生成，点击缩略图放大。',
    image: CHAT_IMAGE.url,
    meta: `${CHAT_IMAGE.seconds} 秒 · 种子 ${CHAT_IMAGE.seed}`,
  },
]

export function buildScenarios() {
  return {
    'studio-ready': {
      kind: 'studio',
      state: states.ready,
      history: historyItems,
      props: { initialPrompt: HERO_PROMPT },
    },
    'studio-portrait': {
      kind: 'studio',
      state: states.ready,
      history: portraitHistory,
      props: { initialPrompt: portraitHistory[0].prompt },
    },
    'studio-fresh': {
      kind: 'studio',
      state: states.ready,
      history: freshHistory,
      props: { initialPrompt: HERO_PROMPT },
    },
    'studio-pending': {
      kind: 'studio',
      state: {
        ...states.ready,
        jobs: [{ id: 'job-first', status: 'running', startedAt: at(-8), params: { prompt: '第一张画面：兔耳双马尾少女', width: 720, height: 1280 } }],
      },
      history: [],
    },
    'studio-chat': {
      kind: 'studio',
      state: states.ready,
      history: historyItems,
      props: { panelMode: 'chat' },
    },
    // M2.6：裸导入图焦点隔离——表单 / 助手锁定，只留引导条与「新建创作」出口。
    'studio-import': {
      kind: 'studio',
      state: states.ready,
      history: [IMPORT_ITEM, ...historyItems],
      props: { workspaceMode: 'work' },
    },
    'studio-import-chat': {
      kind: 'studio',
      state: states.ready,
      history: [IMPORT_ITEM, ...historyItems],
      props: { panelMode: 'chat', workspaceMode: 'work' },
    },
    'studio-gallery': {
      kind: 'studio',
      state: states.ready,
      history: historyItems,
      props: { view: 'gallery' },
    },
    // 工坊整页（M4.2c）：默认展开说明 + 左栏同宽 + 全套工具实机场景。
    'workshop-tools': {
      kind: 'studio',
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'cutout',
        workshopEntry: { image: SHIELD_SOURCE_IMG, item: WORKSHOP_SHIELD_ITEM },
      },
    },
    'workshop-cutout': {
      kind: 'studio',
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'cutout',
        workshopEntry: { image: SHIELD_SOURCE_IMG, item: WORKSHOP_SHIELD_ITEM },
        workshopProps: { initialChannel: 'cutout' },
      },
    },
    'workshop-pbr': {
      kind: 'studio',
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'pbr',
        workshopEntry: { image: SHIELD_SOURCE_IMG, item: WORKSHOP_SHIELD_ITEM },
        workshopProps: { initialChannel: 'normal' },
      },
    },
    'workshop-vectorize': {
      kind: 'studio',
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'vectorize',
        workshopEntry: { image: VECTOR_IMG, item: WORKSHOP_VECTOR_ITEM },
        workshopProps: {
          initialResult: VECTOR_SAMPLE_SVG ? { tool: 'vectorize', svg: VECTOR_SAMPLE_SVG } : null,
        },
      },
    },
    'workshop-tile': {
      kind: 'studio',
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'tile',
        workshopEntry: { image: TILE_IMG, item: WORKSHOP_TILE_ITEM },
        workshopProps: {
          initialTilePreview: true,
          initialParams: { tile: { blend: true, blendRatio: 0.14 } },
        },
      },
    },
    'workshop-pixel': {
      kind: 'studio',
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'pixel-snap',
        workshopEntry: { image: PIXEL_IMG, item: WORKSHOP_PIXEL_ITEM },
      },
    },
    'workshop-sprite': {
      kind: 'studio',
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'sprite-slice',
        workshopEntry: { image: SPRITE_IMG, item: WORKSHOP_SPRITE_ITEM },
        workshopProps: {
          initialParams: { sprite: { rows: 2, cols: 2, frameMs: 120, trimAlpha: true } },
        },
      },
    },
    // 复现大量作品时的侧栏分配，验证高窗口与参数说明展开后的内部滚动。
    'workshop-many': {
      kind: 'studio',
      state: states.ready,
      history: Array.from({ length: 86 }, (_, index) => {
        const item = historyItems[index % historyItems.length]
        const dir = `outputs/workshop-preview-${index}`
        return {
          ...item,
          jobId: `workshop-preview-${index}`,
          dir,
          images: [{ ...item.images[0], path: `${dir}/01.png` }],
        }
      }),
      props: { view: 'workshop' },
    },
    'workshop-dark': {
      kind: 'studio',
      dark: true,
      state: states.ready,
      history: WORKSHOP_HISTORY,
      props: {
        view: 'workshop',
        workshopInitialTool: 'pbr',
        workshopEntry: { image: SHIELD_SOURCE_IMG, item: WORKSHOP_SHIELD_ITEM },
        workshopProps: { initialChannel: 'albedo' },
      },
    },
    // 创作页实机扩展场景：视频创作 / 局部重绘 / 扩图画布 / 原图拉帘对比 / 原生双参考图。
    'studio-video': {
      kind: 'studio',
      state: {
        provider: 'cloud-api',
        defaultPreset: VIDEO_PRESET.id,
        presets: SILICONFLOW_PRESETS,
        session: { state: 'ready', provider: 'siliconflow', error: null },
        jobs: [],
        lastJob: null,
      },
      history: historyItems,
      props: {
        workspaceMode: 'new_draft',
        initialPrompt: '海风吹拂的日落海边站台，列车缓缓驶过，电影感运镜',
      },
    },
    'studio-inpaint': {
      kind: 'studio',
      state: states.ready,
      history: [LIVE_INPAINT_ITEM, ...historyItems],
      props: {
        workspaceMode: 'work',
        initialImageTool: 'inpaint',
      },
    },
    'studio-outpaint': {
      kind: 'studio',
      state: { ...states.ready, defaultPreset: 'flux2-klein-4b' },
      history: [LIVE_OUTPAINT_SOURCE_ITEM, ...historyItems],
      props: {
        workspaceMode: 'work',
        initialImageTool: 'outpaint',
      },
    },
    'studio-compare': {
      kind: 'studio',
      state: states.ready,
      history: [LIVE_OUTPAINT_RESULT_ITEM, LIVE_OUTPAINT_SOURCE_ITEM, ...historyItems],
      props: {
        workspaceMode: 'work',
        initialCompareOpen: true,
      },
    },
    'studio-refs': {
      kind: 'studio',
      state: {
        ...states.ready,
        defaultPreset: 'flux2-klein-4b',
      },
      history: [LIVE_REF_RESULT_ITEM, ...historyItems],
      props: {
        workspaceMode: 'work',
        initialPrompt: LIVE_REF_RESULT_ITEM.prompt,
        initialReferences: [
          {
            path: 'outputs/live/2026-11-21T12-40-47/01-source-1.png',
            url: `${LIVE_URL}/2026-11-21T12-40-47/01-source-1.png`,
            name: '01-source-1.png',
            width: 1024,
            height: 1024,
          },
          {
            path: 'outputs/live/2026-11-21T12-40-47/01-source-2.png',
            url: `${LIVE_URL}/2026-11-21T12-40-47/01-source-2.png`,
            name: '01-source-2.png',
            width: 1024,
            height: 1024,
          },
        ],
      },
    },
    'studio-dark': {
      kind: 'studio',
      dark: true,
      state: states.ready,
      history: historyItems,
      props: { initialPrompt: HERO_PROMPT },
    },
    'studio-disabled-dark': {
      kind: 'studio',
      dark: true,
      state: states.ready,
      history: [],
    },
    'studio-empty': {
      kind: 'studio',
      state: states.empty,
      history: [],
    },
    'studio-queued': {
      kind: 'studio',
      state: states.queued,
      history: [],
    },
    'studio-queue-two': {
      kind: 'studio',
      state: states.queueTwo,
      history: [],
    },
    'studio-queue-two-dark': {
      kind: 'studio',
      dark: true,
      state: states.queueTwo,
      history: [],
    },
    'studio-pushing': {
      kind: 'studio',
      state: states.pushing,
      history: [],
    },
    'studio-connecting': {
      kind: 'studio',
      state: states.connecting,
      history: [],
    },
    'studio-warming': {
      kind: 'studio',
      state: states.warming,
      history: [],
    },
    'studio-asleep': {
      kind: 'studio',
      state: states.asleep,
      history: historyItems,
    },
    'studio-stopped': {
      kind: 'studio',
      state: states.stopped,
      history: [],
    },
    'studio-guidance': {
      kind: 'studio',
      state: states.guidance,
      history: historyItems,
    },
    'studio-cli': {
      kind: 'studio',
      state: states.cli,
      history: [],
    },
    'gallery-wide': {
      kind: 'gallery',
      state: states.ready,
      history: USER_OUTPUTS.length > 0 ? historyItems : [...historyItems, ...WORKSHOP_HISTORY],
    },
    'gallery-hover': {
      kind: 'gallery',
      state: states.ready,
      history: historyItems,
      hoverSelector: '.ofs-gallery-card',
    },
    'chat-standalone': {
      kind: 'chat',
      state: states.ready,
      history: historyItems,
      messages: CHAT_MESSAGES,
    },
    'chat-composed': {
      kind: 'chat-composed',
      state: states.ready,
      history: historyItems,
      messages: CHAT_MESSAGES,
      selectedItem: CHAT_ITEM,
      selectedImage: CHAT_IMAGE,
    },
    'studio-refine': {
      kind: 'refine',
      state: states.ready,
      history: [],
    },
    'compute-popover': {
      kind: 'compute-popover',
      state: states.ready,
      history: historyItems,
    },
    // 弹层的四个来源分支与等待 / 失败态：对版时逐张看，别只看就绪态。
    'compute-popover-offline': {
      kind: 'compute-popover',
      state: states.empty,
      history: [],
      compute: { sessionState: 'absent' },
    },
    'compute-popover-queued': {
      kind: 'compute-popover',
      state: states.queued,
      history: [],
      compute: { sessionState: 'provisioning' },
    },
    'compute-popover-error': {
      kind: 'compute-popover',
      state: states.cli,
      history: [],
      compute: { sessionState: 'error' },
    },
    'compute-popover-colab': {
      kind: 'compute-popover',
      state: {
        ...states.ready,
        session: { state: 'absent', provider: 'colab', error: null },
        probe: null,
      },
      history: [],
      compute: {
        sessionState: 'absent',
        provider: 'colab',
        colabAuth: { authorized: true, email: 'creator@gmail.com' },
        colabUsage: { balance: 42.5, rate: 2.5, assignments: 0 },
      },
    },
    // 余额读到了、耗速没读到：右侧不能反过来说「还没读出额度」（用户截图里的那个矛盾）。
    'compute-popover-colab-balance': {
      kind: 'compute-popover',
      state: {
        ...states.ready,
        session: { state: 'absent', provider: 'colab', idleTimeoutSec: 1800, error: null },
        probe: null,
      },
      history: [],
      compute: {
        sessionState: 'absent',
        provider: 'colab',
        colabAuth: { authorized: true, email: 'murshroomlite@gmail.com' },
        colabUsage: { balance: 193.5, rate: null, assignments: 0 },
      },
    },
    'compute-popover-worker': {
      kind: 'compute-popover',
      state: {
        ...states.ready,
        session: { state: 'ready', provider: 'private-worker', device: 'NVIDIA RTX 4090', idleTimeoutSec: 1800, error: null },
        probe: null,
      },
      history: [],
      compute: {
        provider: 'private-worker',
        worker: { endpointUrl: 'https://studio-worker.tail1a2b.ts.net', tokenConfigured: true },
      },
    },
    'compute-popover-cloud': {
      kind: 'compute-popover',
      state: {
        ...states.ready,
        session: { state: 'ready', provider: 'siliconflow', error: null },
        probe: null,
      },
      history: [],
      compute: {
        provider: 'cloud-api',
        imageApi: { hasApiKey: true, apiKeysConfigured: ['siliconflow', 'openai'] },
      },
    },
    'compute-popover-dark': {
      kind: 'compute-popover',
      dark: true,
      state: states.ready,
      history: historyItems,
    },
    'rail-open': {
      kind: 'rail',
      state: states.ready,
      history: historyItems,
      refs: false,
    },
    'rail-refs': {
      kind: 'rail',
      state: states.ready,
      history: historyItems,
      refs: true,
    },
    'rail-open-dark': {
      kind: 'rail',
      dark: true,
      state: states.ready,
      history: historyItems,
      refs: false,
    },
    'model-picker': {
      kind: 'studio',
      state: states.ready,
      history: historyItems,
      props: { defaultModelOpen: true, initialPrompt: HERO_PROMPT },
    },
    'model-picker-dark': {
      kind: 'studio',
      dark: true,
      state: states.ready,
      history: historyItems,
      props: { defaultModelOpen: true, initialPrompt: HERO_PROMPT },
    },
    // 运行设置 → 云端算力：SettingsForm 的可见真相（居中弹窗 740×560，内容宽约 512px）。
    'settings-compute': {
      kind: 'settings',
      tab: 'compute',
      settings: {
        provider: 'kaggle',
        accelerator: 'NvidiaTeslaT4',
        idleTimeoutSec: 1800,
        kaggleTransport: 'cli',
        hasHfToken: true,
        hfTokenSource: 'config',
        datasetSources: ['owner/dataset'],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
    },
    'settings-compute-colab': {
      kind: 'settings',
      tab: 'compute',
      settings: {
        provider: 'colab',
        colabGpu: 'T4',
        colabHighRam: false,
        idleTimeoutSec: 1800,
        hasHfToken: true,
        hfTokenSource: 'config',
        datasetSources: [],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
      colabAuth: { authorized: true, email: 'creator@gmail.com' },
      colabLogin: { login: { state: 'done', mode: 'browser', username: 'creator@gmail.com' }, pending: false, busy: false },
    },
    'settings-compute-colab-idle': {
      kind: 'settings',
      tab: 'compute',
      settings: {
        provider: 'colab',
        colabGpu: 'T4',
        colabHighRam: false,
        idleTimeoutSec: 1800,
        hasHfToken: false,
        hfTokenSource: 'none',
        datasetSources: [],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
      colabAuth: { authorized: false, email: null },
      colabLogin: { login: { state: 'idle', mode: 'browser' }, pending: false, busy: false },
    },
    'settings-compute-worker': {
      kind: 'settings',
      tab: 'compute',
      settings: {
        provider: 'private-worker',
        idleTimeoutSec: 1800,
        hasHfToken: false,
        hfTokenSource: 'none',
        datasetSources: [],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
    },
    'settings-compute-dark': {
      kind: 'settings',
      dark: true,
      tab: 'compute',
      settings: {
        provider: 'kaggle',
        accelerator: 'NvidiaTeslaT4',
        idleTimeoutSec: 1800,
        kaggleTransport: 'cli',
        hasHfToken: true,
        hfTokenSource: 'config',
        datasetSources: ['owner/dataset'],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
    },
    'settings-compute-en': {
      kind: 'settings',
      lang: 'en',
      tab: 'compute',
      settings: {
        provider: 'kaggle',
        accelerator: 'NvidiaTeslaT4',
        idleTimeoutSec: 1800,
        kaggleTransport: 'cli',
        hasHfToken: true,
        hfTokenSource: 'config',
        datasetSources: ['owner/dataset'],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
    },
    'settings-compute-cloud-en': {
      kind: 'settings',
      lang: 'en',
      tab: 'compute',
      settings: {
        provider: 'cloud-api',
        idleTimeoutSec: 1800,
        hasHfToken: false,
        hfTokenSource: 'none',
        datasetSources: [],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
      appSettings: {
        imageApi: {
          vendor: 'siliconflow',
          baseUrl: '',
          model: '',
          hasApiKey: true,
          apiKeysConfigured: ['siliconflow', 'openai'],
        },
      },
    },
    'settings-compute-cloud-custom': {
      kind: 'settings',
      tab: 'compute',
      settings: {
        provider: 'cloud-api',
        idleTimeoutSec: 1800,
        hasHfToken: false,
        hfTokenSource: 'none',
        datasetSources: [],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
      appSettings: {
        imageApi: {
          vendor: 'custom',
          baseUrl: 'https://gw.example.com/v1',
          model: 'my-a, my-b',
          hasApiKey: false,
          apiKeysConfigured: [],
        },
      },
    },
    'settings-compute-advanced': {
      kind: 'settings',
      tab: 'compute',
      advanced: true,
      settings: {
        provider: 'kaggle',
        accelerator: 'NvidiaTeslaT4',
        idleTimeoutSec: 1800,
        kaggleTransport: 'cli',
        hasHfToken: true,
        hfTokenSource: 'config',
        datasetSources: ['owner/dataset'],
        localModels: { 'org/repo': '/kaggle/input/repo' },
        pipConstraints: ['diffusers==0.31.0'],
        effectiveOnNextSession: false,
      },
    },
    'settings-compute-cloud': {
      kind: 'settings',
      tab: 'compute',
      settings: {
        provider: 'cloud-api',
        idleTimeoutSec: 1800,
        hasHfToken: false,
        hfTokenSource: 'none',
        datasetSources: [],
        localModels: {},
        pipConstraints: [],
        effectiveOnNextSession: false,
      },
      appSettings: {
        imageApi: {
          vendor: 'siliconflow',
          baseUrl: '',
          model: '',
          hasApiKey: true,
          apiKeysConfigured: ['siliconflow'],
        },
      },
    },
    'settings-appearance': {
      kind: 'settings',
      tab: 'appearance',
      settings: { provider: 'kaggle', idleTimeoutSec: 1800 },
    },
  }
}
