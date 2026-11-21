/**
 * 提示词润色与英译：
 *  - refine（initial / refresh）：按当前模型配方重写/精炼英文主稿，并生成 2~3 组
 *    与当前画面强相关的动态微调方向；
 *  - refine（merge）：将用户在抽屉里多选的微调方向按模型句法自然揉合进当前提示词；
 *  - translate：忠实直译成英文提示词，不扩写、不加戏。
 *
 * 思考档位：润色与揉合优先选用 `low` 档位（模型不支持时安全降级），保证语义重组
 * 质量与延迟平衡；英译保持最低可用档位。
 *
 * 未配置模型时明确返回 `source: 'local'` + `note: 'llm_unconfigured'`，由前端弹出
 * 气泡框引导用户前往设置页；已配置但调用失败时返回 `note: 'llm_unavailable'`，
 * 绝不破坏用户原有提示词或用硬编码词表假装润色成功。
 */

import { LIMITS, presetById } from '../shared/contract.js'
import { modelUsageLine, negativeGuidance, promptStyleRule } from '../shared/models-guide.js'
import { extractJsonObject } from './json.js'
import { hasConfiguredLlm, invokeLlm } from './llm.js'
import { createLogger } from './log.js'

const log = createLogger({ scope: 'enhance' })

const LOCALE_NAME = { zh: '中文', en: 'English' }

/** 润色与微调揉合优先使用 `low` 思考档位，不支持时按顺序降级。 */
const REFINE_REASONING_EFFORTS = ['low', 'minimal', 'off']

const FALLBACK_DIMENSION_LABELS = {
  zh: {
    lighting: '光影',
    material: '材质',
    composition: '构图',
    atmosphere: '氛围',
    camera: '镜头视角',
    detail: '画面细节',
    style: '风格媒介',
  },
  en: {
    lighting: 'Light',
    material: 'Material',
    composition: 'Composition',
    atmosphere: 'Mood',
    camera: 'Camera',
    detail: 'Detail',
    style: 'Medium',
  },
}

/** 按 id 取预设；空值或未知 id 返回 null（不把默认预设当成「用户指定的模型」）。 */
function presetOf(id) {
  const requested = typeof id === 'string' ? id.trim() : ''
  if (!requested) return null
  const preset = presetById(requested)
  return preset && preset.id === requested ? preset : null
}

/** 补齐模型配方对应的严格书写边界，避免自然语言模型退化成标签堆砌。 */
function styleStrictLine(preset) {
  const style = preset && typeof preset === 'object' ? preset.promptStyle : ''
  if (style === 'natural') {
    return '句法要求：必须输出 1~2 句连贯自然的英文完整句子，把光线、视角与材质揉进句法里，禁止写成逗号堆叠的 tag 串。'
  }
  if (style === 'danbooru') {
    return '句法要求：必须输出英文逗号分隔的有序 tag 短语，遵循质量前缀 → 主体 → 外观动作 → 场景 → 构图光影，禁止写完整句子。'
  }
  if (style === 'concise') {
    return '句法要求：必须输出凝练的英文短语（约 25 词以内），只抓核心视觉锚点，禁止堆砌形容词与空泛修辞。'
  }
  return '句法要求：用具体、可直接用于文生图的英文画面描述书写。'
}

/** 模型能力带来的书写口径：速度档位、提示词配方与负向词能力都来自模型资产。 */
function modelGuidance(preset, cfg) {
  if (!preset) {
    return [
      '当前模型未知：用英文书写，优先具体、可感的视觉维度，避免空泛质量词与否定式短语（不要写 no xxx）。',
    ]
  }
  const effectiveCfg = Number.isFinite(Number(cfg)) ? Number(cfg) : preset.cfg
  const tierLine =
    preset.tier === 'fast'
      ? `该模型是快速档（${preset.steps} 步）：表达要聚焦精准，优先主体结构与光影主基调，不要堆砌冗长修辞。`
      : `该模型是多步质量档（${preset.steps} 步，当前 CFG ${effectiveCfg}）：可以刻画更丰富的材质、光影层次与镜头语言。`
  return [
    `当前模型：${modelUsageLine(preset).replace(/^-\s*/, '')}`,
    `书写规则：${promptStyleRule(preset)}`,
    styleStrictLine(preset),
    tierLine,
    negativeGuidance(preset, effectiveCfg),
  ]
}

