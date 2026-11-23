/**
 * 资产工坊（M4.2a / M4.2b / M4.2c）：独立整页视图。
 *
 * 页面分三段：
 *   .ofs-workshop-head   单行工具顶栏：按领域分栏全部平铺（平面与提取 / 游戏与 3D）+ 推荐点
 *   .ofs-workshop-body   左侧最近作品 + 参数卡；右侧预览画布（顶部可飘一条极轻提示）+ 通道条
 *   .ofs-workshop-foot   保存到作品库 / 导出 ZIP / 状态文本 / 一个最匹配的接力胶囊
 *
 * 本机确定性算子（像素对齐、序列帧、平铺、SVG 的落盘）全部在渲染进程完成；GPU 后处理
 * （抹除背景 / PBR）只负责提交任务，结果由宿主落盘后进入作品库。所有 canvas / Image
 * 操作都在 effects 里做环境判空，Node 渲染测试可以安全挂载。
 *
 * 场景引导来自 `web/logic/workshopPerception.js` 的 L1 感知层：它只看「这张图现在长什么样」
 * 与「它最初是被什么提示词生出来的」，给出一份确定性推荐。感知**只在后台**决定首屏工具落点、
 * 推荐点与底栏接力，不把分类器暴露成前台选择题——用户要纠偏直接点任意工具即可。
 */

import React from 'react'

import { WORKSHOP } from '../../../shared/contract.js'
import { importImageFile } from '../../api/resources.js'
import { downloadWorkZip, saveWorkshopAsset, vectorizeWorkshopImage } from '../../api/workshop.js'
import { formatText } from '../../logic/format.js'
import { jobCountText, jobStatusText } from '../../logic/status.js'
import {
  isWorkshopTool,
  nextToolSuggestions,
  perceiveWorkshopWork,
  workshopToolGroups,
} from '../../logic/workshopPerception.js'
import { Icon } from '../icons.jsx'
import { useSlidingThumb } from '../hooks/useSlidingThumb.js'
import { WorkshopParams, readGuideOpen, writeGuideOpen } from './WorkshopParams.jsx'
import { WorkshopStage } from './WorkshopStage.jsx'
import {
  blendSeamEdgesSafe,
  canUseCanvas,
  canvasDataUrl,
  createCanvas,
  detectPixelGridSafe,
  drawPixels,
  fileToDataUrl,
  imageUrlToDataUrl,
  pixelsOfUrl,
  seamMaeSafe,
  sliceSpriteFramesSafe,
  snapPixelArtSafe,
  svgToDataUrl,
} from './pixels.js'

/** 工具条图标：与工具语义一一对应，缺省用 image。 */
const TOOL_ICONS = {
  'pixel-snap': 'frame',
  'sprite-slice': 'film',
  tile: 'images',
  vectorize: 'sparkles',
  cutout: 'focus',
  pbr: 'cube',
}

/** 工具领域分栏（不改变 `WORKSHOP.tools` 契约与保存链路，只决定顶栏里的分组）。 */
const TOOL_GROUPS = workshopToolGroups()

/** 顶栏的两个工具胶囊：领域 id 与组名的对应关系。 */
const TOOL_CLUSTERS = [
  { id: 'plane', labelKey: 'studio.workshop.group.plane', tools: TOOL_GROUPS.plane },
  { id: 'game3d', labelKey: 'studio.workshop.group.game3d', tools: TOOL_GROUPS.game3d },
]

/**
 * 一个领域的工具胶囊：组名 + 该领域的全部工具，内部自带滑动高亮。
 *
 * 之所以拆成独立组件而不是在主组件里 map：每个胶囊需要自己的滑块容器与 `useSlidingThumb`
 * 实例，焦点落在别的胶囊时本胶囊的滑块要收起（见该 hook 的说明）。
 * 组件级定义在本模块顶部，避免在渲染里新建组件导致整块重挂载。
 */
function ToolCluster(props) {
  const { t, cluster, activeTool, recommendedTools, onSelect } = props
  const clusterRef = React.useRef(null)
  useSlidingThumb(clusterRef, activeTool)
  return (
    <div
      className="ofs-workshop-cluster"
      data-group={cluster.id}
      role="group"
      aria-label={t(cluster.labelKey)}
      ref={clusterRef}
    >
      <span className="ofs-workshop-cluster-label">{t(cluster.labelKey)}</span>
      <span className="ofs-workshop-cluster-thumb" aria-hidden="true" />
      {cluster.tools.map((toolId) => {
        const isPrimary = recommendedTools[0] === toolId
        return (
          <button
            key={toolId}
            type="button"
            className={toolId === activeTool ? 'ofs-workshop-tool is-on' : 'ofs-workshop-tool'}
            data-tool={toolId}
            data-thumb-key={toolId}
            data-recommended={recommendedTools.includes(toolId) ? 'true' : 'false'}
            data-primary-recommend={isPrimary ? 'true' : 'false'}
            aria-pressed={toolId === activeTool ? 'true' : 'false'}
            onClick={() => onSelect(toolId)}
          >
            <Icon name={TOOL_ICONS[toolId] || 'image'} size={14} />
            {t(`studio.workshop.tool.${toolId}`)}
            {isPrimary ? <span className="ofs-workshop-tool-dot" aria-hidden="true" /> : null}
          </button>
        )
      })}
    </div>
  )
}

/** 通道角色 → 文案键（未知角色回落到「其它通道」）。 */
const CHANNEL_LABEL_KEYS = {
  source: 'studio.workshop.channel.source',
  cutout: 'studio.workshop.channel.cutout',
  albedo: 'studio.workshop.channel.albedo',
  normal: 'studio.workshop.channel.normal',
  roughness: 'studio.workshop.channel.roughness',
  metallic: 'studio.workshop.channel.metallic',
  svg: 'studio.workshop.channel.svg',
  atlas: 'studio.workshop.channel.atlas',
  spritesheet: 'studio.workshop.channel.spritesheet',
  pixel: 'studio.workshop.channel.pixel',
  tile: 'studio.workshop.channel.tile',
  other: 'studio.workshop.channel.other',
}

function channelLabelOf(t, role) {
  return t(CHANNEL_LABEL_KEYS[role] || 'studio.workshop.channel.other')
}

