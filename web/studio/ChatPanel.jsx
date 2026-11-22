/**
 * 创作助手（对话式面板，单轨 Agent）。
 *
 * 用户用一句话描述想画什么，Agent 会：
 *  - 直接回答创作咨询；
 *  - 或给出澄清卡（信息不足时）；
 *  - 或给出「生图确认卡」：中文摘要优先、英文提示词可编辑、张数可选，
 *    可以「按此生成」或「带入参数面板」；
 *  - 用户明确要求直接执行时，Agent 会提交任务并发回可点开的实时作业卡。
 *
 * 气泡类型：提案 / 澄清 / 任务状态与结果 / 表单提交同步 / 舞台工具动作镜像。
 *
 * 阶段十五 Phase A2：
 *  - 完成气泡用 1~4 格缩略图网格展示全部结果图（1 张保持单图观感）；
 *  - 点击网格中任一图 → 舞台切到该图（library.openMessage）+ 助手进入单图聚焦视图；
 *  - 聚焦视图给出快捷胶囊：对比原图 / 继续涂抹 / 重新生成 / 查看大图。
 *
 * Phase B：
 *  - 思考过程与工具步骤合并为可折叠的「步骤时间线」，气泡区保持清爽；
 *  - 澄清卡支持多维度选择；
 *  - 移除「快速填卡 / Agent 对话」模式开关（统一由 pi-agent-core 驱动）。
 *
 * 外框、头部与分段控件来自 panel.css，消息流与卡片样式在 chat.css。
 * 接收 { t, ui, form, chat, library, actions } 领域对象。
 *
 * M2.6（导入图焦点隔离）：舞台停在裸导入图或其无参数放大产物时（`library.importLocked`），
 * 线程与消息原样保留，只把输入区 / 发送 / 示例词 / 卡片提交按钮禁用，并在坞内给
 * 「新建创作」出口；切回 AI 作品或新建画布后自动恢复。
 *
 * M2.7（助手显式参考图 / 跨后端调度）：
 *  - 输入区上方外露共用参考图条（与左栏 `form.form.references` 同源），支持本地选图、
 *    从作品选择、拖放与单张移除，并用角色标注和「舞台当前图」区分；
 *  - 提案卡按钮按实时 `compute.provider` 动态计算：同后端「按此生成」、跨后端
 *    「切换到 X 并按此生成」，不在历史消息里写死按钮文案；
 *  - 结果缩略图裂图 / 已删图给安全占位，点击时提示而不是切到空路径。
 */

import React from 'react'

import { LIMITS, publicPresets } from '../../shared/contract.js'

import { COUNT_OPTIONS, INSPIRE_KEYS } from '../constants.js'
import { gridImagesOf, gridLabelOf, imageMetaOf, proposalTargetOf, strengthLabelOf } from '../logic/chat.js'
import { formatText } from '../logic/format.js'
import { intentCount } from '../logic/intent.js'
import { providerLabelOf } from '../logic/status.js'
import { filesOf, hasFilePayload, hasWorkDragPayload, workDragPathOf } from './drag.js'
import { ChatReferenceBar } from './ChatReferenceBar.jsx'
import { Icon } from './icons.jsx'
import { PanelModeTabs } from './PanelModeTabs.jsx'

// 任务型气泡左上角的状态点：完成绿点，排队/生成是呼吸琥珀点，失败红点。
const WORKING_STAGES = ['pending', 'queued', 'running']

/** 云端会话仍占用实例的状态：跨后端切换前要提示「先关掉它」。 */
const ACTIVE_SESSION_STATES = ['provisioning', 'connecting', 'warming', 'ready', 'stopping']

function isWorking(stage) {
  return WORKING_STAGES.indexOf(stage) >= 0
}

function dotClass(stage) {
  if (stage === 'failed') return 'ofs-dot ofs-chat-dot is-error'
  if (isWorking(stage)) return 'ofs-dot ofs-chat-dot is-warn is-live'
  return 'ofs-dot ofs-chat-dot is-ok'
}

function ratioLabel(t, ratioId) {
  return ratioId || t('studio.chat.ratioAuto')
}

const PUBLIC_PRESET_LIST = publicPresets()

/** 会镜像到助手线程的舞台工具 id：界面按它决定回放哪条动作说明。 */
const MIRROR_TOOL_IDS = Object.freeze(['inpaint', 'img2img', 'upscale', 'outpaint'])

/** 模型建议里展示的模型名；未知 id 返回空串（整行不渲染）。 */
function modelLabelOf(presetId) {
  const preset = PUBLIC_PRESET_LIST.find((item) => item && item.id === presetId)
  return preset ? (preset.label || preset.short || preset.id) : ''
}

/**
 * 线程图片：加载失败（早期卡片引用的图已在画廊被删 / 文件移动）时降级为安全占位，
 * 不把浏览器的裂图图标直接摆在卡片里；点击行为由外层决定（会提示而不是切空路径）。
 */
function ThreadImage(props) {
  const { src, alt, className, title, onReady, onDead } = props
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => {
    setBroken(false)
  }, [src])
  if (!src || broken) {
    return (
      <span className="ofs-chat-img-missing" role="img" aria-label={title || alt || ''}>
        <Icon name="image" size={18} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={alt || ''}
      title={title || undefined}
      className={className}
      loading="lazy"
      draggable={false}
      onLoad={() => {
        if (typeof onReady === 'function') onReady(true)
      }}
      onError={() => {
        setBroken(true)
        if (typeof onDead === 'function') onDead()
      }}
    />
  )
}

/** 表单提交同步记录的小标题：普通表单提交 / 生成变体 / 重试上次参数。 */
function formSyncTitle(t, source) {
  if (source === 'variant') return t('studio.chat.formSync.variant')
  if (source === 'retry') return t('studio.chat.formSync.retry')
  return t('studio.chat.formSync.form')
}

/**
 * 澄清卡。
 *
 * 兼容两代协议：
 *  - 旧版 `{ question, options: string[] }`：点选项立即提交；
 *  - 新版 `{ question, dimensions: [{ id, label, multi, options:[{label,value}] }] }`：
 *    - 单维度单选 → 点选项立即提交（最少一次点击）；
 *    - 多维度或多选 → 先累积选择，再点「提交选择」把「维度：选项」拼成下一轮用户输入。
 * 底部始终保留「先按当前设置」兜底（只关闭澄清卡，不提交）。
 */
