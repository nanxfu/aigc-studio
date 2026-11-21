/**
 * 对话线程域：消息列表、单轨 Agent 对话、澄清卡 / 提案卡与助手气泡同步。
 *
 * 单轨（Phase B）：不再有「快速填卡 / Agent 对话」双模式。所有输入统一走
 * `POST /api/agent/chat`：
 *  - 配置了模型时由 `pi-agent-core` 驱动多轮工具循环；
 *  - 未配置模型时服务端用本地规则返回同一张提案卡（静默降级，不报错）。
 *
 * 事件 → 消息映射：
 *  - `text-delta` / `reasoning-delta`：正文与思考过程（思考进折叠时间线）；
 *  - `tool-start` / `tool-result`：工具步骤胶囊；
 *  - `proposal`：把当前助手气泡升级为「生图确认卡」（复用 intent 卡的渲染与提交路径）；
 *  - `clarify`：渲染澄清卡（支持多维度多选）；
 *  - `job-bound`：追加/绑定真实任务气泡，由任务状态 effect 继续推进进度；
 *  - `done`：收口；若已产出 proposal / clarify 则挂起等待用户交互。
 *
 * 结果网格与单图聚焦（阶段十五 Phase A2）保持原样：气泡收全部 1~4 张结果图，
 * 点击某张进入单图聚焦；聚焦只影响视图，**不改 messages**。
 */

import React from 'react'

import { streamAgentChat } from '../../api/resources.js'
import { stateJobs } from '../../logic/jobs.js'
import { errorText } from '../../logic/error.js'
import {
  bubblePatch,
  bubbleUnchanged,
  currentFocusOf,
  focusBackLabelOf,
  focusEntryOf,
  gridImagesOf,
  mirrorToolEntries,
  popFocus,
  pushFocus,
} from '../../logic/chat.js'
import {
  INTENT_EDITABLE_FIELDS,
  intentCount,
  intentFieldPatch,
  intentFormPatch,
  intentModelHint,
  intentNegative,
  intentOverrides,
  intentRatio,
  intentSeedOf,
  lastSeedOf,
} from '../../logic/intent.js'
import { DEFAULT_RATIOS } from '../presets.js'

/** 提案卡上的 presetId 必须真实存在（未知值丢弃，回落到当前表单模型）。 */
function proposalPresetOf(presetId, presets) {
  const id = typeof presetId === 'string' ? presetId.trim() : ''
  if (!id) return ''
  const list = Array.isArray(presets) ? presets : []
  return list.some((item) => item && item.id === id) ? id : ''
}

/** 澄清卡归一：服务端可能给 dimensions（新）或 options（兼容），两者都保留。 */
function clarifyOf(event) {
  const question = typeof event?.question === 'string' ? event.question.trim() : ''
  if (!question) return null
  const dimensions = Array.isArray(event?.dimensions)
    ? event.dimensions
      .filter((dimension) => dimension && Array.isArray(dimension.options) && dimension.options.length > 0)
      .map((dimension, index) => ({
        id: typeof dimension.id === 'string' && dimension.id ? dimension.id : `d${index + 1}`,
        label: typeof dimension.label === 'string' && dimension.label ? dimension.label : question,
        multi: dimension.multi === true,
        options: dimension.options
          .map((option) => {
            const label = typeof option === 'string' ? option : String(option?.label ?? option?.value ?? '').trim()
            const value = typeof option === 'string' ? option : String(option?.value ?? label).trim()
            return label ? { label, value: value || label } : null
          })
          .filter(Boolean),
      }))
      .filter((dimension) => dimension.options.length > 0)
    : []
  const options = Array.isArray(event?.options)
    ? event.options.map((item) => String(item ?? '').trim()).filter(Boolean)
    : dimensions[0]
      ? dimensions[0].options.map((option) => option.label)
      : []
  if (dimensions.length === 0 && options.length < 2) return null
  // 澄清卡的「先按当前设置」兜底：服务端给了草稿就一并带上，点按钮直接还原成提案卡。
  const draft = event?.draft && typeof event.draft === 'object' && typeof event.draft.prompt === 'string' && event.draft.prompt.trim()
    ? {
        prompt: event.draft.prompt.trim(),
        summaryZh: typeof event.draft.summaryZh === 'string' ? event.draft.summaryZh : '',
        negativePrompt: typeof event.draft.negativePrompt === 'string' ? event.draft.negativePrompt : '',
        presetId: typeof event.draft.presetId === 'string' ? event.draft.presetId : '',
        ratioId: typeof event.draft.ratioId === 'string' ? event.draft.ratioId : '',
        count: Number.isFinite(Number(event.draft.count)) ? Number(event.draft.count) : 1,
      }
    : null
  return {
    question,
    options,
    ...(dimensions.length > 0 ? { dimensions } : {}),
    ...(draft ? { draft } : {}),
  }
}

