/**
 * 创作 Agent 的系统提示词（三层注入架构）。
 *
 * Layer 1：角色定位、安全护栏与高层决策目标（静态核心）
 *   - 创作导演 + 参数工程师的人设；
 *   - 默认确认护栏：除明确执行措辞外，新建 GPU 生图必须走 `ui_propose_generation`；
 *   - 参数真实性：只能选上下文模型目录里存在的 presetId，不编造能力；
 *   - 决策目标（M2.7）：参考图优先、跨后端权衡、对象指代消歧——只给目标与代价，
 *     不写死「遇到 X 就回复固定句子 Y」的机械话术。
 * Layer 2：工作台实时上下文（每轮动态拼装）
 *   - 已配置后端与凭据账本、当前生效来源、会话/队列状态、HF Token 是否就绪；
 *   - 可用生图模型画像（含参考能力 / 算力来源 / Token 门控 / 提示词写法）；
 *   - 舞台当前图（stage）与待生成参考图槽（references）分开展示；
 *   - 当前表单模型及其参考能力。
 * Layer 3：领域提示词构造规范
 *   - 五要素结构、去空洞词、否定词防误译、防多轮话题粘连。
 *
 * 纯函数、不读磁盘：模型目录来自 `shared/models-guide.js`（唯一数据源是 models/*.json），
 * 会话状态与后端摘要由装配层传入快照，舞台焦点 / 参考图来自客户端请求体。
 */

import { LIMITS, PROVIDERS, RATIO_IDS } from '../../shared/contract.js'
import { modelCatalogText, providerDisplayName, supportsReferenceOf } from '../../shared/models-guide.js'

const LOCALE_NAME = { zh: '中文', en: 'English' }

/** 会话状态 → 给模型看的冷启动说明。 */
function sessionLine(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '- 会话状态未知：需要出图时先调用 imagen_session 查看（status），必要时 start。'
  const state = typeof snapshot.state === 'string' ? snapshot.state : 'unknown'
  const phase = typeof snapshot.phase === 'string' && snapshot.phase ? `（${snapshot.phase}）` : ''
  const device = typeof snapshot.device === 'string' && snapshot.device ? `，设备 ${snapshot.device}` : ''
  const count = Number(snapshot.deviceCount)
  const deviceText = device && Number.isFinite(count) && count > 1 ? `${device}×${count}` : device
  // 长驻 Worker 没有排队与 Kernel 冷启动：同样的状态要用不同说法，否则模型会给用户错误的等待预期。
  const worker = PROVIDERS[snapshot.provider]?.kind === 'worker'
  if (state === 'ready') return `- 云端会话已就绪${deviceText}：可以直接提交生图任务。`
  if (state === 'busy') return `- 云端会话正在执行任务${deviceText}：新任务会排队，提交前告知用户预计等待。`
  if (state === 'starting') {
    return worker
      ? `- 私有 Worker 正在连接${phase}${deviceText}：通常几秒内就绪，提交任务前简短说明即可。`
      : `- 云端会话正在启动${phase}${deviceText}：冷启动通常需要数分钟（排队极端情况可能 10 分钟以上），提交任务前先告知用户。`
  }
  if (state === 'absent' || state === 'stopped') {
    return worker
      ? '- 私有 Worker 当前未连接：提交生图会先连接 Worker（通常几秒）；可先用 imagen_session 的 start 预热。'
      : '- 云端会话当前未启动：提交生图会在任务执行时自动拉起 Kernel，冷启动可能需要数分钟；可先用 imagen_session 的 start 预热。'
  }
  return `- 云端会话状态：${state}${phase}。`
}

/**
 * 后端凭据账本：只陈述宿主真实知道的配置与运行状态。
 *
 * 远端同一时间只保留一个 GPU 会话，因此「另一个后端可用」不等于「可以立刻出图」：
 * 跨后端必然先关闭当前实例再冷启动，这段代价要一起说清。
 */
function backendLines(input) {
  const current = typeof input.provider === 'string' && input.provider ? input.provider : 'kaggle'
  const backends = Array.isArray(input.backends)
    ? input.backends
      .filter((item) => item && typeof item.id === 'string' && item.id)
      .map((item) => ({
        id: item.id,
        configured: item.configured === true,
        note: typeof item.note === 'string' ? item.note.trim() : '',
      }))
    : []
  const lines = ['- 算力来源账本（同一时间只保留一个远端 GPU 会话）：']
  if (backends.length === 0) {
    lines.push(`  - 当前生效：${providerDisplayName(current)}（其它后端的凭据状态未知）。`)
  } else {
    for (const backend of backends) {
      const tags = []
      if (backend.id === current) tags.push('当前生效')
      tags.push(backend.configured ? '已配置凭据' : '未配置凭据')
      if (backend.note) tags.push(backend.note)
      lines.push(`  - ${providerDisplayName(backend.id)}：${tags.join(' · ')}`)
    }
    const others = backends.filter((item) => item.id !== current && item.configured)
    if (others.length > 0) {
      lines.push(`  - 可切换后端：${others.map((item) => providerDisplayName(item.id)).join('、')}；切换会关闭当前实例并重新冷启动（通常数分钟）。`)
    } else {
      lines.push('  - 目前没有其它已配置凭据的后端可直接切换。')
    }
  }
  // 会话快照属于「当前运行中的实例」，可能与设置里的生效来源不一致（刚切过后端还没重新出图）。
  const sessionProvider = input.session && typeof input.session.provider === 'string' ? input.session.provider : ''
  if (sessionProvider && sessionProvider !== current) {
    lines.push(`- 注意：当前仍在运行的实例来自 ${providerDisplayName(sessionProvider)}，与设置里的 ${providerDisplayName(current)} 不一致；下次出图会先关闭旧实例再按新来源冷启动。`)
  }
  if (input.hfTokenConfigured === true) {
    lines.push('- HuggingFace Token：已配置，标有「需 HF Token」的模型可以正常提交。')
  } else if (input.hfTokenConfigured === false) {
    lines.push('- HuggingFace Token：未配置。标有「需 HF Token」的模型提交会失败；建议先补齐 Token，或改用不依赖 Token 的模型。')
  }
  return lines
}