/** 初次润色 / 换一批建议的 system prompt。 */
function refineSystemPrompt(locale, preset, cfg, { refresh = false } = {}) {
  const uiLanguage = LOCALE_NAME[locale] ?? LOCALE_NAME.zh
  const lines = [
    '【身份与任务】',
    '你是专业文生图提示词顾问。用户会给出一句画面描述（可能是中文短句、中英混杂或已有的英文草稿）。',
    '请同时完成两件事：',
    '1. prompt：重写或精炼后的完整英文提示词，可直接用于当前绘图模型出图；',
    `2. groups：2~3 组与当前画面题材强相关的动态微调建议（每组 2~3 个方向胶囊），供用户勾选后进一步融入。`,
    '',
    '【模型配方与能力】',
    ...modelGuidance(preset, cfg),
    '',
    '【润色与发散准则】',
    '- 忠实原意主体与核心元素：把模糊意象具象为可感的光线、动作、环境互动与材质，不要擅自替换主体或凭空编造无关人物/剧情。',
    '- 禁绝空泛质量词轰炸（如 masterpiece, best quality, 8k, ultra detailed），除非当前模型规则要求写 qualityPrefix。',
    '- 如果用户原句已经较长且完整，优先精炼去冗、修顺句式并对齐当前模型风格，不要越改越臃肿。',
    '- groups 维度不要机械套用固定分类！请从当前画面题材出发，自主挑选 2~3 个最有启发性的调整维度（如人物的「神态动作 / 镜头景别 / 光影情绪」，山水的「墨韵留白 / 气候氛围 / 构图远近」等）。',
    `- 每组带一个简短英文 slug 字段 dimension、一个 ${uiLanguage} 标题 label（中文不超过 6 字），以及 2~3 条 options。`,
    `- 每条 option 含两部分：text 是具体英文视觉意象（不超过 10 词），label 是给用户看的 ${uiLanguage} 短标签（中文不超过 12 字），一眼看懂效果。`,
    '- 建议应彼此有明显差异，且不要简单重复主稿里已经写满的常规描述。',
  ]
  if (refresh) {
    lines.push('- 【换一批】用户希望看到新的微调灵感：请保留画面核心主体，提供一组与常规思路不同、更有新意的视角、光线或风格化方向建议。')
  }
  lines.push(
    '',
    '【输出格式】',
    '只输出一个 JSON 对象，不要解释、不要编号、不要 Markdown 代码围栏：',
    `{"prompt":"英文提示词","groups":[{"dimension":"camera","label":"镜头视角","options":[{"text":"low-angle shot looking up","label":"低机位仰拍"}]}]}`,
  )
  return lines.join('\n')
}

/** 多选微调揉合的 system prompt。 */
function mergeSystemPrompt(preset, cfg) {
  return [
    '【身份与任务】',
    '你是专业文生图提示词编辑。用户会提供当前的英文提示词以及 1 条或多条选中的微调方向。',
    '请把这些微调意图自然、无缝地揉合进当前提示词中，输出修改后的完整英文提示词。',
    '',
    '【模型配方与能力】',
    ...modelGuidance(preset, cfg),
    '',
    '【揉合原则】',
    '- 严格按照目标模型的句法规则改写融合：自然语言模型应调整句子主谓或从句使其流畅连贯；标签模型应插入合适位置并去重；极速简短模型应精炼替换避免超长。',
    '- 禁止只是生硬地在原句末尾用逗号拼接！如新方向与原句某局部冲突（例如原句是平视、微调选了仰拍，或换了时段光线），应自然替换旧局部使画面自洽。',
    '- 完整保留原句的主体与未被修改的细节，不要丢掉用户原有的核心设定。',
    '',
    '【输出格式】',
    '只输出一个 JSON 对象，不要解释、不要 Markdown 代码围栏：',
    '{"prompt":"融合后的完整英文提示词"}',
  ].join('\n')
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanSlug(raw, index) {
  const cleaned = textOf(raw).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || `group-${index + 1}`
}

function defaultGroupLabel(dimension, locale) {
  const dict = FALLBACK_DIMENSION_LABELS[locale === 'en' ? 'en' : 'zh']
  return dict[dimension] || dimension
}

/** 把模型给的一条建议归一成 { text, label }；text 为空则丢弃。 */
function readOption(value) {
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? { text, label: text } : null
  }
  if (!value || typeof value !== 'object') return null
  const text = textOf(value.text)
  if (!text) return null
  return { text, label: textOf(value.label) || text }
}

