/**
 * 客户端「资产工坊」（M4.2a / M4.2b）渲染测试。
 *
 * 覆盖：
 *  1. 工坊页结构：六工具 / 侧栏 / 画布 / 参数 / 动作区 / PBR 通道条；
 *  2. 顶栏三段式导航：创作（保留下拉）/ 工坊 / 作品库，点击后的 setView 与创作类型切换；
 *  3. 舞台动作坞新增资产工坊组与两个按钮的回调绑定；
 *  4. Stage 中图片作品有资产工坊组、视频作品不渲染动作坞（保持既有行为）；
 *  5. 保存 / 矢量化 / GPU 后处理请求体形状（按 Host 契约断言）。
 *
 * 运行：node test/check-client-workshop.mjs（并发开发时设置 OFS_TEST_BUNDLE）
 */

import assert from 'node:assert/strict'

import { WORKSHOP } from '../shared/contract.js'
import { createCheckRunner } from './helpers/check.mjs'
import {
  NOW,
  image,
  historyItem,
  preset,
  readyState,
  studioResponses,
} from './helpers/client-fixtures.mjs'
import {
  assertStructure,
  buttonByText,
  collectText,
  countByClass,
  createTestClient,
  findNodes,
  nodesByClass,
} from './helpers/render.mjs'

const { check, summary } = createCheckRunner()

/** 工坊页需要的界面态替身：setView / toast 记录下来供断言。 */
function createUi() {
  const state = { views: [], toasts: [], zoom: false, compareOpen: false }
  return {
    state,
    ui: {
      view: 'workshop',
      setView: (view) => state.views.push(view),
      setZoom: (value) => { state.zoom = value },
      setCompareOpen: (value) => { state.compareOpen = value },
      showToast: (text) => state.toasts.push(String(text)),
    },
  }
}

/** 工坊动作替身：记录提交体 / 保存回调。 */
function createActions() {
  const state = { ops: [], saved: [], closed: 0, workshopJobId: '' }
  return {
    state,
    actions: {
      closeWorkshop: () => { state.closed += 1 },
      runWorkshopOp: async (body) => {
        state.ops.push(body)
        return { ok: true, jobId: 'job-workshop-1' }
      },
      workshopSaved: (entry) => state.saved.push(entry),
      workshopJobId: '',
    },
  }
}

/** 测试用作品条目：普通图片 + 带 PBR 四通道的复合资产。 */
const sourceImage = {
  ...image(11),
  path: 'outputs/workshop-src/01.png',
  file: '01.png',
  url: '/api/file?path=outputs%2Fworkshop-src%2F01.png',
  width: 512,
  height: 512,
}
const sourceEntry = { image: sourceImage, item: { prompt: '像素小人', channels: [] } }

const pbrImage = {
  ...sourceImage,
  path: 'outputs/workshop-pbr/01.png',
  file: '01.png',
  url: '/api/file?path=outputs%2Fworkshop-pbr%2F01.png',
}
const pbrChannels = ['albedo', 'normal', 'roughness', 'metallic'].map((role) => ({
  role,
  file: `${role}.png`,
  format: 'png',
  width: 512,
  height: 512,
  url: `/api/file?path=outputs%2Fworkshop-pbr%2F${role}.png`,
}))
const pbrEntry = { image: { ...pbrImage, channels: pbrChannels }, item: { prompt: 'PBR 材质', channels: pbrChannels } }

/** 挂载工坊页的最小 props。 */
function workshopProps(client, overrides = {}) {
  const { ui, state: uiState } = createUi()
  const { actions, state: actionState } = createActions()
  const gallery = overrides.gallery || [pbrEntry, sourceEntry]
  return {
    uiState,
    actionState,
    props: {
      t: client.internals.i18n.fallbackTranslate('zh-CN'),
      isEn: false,
      ui,
      compute: { activeJob: null, focusedJob: null, provider: 'kaggle' },
      library: { gallery, workspaceMode: 'work', selected: gallery[0] },
      actions,
      initialEntry: overrides.initialEntry === undefined ? gallery[0] : overrides.initialEntry,
      initialResult: overrides.initialResult || null,
      testResult: overrides.testResult || null,
      ...overrides.props,
    },
  }
}

