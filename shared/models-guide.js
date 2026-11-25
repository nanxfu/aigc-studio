/**
 * 模型知识的统一口径：把 `models/*.json`（经 `shared/contract.js` 的 publicPresets() 下发）
 * 整理成提示词规则、负向词能力、模型用法摘要，供三处复用：
 *
 *  - Host 助手层（`lib/intent.js`、`lib/enhance.js`、`lib/tools.js`）：告诉大模型每款模型
 *    该怎么写提示词、能不能用负向词、适合什么场景；
 *  - Client（`src/logic/preset.js` 等）：决定「排除项」是否展示、提交时是否携带；
 *  - 测试：直接断言规则本身，不必重复抄一份模型事实。
 *
 * 算力来源能力位（`providers`）的判定也收敛在这里（见文件末尾），Host 的意图模型推荐
 * 与 Client 的模型卡 / 生成预检共用同一份口径。
 *
 * 本文件只允许纯数据与纯函数，不得 import `node:*`，也不在这里写死模型清单
 * （唯一来源是 `models/*.json`）。
 */

import { LIMITS, PROVIDER_IDS, PROVIDERS, SETTINGS, WORKSHOP, publicPresets } from './contract.js'

const PROMPT_STYLE_NAMES = {
  danbooru: 'Danbooru 标签',
  natural: '自然语言',
  concise: '简短短语',
}

/** 提示词配方的展示名；未知值回落到「通用英文」。 */
export function promptStyleName(style) {
  return PROMPT_STYLE_NAMES[style] ?? '通用英文'
}

/**
 * 当前模型的提示词书写规则（中文，直接进 system prompt）。
 *
 * 参数来自模型资产的 `promptStyle` 与 `qualityPrefix`，不再由调用方手写分支；
 * 未知配方回落到通用英文要求。
 */
export function promptStyleRule(preset) {
  const style = preset && typeof preset === 'object' && preset.promptStyle ? preset.promptStyle : ''
  const prefix = preset && typeof preset.qualityPrefix === 'string' ? preset.qualityPrefix.trim() : ''
  if (style === 'danbooru') {
    const head = prefix ? `质量词前缀固定为「${prefix}」，写在最前面；` : ''
    return `按 Danbooru 标签风格书写：${head}随后依次是主体、外观、场景、构图、光影，全部是英文逗号分隔的短语，不要写完整句子。`
  }
  if (style === 'natural') {
    const head = prefix ? `先写质量词「${prefix}」，再写画面；` : ''
    return `用英文自然语言段落书写：${head}一到两句完整句子写清主体、环境、光线、材质与镜头。`
  }
  if (style === 'concise') {
    const head = prefix ? `质量词前缀「${prefix}」；` : ''
    return `用简短英文短语书写（约 25 个词以内）：${head}优先主体、场景与光影，避免堆砌形容词与修辞。`
  }
  return '用英文书写，具体、可直接用于文生图。'
}

function effectiveCfgOf(preset, cfg) {
  const value = Number(cfg)
  if (Number.isFinite(value)) return value
  const recommended = Number(preset && preset.cfg)
  return Number.isFinite(recommended) ? recommended : 0
}

/**
 * 当前配置下是否应该使用负向提示词（Host 与 Client 共用，禁止各写一份）。
 *
 * 规则：
 *  1. 预设缺失（旧宿主 / 尚未拿到预设）时只看 `cfg > 0`；
 *  2. 预设声明了 `supportsNegative` 时以它为准；旧宿主预设没有该字段时，
 *     用「`negativeHint` 非空」兜底判断管线是否消费负向词；
 *  3. 必须 `cfg > 0`（CFG=0 的模型会忽略 negative_prompt）；
 *  4. 且满足：模型自带推荐负向词，或用户把 CFG 抬到了推荐值以上。
 *
 * 因此默认 4 步极速模型（cfg=0）与 FLUX.2（管线无 negative_prompt）默认隐藏排除项；
 * 用户主动抬高 CFG 后出现，恢复默认后再次隐藏。
 */
