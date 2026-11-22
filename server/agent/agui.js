/**
 * AGUI（Agent-UI）交互工具：把「结构化卡片」变成 Agent 的标准工具。
 *
 * 为什么不做成服务端硬编码分支：
 *  - 模型自己决定「要不要先确认 / 要不要澄清」，工具调用就是决策的落点；
 *  - 工具返回的 `data.ui` 由运行时翻译成 `proposal` / `clarify` SSE 事件，
 *    前端只消费事件，不需要知道是哪个工具产生的。
 *
 * 关键约定：UI 工具执行后本轮必须结束（由运行时在 tool_execution_end 后 finishTurn），
 * 否则模型会在等待用户点击时继续空转、重复调用生成工具，白烧 Token。
 *
 * 工具只做「归一 + 返回卡片数据」，不提交任何 GPU 任务。
 */

import { DEFAULT_PRESET, INTENT, LIMITS, PRESETS, RATIO_IDS, presetById } from '../../shared/contract.js'
import { buildInspectBlocks } from './inspect.js'
import { currentTurnContext } from './turn-context.js'

/** 文生图可选预设（与 `imagen_generate` 的 schema 同口径：剔除 inpaintOnly）。 */
const TEXT_TO_IMAGE_PRESET_IDS = PRESETS.filter((preset) => preset.inpaintOnly !== true).map((preset) => preset.id)

/** 与 `server/tools.js` 同形的文本输出描述（MCP 导出与工具清单检查都要求存在）。 */
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

function textOf(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : ''
  return maxChars ? text.slice(0, maxChars) : text
}

function intOf(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

function clampInt(value, min, max, fallback) {
  const number = intOf(value)
  if (number === null) return fallback
  return Math.min(max, Math.max(min, number))
}

/** 预设 id 归一：非法 / 缺省回落到默认预设。 */
function presetIdOf(value) {
  const id = textOf(value)
  return TEXT_TO_IMAGE_PRESET_IDS.includes(id) ? id : DEFAULT_PRESET
}

/**
 * 澄清维度归一：最多 3 组，每组 1~6 个选项；选项支持字符串或 `{ label, value }`。
 * 全空返回 []（调用方回退到旧版 `options`）。
 */
function normalizeDimensions(value, locale) {
  if (!Array.isArray(value)) return []
  const dimensions = []
  for (const [index, raw] of value.slice(0, 3).entries()) {
    if (!raw || typeof raw !== 'object') continue
    const options = []
    for (const option of Array.isArray(raw.options) ? raw.options.slice(0, 6) : []) {
      const label = typeof option === 'string' ? option : textOf(option?.label || option?.value, INTENT.clarifyOptionMaxChars)
      if (!label) continue
      const optionValue = typeof option === 'string' ? option : textOf(option?.value, INTENT.clarifyOptionMaxChars) || label
      options.push({ label, value: optionValue })
    }
    if (options.length === 0) continue
    dimensions.push({
      id: textOf(raw.id) || `d${index + 1}`,
      label: textOf(raw.label, INTENT.clarifyQuestionMaxChars) || (locale === 'en' ? `Question ${index + 1}` : `问题 ${index + 1}`),
      multi: raw.multi === true,
      options,
    })
  }
  return dimensions
}

/** 旧版选项（扁平字符串）归一：2~4 条去重。 */
function normalizeOptions(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const label = textOf(item, INTENT.clarifyOptionMaxChars)
    if (!label || out.includes(label)) continue
    out.push(label)
    if (out.length >= INTENT.clarifyMaxOptions) break
  }
  return out
}

/**
 * 注册 AGUI 工具与舞台上下文工具。
 *
 * @param {object} registry `server/agent/tools.js` 的 createToolRegistry()
 * @param {{ getStage?: () => object|null, ctx?: object, visionModel?: () => boolean }} [options]
 *   getStage 供独立调用（测试 / 无 turn-context 的场景）覆盖；缺省读本轮上下文。
 *   ctx 供 imagen_inspect 解析产物路径（M3.5 Phase B）；测试不传时用只读兜底。
 *   visionModel 供视觉能力门控的可选覆写；缺省依赖 pi-ai 在 LLM 边界自动门控。
 */
