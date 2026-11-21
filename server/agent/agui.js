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
 * @param {{ getStage?: () => object|null }} [options]
 *   getStage 供独立调用（测试 / 无 turn-context 的场景）覆盖；缺省读本轮上下文。
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
}