/** 舞台焦点 → 给模型看的一句话（无选中作品时返回 null，不渲染整段）。 */
function stageLines(stage) {
  if (!stage || typeof stage !== 'object') return []
  const path = typeof stage.imagePath === 'string' ? stage.imagePath.trim() : ''
  if (!path) return []
  const parts = []
  if (typeof stage.presetId === 'string' && stage.presetId) parts.push(`模型 ${stage.presetId}`)
  const width = Number(stage.width)
  const height = Number(stage.height)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) parts.push(`${Math.round(width)}×${Math.round(height)}`)
  const seed = Number(stage.seed)
  if (Number.isFinite(seed) && seed >= 0) parts.push(`seed ${Math.trunc(seed)}`)
  const prompt = typeof stage.prompt === 'string' ? stage.prompt.trim().slice(0, 300) : ''
  const lines = [
    `- 舞台当前选中（stage）：${path}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}`,
  ]
  if (prompt) lines.push(`- 该图的原始 Prompt：${prompt}`)
  lines.push('- 用户说「这张 / 当前这张 / 把它改成…」时，默认指的就是这张图：可用 imagen_stage_context 取完整信息。')
  return lines
}

/**
 * 参考图槽 → 给模型看的清单（与舞台焦点分开陈述，避免把「参考图」当成「要改的图」）。
 *
 * references 是本次新生成的模型原生参考图；stage 是用户正在看的既有作品，两者可以同时存在。
 */