/** 本地工具：渲染进程直接出结果；GPU 工具走任务队列。 */
const LOCAL_TOOLS = new Set(['pixel-snap', 'sprite-slice', 'tile'])
const GPU_TOOLS = new Set(['cutout', 'pbr'])

/** 每个工具的参数初始值：边界全部取自 shared/contract.js 的 WORKSHOP。 */
function defaultParams() {
  return {
    pixel: {
      cell: WORKSHOP.pixel.grid.default,
      colors: WORKSHOP.pixel.colors.default,
      alphaThreshold: WORKSHOP.pixel.alphaThreshold.default,
      scale: WORKSHOP.pixel.scale.default,
    },
    sprite: {
      rows: WORKSHOP.sprite.rows.default,
      cols: WORKSHOP.sprite.cols.default,
      frameMs: WORKSHOP.sprite.frameMs.default,
      trimAlpha: WORKSHOP.sprite.trimAlpha,
    },
    tile: {
      blend: false,
      blendRatio: WORKSHOP.tile.blendRatio.default,
    },
    vector: {
      colorPrecision: WORKSHOP.vector.colorPrecision.default,
      filterSpeckle: WORKSHOP.vector.filterSpeckle.default,
      colormode: 'color',
      hierarchy: 'stacked',
      mode: 'spline',
    },
  }
}

/** 作品展示名：优先文件名，其次路径末段。 */
function workNameOf(image) {
  if (!image) return ''
  if (typeof image.file === 'string' && image.file.trim()) return image.file.trim()
  const path = typeof image.path === 'string' ? image.path.trim() : ''
  return path.split(/[\\/]/).filter(Boolean).pop() || ''
}

/** 作品在图库里的稳定标识：切换作品时用它判断「焦点变了」。 */
function workKeyOf(entry) {
  if (!entry || !entry.image) return ''
  return entry.image.path || entry.image.url || ''
}