/** 直接挂载 Stage 的最小 props（只关心动作坞结构）。 */
function stageProps(client, selected) {
  return {
    t: client.internals.i18n.fallbackTranslate('zh-CN'),
    ui: {
      zoom: false,
      setZoom: () => {},
      copyPath: () => {},
      compareOpen: false,
      setCompareOpen: () => {},
    },
    compute: { activeJob: null, status: {}, presets: [], provider: 'kaggle' },
    form: { form: { presetId: 'sdxl-lightning', width: 1024, height: 1024 }, useInspiration() {} },
    library: {
      selected,
      gallery: [selected],
      workspaceMode: 'work',
      newDraftCard: {},
      isFavorite: () => false,
      toggleFavorite: () => {},
    },
    actions: {
      openImageTool: () => {},
      reroll: () => {},
      useAsReference: () => {},
      runRemoveBackground: () => {},
      openWorkshop: () => {},
    },
  }
}

// ── 1. 工坊页结构 ────────────────────────────────────────────
await check('工坊页：六工具 / 侧栏 / 画布 / 参数 / 动作区 / PBR 通道条结构完整', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const mounted = workshopProps(client)
    const tree = await client.mountRaw(client.components.Workshop, mounted.props)
    assertStructure('workshop-main', tree, {
      required: {
        'ofs-workshop': 1,
        'ofs-workshop-head': 1,
        'ofs-workshop-tool': WORKSHOP.tools.length,
        'ofs-workshop-body': 1,
        'ofs-workshop-side': 1,
        'ofs-workshop-works': 1,
        'ofs-workshop-work': 2,
        'ofs-workshop-params-wrap': 1,
        'ofs-workshop-params': 1,
        'ofs-workshop-canvas': 1,
        'ofs-workshop-checker': 1,
        'ofs-workshop-grid': 1,
        'ofs-workshop-play': 1,
        'ofs-workshop-tile-toggle': 1,
        'ofs-workshop-channels': 1,
        'ofs-workshop-channel': 5,
        'ofs-workshop-foot': 1,
        'ofs-workshop-save': 1,
        'ofs-workshop-export': 1,
        'ofs-workshop-status': 1,
      },
      forbidden: [],
    })
    // 六项工具与契约顺序一致，且只有当前项 is-on。
    const tools = nodesByClass(tree, 'ofs-workshop-tool')
    assert.deepEqual(tools.map((node) => node.props['data-tool']), WORKSHOP.tools)
    assert.equal(tools.filter((node) => String(node.props.className).split(/\s+/).includes('is-on')).length, 1)
    // 画布元素是真正的 <canvas>。
    assert.equal(nodesByClass(tree, 'ofs-workshop-canvas-el')[0].type, 'canvas')
    // PBR 通道条：原图 + 四通道。
    const channels = nodesByClass(tree, 'ofs-workshop-channel')
    assert.deepEqual(channels.map((node) => node.props['data-role']), ['source', 'albedo', 'normal', 'roughness', 'metallic'])
    assert.equal(channels[0].props['aria-pressed'], 'true', '默认选中原图')
    // 动作区：保存 / 导出 / 状态文本。
    const footText = collectText(nodesByClass(tree, 'ofs-workshop-foot')[0]).join(' | ')
    assert.ok(footText.includes('保存到作品库'), '页脚应有保存动作')
    assert.ok(footText.includes('导出 ZIP'), '页脚应有导出动作')
    // 默认工具是像素对齐：网格覆盖层在，播放按钮禁用。
    assert.equal(nodesByClass(tree, 'ofs-workshop-play')[0].props.disabled, true, '非序列帧工具不可播放')

    // 切到「序列帧切片」：网格仍在、播放按钮在结构里保留（没有可切帧的源图时仍禁用）。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'sprite-slice').props.onClick()
    const next = await client.rerenderRaw()
    assert.equal(countByClass(next, 'ofs-workshop-grid'), 1, '序列帧工具保留网格线')
    assert.ok(
      nodesByClass(next, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'sprite-slice')
        .props.className.split(/\s+/).includes('is-on'),
      '点击后工具应高亮',
    )
    // 切到「无缝平铺」：网格覆盖层收起，平铺预览按钮可用。
    nodesByClass(next, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'tile').props.onClick()
    const tiled = await client.rerenderRaw()
    assert.equal(countByClass(tiled, 'ofs-workshop-grid'), 0, '平铺工具不显示网格线')
    assert.equal(nodesByClass(tiled, 'ofs-workshop-tile-toggle')[0].props.disabled, false, '平铺工具可开 2×2 预览')
    // 通道切换：点「法线」后该通道成为选中态。
    nodesByClass(tiled, 'ofs-workshop-channel').find((node) => node.props['data-role'] === 'normal').props.onClick()
    const normalTree = await client.rerenderRaw()
    const normal = nodesByClass(normalTree, 'ofs-workshop-channel').find((node) => node.props['data-role'] === 'normal')
    assert.equal(normal.props['aria-pressed'], 'true')
    assert.equal(countByClass(normalTree, 'ofs-workshop-channel'), 5)
  } finally {
    client.unmount()
  }
})

