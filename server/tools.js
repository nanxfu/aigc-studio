/**
 * DSH Agent 工具注册：
 * imagen_generate / imagen_batch / imagen_recipes / imagen_session / imagen_history /
 * imagen_cancel / imagen_upscale。
 *
 * 这里只放「给模型看的描述 + 执行 + 文案」；宿主入口 index.js 只负责装配。
 * 工具参数边界取自 `shared/contract.js` 的 LIMITS（唯一来源）；
 * 风格配方数据来自 `shared/recipes.js`，工具只读检索，不替用户拼接样式后缀。
 *
 * 扩图的 Agent 工具（imagen_outpaint）本轮不接：扩图画布需要像素级的「等比缩放 + 居中 +
 * 白边蒙版」合成，而 Host 保持零图像依赖（不引入 sharp / jimp）；这部分逻辑已经在客户端
 * `src/logic/outpaint.js` 与 OutpaintEditor 里实现，用户从舞台动作坞提交即可。Agent 侧
 * 若要扩图，需要客户端先把画布导出成参考图，超出本轮范围（见 docs/SPEC.md 的评估结论）。
 */

import { readFile } from 'node:fs/promises'

import { LIMITS, PRESETS, PROVIDERS, UPSCALE } from '../shared/contract.js'
import { promptStyleName } from '../shared/models-guide.js'
import {
  RECIPES,
  RECIPE_CATEGORIES,
  SUBJECT_PLACEHOLDER,
  categoryLabelOf,
  searchRecipes,
  templateFor,
} from '../shared/recipes.js'
import { toolSpecOf } from '../shared/tool-specs.js'
import { parseImageHeader } from './image-meta.js'
import { scanHistory } from './output.js'
import { OUTPUT_DIR, resolveOutputPath, resolveWorkspaceWritePath } from './paths.js'
import { DEFAULT_PRESET, presetById } from './presets.js'
import { toInt } from './route-kit.js'

/** 把 job 折叠成一段给模型看的文字。 */
export function describeJob(job) {
  if (!job) return '任务不存在'
  const lines = []
  lines.push(`任务 ${job.id}：${job.status}${job.seconds != null ? `（${job.seconds}s）` : ''}`)
  // 补上模型定位：Agent 看到产物时能判断这批图是用什么模型、什么取向生成的。
  if (job.tool === 'upscale') {
    // 高清放大没有扩散参数：只给源图尺寸与倍率，避免出现「0 步 · cfg 0」这类无意义信息。
    lines.push(`高清放大（×${UPSCALE.factor}）· 源图 ${job.params.width ?? '?'}×${job.params.height ?? '?'}`)
  } else {
    const preset = presetById(job.presetId)
    const known = preset && preset.id === job.presetId ? preset : null
    const presetText = known ? `${known.label}（${known.id}）` : job.presetId
    const position = known && known.description ? known.description.zh || known.description.en : ''
    const presetParts = [`预设：${presetText}`]
    if (position) presetParts.push(`定位：${position}`)
    lines.push(
      `${presetParts.join(' · ')} · 尺寸 ${job.params.width}×${job.params.height} · ${job.params.steps} 步 · cfg ${job.params.cfg} · seed ${job.params.seed}`,
    )
  }
  if (job.error) lines.push(`错误：${job.error.code} ${job.error.message}`)
  if (job.output?.images?.length) {
    lines.push('产物：')
    for (const image of job.output.images) {
      lines.push(`- ${image.path}（${image.width}×${image.height}，seed ${image.seed}）`)
      if (image.url) lines.push(`  ${image.url}`)
    }
    // 交付到工作区的副本单独列出：Agent 可以直接把相对路径写进代码或文档引用。
    for (const path of job.output.deliveredPaths ?? []) {
      lines.push(`已交付至：${path}`)
    }
    lines.push('提示：可以直接在回复里用 ![描述](URL) 展示图片。')
  } else if (job.status === 'cancelled') {
    lines.push('任务已取消，没有可展示的图片。')
  } else if (job.status !== 'done') {
    lines.push('任务仍在进行中，可用 imagen_history 或再次调用查看结果。')
  }
  return lines.join('\n')
}

