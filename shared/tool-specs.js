/**
 * Agent / MCP 工具规格的唯一来源：名称、描述与 JSON Schema 参数。
 *
 * 为什么独立成 shared 模块（M3.3）：
 *  - 本地 Agent（`server/tools.js`）与外部 MCP Server（`mcp/server.mjs`）必须看到同一套
 *    工具名与参数边界；两边各抄一份迟早漂移，模型会调用一个「服务端不认识」的参数；
 *  - 本文件只允许纯数据与纯函数（不 import `node:*`、不持有队列/会话），MCP 进程可以
 *    在没有 Electron / 本地服务的情况下直接读它；
 *  - `server/tools.js` 只负责给这些规格附加 `execute`，不重复写描述。
 *
 * 参数边界仍来自 `shared/contract.js` 的 LIMITS（唯一来源）；模型目录来自
 * `shared/models-guide.js`，配方来自 `shared/recipes.js`。
 */

import { DEFAULT_PRESET, LIMITS, PRESETS, UPSCALE, presetById } from './contract.js'
import { LORA_SCALE_BOUNDS, styleLoraCatalogText } from './game-styles.js'
import { modelCatalogText } from './models-guide.js'
import { RECIPES, RECIPE_CATEGORIES, SUBJECT_PLACEHOLDER, searchRecipes } from './recipes.js'

/** 产物目录名（与 `server/paths.js` 的 OUTPUT_DIR 一致；test/tool-specs.mjs 会断言）。 */
const OUTPUT_DIR = 'outputs'

const defaultPreset = presetById(DEFAULT_PRESET)
const sizeLabel = `${defaultPreset.size}²`
// 文生图工具的 presetId 取值域：剔除 inpaintOnly 专用权重（只能带蒙版提交）。
const textToImagePresetIds = PRESETS.filter((preset) => preset.inpaintOnly !== true).map((preset) => preset.id)
const modelCatalog = modelCatalogText({ textToImageOnly: true })
const recipesDefaultLimit = searchRecipes().limit

const generateParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: `画面描述，建议英文，不超过 ${LIMITS.prompt.maxChars} 字符` },
    negativePrompt: {
      type: 'string',
      description:
        '排除项（反向提示词）。只在所选模型真的消费负向词且 CFG > 0 时生效：' +
        'CFG=0 的极速模型或不支持负向词的模型会忽略它（各模型能力见工具说明的模型库），' +
        '需要排除内容时改用正面描述',
    },
    presetId: {
      type: 'string',
      enum: textToImagePresetIds,
      description: `模型预设 id；默认 ${DEFAULT_PRESET}（${sizeLabel}，${defaultPreset.steps} 步，约 ${Math.round(defaultPreset.steadySeconds)} 秒）。具体写法与专长见工具说明的模型库；不确定时保持默认`,
    },
    width: { type: 'integer', description: `宽度 ${LIMITS.width.min}-${LIMITS.width.max}，默认取预设` },
    height: { type: 'integer', description: `高度 ${LIMITS.height.min}-${LIMITS.height.max}，默认取预设` },
    steps: { type: 'integer', description: `采样步数 ${LIMITS.steps.min}-${LIMITS.steps.max}，默认取预设` },
    cfg: { type: 'number', description: `CFG ${LIMITS.cfg.min}-${LIMITS.cfg.max}，默认取预设` },
    seed: { type: 'integer', description: '随机种子，省略则随机' },
    count: { type: 'integer', description: `张数 ${LIMITS.count.min}-${LIMITS.count.max}，默认 ${LIMITS.count.min}` },
    waitSeconds: {
      type: 'integer',
      description: `最多等待多少秒（${LIMITS.waitSeconds.min}-${LIMITS.waitSeconds.max}，默认 ${LIMITS.waitSeconds.default}）。首次生成需要排队与加载模型时可能超时，超时后任务仍在后台继续`,
    },
    saveTo: {
      type: 'string',
      description:
        '可选：把图片同时交付到工作区内的相对路径，例如 docs/assets/hero。' +
        '未写扩展名时自动补 .png；count 大于 1 时按 -01、-02 追加序号；' +
        '只接受相对路径（不允许绝对路径、..、outputs/ 或 .aigc-studio/）。原始归档照常生成在 outputs/',
    },
    variantId: {
      type: 'string',
      description: '可选：模式或精度档位 id（如 auto / full / compact-q4 / quality；切到 quality 时默认步数与 CFG 会自动适配）',
    },
    lora: {
      type: 'object',
      additionalProperties: false,
      description:
        '可选：风格 LoRA（仅支持动态 LoRA 的 FLUX.2 模型且非 cloud-api 时生效）。' +
        '传 { id, scale? } 选内置 LoRA，或传 { repo, weight, scale?, trigger? } 挂载自定义 HF LoRA',
      properties: {
        id: { type: 'string', description: '内置风格 LoRA id（见工具说明中的 LoRA 列表，或 none）' },
        repo: { type: 'string', description: '自定义 Hugging Face 仓库，格式 owner/repo' },
        weight: { type: 'string', description: '自定义权重文件名，必须以 .safetensors 结尾' },
        scale: {
          type: 'number',
          description: `LoRA 强度 ${LORA_SCALE_BOUNDS.min}-${LORA_SCALE_BOUNDS.max}，默认 ${LORA_SCALE_BOUNDS.default}`,
        },
        trigger: { type: 'string', description: '可选触发词，提交时自动前置到提示词开头' },
      },
    },
    references: {
      type: 'array',
      items: { type: 'string' },
      description:
        `可选：1-${LIMITS.referenceImages.maxCount} 张 ${OUTPUT_DIR}/ 内已有作品作为模型原生参考图` +
        '（仅 supportsReference 模型支持，如 flux2-klein-4b；与 reference 单图垫图互斥）。' +
        `每张不超过 ${Math.round((LIMITS.referenceImages.maxBytes / 1024 / 1024) * 10) / 10} MB、只接受 PNG / JPEG；` +
        '参考图只作为图像条件，出图尺寸仍由 width / height 决定',
    },
  },
}

const upscaleParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: {
      type: 'string',
      description:
        `工作区相对的源图路径，必须是 ${OUTPUT_DIR}/ 内的作品，例如 ${OUTPUT_DIR}/20260101-120000-j_1a2b3c4d/01.png。` +
        `源图长边不能超过 ${UPSCALE.maxInputEdge}px（输出长宽固定 ×${UPSCALE.factor}）`,
    },
    waitSeconds: {
      type: 'integer',
      description: `最多等待多少秒（${LIMITS.waitSeconds.min}-${LIMITS.waitSeconds.max}，默认 ${LIMITS.waitSeconds.default}）。超时后任务仍在后台继续`,
    },
    saveTo: {
      type: 'string',
      description:
        '可选：把放大结果同时交付到工作区内的相对路径，例如 docs/assets/hero-upscaled。' +
        '未写扩展名时自动补 .png；只接受相对路径（不允许绝对路径、..、outputs/ 或 .aigc-studio/）。原始归档照常生成在 outputs/',
    },
  },
}

const sessionParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['start', 'stop', 'status'] },
    presetId: { type: 'string', enum: PRESETS.map((preset) => preset.id) },
  },
}

const historyParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      description: `返回条数 ${LIMITS.historyTool.defaultLimit}-${LIMITS.historyTool.maxLimit}，默认 ${LIMITS.historyTool.defaultLimit}`,
    },
  },
}

const cancelParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['jobId'],
  properties: {
    jobId: { type: 'string', description: '要取消的任务 ID（来自 imagen_generate 返回结果）' },
  },
}

const batchItemParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: `画面描述，建议英文，不超过 ${LIMITS.prompt.maxChars} 字符` },
    negativePrompt: {
      type: 'string',
      description:
        '本条任务的排除项（反向提示词）。只在所选模型消费负向词且 CFG > 0 时生效，' +
        '不支持负向词的模型会忽略它；需要排除内容时改用正面描述',
    },
    seed: { type: 'integer', description: '本条任务的随机种子，省略则随机' },
    saveTo: {
      type: 'string',
      description:
        '可选：把本条产物同时交付到工作区内的相对路径，例如 docs/assets/hero。' +
        '未写扩展名时自动补 .png；只接受相对路径（不允许绝对路径、..、outputs/ 或 .aigc-studio/）；多条任务不要使用同一个 saveTo',
    },
  },
}

const batchParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: LIMITS.batch.maxItems,
      items: batchItemParameters,
      description: `任务列表，1-${LIMITS.batch.maxItems} 条；每条独立入队、独立成败，单条失败不影响其余任务`,
    },
    presetId: {
      type: 'string',
      enum: textToImagePresetIds,
      description: `公共模型预设，对全部条目生效；默认 ${DEFAULT_PRESET}（${sizeLabel}，${defaultPreset.steps} 步）。具体写法与专长见 imagen_generate 的模型库`,
    },
    variantId: {
      type: 'string',
      description: '可选：全部条目共用的模式或精度档位 id（如 auto / full / compact-q4 / quality）',
    },
    lora: generateParameters.properties.lora,
    width: { type: 'integer', description: `公共宽度 ${LIMITS.width.min}-${LIMITS.width.max}，默认取预设` },
    height: { type: 'integer', description: `公共高度 ${LIMITS.height.min}-${LIMITS.height.max}，默认取预设` },
    steps: { type: 'integer', description: `公共采样步数 ${LIMITS.steps.min}-${LIMITS.steps.max}，默认取预设` },
    cfg: { type: 'number', description: `公共 CFG ${LIMITS.cfg.min}-${LIMITS.cfg.max}，默认取预设` },
    waitSeconds: {
      type: 'integer',
      description:
        `本次调用的总等待预算（${LIMITS.waitSeconds.min}-${LIMITS.waitSeconds.max} 秒，默认 ${LIMITS.waitSeconds.default}），不是每条任务的单独预算：` +
        '预算用尽后返回已完成与未完成情况，未完成任务仍在后台继续，可用返回的 jobId 配合 imagen_history 轮询',
    },
    references: {
      type: 'array',
      items: { type: 'string' },
      description:
        `可选：全部条目共用的 ${LIMITS.referenceImages.maxCount} 张以内模型原生参考图（${OUTPUT_DIR}/ 内作品路径，仅 supportsReference 模型），` +
        '适合同主角批量分镜；与 reference 单图垫图互斥',
    },
  },
}

const recipesParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keyword: {
      type: 'string',
      description: '风格关键词，例如 日系、赛博霓虹、极简海报；多个词用空格或逗号分隔，需全部命中',
    },
    category: {
      type: 'string',
      enum: RECIPE_CATEGORIES.map((item) => item.id),
      description: `风格分类：${RECIPE_CATEGORIES.map((item) => `${item.id}（${item.label}）`).join('、')}`,
    },
    presetId: {
      type: 'string',
      enum: PRESETS.map((preset) => preset.id),
      description: '按适配的模型预设过滤，例如 anima-turbo-v1.1',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '按标签过滤，需全部命中；标签示例见返回结果',
    },
    limit: {
      type: 'integer',
      description: `返回条数 1-${RECIPES.length}，默认 ${recipesDefaultLimit}`,
    },
  },
}

