/**
 * 客户端外壳渲染测试（不需要浏览器）。
 *
 * 覆盖：Web 入口契约 / 场景基础渲染 / 画廊 / 顶栏 / 设置抽屉 / 指引卡 / 舞台空态 /
 * 日志抽屉 / 更新提示。画廊分页与界面态持久化也在这里。
 *
 * 运行：node test/check-client-shell.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LIMITS } from '../shared/contract.js'
import {
  cancelJob as cancelJobRequest,
  cancelKaggleLogin,
  enhancePromptRequest,
  fetchHistory,
  fetchKaggleLogin,
  fetchSettings as fetchSettingsRequest,
  fetchUiState as fetchUiStateRequest,
  kaggleLoginAction,
  saveSettings as saveSettingsRequest,
  saveUiState as saveUiStateRequest,
  startKaggleLogin,
  startSession as startSessionRequest,
  submitKaggleLoginCode,
} from '../web/api/resources.js'
import { createCheckRunner } from './helpers/check.mjs'
import { assertStructure, collectText, countByClass, findNodes, createTestClient } from './helpers/render.mjs'
import {
  NOW, at, preset, turbo, image, historyItem, readyState, scenarios, studioResponses,
  settingsView, appSettingsView, mountSettingsDrawer, idleShutdownSession, mountTopBarExpanded,
} from './helpers/client-fixtures.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const { check, summary } = createCheckRunner()

// 原 DSH 专属断言「发布产物是合法 bundle / inject+apply 注册插槽」已随宿主剥离删除
// （MIGRATION_SPEC §9.2）：standalone 版没有 DSH ModuleLoader 发布产物，也不再有槽位注册。
// 等价契约改为校验 Web 入口：main.jsx 负责 createRoot 挂载 <Studio />，index.html 提供挂载点。
await check('Web 入口契约：main.jsx 挂载 Studio，index.html 提供 root 容器', async () => {
  const main = await readFile(join(ROOT, 'web/main.jsx'), 'utf8')
  assert.match(main, /createRoot\s*\(/, 'main.jsx 必须用 createRoot 挂载')
  assert.match(main, /getElementById\(\s*['"]root['"]\s*\)/, 'main.jsx 必须挂到 #root')
  assert.match(main, /from\s+['"]\.\/studio\/Studio\.jsx['"]/, 'main.jsx 必须导入 Studio')
  assert.match(main, /<Studio\b/, 'main.jsx 必须渲染 <Studio />')
  const html = await readFile(join(ROOT, 'web/index.html'), 'utf8')
  assert.ok(html.includes('<div id="root">'), 'index.html 必须提供 #root 容器')
  assert.match(html, /<script[^>]+src=["']\.\/main\.jsx["']/, 'index.html 必须加载 ./main.jsx')
})
await check('渲染：工作区菜单当前值不重复堆叠标题', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const baseProps = {
    t,
    isEn: false,
    ui: { view: 'studio', setView: () => {}, openLogs: () => {}, openSettings: () => {} },
    compute: { presets: [], provider: 'kaggle', status: { tone: 'idle', label: '云端未启动' }, workspace: { current: '', recent: [], switchable: true } },
    form: { form: {}, patchForm: () => {}, selectPreset: () => {} },
    library: {},
    actions: {},
    defaultWorkspaceOpen: true,
  }
  const emptyTree = await client.mountRaw(client.components.TopBar, baseProps)
  const emptyText = collectText(emptyTree).join('')
  assert.ok(emptyText.includes('未选择工作区'), '空状态应明确说明尚未选择工作区')
  assert.ok(!emptyText.includes('当前工作区未选择工作区'), '空状态不应把字段标题和状态拼成重复句')
  client.unmount()

  const pathClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const pathTree = await pathClient.mountRaw(pathClient.components.TopBar, {
    ...baseProps,
    compute: { ...baseProps.compute, workspace: { current: 'D:\\Studio\\Projects\\A', recent: [], switchable: true } },
  })
  const pathText = collectText(pathTree).join('')
  assert.ok(pathText.includes('当前工作区'), '有路径时保留字段标签')
  assert.ok(pathText.includes('D:\\Studio\\Projects\\A'), '完整当前路径应在标签下展示')
  pathClient.unmount()
})

for (const [name, scenario] of Object.entries(scenarios)) {
  await check(`渲染：${name}`, async () => {
        const responses = studioResponses(scenario.state, scenario.history)
    const client = await createTestClient({
      now: NOW,
      responses,
      failures: scenario.failures ?? {},
      testBuild: true,
    })
    const tree = scenario.view === 'gallery'
      // 画廊是工作台内的一个视图，用组件自身的初始 state 无法直达，这里直接挂 Gallery
      ? await client.mountRaw(client.components.Gallery, {
          t: client.internals.i18n.fallbackTranslate('zh'),
          gallery: [{ image: historyItem.images[0], item: historyItem }],
          now: NOW,
          presets: [preset],
          favorites: [],
          hasMore: false,
          loadingMore: false,
          onLoadMore: () => {},
          onDelete: () => {},
          onExport: () => {},
          onOpen: () => {},
          onRedraw: () => {},
          onZoom: () => {},
        })
      : await client.mountRaw(client.components.Studio, scenario.props ?? {})
    client.unmount()
    const text = collectText(tree).join(' | ')
    for (const needle of scenario.expect) assert.ok(text.includes(needle), `[${name}] 缺少文案：${needle}`)
    for (const needle of scenario.reject ?? []) assert.ok(!text.includes(needle), `[${name}] 不应出现文案：${needle}`)
    assertStructure(name, tree, scenario.structure)
  })
}
await check('画廊悬停动作把完整作品条目交给回调（阶段十五 A1 收敛）', async () => {
  const client = await createTestClient({ now: NOW, responses: studioResponses(readyState, { items: [historyItem] }), testBuild: true })
  const received = { open: [], redraw: [], zoom: [] }
  const entry = { image: historyItem.images[0], item: historyItem }
  const tree = await client.mountRaw(client.components.Gallery, {
    t: client.internals.i18n.fallbackTranslate('zh'),
    gallery: [entry],
    now: NOW,
    presets: [preset],
    favorites: [],
    onDelete: () => {},
    onExport: () => {},
    onOpenStudio: (value) => { received.open.push(value) },
    onRedraw: (value) => { received.redraw.push(value) },
    onZoom: (value) => { received.zoom.push(value) },
  })
  client.unmount()
  const actions = findNodes(
    tree,
    (node) => node.type === 'button'
      && typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('ofs-gallery-action'),
  )
  // 动作收敛：在工作台打开 / 重绘编辑 / 查看大图 / 删除；带回参数与生成变体已下线。
  assert.equal(actions.length, 4, '每张作品应有在工作台打开 / 重绘编辑 / 查看大图 / 删除四个动作')
  for (const node of actions) node.props.onClick()
  assert.deepEqual(received.open, [entry], '「在工作台打开」应收到完整 { image, item } 条目')
  assert.deepEqual(received.redraw, [entry], '「重绘编辑」应收到完整条目')
  assert.deepEqual(received.zoom, [entry], '「查看大图」应收到完整条目')
  // 主点击与「在工作台打开」同义（不是切到画廊之外的另一套动作）。
  const media = findNodes(tree, (node) => node.type === 'button' && node.props?.className === 'ofs-gallery-media')[0]
  media.props.onClick()
  assert.deepEqual(received.open, [entry, entry], '点卡片图片与「在工作台打开」同义')
  // 画廊不再盲发请求：条目里只有作品数据，动作全部交给组合层。
  const cardText = collectText(tree).join(' | ')
  assert.ok(!cardText.includes('带回参数'), '画廊不应再出现「带回参数」')
  assert.ok(!cardText.includes('生成变体'), '画廊不应再出现「生成变体」')
  assert.ok(cardText.includes('在工作台打开') && cardText.includes('重绘编辑'), '新动作文案来自字典键')
})
// 画廊列分配：行优先，第一行从左到右就是最新顺序；列内部保留自然高度。
await check('渲染：画廊按行优先分列，最新作品在第一行最左', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const entries = [image(101), image(102), image(103)].map((img) => ({ image: img, item: historyItem }))
  const tree = await client.mountRaw(client.components.Gallery, {
    t,
    gallery: entries,
    now: NOW,
    presets: [preset],
    favorites: [],
    onDelete: () => {},
    onExport: () => {},
    onOpen: () => {},
    onZoom: () => {},
    onToggleFavorite: () => {},
  })
  client.unmount()
  const columns = findNodes(tree, (node) => node.props && node.props.className === 'ofs-gallery-col')
  assert.equal(columns.length, 4, '1280px 视口下应是 4 列')
  const srcOf = (column) => findNodes(column, (node) => node.type === 'img').map((node) => node.props.src)
  assert.deepEqual(srcOf(columns[0]), [image(101).url], '最新作品落在第一列第一格')
  assert.deepEqual(srcOf(columns[1]), [image(102).url], '第二新落在第二列')
  assert.deepEqual(srcOf(columns[2]), [image(103).url], '第三新落在第三列')
  assert.deepEqual(srcOf(columns[3]), [], '条目用完后不再往后面的列补位')
})
// 卡片直接收藏：星标是图片按钮的兄弟节点，点击只切收藏，不连带打开大图。
await check('渲染：画廊卡片星标切换收藏，不影响打开大图', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const entries = [image(7), image(8)].map((img) => ({ image: img, item: historyItem }))
  const favoriteCalls = []
  const opened = []
  const baseProps = (extra = {}) => ({
    t,
    gallery: entries,
    now: NOW,
    presets: [preset],
    favorites: [entries[0].image.path],
    onDelete: () => {},
    onExport: () => {},
    onOpen: (entry) => opened.push(entry),
    onRedraw: () => {},
    onZoom: () => {},
    onToggleFavorite: (path) => favoriteCalls.push(path),
    ...extra,
  })
  const tree = await client.mountRaw(client.components.Gallery, baseProps())
  client.unmount()
  const starButtons = findNodes(
    tree,
    (node) => node.type === 'button'
      && typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('ofs-gallery-star'),
  )
  assert.equal(starButtons.length, 2, '每张卡片都应有一个星标按钮')
  assert.equal(starButtons[0].props['aria-pressed'], true, '已收藏的星标是选中态')
  assert.equal(starButtons[1].props['aria-pressed'], false)
  // 星标必须是图片按钮的兄弟节点：嵌套 button 既不合规，也会让点击互相干扰。
  const mediaButtons = findNodes(
    tree,
    (node) => node.type === 'button' && node.props && node.props.className === 'ofs-gallery-media',
  )
  assert.equal(mediaButtons.length, 2)
  for (const media of mediaButtons) {
    assert.equal(countByClass(media, 'ofs-gallery-star'), 0, '星标不应嵌在图片按钮内部')
  }
  starButtons[1].props.onClick({ stopPropagation: () => {} })
  assert.deepEqual(favoriteCalls, [entries[1].image.path], '点星标只把该图路径交给收藏动作')
  assert.equal(opened.length, 0, '点星标不应打开大图')
  // 批量选择态：星标整颗收起，点图片只切换选中，不打开大图也不误触收藏。
  const selectingClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const selectingTree = await selectingClient.mountRaw(
    selectingClient.components.Gallery,
    baseProps({ defaultSelecting: true }),
  )
  selectingClient.unmount()
  assert.equal(
    findNodes(
      selectingTree,
      (node) => node.props && typeof node.props.className === 'string'
        && node.props.className.split(' ').includes('ofs-gallery-star'),
    ).length,
    0,
    '批量选择模式下不应出现可点击的星标',
  )
  assert.equal(
    findNodes(selectingTree, (node) => node.props && node.props.className === 'ofs-gallery-pick').length,
    2,
    '批量选择模式下每张卡片显示选择圆点',
  )
  const selectingMedia = findNodes(
    selectingTree,
    (node) => node.type === 'button' && node.props && node.props.className === 'ofs-gallery-media',
  )
  selectingMedia[0].props.onClick()
  assert.equal(opened.length, 0, '批量选择时点图片只切换选中，不打开大图')
  assert.deepEqual(favoriteCalls, [entries[1].image.path], '批量选择时不应触发收藏')
})
// 单张删除：第一次点击只进入确认态，可取消；再点一次才把这一张交给删除动作。
await check('渲染：画廊卡片单张删除需二次确认', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const entry = { image: image(31), item: historyItem }
  const deleted = []
  let tree = await client.mountRaw(client.components.Gallery, {
    t,
    gallery: [entry],
    now: NOW,
    presets: [preset],
    favorites: [],
    onDelete: async (paths) => {
      deleted.push(paths)
      return { removed: paths, failed: [] }
    },
    onExport: () => {},
    onOpen: () => {},
    onRedraw: () => {},
    onZoom: () => {},
    onToggleFavorite: () => {},
  })
  const dangerButton = () => findNodes(
    tree,
    (node) => node.type === 'button'
      && typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('is-danger'),
  )[0]
  assert.equal(collectText(dangerButton()).join(''), '删除', '未确认时按钮只写「删除」')
  dangerButton().props.onClick()
  tree = await client.rerenderRaw()
  assert.equal(collectText(dangerButton()).join(''), '确认删除', '第一次点击进入确认态，而不是直接删除')
  assert.equal(deleted.length, 0, '确认前不得发出删除请求')
  // 取消：回到未确认，不触发删除。
  const cancel = findNodes(tree, (node) => node.type === 'button' && collectText(node).join('') === '取消')[0]
  assert.ok(cancel, '确认态应提供「取消」')
  cancel.props.onClick()
  tree = await client.rerenderRaw()
  assert.equal(collectText(dangerButton()).join(''), '删除', '取消后按钮回到未确认态')
  // 指针移出卡片：确认态自动收起，避免下次滑过时误删。
  dangerButton().props.onClick()
  tree = await client.rerenderRaw()
  findNodes(tree, (node) => typeof node.props?.className === 'string'
    && node.props.className.split(' ').includes('ofs-gallery-card'))[0].props.onMouseLeave()
  tree = await client.rerenderRaw()
  assert.equal(collectText(dangerButton()).join(''), '删除', '移出卡片应收起确认态')
  // 二次点击才真正删除，并且只提交这一张的路径。
  dangerButton().props.onClick()
  tree = await client.rerenderRaw()
  await dangerButton().props.onClick()
  assert.deepEqual(deleted, [[entry.image.path]], '确认后只删除这一张')
  tree = await client.rerenderRaw()
  assert.equal(collectText(dangerButton()).join(''), '删除', '删除成功后收起确认态')
  client.unmount()
})
// 历史首屏按契约页长请求，offset 从 0 开始（分页由「加载更多」推进）。
await check('渲染：历史首屏按契约页长与 offset 请求', async () => {
  const client = await createTestClient({
    now: NOW,
        responses: studioResponses(readyState, { items: [historyItem], limit: LIMITS.history.pageSize, offset: 0, hasMore: false }),
    testBuild: true,
  })
  await client.mountRaw(client.components.Studio, {})
  client.unmount()
  assert.ok(
    client.fetches.includes(`/api/history?limit=${LIMITS.history.pageSize}&offset=0`),
    `历史首屏应取契约页长且 offset=0，实际请求：${client.fetches.join(', ')}`,
  )
  assert.ok(!client.fetches.includes('/api/history?limit=60'), '不应再写死旧的 60 张上限')
})
// 英文界面：流水线节点文案走本地化，不能出现宿主硬编码的中文 stage。
await check('渲染：英文界面的生图流水线', async () => {
  const client = await createTestClient({
    now: NOW,
    locale: 'en-US',
    responses: {
      '/api/state': {
        ...readyState,
        jobs: [
          { id: 'job-e2', status: 'queued', createdAt: at(-5), params: { prompt: 'queued second' } },
          {
            id: 'job-e1',
            status: 'running',
            stageCode: 'running',
            progress: { done: 1, total: 3 },
            createdAt: at(-30),
            startedAt: at(-8),
            params: { prompt: 'running first' },
          },
        ],
      },
      '/api/history': { items: [] },
      '/api/library': { favorites: [], deleted: [] },
    },
    testBuild: true,
  })
  const tree = await client.mountRaw(client.components.Studio, {})
  client.unmount()
  const text = collectText(tree).join(' | ')
  assert.ok(text.includes('Cloud ready'), `[pipeline] 英文节点文案应本地化：${text}`)
  assert.ok(text.includes('Image 2/3'), '[pipeline] 英文分张进度应本地化')
  assert.ok(text.includes('1 more queued'), '[pipeline] 英文排队数量应本地化')
  assert.ok(!text.includes('另有'), '[pipeline] 英文界面不应出现中文队列文案')
})
// 阶段十五 Phase C0：1Hz 读秒从 Studio 顶层下沉到流水线自己——只有它随后一秒重渲染；
// 空闲（无活动任务 / 非过渡态）时不注册任何定时器，等待期间不驱动整页。
await check('渲染：流水线读秒下沉到组件内部（等待时自走一秒，空闲时不计时）', async () => {
  const running = { id: 'job-tick', status: 'running', createdAt: at(-8), startedAt: at(-8), params: { prompt: '读秒中的画面' } }
  const client = await createTestClient({
    now: NOW,
    responses: studioResponses({ ...readyState, jobs: [running] }, { items: [] }),
    testBuild: true,
  })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const timeTextOf = (tree) => {
    const node = findNodes(
      tree,
      (item) => typeof item.props?.className === 'string' && item.props.className.split(/\s+/).includes('ofs-pl-time'),
    )[0]
    return node ? collectText(node).join('') : ''
  }
  const mountBar = (props) => client.mountRaw(client.components.PipelineBar, {
    t,
    session: { state: 'ready' },
    activeJob: null,
    focusedJob: null,
    pendingCount: 0,
    queuePolicy: null,
    failureDismissed: false,
    transient: false,
    ...props,
  })
  try {
    // 等待中：组件内部每秒推进「已等待」读数，重新渲染即可见。
    let tree = await mountBar({ activeJob: running, pendingCount: 1 })
    assert.ok(timeTextOf(tree).includes('0:08'), `应在组件内渲染已等待 0:08，实际：${timeTextOf(tree)}`)
    assert.equal(await client.advanceTimers(1000), 1, '等待期间流水线注册了 1Hz 走字定时器')
    tree = await client.rerenderRaw()
    assert.ok(timeTextOf(tree).includes('0:09'), `走一秒后应为 0:09，实际：${timeTextOf(tree)}`)

    // 空闲：没有活动任务、也不是过渡会话态 → 不渲染计时，也不再注册定时器。
    client.unmount()
    tree = await mountBar({})
    assert.equal(countByClass(tree, 'ofs-pl-time'), 0, '空闲时不显示「已等待」计时')
    assert.equal(await client.advanceTimers(3000), 0, '空闲时流水线不注册定时器')
    await client.rerenderRaw()
  } finally {
    client.unmount()
  }
})
await check('渲染：日志抽屉（就绪 / 空态 / 不可用）', async () => {
  const fallbackState = {
    ...readyState,
    version: '0.4.1',
    probe: { cli: { present: true }, auth: { ok: true }, quota: { available: false }, notes: ['配额接口超时'] },
    probeLastGood: { quota: { available: true, usedHours: 3, totalHours: 30 } },
    probeLastGoodAt: '2026-11-09T04:40:00.000Z',
    queue: { running: null, pending: 0 },
  }
    const responses = studioResponses(fallbackState, { items: [historyItem] })
  const lines = ['[boot] 运行时就绪', '[tunnel] 隧道就绪：https://example.trycloudflare.com']
  // 就绪：日志行进入等宽文本区，复制诊断信息走 ui.copyText。
  let client = await createTestClient({ now: NOW, responses, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const copied = []
  let tree = await client.mountRaw(client.components.LogsDrawer, {
    t,
    ui: { copyText: (text, key) => copied.push({ text, key }) },
    compute: { session: { state: 'ready' }, probe: null },
    logs: { status: 'ready', lines, reason: null },
    onClose: () => {},
  })
  let text = collectText(tree).join(' | ')
  assert.ok(text.includes('运行日志'), '[logs] 缺少标题')
  assert.ok(text.includes('复制诊断信息'), '[logs] 缺少复制诊断按钮')
  assert.ok(text.includes('[tunnel] 隧道就绪'), '[logs] 缺少日志内容')
  assertStructure('logs-ready', tree, {
    required: { 'ofs-logs': 1, 'ofs-logs-panel': 1, 'ofs-logs-head': 1, 'ofs-logs-title': 1, 'ofs-logs-body': 1, 'ofs-logs-lines': 1, 'ofs-logs-copy': 1 },
    forbidden: ['ofs-logs-note'],
  })
  const dialog = findNodes(tree, (node) => node.props && node.props.role === 'dialog')[0]
  assert.ok(dialog, '[logs] 抽屉应以 role="dialog" 渲染')
  assert.equal(dialog.props['aria-modal'], 'true')
  const copyButton = findNodes(
    tree,
    (node) => node.type === 'button' && node.props && node.props.className === 'ofs-chip ofs-logs-copy',
  )[0]
  assert.ok(copyButton, '[logs] 缺少复制按钮元素')
  copyButton.props.onClick()
  assert.equal(copied.length, 1, '[logs] 复制应交给 ui.copyText')
  assert.equal(copied[0].key, 'studio.logs.copied')
  assert.ok(copied[0].text.includes('version: 0.4.1'), '[logs] 诊断文本应带版本')
  assert.ok(copied[0].text.includes('session.state: ready'), '[logs] 诊断文本应带会话快照')
  assert.ok(!copied[0].text.includes('token'), '[logs] 诊断文本不得出现 token 字段')
  client.unmount()
  // 空态：没有日志时只给一句提示，不渲染等宽日志区。
  client = await createTestClient({ now: NOW, responses, testBuild: true })
  tree = await client.mountRaw(client.components.LogsDrawer, {
    t,
    ui: { copyText: () => {} },
    compute: { session: null, probe: null },
    logs: { status: 'empty', lines: [], reason: null },
    onClose: () => {},
  })
  client.unmount()
  text = collectText(tree).join(' | ')
  assert.ok(text.includes('暂无日志'), '[logs] 缺少空态文案')
  assertStructure('logs-empty', tree, { required: { 'ofs-logs-note': 1 }, forbidden: ['ofs-logs-lines'] })
  // 不可用：展示原因，同时保留已经拿到的旧日志。
  client = await createTestClient({ now: NOW, responses, testBuild: true })
  tree = await client.mountRaw(client.components.LogsDrawer, {
    t,
    ui: { copyText: () => {} },
    compute: { session: null, probe: null },
    logs: { status: 'unavailable', lines: ['[boot] 旧日志'], reason: { code: 'logs_unavailable', message: '隧道断开' } },
    onClose: () => {},
  })
  client.unmount()
  text = collectText(tree).join(' | ')
  assert.ok(text.includes('暂时拿不到远端运行日志'), '[logs] 不可用时应给出错误文案')
  assert.ok(text.includes('隧道断开'), '[logs] 不可用时应带远端原因')
  assertStructure('logs-unavailable', tree, {
    required: { 'ofs-logs-note': 1, 'ofs-logs-lines': 1 },
    forbidden: [],
  })
  // 只有 Host 本地日志（无远端会话）：仍渲染日志区并注明来源，复制诊断带 host logs 段落。
  client = await createTestClient({ now: NOW, responses, testBuild: true })
  const hostCopied = []
  const hostLogs = [
    '[2026-11-11T23:10:00.123Z] [info] [jobs] enqueue jobId=j_1',
    '[2026-11-11T23:10:03.456Z] [warn] [session] transition absent->starting',
  ]
  tree = await client.mountRaw(client.components.LogsDrawer, {
    t,
    ui: { copyText: (copy, key) => hostCopied.push({ text: copy, key }) },
    compute: { session: null, probe: null },
    logs: {
      status: 'unavailable',
      lines: [],
      hostLines: hostLogs,
      reason: { code: 'session_absent', message: '云端会话未启动' },
    },
    onClose: () => {},
  })
  text = collectText(tree).join(' | ')
  assert.ok(text.includes('Host 本地运行日志'), '[logs] 只有 Host 日志时应注明来源')
  assert.ok(text.includes('[info] [jobs] enqueue jobId=j_1'), '[logs] 应展示 Host 本地日志内容')
  assert.ok(text.includes('云端会话未启动'), '[logs] 无远端会话时应保留原因提示')
  assertStructure('logs-host-only', tree, {
    required: { 'ofs-logs-note': 2, 'ofs-logs-lines': 1 },
    forbidden: [],
  })
  const hostCopyButton = findNodes(
    tree,
    (node) => node.type === 'button' && node.props && node.props.className === 'ofs-chip ofs-logs-copy',
  )[0]
  assert.ok(hostCopyButton, '[logs] 缺少复制按钮元素')
  hostCopyButton.props.onClick()
  assert.equal(hostCopied.length, 1, '[logs] 复制应交给 ui.copyText')
  assert.ok(hostCopied[0].text.includes('host logs (last 2/2):'), '[logs] 诊断文本应带 Host 日志段落')
  assert.ok(
    hostCopied[0].text.includes('[warn] [session] transition absent->starting'),
    '[logs] 诊断文本应带 Host 日志内容',
  )
  client.unmount()
})
await check('渲染：算力弹层配额回退、隧道通道与日志入口', async () => {
  const fallbackState = {
    ...readyState,
    version: '0.4.1',
    probe: { cli: { present: true }, auth: { ok: true }, quota: { available: false }, notes: ['配额接口超时'] },
    probeLastGood: { quota: { available: true, usedHours: 3, totalHours: 30 } },
    probeLastGoodAt: '2026-11-09T04:40:00.000Z',
    queue: { running: null, pending: 0 },
    session: {
      state: 'ready',
      modelId: 'sdxl-lightning',
      device: 'Tesla T4',
      idleTimeoutSec: 1800,
      tunnelProvider: 'cloudflare',
      startedAt: new Date(NOW - 600000).toISOString(),
      error: null,
    },
  }
  const client = await createTestClient({ now: NOW, responses: studioResponses(fallbackState, { items: [] }), testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const openLogsCalls = []
  const tree = await client.mountRaw(client.components.TopBar, {
    t,
    ui: {
      view: 'studio',
      setView: () => {},
      openLogs: (trigger) => openLogsCalls.push(trigger),
    },
    compute: {
      sessionState: 'ready',
      session: fallbackState.session,
      quota: null,
      presets: [preset],
      busy: '',
      probing: false,
      probe: null,
      probeReport: null,
      startSession: () => {},
      stopSession: () => {},
      runProbe: () => {},
      openFolder: () => {},
    },
    form: {
      form: { presetId: 'sdxl-lightning', width: 1024, height: 1024, steps: 4, cfg: 0 },
      patchForm: () => {},
      selectPreset: () => {},
    },
    library: { loadHistory: () => {} },
    // 正式界面从关闭态开始；这里为渲染断言直接展开弹层。
    defaultOpen: true,
  })
  client.unmount()
  const text = collectText(tree).join(' | ')
  for (const needle of [
    '配额暂时读不到，先看本地统计',
    '最近一次成功检查',
    '3 / 30 h',
    '本次会话已运行',
    '打开 Kaggle 账户设置',
    '隧道通道',
    'Cloudflare',
    '查看运行日志',
    '闲置 30 分钟关机',
  ]) {
    assert.ok(text.includes(needle), `[compute] 缺少文案：${needle}`)
  }
  assertStructure('compute-fallback', tree, {
    required: { 'ofs-popover': 1, 'ofs-popover-fallback': 1, 'ofs-popover-link': 1 },
    forbidden: [],
  })
  // Colab 会话：顶栏胶囊保持极简不展示 CCU 余额，展开面板后展示 CCU 余额位与耗速详情。
  const colabProps = {
    t,
    ui: { view: "studio", setView: () => {}, openLogs: () => {} },
    compute: {
      sessionState: "ready",
      session: { ...fallbackState.session, provider: "colab", providerUsage: { balance: 198.1, rate: 1.83, assignments: 1 } },
      quota: null,
      presets: [preset],
      busy: "",
      probing: false,
      probe: null,
      probeReport: null,
      startSession: () => {},
      stopSession: () => {},
      runProbe: () => {},
      openFolder: () => {},
    },
    form: { form: { presetId: "sdxl-lightning", width: 1024, height: 1024, steps: 4, cfg: 0 }, patchForm: () => {}, selectPreset: () => {} },
    library: { loadHistory: () => {} },
  }
  const ccuPillTree = await client.mountRaw(client.components.TopBar, { ...colabProps, defaultOpen: false })
  client.unmount()
  assert.ok(!collectText(ccuPillTree).join(" ").includes("198.1"), "[compute] 顶栏胶囊保持极简，不应直接展示 CCU 余额")
  const ccuTree = await client.mountRaw(client.components.TopBar, { ...colabProps, defaultOpen: true })
  client.unmount()
  const ccuText = collectText(ccuTree).join(" ")
  assert.ok(ccuText.includes("198.1") && ccuText.includes("CCU"), `[compute] Colab 展开面板应展示 CCU 余额：${ccuText}`)

  const link = findNodes(
    tree,
    (node) => node.type === 'a' && node.props && node.props.className === 'ofs-popover-link',
  )[0]
  assert.ok(link, '[compute] 缺少 Kaggle 设置链接')
  assert.equal(link.props.href, 'https://www.kaggle.com/settings')
  assert.equal(link.props.target, '_blank')
  assert.match(String(link.props.rel), /noreferrer/)
  const logsRow = findNodes(
    tree,
    (node) => node.type === 'button'
      && node.props
      && node.props.role === 'menuitem'
      && collectText(node).join('').includes('查看运行日志'),
  )[0]
  assert.ok(logsRow, '[compute] 缺少查看运行日志入口')
  logsRow.props.onClick()
  assert.equal(openLogsCalls.length, 1, '[compute] 点击日志入口应交给 ui.openLogs')
  // 回归：本轮从未点过「检查环境」时 /state 的 probe 为 null，账号状态不能落成「不可用」。
  // 故意不给 /state 应答，避免宿主快照里的 probe 掩盖问题。
  const mountWithoutProbe = async (sessionState, session) => {
    const bare = await createTestClient({ now: NOW, responses: {}, testBuild: true })
    const bareTree = await bare.mountRaw(bare.components.TopBar, {
      t,
      ui: { view: 'studio', setView: () => {}, openLogs: () => {} },
      compute: {
        sessionState,
        session,
        quota: null,
        presets: [preset],
        busy: '',
        probing: false,
        probe: null,
        probeReport: null,
        startSession: () => {},
        stopSession: () => {},
        runProbe: () => {},
        openFolder: () => {},
      },
      form: {
        form: { presetId: 'sdxl-lightning', width: 1024, height: 1024, steps: 4, cfg: 0 },
        patchForm: () => {},
      },
      library: { loadHistory: () => {} },
      defaultOpen: true,
    })
    bare.unmount()
    return collectText(bareTree).join('')
  }
  // 会话已就绪（能出图）→ 账号正常：会话本身就是凭据有效的证据。
  const readyFlat = await mountWithoutProbe('ready', fallbackState.session)
  assert.ok(readyFlat.includes('账号 · 正常'), `[compute] 会话就绪时账号应为正常，实际：${readyFlat}`)
  assert.ok(!readyFlat.includes('账号 · 不可用'), '[compute] 会话就绪时不应把账号判成不可用')
  // 既没探测过、也没有会话 → 未检查，同样不能落成「不可用」。
  const idleFlat = await mountWithoutProbe('absent', null)
  assert.ok(idleFlat.includes('账号 · 未检查'), `[compute] 未探测时应显示未检查，实际：${idleFlat}`)
  assert.ok(!idleFlat.includes('账号 · 不可用'), '[compute] 未探测不应显示不可用')
})
// ── 运行设置抽屉（M2.3） ───────────────────────────────────────
await check('渲染：算力弹层运行设置入口与空闲倒计时', async () => {
  // 两个字段都有真实读数：展示「已空闲 X 分钟 · 满 Y 分钟自动关机」。
  const first = await mountTopBarExpanded(idleShutdownSession)
  const firstText = collectText(first.tree).join('')
  assert.ok(
    firstText.includes('已空闲 10 分钟 · 满 30 分钟自动关机'),
    `[idle] 缺少空闲倒计时：${firstText}`,
  )
  const settingsRow = findNodes(
    first.tree,
    (node) => node.type === 'button'
      && node.props
      && node.props.role === 'menuitem'
      && collectText(node).join('').includes('设置'),
  )[0]
  assert.ok(settingsRow, '[idle] 缺少设置入口')
  settingsRow.props.onClick()
  assert.equal(first.opened.length, 1, '[idle] 点击入口应打开设置弹窗')
  first.client.unmount()
  // 缺 idleSeconds（旧宿主 / 没有 /health 的会话态）：不编造倒计时，退回休眠阈值说明。
  const missing = await mountTopBarExpanded({ state: 'ready', modelId: 'sdxl-lightning', idleTimeoutSec: 1800, error: null })
  const missingText = collectText(missing.tree).join('')
  assert.ok(!missingText.includes('已空闲'), '[idle] 缺 idleSeconds 时不应展示倒计时')
  assert.ok(missingText.includes('闲置 30 分钟关机'), `[idle] 缺读数时应保留休眠阈值：${missingText}`)
  missing.client.unmount()
  // 两个字段都缺：整行不出现。
  const none = await mountTopBarExpanded({ state: 'ready', modelId: 'sdxl-lightning', error: null })
  const noneText = collectText(none.tree).join('')
  assert.ok(!noneText.includes('已空闲'), '[idle] 缺 idleSeconds 时不应展示倒计时')
  assert.ok(!noneText.includes('分钟关机'), '[idle] 缺 idleTimeoutSec 时不应展示阈值')
  none.client.unmount()
  // 不足一分钟同样不显示，避免出现「已空闲 0 分钟」。
  const fresh = await mountTopBarExpanded({ ...idleShutdownSession, idleSeconds: 30 })
  assert.ok(
    !collectText(fresh.tree).join('').includes('已空闲'),
    '[idle] 空闲不足一分钟不应展示 0 分钟',
  )
  fresh.client.unmount()
})
await check('渲染：设置居中双栏弹窗、4 Tab 切换、生效提示与 Token 状态', async () => {
  const mounted = await mountSettingsDrawer()
  let tree = mounted.tree
  const refresh = async () => {
    tree = await mounted.client.rerenderRaw()
    return tree
  }
  const tabBtn = (id) => findNodes(
    tree,
    (node) => node.type === 'button' && node.props && node.props['data-settings-tab'] === id,
  )[0]
  try {
    // 1) 默认落在「创作助手」Tab：顶部连通状态 + 服务商图标 + 统一单保存按钮。
    const assistantText = collectText(tree).join(' | ')
    for (const needle of ['设置', '创作助手', '云端算力', '本机模型', '外观与通用', '版本与更新', '已就绪 · OpenAI / gpt-5-mini', '服务商', 'API Key', '模型', '获取模型', '关闭', '保存模型设置']) {
      assert.ok(assistantText.includes(needle), `[settings-assistant] 缺少文案：${needle}\n实际：${assistantText}`)
    }
    assertStructure('settings-modal-assistant', tree, {
      required: {
        'ofs-settings': 1,
        'ofs-settings-panel': 1,
        'ofs-settings-sidebar': 1,
        'ofs-settings-nav-item': 5,
        'ofs-settings-main': 1,
        'ofs-settings-head': 1,
        'ofs-settings-body': 1,
        'ofs-settings-status': 1,
        'ofs-provider-icon': 2,
        'ofs-settings-save': 1,
      },
      forbidden: ['ofs-settings-effective', 'ofs-settings-advanced', 'ofs-settings-textarea', 'ofs-settings-errors'],
    })
    const dialog = findNodes(tree, (node) => node.props && node.props.role === 'dialog')[0]
    assert.ok(dialog, '[settings] 弹窗应以 role="dialog" 渲染')
    assert.equal(dialog.props['aria-modal'], 'true')
    assert.equal(dialog.props['aria-label'], '设置')
    const closeButton = findNodes(
      tree,
      (node) => node.type === 'button' && node.props && node.props['aria-label'] === '关闭设置',
    )[0]
    assert.ok(closeButton, '[settings] 缺少关闭按钮')
    assert.equal(closeButton.props.title, '关闭设置')
    // 并行读取两套设置一次。
    assert.equal(mounted.calls.filter((call) => call.path === '/api/settings' && call.method === 'GET').length, 1)
    assert.equal(mounted.calls.filter((call) => call.path === '/api/app-settings' && call.method === 'GET').length, 1)

    // 2) 切换到「云端算力」Tab：渲染算力来源 / 加速器 / 空闲档位（默认收起自定义数字框）/ HF Token / 折叠高级区。
    tabBtn('compute').props.onClick()
    await refresh()
    const computeText = collectText(tree).join(' | ')
    for (const needle of [
      '当前云端实例已运行，修改将在下次唤醒时生效',
      '算力来源',
      '空闲自动关机',
      '15 分钟',
      '30 分钟',
      '60 分钟',
      '120 分钟',
      '自定义',
      'GPU 加速器',
      '2× Tesla T4（默认推荐）',
      'Tesla P100',
      'HuggingFace Token',
      '清除 Token',
      '来源：宿主配置',
      '高级：预挂载与依赖锁定',
      '保存设置',
      '关闭',
    ]) {
      assert.ok(computeText.includes(needle), `[settings-compute] 缺少文案：${needle}\n实际：${computeText}`)
    }
    assert.equal(findNodes(tree, (node) => node.type === 'textarea').length, 0, '[settings] 高级区应默认折叠')
    assert.equal(findNodes(tree, (node) => node.type === 'input' && node.props?.type === 'number').length, 0, '[settings] 命中快捷档时默认收起自定义分钟框')
    const quickItems = findNodes(
      tree,
      (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-quick-item'),
    )
    assert.deepEqual(quickItems.map((node) => node.props['aria-pressed']), [false, true, false, false, false])
    // 点「自定义」才展开数字框。
    quickItems[4].props.onClick()
    await refresh()
    assert.equal(findNodes(tree, (node) => node.type === 'input' && node.props?.type === 'number').length, 1, '[settings] 点自定义后应展开分钟输入框')

    const saveButton = findNodes(
      tree,
      (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-save'),
    )[0]
    assert.ok(saveButton, '[settings] 缺少保存按钮')
    assert.equal(saveButton.props.disabled, true, '没有改动时保存按钮应禁用')
    assert.equal(saveButton.props['aria-busy'], false)
    const tokenInput = findNodes(
      tree,
      (node) => node.type === 'input' && node.props && node.props.type === 'password',
    )[0]
    assert.ok(tokenInput, '[settings] 缺少 Token 输入框')
    assert.equal(tokenInput.props.value, '')
    // 「已配置」由左侧「来源：宿主配置」承担，输入框只交代留空等于不修改。
    assert.equal(tokenInput.props.placeholder, '留空保持不变')
    assert.equal(tokenInput.props.autoComplete, 'off')
    const radios = findNodes(tree, (node) => node.type === 'input' && node.props && node.props.type === 'radio' && node.props.name === 'ofs-accelerator')
    assert.deepEqual(radios.map((node) => node.props.value), ['NvidiaTeslaT4', 'NvidiaTeslaP100'])
    assert.deepEqual(radios.map((node) => node.props.checked), [true, false])

    // 2.5) 切换到「本机模型」Tab：展示硬件加速状态、目录、按需模型与随包内置引擎。
    tabBtn('local-models').props.onClick()
    await refresh()
    const localModelsText = collectText(tree).join(' | ')
    for (const needle of [
      '推理引擎与硬件加速',
      '本机模型目录',
      '按需下载模型（ONNX）',
      'MobileCLIP-S0',
      '随包内置算子与本地生图规划',
      'SVG 矢量转换（VTracer）',
      '本地扩散生图（Vulkan GGUF）',
    ]) {
      assert.ok(localModelsText.includes(needle), `[settings-local-models] 缺少文案：${needle}\n实际：${localModelsText}`)
    }

    // 3) 切换到「外观与通用」Tab：选完即保存，不渲染底部保存栏。
    tabBtn('appearance').props.onClick()
    await refresh()
    assert.equal(
      findNodes(tree, (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-save')).length,
      0,
      '外观页点选即生效，不应显示保存按钮',
    )
    assertStructure('settings-modal-appearance', tree, {
      required: { 'ofs-settings-option': 5, 'ofs-theme-swatch': 3 },
      forbidden: ['ofs-settings-foot'],
    })

    // 4) 切换到「版本与更新」：当前版本 / 自动检查 / 更新源 / 立即检查，同样不显示底部保存栏。
    tabBtn('update').props.onClick()
    await refresh()
    const updateText = collectText(tree).join(' | ')
    for (const needle of ['当前版本', '自动检查', '更新源', 'GitHub Releases', '自定义镜像', '立即检查']) {
      assert.ok(updateText.includes(needle), `[settings-update] 缺少文案：${needle}\n实际：${updateText}`)
    }
    assert.equal(
      findNodes(tree, (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-save')).length,
      0,
      '更新页切换即保存，不应显示保存按钮',
    )
  } finally {
    mounted.client.unmount()
  }
})
await check('渲染：设置抽屉高级区与行级校验', async () => {
  // 高级区展开：三个多行输入与示例提示；合法内容不出现错误行。
  const valid = await mountSettingsDrawer({ defaultAdvancedOpen: true })
  try {
    const text = collectText(valid.tree).join(' | ')
    for (const needle of [
      '预挂载 Kaggle Dataset',
      '每行一个 owner/dataset，最多 32 行',
      '本地模型目录映射',
      '每行一条 repo=容器路径',
      'repo 是 HuggingFace 模型 ID',
      'pip 依赖约束',
      '每行一条约束，例如 diffusers==0.31.0',
    ]) {
      assert.ok(text.includes(needle), `[settings-advanced] 缺少文案：${needle}`)
    }
    const textareas = findNodes(valid.tree, (node) => node.type === 'textarea')
    assert.equal(textareas.length, 3, '[settings-advanced] 高级区应有三个多行输入')
    assert.deepEqual(textareas.map((node) => node.props.value), [
      'owner/dataset',
      'org/repo=/kaggle/input/repo',
      'diffusers==0.31.0',
    ])
    assertStructure('settings-advanced', valid.tree, {
      required: { 'ofs-settings-advanced': 1, 'ofs-settings-textarea': 3, 'ofs-settings-hint': 3 },
      forbidden: ['ofs-settings-errors', 'ofs-settings-error-item'],
    })
    const saveButton = findNodes(
      valid.tree,
      (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-save'),
    ).at(-1)
    assert.equal(saveButton.props.disabled, true, '高级区合法但没改动时仍禁用保存')
  } finally {
    valid.client.unmount()
  }
  // 非法行：标出第几行、说明原因，并禁止保存。
  const invalid = await mountSettingsDrawer({ defaultAdvancedOpen: true, defaultDraft: { localModelsText: 'owner/repo=/kaggle/input/repo\nbroken-line' } })
  try {
    const text = collectText(invalid.tree).join(' | ')
    assert.ok(text.includes('第 2 行：缺少 =，格式应为 repo=容器路径'), `[settings-advanced] 缺少行级错误：${text}`)
    assert.ok(text.includes('有 1 行需要修正后才能保存'), '[settings-advanced] 缺少修正提示')
    assertStructure('settings-advanced-invalid', invalid.tree, {
      required: { 'ofs-settings-errors': 1, 'ofs-settings-error-item': 1, 'ofs-settings-error': 1 },
      forbidden: [],
    })
    const saveButton = findNodes(
      invalid.tree,
      (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-save'),
    ).at(-1)
    assert.equal(saveButton.props.disabled, true, '存在非法行时必须禁用保存')
  } finally {
    invalid.client.unmount()
  }
})
await check('渲染：设置抽屉保存流程（只提交改动字段）', async () => {
  const savedView = {
    ...settingsView,
    idleTimeoutSec: 3600,
    accelerator: 'NvidiaTeslaP100',
    hasHfToken: false,
    hfTokenSource: 'none',
  }
  const mounted = await mountSettingsDrawer({
    defaultDraft: { idleMinutes: '60', accelerator: 'NvidiaTeslaP100', clearHfToken: true },
    savedView,
  })
  try {
    const text = collectText(mounted.tree).join(' | ')
    assert.ok(text.includes('保存后将清除已配置的 Token'), `[settings-save] 缺少清除提示：${text}`)
    // 草稿改动立刻反映在档位高亮与单选态上。
    const quickItems = findNodes(
      mounted.tree,
      (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-quick-item'),
    )
    assert.deepEqual(quickItems.map((node) => node.props['aria-pressed']), [false, false, true, false, false], '60 分钟档应高亮')
    const radios = findNodes(mounted.tree, (node) => node.type === 'input' && node.props && node.props.type === 'radio' && node.props.name === 'ofs-accelerator')
    assert.deepEqual(radios.map((node) => node.props.checked), [false, true], 'P100 应选中')
    const saveButton = findNodes(
      mounted.tree,
      (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-save'),
    ).at(-1)
    assert.equal(saveButton.props.disabled, false, '有改动时保存按钮应可用')
    saveButton.props.onClick()
    for (let round = 0; round < 6; round += 1) {
      await Promise.resolve()
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    // 运行设置的调用序列：打开时 GET、保存时 POST；/api/app-settings 的并行读取不计入本序列。
    const settingsCalls = mounted.calls.filter((call) => call.path === '/api/settings')
    assert.deepEqual(settingsCalls.map((call) => call.method), ['GET', 'POST'], '打开时 GET、保存时 POST')
    const posted = settingsCalls[1]
    assert.equal(posted.path, '/api/settings')
    assert.deepEqual(posted.body, { idleTimeoutSec: 3600, accelerator: 'NvidiaTeslaP100', clearHfToken: true })
    assert.deepEqual(mounted.toasts, ['运行设置已保存'], '保存成功后应 toast')
  } finally {
    mounted.client.unmount()
  }
  // 另一种改动来源：手输 Token（去首尾空白后提交），不与 clearHfToken 混在一起。
  const tokenMounted = await mountSettingsDrawer({ defaultDraft: { hfToken: ' hf_secret ' } })
  try {
    const saveButton = findNodes(
      tokenMounted.tree,
      (node) => node.type === 'button' && String(node.props?.className).includes('ofs-settings-save'),
    ).at(-1)
    assert.equal(saveButton.props.disabled, false)
    saveButton.props.onClick()
    for (let round = 0; round < 6; round += 1) {
      await Promise.resolve()
      await new Promise((resolvePromise) => setImmediate(resolvePromise))
    }
    const posted = tokenMounted.calls.find((call) => call.method === 'POST' && call.path === '/api/settings')
    assert.ok(posted, '[settings-save] 手输 Token 应提交 POST')
    assert.deepEqual(posted.body, { hfToken: 'hf_secret' })
    assert.equal(Object.prototype.hasOwnProperty.call(posted.body, 'clearHfToken'), false)
  } finally {
    tokenMounted.client.unmount()
  }
})
await check('渲染：设置抽屉读取失败可重试', async () => {
  const client = await createTestClient({
    now: NOW,
    responses: {
      '/api/settings': { ok: false, error: { code: 'internal_error', message: '设置读取失败' } },
      // 全局应用设置正常：本用例只验证运行设置读取失败时的局部失败态，不应被另一区块的错误干扰。
      '/api/app-settings': { ok: true, settings: appSettingsView },
    },
    testBuild: true,
  })
  let tree = null
  try {
    tree = await client.mountRaw(client.components.SettingsDrawer, {
      t: client.internals.i18n.fallbackTranslate('zh'),
      ui: { showToast: () => {} },
      defaultTab: 'compute',
      onClose: () => {},
    })
  } finally {
    client.unmount()
  }
  const text = collectText(tree).join(' | ')
  assert.ok(text.includes('读取运行设置失败'), `[settings-load] 缺少失败提示：${text}`)
  assert.ok(text.includes('本地服务内部错误'), '[settings-load] 应给出可读的错误码文案')
  assert.ok(text.includes('重试'), '[settings-load] 失败态应提供重试按钮')
  assertStructure('settings-load-error', tree, {
    required: { 'ofs-settings': 1, 'ofs-settings-panel': 1, 'ofs-settings-error-state': 1, 'ofs-settings-error': 1 },
    // 运行设置读取失败时不应渲染运行设置表单：用运行设置独有的快捷档 / 高级区开关判断
    //（ofs-settings-form 也被独立客户端设置区块复用，不再作为「运行设置表单」的标志）。
    forbidden: ['ofs-settings-quick', 'ofs-settings-advanced-toggle', 'ofs-settings-loading'],
  })
})
await check('渲染：设置抽屉英文界面', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultAdvancedOpen: true },
    { locale: 'en-US', view: { ...settingsView, effectiveOnNextSession: false } },
  )
  try {
    const text = collectText(mounted.tree).join(' | ')
    for (const needle of [
      'Settings',
      'Assistant',
      'Cloud compute',
      'Appearance',
      'Auto-shutdown when idle',
      '15 min',
      'Custom',
      '2× Tesla T4 (recommended)',
      'Tesla P100',
      'HuggingFace token',
      'Clear token',
      'Advanced: preloads and pinned dependencies',
      'Pre-mounted Kaggle datasets',
      'One repo=container-path per line',
      'pip dependency constraints',
      'Save settings',
      'Close',
    ]) {
      assert.ok(text.includes(needle), `[settings-en] 缺少英文文案：${needle}\n实际：${text}`)
    }
    assert.ok(!text.includes('云端算力'), '[settings-en] 英文界面不应出现中文标题')
    assert.ok(!text.includes('保存设置'), '[settings-en] 英文界面不应出现中文按钮')
    // 已配置 Token 的 placeholder 也走英文字典（placeholder 不进 collectText）。
    const passwordInput = findNodes(
      mounted.tree,
      (node) => node.type === 'input' && node.props && node.props.type === 'password',
    )[0]
    assert.equal(passwordInput.props.placeholder, 'Leave empty to keep it')
  } finally {
    mounted.client.unmount()
  }
})
await check('渲染：gpu / auth / cli 指引卡动作与提示', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh')
    const started = []
    const viewedLogs = []
    const copiedCommands = []
    const copiedLogins = []
    const baseProps = {
      t,
      actions: { resetToSafe: () => {}, retryFocusedJob: () => {} },
      compute: {
        session: null,
        probe: null,
        startSession: () => started.push('start'),
        runProbe: () => started.push('probe'),
        retryHost: () => {},
      },
      ui: {
        openLogs: () => viewedLogs.push(true),
        copyText: () => copiedLogins.push(true),
        copyInstallCommand: () => copiedCommands.push(true),
      },
    }
    // gpu 卡：主操作是外链（账户设置首页，不是 API Token 页），次操作是唤醒，另有两个次级动作。
    const gpuTree = await client.mountRaw(client.components.GuidanceCard, {
      ...baseProps,
      guidance: { kind: 'gpu', detail: '未检测到可用 GPU（当前为 CPU 容器）', dismiss: () => {} },
    })
    const gpuText = collectText(gpuTree).join(' | ')
    for (const needle of [
      '云端没有拿到 GPU',
      '未检测到可用 GPU（当前为 CPU 容器）',
      '手机号验证',
      '打开 Kaggle 账户设置',
      '唤醒云端',
      '查看日志',
      '复制诊断信息',
    ]) {
      assert.ok(gpuText.includes(needle), `[gpu-card] 缺少文案：${needle}`)
    }
    assert.ok(!gpuText.includes('重试一次'), '[gpu-card] 不应给出「重试一次」')
    assertStructure('gpu-card', gpuTree, {
      required: { 'ofs-guidance': 1, 'ofs-guidance-note': 1, 'ofs-guidance-actions': 1 },
      forbidden: ['ofs-guidance-command'],
    })
    const gpuLink = findNodes(gpuTree, (node) => node.type === 'a')[0]
    assert.ok(gpuLink, '[gpu-card] 缺少 Kaggle 账户设置链接')
    assert.equal(gpuLink.props.href, 'https://www.kaggle.com/settings')
    assert.equal(gpuLink.props.target, '_blank')
    assert.match(String(gpuLink.props.rel), /noreferrer/)
    const wakeButton = findNodes(
      gpuTree,
      (node) => node.type === 'button' && collectText(node).join('').includes('唤醒云端'),
    )[0]
    assert.ok(wakeButton, '[gpu-card] 缺少唤醒按钮')
    wakeButton.props.onClick()
    assert.deepEqual(started, ['start'], '[gpu-card] 唤醒按钮应重新启动会话')
    const viewLogsButton = findNodes(
      gpuTree,
      (node) => node.type === 'button' && collectText(node).join('').includes('查看日志'),
    )[0]
    viewLogsButton.props.onClick()
    assert.equal(viewedLogs.length, 1, '[gpu-card] 查看日志应交给 openLogs')
    // auth 卡：给出 CLI 2.x 登录命令（可复制）+ OAuth 凭据位置 + 网页 Token / 旧版兼容位置。
    const authTree = await client.mountRaw(client.components.GuidanceCard, {
      ...baseProps,
      guidance: { kind: 'auth', detail: '', dismiss: () => {} },
    })
    const authText = collectText(authTree).join(' | ')
    for (const needle of [
      'kaggle auth login',
      '%USERPROFILE%\\.kaggle\\credentials.json',
      'refresh_token',
      '%USERPROFILE%\\.kaggle\\access_token',
      '%USERPROFILE%\\.kaggle\\kaggle.json',
      '复制登录命令',
    ]) {
      assert.ok(authText.includes(needle), `[auth-card] 缺少文案：${needle}（实际：${authText}）`)
    }
    const authLink = findNodes(authTree, (node) => node.type === 'a')[0]
    assert.equal(authLink.props.href, 'https://www.kaggle.com/settings/api')
    const copyLoginButton = findNodes(
      authTree,
      (node) => node.type === 'button' && collectText(node).join('').includes('复制登录命令'),
    )[0]
    assert.ok(copyLoginButton, '[auth-card] 缺少复制登录命令按钮')
    copyLoginButton.props.onClick()
    assert.equal(copiedLogins.length, 1, '[auth-card] 复制登录命令应走 ui.copyText')
    // cli 卡：安装命令下给 Windows PATH 提示。
    const cliTree = await client.mountRaw(client.components.GuidanceCard, {
      ...baseProps,
      guidance: { kind: 'cli', detail: '', dismiss: () => {} },
    })
    const cliText = collectText(cliTree).join(' | ')
    assert.ok(cliText.includes('pip install -U kaggle'), '[cli-card] 缺少安装命令')
    assert.ok(cliText.includes('Windows 用户安装后若仍提示找不到命令'), '[cli-card] 缺少 Windows PATH 提示')
    assert.ok(cliText.includes('已加入系统 PATH'), '[cli-card] PATH 提示应说明加入系统 PATH')
    const copyClipboard = findNodes(
      cliTree,
      (node) => node.type === 'button' && collectText(node).join('').includes('复制安装命令'),
    )[0]
    copyClipboard.props.onClick()
    assert.equal(copiedCommands.length, 1, '[cli-card] 复制安装命令应走 ui.copyInstallCommand')
  } finally {
    client.unmount()
  }
})
await check('渲染：queue_timeout 指引卡收敛为「换新实例重排」', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh')
    const calls = []
    const tree = await client.mountRaw(client.components.GuidanceCard, {
      t,
      actions: { resetToSafe: () => {}, retryFocusedJob: () => {} },
      compute: {
        session: {
          state: 'error',
          kernelUrl: 'https://www.kaggle.com/code/tester/imagen-12345678',
          error: { code: 'queue_timeout', message: '等待 GPU 超时（45 分钟），Kernel 仍在队列中（QUEUED）' },
        },
        probe: null,
        startSession: () => calls.push('start'),
        requeueSession: () => calls.push('requeue'),
        runProbe: () => {},
        retryHost: () => {},
      },
      ui: { openLogs: () => {}, copyText: () => {}, copyInstallCommand: () => {} },
      guidance: {
        kind: 'session',
        code: 'queue_timeout',
        detail: '等待 GPU 超时（45 分钟），Kernel 仍在队列中（QUEUED）',
        dismiss: () => {},
      },
    })
    const text = collectText(tree).join(' | ')
    for (const needle of [
      '云端会话没有就绪',
      '换新实例重排',
      '45 分钟仍未拿到 GPU',
      '删除这条排不上的 Kernel',
      '查看日志',
      '关闭',
    ]) {
      assert.ok(text.includes(needle), `[queue-timeout-card] 缺少文案：${needle}（实际：${text}）`)
    }
    // 文案确定化：不再出现「可能仍在队列中」这类不确定表述，也不再提供继续等待 / 去 Kaggle。
    for (const gone of [
      '该 Kernel 可能仍在',
      '继续等待当前队列',
      '前往 Kaggle 查看',
      '强制新建实例',
      '复制诊断信息',
    ]) {
      assert.ok(!text.includes(gone), `[queue-timeout-card] 不应出现：${gone}（实际：${text}）`)
    }
    assert.equal(findNodes(tree, (node) => node.type === 'a').length, 0, '[queue-timeout-card] 不再提供 Kaggle 外链')
    // 动作集合收敛为：主「换新实例重排」+ 「查看日志」+ 「关闭」。
    const buttons = findNodes(tree, (node) => node.type === 'button')
    assert.deepEqual(
      buttons.map((node) => collectText(node).join('')),
      ['换新实例重排', '查看日志', '关闭'],
      '[queue-timeout-card] 动作集合应为换新实例重排 / 查看日志 / 关闭',
    )
    assert.ok(buttons[0].props.className.includes('is-on'), '[queue-timeout-card] 重排应是主操作')
    buttons[0].props.onClick()
    assert.deepEqual(calls, ['requeue'], '[queue-timeout-card] 主操作应调用 requeueSession')
  } finally {
    client.unmount()
  }
})
/**
 * 10 分钟卡住横幅的完整状态：旧快照没有 queuePolicy，靠契约默认值判定卡住；
 * startedAt 与用例里的 NOW 相差 11 分钟。
 */
