/** 画面预览：光桌上的相纸。大图居中，图下一条题注与一条动作坞。 */

import React from 'react'

import { INSPIRE_KEYS, VIDEO_INSPIRE_KEYS } from '../constants.js'
import { clampSize } from '../logic/clamp.js'
import { formatText, formatSeconds, percentOf } from '../logic/format.js'
import { isBareImportOf } from '../logic/generate.js'
import { getLanguage } from '../i18n.js'
import { referenceListOf, referenceUrlOf } from '../logic/reference.js'
import { IMAGE_TOOLS, toolPromptPlaceholderOf } from '../logic/imageTool.js'
import { normalizeOutpaintContent } from '../logic/outpaint.js'
import { deviceShortOf, jobCountText, providerLabelOf } from '../logic/status.js'
import { canCaptureFrameOf, frameCanvasSize, frameNameOf, frameSeekOf } from '../logic/video.js'
import { Icon } from './icons.jsx'
import { desktop } from '../runtime.js'
import { useFocusTrap } from './hooks/useFocusTrap.js'
import { usePresence } from './hooks/usePresence.js'
import { CompareSlider } from './stage/CompareSlider.jsx'
import { ImageDock } from './stage/ImageDock.jsx'
import { ImageDropzone } from './stage/ImageDropzone.jsx'
import { InlineTool } from './stage/InlineTool.jsx'
import { MaskEditor } from './stage/MaskEditor.jsx'
import { OutpaintEditor } from './stage/OutpaintEditor.jsx'
import { ToolSubmitBar } from './stage/ToolSubmitBar.jsx'

/** 出图后一分钟内才算「刚落定」，超过就当历史作品直接陈列。 */
const FRESH_MS = 60_000

/**
 * 把 `<video>` 定位到指定时刻并等它把该帧解码出来。
 *
 * 两个现实约束：`seeked` 在「已经就在这一刻」时可能不触发（例如反复点首帧），
 * 因此有超时兜底；视频正在播放时先暂停，否则画布可能抓到缓冲中的旧帧。
 */
function seekVideoFrame(node, time) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = () => {
      if (settled) return
      settled = true
      try { node.removeEventListener('seeked', finish) } catch {}
      if (timer) clearTimeout(timer)
      resolve()
    }
    if (node && typeof node.pause === 'function') {
      try { node.pause() } catch {}
    }
    try {
      node.currentTime = Math.max(0, Number(time) || 0)
    } catch {
      finish()
      return
    }
    node.addEventListener('seeked', finish, { once: true })
    timer = setTimeout(finish, 600)
  })
}

function isFreshItem(item, now) {
  const finishedAt = Date.parse(String((item && item.finishedAt) || ''))
  if (!Number.isFinite(finishedAt)) return false
  const current = Number.isFinite(now) ? now : Date.now()
  const delta = current - finishedAt
  return delta > -5_000 && delta < FRESH_MS
}

/** 正数比例；宽高缺失时回落到正方形画幅。 */
function ratioOf(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 1
  return w / h
}

/** 解析字符串画幅比（如 "16:9" / "21:9"），非法返回 null。 */
function parseRatioString(value) {
  if (typeof value !== 'string' || !value.includes(':')) return null
  const [w, h] = value.split(':').map(Number)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return w / h
}

/** 视频取景框比例：有首帧时跟随首帧图，否则依次读任务 / 表单 ratio / 宽高。 */
function videoFrameRatioOf(fields, preset, activeJob) {
  const refs = referenceListOf(fields && fields.references)
  if (refs.length > 0 && Number(refs[0].width) > 0 && Number(refs[0].height) > 0) {
    return ratioOf(refs[0].width, refs[0].height)
  }
  const jobParams = (activeJob && activeJob.params) || {}
  return (
    parseRatioString(jobParams.ratio)
    || parseRatioString(fields && fields.ratio)
    || parseRatioString(preset && preset.video && preset.video.defaultRatio)
    || (Number(fields && fields.width) > 0 && Number(fields && fields.height) > 0
      ? ratioOf(fields.width, fields.height)
      : 16 / 9)
  )
}

/**
 * 舞台：只做编排。
 *
 * - 主表单回归纯文生图后，针对作品的二次处理（局部涂抹 / 整图重绘 / 高清放大 / 扩图）
 *   全部由舞台底部动作坞 `ImageDock` 一步直达；编辑态下按工具的 `form` 挂载
 *   `MaskEditor` / `OutpaintEditor` / `InlineTool` 三选一，提交栏由 tool-core 的
 *   组件内置，Stage 不再自己拼提交参数。高清放大是即时工具，不会进入编辑态。
 * - 空舞台没有底图，不再出现涂抹入口；动作坞只在有选中作品时渲染。
 *
 * 接收 { t, ui, compute, form, library, imageTool, actions } 领域对象。
 */