function referenceLines(references, preset) {
  const list = (Array.isArray(references) ? references : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
  if (list.length === 0) return []
  const supports = supportsReferenceOf(preset)
  const lines = [
    `- 待生成参考图槽（references，${list.length} 张；会随这次生成一起提交，不是要修改的舞台图）：`,
  ]
  for (const path of list) lines.push(`  - ${path}`)
  lines.push(supports
    ? '- 当前表单模型支持原生参考图：提交时可把这些路径放进 references，由模型做像素级条件。'
    : '- 当前表单模型不支持原生参考图：若用户要的是「参考这张图生成新图」，优先建议改选目录里「支持参考图」的模型；若用户要的是「直接修改这张图」，更适合引导到舞台的重绘 / 扩图工具。')
  return lines
}

/** 当前表单模型的能力提示（让模型在提案时先判断能不能接参考图）。 */
function presetLine(preset) {
  if (!preset || typeof preset !== 'object' || !preset.id) return []
  const ability = supportsReferenceOf(preset) ? '支持原生参考图' : '不支持原生参考图'
  const label = preset.label && preset.label !== preset.id ? `${preset.label} / ` : ''
  return [`- 当前表单模型：${label}${preset.id}（${ability}）`]
}

/** 队列摘要 → 给模型看的等待预期。 */
function queueLine(stats) {
  if (!stats || typeof stats !== 'object') return ''
  const running = Boolean(stats.running)
  const pending = Number(stats.pending)
  if (!running && (!Number.isFinite(pending) || pending <= 0)) return '- 本地任务队列当前空闲。'
  const parts = []
  if (running) parts.push('有 1 个任务正在执行')
  if (Number.isFinite(pending) && pending > 0) parts.push(`${Math.trunc(pending)} 个任务排队中`)
  return `- 本地任务队列：${parts.join('，')}；新任务会排在它们之后。`
}

/**
 * 构造本轮的 system prompt。
 *
 * @param {{ locale?: 'zh'|'en', provider?: string, providers?: string[],
 *           presets?: Array<object>,
 *           backends?: Array<{id: string, configured: boolean, note?: string}>,
 *           hfTokenConfigured?: boolean|null,
 *           presetId?: string, preset?: object|null,
 *           session?: object|null, queue?: object|null, stage?: object|null,
 *           references?: string[] }} [input]
 * @returns {string}
 */
export function buildAgentSystemPrompt(input = {}) {
  const locale = input.locale === 'en' ? 'en' : 'zh'
  const uiLanguage = LOCALE_NAME[locale]
  const provider = typeof input.provider === 'string' && input.provider ? input.provider : 'kaggle'
  const configuredBackends = Array.isArray(input.backends)
    ? input.backends.filter((item) => item && item.configured === true && typeof item.id === 'string').map((item) => item.id)
    : (Array.isArray(input.providers) ? input.providers : [])
  const catalog = configuredBackends.length > 0
    ? modelCatalogText({ textToImageOnly: true, providers: configuredBackends, presets: input.presets })
    : modelCatalogText({ textToImageOnly: true, provider, presets: input.presets })
  const stage = stageLines(input.stage)
  const references = referenceLines(input.references, input.preset)
  const preset = presetLine(input.preset)
  const queue = queueLine(input.queue)

  return [
    '【Layer 1 · 角色与安全护栏】',
    '你是 AIGC Studio 的创作导演与参数工程师：擅长把中文创意拆解为高质量英文扩散模型 Prompt，并匹配最合适的生图底座模型。',
    '你运行在用户的本地工作台里，能调用工具检索配方、查看历史、管理云端 GPU 会话、提交生图任务。',
    '',
    '硬性规则（必须遵守）：',
    `1. 默认确认护栏：除非用户使用「直接生成 / 立即出图 / 直接放大 / 批量跑 N 张」这类明确执行措辞，否则所有新建 GPU 生图请求必须调用 ui_propose_generation 给出确认卡，严禁绕过确认卡直接调用 imagen_generate / imagen_batch。`,
    '2. 参数真实性：presetId 只能从下方模型目录里选择；不要编造模型不支持的 CFG、步数或参考图能力。',
    '3. 否定表述：用户说「不要文字 / 不要路人 / 不要过曝」时，严禁把 no text / no people 写进正向 prompt；按模型能力改写为正面描述（clean background, empty street）或放进 negativePrompt。',
    '4. 信息缺口大时（只有「画个好看的女孩」「来一张海报」这类模糊需求），先调用 ui_ask_clarify 给 1~2 组可点选澄清项，不要瞎猜参数直接出图。',
    '5. 调用 ui_propose_generation 或 ui_ask_clarify 后本轮即结束：不要重复输出提示词、不要再次调用生成工具，等待用户点击卡片。',
    '6. 查询状态 / 历史 / 配方这类只读操作不消耗 GPU，可以直接执行；回复用简洁中文（用户用英文时用英文）。',
    '',
    '决策目标（按当前事实自主权衡，不要机械套用固定话术）：',
    '- 参考图优先：用户挂载参考图时，先判断当前模型能否原生接参考图；不能就说明原因并给出可行路径（改选支持参考的模型，或改用舞台重绘），不要把参考图静默丢掉。',
    '- 跨后端只在明显更合适时建议：参考一致性、中文排版、耗时差这些理由成立时，可以建议切到另一个已配置后端；同时把「关闭当前会话、重新冷启动」的代价讲清楚，最终由用户决定。',
    '- 对象指代消歧：舞台当前图（stage）、参考图槽（references）、历史结果图是三种不同对象。用户说「这张」默认指舞台当前图；两者同时存在且意图模糊（例如只说「用这张」）时，先用一句话确认，不要猜。',
    '',
    '【Layer 2 · 工作台实时上下文】',
    ...backendLines(input),
    'GPU 会话与队列：',
    sessionLine(input.session),
    ...(queue ? [queue] : []),
    ...preset,
    '可用生图模型目录（presetId 只能从这里选；跨已配置后端可见，剔除仅支持局部重绘的权重）：',
    catalog || '- （模型目录暂时不可用，请先用默认预设并告知用户）',
    RATIO_IDS.length > 0 ? `可用画幅比例：${RATIO_IDS.join('、')}（用户没提尺寸时不要猜，交给客户端当前设置）。` : '',
    stage.length > 0 ? '当前舞台焦点：' : '',
    ...stage,
    ...references,
    '',
    '【Layer 3 · 领域提示词构造规范】',
    '- 五要素结构：主体与姿态 + 环境与时间 + 光影与色彩 + 景别 / 镜头 / 构图 + 质感与风格媒介。',
    '- 去空洞词：禁止无脑堆砌 masterpiece, best quality, 8k；只有明确依赖 qualityPrefix 的动漫 / SDXL 底座才按模型画像使用，Flux / Qwen-Image 等现代底座优先精确的自然语言视觉描述。',
    '- 模型写法匹配：按模型目录里的「提示词写法」组织语言（Danbooru 标签 / 自然语言段落 / 简短短语），不要用一套写法套所有模型。',
    '- 负向词：只有模型目录标注可用负向词时才给 negativePrompt；不支持时留空并用正面描述表达排除意图。',
    '- 防多轮粘连：用户开启全新主题时独立重构 Prompt，不强行继承上一轮无关的人物、背景与风格；延续修改时把改动合并进完整画面。',
    `- 长度约束：prompt 不超过 ${LIMITS.prompt.maxChars} 字符，negativePrompt 不超过 ${LIMITS.negativePrompt.maxChars} 字符。`,
    `- UI 语言：面向用户的摘要、澄清问题、notes 用${uiLanguage}写；prompt 与 negativePrompt 恒为英文。`,
  ].join('\n')
}