export function Workshop(props) {
  const { t, ui, compute, library, actions } = props
  const initialEntry = props.initialEntry && props.initialEntry.image ? props.initialEntry : null
  const initialPath = initialEntry && initialEntry.image
    ? (initialEntry.image.path || initialEntry.image.url || '')
    : ''

  // 最近作品：作品库里的图片作品（视频不进工坊）优先，本地上传的追加在最前。
  const galleryWorks = React.useMemo(() => {
    const gallery = Array.isArray(library && library.gallery) ? library.gallery : []
    return gallery.filter((entry) => entry && entry.image && entry.image.mediaType !== 'video')
  }, [library && library.gallery])
  const [uploadedWorks, setUploadedWorks] = React.useState([])
  const works = React.useMemo(() => {
    const seen = new Set()
    const list = []
    for (const entry of [...uploadedWorks, ...galleryWorks]) {
      const key = entry && entry.image ? (entry.image.path || entry.image.url || '') : ''
      if (!key || seen.has(key)) continue
      seen.add(key)
      list.push(entry)
    }
    return list
  }, [uploadedWorks, galleryWorks])

  const pinnedInitialTool = isWorkshopTool(props.initialTool) ? props.initialTool : ''
  // 首屏先落在「平面与提取」的第一个工具，而不是契约里的 `tools[0]`（像素对齐属于游戏与 3D）：
  // 感知结果到位后再按推荐改写，避免一进工坊就把专业工具怼到普通用户脸上。
  const [tool, setTool] = React.useState(pinnedInitialTool || TOOL_GROUPS.plane[0])
  const [selected, setSelected] = React.useState(() => initialEntry || galleryWorks[0] || null)
  // 作品库是异步加载的：工坊先挂载（例如刷新后从会话恢复 workshop 视图）时没有可用作品，
  // 等历史回来后再自动落到第一张，避免画布一直空着。
  React.useEffect(() => {
    if (selected && selected.image) return
    if (works.length > 0) setSelected(works[0])
  }, [selected, works])
  const [params, setParams] = React.useState(defaultParams)
  const [detected, setDetected] = React.useState(null)
  const [sourcePixels, setSourcePixels] = React.useState(null)
  const [spriteFrames, setSpriteFrames] = React.useState(null)
  const [seam, setSeam] = React.useState(null)
  // 工具结果（本机算子）：{ tool, primary:{ data, width, height }, channels:[], svg?, meta }
  const [result, setResult] = React.useState(() => props.initialResult || props.testResult || null)
  // 已保存过的那一份结果：接力前用它判断「当前结果是否已经落库」。
  const [savedResult, setSavedResult] = React.useState(null)
  // 像素工具的实时预览（调参即看效果）：只在真实 canvas 环境计算，且不替代「应用」产物。
  const [livePixelPreview, setLivePixelPreview] = React.useState('')
  const [channel, setChannel] = React.useState('source')
  const [tilePreview, setTilePreview] = React.useState(false)
  const [playing, setPlaying] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [opDone, setOpDone] = React.useState(false)
  const [cutoutModel, setCutoutModel] = React.useState(WORKSHOP.cutout.defaultModel)
  const [pbrModel, setPbrModel] = React.useState(WORKSHOP.pbr.defaultModel)
  const [pbrSteps, setPbrSteps] = React.useState(WORKSHOP.pbr.steps.default)
  // 参数卡标题栏的 `?`：默认折叠，偏好记在 localStorage（控件优先，说明按需展开）。
  const [guideOpen, setGuideOpen] = React.useState(readGuideOpen)
  // 画布顶部「完整画作可回创作台」提示是否已被用户关掉（换作品时复位）。
  const [studioHintDismissed, setStudioHintDismissed] = React.useState(false)

  const sourceUrl = selected && selected.image ? (selected.image.url || '') : ''
  const sourcePath = selected && selected.image ? (selected.image.path || '') : ''
  const selectedKey = workKeyOf(selected)
  const loadedUrlRef = React.useRef('')
  const lastInitialPathRef = React.useRef(initialPath)
  const pendingAutoChannelRef = React.useRef('')
  // 用户手动点过工具 Tab：切换作品前不再用感知结果覆盖他的选择。
  const pinnedToolRef = React.useRef(Boolean(pinnedInitialTool))
  // 已经为哪一张作品自动落过焦点（避免感知重算时反复改工具）。
  const autoToolRef = React.useRef('')
  // 接力目标工具：跨作品切换时用它压住「自动落焦点」。
  const handoffToolRef = React.useRef('')
  // 测试注入的像素读数（Node 渲染测试没有 canvas，用它驱动真实感知逻辑）。
  const testPixels = props.testSourcePixels || null

  /** 外部（动作坞「进工坊」/ 再次进入）带着新作品进来：切焦点并清空上一张的结果。 */
  React.useEffect(() => {
    if (!initialPath || lastInitialPathRef.current === initialPath) return
    lastInitialPathRef.current = initialPath
    if (initialEntry) {
      setSelected(initialEntry)
      setResult(null)
      setChannel('source')
      setStatus('')
    }
  }, [initialPath, initialEntry])

  /** 载入源图像素：检测 / 平铺 / 切片都以它为基础；换图时清空旧结果。 */
  React.useEffect(() => {
    if (testPixels) {
      setSourcePixels(testPixels)
      return undefined
    }
    if (!sourceUrl) {
      setSourcePixels(null)
      loadedUrlRef.current = ''
      return undefined
    }
    if (loadedUrlRef.current === sourceUrl) return undefined
    // 首次载入只做像素读取，不清空外部注入的结果（预览 / 渲染测试会直接给 initialResult）；
    // 换图时才需要丢掉上一张的算子结果与读数。
    const firstLoad = loadedUrlRef.current === ''
    loadedUrlRef.current = sourceUrl
    if (!firstLoad) {
      setSourcePixels(null)
      setSpriteFrames(null)
      setSeam(null)
      setDetected(null)
      setResult(null)
      setLivePixelPreview('')
      const nextChannel = pendingAutoChannelRef.current || 'source'
      pendingAutoChannelRef.current = ''
      setChannel(nextChannel)
      setTilePreview(false)
      setPlaying(false)
      setOpDone(false)
      setStatus('')
    }
    let alive = true
    pixelsOfUrl(sourceUrl).then((pixels) => {
      if (!alive || !pixels) return
      setSourcePixels(pixels)
    })
    return () => {
      alive = false
    }
  }, [sourceUrl, testPixels])

  /** 换工具：停掉只有特定工具才有意义的播放 / 平铺预览，并清掉上一条操作状态。 */
  React.useEffect(() => {
    setPlaying(false)
    if (tool !== 'tile') setTilePreview(false)
    if (tool !== 'pixel-snap') setLivePixelPreview('')
    setStatus('')
  }, [tool])

  /** 切换作品：收起画布浮层提示，并把「是否手动选过工具」复位。 */
  React.useEffect(() => {
    autoToolRef.current = ''
    setStudioHintDismissed(false)
    const handoffTool = handoffToolRef.current
    handoffToolRef.current = ''
    // 接力时目标工具是显式指定的，不能被「自动落焦点」改回感知首推。
    pinnedToolRef.current = Boolean(handoffTool) || Boolean(pinnedInitialTool)
  }, [selectedKey, pinnedInitialTool])

  /**
   * 像素对齐的实时预览：格距 / 色数 / Alpha / 放大倍数的改动防抖 180ms 后重算，
   * 直接把结果画到预览画布上；点「应用」才把它固化为可保存的结果。
   */
  React.useEffect(() => {
    if (tool !== 'pixel-snap' || !sourcePixels || !canUseCanvas()) {
      setLivePixelPreview('')
      return undefined
    }
    let alive = true
    const timer = setTimeout(() => {
      if (!alive) return
      const snapped = snapPixelArtSafe(sourcePixels, { ...params.pixel })
      if (!snapped) return
      const canvas = createCanvas(snapped.width, snapped.height)
      if (!canvas || !drawPixels(canvas, { width: snapped.width, height: snapped.height, data: snapped.data })) return
      const url = canvasDataUrl(canvas)
      if (alive && url) setLivePixelPreview(url)
    }, 180)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [
    tool,
    sourcePixels,
    params.pixel.cell,
    params.pixel.colors,
    params.pixel.alphaThreshold,
    params.pixel.scale,
  ])

  /** 像素工具：自动探测格距（只探测一次，参数可手动改）。 */
  React.useEffect(() => {
    if (!sourcePixels || tool !== 'pixel-snap') return
    const grid = detectPixelGridSafe(sourcePixels, { alphaCut: params.pixel.alphaThreshold })
    setDetected(grid)
    if (grid && grid.cell > 1) {
      setParams((previous) => (previous.pixel.cell === grid.cell
        ? previous
        : { ...previous, pixel: { ...previous.pixel, cell: grid.cell } }))
    }
  }, [sourcePixels, tool])

  /** 平铺工具：接缝 MAE 读数。 */
  React.useEffect(() => {
    if (!sourcePixels || tool !== 'tile') return
    setSeam(seamMaeSafe(sourcePixels))
  }, [sourcePixels, tool])

  /** 序列帧工具：按行列切帧（参数变化时重算）；失败保持 null 并在参数区不显示帧读数。 */
  React.useEffect(() => {
    if (!sourcePixels || tool !== 'sprite-slice') return
    setSpriteFrames(sliceSpriteFramesSafe(sourcePixels, {
      rows: params.sprite.rows,
      cols: params.sprite.cols,
      trimAlpha: params.sprite.trimAlpha,
    }))
  }, [sourcePixels, tool, params.sprite.rows, params.sprite.cols, params.sprite.trimAlpha])

  // ── 场景感知（L1，纯前端 <10ms）────────────────────────────────
  //
  // 输入三路信号：当前作品的派生状态（channel / workshopTool）、根作品的原生提示词与
  // 预设（rootPrompt / rootPresetId，由 Host 溯源）、以及源图的像素读数。
  // 预设对象只用来读可选的 `sceneTags`；找不到就按「这款模型没有场景偏向」处理。
  const preset = React.useMemo(() => {
    const item = selected && selected.item ? selected.item : null
    const id = item ? (item.rootPresetId || item.presetId || '') : ''
    if (!id) return null
    const list = compute && Array.isArray(compute.presets) ? compute.presets : []
    return list.find((entry) => entry && entry.id === id) || null
  }, [compute && compute.presets, selected])

  const perception = React.useMemo(() => perceiveWorkshopWork({
    pixels: sourcePixels,
    item: selected && selected.item ? selected.item : null,
    preset,
  }), [sourcePixels, selected, preset])

  /**
   * 首屏落焦点：等到像素读数到位后再用感知结果决定初始工具，**不再无脑停在 `pixel-snap`**。
   * 用户手动点过 Tab（`pinnedToolRef`）、或拿不到像素读数时保持原样。
   */
  React.useEffect(() => {
    if (!sourcePixels || !selectedKey) return
    if (pinnedToolRef.current || autoToolRef.current === selectedKey) return
    const recommended = perception.recommendedTools[0]
    if (!isWorkshopTool(recommended)) return
    autoToolRef.current = selectedKey
    setTool(recommended)
  }, [perception, sourcePixels, selectedKey])

  // ── GPU 后处理任务进度（抹除背景 / PBR）─────────────────────────
  const focusedJob = compute && compute.focusedJob ? compute.focusedJob : null
  const activeJob = compute && compute.activeJob ? compute.activeJob : null
  const runningJob = focusedJob || activeJob || null
  const runningJobKey = runningJob ? `${runningJob.id || ''}:${runningJob.status || ''}` : ''
  // 只有本页真正提交过任务后才认「完成 / 失败」：挂载时历史里可能就躺着一条旧任务，
  // 不能一进工坊就提示「处理完成」。
  const opSubmittedRef = React.useRef(false)
  const pendingOutputJobIdRef = React.useRef('')
  React.useEffect(() => {
    const job = focusedJob
    if (!job || !opSubmittedRef.current) return
    if (job.tool !== 'remove-bg' && job.tool !== 'pbr') return
    if (job.status === 'done') {
      opSubmittedRef.current = false
      pendingOutputJobIdRef.current = job.id || ''
      setOpDone(true)
      setStatus(t('studio.workshop.opDone'))
    } else if (job.status === 'failed') {
      opSubmittedRef.current = false
      pendingOutputJobIdRef.current = ''
      setOpDone(false)
      setStatus(t('studio.workshop.opFailed'))
    }
  }, [runningJobKey, focusedJob, t])

  // GPU 后处理完成后等历史刷新回来，自动把工坊焦点切到刚产出的新作品与首通道，
  // 让用户不用再去左侧「最近作品」里手动点一次。
  React.useEffect(() => {
    const jobId = pendingOutputJobIdRef.current
    if (!jobId) return
    const nextEntry = galleryWorks.find((entry) => entry && entry.item && entry.item.jobId === jobId)
    if (!nextEntry) return
    pendingOutputJobIdRef.current = ''
    const firstChannel = Array.isArray(nextEntry.item?.channels) && nextEntry.item.channels[0]
      ? nextEntry.item.channels[0].role
      : 'source'
    pendingAutoChannelRef.current = firstChannel || 'source'
    setSelected(nextEntry)
    setResult(null)
    setChannel(firstChannel || 'source')
  }, [galleryWorks])

  /** 通道条：原图 + 作品 meta.channels（PBR 四通道 / 抹除背景 / SVG / Atlas 等）。 */
  const channelList = React.useMemo(() => {
    if (!selected || !selected.image) return []
    const list = [{
      role: 'source',
      label: t('studio.workshop.channel.source'),
      url: selected.image.url || '',
      thumb: selected.image.url || '',
      format: 'png',
    }]
    const channels = selected.item && Array.isArray(selected.item.channels) ? selected.item.channels : []
    for (const item of channels) {
      if (!item || !item.role) continue
      const format = item.format || 'png'
      list.push({
        role: item.role,
        label: channelLabelOf(t, item.role),
        url: item.url || '',
        // 非图片通道（如 atlas.json）不挂 <img src>，防止出现裂图占位。
        thumb: format === 'json' ? '' : (item.url || ''),
        format,
      })
    }
    return list
  }, [selected, t])

  const resultSvg = result && typeof result.svg === 'string' ? result.svg : ''
  const repeat = tool === 'tile' && tilePreview ? Math.max(1, WORKSHOP.tile.repeat) : 1

  const preview = React.useMemo(() => {
    if (channel !== 'source') {
      const target = channelList.find((item) => item.role === channel)
      if (target && target.url) {
        if (target.format === 'svg') return { type: 'svg', url: target.url }
        if (target.format === 'json') return { type: 'json', url: target.url, label: target.label }
        return { type: 'image', url: target.url }
      }
    }
    if (resultSvg) return { type: 'svg', url: svgToDataUrl(resultSvg) }
    if (result && result.primary && result.primary.data) return { type: 'image', url: result.primary.data }
    // 像素工具尚未点「应用」时，用实时预览代替原图（调参即可见）。
    if (tool === 'pixel-snap' && livePixelPreview) return { type: 'image', url: livePixelPreview }
    if (sourceUrl) return { type: 'image', url: sourceUrl }
    return { type: 'empty' }
  }, [channel, channelList, resultSvg, result, tool, livePixelPreview, sourceUrl])

  const canPlay = tool === 'sprite-slice'
    && Boolean(spriteFrames && Array.isArray(spriteFrames.frames) && spriteFrames.frames.length > 0)
  const canTile = tool === 'tile'

  /** 保存请求体：主图 + 附属通道 + 版本树继承；没有可保存的主图时返回 null。 */
  const savePayload = React.useMemo(() => {
    if (!result || !result.primary || !result.primary.data) return null
    const channels = Array.isArray(result.channels) ? result.channels : []
    const cleanChannels = channels
      .filter((item) => item && item.role && typeof item.data === 'string' && item.data)
      .slice(0, WORKSHOP.channels.maxCount)
      .map((item) => ({
        role: item.role,
        label: item.label || channelLabelOf(t, item.role),
        format: item.format || 'png',
        data: item.data,
      }))
    const baseName = workNameOf(selected && selected.image) || 'workshop'
    return {
      base: sourcePath ? { path: sourcePath } : undefined,
      tool: WORKSHOP.tools.includes(result.tool) ? result.tool : tool,
      name: `${baseName.replace(/\.[a-z0-9]+$/i, '')}-${tool}.png`.slice(0, WORKSHOP.save.maxNameChars),
      primary: {
        data: result.primary.data,
        width: Number(result.primary.width) || 0,
        height: Number(result.primary.height) || 0,
      },
      channels: cleanChannels,
      meta: result.meta && typeof result.meta === 'object' ? result.meta : undefined,
    }
  }, [result, selected, sourcePath, t, tool])

  /** 状态行：GPU 任务进行中优先展示进度，其次显式操作状态，最后按「结果 / 源图 / 空态」给默认读数。 */
  const opRunning = runningJob
    && (runningJob.tool === 'remove-bg' || runningJob.tool === 'pbr')
    && (runningJob.status === 'pending' || runningJob.status === 'running' || runningJob.status === 'queued')
  let statusText = ''
  if (opRunning) {
    statusText = formatText(t('studio.workshop.opRunning'), {
      label: t(runningJob.tool === 'pbr' ? 'studio.workshop.tool.pbr' : 'studio.workshop.tool.cutout'),
      progress: jobCountText(t, runningJob) || jobStatusText(t, runningJob.status),
    })
  } else if (status) {
    statusText = status
  } else if (result && result.primary) {
    statusText = formatText(t('studio.workshop.statusResult'), {
      width: Number(result.primary.width) || 0,
      height: Number(result.primary.height) || 0,
    })
  } else if (selected && selected.image) {
    statusText = formatText(t('studio.workshop.statusSource'), {
      name: workNameOf(selected.image) || t('studio.workshop.sourceUnknown'),
    })
  } else {
    statusText = t('studio.workshop.statusNoSource')
  }

  // ── 接力 ──────────────────────────────────────────────────────

  // 接力建议按「产出这份结果的工具」算，而不是当前选中的工具：
  // 用户切走 Tab 再切回来时，页脚不会给出与结果无关的下一步。
  const handoffSource = result && isWorkshopTool(result.tool) ? result.tool : (opDone ? tool : '')
  const handoff = React.useMemo(
    () => (handoffSource ? nextToolSuggestions({ tool: handoffSource, perception }) : []),
    [handoffSource, perception],
  )
  // 底栏只放一个「最匹配」的下一步，避免在页脚堆一排按钮。
  const primaryHandoff = handoff.length > 0 ? handoff[0] : null
  const handoffNeedsSave = Boolean(result) && savedResult !== result
  const recommendedTools = perception.recommendedTools

  // ── 动作 ───────────────────────────────────────────────────────

  function selectWork(entry) {
    if (!entry || !entry.image) return
    setSelected(entry)
    setResult(null)
    setChannel('source')
    setOpDone(false)
    setStatus('')
  }

  /** 手动点工具 Tab：记为「用户已指定」，切换作品前不再被感知结果覆盖。 */
  function switchTool(nextTool) {
    if (!WORKSHOP.tools.includes(nextTool)) return
    pinnedToolRef.current = true
    autoToolRef.current = selectedKey
    setTool(nextTool)
  }

  /** 参数说明：`?` 开关，默认折叠，偏好写入 localStorage。 */
  function toggleGuide() {
    setGuideOpen((previous) => {
      const next = !previous
      writeGuideOpen(next)
      return next
    })
  }

  function patchParams(section, patch) {
    if (!patch || typeof patch !== 'object') return
    setParams((previous) => ({ ...previous, [section]: { ...previous[section], ...patch } }))
  }

  /** 「自动探测」：按当前论题重新跑一次格距探测。 */
  function handleDetect() {
    if (!sourcePixels) {
      setStatus(t('studio.workshop.canvasUnavailable'))
      return
    }
    const grid = detectPixelGridSafe(sourcePixels, { alphaCut: params.pixel.alphaThreshold })
    setDetected(grid)
    if (grid && grid.cell > 1) patchParams('pixel', { cell: grid.cell })
  }

  /** 「应用」：本机确定性算子出结果（主图 + 附属通道）。 */
  async function handleApply() {
    if (!selected || !selected.image) {
      setStatus(t('studio.workshop.statusNoSource'))
      return
    }
    if (!canUseCanvas() || !sourcePixels) {
      setStatus(t('studio.workshop.canvasUnavailable'))
      return
    }
    if (busy) return
    setBusy('apply')
    try {
      if (tool === 'pixel-snap') {
        const snapped = snapPixelArtSafe(sourcePixels, {
          cell: params.pixel.cell,
          colors: params.pixel.colors,
          alphaThreshold: params.pixel.alphaThreshold,
          scale: params.pixel.scale,
        })
        if (!snapped) throw new Error('snap failed')
        const pixels = { width: snapped.width, height: snapped.height, data: snapped.data }
        const canvas = createCanvas(pixels.width, pixels.height)
        if (!canvas || !drawPixels(canvas, pixels)) throw new Error('draw failed')
        const data = canvasDataUrl(canvas)
        if (!data) throw new Error('encode failed')
        setResult({
          tool,
          primary: { data, width: pixels.width, height: pixels.height },
          channels: [{
            role: 'pixel',
            format: 'png',
            data,
            label: t('studio.workshop.channel.pixel'),
            width: pixels.width,
            height: pixels.height,
          }],
          meta: {
            cell: params.pixel.cell,
            colors: params.pixel.colors,
            alphaThreshold: params.pixel.alphaThreshold,
            scale: params.pixel.scale,
            detected: detected ? { cell: detected.cell, confidence: detected.confidence } : null,
          },
        })
        setStatus(t('studio.workshop.applyDone'))
      } else if (tool === 'sprite-slice') {
        const sliced = spriteFrames || sliceSpriteFramesSafe(sourcePixels, {
          rows: params.sprite.rows,
          cols: params.sprite.cols,
          trimAlpha: params.sprite.trimAlpha,
        })
        if (!sliced || !Array.isArray(sliced.frames) || sliced.frames.length === 0) throw new Error('slice failed')
        // 主图沿用源图（画廊里仍是一张完整序列帧大图），atlas 作为附属通道。
        const primary = await imageUrlToDataUrl(sourceUrl, { maxEdge: WORKSHOP.sprite.maxInputEdge })
        if (!primary) throw new Error('encode failed')
        setSpriteFrames(sliced)
        setResult({
          tool,
          primary: {
            data: primary,
            width: Number(selected.image.width) || 0,
            height: Number(selected.image.height) || 0,
          },
          channels: [
            { role: 'atlas', format: 'json', data: JSON.stringify(sliced.atlas), label: t('studio.workshop.channel.atlas') },
            { role: 'spritesheet', format: 'png', data: primary, label: t('studio.workshop.channel.spritesheet') },
          ],
          meta: {
            rows: params.sprite.rows,
            cols: params.sprite.cols,
            frameMs: params.sprite.frameMs,
            trimAlpha: params.sprite.trimAlpha === true,
            count: sliced.frames.length,
          },
        })
        setStatus(t('studio.workshop.applyDone'))
      } else if (tool === 'tile') {
        const processed = params.tile.blend
          ? blendSeamEdgesSafe(sourcePixels, { borderRatio: params.tile.blendRatio })
          : sourcePixels
        if (!processed) throw new Error('blend failed')
        const pixels = { width: processed.width, height: processed.height, data: processed.data }
        const canvas = createCanvas(pixels.width, pixels.height)
        if (!canvas || !drawPixels(canvas, pixels)) throw new Error('draw failed')
        const data = canvasDataUrl(canvas)
        if (!data) throw new Error('encode failed')
        setSeam(seamMaeSafe(processed))
        setResult({
          tool,
          primary: { data, width: pixels.width, height: pixels.height },
          channels: [{
            role: 'tile',
            format: 'png',
            data,
            label: t('studio.workshop.channel.tile'),
            width: pixels.width,
            height: pixels.height,
          }],
          meta: {
            blend: params.tile.blend === true,
            blendRatio: params.tile.blendRatio,
            before: seam ? { maxSeamMae: seam.maxSeamMae, isSeamless: seam.isSeamless } : null,
          },
        })
        setStatus(t('studio.workshop.applyDone'))
      }
    } catch {
      setStatus(t('studio.workshop.applyFailed'))
    } finally {
      setBusy('')
    }
  }

  /** SVG 矢量：POST /api/workshop/vectorize，取回 svg 用 dataURL 预览，保存时作为 svg 通道。 */
  async function handleVectorize() {
    if (!selected || !selected.image || !sourcePath) {
      setStatus(t('studio.workshop.statusNoSource'))
      return
    }
    if (busy) return
    setBusy('vectorize')
    try {
      const response = await vectorizeWorkshopImage({ path: sourcePath, options: { ...params.vector } })
      if (!response.ok) {
        setStatus(`${t('studio.workshop.vectorizeFailed')}${response.message ? `：${response.message}` : ''}`)
        return
      }
      // 主图用源图 PNG 重新编码；环境不支持 canvas 时仍保留 SVG 结果（保存按钮会提示不可保存主图）。
      const primary = await imageUrlToDataUrl(sourceUrl, { maxEdge: WORKSHOP.vector.maxInputEdge })
      setResult({
        tool: 'vectorize',
        primary: primary
          ? {
              data: primary,
              width: Number(selected.image.width) || response.width || 0,
              height: Number(selected.image.height) || response.height || 0,
            }
          : null,
        svg: response.svg,
        channels: [{
          role: 'svg',
          format: 'svg',
          data: response.svg,
          label: t('studio.workshop.channel.svg'),
          width: response.width || 0,
          height: response.height || 0,
        }],
        meta: {
          colorPrecision: params.vector.colorPrecision,
          filterSpeckle: params.vector.filterSpeckle,
          colormode: params.vector.colormode,
          hierarchy: params.vector.hierarchy,
          mode: params.vector.mode,
        },
      })
      setChannel('source')
      setStatus(formatText(t('studio.workshop.vectorizeDone'), { bytes: response.bytes }))
    } finally {
      setBusy('')
    }
  }

  /** GPU 后处理：提交 remove-bg / pbr 任务（进度由宿主轮询回填）。 */
  async function handleRunGpu() {
    if (!selected || !selected.image || !sourcePath) {
      setStatus(t('studio.workshop.statusNoSource'))
      return
    }
    if (!actions || typeof actions.runWorkshopOp !== 'function') {
      setStatus(t('studio.workshop.opFailed'))
      return
    }
    if (busy) return
    setBusy('op')
    setOpDone(false)
    try {
      const body = tool === 'pbr'
        ? { op: WORKSHOP.pbr.op, path: sourcePath, model: pbrModel, options: { steps: pbrSteps } }
        : { op: WORKSHOP.cutout.op, path: sourcePath, model: cutoutModel }
      const response = await actions.runWorkshopOp(body)
      if (response && response.ok) {
        // 只有本页提交成功后才监听「完成 / 失败」，避免把历史任务当成这次的结果。
        opSubmittedRef.current = true
      }
      setStatus(response && response.ok
        ? t('studio.workshop.opQueued')
        : t('studio.workshop.opFailed'))
    } finally {
      setBusy('')
    }
  }

  /** 本地上传：导入作品库（走既有 /api/import），成功后进入侧栏并选中。 */
  async function handleFileChange(event) {
    const input = event && event.target ? event.target : null
    const file = input && input.files && input.files[0] ? input.files[0] : null
    if (!file) return
    setBusy('upload')
    try {
      const data = await fileToDataUrl(file)
      if (!data) throw new Error('read failed')
      const response = await importImageFile({ data, name: file.name })
      const entry = response && response.ok && response.data ? response.data.entry : null
      if (!entry || !entry.image) throw new Error('import failed')
      setUploadedWorks((previous) => [entry, ...previous])
      setSelected(entry)
      setResult(null)
      setChannel('source')
      setStatus('')
    } catch {
      setStatus(t('studio.workshop.uploadFailed'))
      if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.workshop.uploadFailed'))
    } finally {
      setBusy('')
      if (input) input.value = ''
    }
  }

  /**
   * 保存到作品库：主图 + 附属通道 + 版本树继承（base.path 指向当前源作品）。
   *
   * @returns {Promise<object|null>} 成功时返回新作品条目（供工作流接力切焦点），失败 null
   */
  async function performSave() {
    if (!savePayload) {
      setStatus(t('studio.workshop.saveNeedResult'))
      return null
    }
    if (busy) return null
    setBusy('save')
    try {
      const response = await saveWorkshopAsset(savePayload)
      if (ui && typeof ui.showToast === 'function') {
        ui.showToast(t(response.ok ? 'studio.workshop.saved' : 'studio.workshop.saveFailed'))
      }
      if (!response.ok) {
        setStatus(`${t('studio.workshop.saveFailed')}${response.message ? `：${response.message}` : ''}`)
        return null
      }
      setStatus(t('studio.workshop.saved'))
      setSavedResult(result)
      const entry = response.entry || null
      // 宿主侧收尾：新作品进历史 / 侧栏（导出 ZIP 直接可用）。
      if (actions && typeof actions.workshopSaved === 'function') actions.workshopSaved(entry)
      return entry
    } finally {
      setBusy('')
    }
  }

  async function handleSave() {
    await performSave()
  }

  /**
   * 工作流接力：切到下一步工具，并把**当前结果**作为下一步的输入。
   *
   * 有未保存的本机结果时先落盘再切焦点：直接以 result 作为下一步输入需要重新解码
   * dataURL，等于绕开作品库再存一份中间产物；先保存再接力既有版本树可追溯，也不会丢结果。
   */
  async function handleHandoff(targetTool) {
    if (!isWorkshopTool(targetTool) || targetTool === tool) return
    if (busy) return
    let entry = null
    if (handoffNeedsSave) {
      entry = await performSave()
      if (!entry) return
    }
    handoffToolRef.current = targetTool
    if (entry && entry.image) setSelected(entry)
    setResult(null)
    setSavedResult(null)
    setChannel('source')
    setPlaying(false)
    setTilePreview(false)
    setOpDone(false)
    setStatus('')
    setTool(targetTool)
  }

  /** 导出 ZIP：仅对作品库里的已保存作品可用（按当前选中作品的路径打包整个目录）。 */
  async function handleExport() {
    if (!sourcePath) {
      setStatus(t('studio.workshop.exportNeedSaved'))
      return
    }
    if (busy) return
    setBusy('export')
    try {
      const response = await downloadWorkZip(sourcePath)
      if (!response.ok) {
        setStatus(`${t('studio.workshop.exportFailed')}${response.message ? `：${response.message}` : ''}`)
        if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.workshop.exportFailed'))
        return
      }
      if (ui && typeof ui.showToast === 'function') ui.showToast(formatText(t('studio.workshop.exportedName'), { name: response.name || '' }))
    } finally {
      setBusy('')
    }
  }

  function handleOpenLatest() {
    const target = works.find((entry) => entry.item && Array.isArray(entry.item.channels) && entry.item.channels.length > 0)
      || works[0]
      || null
    if (!target) return
    setOpDone(false)
    setSelected(target)
    setResult(null)
    setChannel('source')
    setStatus('')
  }

  function handleToggleTilePreview() {
    if (!canTile) return
    setTilePreview((value) => !value)
  }

  function handleTogglePlay() {
    if (!canPlay) return
    setPlaying((value) => !value)
  }

  function handleCloseWorkshop() {
    if (actions && typeof actions.closeWorkshop === 'function') actions.closeWorkshop()
    else if (ui && typeof ui.setView === 'function') ui.setView('studio')
  }

  const canApply = Boolean(selected && selected.image)
  const canRunGpu = Boolean(selected && selected.image && sourcePath)
  // 画布顶边浮层：只在「完整画作 + 专业度低」且用户没关掉时出现。
  const showStudioHint = perception.showStudioReturnHint && !studioHintDismissed
  // 参数说明里的场景解读：分类器只在用户主动点 `?` 时才解释自己。
  const sceneSummary = formatText(t('studio.workshop.guide.scene'), {
    label: t(`studio.workshop.scene.label.${perception.scene}`),
    reason: formatText(t(perception.reasonKey), perception.reasonParams),
  })

  return (
    <section className="ofs-workshop" data-view-enter={props.viewEnter ? 'true' : undefined}>
      <header className="ofs-workshop-head">
        {/* 每个领域一枚独立胶囊：同领域工具聚在一起，跨领域之间有明确留白。 */}
        <div className="ofs-workshop-tools" role="toolbar" aria-label={t('studio.workshop.toolsLabel')}>
          {TOOL_CLUSTERS.map((cluster) => (
            <ToolCluster
              key={cluster.id}
              t={t}
              cluster={cluster}
              activeTool={tool}
              recommendedTools={recommendedTools}
              onSelect={switchTool}
            />
          ))}
        </div>
      </header>

      <div className="ofs-workshop-body">
        <aside className="ofs-workshop-side">
          <section className="ofs-workshop-works">
            <div className="ofs-workshop-section-head">
              <h3>{t('studio.workshop.sideTitle')}</h3>
              <div className="ofs-workshop-section-tools">
                <span className="ofs-workshop-count">{works.length}</span>
                {/* 上传收进标题行：整行虚线按钮会把参数卡一路往下挤。 */}
                <label className="ofs-workshop-upload" title={t('studio.workshop.uploadHint')}>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleFileChange}
                    disabled={busy !== ''}
                  />
                  <Icon name="plus" size={12} />
                  <span>{busy === 'upload' ? t('studio.workshop.uploading') : t('studio.workshop.upload')}</span>
                </label>
              </div>
            </div>
            <p className="ofs-workshop-hint">{t('studio.workshop.sideHint')}</p>
            {works.length === 0 ? (
              <p className="ofs-workshop-empty">{t('studio.workshop.sideEmpty')}</p>
            ) : (
              <div className="ofs-workshop-work-grid">
                {works.slice(0, 24).map((entry) => {
                  const entryPath = entry.image.path || entry.image.url || ''
                  const active = selected && selected.image && (selected.image.path || selected.image.url || '') === entryPath
                  return (
                    <button
                      key={entryPath}
                      type="button"
                      className={active ? 'ofs-workshop-work is-on' : 'ofs-workshop-work'}
                      title={workNameOf(entry.image)}
                      aria-pressed={active ? 'true' : 'false'}
                      onClick={() => selectWork(entry)}
                    >
                      <img src={entry.image.url} alt={workNameOf(entry.image)} draggable={false} />
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          <section className="ofs-workshop-params-wrap">
            <div className="ofs-workshop-section-head">
              <h3>{t('studio.workshop.params')}</h3>
              <div className="ofs-workshop-section-tools">
                <span className="ofs-workshop-tool-label">{t(`studio.workshop.tool.${tool}`)}</span>
                <button
                  type="button"
                  className={guideOpen ? 'ofs-workshop-guide-trigger is-on' : 'ofs-workshop-guide-trigger'}
                  aria-expanded={guideOpen ? 'true' : 'false'}
                  aria-controls="ofs-workshop-guide"
                  title={t(guideOpen ? 'studio.workshop.guide.collapse' : 'studio.workshop.guide.expand')}
                  onClick={toggleGuide}
                >
                  ?
                </button>
              </div>
            </div>
            {/* key 换成工具 = 重新挂载参数卡，让「切换工具」有轻量的切入过渡（减少动效时自动失效）。 */}
            <div className="ofs-workshop-params" key={tool}>
              <WorkshopParams
                t={t}
                tool={tool}
                guideOpen={guideOpen}
                sceneSummary={sceneSummary}
                pixel={params.pixel}
                setPixel={(patch) => patchParams('pixel', patch)}
                sprite={params.sprite}
                setSprite={(patch) => patchParams('sprite', patch)}
                tile={params.tile}
                setTile={(patch) => patchParams('tile', patch)}
                vector={params.vector}
                setVector={(patch) => patchParams('vector', patch)}
                cutoutModel={cutoutModel}
                setCutoutModel={setCutoutModel}
                pbrModel={pbrModel}
                setPbrModel={setPbrModel}
                pbrSteps={pbrSteps}
                setPbrSteps={setPbrSteps}
                detected={detected}
                seam={seam}
                spriteFrames={spriteFrames}
                busy={busy}
                canApply={canApply}
                canRunGpu={canRunGpu}
                modelReady
                onDetect={handleDetect}
                onApply={handleApply}
                onVectorize={handleVectorize}
                onRunGpu={handleRunGpu}
              />
            </div>
            {opDone ? (
              <button type="button" className="ofs-workshop-open-latest" onClick={handleOpenLatest}>
                <Icon name="images" size={14} />
                {t('studio.workshop.openLatest')}
              </button>
            ) : null}
          </section>
        </aside>

        <section className="ofs-workshop-canvas-wrap">
          <WorkshopStage
            t={t}
            tool={tool}
            preview={preview}
            repeat={repeat}
            playing={playing}
            canPlay={canPlay}
            onTogglePlay={handleTogglePlay}
            channelList={channelList}
            activeChannel={channel}
            onChannel={setChannel}
            tilePreview={tilePreview}
            canTile={canTile}
            onToggleTilePreview={handleToggleTilePreview}
            cell={params.pixel.cell}
            spriteFrames={spriteFrames}
            frameMs={params.sprite.frameMs}
            sourceUrl={sourceUrl}
            notice={showStudioHint ? (
              <div className="ofs-workshop-canvas-hint" role="note">
                <span className="ofs-workshop-canvas-hint-text">{t('studio.workshop.canvasHint.text')}</span>
                <button
                  type="button"
                  className="ofs-workshop-canvas-hint-link"
                  onClick={handleCloseWorkshop}
                >
                  {t('studio.workshop.canvasHint.action')}
                  <Icon name="chevronRight" size={11} />
                </button>
                <button
                  type="button"
                  className="ofs-workshop-canvas-hint-close"
                  aria-label={t('studio.workshop.canvasHint.dismiss')}
                  onClick={() => setStudioHintDismissed(true)}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ) : null}
          />
          {!canUseCanvas() ? (
            <p className="ofs-workshop-capability">{t('studio.workshop.capabilityMissing')}</p>
          ) : null}
          {!sourcePixels && sourceUrl && canUseCanvas() ? (
            <p className="ofs-workshop-capability">{t('studio.workshop.capabilityMissing')}</p>
          ) : null}
        </section>
      </div>

      <footer className="ofs-workshop-foot">
        <button
          type="button"
          className="ofs-workshop-save"
          disabled={busy !== ''}
          onClick={handleSave}
        >
          <Icon name="check" size={14} />
          {busy === 'save' ? t('studio.workshop.saving') : t('studio.workshop.save')}
        </button>
        <button
          type="button"
          className="ofs-workshop-export"
          disabled={busy !== ''}
          onClick={handleExport}
        >
          <Icon name="download" size={14} />
          {busy === 'export' ? t('studio.workshop.exporting') : t('studio.workshop.export')}
        </button>
        <span className="ofs-workshop-status" role="status" aria-live="polite">{statusText}</span>
        {/* 接力只有一个最匹配的下一步，原位嵌在状态行右侧；悬停标题说明「为什么」。
            当前结果未落盘时点击会先保存（按钮文案不变，避免多一行提示占位）。 */}
        {primaryHandoff ? (
          <button
            type="button"
            className="ofs-workshop-continue"
            data-tool={primaryHandoff.tool}
            data-needs-save={handoffNeedsSave ? 'true' : 'false'}
            title={handoffNeedsSave
              ? `${t(primaryHandoff.reasonKey)} · ${t('studio.workshop.handoff.saveFirst')}`
              : t(primaryHandoff.reasonKey)}
            disabled={busy !== ''}
            onClick={() => { void handleHandoff(primaryHandoff.tool) }}
          >
            <Icon name={TOOL_ICONS[primaryHandoff.tool] || 'image'} size={12} />
            {formatText(t('studio.workshop.handoff.action'), {
              label: t(`studio.workshop.handoff.to.${primaryHandoff.tool}`),
            })}
            <Icon name="chevronRight" size={11} />
          </button>
        ) : null}
      </footer>
    </section>
  )
}

/** 工坊页的图片工具能力判定（供测试与外部入口复用）。 */
export function workshopToolKind(tool) {
  if (LOCAL_TOOLS.has(tool)) return 'local'
  if (GPU_TOOLS.has(tool)) return 'gpu'
  return 'unknown'
}
