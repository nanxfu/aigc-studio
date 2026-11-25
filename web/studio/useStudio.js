/**
 * 生图工作台的数据编排（组合层）。
 *
 * 域 hook 各管一块状态，这里只做宿主状态桥接、跨域动作粘合（生成、重新生成、回填与草稿托管、
 * 重试、指引计算）与领域对象组装。对外返回按领域分组：
 *   { t, ui, compute, form, chat, library, imageTool, guidance, actions }
 *
 * 0.13.0 起主表单只做纯文生图；针对舞台作品的图片处理（局部涂抹 / 整图重绘）
 * 由独立的 `imageTool` 域承载，组合层只负责动作入口与视图切换。
 *
 * 阶段十五 Phase A1：胶片条点击不再被 dirty 拦截——`previewWork` 先把未提交修改托管进
 * 最左端草稿卡（`form.parkDraft`），再回填目标作品；点草稿卡走 `form.openDraft` 恢复，
 * 「还原原图」走 `restoreOriginal`（参数恢复 + 清草稿 + 回到来源作品）。
 *
 * 阶段十五 Phase C0：焦点与来源「同源收口」全部走 `recallTarget()` 这一个口径——
 * 胶片条 / 画廊 / 助手结果图 / 导入完成 / 删除后的回退都先按需托管草稿、再回填参数与
 * `origin`，并统一退出舞台画布编辑态；裸导入图与空白新建画布改为解除与上一张作品的绑定。
 *
 * 阶段十五 Phase C2：左栏参考图槽的导入（拖入 / 选择文件 → `/import` 落盘）由
 * `useReferenceSlot` 负责，本层只做「建槽 / 去重 / 满额 / 换模型 / 送到舞台重绘」这些
 * 跨域动作；生成请求体里是否带 `references` 统一由 `form.buildBody()` 决定。
 *
 * effect 顺序：宿主轮询 → 卸载边界 → Toast 定时 → 宿主错误消费 → 预设同步 → 线程同步
 * → 历史/收藏加载 → 工作区切换重置 → 首图提示 → 任务完成刷新历史。
 *
 * 工作区热切换（独立客户端 Phase 1）：`/state.workspace.current` 变化时，作品库域先作废旧
 * 工作区的历史 / 收藏 / 选中 / 版本树并从第 0 页重载，再通过 `onWorkspaceChanged` 级联清理
 * 左栏草稿与参考图槽、舞台工具草稿、对话线程；否则旧工作区的图片会继续显示（裂图），
 * 或让生成请求带上新工作区里不存在的路径。
 */

import React from 'react'

import { SETTINGS, WORKSHOP } from '../../shared/contract.js'
import { fetchLocalHardware } from '../api/localModels.js'
import { saveSettings, importImageFile, submitGenerate } from '../api/resources.js'
import { submitWorkshopOp } from '../api/workshop.js'
import { useHostState } from '../hooks/useHostState.js'
import { getLanguage, translator } from '../i18n.js'
import { desktop } from '../runtime.js'
import { formDraftSummaryOf, mergeWorkDrafts } from '../logic/form.js'
import { guidanceDetailOf, guidanceKeyOf, guidanceKindOf, guidanceSurfaceOf, isConnectionCode } from '../logic/guidance.js'
import { formatText } from '../logic/format.js'
import { importPrecheckOf } from '../logic/import.js'
import { workDraftSummary as lineageWorkDraftSummary } from '../logic/lineage.js'
import {
  effectivePresetOf,
  formSummaryOf,
  generateCapabilityOf,
  isBareImportOf,
  isImportLockedOf,
  iteratePatch,
  presetLabelOf,
  previewRecallOf,
  rerollOverrides,
  retryOverrides,
} from '../logic/generate.js'
import { safeResetPatch } from '../../shared/models-guide.js'
import { accountStatusOf } from '../logic/probe.js'
import { pendingJobsOf, stateJobs } from '../logic/jobs.js'
import { modePresetCandidateOf, presetAvailableForProvider, presetProvidersOf, providerNameKeyOf } from '../logic/preset.js'
import { referenceItemOf, referenceListOf, referencePathsOf, referenceUrlOf, supportsReferenceOf } from '../logic/reference.js'
import { readStudioSession, writeStudioSession } from './sessionSnapshot.js'
import { useChatThread } from './hooks/useChatThread.js'
import { useImageTool } from './hooks/useImageTool.js'
import { useColabLogin, useKaggleLogin } from './hooks/useKaggleLogin.js'
import { useReferenceSlot } from './hooks/useReferenceSlot.js'
import { useSessionControl } from './hooks/useSessionControl.js'
import { readSavedModePreset, useStudioForm } from './hooks/useStudioForm.js'
import { useStudioUi } from './hooks/useStudioUi.js'
import { useWorkLibrary } from './hooks/useWorkLibrary.js'

function queueJobTimestamp(job) {
  const value = Date.parse(String((job && (job.finishedAt || job.startedAt || job.createdAt)) || ''))
  return Number.isFinite(value) ? value : 0
}

function retainedQueueKey(job) {
  if (!job) return ''
  const images = Array.isArray(job.output?.images)
    ? job.output.images.map((image) => `${image?.path || ''}:${image?.url || ''}`).join(',')
    : ''
  return [
    job.status || '',
    job.finishedAt || '',
    job.seconds ?? '',
    images,
    job.error?.code || '',
    job.error?.message || '',
  ].join('|')
}

function queueJobMatchesEntry(job, entry) {
  if (!job || !entry) return false
  const jobId = entry.item && typeof entry.item.jobId === 'string' ? entry.item.jobId.trim() : ''
  if (jobId && job.id === jobId) return true
  const path = entry.image && typeof entry.image.path === 'string' ? entry.image.path.trim() : ''
  if (!path) return false
  const images = Array.isArray(job.output?.images) ? job.output.images : []
  return images.some((image) => image && image.path === path)
}

/**
 * 组件卸载边界：域 hook 里的异步流程统一 `const result = await alive(request)`；
 * 卸载后 alive 返回 null，调用方直接 return。
 */
function useAlive() {
  const ref = React.useRef(true)
  React.useEffect(() => {
    ref.current = true
    return () => {
      ref.current = false
    }
  }, [])
  return React.useCallback(async (promise) => {
    const value = await promise
    return ref.current ? value : null
  }, [])
}