const stalledQueueState = {
  defaultPreset: 'sdxl-lightning',
  presets: [preset],
  session: {
    state: 'provisioning',
    phase: 'queue',
    startedAt: at(-660),
    presetId: 'sdxl-lightning',
    error: null,
  },
  jobs: [],
  lastJob: null,
}
const mountStalledStudio = async () => {
  const client = await createTestClient({ now: NOW, responses: studioResponses(stalledQueueState, { items: [] }), testBuild: true })
  const tree = await client.mountRaw(client.components.Studio, {})
  return { client, tree }
}
// 关闭（继续等待）只收起卡片：宿主仍返回同一轮卡住的会话时，轮询不会把卡片重新弹出来。
await check('渲染：10 分钟卡住横幅关闭后同一轮不再弹回', async () => {
  const { client, tree } = await mountStalledStudio()
  try {
    const collect = (root) => collectText(root).join(' | ')
    assert.ok(collect(tree).includes('排队超过 10 分钟还没拿到 GPU'), '初始应显示排队卡住横幅')
    const waitButton = findNodes(
      tree,
      (node) => node.type === 'button' && collectText(node).join('') === '继续等待',
    )[0]
    assert.ok(waitButton, '[queue-stalled] 缺少「继续等待」按钮')
    waitButton.props.onClick()
    // 宿主轮询仍返回同一轮卡住的会话（startedAt 未变），卡片不能回来。
    await client.advanceTimers(12000)
    const next = await client.rerenderRaw()
    assert.ok(!collect(next).includes('排队超过 10 分钟还没拿到 GPU'), '[queue-stalled] 关闭后同一轮不应重复弹出')
    assert.equal(findNodes(next, (node) => node.props?.className === 'ofs-queue-notice').length, 0)
  } finally {
    client.unmount()
  }
})
// 主操作「换新实例重排」：发一次 POST /session/start，body 带 forceNew + replace；点击后卡片收起。
await check('渲染：10 分钟卡住横幅换新实例重排请求体与防重入', async () => {
  const { client, tree } = await mountStalledStudio()
  try {
    const requeueButton = findNodes(
      tree,
      (node) => node.type === 'button' && collectText(node).join('') === '换新实例重排',
    )[0]
    assert.ok(requeueButton, '[queue-stalled] 缺少「换新实例重排」按钮')
    // 同一 tick 双击：useSessionControl 的同步判重只允许发一次请求。
    requeueButton.props.onClick()
    requeueButton.props.onClick()
    await client.settle()
    const starts = client.requests.filter((item) => item.path === '/api/session/start')
    assert.equal(starts.length, 1, '[queue-stalled] 重排请求只应发出一次（防重入）')
    assert.equal(starts[0].method, 'POST')
    assert.deepEqual(
      starts[0].body,
      { presetId: 'sdxl-lightning', forceNew: true, replace: true },
      '[queue-stalled] 重排请求体必须是 { presetId, forceNew: true, replace: true }',
    )
    const next = await client.rerenderRaw()
    assert.ok(
      !collectText(next).join(' | ').includes('排队超过 10 分钟还没拿到 GPU'),
      '[queue-stalled] 点击重排后卡片应收起',
    )
  } finally {
    client.unmount()
  }
})
await check('渲染：模型选择卡展开态', async () => {
  const client = await createTestClient({ now: NOW, responses: studioResponses(readyState, { items: [] }), testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const tree = await client.mountRaw(client.components.TopBar, {
    t,
    isEn: false,
    ui: { view: 'studio', setView: () => {}, openLogs: () => {} },
    compute: {
      sessionState: 'ready',
      session: readyState.session,
      quota: readyState.probe.quota,
      presets: [preset, turbo],
      defaultPreset: 'sdxl-lightning',
      busy: '',
      probing: false,
      probe: readyState.probe,
      probeReport: null,
      startSession: () => {},
      stopSession: () => {},
      runProbe: () => {},
      openFolder: () => {},
    },
    form: {
      form: { presetId: 'sdxl-lightning', width: 1024, height: 1024, steps: 4, cfg: 0 },
      patchForm: () => {},
      selectPreset: () => {},
    },
    library: { loadHistory: () => {} },
    defaultModelOpen: true,
  })
  client.unmount()
  const text = collectText(tree).join(' | ')
  for (const needle of [
    '出图模型 · 2',
    '实测稳态耗时',
    'Lightning',
    'Turbo',
    '默认',
    '4 步极速出图，平衡画质与耗时',
    '3.5B + LoRA · 1024px · 4 步',
    '~6.2秒',
    '海报为概念示意，非出图样例；切换会套用推荐尺寸与步数。',
  ]) {
    assert.ok(text.includes(needle), `[model-picker] 缺少文案：${needle}`)
  }
  assertStructure('model-picker', tree, {
    required: { 'ofs-model': 1, 'ofs-model-menu': 1, 'ofs-model-option': 2, 'ofs-model-poster': 2, 'ofs-model-default': 1 },
    forbidden: ['ofs-preset'],
  })
  const options = findNodes(tree, (node) => node.props && node.props.role === 'option')
  assert.equal(options.length, 2, '[model-picker] 应渲染两个模型选项')
  const selected = options.find((node) => node.props['aria-selected'] === 'true')
  assert.ok(selected, '[model-picker] 应有选中项')
  assert.equal(selected.props['aria-selected'], 'true')
  const trigger = findNodes(
    tree,
    (node) => node.type === 'button' && node.props && node.props.className === 'ofs-model',
  )[0]
  assert.ok(trigger, '[model-picker] 缺少触发胶囊')
  assert.equal(trigger.props['aria-expanded'], 'true')
  assert.equal(trigger.props['aria-haspopup'], 'listbox')
  // 组件级：点选回调与中英切换（不依赖浏览器事件，直接调用渲染树上的回调）。
  const pickerClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const calls = { open: [], change: [] }
  const pickerTree = await pickerClient.mountRaw(pickerClient.components.ModelCardPicker, {
    t: pickerClient.internals.i18n.fallbackTranslate('zh'),
    isEn: false,
    presets: [preset, turbo],
    value: 'sdxl-lightning',
    defaultPreset: 'sdxl-lightning',
    open: true,
    onOpenChange: (next) => calls.open.push(next),
    onChange: (next) => calls.change.push(next.id),
  })
  pickerClient.unmount()
  const pickerOptions = findNodes(pickerTree, (node) => node.props && node.props.role === 'option')
  pickerOptions[1].props.onClick()
  assert.deepEqual(calls.change, ['sdxl-turbo'], '[model-picker] 点选应把完整预设交给 onChange')
  assert.deepEqual(calls.open, [false], '[model-picker] 点选后应请求关闭')
  const enClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const enTree = await enClient.mountRaw(enClient.components.ModelCardPicker, {
    t: enClient.internals.i18n.fallbackTranslate('en'),
    isEn: true,
    presets: [preset],
    value: 'sdxl-lightning',
    defaultPreset: 'sdxl-lightning',
    open: true,
    onOpenChange: () => {},
    onChange: () => {},
  })
  enClient.unmount()
  const enText = collectText(enTree).join(' | ')
  assert.ok(enText.includes('4-step fast generation, balanced quality'), '[model-picker] 英文描述应取自 description.en')
  assert.ok(enText.includes('~6.2s'), '[model-picker] 英文耗时单位应为 s')
})
await check('渲染：大图预览 dialog 与图片 alt', async () => {
    const responses = studioResponses(readyState, { items: [historyItem] })
  // 工作台：舞台与胶片条的 alt 优先用提示词，不再回落成文件名。
  let client = await createTestClient({ now: NOW, responses, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  let tree = await client.mountRaw(client.components.Studio, {})
  client.unmount()
  const studioImages = findNodes(tree, (node) => node.type === 'img')
  assert.ok(studioImages.length >= 2, '舞台与胶片条都应渲染图片')
  for (const node of studioImages) {
    assert.ok(typeof node.props.alt === 'string' && node.props.alt.length > 0, '所有 img 都应有非空 alt')
  }
  assert.ok(
    studioImages.some((node) => node.props.alt === '测试用的荷花池塘'),
    'alt 应优先使用提示词',
  )
  // 大图预览：role="dialog" + aria-modal，图片同样带可读 alt。
  client = await createTestClient({ now: NOW, responses, testBuild: true })
  tree = await client.mountRaw(client.components.Stage, {
    t,
    ui: { zoom: true, setZoom: () => {}, copyPath: () => {} },
    compute: { activeJob: null, queued: false },
    form: { useInspiration: () => {} },
    library: {
      selected: { image: historyItem.images[0], item: historyItem },
      isFavorite: () => false,
      toggleFavorite: () => {},
    },
    // 舞台动作坞现在只有「重新生成」；放大层里的重绘入口走 openImageTool。
    actions: { reroll: () => {}, openImageTool: () => {} },
  })
  client.unmount()
  const dialog = findNodes(tree, (node) => node.props && node.props.role === 'dialog')[0]
  assert.ok(dialog, '[stage] 放大层应带 role="dialog"')
  assert.equal(dialog.props['aria-modal'], 'true')
  const lightboxImages = findNodes(tree, (node) => node.type === 'img')
  assert.ok(lightboxImages.length >= 2, '放大层应包含大图')
  for (const node of lightboxImages) {
    assert.ok(typeof node.props.alt === 'string' && node.props.alt.length > 0, '放大层 img 应有非空 alt')
  }
})
// 画廊分页脚：有更早记录时给「加载更多」，取完后给「已加载全部作品」。
await check('渲染：画廊分页底部（加载更多 / 已加载全部）', async () => {
  const mountGallery = async (extra = {}) => {
    const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
    const calls = []
    const tree = await client.mountRaw(client.components.Gallery, {
      t: client.internals.i18n.fallbackTranslate('zh'),
      gallery: [{ image: historyItem.images[0], item: historyItem }],
      now: NOW,
      presets: [preset],
      favorites: [],
      hasMore: true,
      loadingMore: false,
      onLoadMore: () => calls.push('more'),
      onDelete: () => {},
      onExport: () => {},
      onOpen: () => {},
      onRedraw: () => {},
      onZoom: () => {},
      ...extra,
    })
    client.unmount()
    return { tree, calls }
  }
  const more = await mountGallery()
  const moreButton = findNodes(
    more.tree,
    (node) => node.type === 'button' && node.props?.className === 'ofs-chip ofs-gallery-more',
  )
  assert.equal(moreButton.length, 1, 'hasMore=true 时应显示「加载更多」')
  assert.ok(collectText(moreButton[0]).join('').includes('加载更多'))
  moreButton[0].props.onClick()
  assert.deepEqual(more.calls, ['more'], '点击加载更多应交给 useWorkLibrary 的 loadMore')
  const busy = await mountGallery({ loadingMore: true })
  const busyButton = findNodes(
    busy.tree,
    (node) => node.type === 'button' && node.props?.className === 'ofs-chip ofs-gallery-more',
  )[0]
  assert.equal(busyButton.props.disabled, true, '加载中按钮禁用')
  assert.equal(busyButton.props['aria-busy'], 'true')
  const done = await mountGallery({ hasMore: false })
  assert.ok(collectText(done.tree).join(' | ').includes('已加载全部作品'), '没有更多记录时显示全部已加载')
  assert.equal(
    findNodes(done.tree, (node) => node.props?.className === 'ofs-chip ofs-gallery-more').length,
    0,
    '取完后不再显示加载更多按钮',
  )
  assertStructure('gallery-foot-done', done.tree, {
    required: { 'ofs-gallery-foot': 1, 'ofs-gallery-all-loaded': 1 },
    forbidden: ['ofs-gallery-more'],
  })
})
// 工作台画廊视图：首屏 offset=0，点「加载更多」后按已加载条数推进 offset。
await check('渲染：画廊加载更多推进 offset 且不重复请求首页', async () => {
  const secondItem = {
    ...historyItem,
    jobId: 'job-2',
    dir: 'imagen-output/20261109-110000-job-2',
    prompt: '第二张作品',
    images: [image(9)],
  }
  const client = await createTestClient({
    now: NOW,
    responses: {
      '/api/state': readyState,
      '/api/history': {
        items: [historyItem, secondItem],
        limit: LIMITS.history.pageSize,
        offset: 0,
        hasMore: true,
      },
      '/api/library': { favorites: [], deleted: [] },
    },
    testBuild: true,
  })
  const tree = await client.mountRaw(client.components.Studio, { view: 'gallery' })
  const moreButton = findNodes(
    tree,
    (node) => node.type === 'button' && node.props?.className === 'ofs-chip ofs-gallery-more',
  )[0]
  assert.ok(moreButton, 'hasMore=true 时画廊底部应显示加载更多')
  moreButton.props.onClick()
  // loadMore 是异步请求：给微任务与 setImmediate 几轮时间落地。
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve()
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  client.unmount()
  const first = `/api/history?limit=${LIMITS.history.pageSize}&offset=0`
  const next = `/api/history?limit=${LIMITS.history.pageSize}&offset=2`
  assert.equal(client.fetches.filter((item) => item === first).length, 1, '首屏只请求一次 offset=0')
  assert.ok(client.fetches.includes(next), `加载更多应按已加载 2 条推进 offset，实际请求：${client.fetches.join(', ')}`)
})
// 画面设置（0.10.0）：画幅比例 → 分辨率档位（长边）→「自定义宽高」折叠；
// 自定义输入仍走本地草稿 + 失焦提交，宽高互不联动；页脚是张数 + 生成 + 规格摘要。
await check('渲染：画面设置比例 / 档位 / 自定义宽高与页脚规格摘要', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const calls = { translate: 0, tier: [], ratio: [], patch: [], custom: [] }
  const formProps = {
    form: {
      prompt: '雨夜街景',
      negative: 'blurry, my own',
      negativeLayers: { model: '', user: 'blurry, my own' },
      presetId: 'sdxl-lightning',
      width: 1024,
      height: 1024,
      steps: 4,
      cfg: 0,
      seed: '',
      count: 1,
    },
    patchForm: (partial) => calls.patch.push(partial),
    selectPreset: () => {},
    ratioId: '1:1',
    applyRatio: (id) => calls.ratio.push(id),
    sizeTiers: [768, 1024, 1152],
    selectedTier: 1024,
    applyTier: (tier) => calls.tier.push(tier),
    applyCustomSize: (partial) => calls.custom.push(partial),
    applyCfg: () => {},
    resetSeed: () => {},
    negativeActive: false,
    negativeHint: '',
    refineGroups: [],
    refineSource: '',
    enhancing: false,
    enhance: () => {},
    translating: false,
    translate: () => { calls.translate += 1 },
    toggleRefine: () => {},
    useInspiration: () => {},
    englishPromptHint: false,
  }
  const ui = {
    advancedOpen: false,
    setAdvancedOpen: () => {},
    toggleAdvancedOpen: () => {},
    negativeOpen: false,
    setNegativeOpen: () => {},
    panelMode: 'form',
    setPanelMode: () => {},
  }
  const railProps = (props = {}) => ({
    t,
    ui,
    form: formProps,
    actions: { sending: false, generate: () => {} },
    ...props,
  })
  const textOf = (tree) => collectText(tree).join(' | ')
  const widthInputOf = (tree) => findNodes(
    tree,
    (node) => node.type === 'input' && node.props?.['aria-label'] === '宽',
  )[0]
  const heightInputOf = (tree) => findNodes(
    tree,
    (node) => node.type === 'input' && node.props?.['aria-label'] === '高',
  )[0]
  const customToggleOf = (tree) => findNodes(
    tree,
    (node) => node.type === 'button'
      && typeof node.props?.className === 'string'
      && node.props.className.split(' ').includes('ofs-custom-toggle'),
  )[0]
  const tree = await client.mountRaw(client.components.Rail, railProps())
  try {
    let text = textOf(tree)
    assert.ok(text.includes('转为英文'), '提示词区应有「转为英文」按钮')
    assert.ok(text.includes('润色'), '润色按钮仍在，二者并列')
    // 画面设置：画幅比例 → 自定义宽高折叠；标题栏显示实时像素读数。
    // 比例按钮各自带着 1:1 / 16:9 的读数，界面不再单起一行「画幅比例」标签，
    // 分组名以 aria-label 保留给读屏。
    assert.ok(
      findNodes(
        tree,
        (node) => node.props?.role === 'group' && node.props?.['aria-label'] === '画幅比例',
      ).length === 1,
      '画面设置应有画幅比例分组',
    )
    assert.ok(text.includes('1024 × 1024'), '画面设置标题栏应有当前像素读数')
    assert.ok(text.includes('自定义宽高'), '画面设置应有自定义宽高折叠入口')
    assert.ok(!text.includes('分辨率档位'), '不再有分辨率档位行')
    assert.ok(!text.includes('推荐尺寸'), '0.10.0 起不再有方形推荐尺寸行')
    assert.ok(!text.includes('风格'), '参数面板不再有风格预设')
    // 页脚规格摘要：尺寸 · 比例 · 张数。
    assert.ok(text.includes('1024 × 1024 · 1:1 · 1 张'), `页脚应有规格摘要，实际：${text}`)
    // 转英文按钮：点击交给 translate 动作。
    const translateButton = findNodes(
      tree,
      (node) => node.type === 'button'
        && typeof node.props?.className === 'string'
        && node.props.className.split(' ').includes('ofs-translate-action'),
    )[0]
    assert.ok(translateButton, '缺少「转为英文」按钮')
    assert.notEqual(translateButton.props.disabled, true)
    translateButton.props.onClick()
    assert.equal(calls.translate, 1, '点击应调用 translate()')
    // 画幅比例：5 个按钮，当前 1:1 高亮；点击交给 applyRatio。
    const ratioButtons = findNodes(
      tree,
      (node) => node.type === 'button'
        && typeof node.props?.className === 'string'
        && node.props.className.split(' ').includes('ofs-ratio'),
    )
    assert.equal(ratioButtons.length, 5)
    assert.equal(ratioButtons[0].props['aria-pressed'], true, '宽高 1024×1024 时 1:1 高亮')
    ratioButtons[1].props.onClick()
    assert.deepEqual(calls.ratio, ['16:9'], '点击比例应交给 applyRatio')
    // 自定义宽高默认折叠；展开后才渲染输入框。
    const toggle = customToggleOf(tree)
    assert.ok(toggle, '缺少自定义宽高折叠入口')
    assert.equal(toggle.props['aria-expanded'], false, '自定义宽高默认折叠')
    assert.equal(widthInputOf(tree), undefined, '折叠时不渲染宽输入框')
    toggle.props.onClick()
    let expanded = await client.rerenderRaw()
    assert.equal(customToggleOf(expanded).props['aria-expanded'], true)
    assert.ok(widthInputOf(expanded), '展开后渲染宽输入框')
    assert.equal(widthInputOf(expanded).props.value, '1024')
    assert.equal(widthInputOf(expanded).props.type, 'number')
    assert.equal(widthInputOf(expanded).props.min, LIMITS.width.min)
    assert.equal(widthInputOf(expanded).props.max, LIMITS.width.max)
    assert.equal(widthInputOf(expanded).props.step, LIMITS.width.step)
    assert.equal(heightInputOf(expanded).props.max, LIMITS.height.max)
    // 输入过程只落在本地草稿，不写表单；失焦才归一化提交，且宽高互不联动。
    widthInputOf(expanded).props.onChange({ target: { value: '720' } })
    assert.equal(calls.patch.length, 0, '输入过程不应把原始文本写进表单')
    expanded = await client.rerenderRaw()
    assert.equal(widthInputOf(expanded).props.value, '720', '草稿即时反映输入')
    widthInputOf(expanded).props.onBlur()
    assert.deepEqual(calls.custom, [{ width: 720 }], '修改宽只提交宽，高不联动')
    // 清空后失焦：恢复修改前的合法值（1024），既不提交也不跳成 256。
    expanded = await client.rerenderRaw()
    widthInputOf(expanded).props.onChange({ target: { value: '' } })
    expanded = await client.rerenderRaw()
    assert.equal(widthInputOf(expanded).props.value, '', '清空后输入框为空')
    widthInputOf(expanded).props.onBlur()
    assert.equal(calls.custom.length, 1, '空值失焦不应提交表单')
    expanded = await client.rerenderRaw()
    assert.equal(widthInputOf(expanded).props.value, '1024', '恢复到修改前的合法值')
    assert.notEqual(widthInputOf(expanded).props.value, '256', "不能因 Number('') 钳成下限 256")
    // 改高超界按契约上限钳制，非 8 倍数按 step 对齐；宽保持 1024。
    heightInputOf(expanded).props.onChange({ target: { value: '99999' } })
    expanded = await client.rerenderRaw()
    heightInputOf(expanded).props.onBlur()
    assert.deepEqual(calls.custom.at(-1), { height: LIMITS.height.max }, '超界按契约上限钳制')
    expanded = await client.rerenderRaw()
    assert.equal(widthInputOf(expanded).props.value, '1024', '改高后宽仍保持 1024')
    heightInputOf(expanded).props.onChange({ target: { value: '253' } })
    expanded = await client.rerenderRaw()
    heightInputOf(expanded).props.onBlur()
    assert.deepEqual(calls.custom.at(-1), { height: LIMITS.height.min }, '非 8 倍数按 step 对齐')
    // 回车等价失焦，方便「改完直接按 Enter」。
    const heightForEnter = heightInputOf(expanded)
    let blurred = 0
    heightForEnter.props.onKeyDown({ key: 'Enter', currentTarget: { blur: () => { blurred += 1 } } })
    assert.equal(blurred, 1, '回车应提交（等价失焦）')
    // 高级设置默认折叠：不渲染步数输入，折叠态标题右侧给参数读数。
    assert.equal(
      findNodes(expanded, (node) => node.type === 'input' && node.props?.['aria-label'] === '采样步数').length,
      0,
      '高级设置折叠时不应渲染步数输入',
    )
    assert.ok(textOf(expanded).includes('4 步 · CFG 0 · 随机种子'), '折叠态应有参数读数')
    // 翻译中：按钮显示进行中文案并禁用。
    const translatingClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
    const translatingTree = await translatingClient.mountRaw(
      translatingClient.components.Rail,
      {
        t: translatingClient.internals.i18n.fallbackTranslate('zh'),
        ui,
        form: { ...formProps, translating: true },
        actions: { sending: false, generate: () => {} },
      },
    )
    assert.ok(textOf(translatingTree).includes('正在翻译…'), '翻译中按钮显示进行中文案')
    const translatingButton = findNodes(
      translatingTree,
      (node) => node.type === 'button'
        && typeof node.props?.className === 'string'
        && node.props.className.split(' ').includes('ofs-translate-action'),
    )[0]
    assert.equal(translatingButton.props.disabled, true, '翻译中按钮禁用')
    translatingClient.unmount()
  } finally {
    client.unmount()
  }
})
await check('资源层：取消 / 历史分页 / 英译的请求形状', async () => {
  const savedFetch = globalThis.fetch
  const savedDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
    ? globalThis.document
    : undefined
  const savedHasDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  const calls = []
  const startCalls = []
  globalThis.document = { baseURI: 'http://localhost/' }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  try {
    await cancelJobRequest('j_123')
    await fetchHistory()
    await fetchHistory(LIMITS.history.pageSize, LIMITS.history.pageSize)
    await enhancePromptRequest({ prompt: '雨夜街景', presetId: 'sdxl-lightning', locale: 'zh', mode: 'translate' })
    await fetchSettingsRequest()
    await saveSettingsRequest({ idleTimeoutSec: 2700, accelerator: 'NvidiaTeslaP100' })
    await fetchUiStateRequest()
    await saveUiStateRequest({ advancedOpen: true })
    await fetchKaggleLogin()
    await startKaggleLogin()
    await cancelKaggleLogin()
    await submitKaggleLoginCode('  code=abcd-efgh-1234  ')
    // 启动会话：普通启动只带 presetId；换新实例重排额外带 forceNew + replace（旧 Host 忽略未知字段）。
    const startIndex = calls.length
    await startSessionRequest('sdxl-lightning')
    await startSessionRequest('sdxl-lightning', { forceNew: true })
    await startSessionRequest('sdxl-lightning', { forceNew: true, replace: true })
    startCalls.push(...calls.slice(startIndex))
  } finally {
    globalThis.fetch = savedFetch
    if (savedHasDocument) globalThis.document = savedDocument
    else delete globalThis.document
  }
  assert.equal(calls[0].url, 'http://localhost/api/job/cancel', '取消必须走契约 ROUTES.jobCancel')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { id: 'j_123' }, '取消请求体是 { id }')
  assert.equal(calls[1].url, `http://localhost/api/history?limit=${LIMITS.history.pageSize}&offset=0`)
  assert.equal(
    calls[2].url,
    `http://localhost/api/history?limit=${LIMITS.history.pageSize}&offset=${LIMITS.history.pageSize}`,
    '加载更多按 offset 逐页请求',
  )
  const enhance = JSON.parse(calls[3].body)
  assert.equal(enhance.mode, 'translate', '英译请求必须带 mode=translate')
  assert.equal(enhance.prompt, '雨夜街景')
  // 运行设置：GET 与 POST 共用契约里的 /settings 路径，POST 只带部分字段。
  assert.equal(calls[4].url, 'http://localhost/api/settings', '读取设置必须走契约 ROUTES.settings')
  assert.equal(calls[4].method, 'GET')
  assert.equal(calls[5].url, 'http://localhost/api/settings', '保存设置必须走契约 ROUTES.settingsSave')
  assert.equal(calls[5].method, 'POST')
  assert.deepEqual(
    JSON.parse(calls[5].body),
    { idleTimeoutSec: 2700, accelerator: 'NvidiaTeslaP100' },
    '设置请求体是部分字段对象',
  )
  // 界面态：GET 与 POST 共用契约里的 /ui-state 路径，POST 是扁平补丁。
  assert.equal(calls[6].url, 'http://localhost/api/ui-state', '读取界面态必须走契约 ROUTES.uiState')
  assert.equal(calls[6].method, 'GET')
  assert.equal(calls[7].url, 'http://localhost/api/ui-state', '保存界面态必须走契约 ROUTES.uiStateSave')
  assert.equal(calls[7].method, 'POST')
  assert.deepEqual(JSON.parse(calls[7].body), { advancedOpen: true }, '界面态请求体是扁平补丁')
  // Kaggle 登录：GET 与 POST 共用契约里的 /kaggle/login；POST body 严格按 action 形状。
  assert.equal(calls[8].url, 'http://localhost/api/kaggle/login', '读取登录态必须走契约 ROUTES.kaggleLogin')
  assert.equal(calls[8].method, 'GET')
  assert.equal(calls[8].body, null, '读取登录态不应带请求体')
  assert.equal(calls[9].url, 'http://localhost/api/kaggle/login', '发起登录必须走契约 ROUTES.kaggleLoginAction')
  assert.equal(calls[9].method, 'POST')
  assert.deepEqual(JSON.parse(calls[9].body), { action: 'start' })
  assert.deepEqual(JSON.parse(calls[10].body), { action: 'cancel' })
  assert.deepEqual(
    JSON.parse(calls[11].body),
    { action: 'submit-code', code: 'abcd-efgh-1234' },
    '授权码要先去空白与 code= 前缀再提交',
  )
  // 白名单外的动作不发请求。
  const beforeInvalid = calls.length
  const invalidAction = await kaggleLoginAction('delete-account', 'x')
  assert.equal(invalidAction.ok, false)
  assert.equal(calls.length, beforeInvalid, '非法登录动作不应发出请求')
  // 启动会话：普通启动只带 presetId；换新实例重排额外带 forceNew + replace（旧 Host 忽略未知字段）。
  assert.equal(startCalls.length, 3)
  assert.equal(startCalls[0].url, 'http://localhost/api/session/start')
  assert.equal(startCalls[0].method, 'POST')
  assert.deepEqual(JSON.parse(startCalls[0].body), { presetId: 'sdxl-lightning' }, '普通启动只带 presetId')
  assert.deepEqual(JSON.parse(startCalls[1].body), { presetId: 'sdxl-lightning', forceNew: true })
  assert.deepEqual(
    JSON.parse(startCalls[2].body),
    { presetId: 'sdxl-lightning', forceNew: true, replace: true },
    '换新实例重排必须同时带 forceNew 与 replace',
  )
})
// ── 工作台界面态持久化（M1：记住「高级设置」折叠状态） ─────────────
// 域 hook 级：挂载读取一次、切换先本地后保存、失败静默回落默认值。
await check('渲染：高级设置折叠状态读取与保存（useStudioUi）', async () => {
  const mountUi = async (options = {}) => {
    const client = await createTestClient({ now: NOW, responses: options.responses ?? {}, failures: options.failures ?? {}, testBuild: true })
    const React = client.react
    const { useStudioUi } = client.hooks
    const latest = { ui: null }
    function Harness(props) {
      const ui = useStudioUi({ t: props.t, initialView: 'studio', initialPanelMode: 'form' })
      props.latest.ui = ui
      return React.createElement('div', { className: 'ofs-ui-harness' }, String(ui.advancedOpen))
    }
    try {
      await client.mountRaw(Harness, { latest, t: client.internals.i18n.fallbackTranslate('zh') })
      await client.settle()
      return { client, latest }
    } catch (error) {
      client.unmount()
      throw error
    }
  }
  const uiStateRequests = (client, method) => client.requests
    .filter((item) => item.path === '/api/ui-state' && item.method === method)
  // 宿主记录为展开：挂载后直接展开。
  const opened = await mountUi({ responses: { '/api/ui-state': { ok: true, uiState: { advancedOpen: true } } } })
  try {
    assert.equal(opened.latest.ui.advancedOpen, true, '挂载时应读取宿主保存的折叠状态')
    assert.equal(uiStateRequests(opened.client, 'GET').length, 1, '挂载只读取一次界面态')
    // 收起：先更新本地状态，再 fire-and-forget 保存扁平补丁。
    opened.latest.ui.toggleAdvancedOpen()
    await opened.client.settle()
    const collapsedTree = await opened.client.rerender()
    assert.equal(collectText(collapsedTree).join(''), 'false', '切换后本地状态应立刻收起')
    assert.deepEqual(
      uiStateRequests(opened.client, 'POST').map((item) => item.body),
      [{ advancedOpen: false }],
      '收起后应保存扁平补丁',
    )
    // 再展开：保存的补丁跟着变。
    opened.latest.ui.toggleAdvancedOpen()
    await opened.client.settle()
    await opened.client.rerender()
    assert.deepEqual(
      uiStateRequests(opened.client, 'POST').map((item) => item.body),
      [{ advancedOpen: false }, { advancedOpen: true }],
    )
  } finally {
    opened.client.unmount()
  }
  // 读取失败：静默回落默认收起，切换仍然可用并尝试保存。
  const failed = await mountUi({ failures: { '/api/ui-state': 'Failed to fetch' } })
  try {
    assert.equal(failed.latest.ui.advancedOpen, false, '读取失败应按契约默认值收起')
    failed.latest.ui.toggleAdvancedOpen()
    await failed.client.settle()
    await failed.client.rerender()
    assert.equal(failed.latest.ui.advancedOpen, true, '保存失败不影响本地切换')
    assert.deepEqual(
      uiStateRequests(failed.client, 'POST').map((item) => item.body),
      [{ advancedOpen: true }],
      '读取失败后仍应尝试保存',
    )
  } finally {
    failed.client.unmount()
  }
  // 宿主返回未知字段 / 类型错误：只认白名单且类型正确的值。
  const dirty = await mountUi({ responses: { '/api/ui-state': { ok: true, uiState: { advancedOpen: 'yes', mystery: 1 } } } })
  try {
    assert.equal(dirty.latest.ui.advancedOpen, false, '类型不符的界面态应按默认值处理')
  } finally {
    dirty.client.unmount()
  }
})
// 工作台级：Rail 真的按读取到的折叠态渲染，点击后收起并保存。
await check('渲染：工作台按宿主界面态展开高级设置并保存折叠', async () => {
  const responses = {
    '/api/state': readyState,
    '/api/history': { items: [] },
    '/api/library': { favorites: [], deleted: [] },
    '/api/ui-state': { ok: true, uiState: { advancedOpen: true } },
  }
  const client = await createTestClient({ now: NOW, responses, testBuild: true })
  try {
    let tree = await client.mountRaw(client.components.Studio, {})
    const stepsInput = (node) => node.type === 'input' && node.props?.['aria-label'] === '采样步数'
    assert.equal(findNodes(tree, stepsInput).length, 1, '界面态为展开时应渲染高级设置')
    const toggle = findNodes(
      tree,
      (node) => node.type === 'button'
        && String(node.props?.className).includes('ofs-fieldset-chevron')
        && node.props?.['aria-label'] === '高级设置',
    )[0]
    assert.ok(toggle, '缺少高级设置折叠按钮')
    assert.equal(toggle.props['aria-expanded'], true, '展开态按钮应带 aria-expanded=true')
    toggle.props.onClick()
    await client.settle()
    tree = await client.rerender()
    assert.equal(findNodes(tree, stepsInput).length, 0, '收起后不再渲染高级设置')
    assert.deepEqual(
      client.requests
        .filter((item) => item.path === '/api/ui-state' && item.method === 'POST')
        .map((item) => item.body),
      [{ advancedOpen: false }],
      '收起后应保存界面态',
    )
  } finally {
    client.unmount()
  }
  // 读取失败：静默回落默认收起，不弹指引卡。
  const fallback = await createTestClient({
    now: NOW,
        responses: studioResponses(readyState, { items: [] }),
    failures: { '/api/ui-state': 'Failed to fetch' },
    testBuild: true,
  })
  try {
    const tree = await fallback.mountRaw(fallback.components.Studio, {})
    assert.equal(
      findNodes(tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '采样步数').length,
      0,
      '读取失败应按默认值收起',
    )
    assert.ok(
      !collectText(tree).join(' | ').includes('连不上本地服务'),
      '界面态读取失败不应弹指引卡',
    )
  } finally {
    fallback.unmount()
  }
})
// 工作台集成：运行中的任务点取消 → 请求契约里的取消接口并刷新宿主快照。
await check('渲染：工作台点取消按钮请求取消接口', async () => {
  const runningState = {
    ...readyState,
    jobs: [
      {
        id: 'job-cancel',
        status: 'running',
        stageCode: 'running',
        progress: { done: 0, total: 2 },
        createdAt: at(-8),
        startedAt: at(-6),
        params: { prompt: '取消这一张' },
      },
    ],
  }
  const client = await createTestClient({
    now: NOW,
    responses: {
      '/api/state': runningState,
      '/api/history': { items: [], limit: LIMITS.history.pageSize, offset: 0, hasMore: false },
      '/api/library': { favorites: [], deleted: [] },
      '/api/job/cancel': {
        ok: true,
        job: { id: 'job-cancel', status: 'cancelled', cancelRequested: true, progress: null, params: { prompt: '取消这一张' } },
        disposition: 'dequeued',
      },
    },
    testBuild: true,
  })
  const tree = await client.mountRaw(client.components.Studio, {})
  const button = findNodes(
    tree,
    (node) => node.type === 'button' && node.props?.className === 'ofs-ghost-cancel',
  )[0]
  assert.ok(button, '运行中任务应显示取消按钮')
  button.props.onClick()
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve()
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  client.unmount()
  assert.ok(
    client.fetches.includes('/api/job/cancel'),
    `点击取消应请求取消接口，实际请求：${client.fetches.join(', ')}`,
  )
  assert.equal(
    client.fetches.filter((item) => item === '/api/state').length >= 2,
    true,
    '取消成功后应刷新宿主快照',
  )
})

await check('渲染：已关闭的失败指引跨热更新/重载保持屏蔽，且工坊抠图失败不触发工作台弹窗', async () => {
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  }
  const failedJobState = {
    ...readyState,
    lastJob: {
      id: 'job-failed-1',
      tool: 'generate',
      status: 'failed',
      startedAt: at(-30),
      finishedAt: at(-20),
      params: { prompt: '失败的画面' },
      error: { code: 'generation_failed', message: '远端生成失败' },
    },
  }
  const firstClient = await createTestClient({
    now: NOW,
    responses: studioResponses(failedJobState, { items: [] }),
    sessionStorage: storage,
    testBuild: true,
  })
  try {
    let tree = await firstClient.mountRaw(firstClient.components.Studio, {})
    assert.equal(countByClass(tree, 'ofs-toast--notice'), 1, '首次失败应弹出错误通知')
    const closeBtn = findNodes(
      tree,
      (node) => node.type === 'button' && collectText(node).join('') === '关闭',
    )[0]
    assert.ok(closeBtn, '失败通知应提供关闭按钮')
    closeBtn.props.onClick()
    tree = await firstClient.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-toast--notice'), 0, '点击关闭后当前页面应立刻收起通知')
  } finally {
    firstClient.unmount()
  }

  // 模拟热更新 / 页面重挂载，后端 /api/state 仍保留同一条历史失败任务：不应再次弹窗。
  const reloadedClient = await createTestClient({
    now: NOW,
    responses: studioResponses(failedJobState, { items: [] }),
    sessionStorage: storage,
    testBuild: true,
  })
  try {
    const tree = await reloadedClient.mountRaw(reloadedClient.components.Studio, {})
    assert.equal(countByClass(tree, 'ofs-toast--notice'), 0, '热更新/重载后已关闭的同一历史失败不得再弹出')
    assert.equal(countByClass(tree, 'ofs-pl-node'), 0, '流水线失败条应保持收起')
  } finally {
    reloadedClient.unmount()
  }

  // 新的任务 id 即使错误码与文案相同，也必须正常弹出。
  const nextJobState = {
    ...readyState,
    lastJob: {
      ...failedJobState.lastJob,
      id: 'job-failed-2',
    },
  }
  const nextJobClient = await createTestClient({
    now: NOW,
    responses: studioResponses(nextJobState, { items: [] }),
    sessionStorage: storage,
    testBuild: true,
  })
  try {
    const tree = await nextJobClient.mountRaw(nextJobClient.components.Studio, {})
    assert.equal(countByClass(tree, 'ofs-toast--notice'), 1, '新任务失败时不应被旧关闭记录屏蔽')
  } finally {
    nextJobClient.unmount()
  }

  // 工坊抠图（remove-bg）失败由 Workshop 内部状态承接，不应触发 Studio 全局失败弹窗与红条。
  const cutoutFailedState = {
    ...readyState,
    lastJob: {
      id: 'job-cutout-failed',
      tool: 'remove-bg',
      status: 'failed',
      startedAt: at(-30),
      finishedAt: at(-20),
      params: { prompt: '', reference: { sourcePath: 'outputs/a/01.png' } },
      error: { code: 'generation_failed', message: '抠图模型推理失败' },
    },
  }
  const cutoutClient = await createTestClient({
    now: NOW,
    responses: studioResponses(cutoutFailedState, { items: [] }),
    testBuild: true,
  })
  try {
    const tree = await cutoutClient.mountRaw(cutoutClient.components.Studio, {})
    assert.equal(countByClass(tree, 'ofs-toast--notice'), 0, '工坊抠图失败不应在 Studio 全局弹窗')
    assert.equal(countByClass(tree, 'ofs-pl-node'), 0, '工坊抠图失败不应留在顶部流水线红条')
  } finally {
    cutoutClient.unmount()
  }
})

await check('渲染：顶栏独立更新入口与新版本弹层', async () => {
  const updateState = {
    mode: 'readonly',
    form: 'portable',
    canAutoUpdate: false,
    current: '0.11.0',
    latest: '0.12.0',
    hasUpdate: true,
    status: 'available',
    releaseUrl: 'https://github.com/nanxfu/aigc-studio/releases/tag/v0.12.0',
    checkedAt: '2026-01-01T00:00:00.000Z',
  }
  const { tree } = await mountTopBarExpanded(idleShutdownSession, {}, { updateState, defaultUpdateOpen: true })
  const plain = collectText(tree).join('')
  assert.ok(plain.includes('新版本 v0.12.0 可用（当前 v0.11.0）'), `[update] 缺少版本提示：${plain}`)
  assert.ok(plain.includes('打开发布页'), `[update] 缺少发布页动作：${plain}`)
  assert.equal(countByClass(tree, 'ofs-update-dot'), 1, '独立入口上应有版本红点')
  assert.equal(countByClass(tree, 'ofs-update-popover'), 1, '应渲染独立更新弹层')
  // 只读形态要说明为什么不能应用内更新。
  assert.ok(plain.includes('便携版不支持应用内更新'), `[update] 缺少只读说明：${plain}`)
})

await check('渲染：没有新版本时不出现红点与更新弹层', async () => {
  const { tree } = await mountTopBarExpanded(idleShutdownSession)
  assert.equal(countByClass(tree, 'ofs-update-dot'), 0, '无更新时不应出现红点')
  assert.equal(countByClass(tree, 'ofs-update-popover'), 0, '无更新时不应展开弹层')
})
await check('渲染：顶栏可视化升级（极简胶囊、弹层圆形额度仪表、空闲预警、仪表卡与模型缩略图）', async () => {
  const warnCompute = {
    provider: 'kaggle',
    quota: { usedHours: 27, totalHours: 30 },
    // probe 用宿主真实形状：quota 是对象且 available 才算出「额度可读」。
    probe: {
      ok: true,
      cli: { present: true, version: '1.6.17' },
      quota: { available: true, usedHours: 27, totalHours: 30 },
      auth: { ok: true },
      notes: ['kaggle CLI 1.6.17'],
    },
  }
  const nearSleepSession = {
    ...idleShutdownSession,
    provider: 'kaggle',
    device: 'NVIDIA L4',
    tunnelProvider: 'cloudflare',
    idleSeconds: 24 * 60,
    idleTimeoutSec: 30 * 60,
  }
  const mounted = await mountTopBarExpanded(nearSleepSession, warnCompute)
  try {
    assertStructure('topbar-visual-dashboard', mounted.tree, {
      required: {
        // 胶囊里 2 处来源图标（胶囊 + 弹层标题），弹层只留 1 个额度读数与 1 个主动作。
        'ofs-compute-provider': 2,
        'ofs-compute-idle-alert': 1,
        'ofs-compute-popover': 1,
        'ofs-compute-meta': 1,
        'ofs-quota-panel': 1,
        'ofs-quota-ring': 1,
        'ofs-meter': 1,
        'ofs-compute-check': 1,
        'ofs-check-row': 1,
        'ofs-compute-actions': 1,
        'ofs-popover-action': 1,
        'ofs-model-thumb': 1,
      },
      forbidden: ['ofs-compute-pill-meter', 'ofs-health-card', 'ofs-popover-btn-grid', 'ofs-spec-chip'],
      forbidden: ['ofs-compute-pill-meter'],
    })
    const rings = findNodes(
      mounted.tree,
      (node) => typeof node.props?.className === 'string'
        && node.props.className.split(/\s+/).includes('ofs-quota-ring'),
    )
    assert.ok(rings[0].props.className.includes('is-warn'), '剩余配额 <=15% 时圆形仪表环应亮起警告态')
    assert.ok(collectText(mounted.tree).join('').includes('3h剩余'), '圆形仪表中心应显示 Kaggle 剩余小时数')
    const idleAlerts = findNodes(
      mounted.tree,
      (node) => typeof node.props?.className === 'string'
        && node.props.className.split(/\s+/).includes('ofs-compute-idle-alert'),
    )
    assert.ok(idleAlerts[0].props.className.includes('is-warn'), '空闲 >=70% 时胶囊应亮起休眠预警图标')
  } finally {
    mounted.client.unmount()
  }

  // Colab 未唤醒状态（session 为空）：只要已授权并拿到 colabUsage，弹层即可直接展示 CCU 余额位与预计可用时长。
  const colabIdleMounted = await mountTopBarExpanded(null, {
    sessionState: 'absent',
    provider: 'colab',
    colabAuth: { authorized: true, email: 'creator@example.com' },
    colabUsage: { balance: 42.5, rate: 2.5, assignments: 0 },
  })
  try {
    assert.equal(countByClass(colabIdleMounted.tree, 'ofs-compute-idle-alert'), 0, '未唤醒不应出现休眠预警')
    // CCU 没有总量可画成分数：用 56px 读数位，不画可能被误读成「剩余百分比」的圆环。
    assert.equal(countByClass(colabIdleMounted.tree, 'ofs-quota-slot'), 1, '未唤醒也应展示 Colab CCU 读数位')
    assert.equal(countByClass(colabIdleMounted.tree, 'ofs-quota-ring'), 0, 'Colab 不应画没有分母的圆环')
    const colabText = collectText(colabIdleMounted.tree).join(' | ')
    assert.ok(colabText.includes('42.5') && colabText.includes('CCU'), `未唤醒应展示 CCU 余额，实际：${colabText}`)
    assert.ok(colabText.includes('耗速 2.50/h') && colabText.includes('约可用 17.0 小时'), `应展示耗速与预计可用时长，实际：${colabText}`)
    assert.ok(colabText.includes('creator@example.com'), '账号卡应展示已授权 Colab 邮箱')
  } finally {
    colabIdleMounted.client.unmount()
  }

  // Colab 低余额（<15 CCU）：读数位数字亮起预警色。
  const colabLowMounted = await mountTopBarExpanded(null, {
    sessionState: 'absent',
    provider: 'colab',
    colabAuth: { authorized: true, email: 'creator@example.com' },
    colabUsage: { balance: 10.0, rate: 1.5, assignments: 0 },
  })
  try {
    const lowSlots = findNodes(
      colabLowMounted.tree,
      (node) => typeof node.props?.className === 'string'
        && node.props.className.split(/\s+/).includes('ofs-quota-slot'),
    )
    assert.ok(lowSlots[0].props.className.includes('is-warn'), 'Colab 余额 <15 CCU 时应亮起预警色')
  } finally {
    colabLowMounted.client.unmount()
  }
})
// ── 阶段十五 Phase C2：原生参考图槽接入整页工作台 ──────────────────────────
await check('渲染：参考生图模型下的左栏参考图槽（整页工作台）', async () => {
  // 首期唯一支持原生参考生图的模型：左栏应在提示词与画面设置之间多出参考图小节。
  const klein = {
    ...preset,
    id: 'flux2-klein-4b',
    label: 'FLUX.2 Klein 4B',
    supportsReference: true,
    supportsImg2Img: false,
    supportsNegative: false,
    cfg: 1,
    negativeHint: '',
  }
  const client = await createTestClient({
    now: NOW,
    responses: studioResponses(
      { ...readyState, defaultPreset: klein.id, presets: [klein] },
      { items: [historyItem] },
    ),
    testBuild: true,
  })
  try {
    const tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'work' })
    assert.equal(countByClass(tree, 'ofs-ref-zone'), 1, '支持参考的模型应渲染参考图小节')
    const text = collectText(tree).join(' | ')
    // 空态是两个同尺寸入口：本地选择（tip 写明上限）+ 从作品选择。
    const entries = findNodes(
      tree,
      (node) => typeof node.props?.className === 'string'
        && node.props.className.split(/\s+/).includes('ofs-ref-entry'),
    )
    assert.equal(entries.length, 2, `空态应给出两个入口：${text}`)
    assert.equal(entries[0].props.title, '添加参考图（最多 2 张）', '本地选择入口的 tip 写明上限')
    assert.ok(text.includes('选择图片') && text.includes('从作品选择'), `两个入口都要有可见标签：${text}`)
    assert.ok(!text.includes('参考图是弱条件'), '参考图小节不再常驻弱条件说明，只留槽位本身')
    // 动作坞创作复用组包含「设为参考图」；页脚仍只有一个生成按钮。
    const dock = findNodes(tree, (node) => node.props && node.props.className === 'ofs-dock')[0]
    assert.ok(dock, '作品分支应有动作坞')
    assert.ok(collectText(dock).join(' | ').includes('设为参考图'), '动作坞应有「设为参考图」')
    assert.equal(countByClass(tree, 'ofs-generate'), 1, '生成按钮仍只有页脚一个')
  } finally {
    client.unmount()
  }

  // 换成不支持参考的模型：同一份工作台状态不出现参考图小节。
  const plain = await createTestClient({
    now: NOW,
    responses: studioResponses(readyState, { items: [historyItem] }),
    testBuild: true,
  })
  try {
    const tree = await plain.mountRaw(plain.components.Studio, { workspaceMode: 'work' })
    assert.equal(countByClass(tree, 'ofs-ref-zone'), 0, '不支持参考的模型不渲染参考图小节')
  } finally {
    plain.unmount()
  }
})
// ── 独立客户端 Phase 1：工作区热切换重置 / 重载 ─────────────────────────────
// /state.workspace.current 变化 = 数据根变了：旧工作区的历史 / 收藏 / 选中 / 版本树 / 草稿态
// 必须整体作废并从第 0 页重载新工作区数据；旧工作区的图片不能继续挂在舞台 / 作品条 / 参考槽上
// （新工作区里这些路径解析不到，会变成裂图）。
await check('渲染：工作区切换后重置旧状态并重载新工作区历史与收藏', async () => {
  const workspaceA = {
    current: 'D:/AI/workspaces/alpha',
    recent: ['D:/AI/workspaces/alpha'],
    switchable: true,
  }
  const workspaceB = {
    current: 'D:/AI/workspaces/beta',
    recent: ['D:/AI/workspaces/beta', 'D:/AI/workspaces/alpha'],
    switchable: true,
  }
  const oldImage = {
    ...image(21),
    path: 'imagen-output/job-a/21.png',
    file: '21.png',
    url: '/api/file?path=imagen-output%2Fjob-a%2F21.png',
  }
  const newImage1 = {
    ...image(31),
    path: 'outputs/job-b/31.png',
    file: '31.png',
    url: '/api/file?path=outputs%2Fjob-b%2F31.png',
  }
  const newImage2 = {
    ...image(32),
    path: 'outputs/job-b/32.png',
    file: '32.png',
    url: '/api/file?path=outputs%2Fjob-b%2F32.png',
  }
  const oldItem = {
    jobId: 'job-a',
    dir: 'imagen-output/job-a',
    prompt: '旧工作区的荷花',
    presetId: 'sdxl-lightning',
    finishedAt: at(-120),
    images: [oldImage],
  }
  const newItem = {
    jobId: 'job-b',
    dir: 'outputs/job-b',
    prompt: '新工作区的雪山',
    presetId: 'sdxl-lightning',
    finishedAt: at(-60),
    images: [newImage1, newImage2],
  }
  const responses = studioResponses({ ...readyState, workspace: workspaceA }, { items: [oldItem] })
  responses['/api/library'] = { favorites: [oldImage.path], deleted: [] }
  const client = await createTestClient({ now: NOW, responses, testBuild: true })
  try {
    const React = client.react
    const latest = {}
    /** 把 useStudio 的领域对象直接交给舞台：断言「旧图不再渲染」要看真实渲染树。 */
    function Harness() {
      const studio = client.hooks.useStudio({
        t: client.internals.i18n.fallbackTranslate('zh'),
        workspaceMode: 'work',
      })
      latest.studio = studio
      return React.createElement('div', { className: 'ofs-workspace-harness' },
        React.createElement(client.components.Stage, studio))
    }
    const countRequests = (path, method = 'GET') => client.requests
      .filter((item) => item.path === path && item.method === method).length

    await client.mountRaw(Harness, {})
    await client.settle()
    await client.rerenderRaw()
    await client.settle()
    let tree = await client.rerenderRaw()
    // 初始工作区 A：历史 / 收藏 / 舞台都是 A 的数据。
    assert.equal(latest.studio.compute.workspace.current, workspaceA.current, '初始工作区应为 A')
    assert.deepEqual(latest.studio.library.gallery.map((entry) => entry.image.path), [oldImage.path])
    assert.deepEqual(latest.studio.library.favorites, [oldImage.path])
    assert.equal(countByClass(tree, 'ofs-print'), 1, 'A 的选中图应在舞台上')
    assert.ok(
      findNodes(tree, (node) => node.type === 'img' && node.props.src === oldImage.url).length > 0,
      'A 的图片地址应出现在舞台上',
    )

    // 在 A 里留下「按旧工作区路径索引」的编辑上下文：回填作品 → 改提示词（进草稿槽）→
    // 挂参考图 → 给对话线程加纯文字消息与带旧结果图的任务气泡。
    latest.studio.actions.previewWork({ image: oldImage, item: oldItem })
    await client.rerenderRaw()
    latest.studio.form.patchForm({ prompt: 'A 的未提交草稿' })
    await client.rerenderRaw()
    latest.studio.form.addReference(oldImage)
    await client.rerenderRaw()
    latest.studio.chat.pushMessages([
      { role: 'user', text: '帮我想一个雨夜街景的描述' },
      { role: 'assistant', kind: 'job', jobId: 'job-a', images: [oldImage] },
    ])
    await client.rerenderRaw()
    // 舞台图片工具的未提交编辑草稿：同样以旧工作区作品路径为键。
    latest.studio.imageTool.patchDraft({
      toolId: 'inpaint',
      target: { path: oldImage.path, url: oldImage.url, width: 1024, height: 1024, prompt: '旧工作区的荷花' },
      prompt: 'A 的涂抹草稿',
      presetId: 'sdxl-lightning',
    })
    await client.rerenderRaw()
    assert.equal(Object.keys(latest.studio.form.workFormDrafts).length, 1, 'A 的未提交修改应进草稿槽')
    assert.equal(latest.studio.form.form.references.length, 1, 'A 的参考图应进槽位')
    assert.equal(Object.keys(latest.studio.imageTool.workDrafts).length, 1, 'A 的图片工具草稿应进 workDrafts')

    const historyBefore = countRequests('/api/history')
    const libraryBefore = countRequests('/api/library')
    // 切换工作区：/state.workspace.current 变成 B，历史 / 收藏换成 B 的数据；
    // 顶栏切换成功后调用的就是 compute.refreshState()（POST /api/workspace → 刷新 /state）。
    responses['/api/state'] = { ...readyState, workspace: workspaceB }
    responses['/api/history'] = { items: [newItem] }
    responses['/api/library'] = { favorites: [newImage2.path], deleted: [] }
    latest.studio.compute.refreshState()
    await client.settle()
    await client.rerenderRaw()
    await client.settle()
    tree = await client.rerenderRaw()

    assert.equal(latest.studio.compute.workspace.current, workspaceB.current, '宿主快照应切换到 B')
    assert.ok(countRequests('/api/history') > historyBefore, '切换到新工作区后应重新请求 /history')
    assert.ok(countRequests('/api/library') > libraryBefore, '切换到新工作区后应重新请求 /library')

    // 作品库：历史 / 选中 / 版本树 / 收藏全部换成 B。
    const library = latest.studio.library
    assert.equal(library.selectedPath, '', '旧工作区的选中路径应清空')
    assert.equal(library.selected, null, '旧工作区的图片不能再作为舞台目标')
    assert.equal(library.workspaceMode, 'new_draft', '新工作区从新建画布起步')
    assert.equal(library.newDraftExplicit, false, '新建草稿标记应复位')
    assert.equal(library.newDraftPending, false, '在途新建绘图标记应复位')
    assert.deepEqual(
      library.gallery.map((entry) => entry.image.path),
      [newImage1.path, newImage2.path],
      '作品列表应换成新工作区历史',
    )
    assert.deepEqual(library.items.map((item) => item.jobId), ['job-b'], '旧工作区历史条目不能残留')
    assert.deepEqual(
      library.lineage.roots.map((root) => root.path).sort(),
      [newImage1.path, newImage2.path].sort(),
      '版本树应按新工作区历史重建',
    )
    assert.deepEqual(library.favorites, [newImage2.path], '收藏列表应换成新工作区数据')

    // 组合层（M2.7）：对话历史按工作区隔离，切到 B 载入 B 自己的线程（没有历史时为空），
    // 不把 A 的消息「带过去」——旧工作区的对话可能讨论的是另一批作品。
    assert.equal(latest.studio.form.form.references.length, 0, '参考图槽里的旧工作区路径应清空')
    assert.equal(latest.studio.form.form.prompt, 'A 的未提交草稿', '未提交的纯文本提示词应保留，不误伤用户输入')
    assert.equal(latest.studio.form.origin, null, '来源作品引用应清空')
    assert.deepEqual(latest.studio.form.workFormDrafts, {}, '按旧工作区作品路径索引的草稿槽应清空')
    assert.deepEqual(latest.studio.imageTool.workDrafts, {}, '图片工具的旧工作区草稿应清空')
    assert.equal(latest.studio.imageTool.target, null, '舞台工具的底图应清空')
    assert.equal(latest.studio.chat.messages.length, 0, '切到无历史的新工作区时线程应为空，不串旧工作区记录')

    // 顶栏（M1.5）：独立常驻「设置」按钮直接可用，不藏在算力下拉框里。
    const topBarTree = await client.mountRaw(client.components.TopBar, {
      t: latest.studio.t,
      isEn: false,
      ui: { ...latest.studio.ui, openSettings: () => {} },
      compute: latest.studio.compute,
      form: latest.studio.form,
      library: latest.studio.library,
    })
    assert.equal(countByClass(topBarTree, 'ofs-topbar-settings'), 1, '顶栏右侧应有独立常驻的设置齿轮按钮')

    // 渲染层：舞台切到新建画布取景框，旧工作区图片不再出现（否则 /api/file 在新工作区 404 裂图）。
    assert.equal(countByClass(tree, 'ofs-figure--draft'), 1, '舞台应切到新建画布取景框')
    const imgSources = findNodes(tree, (node) => node.type === 'img').map((node) => node.props.src)
    assert.ok(!imgSources.includes(oldImage.url), '旧工作区的图片不能继续渲染')
  } finally {
    client.unmount()
  }
})
await check('渲染：Provider 模糊搜索、折叠端点与模型自动获取（Phase A）', async () => {
  const mounted = await mountSettingsDrawer({}, {
    models: [
      { id: 'kimi-k2.6', name: 'Kimi K2.6', reasoning: false, vision: false },
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', reasoning: true, vision: false },
    ],
    modelsSource: 'remote',
  })
  let tree = mounted.tree
  const refresh = async () => {
    tree = await mounted.client.rerenderRaw()
    return tree
  }
  const byClass = (token) => findNodes(
    tree,
    (node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(token),
  )
  const combobox = (label) => findNodes(
    tree,
    (node) => node.type === 'input' && node.props && node.props.role === 'combobox' && node.props['aria-label'] === label,
  )[0]
  try {
    // 1) 聚焦服务商输入框：展开分组列表（11 家，含国产直连分组）。
    const providerInput = combobox('服务商')
    assert.ok(providerInput, '[provider] 缺少可搜索的服务商输入框')
    assert.equal(providerInput.props.value, 'OpenAI', '未展开时显示当前服务商展示名')
    providerInput.props.onFocus()
    await refresh()
    let items = findNodes(tree, (node) => node.props && typeof node.props['data-provider-id'] === 'string')
    assert.equal(items.length, 11, '[provider] 应列出全部 11 家服务商')
    assert.ok(byClass('ofs-provider-icon').length >= 12, '[provider] 每个服务商选项与输入栏均应带品牌图标')
    assert.ok(collectText(tree).join(' | ').includes('国产直连'), '[provider] 应有分组标题')

    // 2) 输入 kimi：模糊匹配到 Moonshot（别名 kimi），其它项消失。
    combobox('服务商').props.onChange({ target: { value: 'kimi' } })
    await refresh()
    items = findNodes(tree, (node) => node.props && typeof node.props['data-provider-id'] === 'string')
    assert.deepEqual(items.map((node) => node.props['data-provider-id']), ['moonshot'])

    // 3) 选中 Moonshot：端点与模型自动切到该厂商默认值，端点以小字展示。
    items[0].props.onMouseDown({ preventDefault: () => {} })
    await refresh()
    assert.equal(combobox('服务商').props.value, 'Kimi（Moonshot）')
    assert.equal(combobox('模型').props.value, 'kimi-k2-turbo-preview', '切换服务商应带出推荐模型')
    assert.ok(collectText(tree).join(' | ').includes('https://api.moonshot.cn/v1'), '标准预设默认只展示端点')

    // 4) 获取模型：POST /api/llm/models 只带 provider（Key 留空由 Host 复用已保存值）。
    const fetchButton = byClass('ofs-settings-fetch')[0]
    assert.ok(fetchButton, '[models] 缺少「获取模型」按钮')
    fetchButton.props.onClick()
    await mounted.client.settle()
    await refresh()
    const modelCall = mounted.calls.filter((call) => call.path === '/api/llm/models' && call.method === 'POST').at(-1)
    assert.ok(modelCall, '[models] 应请求 POST /api/llm/models')
    assert.equal(modelCall.body.provider, 'moonshot')
    assert.equal(Object.prototype.hasOwnProperty.call(modelCall.body, 'apiKey'), false, '未输入新 Key 时不带 apiKey')

    // 5) 模型下拉：可搜索、可点选，选中后回填输入框。
    combobox('模型').props.onFocus()
    await refresh()
    const modelItems = findNodes(tree, (node) => node.props && typeof node.props['data-model-id'] === 'string')
    assert.deepEqual(modelItems.map((node) => node.props['data-model-id']), ['kimi-k2.6', 'kimi-k3.1-pro'])
    assert.ok(collectText(tree).join(' | ').includes('推理'), '推理模型应带能力标签')
    modelItems[0].props.onMouseDown({ preventDefault: () => {} })
    await refresh()
    assert.equal(combobox('模型').props.value, 'kimi-k2.6')

    // 6) 保存：只提交变化字段（provider / baseUrl 清空 / model），不重复提交 Key。
    // 统一底栏只有一个保存按钮，不存在双保存按钮打架。
    const saveButtons = byClass('ofs-settings-save')
    assert.equal(saveButtons.length, 1, '[save] 当前页只应有唯一的保存按钮')
    const saveButton = saveButtons[0]
    assert.equal(saveButton.props.disabled, false, '[save] 有改动时保存按钮应可用')
    saveButton.props.onClick()
    await mounted.client.settle()
    const saved = mounted.calls.filter((call) => call.path === '/api/app-settings' && call.method === 'POST').at(-1)
    assert.ok(saved, '[save] 应提交 POST /api/app-settings')
    assert.deepEqual(saved.body, { llm: { provider: 'moonshot', baseUrl: '', model: 'kimi-k2.6' } })
  } finally {
    mounted.client.unmount()
  }
})
await check('渲染：版本与更新切换自定义镜像不死锁并提交完整补丁', async () => {
  const mounted = await mountSettingsDrawer()
  let tree = mounted.tree
  const refresh = async () => {
    tree = await mounted.client.rerenderRaw()
    return tree
  }
  const tabBtn = (id) => findNodes(
    tree,
    (node) => node.type === 'button' && node.props && node.props['data-settings-tab'] === id,
  )[0]
  try {
    tabBtn('update').props.onClick()
    await refresh()
    assert.equal(
      findNodes(tree, (node) => node.type === 'input' && node.props?.type === 'url').length,
      0,
      '默认 GitHub 源时不展示镜像地址输入框',
    )
    const customRadio = findNodes(
      tree,
      (node) => node.type === 'input' && node.props?.name === 'ofs-update-source' && node.props?.value === 'custom',
    )[0]
    assert.ok(customRadio, '缺少自定义镜像单选框')
    customRadio.props.onChange()
    await refresh()
    // 镜像为空时不发请求（防 400 死锁），而是先展开输入框。
    const postCountBeforeFill = mounted.calls.filter((call) => call.path === '/api/app-settings' && call.method === 'POST').length
    assert.equal(postCountBeforeFill, 0, '切到自定义且镜像为空时不应先发失败请求')
    const urlInput = findNodes(tree, (node) => node.type === 'input' && node.props?.type === 'url')[0]
    assert.ok(urlInput, '点击自定义镜像后应立即展开 URL 输入框')

    urlInput.props.onChange({ target: { value: 'https://mirror.example/aigc' } })
    await refresh()
    findNodes(tree, (node) => node.type === 'input' && node.props?.type === 'url')[0].props.onBlur()
    await mounted.client.settle()
    const saved = mounted.calls.filter((call) => call.path === '/api/app-settings' && call.method === 'POST').at(-1)
    assert.ok(saved, '填写镜像地址失焦后应提交 POST /api/app-settings')
    assert.deepEqual(saved.body, {
      update: { updateSource: 'custom', updateMirrorUrl: 'https://mirror.example/aigc' },
    })
  } finally {
    mounted.client.unmount()
  }
})
summary()