/** 归一动态维度建议列表，最多保留 4 组、每组最多 3 条。 */
function parseGroups(rawList, locale) {
  if (!Array.isArray(rawList)) return []
  const groups = []
  const seenDimensions = new Set()
  for (let i = 0; i < rawList.length; i += 1) {
    const entry = rawList[i]
    if (!entry || typeof entry !== 'object') continue
    const dimension = cleanSlug(entry.dimension || entry.label, i)
    if (seenDimensions.has(dimension)) continue
    const options = (Array.isArray(entry.options) ? entry.options : [])
      .map(readOption)
      .filter(Boolean)
      .slice(0, 3)
    if (options.length === 0) continue
    seenDimensions.add(dimension)
    const label = textOf(entry.label) || defaultGroupLabel(dimension, locale)
    groups.push({
      dimension,
      label,
      options: options.map((item, idx) => ({
        id: `model-${dimension}-${idx}`,
        text: item.text,
        label: item.label,
      })),
    })
    if (groups.length >= 4) break
  }
  return groups
}

/** 解析首次润色/换一批返回的 `{ prompt, groups }`。 */
function parseRefineResponse(raw, locale) {
  const parsed = extractJsonObject(raw)
  if (!parsed || typeof parsed !== 'object') return null

  const prompt = textOf(parsed.prompt).slice(0, LIMITS.prompt.maxChars)
  const rawGroups = Array.isArray(parsed.groups)
    ? parsed.groups
    : Array.isArray(parsed)
      ? parsed
      : []
  const groups = parseGroups(rawGroups, locale)

  if (!prompt && groups.length === 0) return null
  return { prompt, groups }
}

/** 归一单条文本输出（英译及揉合纯文本兜底共用）。 */
function normalizeSinglePrompt(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return ''
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  text = firstLine.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim()
  return text.slice(0, LIMITS.prompt.maxChars)
}

/** 解析微调揉合返回的 `{ prompt }`。 */
function parseMergeResponse(raw) {
  const parsed = extractJsonObject(raw)
  if (parsed && typeof parsed === 'object') {
    const prompt = textOf(parsed.prompt).slice(0, LIMITS.prompt.maxChars)
    if (prompt) return prompt
  }
  return normalizeSinglePrompt(raw)
}

/**
 * 英译模式的 system prompt（`mode: 'translate'`）。
 *
 * 只做「中文描述 → 英文提示词」的转写，不扩写画面：九个预设都按英文提示词训练，
 * 多出来的风格词/质量词会改变构图，所以明确要求不加戏。
 */
function translateSystemPrompt() {
  return [
    '你是文生图提示词的翻译助手：把用户给出的画面描述转写成英文提示词。',
    '只输出英文提示词本身，不解释、不编号、不加引号、不要输出 JSON 或 Markdown。',
    '保留原意与画面主体，不要加戏：不要添加原文没有的元素、风格词或质量词。',
    '原文已经是英文时原样输出。',
  ].join('\n')
}

/**
 * 英译：复用宿主已配置的模型。
 *
 * 未配置模型返回 `note: 'llm_unconfigured'`，已配置但调用失败返回 `note: 'llm_unavailable'`，
 * `prompt` 返回原文——绝不把原文伪装成翻译成功。空输入返回空 prompt + note 'empty'。
 */
async function translatePrompt(ctx, text) {
  if (!text) return { source: 'local', prompt: '', note: 'empty' }
  if (!hasConfiguredLlm(ctx)) {
    log.info(`translate_unconfigured promptLen=${text.length}`)
    return { source: 'local', prompt: text, note: 'llm_unconfigured' }
  }

  const raw = await invokeLlm(ctx, {
    prompt: text,
    systemPrompt: translateSystemPrompt(),
    log,
    maxTokens: 600,
    purpose: 'imagen-prompt-translate',
    fallbackMessage: '翻译模型不可用，退回原文并标记 llm_unavailable',
  })
  const translated = normalizeSinglePrompt(raw)
  if (!translated) {
    log.info(`translate_fallback reason=llm_unavailable promptLen=${text.length}`)
    return { source: 'local', prompt: text, note: 'llm_unavailable' }
  }
  log.info(`translate_done promptLen=${text.length} translatedLen=${translated.length}`)
  return { source: 'model', prompt: translated }
}

