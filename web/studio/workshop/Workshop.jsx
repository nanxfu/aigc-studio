/**
 * 资产工坊（M4.2a / M4.2b / M4.2c）：独立整页视图。
 *
 * 页面分两段（M4.2c Phase 1c 起没有底栏）：
 *   .ofs-workshop-head   单行工具顶栏：按领域分栏全部平铺（平面与提取 / 游戏与 3D / 光影与空间）+ 推荐点
 *   .ofs-workshop-body   左侧最近作品 + 版本切换 + 参数卡；右侧预览画布 + 通道条
 *
 * 状态管理约定：
 *  - 主状态（selected / tool / channel / tilePreview / result / savedResult / busy 等）由
 *    `workshopState.js` 的 `workshopReducer` 原子迁移，避免多个 `useEffect` 与 `ref` 相互覆盖；
 *  - `useEffect` 只保留纯异步 I/O 与算子实时计算（像素解码、L2 视觉感知、网格探测、实时混边/像素预览）。
 */

import React from 'react'

import { WORKSHOP } from '../../../shared/contract.js'
import { evaluateLocalPbr } from '../../../shared/workshop-compute.js'
import { normalizeWorkshopPerceptionTag } from '../../../shared/workshop-scenes.js'
import { importImageFile } from '../../api/resources.js'
import {
  perceiveWorkshopVision,
  saveWorkshopPerceptionTag,
  saveWorkshopAsset,
  vectorizeWorkshopImage,
} from '../../api/workshop.js'
import { formatText } from '../../logic/format.js'
import {
  applyDepthFx,
  depthMapFromPixels,
  fogSettingsFromPreset,
  normalPixelsFromDepth,
  pixelsFromDepth,
  resizeDepth,
  resizePixels,
} from '../../logic/depthFx.js'
import { rootOfItem } from '../../logic/lineage.js'
import { runLocalCutout } from '../../logic/localCutout.js'
import { runLocalDepth } from '../../logic/localDepth.js'
import { runLocalVisionPerception } from '../../logic/localVision.js'
import { applyPhysicalRelight } from '../../logic/relight.js'
import { renderPhysicalRelightWebGL } from '../../logic/relightWebGL.js'
import { jobCountText, jobStatusText } from '../../logic/status.js'
import {
  applyWorkshopPerceptionTag,
  isWorkshopTool,
  mergeWorkshopPerception,
  nextToolSuggestions,
  perceiveWorkshopWork,
  resolveWorkshopRootContext,
  workshopPerceptionTagFromResult,
  workshopToolGroups,
} from '../../logic/workshopPerception.js'
import { Icon } from '../icons.jsx'
import { useSlidingThumb } from '../hooks/useSlidingThumb.js'
import { WorkshopParams, readGuideOpen, writeGuideOpen } from './WorkshopParams.jsx'
import { WorkshopStage } from './WorkshopStage.jsx'
import { WorkshopWorksCard } from './WorkshopWorksCard.jsx'
import {
  buildChannelList,
  buildRecentWorkGroups,
  channelLabelOf,
  createInitialWorkshopState,
  primaryChannelOfEntry,
  selectionKeyOf,
  workKeyOf,
  workNameOf,
  workshopReducer,
} from './workshopState.js'
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
  pixelsToDataUrl,
  seamMaeSafe,
  sliceSpriteFramesSafe,
  snapPixelArtSafe,
  svgToDataUrl,
  workshopVisionPixels,
} from './pixels.js'

/** 工具条图标：与工具语义一一对应，缺省用 image。 */
const TOOL_ICONS = {
  'pixel-snap': 'frame',
  'sprite-slice': 'film',
  tile: 'images',
  vectorize: 'sparkles',
  cutout: 'focus',
  pbr: 'cube',
  'depth-fx': 'mountains',
  relight: 'sun',
}

/** 工具领域分栏（不改变 `WORKSHOP.tools` 契约与保存链路，只决定顶栏里的分组）。 */
const TOOL_GROUPS = workshopToolGroups()

/** 顶栏的两个工具胶囊：领域 id 与组名的对应关系。 */
const TOOL_CLUSTERS = [
  { id: 'plane', labelKey: 'studio.workshop.group.plane', tools: TOOL_GROUPS.plane },
  { id: 'game3d', labelKey: 'studio.workshop.group.game3d', tools: TOOL_GROUPS.game3d },
  { id: 'atmosphere', labelKey: 'studio.workshop.group.atmosphere', tools: TOOL_GROUPS.atmosphere },
]

/**
 * 冷启动等待 L2 的上限：首次模型下载 / 慢 Worker 不能把工具落焦无限期挂在安全态。
 * 超时即 abort 并回退 L1；下次进入作品时标签仍是 `l1-heuristic`，会再补跑一次。
 */
const L2_SETTLE_TIMEOUT_MS = 2500

/** 前端感知标签缓存（Phase 2.5）：让「切走再切回」立刻命中，避免重复 L2。 */
const PERCEPTION_CACHE_MAX_ENTRIES = 32
const perceptionCache = new Map()

function readPerceptionCache(key) {
  if (!key) return null
  const tag = perceptionCache.get(key)
  if (!tag) return null
  perceptionCache.delete(key)
  perceptionCache.set(key, tag)
  return tag
}

function writePerceptionCache(key, tag) {
  if (!key || !tag) return
  perceptionCache.delete(key)
  perceptionCache.set(key, tag)
  while (perceptionCache.size > PERCEPTION_CACHE_MAX_ENTRIES) {
    const oldest = perceptionCache.keys().next().value
    if (!oldest) break
    perceptionCache.delete(oldest)
  }
}

/** 测试隔离 / 工作区切换用：清空当前会话的感知标签缓存。 */
export function clearWorkshopPerceptionCache() {
  perceptionCache.clear()
}

/** 从作品条目取有效持久化标签（优先图级，再回落条目级）；版本过旧 / 脏数据由共享归一器返回 null。 */
function perceptionTagOfEntry(entry) {
  return normalizeWorkshopPerceptionTag(entry && entry.image ? entry.image.workshopPerception : null)
    || normalizeWorkshopPerceptionTag(entry && entry.item ? entry.item.workshopPerception : null)
}

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

/** 本地工具：渲染进程直接出结果；GPU 工具走任务队列。 */
const LOCAL_TOOLS = new Set(['pixel-snap', 'sprite-slice', 'tile', 'depth-fx', 'relight'])
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
      blend: true,
      blendRatio: WORKSHOP.tile.blendRatio.default,
    },
    vector: {
      colorPrecision: WORKSHOP.vector.colorPrecision.default,
      filterSpeckle: WORKSHOP.vector.filterSpeckle.default,
      colormode: 'color',
      hierarchy: 'stacked',
      mode: 'spline',
    },
    depthFx: {
      mode: 'fog',
      preset: WORKSHOP.depthFx.fogPresets[0].id,
      ...WORKSHOP.depthFx.fogPresets[0],
      anchors: [],
      strokes: [],
      anchorMode: 'add',
      anchorRadius: WORKSHOP.depthFx.fog.anchorRadius.default,
      anchorStrength: WORKSHOP.depthFx.fog.anchorStrength.default,
      brushMode: false,
      brushRadius: WORKSHOP.depthFx.fog.brush.radius.default,
      brushFeather: WORKSHOP.depthFx.fog.brush.feather.default,
      focusX: 0.5,
      focusY: 0.5,
      aperture: WORKSHOP.depthFx.dof.aperture.default,
      blur: WORKSHOP.depthFx.dof.blur.default,
      tiltShift: false,
      amplitude: WORKSHOP.depthFx.parallax.amplitude.default,
      shiftX: 0,
      shiftY: 0,
    },
    relight: {
      tab: 'physical',
      preset: 'studio',
      lightX: 0.42,
      lightY: 0.3,
      lightZ: 0.72,
      intensity: 1.2,
      color: '#FFF4E0',
      rim: 0.7,
      ambient: 0.28,
      prompt: WORKSHOP.relight.presets.find((item) => item.id === 'studio').prompt,
      steps: WORKSHOP.relight.steps.default,
      cfg: WORKSHOP.relight.cfg.default,
      seed: null,
      model: WORKSHOP.relight.defaultModel,
    },
  }
}

/** 统计 SVG 的路径元素数量与体积（KB），用于矢量面板与画布诊断。 */
function svgStatsOf(svg) {
  if (typeof svg !== 'string' || !svg.trim()) return null
  const matches = svg.match(/<(?:path|circle|rect|polygon|polyline|line|ellipse)\b/gi)
  const paths = matches ? matches.length : 0
  const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(svg).length : svg.length
  const kb = Math.max(0.1, Math.round((bytes / 1024) * 10) / 10)
  return { paths, kb }
}

/** 计算首屏落焦工具：仅采信持久化/缓存感知标签与确定性硬先验。 */
function resolveInitialTool({ pinnedInitialTool, entry, works, workspaceKey, compute }) {
  if (pinnedInitialTool) return pinnedInitialTool
  const persistedTag = perceptionTagOfEntry(entry) || readPerceptionCache(selectionKeyOf(entry, workspaceKey))
  if (persistedTag && isWorkshopTool(persistedTag.recommendedTools[0])) {
    return persistedTag.recommendedTools[0]
  }
  const item = entry && entry.item
    ? { ...entry.item, ...resolveWorkshopRootContext(entry.item, works) }
    : null
  if (item) {
    const id = item.rootPresetId || item.presetId || ''
    const list = compute && Array.isArray(compute.presets) ? compute.presets : []
    const initialPreset = id ? list.find((candidate) => candidate && candidate.id === id) || null : null
    const initial = perceiveWorkshopWork({ pixels: null, item, preset: initialPreset })
    if (initial.derived.hardPrior && isWorkshopTool(initial.recommendedTools[0])) {
      return initial.recommendedTools[0]
    }
  }
  return TOOL_GROUPS.plane[0]
}