function ClarifyCard({ t, message, resolve, locked }) {
  const clarify = message.clarify && typeof message.clarify === 'object' ? message.clarify : {}
  const question = typeof clarify.question === 'string' ? clarify.question : ''
  const dimensions = Array.isArray(clarify.dimensions) && clarify.dimensions.length > 0 ? clarify.dimensions : null
  const legacyOptions = Array.isArray(clarify.options) ? clarify.options : []
  const [picked, setPicked] = React.useState({})
  const disabled = locked === true

  const instant = dimensions
    ? dimensions.length === 1 && dimensions[0].multi !== true
    : true

  function toggle(dimension, option) {
    if (disabled) return
    if (instant) {
      resolve(message.id, option.value || option.label || option)
      return
    }
    setPicked((prev) => {
      const current = Array.isArray(prev[dimension.id]) ? prev[dimension.id] : []
      const exists = current.includes(option.value)
      const next = dimension.multi
        ? (exists ? current.filter((item) => item !== option.value) : [...current, option.value])
        : [option.value]
      return { ...prev, [dimension.id]: next }
    })
  }

  const summary = dimensions
    ? dimensions
      .map((dimension) => {
        const values = Array.isArray(picked[dimension.id]) ? picked[dimension.id] : []
        if (values.length === 0) return ''
        const labels = values.map((value) => {
          const found = dimension.options.find((option) => option.value === value)
          return found ? found.label : value
        })
        return `${dimension.label}：${labels.join('、')}`
      })
      .filter(Boolean)
      .join('；')
    : ''

  return (
    <div className="ofs-msg-card ofs-intent ofs-intent-clarify" key={message.id}>
      <span className="ofs-intent-title">{t('studio.chat.clarify.title')}</span>
      {question ? <p className="ofs-intent-question">{question}</p> : null}
      {dimensions ? (
        <div className="ofs-clarify-dimensions">
          {dimensions.map((dimension) => {
            const values = Array.isArray(picked[dimension.id]) ? picked[dimension.id] : []
            return (
              <div className="ofs-clarify-dimension" key={dimension.id}>
                <span className="ofs-clarify-dimension-label">{dimension.label}</span>
                <div className="ofs-suggestions">
                  {dimension.options.map((option) => {
                    const on = values.includes(option.value)
                    return (
                      <button
                        type="button"
                        key={option.value}
                        className={on ? 'ofs-suggestion is-on' : 'ofs-suggestion'}
                        aria-pressed={on}
                        disabled={disabled}
                        onClick={() => toggle(dimension, option)}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="ofs-suggestions">
          {legacyOptions.map((option) => (
            <button
              type="button"
              key={option}
              className="ofs-suggestion"
              disabled={disabled}
              onClick={() => resolve(message.id, option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="ofs-clarify-actions">
        {dimensions && !instant ? (
          <button
            type="button"
            className="ofs-suggestion is-primary"
            disabled={!summary || disabled}
            onClick={() => resolve(message.id, summary)}
          >
            {t('studio.chat.clarify.submit')}
          </button>
        ) : null}
        <button
          type="button"
          className="ofs-suggestion"
          disabled={disabled}
          onClick={() => resolve(message.id, '')}
        >
          {t('studio.chat.clarify.auto')}
        </button>
      </div>
    </div>
  )
}

/**
 * 思考 / 工具步骤时间线：把 reasoning 与工具胶囊收进一个可折叠的区块。
 * 流式中默认展开（让用户看到「在干什么」），完成后折叠成一行摘要。
 */
function AgentStepTimeline({ t, message }) {
  const tools = Array.isArray(message.tools) ? message.tools.filter((item) => item && item.name) : []
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning.trim() : ''
  if (tools.length === 0 && !reasoning) return null
  const working = isWorking(message.stage)
  const doneCount = tools.filter((tool) => tool.status === 'done').length
  const failedCount = tools.filter((tool) => tool.status === 'failed').length
  const summary = tools.length > 0
    ? formatText(t('studio.chat.steps.summary'), { count: tools.length, done: doneCount })
    : t('studio.chat.steps.thinking')
  return (
    <details className="ofs-chat-steps" open={working}>
      <summary className="ofs-chat-steps-summary">
        <span className={working ? 'ofs-dot ofs-chat-dot is-warn is-live' : 'ofs-dot ofs-chat-dot is-ok'} aria-hidden="true" />
        <span className="ofs-chat-steps-text">{working ? t('studio.chat.agent.streaming') : summary}</span>
        {failedCount > 0 ? <span className="ofs-chip ofs-chat-steps-fail">{failedCount}</span> : null}
        <span className="ofs-grow" />
        <span className="ofs-chat-steps-caret" aria-hidden="true">⌄</span>
      </summary>
      <div className="ofs-chat-steps-body">
        {reasoning ? <p className="ofs-chat-steps-reasoning">{reasoning}</p> : null}
        {tools.length > 0 ? (
          <div className="ofs-chat-tools-log">
            {tools.map((tool, index) => {
              const statusText = tool.status === 'done'
                ? t('studio.chat.agent.toolDone')
                : tool.status === 'failed'
                  ? t('studio.chat.agent.toolFailed')
                  : t('studio.chat.agent.toolRunning')
              return (
                <span key={tool.id || `${tool.name}-${index}`} className={`ofs-chip ofs-chat-tool-chip is-${tool.status || 'running'}`}>
                  {tool.name} · {statusText}
                </span>
              )
            })}
          </div>
        ) : null}
      </div>
    </details>
  )
}

/**
 * 表单提交的参数摘要 → 紧凑胶囊。
 *
 * 展示顺序固定：模型 → 画幅比例与像素 → 张数 → 种子策略，
 * 与表单提交时的请求体一一对应，用户不用回参数面板就能看懂这次是怎么生成的。
 * 主表单固定纯文生图（0.13.0 起参考图迁到舞台图片工具），不再输出「是否带参考图」胶囊。
 */
function formSyncChips(t, message) {
  const summary = message && message.summary && typeof message.summary === 'object' ? message.summary : null
  if (!summary) return []
  const chips = []
  const model = modelLabelOf(summary.presetId) || (typeof summary.presetId === 'string' ? summary.presetId : '')
  if (model) chips.push({ key: 'model', text: model })
  const width = Number(summary.width)
  const height = Number(summary.height)
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    const size = `${Math.round(width)} × ${Math.round(height)}`
    chips.push({
      key: 'size',
      text: typeof summary.ratioId === 'string' && summary.ratioId ? `${summary.ratioId} · ${size}` : size,
    })
  }
  const count = Number(summary.count)
  if (Number.isFinite(count) && count > 0) {
    chips.push({ key: 'count', text: `${Math.round(count)} ${t('unit.image')}` })
  }
  const seedValue = summary.seed
  // Number(null) === 0，不能直接 Number()：没有固定种子时 summary.seed 是 null。
  const seed = seedValue === null || seedValue === undefined || seedValue === '' ? NaN : Number(seedValue)
  if (Number.isFinite(seed) && seed >= 0) {
    chips.push({ key: 'seed', text: formatText(t('studio.chat.formSync.seed'), { seed: Math.trunc(seed) }) })
  } else {
    chips.push({ key: 'seed', text: t('studio.chat.formSync.seedRandom') })
  }
  return chips
}

export function ChatPanel(props) {
  const { t, ui, compute, form, chat, library, actions, embedded } = props
  const { panelMode: mode, setPanelMode: setMode } = ui
  const {
    messages,
    interpreting,
    streamingAgent = false,
    stopAgent = null,
    interpret,
    updateIntentField,
    generateIntent,
    handoffIntent,
    toggleIntentLockSeed,
    canLockSeed,
    resolveClarify,
    startExplore,
    newChat,
    // 阶段十五 Phase A2：单图聚焦返回栈（旧宿主 / 测试替身可以只给部分字段）。
    focus,
    focusBack,
    focusBackLabel,
    focusImage,
    focusClear,
  } = chat
  const { openMessage: openImage } = library
  const { sending } = actions
  // 排除项只在该模型/CFG 真正消费负向词时出现；旧宿主缺这个字段时按「不显示」处理。
  const negativeActive = Boolean(form && form.negativeActive === true)
  // 导入图焦点隔离（M2.6）：锁定期间对话线程原样保留（可滚动、可回看），
  // 只禁用输入、发送、示例词与卡片上的提交动作。
  const locked = Boolean(library && library.importLocked)

  // 参考图槽与左栏表单同源（M2.7）：条上看到的、提交时带的就是同一份 `form.form.references`。
  const references = form && form.form && Array.isArray(form.form.references) ? form.form.references : []
  const referenceSupported = Boolean(form && form.referenceSupported === true)
  const referenceSwitchLabel = form && typeof form.referenceSwitchLabel === 'string' ? form.referenceSwitchLabel : ''
  const referenceMax = form && form.referenceMax
  const referenceBusy = Boolean(actions && actions.referenceUploading)

  // 已删除 / 已移动图片的路径：缩略图降级为占位，点击只提示，不切到空路径。
  const [brokenImages, setBrokenImages] = React.useState({})
  // M3.5 Phase C：多图结果可切成「并排对比」模式（横向单行大图，便于逐张挑优）。
  const [compareSets, setCompareSets] = React.useState({})
  const toggleCompareSet = (messageId) => {
    setCompareSets((prev) => ({ ...prev, [messageId]: !prev[messageId] }))
  }
  const markBroken = (path) => {
    const key = typeof path === 'string' ? path.trim() : ''
    if (!key) return
    setBrokenImages((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
  }
  const isBrokenPath = (path) => {
    const key = typeof path === 'string' ? path.trim() : ''
    return Boolean(key && brokenImages[key])
  }
  const warnMissing = () => {
    if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.chat.imageMissing'))
  }

  // 参考图拖放：把外部文件与站内作品都收进参考图槽（与左栏同一套动作）。
  const [refDragKind, setRefDragKind] = React.useState('')
  const refDragDepthRef = React.useRef(0)

  const [draft, setDraft] = React.useState('')
  const threadRef = React.useRef(null)
  const initialIdsRef = React.useRef(null)
  if (initialIdsRef.current === null) {
    initialIdsRef.current = new Set(
      (Array.isArray(messages) ? messages : [])
        .map((item) => item && item.id)
        .filter((id) => id !== undefined && id !== null),
    )
  }
  const isNewMessage = (id) => id === undefined || id === null || !initialIdsRef.current.has(id)
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const lastStage = (lastMessage && lastMessage.stage) || ''

  // 新消息、状态更新与解析中都把线程滚到底部。
  React.useEffect(() => {
    const node = threadRef.current
    if (node) node.scrollTo({ top: node.scrollHeight })
  }, [messages.length, lastStage, interpreting])

  function send() {
    const text = draft.trim()
    if (!text || sending || interpreting || locked) return
    setDraft('')
    interpret(text)
  }

  /** 拖入输入区的载荷类型：站内作品 / 外部文件；锁定态一律不接。 */
  function dragKindOf(event) {
    if (locked) return ''
    if (hasWorkDragPayload(event)) return 'work'
    if (hasFilePayload(event)) return 'file'
    return ''
  }

  function onDockDragEnter(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    refDragDepthRef.current += 1
    if (refDragKind !== kind) setRefDragKind(kind)
  }

  function onDockDragOver(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  function onDockDragLeave(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    refDragDepthRef.current = Math.max(0, refDragDepthRef.current - 1)
    if (refDragDepthRef.current === 0 && refDragKind) setRefDragKind('')
  }

  /** 松手：外部文件走 `/import` 入槽；站内作品直接引用原路径（不复制副本）。 */
  function onDockDrop(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    refDragDepthRef.current = 0
    if (refDragKind) setRefDragKind('')
    if (kind === 'work') {
      const dragged = ui && ui.draggingWork ? ui.draggingWork : null
      const path = workDragPathOf(event.dataTransfer) || (dragged && dragged.path) || ''
      if (ui && typeof ui.setDraggingWork === 'function') ui.setDraggingWork(null)
      const entry = dragged && entryMatchesPath(dragged.entry, path) ? dragged.entry : null
      if ((entry || path) && actions && typeof actions.addReference === 'function') {
        actions.addReference(entry || path)
      }
      return
    }
    const files = filesOf(event.dataTransfer)
    if (files.length > 0 && actions && typeof actions.uploadReferenceFiles === 'function') {
      actions.uploadReferenceFiles(files)
    }
  }

  function entryMatchesPath(entry, path) {
    if (!path) return Boolean(entry)
    const target = entry && entry.image && typeof entry.image.path === 'string' ? entry.image.path.trim() : ''
    return target === path
  }

  /** 新建对话：清空线程与输入草稿；解析中的在途请求由 useChatThread 的代次守卫丢弃。 */
  function startNewChat() {
    if (typeof newChat === 'function') newChat()
    setDraft('')
  }

  /** 打开某个图片路径；没有 openMessage 的测试替身 / 旧宿主下静默跳过。 */
  function openPath(path) {
    const target = typeof path === 'string' ? path.trim() : ''
    if (target && typeof openImage === 'function') openImage(target)
  }

  /**
   * 从作品库里按路径找回条目 `{ image, item }`：单图聚焦的快捷动作需要 item
   * （判断 sourceImage 是否可对比原图、交给图片工具当底图、重新生成沿用作品参数）。
   * 新完成任务在 /history 刷新前还不在 gallery 里，退一步按 items 里的图拼最小条目。
   */
  function libraryEntryOf(path) {
    const target = typeof path === 'string' ? path.trim() : ''
    if (!target) return null
    const gallery = Array.isArray(library && library.gallery) ? library.gallery : []
    const found = gallery.find((entry) => entry && entry.image && entry.image.path === target)
    if (found) return found
    const items = Array.isArray(library && library.items) ? library.items : []
    for (const item of items) {
      const images = item && Array.isArray(item.images) ? item.images : []
      const image = images.find((candidate) => candidate && candidate.path === target)
      if (image) return { image, item }
    }
    return null
  }

  /**
   * 点击结果网格里的某张图：舞台切到该图 + 进入单图聚焦视图。
   * 顺序上先切舞台再进聚焦：聚焦失败（图片非法）时舞台仍停在被点的图。
   * 已经确认裂图（早期卡片引用的图被删除）时只提示，不切空路径。
   */
  function openGridImage(message, image, index) {
    const path = image && typeof image.path === 'string' ? image.path : ''
    if (path && brokenImages[path]) {
      if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.chat.imageMissing'))
      return
    }
    if (path) openPath(path)
    if (typeof focusImage === 'function') focusImage(message, image, index)
  }

  /** 面包屑返回：逐层出栈；还有上一层时把舞台切回那一层对应的节点，全程不改 messages。 */
  function backFromFocus() {
    if (typeof focusBack !== 'function') return
    const next = focusBack()
    const path = next && typeof next.path === 'string' ? next.path : ''
    if (path) openPath(path)
  }

  /**
   * 聚焦视图的当前条目：优先从作品库拿完整 `{ image, item }`，拿不到时用栈项兜底
   * （「对比原图 / 重新生成」会因缺 item 降级，由下面的按需回填 effect 补救）。
   */
  function focusEntryOfPath() {
    if (!focus) return null
    const found = libraryEntryOf(focus.path)
    if (found) return found
    return {
      image: { path: focus.path, url: focus.url, width: focus.width, height: focus.height },
      item: null,
    }
  }

  /**
   * 聚焦图不在已加载分页时按需回填：/history 尚未刷新完成（新完成任务）或该图在
   * 已加载分页之外，`libraryEntryOf` 都拿不到 item，聚焦卡的「对比原图」不出现、
   * 「重新生成」因缺提示词失败。这里用版本树接口按图片路径把所属条目并入
   * `library.items`（与版本面板同一通道），合并后的重渲染就能拿到完整 `{ image, item }`；
   * 旧宿主没有该路由（404）时 `loadTree` 只降级一次，回到栈项兜底的行为。
   */
  React.useEffect(() => {
    if (!focus) return
    const path = typeof focus.path === 'string' ? focus.path : ''
    if (!path || libraryEntryOf(path)) return
    if (library && typeof library.loadTree === 'function') void library.loadTree(path)
    // library.items 变化（历史刷新 / 树回填落地）后复查一次；gallery 由 items 派生，不单列依赖。
  }, [focus, library.items])

  /** 对比原图：只对有 sourceImage 的派生版本出现，先确保舞台停在这张图，再开关对比层。 */
  function compareFocus(entry) {
    if (!entry || !entry.item || !entry.item.sourceImage) return
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (!ui || typeof ui.setCompareOpen !== 'function') return
    const targetPath = entry.image && typeof entry.image.path === 'string' ? entry.image.path.trim() : ''
    const stagePath = library && library.selected && library.selected.image && typeof library.selected.image.path === 'string'
      ? library.selected.image.path.trim()
      : ''
    if (targetPath && targetPath !== stagePath) {
      openPath(targetPath)
      ui.setCompareOpen(true)
      return
    }
    ui.setCompareOpen(!ui.compareOpen)
  }

  /** 继续涂抹：以这张图为底图打开舞台图片工具（与画廊「重绘编辑」同一入口）。 */
  function continueFocus(entry) {
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (!entry || !actions || typeof actions.openImageTool !== 'function') return
    // 保留助手 Tab：单图聚焦会遮挡线程，退出聚焦 + 不切表单后，提交进度卡就回到视野里。
    const opened = actions.openImageTool('inpaint', entry, { keepPanel: true })
    if (opened && typeof focusClear === 'function') focusClear()
  }

  /** 重新生成：沿用这张作品的提示词与参数再抽一张（组合层的 reroll）。 */
  function regenerateFocus(entry) {
    if (locked) return
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (!entry || !actions || typeof actions.reroll !== 'function') return
    actions.reroll(entry)
  }

  /**
   * M3.5 Phase C：选定这张图继续做变体。把图片路径写进新一轮用户输入，
   * 让 Agent 把它作为参考 / 精修对象；Prompt 发散与 Seed 精修由 Agent 根据事实决定。
   */
  function variantFocus() {
    if (locked || interpreting) return
    const path = typeof focus?.path === 'string' ? focus.path.trim() : ''
    if (!path || isBrokenPath(path)) {
      warnMissing()
      return
    }
    if (typeof focusClear === 'function') focusClear()
    interpret(formatText(t('studio.chat.explore.variantPrompt'), { path }))
  }

  /** 查看大图：确保舞台停在这张图，再打开放大层。 */
  function zoomFocus() {
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (focus && focus.path) openPath(focus.path)
    if (ui && typeof ui.setZoom === 'function') ui.setZoom(true)
  }

  /** 带入参数面板：写表单 → 切回表单模式 → 轻提示；失败时不切换。 */
  function handoff(message) {
    if (locked) return
    if (typeof handoffIntent !== 'function') return
    const result = handoffIntent(message)
    if (!result) return
    if (typeof setMode === 'function') setMode('form')
    // 跨后端兜底（'cross'）时提示已由组合层给出（说明没换模型的原因），这里不再覆盖。
    if (result !== 'cross' && ui && typeof ui.showToast === 'function') {
      ui.showToast(t('studio.chat.intent.handoffDone'))
    }
  }

  /**
   * 舞台图片工具动作镜像记录（`kind='tool'`）：
   * 底图缩略图 + 动作说明（`studio.chat.tool.inpaint|img2img|upscale|outpaint`）
   * + 可选重绘强度胶囊（高清放大没有强度）。
   * 只是界面回放，不进入意图上下文（带 kind 的用户记录会被 intentHistory 跳过）。
   */
  function renderToolSync(message, isNew) {
    const tool = MIRROR_TOOL_IDS.includes(message.tool) ? message.tool : ''
    const title = tool ? t(`studio.chat.tool.${tool}`) : (typeof message.text === 'string' ? message.text : '')
    const strength = tool && message.strength !== undefined && message.strength !== null
      ? strengthLabelOf(t, message.strength)
      : ''
    const path = typeof message.imagePath === 'string' ? message.imagePath : ''
    return (
      <div className={isNew ? 'ofs-msg ofs-tool-sync is-new' : 'ofs-msg ofs-tool-sync'} key={message.id}>
        <div className="ofs-msg-card ofs-tool-sync-card">
          {message.image ? (
            <button
              type="button"
              className="ofs-tool-sync-thumb"
              onClick={() => {
                if (isBrokenPath(path)) {
                  warnMissing()
                  return
                }
                openPath(path)
              }}
              title={title}
              aria-label={title}
            >
              <ThreadImage src={message.image} alt="" onDead={() => markBroken(path)} />
            </button>
          ) : null}
          <div className="ofs-tool-sync-body">
            <span className="ofs-tool-sync-title">{title}</span>
            {strength ? (
              <div className="ofs-tool-sync-chips">
                <span className="ofs-chip ofs-tool-sync-chip">{strength}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  function renderFormSync(message, isNew) {
    const chips = formSyncChips(t, message)
    const prompt = typeof message.text === 'string' ? message.text : ''
    return (
      <div className={isNew ? 'ofs-msg ofs-form-sync is-new' : 'ofs-msg ofs-form-sync'} key={message.id}>
        <div className="ofs-msg-card ofs-form-sync-card">
          <span className="ofs-form-sync-title">{formSyncTitle(t, message.source)}</span>
          {prompt ? <p className="ofs-form-sync-prompt" title={prompt}>{prompt}</p> : null}
          {chips.length > 0 ? (
            <div className="ofs-form-sync-chips">
              {chips.map((chip) => (
                <span className="ofs-chip ofs-form-sync-chip" key={chip.key}>{chip.text}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  /** 通用澄清卡：问题 + 选项 + 「先按当前设置」；多维度时由 ClarifyCard 内部累积选择。 */
  function renderClarify(message) {
    return <ClarifyCard key={message.id} t={t} message={message} resolve={resolveClarify} locked={locked} />
  }

  function renderExploreProgress(progress, showDone = false) {
    if (!progress || typeof progress !== 'object') return null
    const produced = Math.max(0, Number(progress.produced) || 0)
    const maxImages = Math.max(1, Number(progress.maxImages) || 8)
    const exhausted = Boolean(progress.exhausted)
    if (!showDone && produced <= 0 && !exhausted) return null
    const percent = Math.min(100, Math.round((produced / maxImages) * 100))
    return (
      <div className="ofs-explore-progress">
        <div className="ofs-explore-progress-bar" style={{ width: `${percent}%` }} />
        <span className="ofs-explore-progress-label">
          {formatText(t('studio.chat.explore.progress'), { produced, max: maxImages })}
          {showDone && exhausted ? ` · ${t('studio.chat.explore.done')}` : ''}
        </span>
      </div>
    )
  }

  /**
   * M3.5 Phase C：探索方案卡。硬预算（轮数 / 总张数 / 预估费用）是授权的前提，
   * 「开始探索」只在授权后把预算下发给服务端；运行中由「停止生成」随时中止。
   */
  function renderExplore(message) {
    const explore = message.explore
    const start = typeof startExplore === 'function' ? startExplore : () => {}
    const disabled = locked || sending || interpreting || Boolean(explore.exhausted)
    return (
      <div className="ofs-msg-card ofs-intent ofs-intent-explore" key={message.id}>
        <span className="ofs-intent-title">{t('studio.chat.explore.title')}</span>
        <p className="ofs-explore-strategy">{explore.strategy}</p>
        <div className="ofs-explore-budget">
          <span className="ofs-chip ofs-intent-pill">
            {formatText(t('studio.chat.explore.rounds'), { count: explore.maxRounds })}
          </span>
          <span className="ofs-chip ofs-intent-pill">
            {formatText(t('studio.chat.explore.images'), { count: Math.max(1, Number(explore.maxImages) || 8) })}
          </span>
          {explore.estCost ? (
            <span className="ofs-chip ofs-intent-pill is-cost">{explore.estCost}</span>
          ) : null}
        </div>
        {explore.basePrompt ? (
          <p className="ofs-explore-prompt" title={explore.basePrompt}>{explore.basePrompt}</p>
        ) : null}
        {explore.notes ? <p className="ofs-intent-notes">{explore.notes}</p> : null}
        {renderExploreProgress(explore, false)}
        <div className="ofs-intent-actions">
          <button
            type="button"
            className="ofs-btn is-primary ofs-explore-go"
            disabled={disabled}
            onClick={() => start(message.id)}
          >
            {explore.exhausted ? t('studio.chat.explore.done') : t('studio.chat.explore.start')}
          </button>
          <span className="ofs-explore-hint">{t('studio.chat.explore.hint')}</span>
        </div>
      </div>
    )
  }

  function renderIntent(message) {
    if (message.clarify) return renderClarify(message)
    // M3.5 Phase C：探索方案卡走独立渲染（硬预算 / 进度 / 开始探索）。
    if (message.explore) return renderExplore(message)

    // 预览 / 测试可能只给部分 chat 域，缺编辑动作时文本域退化为只读展示。
    const editField = typeof updateIntentField === 'function' ? updateIntentField : () => {}
    const promptValue = typeof message.prompt === 'string' ? message.prompt : ''
    const negativeValue = typeof message.negative === 'string' ? message.negative : ''
    const canGenerate = promptValue.trim().length > 0
    const summary = typeof message.summary === 'string' ? message.summary.trim() : ''
    const showSummary = summary.length > 0 && summary !== promptValue.trim()
    const count = intentCount(message.count)
    const hint = message.modelHint && typeof message.modelHint === 'object' ? message.modelHint : null
    const hintModel = hint ? modelLabelOf(hint.presetId) : ''
    const hintText = hint && hintModel && typeof hint.reason === 'string'
      ? formatText(t('studio.chat.intent.modelHint'), { model: hintModel, reason: hint.reason })
      : ''
    // 提案卡（Agent 产出）：展示推荐模型胶囊与给用户看的补充说明。
    const proposal = message.proposal === true
    const presetLabel = proposal ? modelLabelOf(message.presetId) : ''
    const notes = proposal && typeof message.notes === 'string' ? message.notes.trim() : ''
    // 目标后端按实时 provider 计算（不在历史消息里写死）：同后端 → 按此生成；
    // 跨后端 → 切换到 {后端} 并按此生成。手动切换来源或一步切换完成后，旧卡片按钮也会跟着变。
    const target = proposal
      ? proposalTargetOf(message.presetId, {
          provider: compute && compute.provider,
          presets: compute && Array.isArray(compute.presets) ? compute.presets : undefined,
        })
      : null
    const crossTarget = target && target.kind === 'cross' ? target : null
    const crossLabel = crossTarget ? providerLabelOf(t, crossTarget.targetProvider) : ''
    const crossBlocked = Boolean(crossTarget && target && target.gated && compute && compute.hfTokenConfigured === false)
    const session = compute && compute.session ? compute.session : null
    const sessionProvider = session && typeof session.provider === 'string' && session.provider
      ? session.provider
      : (compute && compute.provider)
    // 当前实例仍在这条目标后端之外运行：提示会先关闭它，而不是笼统说「可能需要冷启动」。
    const crossHot = Boolean(
      crossTarget
      && session
      && ACTIVE_SESSION_STATES.includes(session.state)
      && providerLabelOf(t, sessionProvider) !== crossLabel,
    )
    const crossHintText = crossTarget && crossLabel
      ? (crossHot
        ? formatText(t('studio.chat.intent.crossHot'), {
            from: providerLabelOf(t, sessionProvider),
            to: crossLabel,
          })
        : formatText(t('studio.chat.intent.crossHint'), { provider: crossLabel }))
      : ''
    const generateLabel = crossTarget && crossLabel
      ? formatText(t('studio.chat.intent.switchGenerate'), { provider: crossLabel })
      : t('studio.chat.intent.generate')

    return (
      <div className="ofs-msg-card ofs-intent" key={message.id}>
        <span className="ofs-intent-title">{t('studio.chat.intent.title')}</span>
        {proposal && (presetLabel || message.ratioId) ? (
          <div className="ofs-intent-pills">
            {presetLabel ? <span className="ofs-chip ofs-intent-pill is-model">{presetLabel}</span> : null}
            {message.ratioId ? <span className="ofs-chip ofs-intent-pill">{ratioLabel(t, message.ratioId)}</span> : null}
            {message.seed !== null && message.seed !== undefined ? (
              <span className="ofs-chip ofs-intent-pill">{`${t('studio.meta.seed')} ${message.seed}`}</span>
            ) : null}
          </div>
        ) : null}
        {/* 中文摘要优先：先让用户确认画面对不对，再看真正发给模型的英文提示词。 */}
        {showSummary ? (
          <p className="ofs-intent-summary">
            <span className="ofs-intent-summary-label">{t('studio.chat.intent.summary')}</span>
            {summary}
          </p>
        ) : null}
        {notes ? <p className="ofs-intent-note">{notes}</p> : null}
        {/* 跨后端推荐：说清代价（关闭当前实例 + 冷启动），由用户决定是否一步切换。 */}
        {crossHintText ? (
          <p className="ofs-intent-cross">{crossHintText}</p>
        ) : null}
        {crossBlocked ? (
          <p className="ofs-intent-cross is-blocked">
            {formatText(t('studio.chat.intent.crossGated'), { model: presetLabel || message.presetId })}
          </p>
        ) : null}
        <p className="ofs-intent-edit-hint">{t('studio.chat.intent.editHint')}</p>
        {/* 英文提示词是真正发给模型的内容：直接在卡上改，不必为几个词重新对话。 */}
        <label className="ofs-intent-field">
          <span className="ofs-intent-field-label">{t('studio.chat.intent.promptLabel')}</span>
          <textarea
            className="ofs-intent-prompt"
            rows={2}
            value={promptValue}
            maxLength={LIMITS.prompt.maxChars}
            spellCheck={false}
            disabled={locked}
            aria-label={t('studio.chat.intent.promptLabel')}
            onChange={(event) => editField(message.id, 'prompt', event.target.value)}
          />
        </label>
        {/* 比例来自当前设置或本次解析结果；0.10.0 起不再有风格行。 */}
        <div className="ofs-intent-meta">
          <span>{t('studio.rail.ratio')}</span>
          <span>{ratioLabel(t, message.ratioId)}</span>
        </div>
        {/* 模型建议是弱提示：只说明「换哪个更合适」，不拦着用户按当前模型生成。 */}
        {hintText ? <p className="ofs-intent-model-hint">{hintText}</p> : null}
        {/* 排除项只在该模型/CFG 真正消费负向词时出现；在卡上清空后提交就不带负向词。 */}
        {negativeActive ? (
          <label className="ofs-intent-field">
            <span className="ofs-intent-field-label">{t('studio.chat.intent.negativeLabel')}</span>
            <textarea
              className="ofs-intent-negative"
              rows={2}
              value={negativeValue}
              maxLength={LIMITS.negativePrompt.maxChars}
              placeholder={t('studio.chat.intent.negativePlaceholder')}
              spellCheck={false}
              disabled={locked}
              aria-label={t('studio.chat.intent.negativeLabel')}
              onChange={(event) => editField(message.id, 'negative', event.target.value)}
            />
          </label>
        ) : null}
        {/* 生成张数：四格分段，默认 1 张；值写回消息，提交时进入覆盖项。 */}
        <div className="ofs-intent-qty-row">
          <span className="ofs-intent-qty-label">{t('studio.countShort')}</span>
          <div
            className="ofs-intent-qty"
            role="group"
            aria-label={t('studio.count')}
            style={{ '--ofs-qty-index': String(Math.max(0, COUNT_OPTIONS.indexOf(count))) }}
          >
            <span className="ofs-qty-thumb" aria-hidden="true" />
            {COUNT_OPTIONS.map((option) => (
              <button
                type="button"
                key={option}
                className={option === count ? 'ofs-intent-qty-option is-on' : 'ofs-intent-qty-option'}
                aria-pressed={option === count}
                disabled={locked}
                onClick={() => editField(message.id, 'count', option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        {message.source === 'local' ? <p className="ofs-intent-note">{t('studio.chat.intent.local')}</p> : null}
        {/* 种子默认随机；想对比同一构图时才显式打开，避免跨主题对话被上一张的构图绑住。 */}
        <label className={canLockSeed === false || locked ? 'ofs-intent-lock is-disabled' : 'ofs-intent-lock'}>
          <input
            type="checkbox"
            checked={message.lockSeed === true}
            disabled={canLockSeed === false || locked}
            onChange={() => toggleIntentLockSeed(message.id)}
          />
          <span>{t('studio.chat.intent.lockSeed')}</span>
        </label>
        <div className="ofs-intent-actions">
          <button
            type="button"
            className="ofs-btn is-primary ofs-intent-go"
            onClick={() => generateIntent(message)}
            // 提示词被清空 / 目标后端缺 Token 时不允许提交：先拦下，避免白关一次云端会话。
            disabled={sending || !canGenerate || locked || crossBlocked}
            title={crossBlocked ? formatText(t('studio.chat.intent.crossGated'), { model: presetLabel || message.presetId }) : undefined}
          >
            {sending ? t('studio.generating') : generateLabel}
          </button>
          {/* 次级动作：把确认卡内容写回参数面板，继续精调或批量抽卡。 */}
          <button
            type="button"
            className="ofs-btn is-quiet ofs-intent-handoff"
            onClick={() => handoff(message)}
            disabled={sending || !canGenerate || locked}
          >
            {t('studio.chat.intent.handoff')}
          </button>
        </div>
      </div>
    )
  }

  /**
   * 完成气泡的结果图网格：1~4 张全部展示，不再截断成首图。
   * 单张保持整宽单图的观感；多张用 2 列网格，点击任意一张进入单图聚焦。
   */
  function renderResultGrid(message) {
    const images = gridImagesOf(message)
    if (images.length === 0) return null
    const single = images.length === 1
    const compare = !single && Boolean(compareSets[message.id])
    return (
      <div
        className={`ofs-msg-grid${single ? ' is-single' : ''}${compare ? ' is-compare' : ''}`}
        role="group"
        aria-label={gridLabelOf(t, images.length)}
      >
        {images.map((image, index) => (
          <button
            type="button"
            // key 用图路径：同一任务内不会重复，状态更新后网格也不会整块重挂。
            key={image.path || image.url || index}
            className="ofs-msg-grid-item"
            onClick={() => openGridImage(message, image, index)}
            title={imageMetaOf(t, image) || undefined}
          >
            <ThreadImage
              src={image.url}
              className=""
              alt=""
              onDead={() => markBroken(image.path)}
            />
            {single ? null : <span className="ofs-msg-grid-index" aria-hidden="true">{index + 1}</span>}
          </button>
        ))}
        {single ? null : (
          <div className="ofs-msg-grid-tools">
            <span className="ofs-msg-grid-label">{gridLabelOf(t, images.length)}</span>
            <button
              type="button"
              className={`ofs-chip ofs-msg-grid-compare${compare ? ' is-on' : ''}`}
              onClick={() => toggleCompareSet(message.id)}
            >
              {compare ? t('studio.chat.explore.grid') : t('studio.chat.explore.compare')}
            </button>
          </div>
        )}
      </div>
    )
  }

  function renderAssistant(message) {
    if (message.kind === 'intent') return renderIntent(message)
    if (message.kind === 'error') {
      return (
        <div className="ofs-msg-card" key={message.id}>
          <p>{message.text}</p>
        </div>
      )
    }
    return (
      <div className="ofs-msg-card" key={message.id}>
        <AgentStepTimeline t={t} message={message} />
        {message.exploreProgress ? renderExploreProgress(message.exploreProgress, true) : null}
        {message.text ? <p>{message.text}</p> : (isWorking(message.stage) ? <p>{t('studio.chat.agent.streaming')}</p> : null)}
        {isWorking(message.stage) ? <span className="ofs-chat-shimmer" aria-hidden="true" /> : null}
        {renderResultGrid(message)}
      </div>
    )
  }

  /** 面包屑：单图聚焦时显示在消息流顶部，点击逐层回退（栈空回到普通线程）。 */
  function renderBreadcrumb() {
    if (!focus) return null
    const label = typeof focusBackLabel === 'string' ? focusBackLabel : ''
    const text = label ? formatText(t('studio.chat.focus.back'), { label }) : t('studio.chat.focus.empty')
    return (
      <div className="ofs-chat-breadcrumb">
        <button type="button" className="ofs-chip ofs-chat-back" onClick={backFromFocus}>
          {`← ${text}`}
        </button>
      </div>
    )
  }

  /**
   * 单图聚焦视图：大图 + 参数胶囊 + 快捷动作。
   * 对比原图只在作品带 sourceImage（派生版本）时出现；其它动作统一交给既有领域动作。
   */
  function renderFocus() {
    if (!focus) return null
    const entry = focusEntryOfPath()
    const image = entry && entry.image ? entry.image : focus
    const src = image && typeof image.url === 'string' && image.url ? image.url : focus.url
    const meta = imageMetaOf(t, {
      seconds: focus.seconds,
      seed: focus.seed,
    })
    const canCompare = Boolean(entry && entry.item && entry.item.sourceImage)
    return (
      <div className="ofs-chat-focus">
        <div className="ofs-chat-focus-head">
          <span className="ofs-chat-focus-title">{t('studio.chat.focus.title')}</span>
          {focus.count > 1 ? <span className="ofs-chip ofs-chat-focus-batch">{gridLabelOf(t, focus.count)}</span> : null}
        </div>
        <div className="ofs-chat-focus-figure">
          <ThreadImage src={src} alt="" onDead={() => markBroken(focus.path)} />
        </div>
        {meta ? (
          <div className="ofs-chat-focus-meta">
            <span className="ofs-chip ofs-chat-focus-chip">{meta}</span>
          </div>
        ) : null}
        <div className="ofs-chat-focus-actions">
          {canCompare ? (
            <button type="button" className="ofs-chip ofs-chat-focus-action" onClick={() => compareFocus(entry)}>
              {t('studio.chat.actions.compare')}
            </button>
          ) : null}
          <button type="button" className="ofs-chip ofs-chat-focus-action" onClick={() => continueFocus(entry)}>
            {t('studio.chat.actions.continueInpaint')}
          </button>
          <button
            type="button"
            className="ofs-chip ofs-chat-focus-action"
            onClick={() => regenerateFocus(entry)}
            // 锁定态不能按旧作品的参数重抽（生成入口统一被锁）；涂抹 / 放大仍走舞台工具。
            disabled={locked}
          >
            {t('studio.chat.actions.regenerate')}
          </button>
          <button
            type="button"
            className="ofs-chip ofs-chat-focus-action is-variant"
            onClick={variantFocus}
            disabled={locked || interpreting}
            title={t('studio.chat.explore.variantHint')}
          >
            {t('studio.chat.explore.variant')}
          </button>
          <button type="button" className="ofs-chip ofs-chat-focus-action" onClick={zoomFocus}>
            {t('studio.chat.actions.zoom')}
          </button>
        </div>
      </div>
    )
  }

  const startNewCreation = form && typeof form.newCreation === 'function'
    ? form.newCreation
    : (actions && typeof actions.newDraft === 'function' ? actions.newDraft : undefined)

  const content = (
    <>
      {embedded ? null : (
        <PanelModeTabs t={t} mode={mode} setMode={setMode} onNewCreation={startNewCreation} />
      )}

      <div
        className={messages.length === 0 && !interpreting ? 'ofs-thread is-empty' : 'ofs-thread'}
        ref={threadRef}
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 && !interpreting ? (
          <div className="ofs-chat-empty">
            <p className="ofs-chat-empty-text">{t('studio.chat.empty')}</p>
            <div className="ofs-chat-examples">
              {INSPIRE_KEYS.map((key) => (
                <button
                  type="button"
                  key={key}
                  className="ofs-chip ofs-chat-example"
                  // 空态示例只填对话草稿：参数由确认卡决定，不越过用户直接改表单。
                  onClick={() => setDraft(t(key))}
                  disabled={locked}
                  title={t(key)}
                >
                  {t(`${key}.label`)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {focus ? (
          <>
            {renderBreadcrumb()}
            {renderFocus()}
          </>
        ) : (
          <>
            {messages.map((message) => {
              const isNew = isNewMessage(message.id)
              if (message.role === 'user') {
                // 表单提交 / 舞台工具镜像走独立卡片，与自然语言用户气泡区分开。
                if (message.kind === 'form') return renderFormSync(message, isNew)
                if (message.kind === 'tool') return renderToolSync(message, isNew)
                return (
                  <div className={isNew ? 'ofs-msg ofs-msg--user is-new' : 'ofs-msg ofs-msg--user'} key={message.id}>
                    <p>{message.text}</p>
                  </div>
                )
              }
              return (
                <div className={isNew ? 'ofs-msg ofs-msg--assistant is-new' : 'ofs-msg ofs-msg--assistant'} key={message.id}>
                  {message.kind === 'intent' || message.kind === 'error' ? null : (
                    <div className="ofs-chat-author">
                      <span className={dotClass(message.stage)} aria-hidden="true" />
                      <span className="ofs-chat-author-name">{t('studio.chat.assistant')}</span>
                    </div>
                  )}
                  {renderAssistant(message)}
                </div>
              )
            })}

            {interpreting && !streamingAgent ? (
              <div className="ofs-msg ofs-msg--assistant is-new">
                <div className="ofs-msg-card is-working">
                  <p>{t('studio.chat.parsing')}</p>
                  <span className="ofs-chat-shimmer" aria-hidden="true" />
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div
        className={refDragKind ? 'ofs-chat-dock is-ref-drop' : 'ofs-chat-dock'}
        onDragEnter={onDockDragEnter}
        onDragOver={onDockDragOver}
        onDragLeave={onDockDragLeave}
        onDrop={onDockDrop}
      >
        {/* 导入图锁定态：提示与「新建创作」出口放在禁用区之外，保证随时可逃逸。 */}
        {locked ? (
          <div className="ofs-lock-hint is-chat" role="note">
            <div className="ofs-lock-head">
              <Icon name="image" size={12} />
              <span className="ofs-lock-title">{t('studio.lock.title')}</span>
              <button
                type="button"
                className="ofs-lock-action"
                onClick={() => {
                  if (typeof startNewCreation === 'function') startNewCreation()
                }}
              >
                <Icon name="plus" size={11} />
                {t('studio.rail.newCreation')}
              </button>
            </div>
            <p className="ofs-lock-body">{t('studio.lock.chatHint')}</p>
          </div>
        ) : null}
        <div className="ofs-chat-tools">
          {/* 语义是「开一个新话题」，不是删记录：清空线程并复位请求中状态。
              锁定期间必须保留已有消息，因此「新建对话」也一并禁用；
              中断按钮留在禁用区外——切换作品不该让在途请求失去停止入口。 */}
          <button
            type="button"
            className="ofs-chip ofs-chat-new"
            onClick={startNewChat}
            disabled={messages.length === 0 || locked}
          >
            {t('studio.chat.newChat')}
          </button>
          {streamingAgent && typeof stopAgent === 'function' ? (
            <button type="button" className="ofs-chip ofs-chat-stop" onClick={stopAgent}>
              {t('studio.chat.agent.stop')}
            </button>
          ) : null}
        </div>

        <div className="ofs-chat-refs-wrap" inert={locked ? true : undefined} aria-disabled={locked ? 'true' : undefined}>
          <ChatReferenceBar
            t={t}
            references={references}
            referenceMax={referenceMax}
            works={library && Array.isArray(library.gallery) ? library.gallery : []}
            busy={referenceBusy}
            referenceSupported={referenceSupported}
            referenceSwitchLabel={referenceSwitchLabel}
            actions={actions}
          />
          {refDragKind ? (
            <p className="ofs-chat-refs-drop" role="status">
              <Icon name={refDragKind === 'work' ? 'images' : 'plus'} size={12} />
              <span>{refDragKind === 'work' ? t('studio.drag.dropReferenceWork') : t('studio.drag.dropReferenceFile')}</span>
            </p>
          ) : null}
        </div>

        <div
          className={locked ? 'ofs-chat-composer is-locked' : 'ofs-chat-composer'}
          inert={locked ? true : undefined}
          aria-disabled={locked ? 'true' : undefined}
        >
          <textarea
            rows={2}
            value={draft}
            maxLength={LIMITS.prompt.maxChars}
            placeholder={t('studio.chat.placeholder')}
            aria-label={t('studio.chat.placeholder')}
            spellCheck={false}
            disabled={locked}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              // 中文输入法确认候选词时的回车不算发送。
              if (event.nativeEvent && event.nativeEvent.isComposing) return
              event.preventDefault()
              send()
            }}
          />
          <button
            type="button"
            className="ofs-chat-send"
            onClick={send}
            disabled={sending || interpreting || draft.trim().length === 0 || locked}
            aria-label={t('studio.chat.send')}
            title={t('studio.chat.send')}
          >
            <Icon name="arrowUp" size={15} />
          </button>
        </div>
      </div>
    </>
  )

  if (embedded) return content
  return <aside className="ofs-panel ofs-panel--chat">{content}</aside>
}
