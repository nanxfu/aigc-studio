/**
 * 作品库域：生成历史 / 画廊分页 / 选中图 / 收藏 / 删除 / 导出。
 *
 * 负责两处加载 effect、首图提示与任务完成后的历史刷新。
 * 依赖入参：{ t, alive, ui, state, initialWorkspaceMode, onImagesRemoved }；
 * ui 提供 toast/错误通道与视图切换；`onImagesRemoved` 由组合层注入，用于按被删路径
 * 级联清理舞台图片工具的 `workDrafts` 与左栏表单的来源引用（阶段十五 Phase C0）。
 *
 * 分页约定（见 docs/SPEC.md 2.2 的 history 接口）：
 *  - 首屏请求 limit=LIMITS.history.pageSize、offset=0；
 *  - 「加载更多」按下一页 offset 追加并去重，失败保留已有列表；
 *  - 任务完成后的刷新总是重新从第 0 页开始，而不是只换第一页；
 *    轮询本身不会触发展开刷新，已加载的分页不会被反复重置。
 *
 * 工作区热切换（独立客户端 Phase 1）：`/api/state.workspace.current` 变化说明数据根变了，
 * 旧工作区的历史 / 收藏 / 选中图 / 版本树 / 新建草稿态全部作废，再从第 0 页重载新工作区数据；
 * 在途请求按数据代次（dataEpochRef）丢弃，旧工作区响应不会写进新工作区。
 * 作品库之外、同样按旧工作区作品路径索引的状态由组合层通过 `onWorkspaceChanged` 级联清理。
 */

import React from 'react'

import { LIMITS } from '../../../shared/contract.js'

import {
  deleteImages as deleteImagesRequest,
  favoriteImage,
  fetchHistory,
  fetchHistoryTree,
  fetchLibrary,
} from '../../api/resources.js'
import {
  historyHasMore,
  mergeHistoryPages,
  nextHistoryOffset,
  pendingJobsOf,
} from '../../logic/jobs.js'
import { buildLineage } from '../../logic/lineage.js'

const PAGE_SIZE = LIMITS.history.pageSize

function flattenHistory(items) {
  const images = []
  for (const item of items) {
    const list = Array.isArray(item.images) ? item.images.filter(Boolean) : []
    for (const image of list) images.push({ image, item })
  }
  return images
}

function applyFavorite(list, target, on) {
  const base = Array.isArray(list) ? list : []
  if (on) return base.includes(target) ? base : [...base, target]
  return base.filter((item) => item !== target)
}

function mergePendingFavorites(serverList, pendingMap) {
  let merged = Array.isArray(serverList) ? serverList : []
  for (const [target, entry] of pendingMap.entries()) {
    merged = applyFavorite(merged, target, entry.next)
  }
  return merged
}