export function negativePromptActive(preset, cfg) {
  const effective = effectiveCfgOf(preset, cfg)
  if (!preset || typeof preset !== 'object') return effective > 0
  const capable = typeof preset.supportsNegative === 'boolean'
    ? preset.supportsNegative
    : typeof preset.negativeHint === 'string' && preset.negativeHint.trim() !== ''
  if (!capable || effective <= 0) return false
  const hint = typeof preset.negativeHint === 'string' ? preset.negativeHint.trim() : ''
  if (hint) return true
  const recommended = Number(preset.cfg)
  return Number.isFinite(recommended) && effective > recommended
}

/**
 * 给大模型的负向词指导（中文一句话）。
 *
 * 关键目的：不要让模型把「不要文字」直译成 `no text` 写进正向提示词——扩散模型里
 * 否定词往往适得其反；无负向能力时应改写为正面视觉描述。
 */
export function negativeGuidance(preset, cfg) {
  if (!preset || typeof preset !== 'object') {
    return '模型信息未知：不要输出 negative，按正面描述书写，用「干净/空旷/无遮挡」这类正面视觉表达排除意图。'
  }
  const limit = LIMITS.negativePrompt.maxChars
  if (preset.supportsNegative !== true) {
    return `该模型管线不接受负向提示词：negative 必须是空字符串，用正面视觉描述表达排除意图（如 clean background、empty street、unobstructed view），不要把 no xxx 写进正向提示词（不超过 ${limit} 字符）。`
  }
  if (!negativePromptActive(preset, cfg)) {
    const effective = effectiveCfgOf(preset, cfg)
    return `当前配置（CFG=${effective}）下负向词不生效：negative 必须是空字符串；用正面视觉描述表达排除意图，不要在正向提示词里写 no xxx。`
  }
  return `当前模型支持负向词：只在用户明确表达「不要 X」时，把对应的英文负面短语写进 negative（逗号分隔，不超过 ${limit} 字符）；用户没有否定诉求时 negative 留空。`
}

function finiteSeconds(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? `${number.toFixed(1)} 秒` : ''
}

/**
 * 算力来源的展示名（提示词目录与测试断言共用，不写死在各个调用点）。
 * 新增来源只需要在这里补一行；未登记的 id 回退原文，不会把目录清空。
 */
const PROVIDER_NAMES = {
  kaggle: 'Kaggle',
  colab: 'Colab',
  'private-worker': '私有 Worker',
  'local-gpu': '本机 GPU',
  'cloud-api': '商业生图 API',
}

/** 单个算力来源的展示名；非法 / 缺失回落到契约默认来源的名字。 */
export function providerDisplayName(provider) {
  return PROVIDER_NAMES[providerIdOf(provider)] ?? providerIdOf(provider)
}

/**
 * 单模型用法摘要（中文一行）。用于 system prompt、Agent 工具描述与测试断言。
 *
 * 例：`SDXL Lightning（sdxl-lightning，SDXL）：4 步极速 · 约 6.2 秒/张 ·
 * 提示词写法：简短短语 · 默认 CFG 0（不使用负向词）· 支持垫图 · 定位：4 步极速出图，平衡画质与耗时`
 *
 * M2.7 起补齐三枚能力标签，让模型只读目录就能判断「能不能接参考图 / 属于哪个算力来源 /
 * 是否受 HF Token 门控」，不必再看客户端状态：
 *  - `支持参考图`：`supportsReference=true`（可把 references 直接交给模型做原生条件）；
 *  - `仅 Colab` / `仅 Kaggle`：只声明了一种算力来源的限制；
 *  - `需 HF Token`：`gated=true`，Token 未配置时提交必然 401。
 */