// ── 2. 顶栏三段式导航 ────────────────────────────────────────
await check('顶栏：创作 / 工坊 / 作品库三段，工坊进入 workshop 视图，创作下拉仍能切生图与视频', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh-CN')
    const imagePreset = { ...preset }
    const videoPreset = { id: 'video-1', label: 'MiniMax', short: 'MiniMax', mediaType: 'video', video: {} }
    const views = []
    const switched = []
    const tree = await client.mountRaw(client.components.TopBar, {
      t,
      isEn: false,
      ui: { view: 'studio', setView: (view) => views.push(view), openLogs: () => {}, openSettings: () => {} },
      compute: {
        presets: [imagePreset, videoPreset],
        defaultPreset: imagePreset.id,
        provider: 'kaggle',
        status: { tone: 'idle', label: '云端未启动' },
        workspace: null,
      },
      form: {
        form: { presetId: imagePreset.id, mediaType: 'image' },
        creationMode: 'image',
        patchForm: () => {},
        selectPreset: () => {},
      },
      library: {},
      actions: { switchCreationMode: (mode) => switched.push(mode) },
    })
    const tabs = nodesByClass(tree, 'ofs-tab')
    assert.equal(tabs.length, 3, '顶栏应有三段导航')
    const tabTexts = tabs.map((node) => collectText(node).join(''))
    assert.ok(tabTexts.some((text) => text.includes('创作')), '第一段是创作（带下拉箭头）')
    assert.ok(tabTexts.some((text) => text.includes('工坊')), '第二段是工坊')
    assert.ok(tabTexts.some((text) => text.includes('作品库')), '第三段文案改为作品库')
    assert.ok(!tabTexts.some((text) => text.includes('画廊')), '旧「画廊」文案不再出现')

    // 点工坊：setView('workshop')。
    buttonByText(tree, '工坊').props.onClick()
    assert.deepEqual(views, ['workshop'])

    // 创作按钮仍打开类型菜单，并能切到视频。
    const trigger = findNodes(
      tree,
      (node) => node.type === 'button' && node.props && node.props['aria-haspopup'] === 'menu',
    )[0]
    assert.ok(trigger, '创作按钮保留下拉菜单')
    trigger.props.onClick()
    const opened = await client.rerenderRaw()
    const menu = nodesByClass(opened, 'ofs-creation-menu')[0]
    assert.ok(menu, '创作类型菜单应展开')
    const items = findNodes(menu, (node) => node.props && node.props.role === 'menuitemradio')
    assert.equal(items.length, 2, '图片与视频两种创作类型')
    items[1].props.onClick()
    assert.deepEqual(switched, ['video'], '切换到视频类型')
    assert.deepEqual(views, ['workshop', 'studio'], '选创作类型会回到创作页')
  } finally {
    client.unmount()
  }
})

// ── 3. 动作坞资产工坊组 ──────────────────────────────────────
await check('动作坞：新增 asset 组，抹除背景与进工坊按钮绑定回调', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh-CN')
    const calls = []
    const tree = await client.mountRaw(client.components.ImageDock, {
      t,
      tools: [],
      editing: false,
      activeToolId: '',
      onOpen: () => {},
      onResume: () => {},
      onClose: () => {},
      onReroll: () => {},
      onUseReference: () => {},
      plannedTitle: '',
      onCutout: () => calls.push('cutout'),
      onOpenWorkshop: () => calls.push('workshop'),
    })
    const groups = nodesByClass(tree, 'ofs-dock-group')
    assert.equal(groups.length, 3, '动作坞应有三组')
    assert.deepEqual(groups.map((group) => group.props['data-group']), ['process', 'reuse', 'asset'])
    const assetButtons = findNodes(groups[2], (node) => node.type === 'button')
    assert.deepEqual(assetButtons.map((node) => collectText(node).join('')), ['抹除背景', '进工坊 ↗'])
    assetButtons[0].props.onClick()
    assetButtons[1].props.onClick()
    assert.deepEqual(calls, ['cutout', 'workshop'])
  } finally {
    client.unmount()
  }
})