export function useWorkLibrary({ t, alive, ui, state, initialWorkspaceMode, initialSelectedPath, initialNewDraftExplicit, onImagesRemoved, onWorkspaceChanged }) {
  const [selectedPath, setSelectedPath] = React.useState(() => (
    typeof initialSelectedPath === 'string' ? initialSelectedPath : ''
  ))
  // 事件回调里要读最新选中路径（删除后判断「删的是不是当前预览」），不依赖渲染闭包。
  const selectedPathRef = React.useRef(selectedPath)
  selectedPathRef.current = selectedPath
  const [historyItems, setHistoryItems] = React.useState([])
  const [historyHasMoreState, setHistoryHasMoreState] = React.useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = React.useState(false)
  const [favorites, setFavorites] = React.useState([])
  // 阶段十三：显式新建绘图态与版本树按需拉取（打开工作台默认从新建画布起步）。
  const [workspaceMode, setWorkspaceMode] = React.useState(() => (initialWorkspaceMode === 'work' ? 'work' : 'new_draft'))
  const [newDraftExplicit, setNewDraftExplicit] = React.useState(() => Boolean(initialNewDraftExplicit))
  const [newDraftPending, setNewDraftPending] = React.useState(false)
  const [treeUnavailable, setTreeUnavailable] = React.useState(false)
  const [treeLoadingRoot, setTreeLoadingRoot] = React.useState('')
  // 已提交、等待出图的 new_draft 任务 id：完成后切回 work 并选中新图。
  const pendingNewDraftRef = React.useRef('')
  const treeUnavailableRef = React.useRef(false)
  const treeLoadedRef = React.useRef(new Set())

  // 最新回调函数与收藏视图放进 ref：异步回调与 effect 不依赖渲染闭包。
  const tRef = React.useRef(t)
  const uiRef = React.useRef(ui)
  tRef.current = t
  uiRef.current = ui
  const favoritesRef = React.useRef(favorites)
  favoritesRef.current = favorites
  // 按路径记录收藏请求代号与在途乐观态：防快速连击或慢响应乱序覆盖/回滚新状态。
  const favSeqRef = React.useRef(new Map())
  const favPendingRef = React.useRef(new Map())
  // 工作区切换时的级联清理回调放进 ref：effect 不依赖组合层每次渲染新建的函数身份。
  const onWorkspaceChangedRef = React.useRef(onWorkspaceChanged)
  onWorkspaceChangedRef.current = onWorkspaceChanged
  // 数据代次：工作区切换时自增。旧工作区发出的历史 / 收藏 / 版本树请求回来时代次对不上，
  // 整条丢弃——否则切换后旧图片会被晚到的响应重新写回列表，出现裂图与陈旧数据。
  const dataEpochRef = React.useRef(0)

  // 分页推进用 ref：loadMore 在异步回调里读最新位置，不依赖 state 的提交时序。
  const offsetRef = React.useRef(0)
  const hasMoreRef = React.useRef(false)
  const loadingMoreRef = React.useRef(false)

  /**
   * 从第 0 页重新加载（首屏 / 任务完成 / 删除后的刷新都走这里）。
   *
   * @returns {Promise<Array<object>|null>} 本次加载到的历史条目；失败或卸载时返回 null
   */
  const loadHistory = React.useCallback(async () => {
    // 请求发出时记下数据代次：工作区切换后旧工作区的响应必须整条丢弃。
    const epoch = dataEpochRef.current
    const result = await alive(fetchHistory(PAGE_SIZE, 0))
    if (!result || epoch !== dataEpochRef.current) return null
    if (result.ok && result.data && Array.isArray(result.data.items)) {
      const items = result.data.items.filter(Boolean)
      setHistoryItems(items)
      offsetRef.current = nextHistoryOffset(Number(result.data.offset) || 0, items.length)
      const more = historyHasMore(result.data, PAGE_SIZE)
      hasMoreRef.current = more
      setHistoryHasMoreState(more)
      return items
    }
    if (!result.ok) {
      // 加载失败走错误/指引通道，且不清空已有列表。
      uiRef.current.fail(result.code, result.message)
    }
    return null
  }, [alive])

  /** 追加下一页；失败只提示不清空已有分页。 */
  const loadMoreHistory = React.useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return
    // 分页追加同样受数据代次保护：旧工作区的下一页不能追加到新工作区的列表里。
    const epoch = dataEpochRef.current
    loadingMoreRef.current = true
    setHistoryLoadingMore(true)
    const offset = offsetRef.current
    try {
      const result = await alive(fetchHistory(PAGE_SIZE, offset))
      if (!result) return
      if (epoch !== dataEpochRef.current) return
      if (result.ok && result.data && Array.isArray(result.data.items)) {
        const page = result.data.items.filter(Boolean)
        setHistoryItems((prev) => mergeHistoryPages(prev, page))
        offsetRef.current = nextHistoryOffset(offset, page.length)
        // 空页说明已经到底（offset 已越过最后一条），即便宿主误报 hasMore 也不再请求。
        const more = page.length > 0 && historyHasMore(result.data, PAGE_SIZE)
        hasMoreRef.current = more
        setHistoryHasMoreState(more)
        return
      }
      if (!result.ok) uiRef.current.fail(result.code, result.message)
    } finally {
      // 工作区已切换时复位由切换重置负责，晚到的旧请求不再改动新工作区的加载态。
      if (epoch === dataEpochRef.current) {
        loadingMoreRef.current = false
        setHistoryLoadingMore(false)
      }
    }
  }, [alive])

  React.useEffect(() => {
    loadHistory()
  }, [loadHistory])

  const loadLibrary = React.useCallback(async () => {
    const epoch = dataEpochRef.current
    const result = await alive(fetchLibrary())
    if (!result || epoch !== dataEpochRef.current) return
    if (result.ok && result.data && Array.isArray(result.data.favorites)) {
      const merged = mergePendingFavorites(result.data.favorites, favPendingRef.current)
      favoritesRef.current = merged
      setFavorites(merged)
    } else if (!result.ok) {
      uiRef.current.fail(result.code, result.message)
    }
  }, [alive])

  React.useEffect(() => {
    loadLibrary()
  }, [loadLibrary])

  // 首张出图提示 / 任务完成刷新历史的基线先声明：工作区切换时两者都要按新工作区重建。
  const hasState = Boolean(state)
  const lastJob = state && state.lastJob ? state.lastJob : null
  const lastJobKey = lastJob ? `${lastJob.id}:${lastJob.status}` : ''
  const sessionState = (state && state.session && state.session.state) || 'absent'
  const lastJobId = state && state.lastJob ? `${state.lastJob.id}:${state.lastJob.finishedAt ?? ''}` : ''
  const baselineRef = React.useRef(false)
  const seenJobRef = React.useRef('')
  const announcedRef = React.useRef(false)
  const historyBaselineRef = React.useRef(false)
  const lastSeenRef = React.useRef('')

  // ── 工作区热切换（独立客户端 Phase 1）────────────────────────────────────
  // `/api/state.workspace.current` 变化说明数据根变了：作品库的状态全部按旧工作区解释，
  // 必须先整体作废、再按新工作区重新加载，否则旧图片会继续留在舞台 / 作品条上（请求 404 裂图）。
  // 首次拿到 current 只记基线：挂载 effect 已经拉过当前工作区的数据，避免首屏重复请求；
  // 之后的变化才触发重置 + 重载。`workspaceSeenRef` 同时用于去重：服务端刷新 /state 与
  // 顶栏切换后的确认可能是多次快照，同一个 current 只处理一次。
  const workspaceCurrent = state && state.workspace && typeof state.workspace === 'object'
    && typeof state.workspace.current === 'string'
    ? state.workspace.current.trim()
    : ''
  const workspaceSeenRef = React.useRef('')
  const workspaceBaselineRef = React.useRef(false)

  /**
   * 工作区切换后的作品库重置：清空一切按旧工作区解释的状态。
   *
   * 逐项覆盖本 hook 的状态机：
   *  - 历史分页（列表 / offset / hasMore / loading）；
   *  - 焦点（selectedPath 与 ref、workspaceMode、显式新建草稿标记、在途新建绘图任务）；
   *  - 收藏（列表、按路径的乐观态与请求代号）；
   *  - 版本树（已拉取根 / 不可用降级标记 / loading）；
   *  - 提示与刷新基线：用新工作区当前的 lastJob 重建，旧工作区的完成事件不会再触发首图提示
   *    或重复刷新历史。
   *
   * @param {object|null} currentJob 新工作区 `/state.lastJob`（可能为 null）
   */
  function resetWorkspaceLibrary(currentJob) {
    // 历史分页
    setHistoryItems([])
    offsetRef.current = 0
    hasMoreRef.current = false
    setHistoryHasMoreState(false)
    loadingMoreRef.current = false
    setHistoryLoadingMore(false)
    // 焦点与新建草稿态：新工作区从新建画布起步，旧工作区的选中图 / 草稿卡不再显示。
    pendingNewDraftRef.current = ''
    setNewDraftPending(false)
    setNewDraftExplicit(false)
    setWorkspaceMode('new_draft')
    setSelectedPath('')
    selectedPathRef.current = ''
    // 收藏与在途乐观态：收藏是「路径 → 工作区」的映射，换工作区后整体失效。
    favoritesRef.current = []
    setFavorites([])
    favSeqRef.current = new Map()
    favPendingRef.current = new Map()
    // 版本树按需拉取的缓存
    treeLoadedRef.current = new Set()
    treeUnavailableRef.current = false
    setTreeUnavailable(false)
    setTreeLoadingRoot('')
    // 提示 / 刷新基线
    const job = currentJob && typeof currentJob === 'object' ? currentJob : null
    baselineRef.current = true
    seenJobRef.current = job && job.id ? String(job.id) : ''
    announcedRef.current = false
    historyBaselineRef.current = true
    lastSeenRef.current = job ? `${job.id}:${job.finishedAt ?? ''}` : ''
  }

  React.useEffect(() => {
    if (!workspaceCurrent) return
    if (!workspaceBaselineRef.current) {
      workspaceBaselineRef.current = true
      workspaceSeenRef.current = workspaceCurrent
      return
    }
    if (workspaceSeenRef.current === workspaceCurrent) return
    const previous = workspaceSeenRef.current
    workspaceSeenRef.current = workspaceCurrent
    // 代次先自增：从这一刻起，旧工作区所有在途响应回来都直接丢弃。
    dataEpochRef.current += 1
    resetWorkspaceLibrary(lastJob)
    // 组合层级联清理本 hook 之外、同样按旧工作区路径索引的状态（草稿 / 参考图槽 / 对话结果图）。
    if (typeof onWorkspaceChangedRef.current === 'function') {
      onWorkspaceChangedRef.current({ previous, current: workspaceCurrent })
    }
    // 新工作区从第 0 页重载历史与收藏；失败走各自的错误提示通道，不用 loading 卡住界面。
    loadHistory()
    loadLibrary()
    // lastJob 只用于「切换瞬间」重建基线，取本次渲染的最新值即可，不单独作为依赖。
  }, [workspaceCurrent, loadHistory, loadLibrary])

  // 首张出图提示：只对本次页面观察到的新完成批次、且云端仍就绪时报一次。
  // 首次拿到 /state 时把历史 lastJob 记为基线，避免重挂载后对旧结果再次提示；
  // 云端已关闭时不再宣称「云端就绪」。
  React.useEffect(() => {
    if (!hasState) return
    if (!baselineRef.current) {
      baselineRef.current = true
      seenJobRef.current = lastJob ? lastJob.id : ''
      return
    }
    if (!lastJob || lastJob.id === seenJobRef.current) return
    seenJobRef.current = lastJob.id
    if (announcedRef.current || lastJob.status !== 'done' || sessionState !== 'ready') return
    const images = Array.isArray(lastJob.output?.images) ? lastJob.output.images : []
    if (images.length === 0) return
    announcedRef.current = true
    uiRef.current.showToast(tRef.current('studio.toast.firstImage'))
  }, [hasState, lastJobKey, sessionState])

  // 任务完成后刷新历史：重新从第 0 页加载（新图可能连带改变后续分页边界），
  // 首次拿到 /state 时只记下基线（挂载 effect 已拉过第 0 页），避免首屏重复请求 /history。
  React.useEffect(() => {
    if (!hasState) return
    if (!historyBaselineRef.current) {
      historyBaselineRef.current = true
      lastSeenRef.current = lastJobId
      return
    }
    if (!lastJobId || lastSeenRef.current === lastJobId) return
    lastSeenRef.current = lastJobId
    loadHistory()
  }, [hasState, lastJobId, loadHistory])

  // 阶段十三：显式新建绘图提交后保持 new_draft，直到该任务完成再切回 work 并选中新图。
  // 历史刷新由上面的 effect 负责（同一个 lastJobId 变化），这里只切焦点，避免重复请求。
  React.useEffect(() => {
    const jobId = pendingNewDraftRef.current
    if (!jobId || !lastJob || lastJob.id !== jobId) return
    if (lastJob.status === 'failed' || lastJob.status === 'cancelled') {
      pendingNewDraftRef.current = ''
      setNewDraftPending(false)
      return
    }
    if (lastJob.status !== 'done') return
    const first = Array.isArray(lastJob.output?.images) ? lastJob.output.images[0] : null
    // /state can announce completion before /history arrives. Keep the waiting frame until
    // its own image is available, rather than briefly selecting an unrelated older work.
    if (first?.path && !historyItems.some((item) => item.images?.some((image) => image?.path === first.path))) return
    pendingNewDraftRef.current = ''
    setNewDraftPending(false)
    setWorkspaceMode('work')
    setSelectedPath(first && first.path ? first.path : '')
  }, [hasState, lastJobId, historyItems])

  const gallery = flattenHistory(historyItems)
  // 最近生成按批次分组：一次生成（1~4 张）就是一组。
  const batches = historyItems
    .map((item) => ({
      key: item.jobId || item.dir || String(item.prompt),
      prompt: item.prompt || '',
      presetId: item.presetId || '',
      entries: (Array.isArray(item.images) ? item.images.filter(Boolean) : []).map((image) => ({ image, item })),
    }))
    .filter((batch) => batch.entries.length > 0)
  const newest = gallery[0] || null
  // new_draft 时没有选中作品：舞台显示显式新建背景，而不是上一张旧图。
  const selected = workspaceMode === 'new_draft'
    ? null
    : ((selectedPath && gallery.find((entry) => entry.image.path === selectedPath)) || newest)

  // 阶段十三版本树：已加载历史 + 在途活动任务 → 按根折叠的作品卡索引。
  // pendingJobs 每次渲染都是新数组，用 id+status 指纹做依赖（任务参数不会中途变化）。
  const pendingJobs = pendingJobsOf(state)
  const pendingSignature = pendingJobs.map((job) => `${job.id}:${job.status}`).join(',')
  const lineage = React.useMemo(
    () => buildLineage({ items: historyItems, pendingJobs }),
    [historyItems, pendingSignature],
  )

  /** 把焦点切回新建绘图画布（保留表单与在途新画布状态，不重置内容）。 */
  function focusDraft() {
    setNewDraftExplicit(true)
    setWorkspaceMode('new_draft')
    setSelectedPath('')
  }

  /** 进入显式新建绘图态：清空选中，Stage 切「模糊背景 + 取景框」，作品条出现草稿卡。 */
  function newDraft() {
    pendingNewDraftRef.current = ''
    setNewDraftPending(false)
    setNewDraftExplicit(true)
    setWorkspaceMode('new_draft')
    setSelectedPath('')
  }

  /** 新建绘图提交成功：记下任务 id，等它完成后自动切回 work 并选中新图。 */
  function markNewDraftSubmitted(jobId) {
    pendingNewDraftRef.current = typeof jobId === 'string' ? jobId : ''
    setNewDraftExplicit(true)
    setNewDraftPending(true)
    setWorkspaceMode('new_draft')
    setSelectedPath('')
  }

  /** 切到某张作品：用户显式点选即退出新建态，并作废自动跳转（不抢用户焦点）。 */
  function selectImage(entry) {
    pendingNewDraftRef.current = ''
    setNewDraftPending(false)
    setNewDraftExplicit(false)
    setWorkspaceMode('work')
    const path = entry && entry.image ? entry.image.path : ''
    setSelectedPath(path)
    // 本地导入刚落盘返回完整 item 时，在 /history 尚未完成新一轮拉取前先并入本地列表，
    // 避免舞台在等待 /history 期间暂时回退成上一张旧图或空白。
    if (path && entry && entry.item && Array.isArray(entry.item.images) && entry.item.images.length > 0) {
      setHistoryItems((prev) => {
        const exists = prev.some((item) => Array.isArray(item.images) && item.images.some((img) => img && img.path === path))
        return exists ? prev : mergeHistoryPages([entry.item], prev)
      })
    }
  }

  function openMessage(path) {
    if (!path) return
    pendingNewDraftRef.current = ''
    setNewDraftPending(false)
    setNewDraftExplicit(false)
    setWorkspaceMode('work')
    setSelectedPath(path)
  }

  /**
   * 版本面板按需拉树：`GET /history/tree?root=` 补齐跨分页的子版本，条目并入已加载分页。
   * 旧宿主没有该路由（404）时只降级一次：标记 `treeUnavailable`，面板提示后用已加载分页继续。
   */
  async function loadTree(root) {
    const path = typeof root === 'string' ? root.trim() : ''
    if (!path || treeLoadedRef.current.has(path) || treeUnavailableRef.current) return null
    // 旧工作区的版本树请求不能把节点并进新工作区列表，也不能改写新工作区的降级标记。
    const epoch = dataEpochRef.current
    treeLoadedRef.current.add(path)
    setTreeLoadingRoot(path)
    try {
      const result = await alive(fetchHistoryTree(path))
      if (!result || epoch !== dataEpochRef.current) {
        treeLoadedRef.current.delete(path)
        return null
      }
      if (result.ok && result.data && Array.isArray(result.data.items)) {
        const treeItems = result.data.items.filter(Boolean)
        if (treeItems.length > 0) setHistoryItems((prev) => mergeHistoryPages(prev, treeItems))
        return result.data
      }
      if (result.status === 404 || result.code === 'http_404') {
        treeUnavailableRef.current = true
        setTreeUnavailable(true)
        return null
      }
      // 其它失败（网络/5xx）允许下次再试；不改动已有分页。
      treeLoadedRef.current.delete(path)
      uiRef.current.fail(result.code, result.message)
      return null
    } finally {
      if (epoch === dataEpochRef.current) setTreeLoadingRoot('')
    }
  }

  function isFavorite(path) {
    return Boolean(path) && favorites.includes(String(path))
  }

  async function toggleFavorite(path) {
    const target = String(path ?? '')
    if (!target) return
    const next = !favoritesRef.current.includes(target)
    const seq = (favSeqRef.current.get(target) || 0) + 1
    favSeqRef.current.set(target, seq)
    favPendingRef.current.set(target, { seq, next })
    // 先本地翻转（同步写 ref 避免快速连击读到旧值），再以宿主返回的列表为准。
    const optimistic = applyFavorite(favoritesRef.current, target, next)
    favoritesRef.current = optimistic
    setFavorites(optimistic)
    const epoch = dataEpochRef.current
    const result = await alive(favoriteImage(target, next))
    // 工作区已切换：旧工作区的收藏结果不写回；乐观态已由切换重置清空。
    if (!result || epoch !== dataEpochRef.current) return
    // 同路径已有更新的点击发出后，旧响应（成功或失败）直接丢弃。
    if (favSeqRef.current.get(target) !== seq) return
    favPendingRef.current.delete(target)
    if (result.ok && result.data && Array.isArray(result.data.favorites)) {
      const merged = mergePendingFavorites(result.data.favorites, favPendingRef.current)
      favoritesRef.current = merged
      setFavorites(merged)
      uiRef.current.showToast(next ? tRef.current('studio.toast.favorited') : tRef.current('studio.toast.unfavorited'))
      return
    }
    setFavorites((prev) => {
      const rolled = applyFavorite(prev, target, !next)
      favoritesRef.current = rolled
      return rolled
    })
    uiRef.current.fail(result.code, result.message)
  }

  async function deleteImages(paths) {
    const list = (Array.isArray(paths) ? paths : []).filter(Boolean)
    if (list.length === 0) return
    const result = await alive(deleteImagesRequest(list))
    if (!result) return
    if (!result.ok) {
      uiRef.current.fail(result.code, result.message)
      return null
    }
    const removed = Array.isArray(result.data.removed) ? result.data.removed : []
    if (removed.length > 0) uiRef.current.showToast(tRef.current('studio.toast.deleted'))
    if (Array.isArray(result.data.failed) && result.data.failed.length > 0) {
      uiRef.current.fail('delete_failed', tRef.current('studio.error.deleteFailed'))
    }
    // 只有被删掉的那张才清空预览选择：删别的图不该把画面上正在看的作品一并收走
    // （selected 会回落到最新一张，看起来像「删 A 却换成了 B」）。
    const removedSet = new Set(removed)
    const selectedRemoved = removedSet.has(selectedPathRef.current)
    if (selectedRemoved) setSelectedPath('')
    // 删除会改变记录可达性：重新从第 0 页加载，避免 offset 错位。
    const [items] = await Promise.all([loadHistory(), loadLibrary()])
    const failed = Array.isArray(result.data.failed) ? result.data.failed : []
    // 阶段十五 Phase C0：把「删了哪些图 / 回退到哪张」交给组合层级联清理——
    // 舞台图片工具的 workDrafts 与左栏来源引用都不属于作品库域，这里只上报事实。
    if (removed.length > 0 && typeof onImagesRemoved === 'function') {
      const fallback = flattenHistory(Array.isArray(items) ? items : []).find(
        (entry) => entry.image && entry.image.path && !removedSet.has(entry.image.path),
      ) || null
      // 删掉当前预览作品时明确回退到下一张（而不是让 selected 被宿主返回顺序带着漂）。
      if (selectedRemoved && fallback) setSelectedPath(fallback.image.path)
      onImagesRemoved({ removed, failed, fallback, selectedRemoved })
    }
    return { removed, failed }
  }

  /** 从画廊打开大图：切回创作页并直接进放大层。 */
  function zoomImage(entry) {
    if (!entry) return
    selectImage(entry)
    uiRef.current.setView('studio')
    uiRef.current.setZoom(true)
  }

  async function exportPaths(paths) {
    const list = (Array.isArray(paths) ? paths : []).filter(Boolean)
    if (list.length === 0) return
    // 导出的是「复制文件路径」，用宿主给的绝对路径；老记录没有绝对路径时退回原值。
    const absoluteOf = new Map()
    for (const entry of gallery) {
      const image = (entry && entry.image) || {}
      if (image.path && image.absolute) absoluteOf.set(image.path, image.absolute)
    }
    const text = list.map((item) => absoluteOf.get(item) || item).join('\n')
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        uiRef.current.showToast(tRef.current('studio.toast.exported'))
        return
      }
    } catch {
      // 退化为提示
    }
    uiRef.current.showToast(text)
  }

  return {
    gallery,
    batches,
    selected,
    selectImage,
    openMessage,
    favorites,
    isFavorite,
    toggleFavorite,
    deleteImages,
    exportPaths,
    zoomImage,
    loadHistory,
    // 画廊分页：hasMore 决定底部显示「加载更多」还是「已加载全部作品」。
    offset: offsetRef.current,
    hasMore: historyHasMoreState,
    loadingMore: historyLoadingMore,
    loadMore: loadMoreHistory,
    // 阶段十三：原始历史条目与版本树索引（Filmstrip 按根折叠、版本面板取数据）。
    items: historyItems,
    lineage,
    // 工作区焦点：new_draft 时 selected 为 null，作品条显示新建草稿卡。
    selectedPath,
    workspaceMode,
    newDraftExplicit,
    newDraftPending,
    focusDraft,
    newDraft,
    markNewDraftSubmitted,
    // 版本树按需拉取与旧宿主降级状态。
    loadTree,
    treeUnavailable,
    treeLoadingRoot,
  }
}
