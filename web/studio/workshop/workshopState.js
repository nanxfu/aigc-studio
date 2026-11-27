/**
 * 资产工坊的状态机与版本链 / 通道纯逻辑（无 React / DOM 依赖）。
 *
 * 设计目的：
 *  1. 把原本散落在多个 useEffect 与 pending/keep ref 里的状态迁移收口进单一 reducer，
 *     保证选作品、切版本、切工具、切通道、应用落盘与接力均为原子迁移；
 *  2. 多代工坊加工（如 原图 → 抹除背景 → 无缝平铺）时，通道条能沿着版本链回溯到真正
 *     进入工坊前的原图，并保留中间加工版本的通道，避免「原图被中间版本顶掉」或「抠图
 *     通道在下一步消失」；
 *  3. 版本切换条合并 lineage 与未刷新进 lineage 的本地新保存条目，防止落盘瞬间漏版本。
 */

import { WORKSHOP } from '../../../shared/contract.js'
import { routePath } from '../../api.js'

/** 各工坊工具在通道条中对应的默认主通道 role。 */
export const TOOL_PRIMARY_CHANNEL = Object.freeze({
  cutout: 'cutout',
  tile: 'tile',
  'pixel-snap': 'pixel',
  vectorize: 'svg',
  'sprite-slice': 'spritesheet',
  pbr: 'albedo',
  'depth-fx': 'depthfx',
  relight: 'relit',
})

/** 通道 role → 词典文案键（未知角色回落到「其它通道」）。 */
const CHANNEL_LABEL_KEYS = Object.freeze({
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
  depth: 'studio.workshop.channel.depth',
  depthfx: 'studio.workshop.channel.depthfx',
  relit: 'studio.workshop.channel.relit',
  other: 'studio.workshop.channel.other',
})

export function channelLabelOf(t, role) {
  return t(CHANNEL_LABEL_KEYS[role] || 'studio.workshop.channel.other')
}

export function workNameOf(image) {
  if (!image) return ''
  if (typeof image.file === 'string' && image.file.trim()) return image.file.trim()
  const path = typeof image.path === 'string' ? image.path.trim() : ''
  return path.split(/[\\/]/).filter(Boolean).pop() || ''
}

export function workKeyOf(entry) {
  if (!entry || !entry.image) return ''
  return entry.image.path || entry.image.url || ''
}

export function selectionKeyOf(entry, workspaceKey = '') {
  const key = workKeyOf(entry)
  return key ? `${workspaceKey}\u0000${key}` : ''
}

export function isDerivedWorkshopItem(item) {
  return Boolean(item && (item.workshop || item.workshopTool))
}

export function primaryChannelOfEntry(entry) {
  const item = entry && entry.item ? entry.item : null
  if (!item || !isDerivedWorkshopItem(item)) return 'source'
  const role = TOOL_PRIMARY_CHANNEL[item.workshopTool]
  const channels = Array.isArray(item.channels) ? item.channels : []
  if (role && channels.some((ch) => ch && ch.role === role)) return role
  return 'source'
}

function fileApiUrlOfPath(relativePath) {
  const path = typeof relativePath === 'string' ? relativePath.trim() : ''
  if (!path || path.includes('..') || !path.startsWith('outputs/')) return ''
  return `${routePath('file')}?${new URLSearchParams({ path }).toString()}`
}

/**
 * 沿着 sourceImage 链向上回溯工坊衍生祖先：
 *  - ancestors：从最老的工坊祖先到当前作品的直接工坊父节点（不含非工坊原图与 selected 自身）；
 *  - originEntry：进入工坊前的真实原图条目（若已在 works 中）；
 *  - originUrl：进入工坊前的真实原图 URL（找不到非工坊父节点时回落到 rootImage / sourceImage）。
 */