// ── 4. Stage：图片有资产工坊组，视频没有动作坞 ────────────────
await check('Stage：图片作品出现资产工坊组，视频作品保持不渲染动作坞', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const imageTree = await client.mountRaw(client.components.Stage, stageProps(client, sourceEntry))
    assert.equal(countByClass(imageTree, 'ofs-dock-group'), 3)
    assert.equal(countByClass(imageTree, 'ofs-dock-cutout'), 1)
    assert.equal(countByClass(imageTree, 'ofs-dock-workshop'), 1)
    client.unmount()

    const videoEntry = {
      image: { ...sourceImage, mediaType: 'video', url: '/api/file?path=outputs%2Fvideo%2F01.mp4', duration: 5 },
      item: { prompt: '一段视频' },
    }
    const videoTree = await client.mountRaw(client.components.Stage, stageProps(client, videoEntry))
    assert.equal(countByClass(videoTree, 'ofs-dock'), 0, '视频作品没有动作坞')
    assert.equal(countByClass(videoTree, 'ofs-dock-group'), 0)
  } finally {
    client.unmount()
  }
})

// ── 5. 工坊页接入 Studio：workshop 视图替换舞台与左栏 ─────────
await check('Studio：view=workshop 渲染工坊整页并隐藏左栏面板与作品条', async () => {
  const client = await createTestClient({
    now: NOW,
    responses: studioResponses(readyState, { items: [historyItem] }),
    testBuild: true,
  })
  try {
    const tree = await client.mountRaw(client.components.Studio, { view: 'workshop', workspaceMode: 'work' })
    assert.equal(countByClass(tree, 'ofs-workshop'), 1, '应渲染工坊页')
    assert.equal(countByClass(tree, 'ofs-topbar'), 1, '顶栏常驻')
    assert.equal(countByClass(tree, 'ofs-panel'), 0, '工坊态不渲染左栏面板')
    assert.equal(countByClass(tree, 'ofs-filmstrip'), 0, '工坊态不渲染底部作品条')
    assert.equal(countByClass(tree, 'ofs-dock'), 0, '工坊态不渲染舞台动作坞')
    assert.equal(countByClass(tree, 'ofs-body') && 1, 1)
  } finally {
    client.unmount()
  }
})

// ── 6. 保存请求体形状 ───────────────────────────────────────
await check('工坊保存：请求体含 tool / primary.data / base.path 与附属通道', async () => {
  const savedEntry = {
    image: { path: 'outputs/workshop-out/01.png', file: '01.png', url: '/api/file?path=outputs%2Fworkshop-out%2F01.png', width: 4, height: 4 },
    item: { prompt: 'pixel', channels: [] },
  }
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/save': { ok: true, entry: savedEntry } },
    testBuild: true,
  })
  try {
    const primaryData = 'data:image/png;base64,iVBORw0KGgo='
    const mounted = workshopProps(client, {
      initialEntry: sourceEntry,
      testResult: {
        tool: 'pixel-snap',
        primary: { data: primaryData, width: 4, height: 4 },
        channels: [{ role: 'pixel', format: 'png', data: primaryData, label: '像素对齐图' }],
        meta: { cell: 2, colors: 8, scale: 1 },
      },
    })
    const tree = await client.mountRaw(client.components.Workshop, mounted.props)
    nodesByClass(tree, 'ofs-workshop-save')[0].props.onClick()
    await client.settle()
    const request = client.requests.find((item) => item.path === '/api/workshop/save')
    assert.ok(request, '应发出 POST /api/workshop/save')
    assert.equal(request.method, 'POST')
    assert.equal(request.body.tool, 'pixel-snap', '工具 id 写进 body.tool')
    assert.equal(request.body.primary.data, primaryData, '主图 dataURL 原样提交')
    assert.equal(request.body.primary.width, 4)
    assert.equal(request.body.primary.height, 4)
    assert.equal(request.body.base.path, sourceImage.path, '版本树继承：base.path 指向源作品')
    assert.equal(Array.isArray(request.body.channels), true)
    assert.equal(request.body.channels[0].role, 'pixel')
    assert.equal(request.body.channels[0].format, 'png')
    assert.equal(mounted.actionState.saved.length, 1, '保存成功后调用组合层收尾')
    assert.equal(mounted.actionState.saved[0].image.path, savedEntry.image.path)
    const next = await client.rerenderRaw()
    assert.ok(collectText(nodesByClass(next, 'ofs-workshop-status')[0]).join('').includes('已保存'), '状态行提示已保存')
  } finally {
    client.unmount()
  }
})

