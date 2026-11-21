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

import { fetchChatHistory, saveChatHistory, streamAgentChat } from '../../api/resources.js'
import { stateJobs } from '../../logic/jobs.js'
import { errorText } from '../../logic/error.js'
import { formatText } from '../../logic/format.js'
import {
  agentThreadMessages,
  bubblePatch,
  bubbleUnchanged,
  currentFocusOf,
  focusBackLabelOf,
  focusEntryOf,
  gridImagesOf,
  mirrorToolEntries,
  popFocus,
  proposalTargetOf,
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
import { referencePathsOf } from '../../logic/reference.js'
import { providerLabelOf } from '../../logic/status.js'
import { chatMessagesForStore, clearChatSnapshot, readChatSnapshot, writeChatSnapshot } from '../chatSnapshot.js'
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

export function useChatThread({ t, isEn, alive, ui, state, form, generate, getStage, getProviderContext, switchProvider, onAgentDone }) {
  const [messages, setMessages] = React.useState([])
  const [interpreting, setInterpreting] = React.useState(false)
  const [streamingAgent, setStreamingAgent] = React.useState(false)
  const agentAbortRef = React.useRef(null)
  const onAgentDoneRef = React.useRef(onAgentDone)
  onAgentDoneRef.current = onAgentDone
  const getStageRef = React.useRef(getStage)
  getStageRef.current = getStage
  const getProviderContextRef = React.useRef(getProviderContext)
  getProviderContextRef.current = getProviderContext
  const switchProviderRef = React.useRef(switchProvider)
  switchProviderRef.current = switchProvider
  // 单图聚焦返回栈：栈顶就是当前聚焦的图，空栈表示普通线程视图。
  const [focusStack, setFocusStack] = React.useState([])
  const messageSeq = React.useRef(0)
  // 同一 tick 内连按两次回车时，用 ref 挡住第二次请求。
  const interpretingRef = React.useRef(false)
  // 提案卡提交（尤其跨后端要先进设置再提交）同理：挡住连点造成的重复切源 / 重复出图。
  const intentBusyRef = React.useRef(false)
  // 线程代次：每次「新建对话」自增。请求发出时记下代次，返回时对不上就整条丢弃，
  // 保证旧请求永远不会写进新线程。
  const threadSeq = React.useRef(0)
  // 聚焦栈在事件回调用 ref 读最新值：同一个 tick 内连续聚焦 / 返回时 state 还没提交。
  const focusRef = React.useRef(focusStack)
  focusRef.current = focusStack
  const focus = currentFocusOf(focusStack)

  // 对话历史按工作区隔离持久化（M2.7）：
  //  - L1：sessionStorage（同标签页刷新 / 切侧栏瞬时恢复）；
  //  - L2：Host `<workspace>/.aigc-studio/chat.json`（Electron 重启端口变化后仍可跨重启恢复）。
  const workspaceKey = state && state.workspace && typeof state.workspace.current === 'string'
    ? state.workspace.current.trim()
    : ''
  const [hydrated, setHydrated] = React.useState(false)
  // 当前 messages 属于哪个工作区：写入时用它兜底，避免工作区切换的中间帧把旧线程写进新键。
  const messagesWorkspaceRef = React.useRef(workspaceKey)
  const messagesRef = React.useRef(messages)
  messagesRef.current = messages
  const historyLoadSeqRef = React.useRef(0)
  const saveTimerRef = React.useRef(null)
  // 刚从缓存 / 服务端恢复或主动清空的同一数组引用不再回写一次 POST /api/chat，避免无谓写盘。
  const skipArrayRef = React.useRef(null)

  /** 恢复历史后把消息序号推到已用最大值之后，避免新消息 id 与持久化记录撞车。 */
  function syncMessageSeq(list) {
    let maxId = messageSeq.current
    for (const message of Array.isArray(list) ? list : []) {
      const id = message && typeof message.id === 'number' ? message.id : 0
      if (id > maxId) maxId = id
    }
    messageSeq.current = maxId
  }

  function clearSaveTimer() {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }

  /** 从 Host 拉取当前工作区落盘的对话历史（只在本地线程仍为空且工作区未切走时恢复）。 */
  async function loadServerHistory(targetWorkspace) {
    const target = typeof targetWorkspace === 'string' ? targetWorkspace.trim() : ''
    if (!target) return
    const loadSeq = (historyLoadSeqRef.current += 1)
    const startThreadSeq = threadSeq.current
    const result = await alive(fetchChatHistory())
    if (!result || !result.ok || !result.data || !Array.isArray(result.data.messages)) return
    if (historyLoadSeqRef.current !== loadSeq) return
    if (messagesWorkspaceRef.current !== target) return
    if (threadSeq.current !== startThreadSeq) return
    if (result.data.workspace && result.data.workspace !== target) return
    if (messagesRef.current.length > 0) return
    const loaded = chatMessagesForStore(result.data.messages)
    if (loaded.length === 0) return
    skipArrayRef.current = loaded
    syncMessageSeq(loaded)
    setMessages(loaded)
    writeChatSnapshot({ workspace: target, messages: loaded })
  }

  React.useEffect(() => () => clearSaveTimer(), [])

  React.useEffect(() => {
    if (hydrated) return
    // 宿主首帧快照可能还没到（state=null）：等 workspace.current 出现再做一次性恢复，
    // 否则会把「空工作区标识」误当成最终答案，之后再也恢复不了历史。
    if (!workspaceKey) return
    const saved = readChatSnapshot(workspaceKey)
    messagesWorkspaceRef.current = workspaceKey
    if (Array.isArray(saved) && saved.length > 0) {
      skipArrayRef.current = saved
      syncMessageSeq(saved)
      setMessages(saved)
    } else {
      skipArrayRef.current = messagesRef.current
      void loadServerHistory(workspaceKey)
    }
    setHydrated(true)
  }, [workspaceKey, hydrated])

  React.useEffect(() => {
    if (!hydrated) return
    const owner = messagesWorkspaceRef.current
    if (!owner || owner !== workspaceKey) return
    writeChatSnapshot({ workspace: owner, messages })
    if (skipArrayRef.current === messages) {
      skipArrayRef.current = null
      return
    }
    if (interpreting || streamingAgent) return
    clearSaveTimer()
    const payload = chatMessagesForStore(messages)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      if (messagesWorkspaceRef.current !== owner) return
      void saveChatHistory(payload)
    }, 250)
  }, [messages, workspaceKey, hydrated, interpreting, streamingAgent])

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

  /**
   * 把当前消息流转换为 /api/agent/chat 需要的纯净对话历史。
   *
   * 纯逻辑在 `logic/chat.js` 的 `agentThreadMessages`：会跳过展示型气泡（表单同步 / 工具镜像 /
   * 任务 / 错误），并把 Agent 直调工具生成的图片路径以一行摘要回写，下一轮才能接着说「把它放大」。
   */
  function agentMessagesFor(list, nextUserText) {
    return agentThreadMessages(list, nextUserText)
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
      // 参考图槽与舞台焦点分开发送（M2.7）：服务端据此判断当前模型能否接参考、要不要建议改选。
      references: referencePathsOf(form.form.references),
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

  /** 轻提示：统一走组合层注入的 ui（旧宿主 / 测试替身缺 ui 时静默跳过）。 */
  function notify(key, params) {
    if (!ui || typeof ui.showToast !== 'function') return
    ui.showToast(formatText(t(key), params))
  }

  /** 组合层实时状态：当前 provider / 在途任务 / HF Token（都是判断跨后端的必要事实）。 */
  function providerContext() {
    const value = typeof getProviderContextRef.current === 'function'
      ? getProviderContextRef.current()
      : null
    return value && typeof value === 'object' ? value : {}
  }

  /** 预设展示名（提示语用）；未知 id 原样返回。 */
  function presetLabelOfId(presetId) {
    const preset = (Array.isArray(state && state.presets) ? state.presets : [])
      .find((item) => item && item.id === presetId)
    return preset ? (preset.label || preset.id) : (typeof presetId === 'string' ? presetId : '')
  }

  /**
   * 提案卡提交入口：加一道重入护栏，防止连点重复切后端 / 重复提交。
   * 真正的参数计算与跨后端流转在 `submitIntent`。
   */
  async function generateIntent(message) {
    if (intentBusyRef.current) return false
    intentBusyRef.current = true
    try {
      return await submitIntent(message)
    } finally {
      intentBusyRef.current = false
    }
  }

  /**
   * 生成提案卡：先落表单，再按卡片参数提交。
   *
   * 覆盖项 = 编辑后的提示词、张数、比例尺寸、负向词（仅当前模型/CFG 消费负向词时取卡上值）、
   * 卡片推荐的模型与种子策略；提示词为空时按钮置灰、这里也再拦一次。
   *
   * M2.7 跨后端一步到位：卡片模型只能在另一个已配置后端运行时，先做三道前置检查
   * （在途任务 / gated Token / 切换设置），再切 provider → 切预设 → 提交；
   * 任一步失败立即中止，不发无效生图请求。
   */
  async function submitIntent(message) {
    const negativeActive = form.negativeActive === true
    const overrides = intentOverrides(message, { negativeActive })
    if (!overrides) return false
    const context = providerContext()
    const target = proposalTargetOf(message.presetId, {
      provider: context.provider,
      presets: state && state.presets,
    })
    if (target.kind === 'cross') {
      if (context.activeJob) {
        notify('studio.chat.intent.crossBusy')
        return false
      }
      if (target.gated && context.hfTokenConfigured === false) {
        notify('studio.chat.intent.crossGated', { model: presetLabelOfId(target.presetId) })
        return false
      }
      const switched = typeof switchProviderRef.current === 'function'
        ? await switchProviderRef.current(target.targetProvider)
        : false
      if (!switched) {
        notify('studio.chat.intent.crossFailed', { provider: providerLabelOf(t, target.targetProvider) })
        return false
      }
    }
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
    // 旧宿主 / 快照尚未刷新时 `state.presets` 可能缺这个 id，退一步用同一份模型资产里的定义。
    const preset = proposalPresetOf(message.presetId, state && state.presets)
      || (target.preset && typeof target.preset.id === 'string' ? target.preset.id : '')
    if (preset && preset !== form.form.presetId) {
      overrides.presetId = preset
      // 换模型必须同时带上新模型的推荐步数 / CFG：generate 读到的表单还是旧模型的参数，
      // 不带这两项会把 SDXL 的 4 步 / CFG 0 套到 Flux 之类的模型上。
      const presetInfo = (Array.isArray(state && state.presets) ? state.presets : []).find((item) => item && item.id === preset)
        || (target.preset && target.preset.id === preset ? target.preset : null)
      if (presetInfo) {
        if (Number.isFinite(Number(presetInfo.steps))) overrides.steps = Number(presetInfo.steps)
        if (Number.isFinite(Number(presetInfo.cfg))) overrides.cfg = Number(presetInfo.cfg)
        if (!ratio && !Number.isFinite(Number(message.width)) && Number.isFinite(Number(presetInfo.size))) {
          overrides.width = Number(presetInfo.size)
          overrides.height = Number(presetInfo.size)
        }
      }
    }
    // 卡片显式给了固定种子才沿用；否则默认随机，避免跨主题构图僵化。
    // 注意 Number(null) === 0：null / 空串必须先按「没有种子」处理。
    const rawSeed = message.seed
    const cardSeed = rawSeed === null || rawSeed === undefined || rawSeed === '' ? NaN : Number(rawSeed)
    if (Number.isFinite(cardSeed) && cardSeed >= 0) {
      overrides.seed = Math.trunc(cardSeed)
    } else {
      const seed = intentSeedOf(message, state && state.lastJob, form.form.seed)
      if (seed !== null) {
        overrides.seed = seed
      } else if (String(form.form.seed ?? '').trim() !== '') {
        // 卡片没指定、也没打开「沿用上张构图」时，左栏残留的旧固定种子与本轮无关：
        // 显式写 null 清掉，避免把上一张的构图绑到这次提案上（无残留时不加字段）。
        overrides.seed = null
      }
    }
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
    const ok = await generate(overrides, {
      pushUser: false,
      source: 'assistant',
      // 刚切过后端时组合层的 compute.provider 还是旧值：把目标来源显式带过去，
      // 让生成前的能力预检按新后端判断，避免刚切换就被自己拦下。
      ...(target.kind === 'cross' ? { provider: target.targetProvider } : {}),
    })
    // 确认卡提交成功后表单就是这次生成的内容：补记干净基准。
    if (ok && typeof form.markClean === 'function') form.markClean()
    return ok
  }

  /**
   * 带入参数面板：把卡片内容写进表单（提示词 / 宽高 / 张数 / 可用时的排除项 / 推荐模型），
   * 切换模式与轻提示由 ChatPanel 负责。返回 `true`（已带入）或 `'cross'`（跨后端兜底带入）。
   *
   * M2.7 跨后端保护：目标模型属于另一后端时不静默写进当前表单（会变成一个跑不了的预设），
   * 只带入提示词等通用字段，保留当前后端与模型，并用 toast 说明为什么没换模型。
   */
  function handoffIntent(message) {
    if (!message || typeof form.applyIntent !== 'function') return false
    const context = providerContext()
    const target = proposalTargetOf(message.presetId, {
      provider: context.provider,
      presets: state && state.presets,
    })
    const cross = target.kind === 'cross'
    const hasPrompt = typeof message.prompt === 'string' && message.prompt.trim().length > 0
    if (hasPrompt && (form.dirty || form.draftEditing) && typeof form.parkDraft === 'function') {
      form.parkDraft()
    }
    const preset = proposalPresetOf(message.presetId, state && state.presets)
    if (!cross && preset && preset !== form.form.presetId && typeof form.selectPreset === 'function') {
      form.selectPreset(preset)
    }
    const applied = Boolean(form.applyIntent(message))
    if (!applied) return false
    if (typeof form.clearOrigin === 'function') form.clearOrigin()
    if (cross) {
      notify('studio.chat.intent.handoffCross', {
        preset: presetLabelOfId(target.presetId),
        provider: providerLabelOf(t, target.targetProvider),
      })
      return 'cross'
    }
    return true
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

  /** 新建对话：清空当前线程、聚焦栈、对话上下文与该工作区的 L1/L2 持久化快照。 */
  function newChat() {
    threadSeq.current += 1
    historyLoadSeqRef.current += 1
    clearSaveTimer()
    stopAgent()
    interpretingRef.current = false
    setInterpreting(false)
    setStreamingAgent(false)
    if (messagesRef.current.length > 0) {
      const empty = []
      skipArrayRef.current = empty
      setMessages(empty)
    }
    if (workspaceKey) {
      clearChatSnapshot(workspaceKey)
      void saveChatHistory([])
    }
    clearFocus()
  }

  /**
   * 工作区热切换（M1.5 + M2.7）：线程按工作区隔离，切过去直接载入目标工作区的历史，
   * 不再把旧工作区的文字消息「带过去」——那边可能讨论的是另一批作品。
   */
  function rebaseWorkspace(options = {}) {
    threadSeq.current += 1
    historyLoadSeqRef.current += 1
    clearSaveTimer()
    stopAgent()
    interpretingRef.current = false
    setInterpreting(false)
    setStreamingAgent(false)
    clearFocus()
    const current = options && typeof options.current === 'string' ? options.current.trim() : ''
    const target = current || workspaceKey
    messagesWorkspaceRef.current = target
    const saved = target ? readChatSnapshot(target) : null
    if (Array.isArray(saved) && saved.length > 0) {
      skipArrayRef.current = saved
      syncMessageSeq(saved)
      setMessages(saved)
    } else {
      const empty = []
      skipArrayRef.current = empty
      setMessages(empty)
      if (target) void loadServerHistory(target)
    }
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
    // 退出聚焦视图（「继续涂抹」打开工具后回到线程看进度）：只改视图，不动 messages。
    focusClear: clearFocus,
    mirrorTool,
    newChat,
    rebaseWorkspace,
    pushMessages,
  }
}