export function registerAguiTools(registry, options = {}) {
  if (!registry || typeof registry.register !== 'function') return

  registry.register({
    name: 'ui_propose_generation',
    description:
      '向用户展示「生图确认卡」：把中文创作思路摘要、英文 Prompt、负向词、模型与张数交给用户确认。' +
      '这是新建 GPU 生图的默认路径——除非用户明确说「直接生成 / 立即出图 / 批量跑 N 张」，否则必须先用本工具提案。' +
      '调用后本轮结束，等待用户点击「按此生成」或「带入参数面板」；不要在等待期间再次调用生成工具。' +
      `展示前请先按需要调用 imagen_recipes 查配方，并从模型目录选择 presetId；prompt 不超过 ${LIMITS.prompt.maxChars} 字符。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: '英文提示词（真正发给扩散模型的内容）' },
        summaryZh: { type: 'string', description: `中文一句话创作思路摘要，不超过 ${INTENT.summaryMaxChars} 字符` },
        negativePrompt: {
          type: 'string',
          description: '可选：英文负向词。仅当所选模型真的消费负向词时填写，否则留空',
        },
        presetId: {
          type: 'string',
          enum: TEXT_TO_IMAGE_PRESET_IDS,
          description: `推荐模型预设 id，默认 ${DEFAULT_PRESET}；具体写法与专长见模型目录`,
        },
        ratioId: { type: 'string', enum: RATIO_IDS, description: '画幅比例；用户没说尺寸时省略' },
        width: { type: 'integer', description: `可选宽度 ${LIMITS.width.min}-${LIMITS.width.max}` },
        height: { type: 'integer', description: `可选高度 ${LIMITS.height.min}-${LIMITS.height.max}` },
        count: { type: 'integer', description: `张数 ${LIMITS.count.min}-${LIMITS.count.max}，默认 1` },
        seed: { type: 'integer', description: '可选：固定种子（仅在用户要求复现构图时填写）' },
        notes: { type: 'string', description: '可选：给用户看的补充说明（中文，最多 200 字）' },
      },
    },
    output: textOutput,
    async execute(args = {}) {
      const prompt = textOf(args.prompt, LIMITS.prompt.maxChars)
      if (!prompt) return { text: '未展示确认卡：prompt 不能为空。请先组织英文提示词后重试。' }
      const presetId = presetIdOf(args.presetId)
      const preset = presetById(presetId)
      const ratioId = RATIO_IDS.includes(textOf(args.ratioId)) ? textOf(args.ratioId) : ''
      const count = clampInt(args.count, LIMITS.count.min, LIMITS.count.max, LIMITS.count.min)
      const width = clampInt(args.width, LIMITS.width.min, LIMITS.width.max, preset?.size || null)
      const height = clampInt(args.height, LIMITS.height.min, LIMITS.height.max, preset?.size || null)
      const seedNumber = intOf(args.seed)
      const seed = seedNumber !== null && seedNumber >= 0 ? seedNumber : null
      const proposal = {
        summaryZh: textOf(args.summaryZh, INTENT.summaryMaxChars),
        prompt,
        negativePrompt: textOf(args.negativePrompt, LIMITS.negativePrompt.maxChars),
        presetId,
        ratioId,
        width,
        height,
        count,
        seed,
        notes: textOf(args.notes, 200),
      }
      return {
        text:
          `已向用户展示生图确认卡（${presetId} · ${count} 张）。` +
          '本轮到此结束：不要重复输出提示词，也不要再次调用生成工具；用户点击「按此生成」后任务会由客户端直接提交。',
        data: { ui: { type: 'proposal', ...proposal }, proposal },
      }
    },
  })

  registry.register({
    name: 'ui_ask_clarify',
    description:
      '向用户展示「澄清卡」：当需求信息缺口很大（主体不明、风格跨度大、用途不明）时，' +
      '给出 1~2 组可点选的维度与选项，避免瞎猜参数直接消耗 GPU。' +
      '调用后本轮结束，等待用户选择；用户选择后会自动作为下一轮输入发回。' +
      '强烈建议同时给出 draft（草稿方案）：用户点「先按当前设置」时可以直接拿到可生成的提案卡。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', description: `澄清问题，不超过 ${INTENT.clarifyQuestionMaxChars} 字符` },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: `兼容旧版的扁平选项（${INTENT.clarifyMinOptions}~${INTENT.clarifyMaxOptions} 条）`,
        },
        dimensions: {
          type: 'array',
          description: '结构化维度（最多 3 组，每组 1~6 个选项）；与 options 二选一，同时给出时以本字段为准',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label', 'options'],
            properties: {
              id: { type: 'string', description: '维度 id，例如 style / lighting' },
              label: { type: 'string', description: '维度标题（中文）' },
              multi: { type: 'boolean', description: '是否允许多选' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['label'],
                  properties: {
                    label: { type: 'string' },
                    value: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        draft: {
          type: 'object',
          description:
            '可选：用户点「先按当前设置」时直接使用的草稿方案（与提案卡同样的字段）。' +
            '给了草稿时，澄清卡底部会把它作为兜底提案，避免用户被反问后拿不到任何方案。',
          additionalProperties: false,
          properties: {
            prompt: { type: 'string', description: '英文提示词（草稿）' },
            summaryZh: { type: 'string', description: '中文一句话摘要' },
            negativePrompt: { type: 'string' },
            presetId: { type: 'string', enum: TEXT_TO_IMAGE_PRESET_IDS },
            ratioId: { type: 'string', enum: RATIO_IDS },
            count: { type: 'integer' },
          },
        },
      },
    },
    output: textOutput,
    async execute(args = {}) {
      const locale = currentTurnContext().locale === 'en' ? 'en' : 'zh'
      const question = textOf(args.question, INTENT.clarifyQuestionMaxChars)
      if (!question) return { text: '未展示澄清卡：question 不能为空。' }
      const dimensions = normalizeDimensions(args.dimensions, locale)
      const options = normalizeOptions(args.options)
      if (dimensions.length === 0 && options.length < INTENT.clarifyMinOptions) {
        return {
          text:
            `未展示澄清卡：至少需要 ${INTENT.clarifyMinOptions} 个去重选项，或 1 组带选项的 dimensions。` +
            '请补齐后重试；若需求已经明确，直接调用 ui_propose_generation。',
        }
      }
      const draftPrompt = textOf(args.draft?.prompt, LIMITS.prompt.maxChars)
      const draft = draftPrompt
        ? {
            prompt: draftPrompt,
            summaryZh: textOf(args.draft?.summaryZh, INTENT.summaryMaxChars),
            negativePrompt: textOf(args.draft?.negativePrompt, LIMITS.negativePrompt.maxChars),
            presetId: presetIdOf(args.draft?.presetId),
            ratioId: RATIO_IDS.includes(textOf(args.draft?.ratioId)) ? textOf(args.draft?.ratioId) : '',
            count: clampInt(args.draft?.count, LIMITS.count.min, LIMITS.count.max, LIMITS.count.min),
          }
        : null
      const clarify = {
        question,
        dimensions: dimensions.length > 0
          ? dimensions
          : [{ id: 'choice', label: question, multi: false, options: options.map((label) => ({ label, value: label })) }],
        options: options.length > 0 ? options : dimensions[0].options.map((option) => option.label),
        ...(draft ? { draft } : {}),
      }
      return {
        text:
          `已向用户展示澄清卡「${question}」，共 ${clarify.dimensions.length} 组维度。` +
          '本轮到此结束：等待用户选择，不要继续调用生成工具。',
        data: { ui: { type: 'clarify', ...clarify }, clarify },
      }
    },
  })

  registry.register({
    name: 'imagen_stage_context',
    description:
      '读取「舞台当前选中作品」的完整信息：路径、所用模型、尺寸、seed 与原始 Prompt。' +
      '用户说「把当前这张图… / 基于这张 / 把它改成…」时先调用本工具确认对象，再决定是提案重绘还是查历史。' +
      '只读，不消耗 GPU；没有选中作品时返回明确说明。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput,
    async execute() {
      const stage = typeof options.getStage === 'function'
        ? options.getStage()
        : currentTurnContext().stage
      if (!stage || typeof stage !== 'object' || !stage.imagePath) {
        return { text: '当前舞台没有选中作品。可以让用户在胶卷 / 画廊里选一张，或直接描述要画的新画面。' }
      }
      const lines = [
        `舞台当前作品：${stage.imagePath}`,
        stage.presetId ? `模型预设：${stage.presetId}` : null,
        Number(stage.width) > 0 && Number(stage.height) > 0 ? `尺寸：${stage.width}×${stage.height}` : null,
        Number.isFinite(Number(stage.seed)) && Number(stage.seed) >= 0 ? `seed：${Math.trunc(Number(stage.seed))}` : null,
        typeof stage.prompt === 'string' && stage.prompt.trim() ? `原始 Prompt：${stage.prompt.trim()}` : null,
      ].filter(Boolean)
      lines.push('需要基于它重绘 / 放大时，把该路径作为参考图或源图传给对应工具（放大用 imagen_upscale）。')
      return { text: lines.join('\n') }
    },
  })

  // M3.5 Phase C：探索确认卡（带硬预算），授权后在预算内自动多轮抽卡并支持随时中止。
  registry.register({
    name: 'ui_propose_explore',
    description:
      '向用户展示「探索方案卡」：当用户要求「多试几个方向挑一张 / 探索式批量抽卡 / 广撒网精修」时，' +
      '给出带硬预算上限的方案（轮数、总张数、预估费用）。用户点击「开始探索」后，运行时会在预算内自动' +
      '推进多轮抽卡，无需每一张都打断确认；达到 maxImages 或用户点「停止生成」立即收敛。' +
      '调用后本轮结束，等待用户授权；不要在等待期间自行调用 imagen_batch / imagen_generate。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['strategy', 'maxRounds', 'maxImages'],
      properties: {
        strategy: {
          type: 'string',
          description: `中文探索策略描述（如「第 1 轮测 4 种构图方向，挑最优 1 张后做 4 张细节变体」），不超过 ${INTENT.exploreStrategyMaxChars} 字符`,
        },
        maxRounds: {
          type: 'integer',
          minimum: INTENT.exploreMaxRoundsMin,
          maximum: INTENT.exploreMaxRoundsMax,
          description: `最多探索轮数（${INTENT.exploreMaxRoundsMin}~${INTENT.exploreMaxRoundsMax}）`,
        },
        maxImages: {
          type: 'integer',
          minimum: INTENT.exploreMaxImagesMin,
          maximum: INTENT.exploreMaxImagesMax,
          description: `硬预算：本次最多生成图片总数（${INTENT.exploreMaxImagesMin}~${INTENT.exploreMaxImagesMax}），达到即停`,
        },
        estCost: {
          type: 'string',
          description: '预估费用文案（中文，如「约 ¥0.3」或「免费 Kaggle · ¥0」），帮助用户判断是否授权',
        },
        presetId: { type: 'string', enum: TEXT_TO_IMAGE_PRESET_IDS, description: '探索使用的模型预设' },
        basePrompt: {
          type: 'string',
          description: '探索的基础英文提示词（各轮变体在此基础上发散，不超过 ' + LIMITS.prompt.maxChars + ' 字符）',
        },
        notes: { type: 'string', description: '可选：给用户看的补充说明（中文，最多 200 字）' },
      },
    },
    output: textOutput,
    async execute(args = {}) {
      const strategy = textOf(args.strategy, INTENT.exploreStrategyMaxChars)
      if (!strategy) return { text: '未展示探索卡：strategy 不能为空。请先描述探索策略后重试。' }
      const maxRounds = clampInt(args.maxRounds, INTENT.exploreMaxRoundsMin, INTENT.exploreMaxRoundsMax, 2)
      const maxImages = clampInt(args.maxImages, INTENT.exploreMaxImagesMin, INTENT.exploreMaxImagesMax, 8)
      const explore = {
        strategy,
        maxRounds,
        maxImages,
        estCost: textOf(args.estCost, INTENT.exploreCostMaxChars),
        presetId: presetIdOf(args.presetId),
        basePrompt: textOf(args.basePrompt, LIMITS.prompt.maxChars),
        notes: textOf(args.notes, 200),
      }
      return {
        text:
          `已向用户展示探索方案卡（${maxRounds} 轮 · 最多 ${maxImages} 张${explore.estCost ? ` · ${explore.estCost}` : ''}）。` +
          '本轮到此结束：不要重复输出策略，也不要自行调用生成工具；用户点击「开始探索」后预算会随请求下发，由运行时强制执行。',
        data: { ui: { type: 'explore', ...explore }, explore },
      }
    },
  })

  // M3.5 Phase B：让具备视觉能力的 LLM 真正"看见"产物，做构图 / 畸变 / 提示词贴合度评估。
  // 纯文本模型无需特殊处理：pi-ai 在 LLM 边界只在 model.input 含 image 时才注入 image 块，
  // 因此这里无条件返回预览块，门控交给底座，避免两处重复判断导致行为漂移。
  registry.register({
    name: 'imagen_inspect',
    description:
      '读取并回看本轮生成的产物图片（支持多张并排评估），用于检查构图主体完整性、肢体 / 文字畸变、' +
      '色彩氛围一致性及提示词元素命中率。仅在批量抽卡后需要"看图挑最优 / 针对性改词"时调用；' +
      '传入 paths（产物相对路径列表，最多 4 张）与可选的 focus（本次关注点）。' +
      '若当前模型不具备视觉能力，图片会被自动忽略，只返回路径与元数据，此时改为依据用户反馈迭代提示词。' +
      '只读，不消耗 GPU。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: INTENT.inspectMaxImages,
          description: `待回看的产物相对路径列表（outputs/ 内，最多 ${INTENT.inspectMaxImages} 张）`,
        },
        focus: {
          type: 'string',
          description: '可选：本次看图重点（如「检查主体是否完整、手部有无畸变」），帮助模型聚焦评估维度',
        },
      },
    },
    output: textOutput,
    async execute(args = {}) {
      const paths = Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === 'string' && item.trim()) : []
      if (paths.length === 0) return { text: '未回看：paths 不能为空，请传入产物相对路径列表。' }
      const { blocks, skipped } = await buildInspectBlocks(options.ctx, paths)
      const focus = textOf(args.focus, 200)
      const lines = [
        `已回看 ${blocks.length} 张产物图（图片内容已附加到本条工具结果，视觉模型可直接评估）。`,
        focus ? `本次关注点：${focus}` : '',
        '评估维度：① 构图主体是否完整、有无裁切；② 肢体 / 文字 / 细节有无明显畸变；③ 提示词元素命中率；④ 色彩与氛围是否一致。',
        '请基于实际画面给出具体缺陷，并给出下一轮针对性的提示词增删建议，而不是笼统换词。',
        ...paths.map((path, index) => `- 图 ${index + 1}：${path}`),
        ...skipped.map((item) => `- 未附加 ${item.path}：${item.reason}`),
      ].filter(Boolean)
      return {
        text: lines.join('\n'),
        // pi-ai 原生 image 块；纯文本模型会在 LLM 边界自动忽略，不额外烧 Token。
        content: blocks,
        data: { inspected: paths, attached: blocks.length, skipped },
      }
    },
  })
}