export function resolveWorkshopChain(selected, works) {
  if (!selected || !selected.image) return { originEntry: null, originUrl: '', ancestors: [] }
  const selectedUrl = selected.image.url || ''
  if (!isDerivedWorkshopItem(selected.item)) {
    return { originEntry: selected, originUrl: selectedUrl, ancestors: [] }
  }

  const byPath = new Map()
  for (const entry of works) {
    const path = entry && entry.image && typeof entry.image.path === 'string' ? entry.image.path.trim() : ''
    if (path && !byPath.has(path)) byPath.set(path, entry)
  }

  const ancestorsReversed = []
  let originEntry = null
  let immediateParent = null
  let lastMissingSourcePath = ''
  let current = selected
  const seen = new Set()

  for (let depth = 0; depth < 16; depth += 1) {
    const parentPath = current && current.item && typeof current.item.sourceImage === 'string'
      ? current.item.sourceImage.trim()
      : ''
    if (!parentPath || seen.has(parentPath)) break
    seen.add(parentPath)
    const parent = byPath.get(parentPath) || null
    if (!parent) {
      lastMissingSourcePath = parentPath
      break
    }
    if (!immediateParent) immediateParent = parent
    if (!isDerivedWorkshopItem(parent.item)) {
      originEntry = parent
      break
    }
    ancestorsReversed.push(parent)
    current = parent
  }

  const ancestors = ancestorsReversed.reverse()

  if (originEntry && originEntry.image && originEntry.image.url) {
    return { originEntry, originUrl: originEntry.image.url, ancestors }
  }

  const rootPath = selected.item && typeof selected.item.rootImage === 'string'
    ? selected.item.rootImage.trim()
    : ''
  if (rootPath) {
    const rootEntry = byPath.get(rootPath)
    if (rootEntry && rootEntry.image && rootEntry.image.url) {
      return { originEntry: rootEntry, originUrl: rootEntry.image.url, ancestors }
    }
    const fallbackRootUrl = fileApiUrlOfPath(rootPath)
    if (fallbackRootUrl) {
      return {
        originEntry: { image: { path: rootPath, url: fallbackRootUrl }, item: { channels: [] } },
        originUrl: fallbackRootUrl,
        ancestors,
      }
    }
  }

  if (lastMissingSourcePath) {
    const fallbackParentUrl = fileApiUrlOfPath(lastMissingSourcePath)
    if (fallbackParentUrl) {
      return {
        originEntry: { image: { path: lastMissingSourcePath, url: fallbackParentUrl }, item: { channels: [] } },
        originUrl: fallbackParentUrl,
        ancestors,
      }
    }
  }

  if (immediateParent && immediateParent.image && immediateParent.image.url) {
    return { originEntry: immediateParent, originUrl: immediateParent.image.url, ancestors }
  }

  return { originEntry: selected, originUrl: selectedUrl, ancestors }
}

