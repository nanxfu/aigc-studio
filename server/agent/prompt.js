/**
 * 创作 Agent 的系统提示词（三层注入架构）。
 *
 * Layer 1：角色定位与安全护栏（静态核心）
 *   - 创作导演 + 参数工程师的人设；
 *   - 默认确认护栏：除明确执行措辞外，新建 GPU 生图必须走 `ui_propose_generation`；
 *   - 参数真实性：只能选上下文模型目录里存在的 presetId，不编造能力。
 * Layer 2：工作台实时上下文（每轮动态拼装）
 *   - 可用生图模型画像（含提示词写法 / 负向词能力 / 算力来源过滤）；
 *   - GPU 会话与队列摘要（冷启动预期）；
 *   - 当前舞台焦点（用户正在看的那张图）。
 * Layer 3：领域提示词构造规范
 *   - 五要素结构、去空洞词、否定词防误译、防多轮话题粘连。
 *
 * 纯函数、不读磁盘：模型目录来自 `shared/models-guide.js`（唯一数据源是 models/*.json），
 * 会话状态由装配层传入快照，舞台焦点来自客户端请求体。
 */

import { LIMITS, RATIO_IDS } from '../../shared/contract.js'
import { modelCatalogText } from '../../shared/models-guide.js'

const LOCALE_NAME = { zh: '中文', en: 'English' }

/** 会话状态 → 给模型看的冷启动说明。 */
function sessionLine(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '- 会话状态未知：需要出图时先调用 imagen_session 查看（status），必要时 start。'
  const state = typeof snapshot.state === 'string' ? snapshot.state : 'unknown'
  const phase = typeof snapshot.phase === 'string' && snapshot.phase ? `（${snapshot.phase}）` : ''
  const device = typeof snapshot.device === 'string' && snapshot.device ? `，设备 ${snapshot.device}` : ''
  const count = Number(snapshot.deviceCount)
  const deviceText = device && Number.isFinite(count) && count > 1 ? `${device}×${count}` : device
  if (state === 'ready') return `- 云端会话已就绪${deviceText}：可以直接提交生图任务。`
  if (state === 'busy') return `- 云端会话正在执行任务${deviceText}：新任务会排队，提交前告知用户预计等待。`
  if (state === 'starting') {
    return `- 云端会话正在启动${phase}${deviceText}：冷启动通常需要数分钟（排队极端情况可能 10 分钟以上），提交任务前先告知用户。`
  }
  if (state === 'absent' || state === 'stopped') {
    return '- 云端会话当前未启动：提交生图会在任务执行时自动拉起 Kernel，冷启动可能需要数分钟；可先用 imagen_session 的 start 预热。'
  }
  return `- 云端会话状态：${state}${phase}。`
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
    `- 舞台当前选中：${path}${parts.length > 0 ? `（${parts.join(' · ')}）` : ''}`,
  ]
  if (prompt) lines.push(`- 该图的原始 Prompt：${prompt}`)
  lines.push('- 用户说「这张 / 当前这张 / 把它改成…」时，指的就是这张图：可用 imagen_stage_context 取完整信息。')
  return lines
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
 * @param {{ locale?: 'zh'|'en', provider?: string, session?: object|null, queue?: object|null,
 *           stage?: object|null }} [input]
 * @returns {string}
 */
export function buildAgentSystemPrompt(input = {}) {
  const locale = input.locale === 'en' ? 'en' : 'zh'
  const uiLanguage = LOCALE_NAME[locale]
  const provider = typeof input.provider === 'string' && input.provider ? input.provider : 'kaggle'
  const catalog = modelCatalogText({ textToImageOnly: true, provider })
  const stage = stageLines(input.stage)
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
    '【Layer 2 · 工作台实时上下文】',
    `当前算力来源：${provider}`,
    'GPU 会话与队列：',
    sessionLine(input.session),
    ...(queue ? [queue] : []),
    '可用生图模型目录（presetId 只能从这里选；已按当前算力来源过滤，并剔除仅支持局部重绘的权重）：',
    catalog || '- （模型目录暂时不可用，请先用默认预设并告知用户）',
    RATIO_IDS.length > 0 ? `可用画幅比例：${RATIO_IDS.join('、')}（用户没提尺寸时不要猜，交给客户端当前设置）。` : '',
    stage.length > 0 ? '当前舞台焦点：' : '',
    ...stage,
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