export function useStudio(props) {
  const t = translator(props)
  // 界面语言：优先看调用方显式传入的 t（入口层 / 测试会带上 .lang），
  // 否则用模块级运行时语言；不再从宿主 <html lang> 反推。
  const propLanguage = props && props.t && typeof props.t.lang === 'string'
    ? String(props.t.lang).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    : ''
  const isEn = propLanguage ? propLanguage === 'en' : getLanguage() !== 'zh'
  const host = useHostState()
  const alive = useAlive()
  const state = host.state

  // 跨侧栏切换恢复：只在宿主重挂载且外部未显式传参时，从 sessionStorage 恢复上次焦点与草稿。
  const savedSession = React.useMemo(() => readStudioSession(), [])
  const hasExplicitView = Boolean(props && (props.view === 'gallery' || props.view === 'studio' || props.view === 'workshop'))
  const hasExplicitPanel = Boolean(props && (props.panelMode === 'chat' || props.panelMode === 'form'))
  const hasExplicitWorkspace = Boolean(props && (props.workspaceMode === 'work' || props.workspaceMode === 'new_draft'))

  // 预览与测试用的初始值在组合层解析，域 hook 只接收结果。
  const initialPrompt = props && typeof props.initialPrompt === 'string' ? props.initialPrompt : ''
  // 三态视图：工坊页在关闭应用后重开也要能恢复（M4.2a）。
  const savedView = savedSession && typeof savedSession.view === 'string' ? savedSession.view : ''
  const initialView = hasExplicitView
    ? props.view
    : (savedView === 'gallery' || savedView === 'workshop' ? savedView : 'studio')
  const initialPanelMode = hasExplicitPanel
    ? props.panelMode
    : (savedSession && savedSession.panelMode === 'chat' ? 'chat' : 'form')
  const initialWorkspaceMode = hasExplicitWorkspace
    ? props.workspaceMode
    : (savedSession && savedSession.workspaceMode === 'work' ? 'work' : 'new_draft')
  const initialSelectedPath = !hasExplicitWorkspace && savedSession && typeof savedSession.selectedPath === 'string'
    ? savedSession.selectedPath
    : ''
  const initialNewDraftExplicit = !hasExplicitWorkspace && Boolean(savedSession && savedSession.newDraftExplicit)

  // 宿主下发的预设配置：表单同步与顶栏展示共用同一份。
  const presets = Array.isArray(state && state.presets) ? state.presets.filter((item) => item && item.id) : []
  const defaultPreset = (state && state.defaultPreset) || ''

  const [sending, setSending] = React.useState(false)
  const [referenceFly, setReferenceFly] = React.useState(null)
  const [queueFly, setQueueFly] = React.useState(null)
  const [justQueuedAt, setJustQueuedAt] = React.useState(0)
  // 本次挂载期间进入过活动队列的任务 id：只有它们转为终态后才进入「已结束、待查看」留存集合。
  // 冷启动时 /state 里已有的旧任务不会被收进队列。
  const trackedQueueIdsRef = React.useRef(new Set())
  const retainedQueueRef = React.useRef([])
  const [retainedQueueJobs, setRetainedQueueJobs] = React.useState([])
  const justQueuedTimerRef = React.useRef(null)
  React.useEffect(() => () => {
    if (justQueuedTimerRef.current) clearTimeout(justQueuedTimerRef.current)
  }, [])
  // 上一次提交（或被受限模型预检拦下）的 body，失败或预检恢复后用于「重试一次」。
  const pendingRef = React.useRef(null)
  // 本地受限模型预检拦截时的目标预设 id（不能依赖上一条历史 focusedJob 的 presetId）。
  const [gatedPresetId, setGatedPresetId] = React.useState('')
  // 资产工坊（M4.2a）：进入工坊时携带的初始作品、GPU 后处理提交态与最近一次任务 id。
  const [workshopEntry, setWorkshopEntry] = React.useState(() => {
    const entry = props && props.workshopEntry
    return entry && entry.image ? entry : null
  })
  const [workshopInitialTool, setWorkshopInitialTool] = React.useState(() => (
    props && typeof props.workshopInitialTool === 'string' ? props.workshopInitialTool : ''
  ))
  const [workshopOpBusy, setWorkshopOpBusy] = React.useState(false)
  const [workshopJobId, setWorkshopJobId] = React.useState('')

  const ui = useStudioUi({
    t,
    initialView,
    initialPanelMode,
    initialCompareOpen: Boolean(props && props.initialCompareOpen),
    initialQueueOpen: Boolean(props && props.defaultQueueOpen),
  })
  const control = useSessionControl({ t, host, ui, alive })
  // 10 分钟排队横幅的关闭记忆：值为轮次键（startedAt|presetId），同一轮排队只弹一次。
  const [dismissedQueueKey, setDismissedQueueKey] = React.useState('')
  // 直连登录会话：成功（done）后重跑一次 probe，把账号与配额状态刷成最新。
  // CLI 模式下 hook 不会发起任何请求（指引卡使用原有「复制登录命令」动作）。
  const kaggleLogin = useKaggleLogin({ t, ui, onDone: () => control.runProbe() })
  // Colab Google OAuth 登录会话：成功后刷新 /state 并静默拉一次 CCU 余额（无需唤醒 GPU）。
  const colabLogin = useColabLogin({
    t,
    ui,
    onDone: () => {
      host.refresh()
      control.silentProbe()
    },
  })
  const provider = (state && state.provider) || (control.session && control.session.provider) || 'kaggle'
  const localGpuPresets = Array.isArray(state?.localGpu?.configuredPresets) ? state.localGpu.configuredPresets : []
  const form = useStudioForm({
    t,
    isEn,
    alive,
    ui,
    preset: { presets, defaultPreset },
    provider,
    localGpuPresets,
    initialPrompt,
    initialSession: !initialPrompt ? savedSession : null,
  })
  // 舞台图片工具域：底图 / 提示词 / 强度 / 蒙版 / 工具预设全部独立于左栏表单。
  const imageTool = useImageTool({
    t,
    alive,
    ui,
    presets,
    defaultPreset,
    provider,
    // 工具优先沿用左栏当前模型（支持对应能力时），但不回写左栏。
    currentPresetId: form.form.presetId,
    initialWorkDrafts: savedSession && savedSession.imageToolWorkDrafts ? savedSession.imageToolWorkDrafts : undefined,
    // 阶段十五 A2：舞台图片工具提交成功后，把动作镜像进助手线程（kind 记录不进 intentHistory）。
    onSubmitted: (job, meta) => {
      if (job && job.id) trackedQueueIdsRef.current.add(String(job.id))
      if (meta && typeof meta === 'object') {
        chat.mirrorTool({ job, tool: meta.tool, target: meta.target, body: meta.body })
      }
      triggerQueueFly(captureGenerateOriginRect(), { url: meta?.target?.url || '' })
      host.refresh()
    },
  })
  // generate 是函数声明（提升），chat 在事件回调里调用时已完成初始化。
  const chat = useChatThread({
    t,
    isEn,
    alive,
    ui,
    state,
    form,
    generate,
    // 跨后端「一步到位」需要实时 provider / 在途任务 / HF Token：只在事件回调里读取，
    // 因此用 getter 而不是在 hook 创建时固化（compute 在下方才完成组装）。
    getProviderContext: () => ({
      provider: compute.provider,
      activeJob: compute.activeJob || null,
      hfTokenConfigured: compute.hfTokenConfigured,
      session: compute.session || null,
    }),
    switchProvider,
    // 舞台焦点（Phase C）：随每次对话上报当前选中图的摘要，让「把当前这张图…」有明确对象。
    // 闭包在事件回调里才读取 library，此时下面的 useWorkLibrary 已完成初始化。
    getStage: () => {
      const selected = library && library.selected ? library.selected : null
      const image = selected && selected.image ? selected.image : null
      const path = image && typeof image.path === 'string' ? image.path.trim() : ''
      if (!path) return null
      const item = selected.item && typeof selected.item === 'object' ? selected.item : null
      const params = item && item.params && typeof item.params === 'object' ? item.params : {}
      return {
        imagePath: path,
        presetId: params.presetId || (item && typeof item.presetId === 'string' ? item.presetId : ''),
        width: image.width ?? params.width,
        height: image.height ?? params.height,
        seed: params.seed,
        prompt: params.prompt || (item && typeof item.prompt === 'string' ? item.prompt : ''),
      }
    },
    onAgentDone: ({ images } = {}) => {
      host.refresh()
      if (Array.isArray(images) && images.length > 0 && typeof library.loadHistory === 'function') {
        library.loadHistory()
      }
    },
  })
  const library = useWorkLibrary({
    t,
    alive,
    ui,
    state,
    initialWorkspaceMode,
    initialSelectedPath,
    initialNewDraftExplicit,
    // 阶段十五 Phase C0：删除作品后的级联清理（工具草稿 + 左栏来源引用 + 回退图回填）。
    onImagesRemoved: handleImagesRemoved,
    // 独立客户端 Phase 1：工作区热切换后清理作品库之外、按旧工作区路径索引的状态。
    onWorkspaceChanged: handleWorkspaceChanged,
  })
  // 左栏参考图槽的导入动作（阶段十五 Phase C2）：拖入 / 选择文件 → /import → 槽位追加。
  const referenceSlot = useReferenceSlot({ t, alive, ui, form, library })

  // 预览与测试用：首次挂载时自动打开指定舞台工具或预设参考图（不影响正常使用路径）。
  const initialImageToolRef = React.useRef(false)
  React.useEffect(() => {
    if (initialImageToolRef.current) return
    const targetTool = props && typeof props.initialImageTool === 'string' ? props.initialImageTool : ''
    if (!targetTool || !library.selected || !library.selected.image) return
    initialImageToolRef.current = true
    imageTool.openTool(targetTool, library.selected)
  }, [props && props.initialImageTool, library.selected])

  const initialRefsDoneRef = React.useRef(false)
  React.useEffect(() => {
    if (initialRefsDoneRef.current) return
    const refs = props && Array.isArray(props.initialReferences) ? props.initialReferences : null
    if (!refs || refs.length === 0 || presets.length === 0) return
    initialRefsDoneRef.current = true
    form.patchForm({ references: refs })
  }, [props && props.initialReferences, presets.length])

  /**
   * 导入图焦点隔离（M2.6）：舞台停在裸导入图或其无参数放大产物时，左栏表单与助手整体锁定。
   *
   * 判定只在组合层做一次（纯函数 `isImportLockedOf`），Rail / ChatPanel 只消费布尔值；
   * `new_draft` 空白画布下 selected 恒为 null，天然不锁。
   */
  const importLocked = isImportLockedOf(
    library.workspaceMode === 'work' ? library.selected : null,
    library.items,
  )

  /**
   * 点击底部新建画布卡：进入新建画布焦点。
   *
   * 阶段十五 Phase A1 起这里也是「草稿卡」的入口（§6.1.4）：
   *  - 草稿槽里有托管草稿 → 恢复草稿内容并进入草稿编辑态，舞台取景框提示「源自：…」；
   *  - 只有未提交修改 → 当前表单就是草稿，先托管再进入编辑态；
   *  - 两者都没有 → 与原来一致，切到新建画布（保留当前表单内容）。
   * 同时收起图片工具编辑态。
   */
  function focusNewDraft() {
    imageTool.closeTool()
    const opened = form.openDraft()
    // 阶段十五 Phase C0：既没有托管草稿也没有未提交修改时，切空白新建画布不能把上一张
    // 浏览作品的提示词 / 固定种子 / 「正在微调」来源带进来（保留当前预设与画幅）。
    if (!opened && form.origin) form.detachOrigin()
    library.focusDraft()
    ui.setView('studio')
    ui.setPanelMode('form')
  }

  /**
   * 显式新建绘图（阶段十三）：重置表单 + 进入 new_draft 焦点。
   *
   * 入口沿用 Rail 顶部的「新建创作」按钮（它调用 form.newCreation），这里把 form 的
   * newCreation 包装成「重置表单 + 切新建态」；同时暴露 actions.newDraft 供其它入口使用。
   * 表单域本身不感知工作区焦点，避免 hook 之间互相依赖。
   */
  function newDraft() {
    // 新建画布与「正在编辑某张作品」互斥：先退出工具编辑态（未提交草稿仍保存在 workDrafts）；
    // 表单侧的来源作品与托管草稿由 form.newCreation() 一并清掉（§6.1.7）。
    imageTool.closeTool()
    form.newCreation()
    library.newDraft()
    ui.setView('studio')
    ui.setPanelMode('form')
  }
  const formView = { ...form, newCreation: newDraft }

  /**
   * 创作模式与模型选择联动（方案 A）：
   *  - 切到视频 / 生图模式时，自动切到该模态记住的（或首个可用）预设；
   *  - 若当前选了跨模态模型或点击模式按钮且舞台正停在异模态作品上，把舞台平滑切回取景框（不丢原作品，不锁死导入图）。
   */
  function autoSwitchProviderForPreset(targetPreset) {
    if (!targetPreset) return ''
    if (presetAvailableForProvider(targetPreset, provider)) return ''
    const configuredSet = new Set(configuredProviders)
    if (targetPreset.cloud?.vendor) {
      if (!configuredSet.has('cloud-api')) return ''
      const keys = Array.isArray(compute.imageApi?.apiKeysConfigured) ? compute.imageApi.apiKeysConfigured : []
      if (keys.length > 0 && !keys.includes(targetPreset.cloud.vendor)) return ''
      return 'cloud-api'
    }
    const candidates = presetProvidersOf(targetPreset).filter((id) => configuredSet.has(id))
    if (candidates.length === 0) return ''
    const activeSessionProvider =
      control.session && control.session.state && control.session.state !== 'absent' && control.session.state !== 'error'
        ? control.session.provider
        : ''
    if (activeSessionProvider && candidates.includes(activeSessionProvider)) return activeSessionProvider
    for (const id of ['local-gpu', 'private-worker', 'colab', 'kaggle']) {
      if (candidates.includes(id)) return id
    }
    return candidates[0]
  }

  /** 抓取右侧舞台当前相纸屏幕位置，用于切模型 / 设为参考图时的副本飞入动画。 */
  function captureStagePrintRect() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
    const node = document.querySelector('.ofs-stage .ofs-print .ofs-image')
      || document.querySelector('.ofs-stage .ofs-print')
    if (!node || typeof node.getBoundingClientRect !== 'function') return null
    const rect = node.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }

  function triggerReferenceFly(target, fromRect) {
    if (!fromRect || !target || !target.image || !target.image.path) return
    const url = target.image.url || referenceUrlOf(target.image.path)
    if (!url) return
    setReferenceFly({
      id: `${Date.now()}-${Math.random()}`,
      path: target.image.path,
      url,
      fromRect,
    })
  }

  function clearReferenceFly() {
    setReferenceFly(null)
  }

  /** 抓取生成提交按钮屏幕位置，用于「加入队列」抛物线飞入动效。 */
  function captureGenerateOriginRect() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
    const active = document.activeElement
    const trigger = (active && typeof active.closest === 'function'
      && active.closest('.ofs-generate, .ofs-tool-submit, .ofs-chat-send, .ofs-dock-button'))
      || document.querySelector('.ofs-generate')
      || document.querySelector('.ofs-tool-submit')
      || document.querySelector('.ofs-chat-send')
    if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return null
    const rect = trigger.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }

  function triggerQueueFly(fromRect, meta = {}) {
    if (justQueuedTimerRef.current) clearTimeout(justQueuedTimerRef.current)
    setJustQueuedAt(Date.now())
    justQueuedTimerRef.current = setTimeout(() => {
      setJustQueuedAt(0)
      justQueuedTimerRef.current = null
    }, 900)
    if (!fromRect) return
    setQueueFly({
      id: `${Date.now()}-${Math.random()}`,
      fromRect,
      url: typeof meta.url === 'string' ? meta.url : '',
    })
  }

  function clearQueueFly() {
    setQueueFly(null)
  }

  function applyModePreset(targetPreset, targetProvider = '') {
    if (!targetPreset || !targetPreset.id) return false
    const samePreset = targetPreset.id === form.form.presetId
    const needsProviderSwitch = Boolean(targetProvider && targetProvider !== provider)
    if (samePreset && !needsProviderSwitch) return false

    const onWork = library.workspaceMode === 'work'
    const selected = onWork ? library.selected : null
    const fromStageWork = Boolean(onWork && ui.view !== 'gallery' && selected && selected.image)

    if (onWork) {
      imageTool.closeTool()
      const attachRef = fromStageWork && supportsReferenceOf(targetPreset) && selected.image.mediaType !== 'video'
        ? selected
        : null
      const flyFromRect = attachRef ? captureStagePrintRect() : null
      form.startNewDraftFromWork({
        preset: targetPreset,
        provider: targetProvider || undefined,
        clearPrompt: importLocked || !fromStageWork,
        referenceEntry: attachRef,
      })
      library.focusDraft()
      if (ui.view !== 'gallery') ui.setZoom(false)
      if (attachRef && flyFromRect) triggerReferenceFly(attachRef, flyFromRect)
    } else {
      form.selectPreset(targetPreset, targetProvider ? { provider: targetProvider } : undefined)
    }

    if (targetProvider) {
      void switchProvider(targetProvider)
      ui.showToast(formatText(t('studio.preset.autoSwitchedProvider'), {
        provider: t(providerNameKeyOf(targetProvider)) || targetProvider,
        model: targetPreset.short || targetPreset.label || targetPreset.id,
      }))
    }
    return true
  }

  function switchCreationMode(targetMode) {
    const mode = targetMode === 'video' ? 'video' : 'image'
    ui.setView('studio')
    if (form.creationMode === mode) return false
    const targetPreset = modePresetCandidateOf(presets, mode, {
      rememberedId: readSavedModePreset(mode),
      defaultPreset,
      provider,
    })
    if (!targetPreset) return false
    const targetProvider = autoSwitchProviderForPreset(targetPreset)
    return applyModePreset(targetPreset, targetProvider)
  }

  /**
   * 组件层拿到的作品库视图（阶段十三/十五）：
   * 在 useWorkLibrary 领域对象上补 Filmstrip 需要的草稿表与新建草稿卡数据，
   * 这样 Gallery / Stage / Filmstrip 仍共用同一个 library props，Studio.jsx 不需要改动。
   *
   * 阶段十五 A1：`draft` 相关字段描述「未提交草稿」托管态（§6.1.2~§6.1.4）：
   *  - `draft`：是否有未提交草稿（草稿槽已托管，或当前工作区的脏修改会进草稿卡）；
   *  - `draftFrom`：来源作品的提示词（有来源时才展示「源自此图」）；
   *  - `draftEditing`：当前表单是否正在编辑草稿（点草稿卡恢复后）。
   */
  const draftView = form.draftView
  const mergedWorkDrafts = React.useMemo(
    () => mergeWorkDrafts(imageTool.workDrafts, form.workFormDrafts),
    [imageTool.workDrafts, form.workFormDrafts],
  )
  function clearAnyWorkDraft(path) {
    imageTool.clearWorkDraft(path)
    form.clearWorkDraft(path)
  }
  function combinedWorkDraftSummary(value) {
    const key = typeof value === 'string'
      ? value.trim()
      : (value && value.image && typeof value.image.path === 'string' ? value.image.path.trim() : '')
    const toolSummary = imageTool.workDraftSummary(key)
    const formEntry = key && form.workFormDrafts ? (form.workFormDrafts[key] || null) : null
    if (!formEntry) return toolSummary
    const formSummary = formDraftSummaryOf(formEntry)
    if (!toolSummary || !toolSummary.active) return formSummary
    return lineageWorkDraftSummary(mergedWorkDrafts[key] || null)
  }
  // 跨侧栏切换持久化：焦点、当前表单、多作品草稿与工具草稿随变更写入 sessionStorage。
  React.useEffect(() => {
    writeStudioSession({
      view: ui.view,
      panelMode: ui.panelMode,
      workspaceMode: library.workspaceMode,
      selectedPath: library.selectedPath,
      newDraftExplicit: library.newDraftExplicit,
      form: form.form,
      cleanBaseline: form.cleanBaseline,
      origin: form.origin,
      workFormDrafts: form.workFormDrafts,
      blankDraft: form.blankDraft,
      imageToolWorkDrafts: imageTool.workDrafts,
    })
  }, [
    ui.view,
    ui.panelMode,
    library.workspaceMode,
    library.selectedPath,
    library.newDraftExplicit,
    form.form,
    form.cleanBaseline,
    form.origin,
    form.workFormDrafts,
    form.blankDraft,
    imageTool.workDrafts,
  ])
  const libraryView = {
    ...library,
    // 阶段十五 Phase C0：助手点结果图 / 单图聚焦返回与胶片条同口径——先按需托管 dirty
    // 草稿，再回填目标图参数与 origin，消除「舞台换了图、左栏还是上一张」的图文不同步。
    openMessage: openPath,
    newDraftCard: {
      active: library.workspaceMode === 'new_draft',
      explicit: library.newDraftExplicit === true,
      pending: library.newDraftPending === true,
      width: form.form.width,
      height: form.form.height,
      presetLabel: form.activePreset ? presetLabelOf(form.activePreset) : '',
      prompt: form.form.prompt,
      // 1A：最左端卡片回归纯「新建空白画布」，只承载无来源作品的空白画布草稿；
      // 各作品自身的未提交草稿直接展示在作品缩略图草稿圆点上。
      // 全新画布上只调比例 / 张数 / 提示词不等于「未提交草稿」：SPEC §5.19.2 要求这类
      // 参数编辑保持「正在配置新画布」的展示，只有真正被托管过的空白草稿才亮草稿态。
      draft: Boolean(form.blankDraft),
      draftFrom: '',
      draftFromSource: false,
      draftEditing: Boolean(draftView && draftView.editing && !form.origin),
    },
    // 合并工具域与左栏表单的多作品草稿：缩略图圆点 / 版本面板圆点与一键清空统一走这里。
    workDrafts: mergedWorkDrafts,
    clearWorkDraft: clearAnyWorkDraft,
    workDraftSummary: combinedWorkDraftSummary,
    // 导入图焦点隔离（M2.6）：true 时左栏表单与助手锁定，只剩「新建创作」与舞台动作坞可用。
    importLocked,
  }

  /** 启动会话（默认优先检查并接管仍在排队/运行的原 Kernel）。 */
  function startSession() {
    // 有排队任务时，内核预加载的模型应跟随队头任务，而不是用户在等待期间随手切的表单预设。
    // 两者不一致会让远端先加载 A、接到任务后再卸载加载 B，白等一轮模型加载。
    const queuedPresetId = control.activeJob && typeof control.activeJob.presetId === 'string'
      ? control.activeJob.presetId
      : ''
    return control.startSession(queuedPresetId || form.form.presetId || defaultPreset)
  }

  /**
   * 换新实例重排：跳过接管、删除排不上的旧 Kernel 后推送新 Kernel。
   * busy / 同一 tick 内的重复点击由 useSessionControl 判重，失败走 ui.fail。
   */
  function requeueSession() {
    const queuedPresetId = control.activeJob && typeof control.activeJob.presetId === 'string'
      ? control.activeJob.presetId
      : ''
    return control.requeueSession(queuedPresetId || form.form.presetId || defaultPreset)
  }

  // 排队卡住（10 分钟档）横幅：非错误态通道，只对当前排队轮次弹一次。
  // 「继续等待」只收起卡片、不影响会话；「换新实例重排」收起后发起 replace 请求。
  // 重排成功会换新的 startedAt，新轮次（若仍卡住）可再次触发。
  // provider 一并透传：Colab 没有排队，卡片要改说「实例启动慢 / 重新申请实例」。
  const queue = control.queue
  const queueNotice = queue.level === 'stalled' && queue.key && queue.key !== dismissedQueueKey
    ? {
        minutes: queue.stalledMinutes,
        provider: (control.session && control.session.provider) || provider,
        dismiss: () => setDismissedQueueKey(queue.key),
        requeue: () => {
          setDismissedQueueKey(queue.key)
          return requeueSession()
        },
      }
    : null

  const configuredProviders = React.useMemo(() => {
    const set = new Set(Array.isArray(state?.configuredProviders) ? state.configuredProviders : [])
    if (provider) set.add(provider)
    const activeSessionProvider =
      control.session && control.session.state && control.session.state !== 'absent' && control.session.state !== 'error'
        ? control.session.provider
        : ''
    if (activeSessionProvider) set.add(activeSessionProvider)
    if (state?.colabAuth?.authorized === true) set.add('colab')
    if (control.probe?.auth?.ok === true) set.add('kaggle')
    if (state?.privateWorker?.endpointUrl) set.add('private-worker')
    if (state?.localGpu?.ok) set.add('local-gpu')
    const keys = Array.isArray(state?.imageApi?.apiKeysConfigured) ? state.imageApi.apiKeysConfigured : []
    if (keys.length > 0 || state?.imageApi?.hasApiKey) set.add('cloud-api')
    return Array.from(set)
  }, [state, provider, control.session, control.probe])

  // 硬件适配探测（只读、缓存 30s）：让顶栏模型卡在未打开设置页前也能展示本机预测。
  const [probedHardware, setProbedHardware] = React.useState(null)
  const hardwareTriedRef = React.useRef(false)
  React.useEffect(() => {
    if (state?.hardware) return
    if (hardwareTriedRef.current || presets.length === 0) return
    hardwareTriedRef.current = true
    void alive(fetchLocalHardware()).then((res) => {
      if (res && res.ok && res.hardware) setProbedHardware(res.hardware)
    }).catch(() => {})
  }, [state?.hardware, presets.length])
  const hardware = (state && state.hardware) || probedHardware || null

  const pendingProviderRef = React.useRef(null)

  /**
   * 切换算力来源（M2.7 跨后端一步到位用）。
   *
   * 只改运行设置里的 `provider` 并刷新宿主快照；旧实例由 SessionManager 在下次唤醒时
   * 以 `provider_switch` 原因关闭（不在客户端手动 stop，避免把队列里的任务一起打断）。
   * 设置保存失败时返回 false，调用方中止生成，不发无效请求。
   *
   * @param {string} nextProvider 目标算力来源 id
   * @returns {Promise<boolean>}
   */
  async function switchProvider(nextProvider) {
    const target = SETTINGS.providers.includes(nextProvider) ? nextProvider : ''
    if (!target) return false
    if (target === ((state && state.provider) || '')) return true
    const run = (async () => {
      const result = await alive(saveSettings({ provider: target }))
      if (!result) return false
      if (!result.ok) {
        ui.fail(result.code, result.message)
        return false
      }
      await host.refresh()
      return true
    })().finally(() => {
      if (pendingProviderRef.current && pendingProviderRef.current.target === target) {
        pendingProviderRef.current = null
      }
    })
    pendingProviderRef.current = { target, promise: run }
    return run
  }

  const pendingQueueJobs = Array.isArray(control.pendingJobs) ? control.pendingJobs : []
  const queueJobs = [...pendingQueueJobs, ...retainedQueueJobs]

  // 组件层拿到的云端域：宿主派生状态 + 启停动作，startSession 已绑定当前表单预设。
  const compute = {
    ...control,
    jobs: stateJobs(state),
    // 队列只展示本次会话真正进过活动队列的任务：进行中项 + 结束后的待看留存项。
    // 历史里更早的 done / failed 不参与，避免冷启动就塞满队列。
    queueJobs,
    retainedJobs: retainedQueueJobs,
    presets,
    defaultPreset,
    activePresetId: form.form.presetId || '',
    gatedPresetId,
    startSession,
    requeueSession,
    queueNotice,
    retryHost,
    kaggleLogin,
    provider,
    configuredProviders,
    switchProvider,
    imageApi: (state && state.imageApi) || null,
    localGpu: (state && state.localGpu) || null,
    hardware,
    colabAuth: (state && state.colabAuth) || null,
    colabLogin,
    // 受限模型预检：只看布尔，undefined 表示旧宿主未下发（不拦，交给远端报错）。
    hfTokenConfigured: state && typeof state.hfTokenConfigured === 'boolean'
      ? state.hfTokenConfigured
      : null,
    // 当前工作区：宿主在 /state 里下发 workspace:{current,recent,switchable}；
    // 旧服务端还没有该字段时为 null，顶栏用 GET /api/workspace 兜底并标注。
    workspace: (state && state.workspace) || null,
    // 切换工作区成功后重新拉一次宿主快照（顶栏切换入口使用）。
    refreshState: host.refresh,
    removeQueueJob,
    clearFinishedQueue,
  }

  // 队列留存：跟踪本次会话出现过的活动任务，并在它们离开活动队列时做终态归档。
  //  - done / failed：保留到用户查看、手动移除或清空为止；
  //  - cancelled：主动取消后直接移出，不留「已取消」噪音。
  React.useEffect(() => {
    if (!state) return
    const pending = pendingJobsOf(state)
    const pendingIds = new Set(pending.map((job) => String(job.id)))
    const terminalById = new Map()
    for (const job of stateJobs(state)) {
      if (job && job.id !== undefined && job.id !== null) terminalById.set(String(job.id), job)
    }
    const lastJob = state.lastJob && typeof state.lastJob === 'object' ? state.lastJob : null
    if (lastJob && lastJob.id !== undefined && lastJob.id !== null) {
      terminalById.set(String(lastJob.id), lastJob)
    }

    const tracked = trackedQueueIdsRef.current
    for (const id of pendingIds) tracked.add(id)

    const previous = retainedQueueRef.current
    const nextById = new Map(previous.map((job) => [String(job.id), job]))
    let changed = false

    for (const id of [...tracked]) {
      if (pendingIds.has(id)) {
        // 任务重新进入活动队列（例如同 id 重试）：不能再作为已结束项留在面板里。
        if (nextById.delete(id)) changed = true
        continue
      }
      const job = terminalById.get(id)
      if (!job) continue
      if (job.status === 'done' || job.status === 'failed') {
        const previousJob = nextById.get(id)
        if (!previousJob || retainedQueueKey(previousJob) !== retainedQueueKey(job)) {
          nextById.set(id, job)
          changed = true
        }
      } else if (job.status === 'cancelled') {
        if (nextById.delete(id)) changed = true
        tracked.delete(id)
      }
    }

    if (!changed) return
    const next = [...nextById.values()].sort((a, b) => queueJobTimestamp(b) - queueJobTimestamp(a))
    retainedQueueRef.current = next
    setRetainedQueueJobs(next)
  }, [state])

  function removeQueueJob(target) {
    const id = typeof target === 'string'
      ? target.trim()
      : (target && target.id !== undefined && target.id !== null ? String(target.id).trim() : '')
    if (!id) return false
    trackedQueueIdsRef.current.delete(id)
    const previous = retainedQueueRef.current
    const next = previous.filter((job) => String(job.id) !== id)
    if (next.length === previous.length) return false
    retainedQueueRef.current = next
    setRetainedQueueJobs(next)
    return true
  }

  function trackQueueJob(target) {
    const id = typeof target === 'string'
      ? target.trim()
      : (target && target.id !== undefined && target.id !== null ? String(target.id).trim() : '')
    if (id) trackedQueueIdsRef.current.add(id)
  }

  function clearFinishedQueue() {
    const previous = retainedQueueRef.current
    if (previous.length === 0) return 0
    for (const job of previous) trackedQueueIdsRef.current.delete(String(job.id))
    retainedQueueRef.current = []
    setRetainedQueueJobs([])
    return previous.length
  }

  function dismissFinishedJobsForEntry(entry) {
    if (!entry) return 0
    let removed = 0
    for (const job of [...retainedQueueRef.current]) {
      if (!queueJobMatchesEntry(job, entry)) continue
      if (removeQueueJob(job.id)) removed += 1
    }
    return removed
  }

  function dismissFinishedJobsForPath(path) {
    const target = typeof path === 'string' ? path.trim() : ''
    if (!target) return 0
    return dismissFinishedJobsForEntry({ image: { path: target }, item: null })
  }

  // 生成完成后若舞台已经自动展示这张产物，视为「已查看」；面板打开期间先不静默移除，
  // 等用户收起面板后再对齐，避免条目在眼前突然闪没。
  const retainedQueueSignature = retainedQueueJobs
    .map((job) => `${job.id}:${job.status}:${job.finishedAt || ''}`)
    .join(',')
  const selectedQueueJobId = library.selected?.item && typeof library.selected.item.jobId === 'string'
    ? library.selected.item.jobId
    : ''
  const selectedQueuePath = library.selected?.image && typeof library.selected.image.path === 'string'
    ? library.selected.image.path
    : ''
  React.useEffect(() => {
    if (ui.view !== 'studio' || ui.queueOpen) return
    const selected = {
      item: selectedQueueJobId ? { jobId: selectedQueueJobId } : null,
      image: selectedQueuePath ? { path: selectedQueuePath } : null,
    }
    const matched = retainedQueueRef.current.find(
      (job) => job.status === 'done' && queueJobMatchesEntry(job, selected),
    )
    if (matched) removeQueueJob(matched.id)
  }, [ui.view, ui.queueOpen, selectedQueueJobId, selectedQueuePath, retainedQueueSignature])

  /**
   * 提交生成（纯文生图，可带模型原生参考图）。
   *
   * 主表单 / 助手 / 变体 / 重试都只做文生图：蒙版由舞台图片工具自己的提交路径负责，
   * 不会从这里被带出来；左栏参考图槽非空时，`form.buildBody()` 会把有序路径数组写进
   * `references`（Phase C2，所有入口共用同一份拼装，助手与重试不会漏带）。
   *
   * 三条前置预检（都不发请求）：
   *  - 当前算力来源跑不了的有效预设（资产 `providers` 能力位，如 9B 仅 Colab）：
   *    拦下并说明当前 / 所需来源与模型名，算力来源取组合层唯一的 `compute.provider`；
   *  - 参考图槽非空但当前模型不支持原生参考：拦下并提示换模型 / 移除参考图（不静默丢图）；
   *  - 专用局部重绘预设（`inpaintOnly`）不能文生图：本次请求改用兜底预设并轻提示（决策 D3），
   *    左栏表单保持用户选择不变。
   */
  async function generate(overrides, options = {}) {
    if (sending) return false
    // 导入图焦点隔离（M2.6）：锁定期间界面已禁用提交，这里再兜一道——快捷键、旧入口或
    // 助手卡片都不该把「导入图的文件名」当成提示词发出去。解锁出口只有「新建创作」。
    if (isImportLockedOf(
      library.workspaceMode === 'work' ? library.selected : null,
      library.items,
    )) {
      ui.showToast(t('studio.lock.blocked'))
      return false
    }
    const effectivePreset = effectivePresetOf(overrides, form.activePreset, presets)
    // 跨后端「一步到位」刚切完设置时，组合层的 compute.provider 还是旧值：
    // 调用方可用 `options.provider` 显式指定本次请求要用的来源，或等待在飞的自动换源完成。
    let requestProvider = options && SETTINGS.providers.includes(options.provider)
      ? options.provider
      : compute.provider
    if ((!options || !options.provider) && pendingProviderRef.current) {
      const pending = pendingProviderRef.current
      const ok = await pending.promise
      if (ok && presetAvailableForProvider(effectivePreset, pending.target)) {
        requestProvider = pending.target
      }
    }
    // 覆盖项（重试 / 变体）里的 references 优先：预检与请求体必须看同一组参考图。
    const requestedReferences = referencePathsOf(
      overrides && Object.prototype.hasOwnProperty.call(overrides, 'references')
        ? overrides.references
        : form.form.references,
    )
    const capability = generateCapabilityOf({
      preset: effectivePreset,
      presets,
      references: requestedReferences,
      // 与顶栏模型卡同源：provider 只在组合层归一一次（compute.provider），不在这里重复推导。
      provider: requestProvider,
      localGpuPresets: state?.localGpu?.configuredPresets,
    })
    if (!capability.ok) {
      // blockedParams 里是算力来源 id；提示文案要用本地化展示名，拼装只在组合层做一次。
      const blocked = capability.blockedParams
      const params = blocked
        ? {
            ...blocked,
            provider: t(providerNameKeyOf(blocked.provider)),
            needed: t(providerNameKeyOf(blocked.needed)),
          }
        : undefined
      ui.showToast(formatText(t(capability.blockedKey), params))
      return false
    }
    const requestPreset = capability.preset || effectivePreset
    const body = form.buildBody(overrides, { preset: requestPreset })
    if (!body.prompt) {
      ui.fail('need_prompt', '')
      return false
    }
    // 受限模型（资产 gated: true）：Host 明确告知没有 HF Token 时，不把注定 401 的任务
    // 送进远端排队；先记下当前请求参数与目标预设，方便指引卡展示正确模型页并在填完 Token 后「重试」。
    if (requestPreset && requestPreset.gated === true && compute.hfTokenConfigured === false) {
      pendingRef.current = body
      setGatedPresetId(requestPreset.id || '')
      ui.fail('model_gated', formatText(t('studio.gate.hfTokenMissing'), { preset: presetLabelOf(requestPreset) }))
      return false
    }
    if (gatedPresetId) setGatedPresetId('')
    // 兜底切换的轻提示要在提交结果之后再弹：成功提示会覆盖先前的 toast，
    // 否则用户看不到「本次已改用 X 文生图」这类关键说明。
    const showPolicyNotice = () => {
      if (capability.notice) ui.showToast(formatText(t(capability.notice.key), capability.notice.params))
    }
    // 提交时的表单对象：成功回来后只有它仍是当前表单，才记为干净基准。
    const submittedForm = form.form
    const flyOriginRect = captureGenerateOriginRect()
    pendingRef.current = body
    setSending(true)
    ui.setError(null)
    try {
      const result = await alive(submitGenerate(body))
      if (!result) return false
      if (result.ok && result.data && result.data.id) {
        const jobId = result.data.id
        // 极快完成的任务可能在下一轮 /state 前就离开活动队列；提交成功即登记，
        // 保证它仍按「本次会话进入过队列」进入完成留存。
        trackQueueJob(jobId)
        const entries = []
        // 表单提交同步进助手：除了提示词，再带一份结构化参数摘要（界面渲染成胶囊）。
        // 记录带 kind='form'：与普通用户气泡区分，且不进 intentHistory（见 logic/intent.js）。
        if (options.pushUser !== false) {
          entries.push({
            role: 'user',
            kind: 'form',
            source: options.source || 'form',
            text: body.prompt,
            summary: formSummaryOf(body),
          })
        }
        entries.push({ role: 'assistant', kind: 'job', jobId, stage: 'pending', text: t('studio.chat.pending') })
        chat.pushMessages(entries)
        // 刚提交的内容就是当前的干净版本：之后手动改动才算 dirty。
        // 等 chat 确认卡提交（pushUser=false）由 generateIntent 在表单补丁落地后再标记。
        if (options.pushUser !== false && form.markClean(submittedForm)) {
          // 草稿已经随这次提交发布出去：清掉草稿卡（§6.1.6），后续任务完成自动切新图。
          form.clearDraft()
        }
        // 显式新建绘图：保持 new_draft 直到该任务完成，完成后再切 work 并选中新图。
        if (library.workspaceMode === 'new_draft') library.markNewDraftSubmitted(jobId)
        triggerQueueFly(flyOriginRect)
        host.refresh()
        // 历史只在任务完成后刷新（见 useWorkLibrary 的 lastJob effect）：
        // 刚提交的任务还没有产物，这里再拉一次会把已加载的分页重置回第一页。
        ui.showToast(t('studio.toast.submitted'))
        showPolicyNotice()
        return true
      }
      showPolicyNotice()
      ui.fail(result.code, result.message)
    } finally {
      // 卸载导致 alive 返回 null、或后续逻辑抛错时也必须复位，否则按钮永远停在「提交中」。
      setSending(false)
    }
    return false
  }

  /** 重新生成：按当前选中作品的提示词与参数、换随机种子再抽一张纯文生图（产生新 v1）。 */
  function reroll(entry) {
    const target = entry || library.selected
    // 高清放大等非扩散产物的参数不可信：传入已加载条目与当前预设，让它回溯父作品的扩散参数。
    const overrides = rerollOverrides(target, presets, library.items, form.activePreset)
    if (!overrides) {
      ui.showToast(t('workbench.needPrompt'))
      return
    }
    generate(overrides, { source: 'variant' })
  }

  /**
   * 按路径在已加载作品库里找条目 `{ image, item }`（助手结果图 / 单图聚焦 / 还原原图用）。
   *
   * 新完成任务在 /history 刷新前可能还不在 gallery 里，退一步按 items 里的图拼最小条目；
   * 都找不到时返回 null，调用方按「路径不在当前列表」安全收口。
   */
  function entryByPath(path) {
    const target = typeof path === 'string' ? path.trim() : ''
    if (!target) return null
    const gallery = Array.isArray(library.gallery) ? library.gallery : []
    const found = gallery.find((entry) => entry && entry.image && entry.image.path === target)
    if (found) return found
    const items = Array.isArray(library.items) ? library.items : []
    for (const item of items) {
      const images = item && Array.isArray(item.images) ? item.images : []
      const image = images.find((candidate) => candidate && candidate.path === target)
      if (image) return { image, item }
    }
    return null
  }

  /**
   * 把作品参数回填进左栏（阶段十五 Phase C0 的「焦点与来源同源收口」）。
   *
   * 所有切换作品的入口（胶片条 / 画廊 / 助手结果图 / 导入完成 / 删除后的回退）共用这一份口径：
   *  - 裸导入图没有生成参数：有未提交修改先托管，再解除表单与上一张作品的绑定（清
   *    prompt / seed / origin，保留预设与画幅），不残留上一张生图的参数与「正在微调」；
   *  - 其他作品：`iteratePatch` 算补丁（非扩散产物沿 sourceImage 回溯父作品），
   *    dirty 时先 `parkDraft()` 再回填，并沿用既有提示键。
   *
   * @param {{image: object, item: object}} target 目标作品条目
   * @param {{notice?: boolean}} [options] notice=false 时不弹「已保留当前草稿 / 参数已回填」
   *   （导入完成、删除回退这类入口自己有提示语，避免后弹的提示覆盖主提示）
   */
  function recallTarget(target, options = {}) {
    const notice = options.notice !== false
    if (isBareImportOf(target)) {
      if (form.dirty || form.draftEditing) {
        form.parkDraft()
        if (notice) ui.showToast(t('studio.toast.draftKept'))
      }
      form.detachOrigin()
      return
    }
    // 高清放大 / inpaintOnly 等非扩散产物不直接回填：沿 sourceImage 找父作品的真实扩散参数。
    const patch = iteratePatch(target, form.form, presets, library.items)
    const targetPath = target && target.image && typeof target.image.path === 'string'
      ? target.image.path.trim()
      : ''
    const decision = previewRecallOf({
      dirty: form.dirty,
      hasTargetDraft: Boolean(targetPath && form.hasWorkDraft(targetPath)),
      hasDraft: false,
      patch,
    })
    // 先在原焦点上托管（各自进自己的草稿槽），再回填目标作品参数或恢复目标作品草稿。
    if (decision.park || form.draftEditing) form.parkDraft()
    if (notice && decision.noticeKey) ui.showToast(t(decision.noticeKey))
    if (decision.action !== 'recall') return
    form.applyRecall(patch, target)
  }

  /**
   * 胶片条 / 画廊 / 助手结果图点击作品：切换右侧预览，并把该作品的原始参数回填到左侧面板。
   *
   * 阶段十五 Phase A1（§6.1.1/§6.1.3）：不再因为 dirty 拦截回填——未提交修改先被托管进
   * 最左端草稿卡（已有草稿则覆盖），再回填目标作品的干净基准，并给「已保留当前草稿」提示。
   * 阶段十五 Phase C0：先退出舞台画布编辑态（`closeTool()` 只收编辑态、按作品路径保留
   * `workDrafts`，符合 SPEC §5.17）；裸导入图走 `recallTarget` 的解除绑定分支。
   */
  function previewWork(entry) {
    const target = entry && entry.image ? entry : null
    if (!target) return
    imageTool.closeTool()
    library.selectImage(target)
    // 点击作品即视为查看了对应队列项：优先用 item.jobId，缺失时按产物路径兜底。
    dismissFinishedJobsForEntry(target)
    recallTarget(target)
  }

  /**
   * 助手结果图 / 单图聚焦按路径打开作品：与胶片条同口径走 `previewWork`
   * （先按需托管 dirty 草稿、再回填参数与 origin），消除图文不同步。
   *
   * 路径不在已加载作品库时按裸作品安全收口：只切预览，并解除表单与上一张作品的绑定。
   */
  function openPath(path) {
    const target = typeof path === 'string' ? path.trim() : ''
    if (!target) return
    const entry = entryByPath(target)
    if (entry) {
      previewWork(entry)
      return
    }
    imageTool.closeTool()
    dismissFinishedJobsForPath(target)
    if (form.dirty || form.draftEditing) form.parkDraft()
    library.openMessage(target)
    form.detachOrigin()
  }

  /**
   * 站内拖拽作品到舞台：直接切到该作品预览并回填参数（不走 `/import`，不复制副本）。
   */
  function dropWorkToStage(payload) {
    const direct = payload && payload.entry && payload.entry.image ? payload.entry : null
    const path = (direct && direct.image && typeof direct.image.path === 'string' ? direct.image.path.trim() : '')
      || (payload && typeof payload.path === 'string' ? payload.path.trim() : '')
    if (direct) {
      previewWork(direct)
      return true
    }
    if (path) {
      openPath(path)
      return true
    }
    return false
  }

  /**
   * 从任务队列面板回看任意任务：
   *  - 已完成任务：直接切到舞台展示产物并回填参数；
   *  - 在途 / 排队 / 失败任务：有源图 / 参考图时先回看源图，否则在新建画布下回填其参数（已有脏改动先托管进草稿）。
   */
  function reviewJob(job) {
    if (!job || typeof job !== 'object') return false
    const isTerminal = job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'
    const outImages = job.output && Array.isArray(job.output.images) ? job.output.images : []
    const firstOut = outImages.find((img) => img && img.path) || null
    if (job.status === 'done' && firstOut && firstOut.path) {
      ui.setView('studio')
      ui.setZoom(false)
      const existing = entryByPath(firstOut.path)
      if (existing) {
        previewWork(existing)
      } else {
        previewWork({
          image: firstOut,
          item: {
            jobId: job.id,
            prompt: job.params && typeof job.params.prompt === 'string' ? job.params.prompt : '',
            presetId: job.presetId || (job.params && job.params.presetId) || '',
            provider: job.provider || '',
            device: job.device || '',
            params: job.params || null,
            images: outImages,
          },
        })
      }
      removeQueueJob(job.id)
      return true
    }
    const params = job.params && typeof job.params === 'object' ? job.params : null
    const sourcePath = (typeof job.parentPath === 'string' && job.parentPath)
      || (params && typeof params.parentPath === 'string' && params.parentPath)
      || (params && params.reference && typeof params.reference.sourcePath === 'string' && params.reference.sourcePath)
      || (params && Array.isArray(params.references) && typeof params.references[0] === 'string' && params.references[0])
      || ''
    if (sourcePath) {
      ui.setView('studio')
      ui.setZoom(false)
      openPath(sourcePath)
      if (isTerminal) removeQueueJob(job.id)
      return true
    }
    if (params && typeof params.prompt === 'string') {
      ui.setView('studio')
      ui.setPanelMode('form')
      ui.setZoom(false)
      if (form.dirty || form.draftEditing) form.parkDraft()
      const targetPreset = presets.find((item) => item && item.id === (job.presetId || params.presetId)) || null
      if (targetPreset) form.selectPreset(targetPreset)
      const patch = { prompt: params.prompt }
      if (typeof params.negative === 'string') patch.negative = params.negative
      if (Number.isFinite(Number(params.width))) patch.width = Number(params.width)
      if (Number.isFinite(Number(params.height))) patch.height = Number(params.height)
      if (Number.isFinite(Number(params.steps))) patch.steps = Number(params.steps)
      if (Number.isFinite(Number(params.cfg))) patch.cfg = Number(params.cfg)
      if (params.seed !== undefined && params.seed !== null) patch.seed = String(params.seed)
      form.patchForm(patch)
      library.focusDraft()
      if (isTerminal) removeQueueJob(job.id)
      return true
    }
    return false
  }

  /**
   * 还原原图（§6.1.5）：放弃当前未提交草稿，恢复来源作品的原始参数并回到该作品。
   *
   * 表单参数与干净基准由 `useStudioForm.restoreOriginal()` 恢复；这里负责清草稿后的
   * 预览焦点（work 焦点回到来源作品）、退出舞台画布编辑态与提示。
   *
   * 阶段十五 Phase C0：来源作品已不在当前已加载列表（被删除 / 不在分页内）时，参数照常还原，
   * 但舞台切回新建画布取景框并说明情况——不能停在别的作品上冒充来源，避免图文错位。
   *
   * @returns {boolean} 是否真的还原了（没有来源 / 没有可还原字段时为 false）
   */
  function restoreOriginal() {
    const source = form.restoreOriginal()
    if (!source) return false
    imageTool.closeTool()
    const path = source && typeof source.path === 'string' ? source.path.trim() : ''
    const entry = path ? entryByPath(path) : null
    ui.setView('studio')
    ui.setPanelMode('form')
    ui.setZoom(false)
    if (path && !entry) {
      library.focusDraft()
      ui.showToast(t('studio.toast.restoredOriginalMissing'))
      return true
    }
    if (entry) library.selectImage(entry)
    ui.showToast(t('studio.toast.restoredOriginal'))
    return true
  }

  /**
   * 一步直达舞台图片工具（决策 D4）。
   *
   * 默认以当前选中的作品为底图；从画廊 / 大图预览触发时由调用方传入条目。
   * 工具会自动选模（不改左栏表单）；没有可处理的底图或没有可用垫图预设时，
   * `openTool` 自己 toast 说明并返回 false，这里不切换视图。
   * 高清放大是即时工具：`openTool` 直接提交、不进入编辑态，这里的视图切换照常执行。
   *
   * @param {'inpaint'|'img2img'|'upscale'|'outpaint'} kind 工具 id
   * @param {object} [entry] 胶卷 / 画廊条目 `{ image, item }`；缺省用当前选中作品
   * @param {{ recall?: boolean, keepPanel?: boolean }} [options]
   *   recall=true 时同步回填左栏来源；keepPanel=true 时保留当前面板 Tab（助手聚焦进来用）
   * @returns {boolean} 是否成功打开（即时工具为是否已发起提交）
   */
  function openImageTool(kind, entry, options = {}) {
    // 商业生图 API 阶段 A 只支持文生图：舞台的重绘 / 涂抹 / 扩图 / 超分都依赖本地 diffusers
    // 或 Worker 工具，直接在入口拦住并说明可切换的来源，避免提交后才报错。
    if (compute.provider === 'cloud-api') {
      ui.showToast(t('studio.cloudApi.toolBlocked'))
      return false
    }
    const target = entry || library.selected
    if (!target) {
      ui.showToast(t('studio.imageTool.blockedTarget'))
      return false
    }
    // 离开当前表单焦点前按需托管未提交修改，保证不同作品草稿不互相覆盖。
    if (form.dirty || form.draftEditing) form.parkDraft()
    if (!imageTool.openTool(kind, target)) return false
    // 从画廊点击「重绘编辑」切回工作台时，同步绑定左栏 origin 与参数，避免退出工具后编辑作品不弹草稿提示。
    if (options.recall === true && target.image) recallTarget(target, { notice: false })
    // D4：「选中该作品 + 切回舞台 + 打开工具」三步语义一致——退出工具后舞台停在该作品上。
    // 传裸 image 对象时包成条目；selectImage 同时会把工作区焦点从 new_draft 切回 work。
    library.selectImage(target.image ? target : { image: target })
    ui.setView('studio')
    // 从助手聚焦视图进来时保留当前「助手」Tab：线程里的进度卡要能继续看见（M2.7）。
    if (options.keepPanel !== true) ui.setPanelMode('form')
    ui.setZoom(false)
    return true
  }

  /** 从画廊「查看大图」进入工作台放大层：同步回填左栏来源，保证关掉大图后编辑作品能正常识别草稿来源。 */
  function zoomWork(entry) {
    if (!entry) return false
    if (entry.image) recallTarget(entry, { notice: false })
    dismissFinishedJobsForEntry(entry)
    library.zoomImage(entry)
    return true
  }

  // ── 资产工坊（M4.2a / M4.2b）──────────────────────────────────
  //
  // 工坊是独立视图：进入时不改左栏表单焦点，只记录「带着哪张作品进工坊」。
  // 本机确定性算子（像素对齐 / 序列帧 / 平铺 / SVG）全部在渲染进程里完成，保存时
  // 走 `/api/workshop/save` 落成复合资产；GPU 后处理（抹除背景 / PBR）走任务队列。

  /**
   * 打开资产工坊。
   *
   * @param {{ image: object, item: object }} [entry] 初始作品；缺省带当前舞台选中作品
   *   （没有选中时进入空工坊，侧栏可从最近作品里挑）。
   */
  function openWorkshop(entry, initialTool = '') {
    const candidate = entry && entry.image && entry.image.mediaType !== 'video'
      ? entry
      : (library.workspaceMode === 'work' && library.selected && library.selected.image && library.selected.image.mediaType !== 'video'
        ? library.selected
        : null)
    // 工坊与舞台画布编辑态互斥：先收起涂抹 / 扩图，未提交草稿按既有约定保留在 workDrafts。
    imageTool.closeTool()
    setWorkshopEntry(candidate)
    // 只有显式指定目标工具时才锁定初始工具；普通切进工坊留空，交给工坊 Jev 感知层决定默认工具。
    setWorkshopInitialTool(typeof initialTool === 'string' && WORKSHOP.tools.includes(initialTool) ? initialTool : '')
    ui.setView('workshop')
    ui.setZoom(false)
    ui.setCompareOpen(false)
    return true
  }

  /** 从工坊返回创作页（作品与参数焦点保持不变，由用户自己点胶片条切换）。 */
  function closeWorkshop() {
    ui.setView('studio')
  }

  /**
   * 提交一次工坊 GPU 后处理算子：`{ op:'remove-bg'|'pbr', path, model?, options? }`。
   *
   * 商业 API 来源没有本地任务队列，直接拦下并说明；成功只提示「已提交」，进度由
   * 工坊页读取 `compute.activeJob / focusedJob` 展示，结果作品由宿主落盘后进历史。
   */
  async function runWorkshopOp(body) {
    const payload = body && typeof body === 'object' ? body : {}
    const op = payload.op === 'pbr' ? 'pbr' : 'remove-bg'
    const path = typeof payload.path === 'string' ? payload.path.trim() : ''
    if (!path) {
      ui.showToast(t('studio.workshop.opNoTarget'))
      return { ok: false, status: 0, code: 'no_target', message: '' }
    }
    if (compute.provider === 'cloud-api') {
      ui.showToast(t('studio.workshop.opBlockedCloud'))
      return { ok: false, status: 0, code: 'cloud_api_unsupported', message: '' }
    }
    if (workshopOpBusy) return { ok: false, status: 0, code: 'busy', message: '' }
    const flyOriginRect = captureGenerateOriginRect()
    setWorkshopOpBusy(true)
    try {
      const request = { op, path }
      if (typeof payload.model === 'string' && payload.model.trim()) request.model = payload.model.trim()
      if (payload.options && typeof payload.options === 'object') request.options = payload.options
      const result = await alive(submitWorkshopOp(request))
      if (!result) return { ok: false, status: 0, code: 'disposed', message: '' }
      if (!result.ok) {
        ui.fail(result.code, result.message)
        ui.showToast(t('studio.workshop.opFailed'))
        return result
      }
      setWorkshopJobId(result.jobId)
      trackQueueJob(result.jobId)
      triggerQueueFly(flyOriginRect, { url: workshopEntry?.image?.url || '' })
      ui.showToast(t('studio.workshop.opQueued'))
      host.refresh()
      return result
    } finally {
      setWorkshopOpBusy(false)
    }
  }

  /**
   * 工坊保存成功后的宿主侧收尾：新作品进历史 / 侧栏，并把工坊焦点切到它，
   * 让「导出 ZIP」与后续通道预览直接作用于刚保存的复合资产。
   */
  function workshopSaved(entry) {
    const target = entry && entry.image ? entry : null
    if (!target) return false
    setWorkshopEntry(target)
    setWorkshopInitialTool('')
    if (typeof library.selectImage === 'function') library.selectImage(target)
    if (typeof library.loadHistory === 'function') library.loadHistory()
    return true
  }

  /**
   * 左栏参考图槽（阶段十五 Phase C2）：增删、能力引导与「送到舞台重绘」。
   *
   * 槽位本体由 `useStudioForm` 维护（挂载即 dirty、随草稿托管）；这里只做组合层的提示、
   * 视图切换与工具跳转，避免 UI 组件各自拼一套文案。
   */
  function addReference(entry) {
    const resolved = typeof entry === 'string'
      ? (entryByPath(entry) || entry)
      : (entry && typeof entry === 'object' && !entry.image && typeof entry.path === 'string'
        ? (entryByPath(entry.path) || entry)
        : entry)
    const outcome = form.addReference(resolved)
    if (outcome.ok) {
      ui.showToast(t('studio.reference.addedToSlot'))
      return true
    }
    if (outcome.reason === 'duplicate') ui.showToast(t('studio.reference.duplicate'))
    else if (outcome.reason === 'full') ui.showToast(formatText(t('studio.reference.full'), { max: form.referenceMax }))
    else ui.showToast(t('studio.reference.invalidPath'))
    return false
  }

  function removeReference(path) {
    return form.removeReference(path)
  }

  function swapReferences() {
    return form.swapReferences()
  }

  /** 一键切到第一个支持原生参考生图的预设（参考图保留）；没有候选时给明确提示。 */
  function switchToReferencePreset() {
    if (form.referenceSupported) return false
    const target = form.referenceSwitchPreset
    if (!target) {
      ui.showToast(t('studio.reference.noPreset'))
      return false
    }
    form.selectPreset(target)
    ui.showToast(formatText(t('studio.reference.switched'), { preset: form.referenceSwitchLabel }))
    return true
  }

  /**
   * 动作坞「设为参考图」：切到新建草稿取景框并把当前选中（或指定）作品加入左栏参考图槽。
   *
   * - 作品态触发时一起切去 `new_draft`、解除旧 `origin`（裸导入图清伪提示词，普通作品保留提示词）；
   * - 新建草稿态已有参考图时继续追加（去重 / 满额只提示，不改槽位）；
   * - 当前预设不支持原生参考时自动切到第一个 `supportsReference` 预设（参考图保留）并提示；
   * - 切回创作视图与参数表单，让槽位可见、接着改提示词。
   */
  function useAsReference(entry) {
    const target = entry || library.selected
    if (!target || !target.image) {
      ui.showToast(t('studio.reference.noTarget'))
      return false
    }
    if (target.image.mediaType === 'video' || !referenceItemOf(target)) {
      ui.showToast(t('studio.reference.invalidPath'))
      return false
    }
    const targetPreset = form.referenceSupported ? null : form.referenceSwitchPreset
    const effectiveSupportsRef = supportsReferenceOf(targetPreset || form.activePreset)
    const isFromStage = Boolean(
      effectiveSupportsRef
      && ui.view !== 'gallery'
      && library.selected
      && library.selected.image
      && library.selected.image.path === target.image.path,
    )
    const flyFromRect = isFromStage ? captureStagePrintRect() : null
    if (library.workspaceMode === 'work' || importLocked) {
      const targetIsBare = isBareImportOf(target) || (target === library.selected && importLocked)
      imageTool.closeTool()
      form.startNewDraftFromWork({
        preset: targetPreset,
        clearPrompt: targetIsBare,
        referenceEntry: target,
      })
      library.focusDraft()
    } else {
      const outcome = form.addReference(target)
      if (!outcome.ok) {
        if (outcome.reason === 'duplicate') ui.showToast(t('studio.reference.duplicate'))
        else if (outcome.reason === 'full') ui.showToast(formatText(t('studio.reference.full'), { max: form.referenceMax }))
        else ui.showToast(t('studio.reference.invalidPath'))
        return false
      }
      if (targetPreset) form.selectPreset(targetPreset)
    }
    if (flyFromRect) triggerReferenceFly(target, flyFromRect)
    if (targetPreset) {
      ui.showToast(formatText(t('studio.reference.switched'), { preset: form.referenceSwitchLabel }))
    } else if (form.referenceSupported) {
      ui.showToast(t('studio.reference.addedToSlot'))
    } else {
      ui.showToast(t('studio.reference.addedUnsupported'))
    }
    ui.setView('studio')
    ui.setPanelMode('form')
    ui.setZoom(false)
    return true
  }

  /** 「改用整图重绘」：以第一张参考图为底图打开舞台 img2img 工具（不支持参考时的降级引导）。 */
  function referenceToImg2img() {
    const first = referenceListOf(form.form.references)[0]
    if (!first) {
      ui.showToast(t('studio.reference.emptySlot'))
      return false
    }
    // 优先用已加载的历史条目（带原始 prompt / 预设）；没有时按槽位项拼最小条目即可。
    const entry = entryByPath(first.path) || {
      image: { path: first.path, url: first.url, width: first.width, height: first.height },
      item: null,
    }
    return openImageTool('img2img', entry)
  }

  /**
   * 本地导入完成（阶段十五 Phase A3 / Phase C0）：切到舞台焦点、回填参数并刷新历史。
   *
   * 图片已由 Host 落盘为独立 v1（见 SPEC §2.3 `/import`），前端不伪造历史条目：只切焦点、
   * 退出画布编辑态、关闭对比层，再重新拉一次历史，把新目录并入胶片条与版本树。
   *  - 带 PNG `tEXt` 生成元数据的导入图：完成导入后直接回填原生成参数（舞台与左栏同源）；
   *  - 裸导入图（无生成参数）：解除表单与上一张作品的绑定（清 prompt / seed / origin，
   *    保留预设与画幅），避免左栏继续显示上一张生图作品的参数与「正在微调」。
   */
  function activateImport(entry, options = {}) {
    const target = entry && entry.image ? entry : null
    if (!target) return false
    imageTool.closeTool()
    library.selectImage(target)
    // 导入入口自己有「已识别生成参数 / 图片已导入」提示，回填链路不再叠一条「参数已回填」。
    recallTarget(target, { notice: false })
    ui.setView('studio')
    ui.setPanelMode('form')
    ui.setZoom(false)
    ui.setCompareOpen(false)
    const generation = entry.generation && typeof entry.generation === 'object' ? entry.generation : null
    // 调用方可以换成更贴切的提示（例如视频抽帧用「已取首帧并落成作品」）。
    const toastKey = options && typeof options.toastKey === 'string' && options.toastKey
      ? options.toastKey
      : generation ? 'studio.import.metaFound' : 'studio.import.done'
    ui.showToast(t(toastKey))
    if (typeof library.loadHistory === 'function') library.loadHistory()
    return true
  }

  /**
   * 视频抽帧落盘（M4.2）：渲染进程抽出的帧 → `/api/import` → 成为一张普通作品。
   *
   * 走导入接口而不是新造路由：抽出来的帧和用户本地拖入的图片在语义上完全一致
   * （一张没有生成参数的 PNG），复用同一套预检、体积护栏与落盘/历史归一，
   * 之后既能进参考图槽做 I2V，也能直接开图片工具重绘。
   */
  async function importFrame(payload) {
    const dataUrl = payload && typeof payload.dataUrl === 'string' ? payload.dataUrl : ''
    if (!dataUrl.startsWith('data:image/')) return false
    const precheck = importPrecheckOf({ dataUrl })
    if (!precheck.ok) {
      if (ui && typeof ui.showToast === 'function') ui.showToast(formatText(t(precheck.errorKey), precheck.params || null))
      return false
    }
    const response = await alive(
      importImageFile({
        data: precheck.dataUrl,
        name: (payload && typeof payload.name === 'string' && payload.name) || precheck.name || undefined,
      }),
    )
    if (!response) return false
    const entry = response.ok && response.data ? response.data.entry : null
    if (!entry) {
      if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.import.failed'))
      return false
    }
    return activateImport(entry, {
      toastKey: payload && payload.phase === 'last' ? 'studio.video.captureDoneLast' : 'studio.video.captureDoneFirst',
    })
  }

  /**
   * 删除作品后的级联清理（阶段十五 Phase C0，由 `useWorkLibrary.deleteImages` 回调）。
   *
   *  - 按 `removed` 路径清掉舞台图片工具里对应的未提交草稿（圆点不能指向已删作品）；
   *  - 清掉左栏表单 origin / draft.source 里对已删路径的引用（「还原原图」不能指向不存在的图）；
   *  - 删掉的正是当前预览作品、或左栏正绑着它时，回退到下一张图并同步刷新左栏回填，
   *    避免「舞台换了图、左栏还是被删作品的参数」。
   */
  function handleImagesRemoved({ removed, fallback, selectedRemoved }) {
    const list = Array.isArray(removed) ? removed.filter(Boolean) : []
    if (list.length === 0) return
    for (const path of list) imageTool.clearWorkDraft(path)
    const originRemoved = Boolean(form.origin && form.origin.path && list.includes(form.origin.path))
    form.forgetRemovedPaths(list)
    // 删的不是当前预览、也没绑着左栏：只需清理引用，不抢用户焦点。
    if (!(selectedRemoved === true || originRemoved)) return
    // 删掉的是当前预览作品 → 回退到下一张（作品库已把 selectedPath 指向它）。
    const next = selectedRemoved === true ? fallback : library.selected
    if (next) {
      recallTarget(next, { notice: false })
      return
    }
    // 没有可回退的图：解除绑定，不残留已删作品的提示词 / 固定种子。
    form.detachOrigin()
  }

  /**
   * 工作区热切换的级联清理（由 `useWorkLibrary` 重置完作品库后回调，独立客户端 Phase 1）。
   *
   * 以下状态都按「旧工作区的作品路径」索引，切换后不清理会继续渲染旧工作区的图片
   * （`/api/file` 在新工作区解析不到，显示为裂图），或让生成请求带上已不存在的参考图路径：
   *  - 左栏表单的来源作品 / 多作品草稿 / 空白画布草稿 / 参考图槽（`form.resetWorkspace`）；
   *  - 舞台图片工具的未提交编辑草稿 / 活动草稿 / 失败重试信息（`imageTool.resetWorkspace`）；
   *  - 对话线程的结果图与缩略图（消息气泡保存了旧工作区的图片地址）；
   *  - 上一次提交体：重试时可能回放旧工作区的参考图路径。
   *
   * 作品库自身的历史 / 收藏 / 选中 / 版本树由 useWorkLibrary 重置并重新拉取。
   */
  function handleWorkspaceChanged(event) {
    imageTool.resetWorkspace()
    form.rebaseWorkspace()
    // 对话历史按工作区隔离：切过去载入目标工作区自己的线程，不把旧工作区的消息带过去。
    chat.rebaseWorkspace({ previous: event && event.previous, current: event && event.current })
    pendingRef.current = null
    clearFinishedQueue()
    ui.setQueueOpen(false)
  }

  // ── 桌面原生能力闭环（M1.5）：任务栏角标 + 后台出图系统通知 ──────────────────
  const queueRunning = Boolean(state && state.queue && state.queue.running)
  const queuePending = Number(state && state.queue && state.queue.pending) || 0
  const activeBadgeCount = (queueRunning ? 1 : 0) + (queuePending > 0 ? queuePending : 0)
  React.useEffect(() => {
    const bridge = desktop()
    if (!bridge || typeof bridge.setBadge !== 'function') return undefined
    bridge.setBadge(activeBadgeCount > 0 ? String(activeBadgeCount) : '')
    return () => {
      bridge.setBadge('')
    }
  }, [activeBadgeCount])

  const notifyBaselineRef = React.useRef(false)
  const notifyJobKeyRef = React.useRef('')
  const latestJob = state && state.lastJob ? state.lastJob : null
  const latestJobKey = latestJob ? `${latestJob.id}:${latestJob.status}:${latestJob.finishedAt ?? ''}` : ''
  React.useEffect(() => {
    if (!state) return
    if (!notifyBaselineRef.current) {
      notifyBaselineRef.current = true
      notifyJobKeyRef.current = latestJobKey
      return
    }
    if (!latestJob || !latestJobKey || notifyJobKeyRef.current === latestJobKey) return
    notifyJobKeyRef.current = latestJobKey
    if (latestJob.status !== 'done' && latestJob.status !== 'failed') return
    if (typeof document === 'undefined' || !document.hidden) return
    const bridge = desktop()
    if (!bridge || typeof bridge.notify !== 'function') return
    const title = latestJob.status === 'done'
      ? t('studio.notify.jobDoneTitle')
      : t('studio.notify.jobFailedTitle')
    const promptText = String((latestJob.params && latestJob.params.prompt) || '').trim()
    const body = latestJob.status === 'done'
      ? promptText.slice(0, 120)
      : String((latestJob.error && latestJob.error.message) || promptText).slice(0, 120)
    bridge.notify(title, body)
  }, [Boolean(state), latestJobKey])

  // 用户在设置里补齐 HF Token 后，本地预检拦下的 model_gated 指引应自动消退，不必手动关横幅。
  React.useEffect(() => {
    if (compute.hfTokenConfigured !== true) return
    if (ui.error && ui.error.code === 'model_gated') ui.setError(null)
    if (gatedPresetId) setGatedPresetId('')
  }, [compute.hfTokenConfigured])

  /**
   * 按失败任务原来的参数重试（纯文生图）。
   *
   * 图片工具任务的失败恢复由 `useImageTool` 自己的草稿机制负责（决策 D5），
   * 这里不能把带底图 / 蒙版的任务压成文生图重放：检测到 reference 参数时只给指引。
   * 本地受限模型预检拦下时没有新任务入队，优先重试被拦下的 pending 请求。
   */
  function retryFocusedJob() {
    const pending = pendingRef.current
    if (ui.error && ui.error.code === 'model_gated' && pending) {
      const gatedOverrides = retryOverrides(pending)
      if (gatedOverrides) {
        generate(gatedOverrides, { source: 'retry' })
        return
      }
    }
    const focused = control.focusedJob
    const focusedParams = focused && focused.params && typeof focused.params === 'object' ? focused.params : null
    if (focusedParams && focusedParams.reference) {
      ui.showToast(t('studio.imageTool.retryMoved'))
      return
    }
    const overrides = retryOverrides(focused) || (pending ? retryOverrides(pending) : null)
    if (!overrides) {
      ui.showToast(t('workbench.needPrompt'))
      return
    }
    generate(overrides, { source: 'retry' })
  }

  /** OOM 指引卡上的「重置参数」：表单回到当前活跃预设的安全默认档，并清掉当前错误。 */
  function resetToSafe() {
    const safe = safeResetPatch(form.activePreset)
    form.patchForm(safe)
    if (guidanceKey) ui.dismissGuidance(guidanceKey)
    else ui.setError(null)
    ui.showToast(formatText(t('studio.guidance.oom.reset'), { size: safe.width, steps: safe.steps }))
  }

  /** 降级指引卡上的「重试」：先收起到期提示，再立刻拉一次宿主状态。 */
  function retryHost() {
    if (guidanceKey) ui.dismissGuidance(guidanceKey)
    else ui.setError(null)
    host.refresh()
  }

  function dismissGuidance() {
    ui.dismissGuidance(guidanceKey)
  }

  // 工坊 GPU 算子（remove-bg / pbr）的失败由 Workshop 内部 statusNote 承接，
  // 不驱动工作台全局「生成失败 + 重试一次」提示与流水线红条（避免切页 / 热更新后反复弹窗）。
  const isWorkshopFocusedJob = Boolean(
    control.focusedJob
    && (control.focusedJob.tool === WORKSHOP.cutout.op || control.focusedJob.tool === WORKSHOP.pbr.op),
  )
  const failedStudioJob = control.focusedJob && control.focusedJob.status === 'failed' && !isWorkshopFocusedJob
    ? control.focusedJob
    : null

  // 异常指引：操作失败优先，其次是会话错误，最后是当前工作台任务的错误。
  const rawGuidanceCode =
    (ui.error && ui.error.code) ||
    (control.session && control.session.error && control.session.error.code) ||
    (failedStudioJob && failedStudioJob.error && failedStudioJob.error.code) ||
    ''
  // 账号已被证明确实可用（探测通过或会话能跑）时，不再因旧快照里的 auth_required / cli_missing
  // 弹登录卡——直连模式下刚登录成功、旧会话错误还没被覆盖时最容易出现这种自相矛盾的提示。
  // Colab 只能由 colabAuth / 会话就绪自证，不能被 Kaggle 的 probe 误压制。
  const isColabActive = (state && state.provider === 'colab') || (control.session && control.session.provider === 'colab')
  const authProven = isColabActive
    ? Boolean((state && state.colabAuth && state.colabAuth.authorized === true) || control.sessionState === 'ready')
    : accountStatusOf(control.probe, control.sessionState) === 'ok'
  const suppressAuth = authProven && (rawGuidanceCode === 'auth_required' || rawGuidanceCode === 'cli_missing')
  const guidanceCode = suppressAuth ? '' : rawGuidanceCode
  // 网络层错误不展示浏览器原文（"Failed to fetch" 对用户没有信息量），
  // 换成客户端自己的可读文案；其它错误仍以 Host/远端的原文为准。
  const guidanceDetail = isConnectionCode(guidanceCode)
    ? t('error.network')
    : guidanceDetailOf({ error: ui.error, session: control.session, job: failedStudioJob })
  const guidanceKey = guidanceKeyOf({
    code: guidanceCode,
    detail: guidanceDetail,
    error: ui.error,
    session: control.session,
    job: failedStudioJob,
  })
  const guidanceDismissed = Boolean(guidanceKey) && (
    typeof ui.isGuidanceDismissed === 'function'
      ? ui.isGuidanceDismissed(guidanceKey)
      : ui.dismissed === guidanceKey
  )
  const guidanceKind = guidanceCode && !guidanceDismissed ? guidanceKindOf(guidanceCode) : ''
  const guidanceSurface = guidanceSurfaceOf(guidanceKind)

  return {
    t,
    isEn,
    ui,
    compute,
    form: formView,
    chat,
    library: libraryView,
    imageTool,
    guidance: {
      kind: guidanceKind,
      code: guidanceCode,
      surface: guidanceSurface,
      detail: guidanceDetail,
      key: guidanceKey,
      dismissed: guidanceDismissed,
      dismiss: dismissGuidance,
    },
    actions: {
      sending,
      generate,
      newDraft,
      focusNewDraft,
      previewWork,
      dropWorkToStage,
      zoomWork,
      reroll,
      openImageTool,
      activateImport,
      importFrame,
      restoreOriginal,
      retryFocusedJob,
      resetToSafe,
      // 左栏参考图槽（阶段十五 Phase C2）：增删 / 导入 / 换模型 / 送到舞台重绘。
      addReference,
      removeReference,
      swapReferences,
      switchCreationMode,
      applyModePreset,
      useAsReference,
      switchToReferencePreset,
      referenceToImg2img,
      uploadReferenceFiles: referenceSlot.uploadFiles,
      referenceUploading: referenceSlot.busy,
      referenceFly,
      clearReferenceFly,
      queueFly,
      clearQueueFly,
      justQueuedAt,
      reviewJob,
      // 资产工坊（M4.2a / M4.2b）：入口 / 返回 / GPU 后处理提交 / 保存后收尾。
      openWorkshop,
      closeWorkshop,
      workshopSaved,
      runWorkshopOp,
      workshopEntry,
      workshopInitialTool,
      workshopOpBusy,
      workshopJobId,
    },
  }
}