export function modelUsageLine(preset) {
  if (!preset || typeof preset !== 'object' || !preset.id) return ''
  const label = preset.label || preset.id
  const family = preset.family ? `，${preset.family}` : ''
  const seconds = finiteSeconds(preset.steadySeconds)
  const description = preset.description && (preset.description.zh || preset.description.en)
  const cfg = Number(preset.cfg)
  const cfgText = Number.isFinite(cfg) ? `${cfg}` : '—'
  const negative = preset.supportsNegative === true
    ? (negativePromptActive(preset, cfg) ? '可用负向词' : '负向词默认留空')
    : '不支持负向词'
  const restriction = presetProviderRestrictionOf(preset)
  const parts = [
    `${label}（${preset.id}${family}）`,
    `${preset.steps ?? '—'} 步`,
    seconds ? `约 ${seconds}/张` : '',
    `提示词写法：${promptStyleName(preset.promptStyle)}`,
    `默认 CFG ${cfgText}（${negative}）`,
    preset.supportsImg2Img === true ? '支持垫图' : '',
    preset.supportsReference === true ? '支持参考图' : '',
    restriction ? `仅 ${providerDisplayName(restriction)}` : '',
    preset.gated === true ? '需 HF Token' : '',
    description ? `定位：${description}` : '',
  ].filter(Boolean)
  return `- ${parts.join(' · ')}`
}

/**
 * 全部模型的一行摘要（每行一个，供 system prompt / 工具描述直接拼接）。
 *
 * options 缺省时不过滤（行为与改造前逐字一致）；过滤开关互相独立：
 *  - `textToImageOnly`：剔除 `inpaintOnly` 专用局部重绘权重——它只能带蒙版提交，
 *    主表单也不可选，出现在文生图目录里只会诱导模型选一个注定失败的目标；
 *  - `providers`：已配置凭据的算力来源集合（M2.7）。保留「至少能在其中一个来源运行」
 *    的模型，让目录跨后端可见（「仅 Colab」标签由 modelUsageLine 标注）；
 *  - `provider`：单个算力来源 id（旧调用口径），优先级别低于 `providers`；
 *  - `presets`：仅测试注入用；缺省取 `publicPresets()`（唯一数据来源）。
 *
 * @param {{ textToImageOnly?: boolean, provider?: string, providers?: string[],
 *           presets?: Array<object> }} [options]
 */
export function modelCatalogText(options = {}) {
  const source = Array.isArray(options.presets) ? options.presets : publicPresets()
  const configured = Array.isArray(options.providers)
    ? options.providers.filter((id) => PROVIDER_IDS.includes(id))
    : []
  const provider = configured.length > 0
    ? null
    : (options.provider === undefined ? null : providerIdOf(options.provider))
  return source
    .filter((preset) => !(options.textToImageOnly === true && (preset.inpaintOnly === true || preset.mediaType === 'video')))
    .filter((preset) => (
      configured.length > 0
        ? presetAvailableForProviders(preset, configured)
        : provider === null || presetAvailableForProvider(preset, provider)
    ))
    .map(modelUsageLine)
    .filter(Boolean)
    .join('\n')
}

// ---- 算力来源能力位（providers，shared 唯一判定口径） ----------------------
//
// 模型资产的可选字段 `providers` 声明「这个模型能在哪些远端后端上跑」：
//  - 缺省 / 空数组 / 声明值全部在契约白名单外：**除商业生图 API 外**的全部来源都支持
//    （历史资产与旧宿主预设保持既有语义，不误伤；真正的资产错误由
//    `tools/build-assets.mjs` 构建期拒绝）；
//  - 显式声明：只保留契约 `PROVIDER_IDS`（全部已知来源）里的取值。
//    注意：判定的域是「已知来源」而不是 `SETTINGS.providers`（当前可选来源）——
//    私有 Worker 的显存可能比免费卡大，不能因为它暂时没开放选择就被判成不可用。
//
// 为什么缺省不包含 cloud-api（M3.5）：`models/*.json` 描述的是本地 diffusers 管线，
// 商业 API 需要单独的厂商模型 id 与请求协议，由 `shared/image-providers.js` 生成
// `providers: ['cloud-api']` 的云端预设。若缺省也算「支持 cloud-api」，本地 7 个模型
// 会在商业 API 下显示为可选，选中后必然失败。
// Host（意图模型推荐）与 Client（模型卡置灰、生成预检）共用这一份判定；
// `src/logic/preset.js` 只做薄 re-export，不再维护第二套实现。