export function Stage(props) {
  const { t, ui, compute, form, library, imageTool, actions, viewEnter } = props
  // 显影判定只读一次当前时间、不做 1Hz 计时：舞台不负责读秒，重新渲染跟随宿主轮询即可。
  const now = Date.now()
  const { zoom, setZoom, copyPath } = ui
  const zoomPresence = usePresence(zoom, 175)
  const [copiedPath, setCopiedPath] = React.useState(false)
  const [starPop, setStarPop] = React.useState(false)
  const copyTimerRef = React.useRef(null)
  const starTimerRef = React.useRef(null)
  const [lbScale, setLbScale] = React.useState(1)
  const [lbPan, setLbPan] = React.useState({ x: 0, y: 0 })
  const [lbDragging, setLbDragging] = React.useState(false)
  const lbDragRef = React.useRef(null)
  React.useEffect(() => {
    if (!zoom) {
      setLbScale(1)
      setLbPan({ x: 0, y: 0 })
      setLbDragging(false)
      lbDragRef.current = null
    }
  }, [zoom])
  React.useEffect(() => {
    if (!zoomPresence.mounted || zoomPresence.exiting) return undefined
    const node = lightboxRef.current
    if (!node || typeof node.addEventListener !== 'function') return undefined
    function handleWheel(event) {
      const delta = Number(event && event.deltaY) || 0
      if (!delta) return
      if (typeof event.preventDefault === 'function') event.preventDefault()
      setLbScale((prev) => {
        const factor = delta < 0 ? 1.18 : 1 / 1.18
        const next = Math.min(3.5, Math.max(1, Number((prev * factor).toFixed(2))))
        if (next <= 1.02) {
          setLbPan({ x: 0, y: 0 })
          return 1
        }
        return next
      })
    }
    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      if (typeof node.removeEventListener === 'function') {
        node.removeEventListener('wheel', handleWheel)
      }
    }
  }, [zoomPresence.mounted, zoomPresence.exiting])
  React.useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    if (starTimerRef.current) clearTimeout(starTimerRef.current)
  }, [])
  // 视频抽帧（M4.2）：需要拿到当前舞台上的 <video> 元素与正在抽哪一帧。
  const videoRef = React.useRef(null)
  const [captureBusy, setCaptureBusy] = React.useState('')
  const aliveRef = React.useRef(true)
  React.useEffect(() => () => {
    aliveRef.current = false
  }, [])
  const { activeJob } = compute
  // 舞台胶囊只保留「还在动 + 第 N/M 张」：阶段名与已等待由顶部生图流水线负责，不重复说两遍。
  const progressText = activeJob ? jobCountText(t, activeJob) : ''
  const { useInspiration } = form
  const { selected, isFavorite, toggleFavorite } = library
  const image = selected && selected.image ? selected.image : null
  const item = (selected && selected.item) || null
  // 视频产物（M4.1）：舞台换成原生 <video> 播放，不参与「相纸 / 显影 / 对比拉帘」那套图片语义。
  const isVideo = Boolean(image && image.mediaType === 'video')
  // 导入图焦点隔离（M2.6）：裸导入图与由其直接放大的产物同属「无生成参数」家族，
  // 舞台题注按导入图展示，且不提供「重新生成」（没有可用的原始提示词）。
  const importLocked = Boolean(library && library.importLocked)
  const bareImportFamily = isBareImportOf(selected) || importLocked
  const params = (item && item.params) || null
  // 真实 Host 的历史条目只保证有 prompt，params 可能不存在；都不能时保持空串。
  const prompt = (item && typeof item.prompt === 'string' && item.prompt)
    || (params && typeof params.prompt === 'string' && params.prompt)
    || ''
  const closeRef = React.useRef(null)
  const lightboxRef = React.useRef(null)
  // 打开大图前的焦点位置：关闭后还给触发按钮。
  const zoomOpenerRef = React.useRef(null)

  function openZoom() {
    zoomOpenerRef.current = document.activeElement || null
    setZoom(true)
  }

  /**
   * 视频抽帧（M4.2）：把当前视频的首帧 / 尾帧落成一张**普通作品**。
   *
   * 为什么落成作品而不是临时预览：落盘后它就能当参考图继续做 I2V、当底图做局部重绘，
   * 版本树 / 历史 / 导入元数据全部复用现有链路，不必为视频单独造一套加工体系。
   * 抽帧本身在渲染进程完成（`<video>` → `<canvas>` → dataURL），Host 不依赖 ffmpeg。
   */
  async function captureFrame(phase) {
    const node = videoRef.current
    if (!node || captureBusy) return
    if (!image || !canCaptureFrameOf(image)) return
    if (!actions || typeof actions.importFrame !== 'function') return
    setCaptureBusy(phase)
    try {
      const duration = Number.isFinite(Number(node.duration))
        ? Number(node.duration)
        : (Number(image.duration) || 0)
      await seekVideoFrame(node, frameSeekOf(phase, duration))
      const sourceWidth = Number(node.videoWidth) || Number(image.width) || 0
      const sourceHeight = Number(node.videoHeight) || Number(image.height) || 0
      const size = frameCanvasSize(sourceWidth, sourceHeight)
      if (!size.width || !size.height) return
      const canvas = document.createElement('canvas')
      canvas.width = size.width
      canvas.height = size.height
      const context = canvas.getContext('2d')
      if (!context) return
      context.drawImage(node, 0, 0, size.width, size.height)
      const dataUrl = canvas.toDataURL('image/png')
      if (!aliveRef.current) return
      await actions.importFrame({
        dataUrl,
        phase,
        name: frameNameOf(image.file || image.path || '', phase, { zh: getLanguage() === 'zh' }),
      })
    } finally {
      if (aliveRef.current) setCaptureBusy('')
    }
  }

  // ── 图片工具编排 ───────────────────────────────────────────────
  //
  // 状态全部在 useImageTool：Stage 只决定「现在显示预览、画布还是重绘条」，
  // 并把动作坞需要的工具描述符补上本地化文案与可用状态。
  const activeTool = imageTool && imageTool.activeTool ? imageTool.activeTool : null
  const editorOpen = Boolean(imageTool && imageTool.editorOpen && activeTool && imageTool.target)

  // ── 本地导入与拉帘对比（阶段十五 Phase A3）────────────────────
  //
  // 导入入口包住整个舞台（含编辑态）：编辑态拖入时由 ImageDropzone 提示并拒绝，
  // 不覆盖正在涂抹的草稿。对比层只对带 sourceImage 的派生作品开放。
  const dropzoneRef = React.useRef(null)
  const compareOpen = Boolean(ui && ui.compareOpen)
  const setCompareOpen = ui && typeof ui.setCompareOpen === 'function' ? ui.setCompareOpen : null
  const imageKey = image ? (image.path || image.file || image.url || '') : ''
  // 从画廊切回创作页时首张图跟舞台一起入场，不再叠加 ofs-print-swap；之后点胶片条切图恢复 swap。
  const mountImageKeyRef = React.useRef(imageKey)
  const suppressSwap = Boolean(viewEnter) && mountImageKeyRef.current === imageKey
  // 真实 Host 的派生条目直接带 sourceImage；旧记录可能只写在 params 里。
  const sourceImage = (item && typeof item.sourceImage === 'string' && item.sourceImage)
    || (params && typeof params.sourceImage === 'string' && params.sourceImage)
    || ''
  const compareUrl = sourceImage ? referenceUrlOf(sourceImage) : ''
  // 扩图产物：原图只占画布的一块区域，拉帘时按 outpaintContent 放回真实位置；
  // 普通派生作品 / 旧记录没有该字段时为 null，CompareSlider 保持整幅底图的既有行为。
  const compareContent = item && item.outpaintContent
    ? normalizeOutpaintContent(item.outpaintContent)
    : null
  // 切图时收起对比：拉帘不能停在上一张作品的原图上。
  // 用「上一张图的键」而不是首次挂载就关，避免助手胶囊先置 compareOpen=true 再挂载舞台时被立刻关掉。
  const compareKeyRef = React.useRef(imageKey)
  React.useEffect(() => {
    if (compareKeyRef.current === imageKey) return
    compareKeyRef.current = imageKey
    if (setCompareOpen) setCompareOpen(false)
  }, [imageKey, setCompareOpen])
  // 进入图片工具编辑态时同样收起：编辑分支不展示拉帘。
  React.useEffect(() => {
    if (editorOpen && setCompareOpen) setCompareOpen(false)
  }, [editorOpen, setCompareOpen])
  // 新画布与空舞台才给「选择图片」入口；有作品时舞台留给作品与动作坞。
  const hasGallery = Array.isArray(library.gallery) && library.gallery.length > 0
  const draftCard = library.newDraftCard && typeof library.newDraftCard === 'object' ? library.newDraftCard : {}
  const showNewDraft = library.workspaceMode === 'new_draft'
    && (hasGallery || draftCard.pending === true || Boolean(activeJob) || draftCard.explicit === true)
  const showChoose = !editorOpen && !activeJob && (showNewDraft || !image)
  // 方案 3（参数改写分叉态）：正在预览既有作品、且左栏已相对该作品做了未提交修改时，
  // 让光桌上的原图柔顺退后作参照，同时在前景铺开实时跟随表单比例的虚线取景框。
  const formFields = (form && form.form) || {}
  const formPreset = (compute.presets || []).find((option) => option && option.id === formFields.presetId) || null
  const forkIsVideo = Boolean((formPreset && formPreset.mediaType === 'video') || formFields.mediaType === 'video')
  const forkRatio = forkIsVideo
    ? videoFrameRatioOf(formFields, formPreset, null)
    : ratioOf(formFields.width, formFields.height)
  const forkSpecText = forkIsVideo
    ? (formFields.ratio || formPreset?.video?.defaultRatio || '16:9')
    : (form && form.ratioId
      ? `${form.ratioId} · ${clampSize(formFields.width)} × ${clampSize(formFields.height)}`
      : `${clampSize(formFields.width)} × ${clampSize(formFields.height)}`)
  const forkLabel = formatText(
    t(forkIsVideo ? 'studio.stage.forkVideoBadge' : 'studio.stage.forkBadge'),
    { spec: forkSpecText },
  )
  const draftView = form && form.draftView && typeof form.draftView === 'object' ? form.draftView : null
  const isDraftFork = Boolean(
    image
    && !showNewDraft
    && !editorOpen
    && !compareOpen
    && !activeJob
    && !importLocked
    && draftView
    && draftView.active
    && draftView.source,
  )
  const forkPresence = usePresence(isDraftFork, 220)

  const toolItems = IMAGE_TOOLS.map((tool) => ({
    ...tool,
    label: t(tool.labelKey),
    enabled: tool.ready === true,
    hint: tool.ready === true ? '' : t(tool.plannedKey || 'studio.imageTool.planned'),
  }))
  // 草稿状态：关闭编辑态但仍留有已涂蒙版 / 扩图草稿时，给「继续编辑」一个读数。
  const draftHasInk = Boolean(imageTool && imageTool.mask)
    || Boolean(activeTool && activeTool.id === 'outpaint' && imageTool && imageTool.outpaint && imageTool.outpaint.canvas)
  const draftStatusLabel = activeTool && !editorOpen && draftHasInk
    ? formatText(
        t(activeTool.id === 'outpaint' ? 'studio.outpaint.coverage' : 'studio.imageTool.draftStatus'),
        { percent: percentOf(imageTool.coverage) },
      )
    : ''
  const resumeLabel = activeTool ? t('studio.imageTool.resumeDraft') : ''

  /** 工具提交栏需要的 props：MaskEditor / InlineTool 共用，避免两处漂移。 */
  const submitProps = {
    t,
    target: imageTool ? imageTool.target : null,
    tool: activeTool,
    // 只列当前工具真正可用的预设（inpaint 要 supportsInpaint、img2img 要 supportsImg2Img 且非 inpaintOnly）：
    // 列全量会让用户选到不支持能力的模型，切换请求被静默拒绝。
    presets: imageTool && Array.isArray(imageTool.toolPresets) ? imageTool.toolPresets : [],
    presetId: imageTool ? imageTool.presetId : '',
    onPresetChange: imageTool ? imageTool.selectPreset : () => {},
    prompt: imageTool ? imageTool.prompt : '',
    onPromptChange: imageTool ? imageTool.setPrompt : () => {},
    strength: imageTool ? imageTool.strength : 0,
    strengthMax: imageTool ? imageTool.strengthMax : 0,
    strengthAuto: imageTool ? imageTool.strengthAuto : false,
    onStrengthChange: imageTool ? imageTool.setStrength : () => {},
    submitting: Boolean(imageTool && imageTool.submitting),
    canSubmit: Boolean(imageTool && imageTool.canSubmit),
    blockedKey: imageTool ? imageTool.submitBlockedKey : '',
    onSubmit: imageTool ? imageTool.submit : () => {},
    // 「暂存涂抹」与 Esc 保留蒙版草稿并收起；底部红色「取消」按钮丢弃草稿并退出。
    onStash: imageTool ? imageTool.closeTool : () => {},
    onExit: imageTool ? (imageTool.discardTool || imageTool.closeTool) : () => {},
  }

  const target = imageTool ? imageTool.target : null
  const promptPlaceholder = toolPromptPlaceholderOf({
    t,
    toolId: activeTool ? activeTool.id : '',
    targetPrompt: target && target.prompt,
  })
  // 画布编辑器内部有底图尺寸 / 加载态 / 画笔等本地状态：显式挂 key，换底图时整块重建，
  // 避免沿用上一张图的画布尺寸与「已加载」判断（阶段十五 Phase C0）。
  const editorKey = target && target.path ? target.path : 'none'

  const editorNode = editorOpen
    ? (activeTool.form === 'canvas'
      ? (activeTool.id === 'outpaint'
        ? (
          <OutpaintEditor
            key={editorKey}
            {...submitProps}
            outpaint={imageTool.outpaint}
            coverage={imageTool.coverage}
            onRatioChange={imageTool.setOutpaintRatio}
            onAnchorChange={imageTool.setOutpaintAnchor}
            onCanvasApply={imageTool.applyOutpaintCanvas}
          />
        )
        : <MaskEditor key={editorKey} {...submitProps} mask={imageTool.mask} coverage={imageTool.coverage} onMaskApply={imageTool.applyMask} onMaskClear={imageTool.clearMask} />)
      : <InlineTool {...submitProps} />)
    : null

  const dock = (
    <ImageDock
      t={t}
      tools={toolItems}
      activeToolId={activeTool ? activeTool.id : ''}
      editing={editorOpen}
      resumeLabel={resumeLabel}
      draftStatusLabel={draftStatusLabel}
      onOpen={(toolId) => actions.openImageTool(toolId)}
      onResume={() => {
        if (!activeTool) return
        // 用草稿绑定的底图重新进入编辑态，避免用户切过预览后「继续编辑」串到别的作品。
        const target = imageTool.target
        const entry = target
          ? { image: { path: target.path, url: target.url, width: target.width, height: target.height }, item: target.item || null }
          : selected
        actions.openImageTool(activeTool.id, entry)
      }}
      onClose={() => imageTool.closeTool()}
      onReroll={() => actions.reroll(selected)}
      rerollDisabled={bareImportFamily}
      rerollTitle={bareImportFamily ? t('studio.import.rerollDisabled') : ''}
      onUseReference={() => actions.useAsReference(selected)}
      plannedTitle={t('studio.imageTool.planned')}
    />
  )

  // 编辑态：画布放进 .ofs-figure（画布按容器宽高换算，不挤小），提交条原地落到舞台下方替代动作坞，
  // 整图重绘自带预览与提交条。不再多挂一行重复的「退出」dock。
  let content = null
  if (editorOpen) {
    content = (
      <section className="ofs-stage" data-view-enter={viewEnter ? 'true' : undefined}>
        {activeTool.form === 'canvas' ? (
          <>
            <figure className="ofs-figure">{editorNode}</figure>
            <ToolSubmitBar
              {...submitProps}
              promptPlaceholder={promptPlaceholder}
              maskCoverage={imageTool ? imageTool.coverage : 0}
              metaLabel={activeTool.id === 'outpaint' ? t('studio.outpaint.coverage') : undefined}
              metaPercent={activeTool.id === 'outpaint' ? (imageTool ? imageTool.coverage : 0) : undefined}
            />
          </>
        ) : (
          editorNode
        )}
        {activeJob ? (
          <div className="ofs-stage-progress" aria-hidden="true">
            <span className="ofs-shimmer" aria-hidden="true" />
            <span className="ofs-progress-label">{progressText}</span>
          </div>
        ) : null}
      </section>
    )
  } else if (showNewDraft) {
    // 显式新建绘图态（阶段十三）：打开工作台默认新建画布；已有历史或显式点过「新建创作」时
    // 显示模糊动态背景 + 取景框，没有历史且未手动点新建时继续展示新手引导（灵感示例 + 云端提示）。
    const stopped = Boolean(compute.status && compute.status.stopped)
    const fields = (form && form.form) || {}
    const preset = (compute.presets || []).find((option) => option && option.id === fields.presetId) || null
    const isVideoDraft = Boolean(
      (preset && preset.mediaType === 'video')
      || fields.mediaType === 'video'
      || (activeJob && activeJob.mediaType === 'video'),
    )
    const refs = referenceListOf(fields.references)
    const frameRatio = isVideoDraft
      ? videoFrameRatioOf(fields, preset, activeJob)
      : ratioOf(fields.width, fields.height)
    const steady = preset && Number.isFinite(Number(preset.steadySeconds)) ? Number(preset.steadySeconds) : null
    const videoModeLabel = refs.length >= 2
      ? t('studio.stage.videoModeTransition')
      : refs.length === 1
        ? t('studio.stage.videoModeFirst')
        : t('studio.stage.videoModeText')
    const videoDurationLabel = preset?.video?.supportsDuration === true
      ? formatText(t('studio.video.seconds'), {
          seconds: Number.isFinite(Number(fields.duration))
            ? Math.round(Number(fields.duration))
            : (preset?.video?.duration?.default ?? 5),
        })
      : t('studio.preset.videoFixed')
    const videoSpecHud = [
      refs.length > 0 ? t('studio.video.followFirstFrame') : (fields.ratio || preset?.video?.defaultRatio || '16:9'),
      videoDurationLabel,
      fields.resolution || preset?.video?.defaultResolution || '',
    ].filter(Boolean).join(' · ')
    const videoDraftHintText = refs.length >= 2
      ? t('studio.stage.videoDraftTransitionHint')
      : refs.length === 1
        ? t('studio.stage.videoDraftFirstHint')
        : t('studio.stage.videoDraftHint')
    const inspireList = isVideoDraft ? VIDEO_INSPIRE_KEYS : INSPIRE_KEYS
    content = (
      <section className={`ofs-stage ofs-stage--draft${isVideoDraft ? ' is-video-mode' : ''}`} data-view-enter={viewEnter ? 'true' : undefined}>
        <div className="ofs-figure ofs-figure--draft">
          <div className="ofs-draft-backdrop" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div
            className={`ofs-frame ofs-frame--draft${isVideoDraft ? ' ofs-frame--video' : ''}`}
            data-exposing={activeJob ? 'true' : undefined}
            style={{ '--ofs-frame-r': String(frameRatio) }}
          >
            {/* 换纸：裁切标记随外框比例过渡自然滑移，不再重挂载闪动。 */}
            <span className="ofs-marks" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <div className="ofs-frame-body">
              {isVideoDraft ? (
                <div className="ofs-video-hud">
                  <span className="ofs-video-hud-mode">
                    <Icon name="film" size={12} />
                    {videoModeLabel}
                  </span>
                  <span className="ofs-video-hud-spec">{videoSpecHud}</span>
                </div>
              ) : null}
              <div className="ofs-empty-card ofs-draft-blank">
                <p className="ofs-empty-title">
                  {t(isVideoDraft ? 'studio.stage.videoDraftTitle' : 'studio.stage.newDraftTitle')}
                </p>
                <p className="ofs-muted">
                  {draftCard.pending || activeJob
                    ? t(isVideoDraft ? 'studio.stage.videoDraftPending' : 'studio.stage.newDraftPending')
                    : (stopped ? t('studio.stage.stoppedHint') : (isVideoDraft ? videoDraftHintText : t('studio.stage.newDraftHint')))}
                </p>
                {isVideoDraft && (draftCard.pending || activeJob) ? (
                  <p className="ofs-video-expect">{t('studio.stage.videoQueueExpect')}</p>
                ) : null}
                {/* 阶段十五 A1：点草稿卡恢复后，取景框注明草稿的来源作品（§6.1.4）。 */}
                {draftCard.draft === true && draftCard.draftFrom ? (
                  <p className="ofs-draft-source">
                    {formatText(t('studio.stage.draftFrom'), { prompt: draftCard.draftFrom })}
                  </p>
                ) : null}
                {!draftCard.pending && !activeJob && !draftCard.prompt ? (
                  <div className="ofs-examples">
                    <span className="ofs-examples-label">{t('studio.stage.examples')}</span>
                    {inspireList.map((key) => (
                      <button type="button" key={key} className="ofs-example" onClick={() => useInspiration(t(key))} title={t(key)}>
                        {t(`${key}.label`)}
                      </button>
                    ))}
                  </div>
                ) : null}
                {!draftCard.pending && !activeJob && steady !== null ? (
                  <p className="ofs-exposure">
                    <span className="ofs-exposure-rule" aria-hidden="true" />
                    {t('studio.stage.steady')} {formatSeconds(t, steady)}
                    <span className="ofs-exposure-rule" aria-hidden="true" />
                  </p>
                ) : null}

                {/* 进行中：进度胶囊排进引导文案下方（而不是浮在正中压住句子）。 */}
                {activeJob ? (
                  <div className={`ofs-stage-progress is-flow${isVideoDraft ? ' is-video-timeline' : ''}`} aria-hidden="true">
                    <span className="ofs-shimmer" aria-hidden="true" />
                    <span className="ofs-progress-label">{progressText}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>
    )
  } else if (!image) {
    // 手动关闭云端后不能再说「点击生成即可出图」：生成会被宿主拒绝，先提示唤醒。
    const stopped = Boolean(compute.status && compute.status.stopped)
    // 等待出图时取景框按这次任务的尺寸画；空闲时按当前表单比例画。
    const jobParams = (activeJob && activeJob.params) || {}
    const fields = (form && form.form) || {}
    const preset = (compute.presets || []).find((option) => option && option.id === fields.presetId) || null
    const isVideoDraft = Boolean(
      (preset && preset.mediaType === 'video')
      || fields.mediaType === 'video'
      || (activeJob && activeJob.mediaType === 'video'),
    )
    const refs = referenceListOf(fields.references)
    const frameRatio = isVideoDraft
      ? videoFrameRatioOf(fields, preset, activeJob)
      : ratioOf(jobParams.width || fields.width, jobParams.height || fields.height)
    // 曝光单：这台机器在这个预设上大概多久出一张，先给个准话再让人点生成。
    const steady = preset && Number.isFinite(Number(preset.steadySeconds)) ? Number(preset.steadySeconds) : null
    const videoModeLabel = refs.length >= 2
      ? t('studio.stage.videoModeTransition')
      : refs.length === 1
        ? t('studio.stage.videoModeFirst')
        : t('studio.stage.videoModeText')
    const videoDurationLabel = preset?.video?.supportsDuration === true
      ? formatText(t('studio.video.seconds'), {
          seconds: Number.isFinite(Number(fields.duration))
            ? Math.round(Number(fields.duration))
            : (preset?.video?.duration?.default ?? 5),
        })
      : t('studio.preset.videoFixed')
    const videoSpecHud = [
      refs.length > 0 ? t('studio.video.followFirstFrame') : (fields.ratio || preset?.video?.defaultRatio || '16:9'),
      videoDurationLabel,
      fields.resolution || preset?.video?.defaultResolution || '',
    ].filter(Boolean).join(' · ')
    const videoDraftHintText = refs.length >= 2
      ? t('studio.stage.videoDraftTransitionHint')
      : refs.length === 1
        ? t('studio.stage.videoDraftFirstHint')
        : t('studio.stage.videoDraftHint')
    const inspireList = isVideoDraft ? VIDEO_INSPIRE_KEYS : INSPIRE_KEYS
    content = (
      <section className={`ofs-stage${isVideoDraft ? ' is-video-mode' : ''}`} data-view-enter={viewEnter ? 'true' : undefined}>
        <div className="ofs-figure ofs-figure--empty">
          <div
            className={`ofs-frame${isVideoDraft ? ' ofs-frame--video' : ''}`}
            data-exposing={activeJob ? 'true' : undefined}
            style={{ '--ofs-frame-r': String(frameRatio) }}
          >
            {/* 换纸：裁切标记随外框比例过渡自然滑移，不再重挂载闪动。 */}
            <span className="ofs-marks" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>

            <div className="ofs-frame-body">
              {isVideoDraft ? (
                <div className="ofs-video-hud">
                  <span className="ofs-video-hud-mode">
                    <Icon name="film" size={12} />
                    {videoModeLabel}
                  </span>
                  <span className="ofs-video-hud-spec">{videoSpecHud}</span>
                </div>
              ) : null}
              {activeJob ? (
                isVideoDraft ? (
                  <div className="ofs-empty-card ofs-video-waiting-card">
                    <p className="ofs-empty-title">{t('studio.stage.videoDraftPending')}</p>
                    <p className="ofs-video-expect">{t('studio.stage.videoQueueExpect')}</p>
                  </div>
                ) : null
              ) : (
                <div className="ofs-empty-card">
                  <p className="ofs-empty-title">{t(isVideoDraft ? 'studio.stage.videoDraftTitle' : 'studio.stage.empty')}</p>
                  <p className="ofs-muted">{stopped ? t('studio.stage.stoppedHint') : (isVideoDraft ? videoDraftHintText : t('studio.stage.emptyHint'))}</p>
                  <div className="ofs-examples">
                    <span className="ofs-examples-label">{t('studio.stage.examples')}</span>
                    {inspireList.map((key) => (
                      <button type="button" key={key} className="ofs-example" onClick={() => useInspiration(t(key))} title={t(key)}>
                        {t(`${key}.label`)}
                      </button>
                    ))}
                  </div>
                  {steady !== null ? (
                    <p className="ofs-exposure">
                      <span className="ofs-exposure-rule" aria-hidden="true" />
                      {t('studio.stage.steady')} {formatSeconds(t, steady)}
                      <span className="ofs-exposure-rule" aria-hidden="true" />
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </div>

          {activeJob ? (
            <div className={`ofs-stage-progress is-inside${isVideoDraft ? ' is-video-timeline' : ''}`} aria-hidden="true">
              <span className="ofs-shimmer" aria-hidden="true" />
              <span className="ofs-progress-label">{progressText}</span>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  // 作品分支：相纸 + 玻璃按钮 + 动作坞。带 sourceImage 的派生作品可切「对比原图」拉帘，
  // 打开时用 CompareSlider 原位替代相纸（放大 / 收藏 / 复制路径按钮保持可用）。
  if (!content) {
    const favorite = isFavorite(image.path || image.file)
    // 「复制文件路径」要给绝对路径：历史条目里带 absolute，老记录退回相对路径。
    const copyTarget = image.absolute || image.path || image.file
    const bridge = desktop()
    const canRevealFile = Boolean(image.absolute && bridge && typeof bridge.showItemInFolder === 'function')
    const printRatio = ratioOf(image.width, image.height)
    // 刚落定的图才播一次显影；翻历史作品直接陈列。
    const developing = isFreshItem(item, now)

    content = (
      <section className={isDraftFork ? 'ofs-stage is-draft-fork' : 'ofs-stage'} data-view-enter={viewEnter ? 'true' : undefined}>
        <figure className={isDraftFork ? 'ofs-figure is-draft-fork' : 'ofs-figure'}>
          <div className="ofs-print-slot">
            {compareOpen && compareUrl ? (
              <CompareSlider
                // 拉帘内部有分隔线位置等本地状态：换作品时按图路径重建，不沿用上一张的分隔位置。
                key={imageKey}
                t={t}
                beforeUrl={compareUrl}
                afterUrl={image.url}
                beforeContent={compareContent}
                beforeLabel={t('studio.compare.before')}
                afterLabel={t('studio.compare.after')}
                ratio={printRatio}
              />
            ) : isVideo ? (
              <div
                key={imageKey}
                className="ofs-print ofs-print--video"
                style={{ '--ofs-print-r': String(printRatio) }}
              >
                <video
                  ref={videoRef}
                  className="ofs-video"
                  src={image.url}
                  controls
                  autoPlay
                  loop
                  playsInline
                  preload="metadata"
                />
              </div>
            ) : (
              <button
                type="button"
                key={imageKey}
                className={developing ? 'ofs-print is-developing' : 'ofs-print'}
                data-no-swap={suppressSwap ? 'true' : undefined}
                style={{ '--ofs-print-r': String(printRatio) }}
                onClick={openZoom}
                title={t('studio.stage.zoom')}
              >
                <img src={image.url} alt={prompt || image.file || t('studio.image.alt')} className="ofs-image" draggable={false} />
              </button>
            )}

            <div className="ofs-figure-tools">
              {compareUrl && setCompareOpen ? (
                <button
                  type="button"
                  className={compareOpen ? 'ofs-glass-btn is-on' : 'ofs-glass-btn'}
                  onClick={() => setCompareOpen(!compareOpen)}
                  title={t('studio.compare.toggle')}
                  aria-label={t('studio.compare.toggle')}
                  aria-pressed={compareOpen}
                >
                  <Icon name="images" size={16} />
                </button>
              ) : null}
              <button type="button" className="ofs-glass-btn" onClick={openZoom} title={t('studio.stage.zoom')} aria-label={t('studio.stage.zoom')}>
                <Icon name="expand" size={16} />
              </button>
              <button
                type="button"
                className="ofs-glass-btn"
                data-copied={copiedPath ? 'true' : undefined}
                onClick={() => {
                  copyPath(copyTarget)
                  setCopiedPath(true)
                  if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
                  copyTimerRef.current = setTimeout(() => setCopiedPath(false), 1400)
                }}
                title={t('studio.action.copyPath')}
                aria-label={t('studio.action.copyPath')}
              >
                <Icon name={copiedPath ? 'check' : 'copy'} size={16} />
              </button>
              {canRevealFile ? (
                <button
                  type="button"
                  className="ofs-glass-btn"
                  onClick={() => bridge.showItemInFolder(image.absolute)}
                  title={t('studio.action.revealFile')}
                  aria-label={t('studio.action.revealFile')}
                >
                  <Icon name="folder" size={16} />
                </button>
              ) : null}
              <button
                type="button"
                className={favorite ? 'ofs-glass-btn is-on' : 'ofs-glass-btn'}
                data-just-starred={starPop ? 'true' : undefined}
                onClick={() => {
                  if (!favorite) {
                    setStarPop(true)
                    if (starTimerRef.current) clearTimeout(starTimerRef.current)
                    starTimerRef.current = setTimeout(() => setStarPop(false), 420)
                  } else {
                    setStarPop(false)
                  }
                  toggleFavorite(image.path || image.file)
                }}
                title={favorite ? t('studio.action.favorited') : t('studio.action.favorite')}
                aria-label={favorite ? t('studio.action.favorited') : t('studio.action.favorite')}
                aria-pressed={favorite}
              >
                <Icon name={favorite ? 'starFilled' : 'star'} size={16} />
              </button>
            </div>
          </div>

          {forkPresence.mounted ? (
            <div
              className="ofs-fork-frame"
              data-exiting={forkPresence.exiting ? 'true' : undefined}
              style={{ '--ofs-fork-r': String(forkRatio) }}
              aria-hidden="true"
            >
              <span className="ofs-marks">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span className="ofs-fork-badge">
                <span className="ofs-fork-badge-dot" />
                {forkLabel}
              </span>
            </div>
          ) : null}

          {/* 视频抽帧（M4.2）：取出的帧会落成一张普通作品，可直接当参考图 / 底图继续加工。
              纯渲染进程完成，Host 不需要 ffmpeg。 */}
          {isVideo ? (
            <div className="ofs-video-tools" role="group" aria-label={t('studio.video.captureGroup')}>
              {(['first', 'last']).map((phase) => (
                <button
                  key={phase}
                  type="button"
                  className="ofs-video-capture"
                  aria-busy={captureBusy === phase ? 'true' : undefined}
                  disabled={captureBusy !== ''}
                  onClick={() => captureFrame(phase)}
                >
                  <Icon name="film" size={13} />
                  {captureBusy === phase
                    ? t('studio.video.capturing')
                    : t(phase === 'last' ? 'studio.video.captureLast' : 'studio.video.captureFirst')}
                </button>
              ))}
            </div>
          ) : null}

          {activeJob ? (
            <div className="ofs-stage-progress" aria-hidden="true">
              <span className="ofs-shimmer" aria-hidden="true" />
              <span className="ofs-progress-label">{progressText}</span>
            </div>
          ) : null}
        </figure>

        <div className="ofs-stage-foot">
          {bareImportFamily ? (
            <p className="ofs-stage-prompt is-import" title={prompt || image.file || undefined}>
              <span className="ofs-stage-import-badge">
                <Icon name="image" size={12} />
                {t('studio.gallery.imported')}
              </span>
              <span>{prompt || image.file}</span>
            </p>
          ) : (
            <p className="ofs-stage-prompt" title={prompt || undefined}>{prompt}</p>
          )}
          <div className="ofs-stage-meta">
            <span>
              {image.width || '—'} × {image.height || '—'}
            </span>
            <span aria-hidden="true">·</span>
            {/* 视频产物（M4.1）：给出片长；生成耗时放到标题提示里，不占正行读数。 */}
            {isVideo ? (
              Number(image.duration) > 0 ? (
                <span>{formatText(t('studio.video.seconds'), { seconds: Number(image.duration) })}</span>
              ) : (
                <span>{t('unit.video')}</span>
              )
            ) : (
              <span>{formatSeconds(t, image.seconds)}</span>
            )}
            <span aria-hidden="true">·</span>
            <span>
              {t('studio.meta.seed')} {image.seed ?? '—'}
            </span>
            {item && item.provider ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="ofs-stage-provider" title={item.device || undefined}>
                  {providerLabelOf(t, item.provider)}
                  {item.device ? ` · ${deviceShortOf(item.device)}` : ''}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {isVideo ? null : dock}

        {zoomPresence.mounted ? (
          <div
            className="ofs-lightbox"
            data-exiting={zoomPresence.exiting ? 'true' : undefined}
            data-zoomed={lbScale > 1 ? 'true' : undefined}
            data-dragging={lbDragging ? 'true' : undefined}
            role="dialog"
            aria-modal="true"
            aria-label={t('studio.stage.zoom')}
            ref={lightboxRef}
            onClick={() => {
              if (zoomPresence.exiting) return
              if (lbDragRef.current && lbDragRef.current.moved) return
              setZoom(false)
            }}
          >
            {isVideo ? (
              <video
                className="ofs-lightbox-video"
                src={image.url}
                controls
                autoPlay
                loop
                playsInline
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
            <img
              src={image.url}
              alt={prompt || image.file || t('studio.image.alt')}
              draggable={false}
              style={lbScale > 1 || lbPan.x !== 0 || lbPan.y !== 0
                ? { transform: `translate3d(${lbPan.x}px, ${lbPan.y}px, 0) scale(${lbScale})` }
                : undefined}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (lbScale > 1) {
                  setLbScale(1)
                  setLbPan({ x: 0, y: 0 })
                } else {
                  setLbScale(2.1)
                }
              }}
              onPointerDown={(event) => {
                if (lbScale <= 1 || (event && event.button !== undefined && event.button !== 0)) return
                event.stopPropagation()
                if (typeof event.preventDefault === 'function') event.preventDefault()
                setLbDragging(true)
                lbDragRef.current = { x: event.clientX, y: event.clientY, origX: lbPan.x, origY: lbPan.y, moved: false }
                if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function' && event.pointerId !== undefined) {
                  try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
                }
              }}
              onPointerMove={(event) => {
                const drag = lbDragRef.current
                if (!drag) return
                const dx = (Number(event.clientX) || 0) - drag.x
                const dy = (Number(event.clientY) || 0) - drag.y
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
                setLbPan({ x: drag.origX + dx, y: drag.origY + dy })
              }}
              onPointerUp={(event) => {
                setLbDragging(false)
                if (event.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function' && event.pointerId !== undefined) {
                  try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
                }
                setTimeout(() => { lbDragRef.current = null }, 0)
              }}
              onPointerCancel={() => {
                setLbDragging(false)
                lbDragRef.current = null
              }}
            />
            )}
            <button
              ref={closeRef}
              type="button"
              className="ofs-lightbox-close"
              onClick={(event) => {
                event.stopPropagation()
                setZoom(false)
              }}
              aria-label={t('studio.stage.close')}
            >
              <Icon name="close" size={16} />
            </button>
            {/* 大图预览里的「以此图重绘」：一步直达局部涂抹（决策 D4）。视频没有重绘语义。 */}
            {isVideo ? null : (
            <button
              type="button"
              className="ofs-lightbox-action"
              onClick={(event) => {
                // 放大层本身点任意位置都会关闭，这个按钮单独处理，避免先关层再弹提示。
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                actions.openImageTool('inpaint', selected)
              }}
            >
              <Icon name="image" size={15} />
              {t('studio.action.reference')}
            </button>
            )}
          </div>
        ) : null}
      </section>
    )
  }

  // 拖放 / 粘贴 / 选择图片包住整个舞台（含编辑态，编辑态拖入由 ImageDropzone 提示并拒绝）。
  // onImported 缺接线时留给组件回退 toast，不伪造焦点切换。
  const onImported = actions && typeof actions.activateImport === 'function' ? actions.activateImport : undefined
  const onDropWork = actions && typeof actions.dropWorkToStage === 'function'
    ? actions.dropWorkToStage
    : (payload) => {
        if (payload && payload.entry && actions && typeof actions.previewWork === 'function') {
          actions.previewWork(payload.entry)
          return
        }
        if (payload && payload.path && library && typeof library.openMessage === 'function') {
          library.openMessage(payload.path)
        }
      }
  return (
    <ImageDropzone
      t={t}
      ui={ui}
      editorOpen={editorOpen}
      hasWork={Boolean(image)}
      currentPath={imageKey}
      showChoose={showChoose}
      triggerRef={dropzoneRef}
      onImported={onImported}
      onDropWork={onDropWork}
    >
      {content}
    </ImageDropzone>
  )
}