export function Workshop(props) {
  const { t, ui, compute, library, actions } = props
  const initialEntry = props.initialEntry && props.initialEntry.image ? props.initialEntry : null
  const initialPath = initialEntry && initialEntry.image
    ? (initialEntry.image.path || initialEntry.image.url || '')
    : ''
  const workspaceKey = compute && compute.workspace && typeof compute.workspace.current === 'string'
    ? compute.workspace.current
    : ''

  // 最近作品：作品库里的图片作品（视频不进工坊）优先，本地上传/新保存追加在最前。
  const galleryWorks = React.useMemo(() => {
    const gallery = Array.isArray(library && library.gallery) ? library.gallery : []
    return gallery.filter((entry) => entry && entry.image && entry.image.mediaType !== 'video')
  }, [library && library.gallery])
  const [uploadedWorks, setUploadedWorks] = React.useState([])
  const [savedWorks, setSavedWorks] = React.useState([])
  const works = React.useMemo(() => {
    const seen = new Set()
    const list = []
    for (const entry of [...uploadedWorks, ...savedWorks, ...galleryWorks]) {
      const key = entry && entry.image ? (entry.image.path || entry.image.url || '') : ''
      if (!key || seen.has(key)) continue
      seen.add(key)
      list.push(entry)
    }
    return list
  }, [uploadedWorks, savedWorks, galleryWorks])

  const lineageByPath = library && library.lineage && library.lineage.byPath && typeof library.lineage.byPath === 'object'
    ? library.lineage.byPath
    : null
  const lineageRoots = library && library.lineage && Array.isArray(library.lineage.roots)
    ? library.lineage.roots
    : null
  const worksItemMap = React.useMemo(() => {
    const map = new Map()
    for (const entry of works) {
      const key = workKeyOf(entry)
      if (key && entry.item && !map.has(key)) map.set(key, entry.item)
    }
    return map
  }, [works])

  const rootKeyOf = React.useCallback((entry) => {
    const key = workKeyOf(entry)
    if (!key) return ''
    const node = lineageByPath && lineageByPath[key]
    if (node && typeof node.rootPath === 'string' && node.rootPath) return node.rootPath
    if (entry && entry.item) {
      const resolved = rootOfItem(entry.item, worksItemMap)
      if (resolved) {
        const rootNode = lineageByPath && lineageByPath[resolved]
        return (rootNode && typeof rootNode.rootPath === 'string' && rootNode.rootPath) ? rootNode.rootPath : resolved
      }
    }
    return key
  }, [lineageByPath, worksItemMap])

  const recentWorks = React.useMemo(
    () => buildRecentWorkGroups(works, rootKeyOf, lineageRoots),
    [works, rootKeyOf, lineageRoots],
  )

  const pinnedInitialTool = isWorkshopTool(props.initialTool) ? props.initialTool : ''
  const [state, dispatch] = React.useReducer(
    workshopReducer,
    null,
    () => {
      const firstSelected = initialEntry || galleryWorks[0] || null
      const initialTool = resolveInitialTool({
        pinnedInitialTool,
        entry: firstSelected,
        works,
        workspaceKey,
        compute,
      })
      return createInitialWorkshopState({
        selected: firstSelected,
        tool: initialTool,
        initialChannel: props.initialChannel,
        initialTilePreview: props.initialTilePreview,
        initialCompareSvg: props.initialCompareSvg,
        initialResult: props.initialResult || props.testResult || null,
        pinnedInitialTool,
      })
    },
  )

  const {
    selected,
    tool,
    channel,
    tilePreview,
    playing,
    compareSvg,
    studioHintDismissed,
    result,
    savedResult,
    opDone,
    busy,
    status,
    pinnedTool,
  } = state

  // 作品库异步加载完成后自动选中首图。
  React.useEffect(() => {
    if (selected && selected.image) return
    if (works.length > 0) dispatch({ type: 'HYDRATE_FIRST_WORK', entry: works[0] })
  }, [selected, works])

  const [params, setParams] = React.useState(() => {
    const base = defaultParams()
    const init = props.initialParams && typeof props.initialParams === 'object' ? props.initialParams : null
    if (!init) return base
    return {
      pixel: { ...base.pixel, ...(init.pixel || {}) },
      sprite: { ...base.sprite, ...(init.sprite || {}) },
      tile: { ...base.tile, ...(init.tile || {}) },
      vector: { ...base.vector, ...(init.vector || {}) },
      depthFx: { ...base.depthFx, ...(init.depthFx || {}) },
      relight: { ...base.relight, ...(init.relight || {}) },
    }
  })

  const [detected, setDetected] = React.useState(null)
  const [loadedPixels, setLoadedPixels] = React.useState(null)
  const [pixelLoadFailed, setPixelLoadFailed] = React.useState(false)
  const [vision, setVision] = React.useState(null)
  const [visionStatus, setVisionStatus] = React.useState('idle')
  const [upgradedTag, setUpgradedTag] = React.useState(null)
  const [spriteFrames, setSpriteFrames] = React.useState(null)
  const [seam, setSeam] = React.useState(null)
  const [livePixelPreview, setLivePixelPreview] = React.useState('')
  const [liveTilePreview, setLiveTilePreview] = React.useState('')
  const [liveTileSeam, setLiveTileSeam] = React.useState(null)
  const [fetchedSvg, setFetchedSvg] = React.useState('')
  const [depthState, setDepthState] = React.useState({
    key: '',
    loading: false,
    depth: null,
    normal: null,
    source: '',
    modelId: '',
    elapsedMs: 0,
    error: '',
  })
  const [materialState, setMaterialState] = React.useState({
    key: '',
    albedo: null,
    normal: null,
    roughness: null,
    metallic: null,
  })
  const [spatialLivePreview, setSpatialLivePreview] = React.useState('')
  const [spatialBypass, setSpatialBypass] = React.useState(false)
  const [compareSpatial, setCompareSpatial] = React.useState(false)
  const [depthBusy, setDepthBusy] = React.useState('')
  const [depthJobId, setDepthJobId] = React.useState('')
  const [parallaxPhase, setParallaxPhase] = React.useState(0)
  const [depthCloudModel, setDepthCloudModel] = React.useState(WORKSHOP.depth.defaultCloudModel)
  const depthAbortRef = React.useRef(null)
  const depthCanceledRef = React.useRef(false)

  const [pbrPreference, setPbrPreference] = React.useState(() => {
    try {
      const value = props.initialPbrExecution || (typeof window !== 'undefined' ? window.localStorage?.getItem('aigc-studio.workshop.pbr.execution') : '')
      return ['local', 'cloud'].includes(value) ? value : ''
    } catch { return '' }
  })
  const [pbrModel, setPbrModel] = React.useState(WORKSHOP.pbr.defaultModel)
  const [pbrSteps, setPbrSteps] = React.useState(WORKSHOP.pbr.steps.default)
  const pbrCapability = evaluateLocalPbr(compute?.hardware, { model: pbrModel })
  const pbrExecution = pbrCapability.available ? (pbrPreference || 'local') : 'cloud'
  function setPbrExecution(value) {
    if (value === 'local' && !pbrCapability.available) return
    setPbrPreference(value)
    try { if (typeof window !== 'undefined') window.localStorage?.setItem('aigc-studio.workshop.pbr.execution', value) } catch {}
  }

  const [guideOpen, setGuideOpen] = React.useState(readGuideOpen)

  const selectedRootKey = rootKeyOf(selected)
  const activeGroup = React.useMemo(
    () => recentWorks.find((group) => selectedRootKey && group.rootKey === selectedRootKey) || null,
    [recentWorks, selectedRootKey],
  )
  const channelList = React.useMemo(
    () => buildChannelList(selected, works, t, activeGroup ? activeGroup.entries : null),
    [selected, works, t, activeGroup],
  )
  const activeChannelItem = React.useMemo(
    () => channelList.find((item) => item.role === channel) || null,
    [channelList, channel],
  )
  const activeWork = (activeChannelItem && activeChannelItem.workEntry) || selected

  const selectedUrl = selected && selected.image ? (selected.image.url || '') : ''
  const sourceUrl = activeWork && activeWork.image ? (activeWork.image.url || '') : ''
  const sourcePath = activeWork && activeWork.image ? (activeWork.image.path || '') : ''
  const selectedKey = selectionKeyOf(activeWork, workspaceKey)
  const persistedPerceptionTag = React.useMemo(() => perceptionTagOfEntry(activeWork), [activeWork])
  const cachedPerceptionTag = React.useMemo(() => readPerceptionCache(selectedKey), [selectedKey])
  const effectiveTag = upgradedTag && upgradedTag.key === selectedKey
    ? upgradedTag.tag
    : (persistedPerceptionTag || cachedPerceptionTag)

  const lastInitialPathRef = React.useRef(initialPath)
  const selfSavedPathRef = React.useRef('')
  const pixelCellPinnedRef = React.useRef(false)
  const tagWriteKeysRef = React.useRef(new Set())
  const pinnedToolRef = React.useRef(pinnedTool)
  pinnedToolRef.current = pinnedTool

  const testPixels = props.testSourcePixels || null
  const sourcePixels = loadedPixels
    && loadedPixels.key === selectedKey
    && loadedPixels.url === sourceUrl
    && loadedPixels.testPixels === testPixels
    ? loadedPixels.pixels
    : null

  /** 外部（动作坞「进工坊」/ 再次进入）带着新作品进来：同步焦点（忽略自己刚刚保存回写的路径）。 */
  React.useEffect(() => {
    if (!initialPath || lastInitialPathRef.current === initialPath) return
    lastInitialPathRef.current = initialPath
    if (selfSavedPathRef.current && selfSavedPathRef.current === initialPath) {
      selfSavedPathRef.current = ''
      return
    }
    if (initialEntry) {
      pixelCellPinnedRef.current = false
      dispatch({ type: 'SYNC_INITIAL_ENTRY', entry: initialEntry, pinnedInitialTool })
    }
  }, [initialPath, initialEntry, pinnedInitialTool])

  /** 纯异步像素解码：不修改任何 UI 开关状态，只负责把源图解码成 RGBA 供算子使用。 */
  React.useEffect(() => {
    setSpriteFrames(null)
    setSeam(null)
    setDetected(null)
    setLivePixelPreview('')
    setLiveTilePreview('')
    setLiveTileSeam(null)
    setFetchedSvg('')
    if (testPixels) {
      setPixelLoadFailed(false)
      setLoadedPixels({ key: selectedKey, url: sourceUrl, testPixels, pixels: testPixels })
      return undefined
    }
    if (!sourceUrl) {
      setPixelLoadFailed(false)
      setLoadedPixels(null)
      return undefined
    }
    setPixelLoadFailed(false)
    setLoadedPixels(null)
    let alive = true
    pixelsOfUrl(sourceUrl, { namespace: workspaceKey }).then((pixels) => {
      if (!alive) return
      if (!pixels) {
        setPixelLoadFailed(true)
        return
      }
      setLoadedPixels({ key: selectedKey, url: sourceUrl, testPixels: null, pixels })
    }, () => {
      if (alive) setPixelLoadFailed(true)
    })
    return () => {
      alive = false
    }
  }, [sourceUrl, selectedKey, testPixels, workspaceKey])

  /** 像素对齐的实时预览（180ms 防抖）。 */
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

  /** 像素工具：自动探测格距（只在高置信度且用户未手改格距时采用）。 */
  React.useEffect(() => {
    if (!sourcePixels || tool !== 'pixel-snap') return
    const grid = detectPixelGridSafe(sourcePixels, { alphaCut: params.pixel.alphaThreshold })
    setDetected(grid)
    if (grid && grid.cell > 1 && grid.confidence >= 0.55 && !pixelCellPinnedRef.current) {
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

  /** 平铺工具：开启「边缘混边」后实时防抖预览混边结果与新接缝误差。 */
  React.useEffect(() => {
    if (tool !== 'tile' || !params.tile.blend || !sourcePixels || !canUseCanvas()) {
      setLiveTilePreview('')
      setLiveTileSeam(null)
      return undefined
    }
    let alive = true
    const timer = setTimeout(() => {
      if (!alive) return
      const processed = blendSeamEdgesSafe(sourcePixels, { borderRatio: params.tile.blendRatio })
      if (!processed) return
      const nextSeam = seamMaeSafe(processed)
      const canvas = createCanvas(processed.width, processed.height)
      if (!canvas || !drawPixels(canvas, { width: processed.width, height: processed.height, data: processed.data })) return
      const url = canvasDataUrl(canvas)
      if (alive) {
        if (url) setLiveTilePreview(url)
        if (nextSeam) setLiveTileSeam(nextSeam)
      }
    }, 120)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [tool, sourcePixels, params.tile.blend, params.tile.blendRatio])

  /** 序列帧工具：按行列切帧。 */
  React.useEffect(() => {
    if (!sourcePixels || tool !== 'sprite-slice') return
    setSpriteFrames(sliceSpriteFramesSafe(sourcePixels, {
      rows: params.sprite.rows,
      cols: params.sprite.cols,
      trimAlpha: params.sprite.trimAlpha,
    }))
  }, [sourcePixels, tool, params.sprite.rows, params.sprite.cols, params.sprite.trimAlpha])

  // ── 深度 / PBR 通道读取（M4.2e）────────────────────────────────
  const depthChannel = React.useMemo(
    () => channelList.find((item) => item.role === 'depth' && item.url) || null,
    [channelList],
  )
  const normalChannel = React.useMemo(
    () => channelList.find((item) => item.role === 'normal' && item.url) || null,
    [channelList],
  )
  const localDepthKey = selectedKey ? `local:${selectedKey}:${sourceUrl}` : ''

  React.useEffect(() => {
    if (!['depth-fx', 'relight'].includes(tool)) return undefined
    if (depthState.depth && depthState.key === localDepthKey) return undefined
    if (depthChannel?.url && depthState.depth && depthState.key === `${selectedKey}:${depthChannel.url}`) {
      return undefined
    }
    if (!depthChannel?.url) {
      setDepthState((previous) => (
        previous.key === `${selectedKey}:none`
          ? previous
          : { key: `${selectedKey}:none`, loading: false, depth: null, normal: null, source: '', modelId: '', elapsedMs: 0, error: '' }
      ))
      return undefined
    }
    let alive = true
    setDepthState((previous) => ({ ...previous, key: `${selectedKey}:loading`, loading: true, error: '' }))
    Promise.all([
      pixelsOfUrl(depthChannel.url, { namespace: workspaceKey }),
      normalChannel?.url ? pixelsOfUrl(normalChannel.url, { namespace: workspaceKey }) : Promise.resolve(null),
    ]).then(([depthPixels, normalPixels]) => {
      if (!alive) return
      const depth = depthPixels ? depthMapFromPixels(depthPixels) : null
      if (!depth) {
        setDepthState({
          key: `${selectedKey}:error`,
          loading: false,
          depth: null,
          normal: null,
          source: '',
          modelId: '',
          elapsedMs: 0,
          error: '无法读取 depth 通道',
        })
        return
      }
      setDepthState({
        key: `${selectedKey}:${depthChannel.url}`,
        loading: false,
        depth,
        normal: normalPixels || null,
        source: 'channel',
        modelId: 'channel',
        elapsedMs: 0,
        error: '',
      })
    }, () => {
      if (alive) {
        setDepthState({
          key: `${selectedKey}:error`,
          loading: false,
          depth: null,
          normal: null,
          source: '',
          modelId: '',
          elapsedMs: 0,
          error: '无法读取 depth 通道',
        })
      }
    })
    return () => {
      alive = false
    }
  }, [tool, selectedKey, sourceUrl, workspaceKey, depthChannel?.url, normalChannel?.url, localDepthKey, depthState.depth, depthState.key])

  React.useEffect(() => {
    if (tool !== 'relight') return undefined
    const channels = Array.isArray(channelList) ? channelList : []
    const find = (role) => channels.find((item) => item.role === role && item.url)?.url || ''
    const urls = {
      albedo: find('albedo'),
      normal: find('normal'),
      roughness: find('roughness'),
      metallic: find('metallic'),
    }
    if (!urls.albedo) {
      setMaterialState({
        key: `${selectedKey}:none`,
        albedo: null,
        normal: null,
        roughness: null,
        metallic: null,
      })
      return undefined
    }
    let alive = true
    Promise.all(
      Object.entries(urls).map(([role, url]) => (
        url ? pixelsOfUrl(url, { namespace: workspaceKey }).then((pixels) => [role, pixels]) : Promise.resolve([role, null])
      )),
    ).then((entries) => {
      if (!alive) return
      const next = { key: `${selectedKey}:${urls.albedo}`, albedo: null, normal: null, roughness: null, metallic: null }
      for (const [role, pixels] of entries) next[role] = pixels || null
      setMaterialState(next)
    }, () => {
      if (alive) {
        setMaterialState({
          key: `${selectedKey}:error`,
          albedo: null,
          normal: null,
          roughness: null,
          metallic: null,
        })
      }
    })
    return () => {
      alive = false
    }
  }, [tool, selectedKey, workspaceKey, channelList])

  /** 云端 depth 任务完成后，从新作品目录的 channels 读取深度与法线。 */
  React.useEffect(() => {
    const jobId = depthJobId
    if (!jobId) return
    const jobContext = depthJobContextRef.current?.jobId === jobId
      ? depthJobContextRef.current
      : null
    const entry = galleryWorks.find((item) => item && item.item && item.item.jobId === jobId)
    if (!entry) return
    setDepthJobId('')
    depthJobContextRef.current = null
    const channels = Array.isArray(entry.item?.channels) ? entry.item.channels : []
    const depthUrl = channels.find((item) => item.role === 'depth' && item.url)?.url || ''
    const normalUrl = channels.find((item) => item.role === 'normal' && item.url)?.url || ''
    if (!depthUrl) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.depth.failed') })
      setDepthBusy('')
      return
    }
    setDepthBusy('loading')
    Promise.all([
      pixelsOfUrl(depthUrl, { namespace: workspaceKey }),
      normalUrl ? pixelsOfUrl(normalUrl, { namespace: workspaceKey }) : Promise.resolve(null),
    ]).then(([depthPixels, normalPixels]) => {
      const depth = depthPixels ? depthMapFromPixels(depthPixels) : null
      if (!depth) throw new Error('depth channel unreadable')
      setDepthState({
        key: jobContext?.key || localDepthKey || `${selectedKey}:cloud`,
        loading: false,
        depth,
        normal: normalPixels || null,
        source: 'cloud',
        modelId: entry.item?.presetId || depthCloudModel,
        elapsedMs: 0,
        error: '',
      })
      setDepthBusy('')
      dispatch({ type: 'SET_OP_DONE', opDone: true })
      if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.workshop.depth.done'))
    }).catch(() => {
      setDepthBusy('')
      setDepthState({
        key: `${selectedKey}:error`,
        loading: false,
        depth: null,
        normal: null,
        source: '',
        modelId: '',
        elapsedMs: 0,
        error: 'depth channel unreadable',
      })
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.depth.failed') })
    })
  }, [galleryWorks, selectedKey, workspaceKey, localDepthKey, depthCloudModel, t, ui, depthJobId])

  const isSpatialPreviewActive = Boolean(
    !spatialBypass
    && !compareSpatial
    && (tool === 'depth-fx' || (tool === 'relight' && params.relight.tab === 'physical'))
    && ['source', 'depthfx', 'relit'].includes(channel),
  )

  React.useEffect(() => {
    if (!isSpatialPreviewActive || tool !== 'depth-fx' || params.depthFx.mode !== 'parallax') {
      setParallaxPhase(0)
      return undefined
    }
    let frame = 0
    let last = 0
    const tick = (time) => {
      if (!last || time - last >= WORKSHOP.depthFx.parallax.frameMs) {
        last = time
        setParallaxPhase((previous) => (previous + 0.08) % (Math.PI * 2))
      }
      frame = requestAnimationFrame(tick)
    }
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick)
    return () => {
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [isSpatialPreviewActive, tool, params.depthFx.mode])

  // 预缩放预览图与几何通道只随源图/深度/模式变化，避免 2.5D 视差每帧重复缩图与算梯度。
  const spatialPreviewInputs = React.useMemo(() => {
    if (!isSpatialPreviewActive || !sourcePixels || !depthState.depth || !canUseCanvas()) return null
    const previewEdge = tool === 'depth-fx' && params.depthFx.mode === 'dof'
      ? Math.min(320, WORKSHOP.depthFx.previewMaxEdge)
      : tool === 'relight'
        ? Math.max(WORKSHOP.depthFx.previewMaxEdge, 640)
        : WORKSHOP.depthFx.previewMaxEdge
    const previewPixels = resizePixels(sourcePixels, previewEdge)
    if (!previewPixels) return null
    const depth = resizeDepth(depthState.depth, previewPixels.width, previewPixels.height)
    if (!depth) return null
    let normalPixels = null
    const normalSource = tool === 'relight' && materialState.normal
      ? materialState.normal
      : depthState.normal
    if (normalSource) normalPixels = resizePixels(normalSource, Math.max(previewPixels.width, previewPixels.height))
    if (!normalPixels) normalPixels = normalPixelsFromDepth(depth)
    if (tool === 'depth-fx') {
      return { previewPixels, depth, normalPixels }
    }
    return {
      previewPixels,
      depth,
      normalPixels,
      albedo: materialState.albedo
        ? resizePixels(materialState.albedo, Math.max(previewPixels.width, previewPixels.height))
        : previewPixels,
      roughness: materialState.roughness
        ? resizePixels(materialState.roughness, Math.max(previewPixels.width, previewPixels.height))
        : null,
      metallic: materialState.metallic
        ? resizePixels(materialState.metallic, Math.max(previewPixels.width, previewPixels.height))
        : null,
    }
  }, [isSpatialPreviewActive, sourcePixels, depthState, materialState, tool, params.depthFx.mode])

  React.useEffect(() => {
    if (!spatialPreviewInputs) {
      setSpatialLivePreview('')
      return undefined
    }
    let alive = true
    const timer = setTimeout(() => {
      if (!alive) return
      const { previewPixels, depth, normalPixels } = spatialPreviewInputs
      let rendered = null
      if (tool === 'depth-fx') {
        const settings = params.depthFx
        const common = {
          mode: settings.mode,
          color: settings.color,
          density: settings.density,
          startDepth: settings.startDepth,
          falloff: settings.falloff,
          groundBias: settings.groundBias,
          horizon: settings.horizon,
          blend: settings.blend,
          anchors: settings.anchors,
          strokes: settings.strokes,
          normal: normalPixels,
          desaturate: settings.desaturate,
          haze: settings.haze,
          contrast: settings.contrast,
          focusX: settings.focusX,
          focusY: settings.focusY,
          aperture: settings.aperture,
          blur: settings.blur,
          tiltShift: settings.tiltShift,
          amplitude: settings.amplitude,
          shiftX: settings.shiftX + (settings.mode === 'parallax' ? Math.sin(parallaxPhase) * 0.22 : 0),
          shiftY: settings.shiftY + (settings.mode === 'parallax' ? Math.cos(parallaxPhase) * 0.12 : 0),
        }
        rendered = applyDepthFx(previewPixels, depth, common)
      } else {
        const relightOptions = {
          albedo: spatialPreviewInputs.albedo,
          normal: normalPixels,
          roughness: spatialPreviewInputs.roughness,
          metallic: spatialPreviewInputs.metallic,
          lightX: params.relight.lightX,
          lightY: params.relight.lightY,
          lightZ: params.relight.lightZ,
          intensity: params.relight.intensity,
          color: params.relight.color,
          rim: params.relight.rim,
          ambient: params.relight.ambient,
        }
        const webglCanvas = renderPhysicalRelightWebGL(previewPixels, depth, relightOptions)
        if (webglCanvas) {
          let url = ''
          try {
            url = webglCanvas.toDataURL('image/png')
          } catch {}
          if (url) {
            if (alive) setSpatialLivePreview(url)
            return
          }
        }
        rendered = applyPhysicalRelight(previewPixels, depth, relightOptions)
      }
      const url = rendered ? pixelsToDataUrl(rendered) : ''
      if (alive) setSpatialLivePreview(url)
    }, 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [spatialPreviewInputs, tool, params, parallaxPhase])

  // ── 场景感知（L1 + L2）────────────────────────────────────────
  const perceptionItem = React.useMemo(() => {
    const item = selected && selected.item ? selected.item : null
    return item ? { ...item, ...resolveWorkshopRootContext(item, works) } : null
  }, [selected, works])

  const preset = React.useMemo(() => {
    const id = perceptionItem ? (perceptionItem.rootPresetId || perceptionItem.presetId || '') : ''
    if (!id) return null
    const list = compute && Array.isArray(compute.presets) ? compute.presets : []
    return list.find((entry) => entry && entry.id === id) || null
  }, [compute && compute.presets, perceptionItem])

  const l1Perception = React.useMemo(() => perceiveWorkshopWork({
    pixels: sourcePixels,
    item: perceptionItem,
    preset,
  }), [sourcePixels, perceptionItem, preset])

  React.useEffect(() => {
    setVision(null)
    if (!sourcePixels || !selectedKey) {
      setVisionStatus('idle')
      return undefined
    }
    if (effectiveTag && effectiveTag.source === 'l1+l2') {
      setVisionStatus('skipped')
      return undefined
    }
    const pixels = workshopVisionPixels(sourcePixels)
    if (!pixels) {
      setVisionStatus('failed')
      return undefined
    }
    setVisionStatus('loading')
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let alive = true
    let timedOut = false
    const settleTimer = setTimeout(() => {
      if (!alive) return
      timedOut = true
      controller?.abort()
      setVisionStatus('failed')
    }, L2_SETTLE_TIMEOUT_MS)
    const runVision = async () => {
      if (typeof Worker === 'function') {
        const localRes = await runLocalVisionPerception(pixels, controller ? { signal: controller.signal } : {})
        if (localRes.ok || localRes.disabled) return localRes
      }
      return perceiveWorkshopVision(pixels, controller ? { signal: controller.signal } : {})
    }
    void runVision().then((res) => {
      if (!alive || timedOut) return
      clearTimeout(settleTimer)
      if (!res || !res.ok || !res.perception) {
        setVisionStatus(res && res.disabled ? 'skipped' : 'failed')
        return
      }
      if (pinnedToolRef.current) {
        setVisionStatus('skipped')
        return
      }
      setVision({ key: selectedKey, pixels: sourcePixels, perception: res.perception })
      setVisionStatus('ready')
    }, () => {
      if (!alive || timedOut) return
      clearTimeout(settleTimer)
      setVisionStatus('failed')
    })
    return () => {
      alive = false
      clearTimeout(settleTimer)
      controller?.abort()
    }
  }, [sourcePixels, selectedKey, sourceUrl])

  const activeVision = vision && vision.key === selectedKey && vision.pixels === sourcePixels
    ? vision.perception
    : null
  const livePerception = React.useMemo(
    () => mergeWorkshopPerception(l1Perception, activeVision),
    [l1Perception, activeVision],
  )
  const perception = React.useMemo(() => {
    if (!effectiveTag) return livePerception
    if (effectiveTag.source === 'l1-heuristic' && activeVision) return livePerception
    return applyWorkshopPerceptionTag(l1Perception, effectiveTag)
  }, [effectiveTag, livePerception, l1Perception, activeVision])

  React.useEffect(() => {
    if (!selectedKey || !sourcePixels) return
    if (effectiveTag && effectiveTag.source === 'l1+l2') return
    if (visionStatus !== 'ready' && visionStatus !== 'failed' && visionStatus !== 'skipped') return
    const tag = workshopPerceptionTagFromResult(perception)
    if (!tag) return
    if (effectiveTag) {
      if (effectiveTag.source === tag.source) return
      if (tag.source !== 'l1+l2') return
    }
    setUpgradedTag({ key: selectedKey, tag })
    writePerceptionCache(selectedKey, tag)
    if (!sourcePath) return
    const writeKey = `${selectedKey}:${tag.source}`
    if (tagWriteKeysRef.current.has(writeKey)) return
    tagWriteKeysRef.current.add(writeKey)
    void saveWorkshopPerceptionTag({ path: sourcePath, tag }).then((res) => {
      if (!res || !res.ok) tagWriteKeysRef.current.delete(writeKey)
    }, () => {
      tagWriteKeysRef.current.delete(writeKey)
    })
  }, [perception, sourcePixels, selectedKey, sourcePath, effectiveTag, visionStatus])

  React.useEffect(() => {
    if (!selectedKey || pinnedTool) return
    const recommended = perception.recommendedTools[0]
    if (!isWorkshopTool(recommended)) return
    const liveL1Heuristic = Boolean(
      effectiveTag
      && effectiveTag.source === 'l1-heuristic'
      && activeVision
      && visionStatus === 'ready',
    )
    if (effectiveTag && !liveL1Heuristic) {
      dispatch({ type: 'AUTO_FOCUS_TOOL', tool: recommended, key: `tag:${selectedKey}:${effectiveTag.source}:${effectiveTag.updatedAt}` })
      return
    }
    if (sourcePixels) {
      if (visionStatus !== 'ready' && visionStatus !== 'failed' && visionStatus !== 'skipped') return
      dispatch({ type: 'AUTO_FOCUS_TOOL', tool: recommended, key: `settled:${selectedKey}` })
      return
    }
    if (!perception.derived || !perception.derived.hardPrior) return
    dispatch({ type: 'AUTO_FOCUS_TOOL', tool: recommended, key: `prior:${selectedKey}` })
  }, [perception, sourcePixels, selectedKey, pinnedTool, effectiveTag, activeVision, visionStatus])

  // ── GPU 后处理任务进度（抹除背景 / PBR）─────────────────────────
  const focusedJob = compute && compute.focusedJob ? compute.focusedJob : null
  const activeJob = compute && compute.activeJob ? compute.activeJob : null
  const runningJob = focusedJob || activeJob || null
  const runningJobKey = runningJob ? `${runningJob.id || ''}:${runningJob.status || ''}` : ''
  const opSubmittedRef = React.useRef(false)
  const pendingOutputJobIdRef = React.useRef('')
  const pendingDepthJobIdRef = React.useRef('')
  const depthJobContextRef = React.useRef(null)
  const depthDragRef = React.useRef(null)
  const spatialDragRef = React.useRef(null)

  React.useEffect(() => {
    const job = focusedJob
    if (!job || !opSubmittedRef.current) return
    if (!['remove-bg', 'pbr', 'depth', 'relight'].includes(job.tool)) return
    if (job.status === 'done') {
      opSubmittedRef.current = false
      if (job.tool === 'depth') {
        pendingDepthJobIdRef.current = job.id || ''
        setDepthJobId(job.id || '')
      } else {
        pendingOutputJobIdRef.current = job.id || ''
      }
      dispatch({ type: 'SET_OP_DONE', opDone: true })
      dispatch({ type: 'SET_STATUS', status: '' })
      if (job.tool !== 'depth' && ui && typeof ui.showToast === 'function') {
        ui.showToast(t('studio.workshop.opDone'))
      }
    } else if (job.status === 'failed') {
      opSubmittedRef.current = false
      pendingOutputJobIdRef.current = ''
      pendingDepthJobIdRef.current = ''
      depthJobContextRef.current = null
      setDepthJobId('')
      setDepthBusy('')
      dispatch({ type: 'SET_OP_DONE', opDone: false })
      const detail = job.error && typeof job.error.message === 'string' ? job.error.message.trim().slice(0, 180) : ''
      dispatch({ type: 'SET_STATUS', status: `${t('studio.workshop.opFailed')}${detail ? `：${detail}` : ''}` })
    }
  }, [runningJobKey, focusedJob, t, ui])

  React.useEffect(() => {
    const jobId = pendingOutputJobIdRef.current
    if (!jobId) return
    const nextEntry = galleryWorks.find((entry) => entry && entry.item && entry.item.jobId === jobId)
    if (!nextEntry) return
    pendingOutputJobIdRef.current = ''
    pixelCellPinnedRef.current = false
    dispatch({ type: 'GPU_JOB_SETTLED', entry: nextEntry })
  }, [galleryWorks])

  // ── 平铺倍数与画布预览 ─────────────────────────────────────────
  const resultSvg = result && typeof result.svg === 'string' ? result.svg : ''
  const repeat = (tool === 'tile' && tilePreview) || (tool !== 'tile' && channel === 'tile')
    ? Math.max(1, WORKSHOP.tile.repeat)
    : 1

  const preview = React.useMemo(() => {
    if (isSpatialPreviewActive && spatialLivePreview) {
      return { type: 'image', url: spatialLivePreview }
    }
    const primaryRole = primaryChannelOfEntry(activeWork)
    const ownTool = activeWork && activeWork.item ? activeWork.item.workshopTool : ''
    const hasLiveTransform = Boolean(
      (sourcePixels && tool === 'pixel-snap' && livePixelPreview)
      || (sourcePixels && tool === 'tile' && params.tile.blend && liveTilePreview),
    )
    if (channel !== 'source') {
      if (hasLiveTransform && channel === primaryRole && ownTool !== tool) {
        return { type: 'image', url: tool === 'pixel-snap' ? livePixelPreview : liveTilePreview }
      }
      const target = channelList.find((item) => item.role === channel)
      if (target && target.url) {
        if (target.format === 'svg') return { type: 'svg', url: target.url }
        if (target.format === 'json') return { type: 'json', url: target.url, label: target.label }
        return { type: 'image', url: target.url }
      }
    }
    const sourceChannel = channelList[0]
    const hasDistinctParentSource = Boolean(sourceChannel && sourceChannel.url && sourceChannel.url !== selectedUrl)
    if (resultSvg) return { type: 'svg', url: svgToDataUrl(resultSvg) }
    if (result && result.primary && result.primary.data) {
      if (channel === 'source' && savedResult === result && hasDistinctParentSource) {
        return { type: 'image', url: sourceChannel.url }
      }
      return { type: 'image', url: result.primary.data }
    }
    if (channel === 'source' && hasDistinctParentSource) {
      return { type: 'image', url: sourceChannel.url }
    }
    if (sourcePixels && tool === 'pixel-snap' && livePixelPreview) return { type: 'image', url: livePixelPreview }
    if (sourcePixels && tool === 'tile' && params.tile.blend && liveTilePreview) return { type: 'image', url: liveTilePreview }
    if (sourceUrl) return { type: 'image', url: sourceUrl }
    return { type: 'empty' }
  }, [channel, channelList, resultSvg, result, savedResult, activeWork, tool, livePixelPreview, liveTilePreview, params.tile.blend, sourceUrl, selectedUrl, sourcePixels, isSpatialPreviewActive, spatialLivePreview])

  React.useEffect(() => {
    if (resultSvg) {
      setFetchedSvg('')
      return undefined
    }
    if (!preview || preview.type !== 'svg' || !preview.url) {
      setFetchedSvg('')
      return undefined
    }
    if (preview.url.startsWith('data:image/svg+xml')) {
      const comma = preview.url.indexOf(',')
      try {
        setFetchedSvg(comma >= 0 ? decodeURIComponent(preview.url.slice(comma + 1)) : '')
      } catch {
        setFetchedSvg('')
      }
      return undefined
    }
    if (typeof fetch !== 'function') return undefined
    let alive = true
    fetch(preview.url)
      .then((res) => (res.ok ? res.text() : ''))
      .then((raw) => {
        if (alive && raw) setFetchedSvg(raw)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [resultSvg, preview && preview.type, preview && preview.url])

  const activeSvgText = resultSvg || fetchedSvg
  const svgStats = React.useMemo(() => svgStatsOf(activeSvgText), [activeSvgText])
  const previewRatio = selected && selected.image && selected.image.width > 0 && selected.image.height > 0
    ? selected.image.width / selected.image.height
    : 1

  const canPlay = tool === 'sprite-slice'
    && Boolean(spriteFrames && Array.isArray(spriteFrames.frames) && spriteFrames.frames.length > 0)
  const canTile = tool === 'tile'

  function payloadOf(target) {
    if (!target || !target.primary || !target.primary.data) return null
    const channels = Array.isArray(target.channels) ? target.channels : []
    const cleanChannels = channels
      .filter((item) => item && item.role && typeof item.data === 'string' && item.data)
      .slice(0, WORKSHOP.channels.maxCount)
      .map((item) => ({
        role: item.role,
        label: item.label || channelLabelOf(t, item.role),
        format: item.format || 'png',
        data: item.data,
      }))
    const toolId = WORKSHOP.tools.includes(target.tool) ? target.tool : tool
    const baseName = workNameOf(activeWork && activeWork.image) || 'workshop'
    return {
      base: sourcePath ? { path: sourcePath } : undefined,
      tool: toolId,
      name: `${baseName.replace(/\.[a-z0-9]+$/i, '')}-${toolId}.png`.slice(0, WORKSHOP.save.maxNameChars),
      primary: {
        data: target.primary.data,
        width: Number(target.primary.width) || 0,
        height: Number(target.primary.height) || 0,
      },
      channels: cleanChannels,
      meta: target.meta && typeof target.meta === 'object' ? target.meta : undefined,
    }
  }

  const opRunning = runningJob
    && ['remove-bg', 'pbr', 'depth', 'relight'].includes(runningJob.tool)
    && (runningJob.status === 'pending' || runningJob.status === 'running' || runningJob.status === 'queued')
  let statusNote = ''
  if (opRunning) {
    const runningTool = runningJob.tool
    const runningLabel = runningTool === 'pbr'
      ? t('studio.workshop.tool.pbr')
      : runningTool === 'depth'
        ? t('studio.workshop.tool.depth-fx')
        : runningTool === 'relight'
          ? t('studio.workshop.tool.relight')
          : t('studio.workshop.tool.cutout')
    statusNote = formatText(t('studio.workshop.opRunning'), {
      label: runningLabel,
      progress: jobCountText(t, runningJob) || jobStatusText(t, runningJob.status),
    })
  } else if (status) {
    statusNote = status
  }

  // ── 接力与推荐点 ──────────────────────────────────────────────
  const handoffSource = result && isWorkshopTool(result.tool) ? result.tool : (opDone ? tool : '')
  const handoff = React.useMemo(
    () => (handoffSource ? nextToolSuggestions({ tool: handoffSource, perception }) : []),
    [handoffSource, perception],
  )
  const primaryHandoff = handoff.length > 0 ? handoff[0] : null
  const handoffNeedsSave = Boolean(result) && savedResult !== result
  const recommendationReady = Boolean(effectiveTag)
    || (!sourcePixels && Boolean(perception.derived && perception.derived.hardPrior))
    || (Boolean(sourcePixels) && ['ready', 'failed', 'skipped'].includes(visionStatus))
  const recommendedTools = recommendationReady ? perception.recommendedTools : []

  // ── 动作 ───────────────────────────────────────────────────────
  function selectWork(entry) {
    if (!entry || !entry.image) return
    pixelCellPinnedRef.current = false
    setSpatialBypass(false)
    setCompareSpatial(false)
    dispatch({ type: 'SELECT_WORK', entry, pinnedInitialTool })
  }

  function switchTool(nextTool) {
    if (!WORKSHOP.tools.includes(nextTool)) return
    setSpatialBypass(false)
    setCompareSpatial(false)
    dispatch({ type: 'SELECT_TOOL', tool: nextTool, autoToolKey: `pixel:${selectedKey}` })
  }

  function toggleGuide() {
    setGuideOpen((previous) => {
      const next = !previous
      writeGuideOpen(next)
      return next
    })
  }

  function patchParams(section, patch) {
    if (!patch || typeof patch !== 'object') return
    if (section === 'pixel' && Object.hasOwn(patch, 'cell')) pixelCellPinnedRef.current = true
    if (section === 'depthFx' || section === 'relight') {
      setSpatialBypass(false)
      setCompareSpatial(false)
    }
    setParams((previous) => ({ ...previous, [section]: { ...previous[section], ...patch } }))
  }

  function handleDetect() {
    if (!sourcePixels) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.canvasUnavailable') })
      return
    }
    const grid = detectPixelGridSafe(sourcePixels, { alphaCut: params.pixel.alphaThreshold })
    setDetected(grid)
    if (grid && grid.cell > 1) patchParams('pixel', { cell: grid.cell })
  }

  async function commitResult(nextResult, toastKey, options = {}) {
    if (!nextResult) return null
    const payload = payloadOf(nextResult)
    dispatch({ type: 'SET_RESULT', result: nextResult })
    if (!payload) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.canvasUnavailable') })
      return null
    }
    dispatch({ type: 'SET_BUSY', busy: 'save' })
    try {
      const response = await saveWorkshopAsset(payload)
      if (!response.ok) {
        dispatch({
          type: 'SET_STATUS',
          status: `${t('studio.workshop.saveFailed')}${response.message ? `：${response.message}` : ''}`,
        })
        if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.workshop.saveFailed'))
        return null
      }
      const entry = response.entry || null
      if (entry && entry.image) {
        selfSavedPathRef.current = entry.image.path || ''
        setSavedWorks((previous) => [entry, ...previous.filter((item) => workKeyOf(item) !== workKeyOf(entry))])
      }
      dispatch({
        type: 'COMMIT_SAVED',
        result: nextResult,
        entry,
        autoChannel: options.autoChannel || '',
        opDone: options.opDone,
      })
      if (entry && entry.image && actions && typeof actions.workshopSaved === 'function') {
        actions.workshopSaved(entry)
      }
      if (ui && typeof ui.showToast === 'function') {
        ui.showToast(t(toastKey || 'studio.workshop.saved'))
      }
      return entry
    } finally {
      dispatch({ type: 'SET_BUSY', busy: '' })
    }
  }

  function handleCancelDepth() {
    depthCanceledRef.current = true
    if (depthAbortRef.current) {
      try { depthAbortRef.current.abort() } catch {}
      depthAbortRef.current = null
    }
    depthJobContextRef.current = null
    pendingDepthJobIdRef.current = ''
    opSubmittedRef.current = false
    setDepthJobId('')
    setDepthBusy('')
    dispatch({ type: 'SET_STATUS', status: t('studio.workshop.depth.canceled') })
  }

  function handleCancelSpatial() {
    const defaults = defaultParams()
    if (tool === 'depth-fx') {
      setParams((previous) => ({ ...previous, depthFx: defaults.depthFx }))
    } else if (tool === 'relight') {
      setParams((previous) => ({
        ...previous,
        relight: {
          ...previous.relight,
          lightX: defaults.relight.lightX,
          lightY: defaults.relight.lightY,
          lightZ: defaults.relight.lightZ,
          intensity: defaults.relight.intensity,
          color: defaults.relight.color,
          rim: defaults.relight.rim,
          ambient: defaults.relight.ambient,
        },
      }))
    }
    setSpatialBypass(true)
    setCompareSpatial(false)
    setSpatialLivePreview('')
    dispatch({ type: 'SET_STATUS', status: '' })
  }

  async function handleComputeDepth(execution = 'local') {
    if (depthBusy) return
    if (!sourcePixels) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.canvasUnavailable') })
      return
    }
    depthCanceledRef.current = false
    if (execution === 'cloud') {
      if (!sourcePath || !actions || typeof actions.runWorkshopOp !== 'function') {
        dispatch({ type: 'SET_STATUS', status: t('studio.workshop.depth.cloudUnavailable') })
        return
      }
      setDepthBusy('cloud')
      try {
        const response = await actions.runWorkshopOp({
          op: WORKSHOP.depth.op,
          path: sourcePath,
          model: depthCloudModel,
          execution: 'cloud',
        })
        if (depthCanceledRef.current) return
        if (!response?.ok) {
          setDepthBusy('')
          dispatch({ type: 'SET_STATUS', status: response?.message || t('studio.workshop.depth.failed') })
          return
        }
        opSubmittedRef.current = true
        depthJobContextRef.current = {
          jobId: response.jobId,
          key: localDepthKey,
          sourcePath,
        }
        dispatch({ type: 'SET_OP_DONE', opDone: false })
      } finally {
        if (!opSubmittedRef.current) setDepthBusy('')
      }
      return
    }
    const runner = typeof props.runLocalDepth === 'function' ? props.runLocalDepth : runLocalDepth
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    depthAbortRef.current = controller
    setDepthBusy('local')
    dispatch({ type: 'SET_STATUS', status: t('studio.workshop.depth.loadingLocal') })
    try {
      const result = await runner({
        sourcePixels,
        namespace: workspaceKey,
        signal: controller?.signal,
        onStage(info) {
          if (!info || depthCanceledRef.current) return
          if (info.stage === 'downloading') {
            const total = Number(info.totalBytes) || 0
            const done = Number(info.downloadedBytes) || 0
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
            dispatch({ type: 'SET_STATUS', status: formatText(t('studio.workshop.depth.downloading'), { pct }) })
          } else if (info.stage === 'inferring') {
            dispatch({ type: 'SET_STATUS', status: t('studio.workshop.depth.inferring') })
          }
        },
      })
      if (depthCanceledRef.current || controller?.signal?.aborted) return
      if (!result?.depth) throw new Error('empty depth')
      setSpatialBypass(false)
      setCompareSpatial(false)
      setDepthState({
        key: localDepthKey || `${selectedKey}:local`,
        loading: false,
        depth: result.depth,
        normal: normalPixelsFromDepth(result.depth),
        source: 'local',
        modelId: result.modelId || WORKSHOP.depth.localModel,
        elapsedMs: result.elapsedMs || 0,
        error: '',
      })
      dispatch({ type: 'SET_STATUS', status: '' })
      if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.workshop.depth.done'))
    } catch (error) {
      if (depthCanceledRef.current || controller?.signal?.aborted) {
        dispatch({ type: 'SET_STATUS', status: t('studio.workshop.depth.canceled') })
      } else {
        const detail = error && error.message ? String(error.message).slice(0, 180) : ''
        dispatch({
          type: 'SET_STATUS',
          status: `${t('studio.workshop.depth.failed')}${detail ? `：${detail}` : ''}`,
        })
      }
    } finally {
      if (depthAbortRef.current === controller) depthAbortRef.current = null
      setDepthBusy('')
    }
  }

  async function handleRunRelight() {
    if (!sourcePath || !actions || typeof actions.runWorkshopOp !== 'function') {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.relight.cloudUnavailable') })
      return
    }
    if (busy || opRunning) return
    dispatch({ type: 'SET_BUSY', busy: 'relight' })
    dispatch({ type: 'SET_OP_DONE', opDone: false })
    try {
      const body = {
        op: WORKSHOP.relight.op,
        path: sourcePath,
        model: params.relight.model,
        execution: 'cloud',
        options: {
          prompt: params.relight.prompt,
          steps: params.relight.steps,
          cfg: params.relight.cfg,
          seed: params.relight.seed ?? undefined,
          preset: params.relight.preset,
        },
      }
      const response = await actions.runWorkshopOp(body)
      if (response?.ok) {
        opSubmittedRef.current = true
        dispatch({ type: 'SET_STATUS', status: '' })
      } else {
        dispatch({ type: 'SET_STATUS', status: response?.message || t('studio.workshop.opFailed') })
      }
    } finally {
      dispatch({ type: 'SET_BUSY', busy: '' })
    }
  }

  function handleSpatialPointer(point, phase) {
    if (!point || !['depth-fx', 'relight'].includes(tool)) return
    const x = Math.max(0, Math.min(1, Number(point.x) || 0))
    const y = Math.max(0, Math.min(1, Number(point.y) || 0))
    if (tool === 'relight') {
      patchParams('relight', { lightX: x, lightY: y })
      return
    }
    const settings = params.depthFx
    if (settings.mode === 'fog' && settings.brushMode) {
      if (phase === 'up') {
        spatialDragRef.current = null
        return
      }
      const last = spatialDragRef.current
      if (phase === 'down') {
        patchParams('depthFx', {
          strokes: [...settings.strokes, {
            x,
            y,
            radius: settings.brushRadius,
            feather: settings.brushFeather,
            mode: settings.anchorMode,
            strength: 0.9,
          }].slice(-WORKSHOP.depthFx.fog.brush.maxStrokes),
        })
        spatialDragRef.current = { x, y }
        return
      }
      if (last && Math.hypot(x - last.x, y - last.y) < 0.008) return
      patchParams('depthFx', {
        strokes: [...settings.strokes, {
          x,
          y,
          radius: settings.brushRadius,
          feather: settings.brushFeather,
          mode: settings.anchorMode,
          strength: 0.9,
        }].slice(-WORKSHOP.depthFx.fog.brush.maxStrokes),
      })
      spatialDragRef.current = { x, y }
      return
    }
    if (settings.mode === 'fog') {
      if (phase === 'down') {
        const anchors = [...settings.anchors]
        if (anchors.length >= WORKSHOP.depthFx.fog.maxAnchors) anchors.shift()
        anchors.push({
          x,
          y,
          radius: settings.anchorRadius,
          feather: 0.75,
          mode: settings.anchorMode,
          strength: settings.anchorStrength,
        })
        spatialDragRef.current = { anchorIndex: anchors.length - 1 }
        patchParams('depthFx', { anchors })
      } else if (phase === 'move' && spatialDragRef.current?.anchorIndex >= 0) {
        const anchors = settings.anchors.map((anchor, index) => (
          index === spatialDragRef.current.anchorIndex ? { ...anchor, x, y } : anchor
        ))
        patchParams('depthFx', { anchors })
      } else if (phase === 'up') {
        spatialDragRef.current = null
      }
      return
    }
    if (settings.mode === 'dof') {
      patchParams('depthFx', { focusX: x, focusY: y })
      return
    }
    if (settings.mode === 'parallax') {
      if (phase === 'down') {
        spatialDragRef.current = {
          x,
          y,
          baseX: settings.shiftX,
          baseY: settings.shiftY,
        }
      } else if (phase === 'move' && spatialDragRef.current) {
        const start = spatialDragRef.current
        patchParams('depthFx', {
          shiftX: Math.max(-1, Math.min(1, start.baseX + (x - start.x) * 2.2)),
          shiftY: Math.max(-1, Math.min(1, start.baseY + (y - start.y) * 2.2)),
        })
      } else if (phase === 'up') {
        spatialDragRef.current = null
      }
    }
  }

  function clearSpatialPoints() {
    if (tool === 'depth-fx') patchParams('depthFx', { anchors: [], strokes: [] })
  }

  async function handleApply() {
    if (!selected || !selected.image) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.statusNoSource') })
      return
    }
    if (!canUseCanvas() || !sourcePixels) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.canvasUnavailable') })
      return
    }
    if (busy) return
    dispatch({ type: 'SET_BUSY', busy: 'apply' })
    let nextResult = null
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
        nextResult = {
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
        }
      } else if (tool === 'sprite-slice') {
        const sliced = spriteFrames || sliceSpriteFramesSafe(sourcePixels, {
          rows: params.sprite.rows,
          cols: params.sprite.cols,
          trimAlpha: params.sprite.trimAlpha,
        })
        if (!sliced || !Array.isArray(sliced.frames) || sliced.frames.length === 0) throw new Error('slice failed')
        const primary = await imageUrlToDataUrl(sourceUrl, { maxEdge: WORKSHOP.sprite.maxInputEdge })
        if (!primary) throw new Error('encode failed')
        setSpriteFrames(sliced)
        nextResult = {
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
        }
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
        nextResult = {
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
        }
      } else if (tool === 'depth-fx') {
        if (!depthState.depth) throw new Error('depth required')
        const fullDepth = resizeDepth(depthState.depth, sourcePixels.width, sourcePixels.height)
        const normalPixels = depthState.normal
          ? resizePixels(depthState.normal, Math.max(sourcePixels.width, sourcePixels.height))
          : normalPixelsFromDepth(fullDepth)
        const settings = params.depthFx
        const rendered = applyDepthFx(sourcePixels, fullDepth, {
          mode: settings.mode,
          color: settings.color,
          density: settings.density,
          startDepth: settings.startDepth,
          falloff: settings.falloff,
          groundBias: settings.groundBias,
          horizon: settings.horizon,
          blend: settings.blend,
          anchors: settings.anchors,
          strokes: settings.strokes,
          normal: normalPixels,
          desaturate: settings.desaturate,
          haze: settings.haze,
          contrast: settings.contrast,
          focusX: settings.focusX,
          focusY: settings.focusY,
          aperture: settings.aperture,
          blur: settings.blur,
          tiltShift: settings.tiltShift,
          amplitude: settings.amplitude,
          shiftX: settings.mode === 'parallax' && settings.shiftX === 0 && settings.shiftY === 0 ? 0.25 : settings.shiftX,
          shiftY: settings.shiftY,
        })
        if (!rendered) throw new Error('render failed')
        const data = pixelsToDataUrl(rendered)
        if (!data) throw new Error('encode failed')
        const depthData = pixelsToDataUrl(pixelsFromDepth(fullDepth))
        const normalData = pixelsToDataUrl(normalPixels)
        nextResult = {
          tool,
          primary: { data, width: rendered.width, height: rendered.height },
          channels: [
            { role: 'depthfx', format: 'png', data, label: t('studio.workshop.channel.depthfx'), width: rendered.width, height: rendered.height },
            ...(depthData ? [{ role: 'depth', format: 'png', data: depthData, label: t('studio.workshop.channel.depth'), width: fullDepth.width, height: fullDepth.height }] : []),
            ...(normalData ? [{ role: 'normal', format: 'png', data: normalData, label: t('studio.workshop.channel.normal'), width: normalPixels.width, height: normalPixels.height }] : []),
          ],
          meta: {
            mode: settings.mode,
            color: settings.color,
            density: settings.density,
            startDepth: settings.startDepth,
            falloff: settings.falloff,
            groundBias: settings.groundBias,
            horizon: settings.horizon,
            blend: settings.blend,
            anchors: settings.anchors,
            strokes: settings.strokes,
            focusX: settings.focusX,
            focusY: settings.focusY,
            aperture: settings.aperture,
            blur: settings.blur,
            tiltShift: settings.tiltShift,
            amplitude: settings.amplitude,
            depthSource: depthState.source,
            depthModel: depthState.modelId,
          },
        }
      } else if (tool === 'relight' && params.relight.tab === 'physical') {
        if (!depthState.depth) throw new Error('depth required')
        const fullDepth = resizeDepth(depthState.depth, sourcePixels.width, sourcePixels.height)
        const albedo = materialState.albedo
          ? resizePixels(materialState.albedo, Math.max(sourcePixels.width, sourcePixels.height))
          : null
        const normalPixels = materialState.normal
          ? resizePixels(materialState.normal, Math.max(sourcePixels.width, sourcePixels.height))
          : (depthState.normal
            ? resizePixels(depthState.normal, Math.max(sourcePixels.width, sourcePixels.height))
            : normalPixelsFromDepth(fullDepth))
        const roughness = materialState.roughness
          ? resizePixels(materialState.roughness, Math.max(sourcePixels.width, sourcePixels.height))
          : null
        const metallic = materialState.metallic
          ? resizePixels(materialState.metallic, Math.max(sourcePixels.width, sourcePixels.height))
          : null
        const rendered = applyPhysicalRelight(sourcePixels, fullDepth, {
          albedo,
          normal: normalPixels,
          roughness,
          metallic,
          lightX: params.relight.lightX,
          lightY: params.relight.lightY,
          lightZ: params.relight.lightZ,
          intensity: params.relight.intensity,
          color: params.relight.color,
          rim: params.relight.rim,
          ambient: params.relight.ambient,
        })
        if (!rendered) throw new Error('render failed')
        const data = pixelsToDataUrl(rendered)
        const depthData = pixelsToDataUrl(pixelsFromDepth(fullDepth))
        const normalData = pixelsToDataUrl(normalPixels)
        if (!data) throw new Error('encode failed')
        nextResult = {
          tool,
          primary: { data, width: rendered.width, height: rendered.height },
          channels: [
            { role: 'relit', format: 'png', data, label: t('studio.workshop.channel.relit'), width: rendered.width, height: rendered.height },
            ...(depthData ? [{ role: 'depth', format: 'png', data: depthData, label: t('studio.workshop.channel.depth'), width: fullDepth.width, height: fullDepth.height }] : []),
            ...(normalData ? [{ role: 'normal', format: 'png', data: normalData, label: t('studio.workshop.channel.normal'), width: normalPixels.width, height: normalPixels.height }] : []),
          ],
          meta: {
            mode: 'physical',
            ...params.relight,
            depthSource: depthState.source,
            depthModel: depthState.modelId,
            pbr: Boolean(materialState.albedo),
          },
        }
      }
    } catch (error) {
      const statusKey = error?.message === 'depth required'
        ? 'studio.workshop.depth.required'
        : 'studio.workshop.applyFailed'
      dispatch({ type: 'SET_STATUS', status: t(statusKey) })
      dispatch({ type: 'SET_BUSY', busy: '' })
      return
    }
    dispatch({ type: 'SET_BUSY', busy: '' })
    if (nextResult) {
      const autoChannel = nextResult.tool === 'pixel-snap'
        ? 'pixel'
        : nextResult.tool === 'tile'
          ? 'tile'
          : nextResult.tool === 'depth-fx'
            ? 'depthfx'
            : nextResult.tool === 'relight'
              ? 'relit'
              : ''
      await commitResult(nextResult, 'studio.workshop.appliedSaved', { autoChannel })
    }
  }

  async function handleVectorize() {
    if (!selected || !selected.image || !sourcePath) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.statusNoSource') })
      return
    }
    if (busy) return
    dispatch({ type: 'SET_BUSY', busy: 'vectorize' })
    try {
      const response = await vectorizeWorkshopImage({ path: sourcePath, options: { ...params.vector } })
      if (!response.ok) {
        dispatch({
          type: 'SET_STATUS',
          status: `${t('studio.workshop.vectorizeFailed')}${response.message ? `：${response.message}` : ''}`,
        })
        return
      }
      const primary = await imageUrlToDataUrl(sourceUrl, { maxEdge: WORKSHOP.vector.maxInputEdge })
      await commitResult({
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
      }, 'studio.workshop.vectorizedSaved', { autoChannel: 'svg' })
    } finally {
      dispatch({ type: 'SET_BUSY', busy: '' })
    }
  }

  async function handleRunLocalCutout() {
    if (!selected || !selected.image || !sourceUrl) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.statusNoSource') })
      return
    }
    if (busy) return
    const runner = typeof props.runLocalCutout === 'function' ? props.runLocalCutout : runLocalCutout
    dispatch({ type: 'SET_BUSY', busy: 'cutout' })
    dispatch({ type: 'SET_OP_DONE', opDone: false })
    dispatch({ type: 'SET_STATUS', status: t('studio.workshop.cutout.preparing') })
    try {
      const cutout = await runner({
        sourceUrl,
        onStage(info) {
          if (!info) return
          if (info.stage === 'downloading') {
            const total = Number(info.totalBytes) || 0
            const done = Number(info.downloadedBytes) || 0
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
            dispatch({ type: 'SET_STATUS', status: formatText(t('studio.workshop.cutout.downloading'), { pct }) })
          } else if (info.stage === 'loading') {
            dispatch({ type: 'SET_STATUS', status: t('studio.workshop.cutout.loadingModel') })
          } else if (info.stage === 'inferring') {
            dispatch({ type: 'SET_STATUS', status: t('studio.workshop.cutout.inferring') })
          }
        },
      })
      if (!cutout || !cutout.data) throw new Error('empty cutout')
      await commitResult({
        tool: 'cutout',
        primary: {
          data: cutout.data,
          width: Number(cutout.width) || Number(selected.image.width) || 0,
          height: Number(cutout.height) || Number(selected.image.height) || 0,
        },
        channels: [{
          role: 'cutout',
          format: 'png',
          data: cutout.data,
          label: t('studio.workshop.channel.cutout'),
          width: Number(cutout.width) || Number(selected.image.width) || 0,
          height: Number(cutout.height) || Number(selected.image.height) || 0,
        }],
        meta: {
          mode: 'local',
          model: cutout.modelId || 'rmbg-1.4',
          ep: cutout.ep || 'webgpu',
          elapsedMs: cutout.elapsedMs || 0,
        },
      }, 'studio.workshop.opDone', { autoChannel: 'cutout', opDone: true })
    } catch (error) {
      const detail = error && error.message ? String(error.message).slice(0, 180) : ''
      dispatch({ type: 'SET_STATUS', status: `${t('studio.workshop.cutout.failed')}${detail ? `：${detail}` : ''}` })
    } finally {
      dispatch({ type: 'SET_BUSY', busy: '' })
    }
  }

  async function handleRunGpu() {
    if (!selected || !selected.image || !sourcePath) {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.statusNoSource') })
      return
    }
    if (!actions || typeof actions.runWorkshopOp !== 'function') {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.opFailed') })
      return
    }
    if (busy) return
    dispatch({ type: 'SET_BUSY', busy: 'op' })
    dispatch({ type: 'SET_OP_DONE', opDone: false })
    try {
      const body = {
        op: WORKSHOP.pbr.op,
        path: sourcePath,
        model: pbrModel,
        execution: pbrExecution,
        options: { steps: pbrSteps },
      }
      const response = await actions.runWorkshopOp(body)
      if (response && response.ok) {
        opSubmittedRef.current = true
        dispatch({ type: 'SET_STATUS', status: '' })
      } else {
        dispatch({ type: 'SET_STATUS', status: response?.message || t('studio.workshop.opFailed') })
      }
    } finally {
      dispatch({ type: 'SET_BUSY', busy: '' })
    }
  }

  async function handleFileChange(event) {
    const input = event && event.target ? event.target : null
    const file = input && input.files && input.files[0] ? input.files[0] : null
    if (!file) return
    dispatch({ type: 'SET_BUSY', busy: 'upload' })
    try {
      const data = await fileToDataUrl(file)
      if (!data) throw new Error('read failed')
      const response = await importImageFile({ data, name: file.name })
      const entry = response && response.ok && response.data ? response.data.entry : null
      if (!entry || !entry.image) throw new Error('import failed')
      setUploadedWorks((previous) => [entry, ...previous])
      selectWork(entry)
    } catch {
      dispatch({ type: 'SET_STATUS', status: t('studio.workshop.uploadFailed') })
      if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.workshop.uploadFailed'))
    } finally {
      dispatch({ type: 'SET_BUSY', busy: '' })
      if (input) input.value = ''
    }
  }

  async function handleHandoff(targetTool) {
    if (!isWorkshopTool(targetTool) || targetTool === tool) return
    if (busy) return
    let entry = null
    if (handoffNeedsSave) {
      entry = await commitResult(result)
      if (!entry) return
    }
    pixelCellPinnedRef.current = false
    dispatch({ type: 'HANDOFF', targetTool, entry })
  }

  function handleOpenLatest() {
    const target = works.find((entry) => entry.item && Array.isArray(entry.item.channels) && entry.item.channels.length > 0)
      || works[0]
      || null
    if (!target) return
    selectWork(target)
  }

  function handleCloseWorkshop() {
    if (actions && typeof actions.closeWorkshop === 'function') actions.closeWorkshop()
    else if (ui && typeof ui.setView === 'function') ui.setView('studio')
  }

  function handleCopySvg() {
    if (!activeSvgText) return
    if (ui && typeof ui.copyText === 'function') {
      ui.copyText(activeSvgText, t('studio.workshop.vector.copied'))
      return
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(activeSvgText).then(() => {
        if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.workshop.vector.copied'))
      }).catch(() => {})
    }
  }

  const canApply = Boolean(activeWork && activeWork.image)
  const canRunGpu = Boolean(activeWork && activeWork.image && sourcePath)
  const depthReady = Boolean(depthState.depth)
  const showStudioHint = perception.showStudioReturnHint && !studioHintDismissed
  const canCompareSpatial = Boolean(
    depthReady
    && (tool === 'depth-fx' || (tool === 'relight' && params.relight.tab === 'physical')),
  )
  const stageInteraction = tool === 'depth-fx'
    ? {
        mode: params.depthFx.mode,
        anchors: params.depthFx.anchors,
        focusX: params.depthFx.focusX,
        focusY: params.depthFx.focusY,
        brushMode: params.depthFx.brushMode,
        onPointer: handleSpatialPointer,
      }
    : tool === 'relight' && params.relight.tab === 'physical'
      ? {
          mode: 'relight',
          lightX: params.relight.lightX,
          lightY: params.relight.lightY,
          onPointer: handleSpatialPointer,
        }
      : null

  return (
    <section className="ofs-workshop" data-view-enter={props.viewEnter ? 'true' : undefined}>
      <header className="ofs-workshop-head">
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
          <WorkshopWorksCard
            t={t}
            recentWorks={recentWorks}
            selected={selected}
            selectedRootKey={selectedRootKey}
            busy={busy}
            library={library}
            onSelectWork={selectWork}
            onFileChange={handleFileChange}
          />

          <section className="ofs-workshop-params-wrap ofs-workshop-card--params">
            <div className="ofs-workshop-section-head">
              <h3 className="ofs-workshop-tool-title" key={tool}>
                <Icon name={TOOL_ICONS[tool] || 'image'} size={16} />
                {t(`studio.workshop.tool.${tool}`)}
              </h3>
              <div className="ofs-workshop-section-tools">
                <button
                  type="button"
                  className={guideOpen ? 'ofs-workshop-guide-trigger is-on' : 'ofs-workshop-guide-trigger'}
                  aria-expanded={guideOpen ? 'true' : 'false'}
                  aria-controls="ofs-workshop-guide"
                  aria-label={t(guideOpen ? 'studio.workshop.guide.collapse' : 'studio.workshop.guide.expand')}
                  title={t(guideOpen ? 'studio.workshop.guide.collapse' : 'studio.workshop.guide.expand')}
                  onClick={toggleGuide}
                >
                  ?
                </button>
              </div>
            </div>
            <div className="ofs-workshop-params" key={tool}>
              <WorkshopParams
                t={t}
                tool={tool}
                guideOpen={guideOpen}
                pixel={params.pixel}
                setPixel={(patch) => patchParams('pixel', patch)}
                sprite={params.sprite}
                setSprite={(patch) => patchParams('sprite', patch)}
                tile={params.tile}
                setTile={(patch) => patchParams('tile', patch)}
                vector={params.vector}
                setVector={(patch) => patchParams('vector', patch)}
                pbrExecution={pbrExecution}
                setPbrExecution={setPbrExecution}
                pbrCapability={pbrCapability}
                pbrModel={pbrModel}
                setPbrModel={setPbrModel}
                pbrSteps={pbrSteps}
                setPbrSteps={setPbrSteps}
                depthFx={params.depthFx}
                setDepthFx={(patch) => patchParams('depthFx', patch)}
                depthState={depthState}
                depthBusy={depthBusy}
                depthReady={depthReady}
                depthCloudModel={depthCloudModel}
                setDepthCloudModel={setDepthCloudModel}
                onComputeDepth={handleComputeDepth}
                onCancelDepth={handleCancelDepth}
                onClearSpatialPoints={clearSpatialPoints}
                onCancelSpatial={handleCancelSpatial}
                relight={params.relight}
                setRelight={(patch) => patchParams('relight', patch)}
                materialReady={Boolean(materialState.albedo)}
                onRunRelight={handleRunRelight}
                detected={sourcePixels ? detected : null}
                seam={tool === 'tile' && params.tile.blend && liveTileSeam ? liveTileSeam : (sourcePixels ? seam : null)}
                spriteFrames={sourcePixels ? spriteFrames : null}
                svgStats={tool === 'vectorize' ? svgStats : null}
                busy={busy}
                canApply={canApply}
                canRunGpu={canRunGpu}
                modelReady
                status={statusNote}
                onDetect={handleDetect}
                onApply={handleApply}
                onVectorize={handleVectorize}
                onRunLocalCutout={handleRunLocalCutout}
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
            onTogglePlay={() => canPlay && dispatch({ type: 'TOGGLE_PLAY' })}
            channelList={channelList}
            activeChannel={channel}
            onChannel={(nextChannel) => dispatch({ type: 'SELECT_CHANNEL', channel: nextChannel })}
            tilePreview={tilePreview}
            canTile={canTile}
            onToggleTilePreview={() => canTile && dispatch({ type: 'TOGGLE_TILE_PREVIEW' })}
            cell={params.pixel.cell}
            rows={params.sprite.rows}
            cols={params.sprite.cols}
            spriteFrames={spriteFrames}
            frameMs={params.sprite.frameMs}
            sourceWidth={Number(selected && selected.image ? selected.image.width : 0) || 0}
            sourceHeight={Number(selected && selected.image ? selected.image.height : 0) || 0}
            sourceUrl={sourceUrl}
            svgStats={svgStats}
            canCompareSvg={Boolean(sourceUrl && preview && preview.type === 'svg')}
            compareSvg={compareSvg}
            onToggleCompareSvg={() => dispatch({ type: 'TOGGLE_COMPARE_SVG' })}
            onCopySvg={handleCopySvg}
            previewRatio={previewRatio}
            spatialInteraction={stageInteraction}
            canCompareSpatial={canCompareSpatial}
            compareSpatial={compareSpatial}
            onToggleCompareSpatial={() => setCompareSpatial((previous) => !previous)}
            handoff={primaryHandoff ? (
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
                  onClick={() => dispatch({ type: 'DISMISS_STUDIO_HINT' })}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ) : null}
          />
          {!canUseCanvas() || pixelLoadFailed ? (
            <p className="ofs-workshop-capability">{t('studio.workshop.capabilityMissing')}</p>
          ) : null}
        </section>
      </div>
    </section>
  )
}

/** 工坊页的图片工具能力判定（供测试与外部入口复用）。 */
export function workshopToolKind(tool) {
  if (LOCAL_TOOLS.has(tool)) return 'local'
  if (GPU_TOOLS.has(tool)) return 'gpu'
  return 'unknown'
}