/** 本地 diffusers / Worker 型来源（缺省可用的集合，不含商业 API）。 */
const LOCAL_PROVIDER_IDS = PROVIDER_IDS.filter((id) => PROVIDERS[id]?.kind !== 'cloud-api')
/**
 * 缺省来源：本地模型默认可在 Kaggle / Colab / 私有 Worker 上运行。
 *
 * `local-gpu` 必须由模型显式声明：它加载的是本机 GGUF 文件，与 daemon 的
 * diffusers pipeline 不是同一套权重；把「未声明来源」的模型默认放给本机 GPU，
 * 会出现「界面写 SDXL Lightning、实际跑 RealVisXL」的静默错配。
 */
const DEFAULT_PROVIDER_IDS = LOCAL_PROVIDER_IDS.filter((id) => id !== 'local-gpu')

/** 归一算力来源 id：非法 / 缺失回退契约默认来源（当前是 kaggle）。 */
export function providerIdOf(provider) {
  return PROVIDER_IDS.includes(provider) ? provider : SETTINGS.defaultProvider
}

/**
 * 预设可用的算力来源（始终非空，返回值是新数组）。
 *
 * @param {object} preset 预设（可含 `providers`）
 * @returns {Array<string>} 契约 `PROVIDER_IDS` 取值域内的来源 id
 */
export function presetProvidersOf(preset) {
  const raw = preset && Array.isArray(preset.providers) ? preset.providers : []
  const allowed = []
  for (const id of raw) {
    if (PROVIDER_IDS.includes(id) && !allowed.includes(id)) allowed.push(id)
  }
  return allowed.length > 0 ? allowed : [...DEFAULT_PROVIDER_IDS]
}

/**
 * 当前算力来源能否运行该预设。
 *
 * `provider` 非法（旧宿主 / 拼写错误 / 设置未就绪）时按契约默认来源判断，
 * 不会因为一个脏值把模型全部判成不可用。
 *
 * @param {object} preset 预设
 * @param {unknown} provider 当前算力来源 id
 * @returns {boolean}
 */
export function presetAvailableForProvider(preset, provider) {
  return presetProvidersOf(preset).includes(providerIdOf(provider))
}

/** 预设是否支持模型原生参考图（Agent 选模与客户端预检共用同一判定）。 */
export function supportsReferenceOf(preset) {
  return Boolean(preset && typeof preset === 'object' && preset.supportsReference === true)
}

/**
 * 预设是否能在「已配置凭据的算力来源集合」里至少跑一个。
 *
 * 空集合 / 全非法值按「不过滤」处理（与旧行为一致，避免旧宿主把目录清空）；
 * 只有所有声明来源都不在集合里时才判定不可用。
 *
 * @param {object} preset 预设
 * @param {unknown} providers 已配置来源 id 列表
 * @returns {boolean}
 */
export function presetAvailableForProviders(preset, providers) {
  const list = (Array.isArray(providers) ? providers : [])
    .filter((id) => PROVIDER_IDS.includes(id))
  if (list.length === 0) return true
  return presetProvidersOf(preset).some((id) => list.includes(id))
}

/**
 * 预设的算力来源限制：只支持一种来源时返回该来源 id（界面据此显示「仅 Colab」），
 * 缺省 / 两种都支持时返回空串。
 *
 * @param {object} preset 预设
 * @returns {''|'kaggle'|'colab'|'salad'|'private-worker'|'local-gpu'|'cloud-api'} 单一来源 id；多来源/无限制返回空串
 */