/** 把会话快照折叠成一段给模型看的文字。 */
function describeSession(session) {
  const lines = [
    `会话状态：${session.state}${session.phase ? `（${session.phase}）` : ''}`,
    session.detail ? `说明：${session.detail}` : null,
    session.kernelUrl ? `Kernel：${session.kernelUrl}` : null,
    session.endpointUrl ? `隧道：已建立` : null,
    session.device ? `设备：${session.device}${session.deviceCount ? ` ×${session.deviceCount}` : ''}` : null,
    session.error ? `错误：${session.error.code} ${session.error.message}` : null,
  ]
  return lines.filter(Boolean).join('\n')
}

/** 提示词预览：折叠空白并截断，避免批量汇总把整段 prompt 重复贴出。 */
function promptPreview(prompt, maxChars = 80) {
  const text = String(prompt ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** 预设 id → 「名称（id）」；未知 id 原样返回。 */
function presetLabelOf(presetId) {
  const preset = PRESETS.find((item) => item.id === presetId)
  return preset ? `${preset.label}（${preset.id}）` : String(presetId ?? '未知预设')
}

/**
 * 把批量任务逐条结果折叠成给模型看的汇总文字。
 *
 * 返回值要让模型能继续行动：成功项给出产物路径与 URL；失败项给出可读原因；
 * 未完成项给出 jobId 与轮询/取消方式（本次总等待预算用尽不会取消它们）。
 *
 * @param {Array<object>} records 逐条记录（reject / jobId / job / prompt）
 * @param {number} waitBudget 本次调用的总等待预算（秒）
 */
function describeBatchResult(records, waitBudget) {
  let successCount = 0
  let failedCount = 0
  let pendingCount = 0
  for (const record of records) {
    if (record.reject) {
      failedCount += 1
    } else if (record.job?.status === 'done') {
      successCount += 1
    } else if (record.job?.status === 'failed' || record.job?.status === 'cancelled') {
      failedCount += 1
    } else {
      pendingCount += 1
    }
  }

  const lines = [
    `批量任务汇总：共 ${records.length} 条，成功 ${successCount}，失败 ${failedCount}，未完成 ${pendingCount}。`,
  ]
  records.forEach((record, position) => {
    const label = `[${position + 1}]`
    if (record.reject) {
      lines.push(`${label} 失败（未入队）· 提示词：${promptPreview(record.prompt) || '（空）'}`)
      lines.push(`  原因：${record.reject}`)
      return
    }
    const job = record.job
    if (!job) {
      lines.push(`${label} 未完成 · 任务 ${record.jobId} · 提示词：${promptPreview(record.prompt)}`)
      lines.push('  说明：任务已提交但查询不到快照，可用 imagen_history 确认是否已经落盘。')
      return
    }
    const preset = presetLabelOf(job.presetId)
    const promptLine = `  提示词：${promptPreview(record.prompt)}`
    if (job.status === 'done') {
      lines.push(`${label} 成功 · 任务 ${job.id} · 预设 ${preset}`)
      lines.push(promptLine)
      for (const image of job.output?.images ?? []) {
        lines.push(`  产物：${image.path}（${image.width}×${image.height}，seed ${image.seed}）`)
        if (image.url) lines.push(`  URL：${image.url}`)
      }
      for (const path of job.output?.deliveredPaths ?? []) lines.push(`  已交付至：${path}`)
      return
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      lines.push(`${label} 失败 · 任务 ${job.id} · 预设 ${preset}`)
      lines.push(promptLine)
      if (job.status === 'cancelled') {
        const count = job.output?.images?.length ?? 0
        lines.push(`  原因：任务已取消${count > 0 ? `（已出 ${count} 张，可在 imagen_history 查看）` : ''}`)
      } else {
        lines.push(`  原因：${job.error?.code ?? 'unknown'}：${job.error?.message ?? '生成失败，原因未知'}`)
      }
      return
    }
    lines.push(`${label} 未完成 · 任务 ${job.id}（${job.status}）· 预设 ${preset}`)
    lines.push(promptLine)
  })

  // 尾注只给「下一步能做什么」：未完成不是失败，不要诱导模型重复提交。
  if (pendingCount > 0) {
    lines.push(
      `未完成任务不受本次总等待预算（${waitBudget} 秒）影响，仍在后台继续；` +
        '稍后可用 imagen_history 轮询产物，确实不需要时用 imagen_cancel 按 jobId 取消。',
    )
  }
  if (successCount > 0) lines.push('提示：可以直接在回复里用 ![描述](URL) 展示图片。')
  if (failedCount > 0) {
    lines.push('失败项已逐条隔离，不影响其他任务；修正原因后可用 imagen_generate 单独重试。')
  }
  return lines.join('\n')
}

/**
 * 把配方检索结果折叠成给模型看的说明。
 *
 * 模板按预设的提示词写法分行展示，模型可以直接复制改写；
 * 这里只呈现配方里的可见文本，不生成任何隐藏后缀。
 *
 * @param {{ items: object[], total: number, limit: number, hint: string }} result 检索结果
 * @param {string} [preferredPresetId] 本次按哪个预设过滤（命中时该模型的模板排在最前）
 */
function describeRecipeResult(result, preferredPresetId = '') {
  if (result.items.length === 0) return result.hint

  const lines = []
  const truncated = result.total > result.items.length
  lines.push(
    `找到 ${result.items.length} 条配方` +
      `${truncated ? `（匹配 ${result.total} 条，已按 limit=${result.limit} 截断）` : ''}；` +
      `配方库共 ${RECIPES.length} 条：`,
  )
  for (const recipe of result.items) {
    lines.push(
      `【${recipe.title}】（${recipe.id}）· 分类：${categoryLabelOf(recipe.category)} · 建议比例：${recipe.ratioId}`,
    )
    lines.push(`  标签：${recipe.tags.join('、')}`)
    // 按提示词写法分组：同一写法的多个模型共用一份模板，避免重复贴同一段文本。
    const presetIds =
      preferredPresetId && recipe.recommendedPresets.includes(preferredPresetId)
        ? [preferredPresetId, ...recipe.recommendedPresets.filter((id) => id !== preferredPresetId)]
        : recipe.recommendedPresets
    const groups = new Map()
    for (const presetId of presetIds) {
      const preset = PRESETS.find((item) => item.id === presetId)
      const resolved = templateFor(recipe, preset)
      if (!resolved) continue
      const group = groups.get(resolved.style) ?? {
        style: resolved.style,
        template: resolved.template,
        presets: [],
      }
      group.presets.push(preset ?? { id: presetId, label: presetId })
      groups.set(resolved.style, group)
    }
    lines.push(`  适配模型与提示词模板（把 ${SUBJECT_PLACEHOLDER} 换成具体英文主体描述）：`)
    for (const group of groups.values()) {
      lines.push(
        `  - ${promptStyleName(group.style)} · ${group.presets.map((preset) => `${preset.label}（${preset.id}）`).join('、')}`,
      )
      lines.push(`    模板：${group.template}`)
    }
    lines.push(
      `  负向提示词：${recipe.negativePrompt?.trim() ? recipe.negativePrompt : '留空，主要靠正向描述表达'}`,
    )
    lines.push(`  说明：${recipe.notes}`)
  }
  lines.push(
    `模板里的 ${SUBJECT_PLACEHOLDER} 是唯一占位符：替换成具体的英文主体描述，再按需要在模板上增删词句；` +
      '配方只提供可见文本，工具不会自动追加任何风格后缀。选定 presetId 后调用 imagen_generate 或 imagen_batch。',
  )
  return lines.join('\n')
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

/** 取共享规格；缺失说明打包漏了 shared/tool-specs.js（编程错误，直接抛）。 */
function specOf(name) {
  const spec = toolSpecOf(name)
  if (!spec) throw new Error(`工具规格缺失：${name}`)
  return spec
}

/**
 * 注册 7 个 Agent 工具；宿主没有 tools 服务时静默跳过。
 *
 * @param {object} ctx 宿主上下文
 * @param {{ queue: object, session: object, defaultPreset: string }} deps
 */
export function registerTools(ctx, { queue, session, defaultPreset }) {
  if (!ctx.tools) return
  const generateSpec = specOf('imagen_generate')
  const upscaleSpec = specOf('imagen_upscale')
  const batchSpec = specOf('imagen_batch')
  const recipesSpec = specOf('imagen_recipes')
  const sessionSpec = specOf('imagen_session')
  const historySpec = specOf('imagen_history')
  const cancelSpec = specOf('imagen_cancel')

  ctx.tools.register({
    name: 'imagen_generate',
    description: generateSpec.description,
    parameters: generateSpec.parameters,
    output: textOutput,
    async execute(args = {}) {
      // 交付路径先做完整校验（含软链接逃逸）：非法时直接告诉模型原因，不占用队列。
      if (args.saveTo !== undefined && args.saveTo !== null && args.saveTo !== '') {
        const target = await resolveWorkspaceWritePath(ctx, args.saveTo)
        if (!target.ok) return { text: `提交失败：${target.message}` }
      }
      const submitted = queue.submit(args)
      if (!submitted.ok) return { text: `提交失败：${submitted.message}` }
      const waitSeconds = toInt(args.waitSeconds, LIMITS.waitSeconds.default, LIMITS.waitSeconds.min, LIMITS.waitSeconds.max)
      const job = await queue.waitFor(submitted.job.id, waitSeconds)
      return {
        text: describeJob(job),
        // 结构化任务绑定：运行时据此发出 `job-bound`，前端气泡可以实时显示进度。
        data: {
          jobId: submitted.job.id,
          jobIds: [submitted.job.id],
          presetId: job?.presetId || args.presetId || DEFAULT_PRESET,
          count: job?.params?.count ?? args.count ?? LIMITS.count.min,
          prompt: job?.params?.prompt || args.prompt || '',
        },
      }
    },
  })

  ctx.tools.register({
    name: 'imagen_upscale',
    description: upscaleSpec.description,
    parameters: upscaleSpec.parameters,
    output: textOutput,
    async execute(args = {}) {
      const requested = typeof args.path === 'string' ? args.path.trim() : ''
      if (!requested) return { text: `提交失败：path 不能为空，需要传入 ${OUTPUT_DIR}/ 内的作品路径` }
      // 源图必须真实存在且落在产物目录内（含软链接逃逸检查）：放大的是本机已落盘的作品。
      const source = await resolveOutputPath(ctx, requested)
      if (!source) return { text: `提交失败：源图不存在或不在 ${OUTPUT_DIR}/ 内（${requested}）` }
      let info = null
      try {
        info = parseImageHeader(await readFile(source.absolute))
      } catch {
        info = null
      }
      if (!info) return { text: '提交失败：源图不是可识别的 PNG / JPEG' }
      const longEdge = Math.max(info.width, info.height)
      if (longEdge > UPSCALE.maxInputEdge) {
        return {
          text: `提交失败：源图长边 ${longEdge}px 超过 ${UPSCALE.maxInputEdge}px 上限，请先换到更小的画幅再放大`,
        }
      }
      // 交付路径与 imagen_generate 同一套校验：非法时直接告诉模型原因，不占用队列。
      let saveTo = null
      if (args.saveTo !== undefined && args.saveTo !== null && args.saveTo !== '') {
        const target = await resolveWorkspaceWritePath(ctx, args.saveTo)
        if (!target.ok) return { text: `提交失败：${target.message}` }
        saveTo = target.relative
      }

      // 宽高由 Host 从 PNG/JPEG 头部读出：客户端（Agent）不需要自己算尺寸，
      // 也避免浏览器侧拿不到图片信息时漏传导致远端兜底失败。
      const request = {
        tool: 'upscale',
        prompt: '',
        width: info.width,
        height: info.height,
        reference: { path: source.relative },
        autoStart: true,
      }
      if (saveTo) request.saveTo = saveTo
      const submitted = queue.submit(request)
      if (!submitted.ok) return { text: `提交失败：${submitted.message}` }
      const waitSeconds = toInt(args.waitSeconds, LIMITS.waitSeconds.default, LIMITS.waitSeconds.min, LIMITS.waitSeconds.max)
      const job = await queue.waitFor(submitted.job.id, waitSeconds)
      return {
        text: describeJob(job),
        data: {
          jobId: submitted.job.id,
          jobIds: [submitted.job.id],
          presetId: job?.presetId || '',
          count: 1,
          prompt: '',
        },
      }
    },
  })

  ctx.tools.register({
    name: 'imagen_batch',
    description: batchSpec.description,
    parameters: batchSpec.parameters,
    output: textOutput,
    async execute(args = {}) {
      const items = args.items
      if (!Array.isArray(items) || items.length === 0) {
        return { text: '提交失败：items 必须是非空数组，每项至少包含 prompt；本次未提交任何任务。' }
      }
      if (items.length > LIMITS.batch.maxItems) {
        return {
          text:
            `提交失败：items 共 ${items.length} 条，超过单次上限 ${LIMITS.batch.maxItems} 条；` +
            '请拆成多次调用，本次未提交任何任务。',
        }
      }

      // 公共参数只取契约登记过的字段；条目参数逐项白名单取值，未知字段不带进队列。
      const jobDefaults = {}
      for (const key of ['presetId', 'width', 'height', 'steps', 'cfg']) {
        if (args[key] !== undefined && args[key] !== null) jobDefaults[key] = args[key]
      }
      const waitBudget = toInt(
        args.waitSeconds,
        LIMITS.waitSeconds.default,
        LIMITS.waitSeconds.min,
        LIMITS.waitSeconds.max,
      )

      const records = []
      const saveToOwners = new Map()
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        const record = { index, prompt: '', jobId: null, reject: null, job: null }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          record.reject = '条目必须是对象，且包含 prompt 字段'
          records.push(record)
          continue
        }
        record.prompt = typeof item.prompt === 'string' ? item.prompt : ''
        // saveTo 逐项做完整校验（含软链接逃逸）：非法项只标记该条失败，不占用队列。
        let saveTo = null
        if (item.saveTo !== undefined && item.saveTo !== null && item.saveTo !== '') {
          const target = await resolveWorkspaceWritePath(ctx, item.saveTo)
          if (!target.ok) {
            record.reject = `saveTo 不可用：${target.message}`
            records.push(record)
            continue
          }
          const key = target.relative.toLowerCase()
          if (saveToOwners.has(key)) {
            record.reject =
              `saveTo 与第 ${saveToOwners.get(key) + 1} 条重复（${target.relative}），为避免互相覆盖已跳过`
            records.push(record)
            continue
          }
          saveToOwners.set(key, index)
          saveTo = target.relative
        }

        const request = { ...jobDefaults, prompt: item.prompt }
        if (item.negativePrompt !== undefined && item.negativePrompt !== null) {
          request.negativePrompt = item.negativePrompt
        }
        if (item.seed !== undefined && item.seed !== null) request.seed = item.seed
        // 全部条目共用同一组模型原生参考图（批量分镜的主角落一致性）：
        // 路径格式与 Host 请求体一致，队列在入队前按契约数量/形状校验。
        if (Array.isArray(args.references)) request.references = args.references
        if (saveTo) request.saveTo = saveTo
        try {
          const submitted = queue.submit(request)
          if (submitted.ok) record.jobId = submitted.job.id
          else record.reject = `${submitted.code}：${submitted.message}`
        } catch (error) {
          // 单条提交异常也只影响该条，剩余任务继续入队。
          record.reject = `提交异常：${error?.message ?? error}`
        }
        records.push(record)
      }

      // 所有任务共享同一段等待预算：按提交顺序串行等待，预算用尽即停止等待。
      // 未等待到的任务不会被取消，仍在队列里继续执行。
      const deadline = Date.now() + waitBudget * 1000
      for (const record of records) {
        if (!record.jobId) continue
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) break
        try {
          await queue.waitFor(record.jobId, remainingMs / 1000)
        } catch {
          // 等待异常不应拖垮整批汇总：按当前快照继续收集结果。
          break
        }
      }
      for (const record of records) {
        if (record.jobId) record.job = queue.get(record.jobId)
      }
      return {
        text: describeBatchResult(records, waitBudget),
        data: {
          jobIds: records.map((record) => record.jobId).filter(Boolean),
          presetId: jobDefaults.presetId || DEFAULT_PRESET,
          count: records.length,
          prompt: '',
        },
      }
    },
  })

  ctx.tools.register({
    name: 'imagen_recipes',
    description: recipesSpec.description,
    parameters: recipesSpec.parameters,
    output: textOutput,
    async execute(args = {}) {
      const presetId = typeof args.presetId === 'string' ? args.presetId : ''
      const result = searchRecipes({
        keyword: typeof args.keyword === 'string' ? args.keyword : '',
        category: typeof args.category === 'string' ? args.category : '',
        presetId,
        tags: Array.isArray(args.tags) ? args.tags : [],
        limit: args.limit,
      })
      return { text: describeRecipeResult(result, presetId) }
    },
  })

  ctx.tools.register({
    name: 'imagen_session',
    description: sessionSpec.description,
    parameters: sessionSpec.parameters,
    output: textOutput,
    async execute(args = {}) {
      const action = String(args.action ?? 'status')
      if (action === 'start') {
        const snapshot = await session.start(presetById(args.presetId ?? defaultPreset).id)
        return { text: describeSession(snapshot) }
      }
      if (action === 'stop') {
        const snapshot = await session.stop()
        return { text: describeSession(snapshot) }
      }
      return { text: describeSession(session.snapshot()) }
    },
  })

  ctx.tools.register({
    name: 'imagen_history',
    description: historySpec.description,
    parameters: historySpec.parameters,
    output: textOutput,
    async execute(args = {}) {
      const limit = toInt(args.limit, LIMITS.historyTool.defaultLimit, 1, LIMITS.historyTool.maxLimit)
      // scanHistory 自历史分页改造后返回 { items, hasMore }；工具只需要最近几条记录。
      const { items } = await scanHistory(ctx, limit)
      if (items.length === 0) return { text: '还没有生成记录。' }
      const lines = []
      for (const item of items) {
        lines.push(`${item.createdAt ?? item.dir} · ${item.presetId ?? '未知预设'}`)
        lines.push(`  ${String(item.prompt ?? '').slice(0, 120)}`)
        for (const image of item.images) lines.push(`  ${image.path}`)
      }
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'imagen_cancel',
    description: cancelSpec.description,
    parameters: cancelSpec.parameters,
    output: textOutput,
    async execute(args = {}) {
      const jobId = String(args.jobId ?? '').trim()
      const result = queue.cancel(jobId)
      if (!result.ok) return { text: `未找到任务 ${jobId}` }
      if (result.disposition === 'dequeued') {
        return { text: `已取消任务 ${jobId}（已从队列移除）` }
      }
      if (result.disposition === 'cooperative') {
        return {
          text: `已向任务 ${jobId} 发送合作式取消请求：当前正在生成的单张完成后将停止，不再继续后续张数，已出图像仍保留`,
        }
      }
      return { text: `任务 ${jobId} 已处于终态（${result.job?.status ?? 'unknown'}），无需取消` }
    },
  })
}