/** 多选微调揉合：将勾选的微调方向自然融入当前提示词。 */
async function mergeRefinePrompt(ctx, text, { preset, cfg, tweaks }) {
  if (!hasConfiguredLlm(ctx)) {
    log.info(`merge_unconfigured promptLen=${text.length}`)
    return { source: 'local', prompt: text, groups: [], note: 'llm_unconfigured' }
  }

  const userLines = [
    `当前提示词：${text}`,
    '需要融入的微调方向：',
    ...tweaks.map((item, index) => `${index + 1}. ${item}`),
  ]
  const raw = await invokeLlm(ctx, {
    prompt: userLines.join('\n'),
    systemPrompt: mergeSystemPrompt(preset, cfg),
    log,
    maxTokens: 700,
    purpose: 'imagen-prompt-refine-merge',
    reasoningEfforts: REFINE_REASONING_EFFORTS,
    fallbackMessage: '微调揉合失败，保留原提示词并标记 llm_unavailable',
  })
  const merged = parseMergeResponse(raw)
  if (!merged) {
    log.info(`merge_fallback reason=llm_unavailable promptLen=${text.length}`)
    return { source: 'local', prompt: text, groups: [], note: 'llm_unavailable' }
  }
  log.info(`merge_done promptLen=${text.length} mergedLen=${merged.length} tweaks=${tweaks.length}`)
  return { source: 'model', prompt: merged }
}

/**
 * @param {object} ctx 宿主上下文
 * @param {string} prompt 画面描述
 * @param {{
 *   locale?: 'zh'|'en',
 *   presetId?: string,
 *   cfg?: number,
 *   mode?: 'refine'|'translate',
 *   action?: 'initial'|'refresh'|'merge',
 *   tweaks?: string[],
 * }} [options]
 * @returns {Promise<{
 *   source: 'model'|'local',
 *   prompt: string,
 *   groups?: Array<{dimension: string, label?: string, options: Array<{id: string, text: string, label: string}>}>,
 *   note?: string,
 * }>}
 */
export async function enhancePrompt(ctx, prompt, options = {}) {
  const text = String(prompt ?? '').trim().slice(0, LIMITS.prompt.maxChars)
  const mode = options.mode === 'translate' ? 'translate' : 'refine'
  if (mode === 'translate') return translatePrompt(ctx, text)

  const locale = options.locale === 'en' ? 'en' : 'zh'
  if (!text) return { source: 'local', prompt: '', groups: [], note: 'empty' }

  const preset = presetOf(options.presetId)
  const tweaks = Array.isArray(options.tweaks)
    ? options.tweaks.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean).slice(0, 12)
    : []
  const action = options.action === 'refresh'
    ? 'refresh'
    : options.action === 'merge' || tweaks.length > 0
      ? 'merge'
      : 'initial'

  if (action === 'merge' && tweaks.length > 0) {
    return mergeRefinePrompt(ctx, text, { preset, cfg: options.cfg, tweaks })
  }

  if (!hasConfiguredLlm(ctx)) {
    log.info(`refine_unconfigured promptLen=${text.length}`)
    return { source: 'local', prompt: text, groups: [], note: 'llm_unconfigured' }
  }

  const raw = await invokeLlm(ctx, {
    prompt: `画面描述：${text}`,
    systemPrompt: refineSystemPrompt(locale, preset, options.cfg, { refresh: action === 'refresh' }),
    log,
    maxTokens: 1000,
    purpose: 'imagen-prompt-refine',
    reasoningEfforts: REFINE_REASONING_EFFORTS,
    fallbackMessage: '润色模型调用失败，保留原文并标记 llm_unavailable',
  })
  const parsed = parseRefineResponse(raw, locale)
  if (!parsed) {
    log.info(`refine_fallback reason=llm_unavailable promptLen=${text.length}`)
    return { source: 'local', prompt: text, groups: [], note: 'llm_unavailable' }
  }

  // refresh 允许模型只返回新 groups 而沿用当前 prompt；initial 要求必须有改写后 prompt。
  const nextPrompt = parsed.prompt || (action === 'refresh' ? text : '')
  if (!nextPrompt) {
    log.info(`refine_fallback reason=empty_prompt promptLen=${text.length}`)
    return { source: 'local', prompt: text, groups: [], note: 'llm_unavailable' }
  }

  log.info(`refine_done action=${action} promptLen=${text.length} outLen=${nextPrompt.length} groups=${parsed.groups.length}`)
  return {
    source: 'model',
    prompt: nextPrompt,
    groups: parsed.groups,
  }
}