function entryTimeScore(entry) {
  const item = entry && entry.item ? entry.item : null
  if (!item) return 0
  for (const field of ['finishedAt', 'createdAt']) {
    const ms = typeof item[field] === 'string' ? Date.parse(item[field]) : Number(item[field])
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

/**
 * 构建画布底部的通道切换条：
 *  1. 首项始终是回溯后的真实「原图」，并绑定其来源条目 `workEntry`；
 *  2. 沿版本链保留祖先工坊节点（例如 原图 → 抹除背景 → 无缝平铺），并补全同一作品树中
 *     已有的后续/分支工坊版本通道（例如停在 v2 抹除背景时仍能看到并切到 v3 无缝平铺）；
 *  3. 最后追加当前选中作品自身的 channels（优先保留当前选中版本自己的通道）。
 * 右侧通道点选某一张图后，下一步操作可直接以该通道所属的 `workEntry` 为输入。
 */
export function buildChannelList(selected, works, t, groupEntries = null) {
  if (!selected || !selected.image) return []
  const { originEntry, originUrl, ancestors } = resolveWorkshopChain(selected, works)
  const list = [{
    role: 'source',
    label: t('studio.workshop.channel.source'),
    url: originUrl,
    thumb: originUrl,
    format: 'png',
    workEntry: originEntry || selected,
  }]

  const upsertChannel = (channel, ownerEntry) => {
    if (!channel || !channel.role) return
    const format = channel.format || 'png'
    const normalized = {
      role: channel.role,
      label: channelLabelOf(t, channel.role),
      url: channel.url || '',
      // 非图片通道（如 atlas.json）不挂 <img src>，防止出现裂图占位。
      thumb: format === 'json' ? '' : (channel.url || ''),
      format,
      workEntry: ownerEntry || selected,
    }
    const existingIndex = list.findIndex((item) => item.role === normalized.role)
    if (existingIndex > 0) list[existingIndex] = normalized
    else if (existingIndex < 0) list.push(normalized)
  }

  const pushEntryChannels = (entry) => {
    if (!entry || !entry.item) return
    const entryChannels = Array.isArray(entry.item.channels) ? entry.item.channels : []
    if (entryChannels.length > 0) {
      for (const ch of entryChannels) upsertChannel(ch, entry)
    } else if (TOOL_PRIMARY_CHANNEL[entry.item.workshopTool] && entry.image && entry.image.url) {
      upsertChannel({
        role: TOOL_PRIMARY_CHANNEL[entry.item.workshopTool],
        format: entry.item.workshopTool === 'vectorize' ? 'svg' : 'png',
        url: entry.image.url,
      }, entry)
    }
  }

  const seenKeys = new Set()
  const orderedEntries = []
  const appendUnique = (entry) => {
    if (!entry || !entry.item) return
    const key = workKeyOf(entry)
    if (key && seenKeys.has(key)) return
    if (key) seenKeys.add(key)
    orderedEntries.push(entry)
  }

  for (const ancestor of ancestors) appendUnique(ancestor)
  appendUnique(selected)

  if (Array.isArray(groupEntries) && groupEntries.length > 0) {
    const siblings = groupEntries
      .filter((entry) => entry && isDerivedWorkshopItem(entry.item) && !seenKeys.has(workKeyOf(entry)))
      .reverse()
    for (const sibling of siblings) appendUnique(sibling)
  }

  // 有时间戳时按先后顺序排列，保证「原图 → 抹除背景 → 无缝平铺」顺序稳定不随当前焦点漂移。
  orderedEntries.sort((left, right) => {
    const leftTime = entryTimeScore(left)
    const rightTime = entryTimeScore(right)
    if (leftTime && rightTime && leftTime !== rightTime) return leftTime - rightTime
    return 0
  })

  for (const entry of orderedEntries) pushEntryChannels(entry)
  // 若同 role 存在多个版本且当前选中项本身包含该 role，确保该 role 绑定到当前选中项。
  if (selected && selected.item && Array.isArray(selected.item.channels)) {
    for (const ch of selected.item.channels) upsertChannel(ch, selected)
  }

  return list
}

/** 将扁平作品列表按根作品折叠为最近作品分组，保留版本计数。 */
export function buildRecentWorkGroups(works, rootKeyOf, lineageRoots) {
  const groups = new Map()
  for (const entry of works) {
    const rootKey = rootKeyOf(entry)
    if (!rootKey) continue
    let group = groups.get(rootKey)
    if (!group) {
      group = { rootKey, latest: entry, entries: [] }
      groups.set(rootKey, group)
    }
    group.entries.push(entry)
  }
  const rootCountByPath = new Map()
  if (lineageRoots) {
    for (const rootCard of lineageRoots) {
      if (!rootCard || !rootCard.path) continue
      const nodes = Array.isArray(rootCard.nodes) ? rootCard.nodes.filter((n) => n && !n.ghost) : []
      if (nodes.length > 0) rootCountByPath.set(rootCard.path, nodes.length)
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    versionCount: Math.max(group.entries.length, rootCountByPath.get(group.rootKey) || 0),
  }))
}

/** 创建工坊工作台初始状态。 */
export function createInitialWorkshopState({
  selected,
  tool,
  initialChannel,
  initialTilePreview,
  initialCompareSvg,
  initialResult,
  pinnedInitialTool,
}) {
  const channel = typeof initialChannel === 'string' && initialChannel
    ? initialChannel
    : primaryChannelOfEntry(selected)
  const tilePreview = initialTilePreview !== undefined
    ? Boolean(initialTilePreview)
    : (tool === 'tile' || channel === 'tile')
  return {
    selected: selected || null,
    tool,
    channel,
    tilePreview,
    playing: false,
    compareSvg: Boolean(initialCompareSvg),
    studioHintDismissed: false,
    result: initialResult || null,
    savedResult: null,
    opDone: false,
    busy: '',
    status: '',
    pinnedTool: Boolean(pinnedInitialTool),
    autoToolKey: '',
  }
}

/**
 * 工坊工作台状态迁移 Reducer。
 * 所有用户交互与保存落盘都通过显式 action 一次完成关联字段迁移，避免多条 useEffect 互相覆盖。
 */
export function workshopReducer(state, action) {
  switch (action.type) {
    case 'HYDRATE_FIRST_WORK': {
      if (state.selected && state.selected.image) return state
      const entry = action.entry
      if (!entry || !entry.image) return state
      const channel = primaryChannelOfEntry(entry)
      return {
        ...state,
        selected: entry,
        channel,
        tilePreview: state.tool === 'tile' || channel === 'tile',
      }
    }
    case 'SYNC_INITIAL_ENTRY': {
      const entry = action.entry
      if (!entry) return state
      const channel = primaryChannelOfEntry(entry)
      return {
        ...state,
        selected: entry,
        channel,
        tilePreview: state.tool === 'tile' || channel === 'tile',
        playing: false,
        compareSvg: false,
        studioHintDismissed: false,
        result: null,
        savedResult: null,
        opDone: false,
        status: '',
        pinnedTool: Boolean(action.pinnedInitialTool),
        autoToolKey: '',
      }
    }
    case 'SELECT_WORK': {
      const entry = action.entry
      if (!entry || !entry.image) return state
      const channel = primaryChannelOfEntry(entry)
      return {
        ...state,
        selected: entry,
        channel,
        tilePreview: state.tool === 'tile' || channel === 'tile',
        playing: false,
        compareSvg: false,
        studioHintDismissed: false,
        result: null,
        savedResult: null,
        opDone: false,
        status: '',
        pinnedTool: Boolean(action.pinnedInitialTool),
        autoToolKey: '',
      }
    }
    case 'SELECT_TOOL': {
      const nextTool = action.tool
      if (!WORKSHOP.tools.includes(nextTool)) return state
      return {
        ...state,
        tool: nextTool,
        playing: false,
        compareSvg: nextTool === 'vectorize' ? state.compareSvg : false,
        tilePreview: nextTool === 'tile',
        status: '',
        pinnedTool: true,
        autoToolKey: action.autoToolKey || state.autoToolKey,
      }
    }
    case 'AUTO_FOCUS_TOOL': {
      const nextTool = action.tool
      const key = action.key || ''
      if (state.pinnedTool || !WORKSHOP.tools.includes(nextTool) || state.autoToolKey === key) {
        return state
      }
      return {
        ...state,
        tool: nextTool,
        playing: false,
        compareSvg: nextTool === 'vectorize' ? state.compareSvg : false,
        tilePreview: nextTool === 'tile' ? true : (state.channel === 'tile'),
        status: '',
        autoToolKey: key,
      }
    }
    case 'SELECT_CHANNEL': {
      const nextChannel = action.channel
      if (!nextChannel) return state
      return {
        ...state,
        channel: nextChannel,
        tilePreview: nextChannel === 'tile' ? true : (state.tool === 'tile' ? state.tilePreview : false),
      }
    }
    case 'TOGGLE_TILE_PREVIEW': {
      if (state.tool !== 'tile') return state
      return { ...state, tilePreview: !state.tilePreview }
    }
    case 'TOGGLE_PLAY': {
      return { ...state, playing: !state.playing }
    }
    case 'TOGGLE_COMPARE_SVG': {
      return { ...state, compareSvg: !state.compareSvg }
    }
    case 'DISMISS_STUDIO_HINT': {
      return { ...state, studioHintDismissed: true }
    }
    case 'SET_BUSY': {
      return { ...state, busy: action.busy || '' }
    }
    case 'SET_STATUS': {
      return { ...state, status: action.status || '' }
    }
    case 'SET_OP_DONE': {
      return { ...state, opDone: Boolean(action.opDone) }
    }
    case 'SET_RESULT': {
      return { ...state, result: action.result || null }
    }
    case 'COMMIT_SAVED': {
      const entry = action.entry && action.entry.image ? action.entry : null
      const nextSelected = entry || state.selected
      const nextChannel = action.autoChannel && entry
        && Array.isArray(entry.item?.channels)
        && entry.item.channels.some((c) => c && c.role === action.autoChannel)
        ? action.autoChannel
        : (entry ? primaryChannelOfEntry(entry) : state.channel)
      return {
        ...state,
        selected: nextSelected,
        result: action.result || state.result,
        savedResult: action.result || state.result,
        channel: nextChannel,
        tilePreview: nextChannel === 'tile' || state.tool === 'tile',
        playing: false,
        compareSvg: false,
        studioHintDismissed: false,
        opDone: action.opDone !== undefined ? Boolean(action.opDone) : state.opDone,
        pinnedTool: entry ? true : state.pinnedTool,
        status: '',
      }
    }
    case 'GPU_JOB_SETTLED': {
      const entry = action.entry
      if (!entry || !entry.image) return state
      const firstChannel = Array.isArray(entry.item?.channels) && entry.item.channels[0]
        ? entry.item.channels[0].role
        : 'source'
      const nextChannel = firstChannel || primaryChannelOfEntry(entry)
      return {
        ...state,
        selected: entry,
        channel: nextChannel,
        tilePreview: nextChannel === 'tile' || state.tool === 'tile',
        playing: false,
        compareSvg: false,
        studioHintDismissed: false,
        result: null,
        savedResult: null,
        opDone: true,
        status: '',
      }
    }
    case 'HANDOFF': {
      const targetTool = action.targetTool
      if (!WORKSHOP.tools.includes(targetTool)) return state
      const entry = action.entry && action.entry.image ? action.entry : null
      const nextSelected = entry || state.selected
      const nextChannel = primaryChannelOfEntry(nextSelected)
      return {
        ...state,
        selected: nextSelected,
        tool: targetTool,
        channel: nextChannel,
        tilePreview: targetTool === 'tile' || nextChannel === 'tile',
        playing: false,
        compareSvg: false,
        studioHintDismissed: false,
        result: null,
        savedResult: null,
        opDone: false,
        status: '',
        pinnedTool: true,
        autoToolKey: '',
      }
    }
    default:
      return state
  }
}