export function useChatThread({ t, isEn, alive, state, form, generate, getStage, onAgentDone }) {
  const [messages, setMessages] = React.useState([])
  const [interpreting, setInterpreting] = React.useState(false)
  const [streamingAgent, setStreamingAgent] = React.useState(false)
  const agentAbortRef = React.useRef(null)
  const onAgentDoneRef = React.useRef(onAgentDone)
  onAgentDoneRef.current = onAgentDone
  const getStageRef = React.useRef(getStage)
  getStageRef.current = getStage
  // 单图聚焦返回栈：栈顶就是当前聚焦的图，空栈表示普通线程视图。
  const [focusStack, setFocusStack] = React.useState([])
  const messageSeq = React.useRef(0)
  // 同一 tick 内连按两次回车时，用 ref 挡住第二次请求。
  const interpretingRef = React.useRef(false)
  // 线程代次：每次「新建对话」自增。请求发出时记下代次，返回时对不上就整条丢弃，
  // 保证旧请求永远不会写进新线程。
  const threadSeq = React.useRef(0)
  // 聚焦栈在事件回调用 ref 读最新值：同一个 tick 内连续聚焦 / 返回时 state 还没提交。
  const focusRef = React.useRef(focusStack)
  focusRef.current = focusStack
  const focus = currentFocusOf(focusStack)

  // 助手气泡跟着任务状态走，只反映真实进度。
  const jobs = stateJobs(state)
  const threadJobs = jobs.length > 0 ? jobs : (state && state.lastJob ? [state.lastJob] : [])
  const threadKey = threadJobs.map((job) => `${job.id}:${job.status}`).join('|')
  React.useEffect(() => {
    if (messages.length === 0 || threadJobs.length === 0) return
    setMessages((prev) => {
      let next = prev
      for (const job of threadJobs) {
        const index = prev.map((item) => item.jobId).lastIndexOf(job.id)
        if (index < 0) continue
        const current = (next === prev ? prev : next)[index]
        const patch = bubblePatch(t, job, current)
        if (!patch) continue
        if (bubbleUnchanged(current, patch)) continue
        if (next === prev) next = prev.slice()
        next[index] = { ...current, ...patch }
      }
      return next
    })
  }, [threadKey])

  function pushMessages(entries) {
    setMessages((prev) => [...prev, ...entries.map((entry) => ({ id: (messageSeq.current += 1), ...entry }))])
  }

  /** 把当前消息流转换为 /api/agent/chat 需要的纯净对话历史。 */
  function agentMessagesFor(list, nextUserText) {
    const out = []
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'object') continue
      if (item.kind === 'form' || item.kind === 'tool' || item.kind === 'job' || item.kind === 'error') continue
      if (item.role === 'user' && typeof item.text === 'string' && item.text.trim()) {
        out.push({ role: 'user', content: item.text.trim() })
        continue
      }
      if (item.role === 'assistant') {
        const question = item.clarify && typeof item.clarify.question === 'string' ? item.clarify.question.trim() : ''
        const content = item.kind === 'intent'
          ? (typeof item.summary === 'string' && item.summary.trim()
            ? item.summary.trim()
            : (typeof item.prompt === 'string' && item.prompt.trim()) || (question ? `[Clarify] ${question}` : ''))
          : (typeof item.text === 'string' ? item.text.trim() : '')
        if (content) out.push({ role: 'assistant', content })
      }
    }
    out.push({ role: 'user', content: nextUserText })
    return out
  }

  function stopAgent() {
    if (agentAbortRef.current) {
      agentAbortRef.current.abort()
      agentAbortRef.current = null
    }
  }

  /**
   * 单轨对话：所有输入都走 /api/agent/chat。
   *
   * 服务端在未配置模型时返回本地兜底提案卡；客户端不需要分支，也不需要模式开关。
   */
  async function interpret(text) {
    const value = String(text ?? '').trim()
    if (!value || interpreting || interpretingRef.current) return
    clearFocus()
    interpretingRef.current = true
    const generation = threadSeq.current

    const apiMessages = agentMessagesFor(messages, value)
    const userId = (messageSeq.current += 1)
    const assistantId = (messageSeq.current += 1)
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text: value },
      {
        id: assistantId,
        role: 'assistant',
        kind: 'agent',
        stage: 'running',
        text: '',
        reasoning: '',
        tools: [],
        images: [],
      },
    ])
    setInterpreting(true)
    setStreamingAgent(true)
    const controller = new AbortController()
    agentAbortRef.current = controller

    const updateAssistant = (updater) => {
      if (generation !== threadSeq.current) return
      setMessages((prev) => prev.map((msg) => (msg && msg.id === assistantId ? updater(msg) : msg)))
    }

    // 提案卡落地：复用 intent 卡（kind='intent'）的渲染与「按此生成 / 带入参数面板」路径。
    const applyProposal = (event) => {
      const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
      if (!prompt) return
      updateAssistant((msg) => ({
        ...msg,
        kind: 'intent',
        stage: 'done',
        proposal: true,
        prompt,
        summary: typeof event.summaryZh === 'string' ? event.summaryZh : '',
        ratioId: intentRatio(event.ratioId),
        negative: intentNegative(event.negativePrompt ?? event.negative),
        count: intentCount(event.count),
        // 注意 Number(null) === 0：null 必须保持「没有固定种子」。
        seed: event.seed === null || event.seed === undefined || event.seed === ''
          ? null
          : (Number.isFinite(Number(event.seed)) && Number(event.seed) >= 0 ? Math.trunc(Number(event.seed)) : null),
        presetId: proposalPresetOf(event.presetId, state && state.presets),
        // Agent 选好的像素尺寸（可选）：提交时优先于旧模型的画幅。
        width: event.width === null || event.width === undefined || event.width === ''
          ? null
          : (Number.isFinite(Number(event.width)) && Number(event.width) > 0 ? Math.round(Number(event.width)) : null),
        height: event.height === null || event.height === undefined || event.height === ''
          ? null
          : (Number.isFinite(Number(event.height)) && Number(event.height) > 0 ? Math.round(Number(event.height)) : null),
        notes: typeof event.notes === 'string' ? event.notes : '',
        lockSeed: false,
        clarify: null,
        source: event.source === 'local' ? 'local' : 'agent',
        // 模型建议沿用旧字段：服务端已经过滤过 provider，这里再做一次归一。
        modelHint: intentModelHint(event.modelHint, form.form.presetId, {
          provider: state && typeof state.provider === 'string' ? state.provider : undefined,
        }),
      }))
    }

    const applyClarify = (event) => {
      const clarify = clarifyOf(event)
      if (!clarify) return
      updateAssistant((msg) => ({
        ...msg,
        kind: 'intent',
        stage: 'done',
        proposal: false,
        prompt: '',
        summary: '',
        clarify,
      }))
    }

    const bindJob = (event) => {
      const jobId = typeof event.jobId === 'string' ? event.jobId.trim() : ''
      if (!jobId) return
      if (generation !== threadSeq.current) return
      setMessages((prev) => {
        if (prev.some((msg) => msg && msg.jobId === jobId)) return prev
        return [...prev, {
          id: (messageSeq.current += 1),
          role: 'assistant',
          kind: 'job',
          jobId,
          stage: 'pending',
          text: t('studio.chat.pending'),
          presetId: typeof event.presetId === 'string' ? event.presetId : '',
          prompt: typeof event.prompt === 'string' ? event.prompt : '',
        }]
      })
    }

    const result = await alive(streamAgentChat({
      messages: apiMessages,
      locale: isEn ? 'en' : 'zh',
      presetId: form.form.presetId,
      cfg: form.form.cfg,
      stage: typeof getStageRef.current === 'function' ? getStageRef.current() : undefined,
      signal: controller.signal,
      onEvent(event) {
        if (generation !== threadSeq.current) return
        if (event.type === 'text-delta' && typeof event.text === 'string') {
          updateAssistant((msg) => ({ ...msg, text: `${msg.text || ''}${event.text}` }))
        } else if (event.type === 'text' && typeof event.text === 'string') {
          updateAssistant((msg) => ({ ...msg, text: event.text }))
        } else if (event.type === 'reasoning-delta' && typeof event.text === 'string') {
          updateAssistant((msg) => ({ ...msg, reasoning: `${msg.reasoning || ''}${event.text}` }))
        } else if (event.type === 'tool-start') {
          updateAssistant((msg) => ({
            ...msg,
            tools: [...(Array.isArray(msg.tools) ? msg.tools : []), {
              id: event.toolCallId || `${event.name}-${(msg.tools || []).length}`,
              name: event.name,
              status: 'running',
            }],
          }))
        } else if (event.type === 'tool-result') {
          const incomingImages = Array.isArray(event.images) ? event.images : []
          updateAssistant((msg) => {
            const tools = Array.isArray(msg.tools) ? msg.tools.slice() : []
            const idx = tools.findLastIndex((tool) => (
              event.toolCallId ? tool.id === event.toolCallId : tool.name === event.name && tool.status === 'running'
            ))
            if (idx >= 0) tools[idx] = { ...tools[idx], status: event.ok ? 'done' : 'failed' }
            const existing = Array.isArray(msg.images) ? msg.images : []
            const seen = new Set(existing.map((img) => img.path || img.url))
            const merged = [...existing]
            for (const img of incomingImages) {
              const key = img && (img.path || img.url)
              if (key && !seen.has(key)) {
                seen.add(key)
                merged.push(img)
              }
            }
            return { ...msg, tools, images: merged }
          })
        } else if (event.type === 'proposal') {
          applyProposal(event)
        } else if (event.type === 'clarify') {
          applyClarify(event)
        } else if (event.type === 'job-bound') {
          bindJob(event)
        }
      },
    }))

    if (agentAbortRef.current === controller) agentAbortRef.current = null
    if (generation !== threadSeq.current) return
    interpretingRef.current = false
    setInterpreting(false)
    setStreamingAgent(false)
    if (!result) return

    if (result.ok) {
      const done = result.data || {}
      // 非流式 / 代理吞掉 SSE 时只有 done：用 done.pending 补齐卡片（与事件路径同一份数据）。
      if (done.pending && typeof done.pending === 'object') {
        if (done.pending.type === 'proposal') applyProposal(done.pending)
        else if (done.pending.type === 'clarify') applyClarify(done.pending)
      }
      const doneImages = Array.isArray(done.images) ? done.images : []
      updateAssistant((msg) => {
        // 已产出卡片：保留卡片形态，不把 done 的兜底文案盖到卡片上。
        if (msg.kind === 'intent') return { ...msg, stage: 'done' }
        const text = (typeof done.text === 'string' && done.text) || msg.text || ''
        const merged = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : doneImages
        return {
          ...msg,
          stage: 'done',
          text: text || (merged.length > 0 ? '' : t('studio.chat.agent.toolDone')),
          images: merged,
        }
      })
      if (typeof onAgentDoneRef.current === 'function') {
        onAgentDoneRef.current({ images: doneImages, pending: done.pending ?? null })
      }
      return
    }

    if (result.code === 'llm_aborted') {
      updateAssistant((msg) => ({ ...msg, stage: 'done' }))
      return
    }
    updateAssistant((msg) => ({
      ...msg,
      stage: 'failed',
      text: msg.text || errorText(t, result),
    }))
  }

  /**
   * 澄清卡：
   * - 选项非空 → 把选项当作新一轮用户输入，带完整线程上下文重新请求（单轨 Agent）；
   * - 空串（「先按当前设置」）→ 有草稿就还原成提案卡（不消耗 Token），没有草稿时只清掉澄清。
   *
   * 重新解析前先移除旧澄清卡：选完就应得到新一轮结果，线程里不该同时留着两张卡。
   */
  function resolveClarify(messageId, option) {
    const value = typeof option === 'string' ? option.trim() : ''
    if (!value) {
      setMessages((prev) => prev.map((message) => {
        if (!message || message.id !== messageId) return message
        const draft = message.clarify && message.clarify.draft ? message.clarify.draft : null
        if (!draft || typeof draft.prompt !== 'string' || !draft.prompt.trim()) {
          return { ...message, clarify: null, kind: message.prompt ? 'intent' : 'agent' }
        }
        // 服务端给了草稿：直接转成可编辑的提案卡，「跳过澄清」也不必再跑一轮 LLM。
        return {
          ...message,
          kind: 'intent',
          proposal: true,
          stage: 'done',
          clarify: null,
          prompt: draft.prompt,
          summary: draft.summaryZh || '',
          ratioId: intentRatio(draft.ratioId),
          negative: intentNegative(draft.negativePrompt),
          count: intentCount(draft.count),
          seed: null,
          presetId: proposalPresetOf(draft.presetId, state && state.presets),
          notes: '',
          lockSeed: false,
          source: 'agent',
          modelHint: null,
        }
      }))
      return
    }
    setMessages((prev) => prev.filter((message) => !(message && message.id === messageId)))
    interpret(value)
  }

  /**
   * 意图 / 提案卡行内微调：只接受白名单字段（提示词 / 排除项 / 生成张数），
   * 按契约裁剪后写回消息。比例仍由当前设置或重新解析决定，这里不开放。
   */
  function updateIntent(messageId, patch) {
    const source = patch && typeof patch === 'object' ? patch : {}
    const next = {}
    for (const field of INTENT_EDITABLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) continue
      const applied = intentFieldPatch(field, source[field])
      if (applied) next[field] = applied[field]
    }
    if (Object.keys(next).length === 0) return
    setMessages((prev) => prev.map((message) => (
      message && message.id === messageId ? { ...message, ...next } : message
    )))
  }

  /** 单个字段编辑：textarea / 张数分段控件的 onChange 走这里。 */
  function updateIntentField(messageId, field, value) {
    updateIntent(messageId, { [field]: value })
  }

  /**
   * 生成提案卡：先落表单，再按卡片参数提交。
   *
   * 覆盖项 = 编辑后的提示词、张数、比例尺寸、负向词（仅当前模型/CFG 消费负向词时取卡上值）、
   * 卡片推荐的模型与种子策略；提示词为空时按钮置灰、这里也再拦一次。
   */
  async function generateIntent(message) {
    const negativeActive = form.negativeActive === true
    const overrides = intentOverrides(message, { negativeActive })
    if (!overrides) return
    const ratio = DEFAULT_RATIOS.find((item) => item.id === message.ratioId)
    if (ratio) {
      overrides.width = ratio.width
      overrides.height = ratio.height
    } else {
      // 提案卡直接给了像素尺寸（Agent 按模型能力选的）时优先采用，避免沿用旧模型的画幅。
      const cardWidth = Number(message.width)
      const cardHeight = Number(message.height)
      if (Number.isFinite(cardWidth) && cardWidth > 0 && Number.isFinite(cardHeight) && cardHeight > 0) {
        overrides.width = Math.round(cardWidth)
        overrides.height = Math.round(cardHeight)
      }
    }
    // 提案卡推荐了模型时用推荐值（仍需真实存在）；与当前表单一致时不重复写进请求体。
    const preset = proposalPresetOf(message.presetId, state && state.presets)
    if (preset && preset !== form.form.presetId) {
      overrides.presetId = preset
      // 换模型必须同时带上新模型的推荐步数 / CFG：generate 读到的表单还是旧模型的参数，
      // 不带这两项会把 SDXL 的 4 步 / CFG 0 套到 Flux 之类的模型上。
      const target = (Array.isArray(state && state.presets) ? state.presets : []).find((item) => item && item.id === preset)
      if (target) {
        if (Number.isFinite(Number(target.steps))) overrides.steps = Number(target.steps)
        if (Number.isFinite(Number(target.cfg))) overrides.cfg = Number(target.cfg)
        if (!ratio && !Number.isFinite(Number(message.width)) && Number.isFinite(Number(target.size))) {
          overrides.width = Number(target.size)
          overrides.height = Number(target.size)
        }
      }
    }
    // 卡片显式给了固定种子才沿用；否则默认随机，避免跨主题构图僵化。
    // 注意 Number(null) === 0：null / 空串必须先按「没有种子」处理。
    const rawSeed = message.seed
    const cardSeed = rawSeed === null || rawSeed === undefined || rawSeed === '' ? NaN : Number(rawSeed)
    if (Number.isFinite(cardSeed) && cardSeed >= 0) overrides.seed = Math.trunc(cardSeed)
    const seed = intentSeedOf(message, state && state.lastJob, form.form.seed)
    if (!Number.isFinite(cardSeed) && seed !== null) overrides.seed = seed
    // 确认卡提交前若左栏有未提交修改或正在编辑托管草稿，先托管进草稿卡再覆写表单。
    if ((form.dirty || form.draftEditing) && typeof form.parkDraft === 'function') {
      form.parkDraft()
    }
    // 先切模型（会同步 formRef），再把卡片字段合并进表单：两步都走 formRef，后一步不会覆盖前一步。
    if (preset && preset !== form.form.presetId && typeof form.selectPreset === 'function') {
      form.selectPreset(preset)
    }
    const patch = intentFormPatch(message, DEFAULT_RATIOS, { negativeActive })
    if (Object.keys(patch).length > 0) form.patchForm(patch)
    if (typeof form.clearOrigin === 'function') form.clearOrigin()
    const ok = await generate(overrides, { pushUser: false, source: 'assistant' })
    // 确认卡提交成功后表单就是这次生成的内容：补记干净基准。
    if (ok && typeof form.markClean === 'function') form.markClean()
  }

  /**
   * 带入参数面板：把卡片内容写进表单（提示词 / 宽高 / 张数 / 可用时的排除项 / 推荐模型），
   * 切换模式与轻提示由 ChatPanel 负责。返回是否成功。
   */
  function handoffIntent(message) {
    if (!message || typeof form.applyIntent !== 'function') return false
    const hasPrompt = typeof message.prompt === 'string' && message.prompt.trim().length > 0
    if (hasPrompt && (form.dirty || form.draftEditing) && typeof form.parkDraft === 'function') {
      form.parkDraft()
    }
    const preset = proposalPresetOf(message.presetId, state && state.presets)
    if (preset && preset !== form.form.presetId && typeof form.selectPreset === 'function') {
      form.selectPreset(preset)
    }
    const applied = Boolean(form.applyIntent(message))
    if (applied && typeof form.clearOrigin === 'function') form.clearOrigin()
    return applied
  }

  /** 卡片上的「沿用上张构图」开关：默认关闭，只改这张卡自己的状态。 */
  function toggleIntentLockSeed(messageId) {
    setMessages((prev) => prev.map((message) => {
      if (!message || message.id !== messageId) return message
      return { ...message, lockSeed: message.lockSeed !== true }
    }))
  }

  /** 点击助手结果网格里的某张图：进入单图聚焦视图（舞台切换由 ChatPanel 调 library.openMessage）。 */
  function focusImage(message, image, index) {
    const entry = focusEntryOf({
      messageId: message && message.id,
      image,
      index,
      count: gridImagesOf(message).length,
    })
    if (!entry) return false
    const next = pushFocus(focusRef.current, entry)
    focusRef.current = next
    setFocusStack(next)
    return true
  }

  /** 返回上一层：出栈并返回新的栈顶（栈空返回 null）。 */
  function focusBack() {
    const next = popFocus(focusRef.current)
    focusRef.current = next
    setFocusStack(next)
    return currentFocusOf(next)
  }

  /** 清空聚焦栈、回到普通线程视图（新建对话 / 发起新一轮对话时用）。 */
  function clearFocus() {
    if (focusRef.current.length === 0) return
    focusRef.current = []
    setFocusStack([])
  }

  /**
   * 舞台图片工具动作镜像（组合层在 `useImageTool.onSubmitted` 里调用）。
   */
  function mirrorTool(input) {
    const entries = mirrorToolEntries(t, input)
    if (entries.length === 0) return false
    pushMessages(entries)
    return true
  }

  /** 新建对话：清空当前线程、聚焦栈与对话上下文。 */
  function newChat() {
    threadSeq.current += 1
    stopAgent()
    interpretingRef.current = false
    setInterpreting(false)
    setStreamingAgent(false)
    setMessages([])
    clearFocus()
  }

  /** 精细化工作区切换（M1.5）：保留纯文字对话与卡片草稿，剔除绑定旧工作区产物的气泡。 */
  function rebaseWorkspace() {
    threadSeq.current += 1
    stopAgent()
    interpretingRef.current = false
    setInterpreting(false)
    setStreamingAgent(false)
    clearFocus()
    setMessages((prev) => prev
      .filter((msg) => msg && msg.kind !== 'form' && msg.kind !== 'tool' && msg.kind !== 'job')
      .map((msg) => {
        if (!msg) return msg
        const hasImages = (Array.isArray(msg.images) && msg.images.length > 0) || Boolean(msg.image)
        if (!hasImages) return msg
        return { ...msg, images: [], image: undefined }
      })
      .filter((msg) => {
        if (!msg) return false
        if (msg.kind === 'intent') return Boolean(msg.prompt || msg.summary || msg.clarify)
        return Boolean(typeof msg.text === 'string' && msg.text.trim())
      }))
  }

  return {
    messages,
    interpreting,
    streamingAgent,
    stopAgent,
    interpret,
    resolveClarify,
    updateIntent,
    updateIntentField,
    generateIntent,
    handoffIntent,
    toggleIntentLockSeed,
    canLockSeed: lastSeedOf(state && state.lastJob) !== null,
    focus,
    focusDepth: focusStack.length,
    focusBackLabel: focusBackLabelOf(t, focusStack),
    focusImage,
    focusBack,
    mirrorTool,
    newChat,
    rebaseWorkspace,
    pushMessages,
  }
}