export function presetProviderRestrictionOf(preset) {
  const list = presetProvidersOf(preset)
  return list.length === 1 ? list[0] : ''
}

/**
 * 步数控制模式（按模型类型分治）：
 *  - 'range'：多步可调模型（usable 且声明了完整 stepRange），前端展示连续滑块与三档刻度；
 *  - 'fixed'：蒸馏 / 极速锁步模型（fast 或未声明 stepRange），前端锁定为模型推荐步数。
 */
export function stepModeOf(preset) {
  const r = preset && typeof preset === 'object' ? preset.stepRange : null
  if (
    preset &&
    preset.tier === 'usable' &&
    r &&
    typeof r === 'object' &&
    Number.isFinite(Number(r.min)) &&
    Number.isFinite(Number(r.max)) &&
    Number.isFinite(Number(r.fast)) &&
    Number.isFinite(Number(r.balanced)) &&
    Number.isFinite(Number(r.fine)) &&
    Number(r.min) < Number(r.max)
  ) {
    return 'range'
  }
  return 'fixed'
}

/**
 * 当前步数所属的语义档位（用于滑块实时标签与刻度高亮）：
 *  - 'fixed'：锁步模型；
 *  - 'fast' / 'balanced' / 'fine'：较快 / 均衡 / 精绘。
 */
export function stepTierOf(preset, steps) {
  if (stepModeOf(preset) !== 'range') return 'fixed'
  const r = preset.stepRange
  const val = Number(steps)
  if (!Number.isFinite(val)) return 'balanced'
  const fastMid = (Number(r.fast) + Number(r.balanced)) / 2
  const fineMid = (Number(r.balanced) + Number(r.fine)) / 2
  if (val < fastMid) return 'fast'
  if (val <= fineMid) return 'balanced'
  return 'fine'
}

/**
 * OOM / 显存报错后的安全重置参数补丁：回退到当前选中预设自身的默认安全参数
 * （而不是硬编码成 1024 / 4 步 / CFG 1，以免把 RealVis 等多步模型打成 4 步半成品噪点图）。
 */
export function safeResetPatch(preset) {
  const rawSize = Number(preset?.size)
  const size = Number.isFinite(rawSize) && rawSize > 0
    ? Math.min(Math.max(Math.round(rawSize / LIMITS.width.step) * LIMITS.width.step, LIMITS.width.min), LIMITS.width.max)
    : 1024
  const rawSteps = Number(preset?.steps)
  const steps = Number.isFinite(rawSteps)
    ? Math.min(Math.max(Math.round(rawSteps), LIMITS.steps.min), LIMITS.steps.max)
    : 4
  const rawCfg = Number(preset?.cfg)
  const cfg = Number.isFinite(rawCfg)
    ? Math.min(Math.max(rawCfg, LIMITS.cfg.min), LIMITS.cfg.max)
    : 1
  return { width: size, height: size, steps, cfg }
}

// ── 工坊场景标签（M4.2c）────────────────────────────────────────────────

/**
 * 预设声明的工坊场景标签（`models/*.json` 的可选字段 `sceneTags`）。
 *
 * 语义只有一条：这款模型天生擅长出哪类作品。工坊感知层把它当**加分先验**
 * （见 `web/logic/workshopPerception.js` 的 `scorePresetSignal`），既不参与推理，
 * 也不改变任何请求体。旧宿主下发的预设没有该字段，统一返回空数组，调用方不必判空。
 *
 * @param {object|null|undefined} preset 预设对象
 * @returns {string[]} 命中契约场景白名单的标签（去重、保序）
 */
export function presetSceneTags(preset) {
  const raw = preset && Array.isArray(preset.sceneTags) ? preset.sceneTags : []
  const seen = new Set()
  for (const tag of raw) {
    if (typeof tag === 'string' && WORKSHOP.scenes.includes(tag)) seen.add(tag)
  }
  return [...seen]
}