/** 7 个工具的规格（顺序与 server/tools.js 的注册顺序一致）。 */
export const TOOL_SPECS = Object.freeze([
  Object.freeze({
    name: 'imagen_generate',
    description:
      `在当前算力来源上运行开源文生图模型并出图，图片会保存到工作区 ${OUTPUT_DIR}/ 目录。` +
      '首次调用若远端会话未启动，会自动拉起会话（notebook 型来源可能需要排队 10 分钟以上；长驻 Worker 通常几秒内连上），此时建议 waitSeconds 保持较小并稍后用 imagen_history 查看结果。' +
      '等待超时不影响任务继续执行：返回里的 jobId（形如 j_1a2b3c4d）可配合 imagen_cancel 取消，或用 imagen_history 轮询结果；传入 saveTo 可把图片直接交付到工作区路径。' +
      `需要参考图生成新场景时，把 ${OUTPUT_DIR}/ 内已有作品的路径放进 references（仅支持原生参考的模型）；` +
      '需要风格参考时，先用 imagen_recipes 检索公开的提示词模板，再把模板显式改写进 prompt；工具不会自动追加任何风格后缀。' +
      `\n可用模型（presetId，按专长与提示词写法选择；默认 ${DEFAULT_PRESET}）：\n${modelCatalog}` +
      (styleLoraCatalogText() ? `\n内置风格 LoRA（lora.id，仅支持动态 LoRA 的 FLUX.2 模型）：\n${styleLoraCatalogText()}` : ''),
    parameters: generateParameters,
  }),
  Object.freeze({
    name: 'imagen_upscale',
    description:
      `把工作区 ${OUTPUT_DIR}/ 里已有的一张作品高清放大 ${UPSCALE.factor} 倍（Real-ESRGAN 轻量超分，不加载扩散模型）。` +
      `只支持 PNG / JPEG 且源图长边不超过 ${UPSCALE.maxInputEdge}px；输出作为该作品的派生版本归档到 ${OUTPUT_DIR}/，` +
      '可在 imagen_history 或版本树里看到。' +
      '首次调用若远端会话未启动会自动拉起会话，等待超时不影响任务继续执行：返回里的 jobId 可配合 imagen_history 轮询，或用 imagen_cancel 取消。',
    parameters: upscaleParameters,
  }),
  Object.freeze({
    name: 'imagen_batch',
    description:
      `按一组提示词批量出图（单次 1-${LIMITS.batch.maxItems} 条，适合文章配图、分镜与系列插画）：` +
      '全部条目共享 presetId/width/height/steps/cfg，逐条提交到同一串行队列；每条任务只出 1 张图。' +
      '单条校验不通过或生成失败只影响该条，其余任务照常执行；汇总里给出成功产物的路径与 URL、失败原因、未完成任务 jobId。' +
      'waitSeconds 是本次调用的总等待预算（不是每条任务的预算）：预算用尽后未完成任务仍在后台继续，可用 jobId 配合 imagen_history 轮询，或用 imagen_cancel 取消。' +
      '需要风格参考时，先用 imagen_recipes 检索提示词模板，再把模板显式改写进各条 prompt；工具不会自动追加任何风格后缀。',
    parameters: batchParameters,
  }),
  Object.freeze({
    name: 'imagen_recipes',
    description:
      '只读检索透明风格配方库：按关键词、风格分类、标签或 presetId 查找可读的提示词模板与适配模型。' +
      `配方只返回可见文本（模板里用 ${SUBJECT_PLACEHOLDER} 占位），不会替用户拼接任何样式后缀；` +
      '拿到结果后把模板显式改写进 prompt，再调用 imagen_generate 或 imagen_batch。无匹配时返回可执行的检索建议。',
    parameters: recipesParameters,
  }),
  Object.freeze({
    name: 'imagen_session',
    description:
      '管理远端生图会话：start 连接当前算力来源（notebook 型会拉起 Kernel 并排队，私有 Worker 直接连接；幂等，已就绪则直接返回），stop 释放算力（共享私有 Worker 只断开连接、不关机），status 查看当前状态。',
    parameters: sessionParameters,
  }),
  Object.freeze({
    name: 'imagen_history',
    description: `列出最近生成过的图片（工作区 ${OUTPUT_DIR}/ 下的产物），返回路径与提示词，可用于回填或引用。`,
    parameters: historyParameters,
  }),
  Object.freeze({
    name: 'imagen_cancel',
    description:
      '取消一个已提交的生图任务：排队中的任务立即出队失效；正在生成的任务做合作式停止（当前这张出完后不再生成剩余张数，已出的图仍保留）。jobId 来自 imagen_generate 的返回结果。',
    parameters: cancelParameters,
  }),
])

const BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]))

/** 按名称取工具规格；未知名称返回 null（调用方决定抛错还是跳过）。 */
export function toolSpecOf(name) {
  return BY_NAME.get(String(name ?? '')) ?? null
}

/** 全部工具名（MCP `tools/list` 与一致性测试共用）。 */
export function toolNames() {
  return TOOL_SPECS.map((spec) => spec.name)
}

export { OUTPUT_DIR as TOOL_OUTPUT_DIR }