// ── 7. 矢量化与 GPU 后处理调用参数 ───────────────────────────
await check('工坊：矢量化按作品路径提交参数，GPU 后处理调用 op/model/options', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/vectorize': { ok: true, svg, width: 512, height: 512, bytes: 128 } },
    testBuild: true,
  })
  try {
    const mounted = workshopProps(client, { initialEntry: sourceEntry })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'vectorize').props.onClick()
    tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-vectorize')[0].props.onClick()
    await client.settle()
    const request = client.requests.find((item) => item.path === '/api/workshop/vectorize')
    assert.ok(request, '应发出 POST /api/workshop/vectorize')
    assert.equal(request.body.path, sourceImage.path, '矢量化按作品路径提交')
    assert.deepEqual(request.body.options, {
      colorPrecision: WORKSHOP.vector.colorPrecision.default,
      filterSpeckle: WORKSHOP.vector.filterSpeckle.default,
      colormode: 'color',
      hierarchy: 'stacked',
      mode: 'spline',
    })
    const vectorTree = await client.rerenderRaw()
    assert.equal(countByClass(vectorTree, 'ofs-workshop-canvas-svg'), 1, 'SVG 结果用 dataURL 预览')

    // GPU 后处理：切「抹除背景」运行，动作层收到 op / path / 默认模型。
    nodesByClass(vectorTree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'cutout').props.onClick()
    const cutoutTree = await client.rerenderRaw()
    nodesByClass(cutoutTree, 'ofs-workshop-run')[0].props.onClick()
    await client.settle()
    assert.deepEqual(mounted.actionState.ops[0], {
      op: WORKSHOP.cutout.op,
      path: sourceImage.path,
      model: WORKSHOP.cutout.defaultModel,
    })

    // PBR：模型与步数进入 options。
    nodesByClass(await client.rerenderRaw(), 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pbr').props.onClick()
    const pbrTree = await client.rerenderRaw()
    nodesByClass(pbrTree, 'ofs-workshop-run')[0].props.onClick()
    await client.settle()
    assert.deepEqual(mounted.actionState.ops[1], {
      op: WORKSHOP.pbr.op,
      path: sourceImage.path,
      model: WORKSHOP.pbr.defaultModel,
      options: { steps: WORKSHOP.pbr.steps.default },
    })
  } finally {
    client.unmount()
  }
})

// ── 8. 动作坞「抹除背景」走真实组合层 → POST /api/workshop/op ─
await check('动作坞抹除背景：经组合层向 Host 提交 remove-bg 任务', async () => {
  const client = await createTestClient({
    now: NOW,
    responses: studioResponses(
      readyState,
      { items: [historyItem] },
      { '/api/workshop/op': { ok: true, jobId: 'job-cutout-1' } },
    ),
    testBuild: true,
  })
  try {
    let tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'work' })
    nodesByClass(tree, 'ofs-thumb')[0].props.onClick()
    tree = await client.rerenderRaw()
    const cutout = nodesByClass(tree, 'ofs-dock-cutout')[0]
    assert.ok(cutout, '图片作品的资产工坊组应有抹除背景')
    cutout.props.onClick()
    await client.settle()
    const request = client.requests.find((item) => item.path === '/api/workshop/op')
    assert.ok(request, '应发出 POST /api/workshop/op')
    assert.equal(request.body.op, 'remove-bg')
    assert.equal(request.body.model, WORKSHOP.cutout.defaultModel)
    assert.ok(typeof request.body.path === 'string' && request.body.path.length > 0, '带作品路径')
  } finally {
    client.unmount()
  }
})

summary()
