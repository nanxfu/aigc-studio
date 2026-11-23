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
import { SCENE_SAMPLES } from './helpers/workshop-samples.mjs'
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
await check('工坊页：单行顶栏分栏平铺 / 侧栏 / 画布 / 参数 / 动作区 / PBR 通道条结构完整', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    // 结构用例不引入任何场景信号：提示词清空，避免「PBR」这类词影响推荐落点。
    const neutralGallery = [
      { ...pbrEntry, item: { ...pbrEntry.item, prompt: '' } },
      { ...sourceEntry, item: { ...sourceEntry.item, prompt: '' } },
    ]
    const mounted = workshopProps(client, { gallery: neutralGallery })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    assertStructure('workshop-main', tree, {
      required: {
        'ofs-workshop': 1,
        // 顶栏只有工具胶囊这一行：两个领域各一枚独立胶囊，六个工具一次平铺。
        'ofs-workshop-head': 1,
        'ofs-workshop-tool': WORKSHOP.tools.length,
        'ofs-workshop-cluster': 2,
        'ofs-workshop-cluster-label': 2,
        'ofs-workshop-cluster-thumb': 2,
        'ofs-workshop-body': 1,
        'ofs-workshop-side': 1,
        'ofs-workshop-works': 1,
        'ofs-workshop-work': 2,
        'ofs-workshop-params-wrap': 1,
        'ofs-workshop-params': 1,
        'ofs-workshop-guide-trigger': 1,
        'ofs-workshop-canvas': 1,
        'ofs-workshop-checker': 1,
        'ofs-workshop-play': 1,
        'ofs-workshop-tile-toggle': 1,
        'ofs-workshop-channels': 1,
        'ofs-workshop-channel': 5,
        'ofs-workshop-foot': 1,
        'ofs-workshop-save': 1,
        'ofs-workshop-export': 1,
        'ofs-workshop-status': 1,
      },
      // 首屏落在「抹除背景」：无网格覆盖层；也没有场景卡片、折叠开关、返回按钮或旧的单轨结构。
      forbidden: [
        'ofs-workshop-grid',
        'ofs-workshop-scene',
        'ofs-workshop-tools-toggle',
        'ofs-workshop-tools-sep',
        'ofs-workshop-back',
        'ofs-workshop-guide',
      ],
    })
    // 两个胶囊按领域顺序排列，领域名在胶囊里，工具不重不漏。
    const clusters = nodesByClass(tree, 'ofs-workshop-cluster')
    assert.deepEqual(clusters.map((node) => node.props['data-group']), ['plane', 'game3d'])
    assert.deepEqual(
      clusters.map((node) => collectText(nodesByClass(node, 'ofs-workshop-cluster-label')[0]).join('')),
      ['平面与提取', '游戏与 3D'],
      '领域名各自落在自己的胶囊里',
    )
    const tools = nodesByClass(tree, 'ofs-workshop-tool')
    assert.deepEqual(
      tools.map((node) => node.props['data-tool']),
      ['cutout', 'vectorize', 'tile', 'pixel-snap', 'sprite-slice', 'pbr'],
      '工具按「平面与提取 → 游戏与 3D」顺序平铺',
    )
    assert.equal(countByClass(clusters[0], 'ofs-workshop-tool'), 3, '平面与提取胶囊装三个工具')
    assert.equal(countByClass(clusters[1], 'ofs-workshop-tool'), 3, '游戏与 3D 胶囊装三个工具')
    assert.ok(
      tools.every((node) => node.props['data-thumb-key'] === node.props['data-tool']),
      '每个工具都带滑动高亮的定位键',
    )
    assert.equal(
      tools.filter((node) => String(node.props.className).split(/\s+/).includes('is-on')).length,
      1,
      '同时只有一个工具处于选中态',
    )
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
    // 本地上传收进「最近作品」的标题行，不再占一整行 + 说明。
    const worksCard = nodesByClass(tree, 'ofs-workshop-works')[0]
    const worksHead = nodesByClass(worksCard, 'ofs-workshop-section-head')[0]
    assert.equal(countByClass(worksHead, 'ofs-workshop-upload'), 1, '上传按钮在最近作品的标题行里')
    assert.equal(countByClass(worksCard, 'ofs-workshop-hint'), 1, '只剩「只列图片作品」一条说明')
    // 模型许可内联在「模型」标签行右侧，且必须同时带档位与协议（占位符漏一个会静默少一段）。
    const modelNote = nodesByClass(tree, 'ofs-workshop-field-note')[0]
    assert.ok(modelNote, '「模型」标签行右侧应有许可说明')
    const modelNoteText = collectText(modelNote).join('')
    assert.ok(modelNoteText.includes('MIT'), `许可应含协议，实际「${modelNoteText}」`)
    assert.ok(modelNoteText.includes('极速'), `许可应含档位，实际「${modelNoteText}」`)
    // 默认工具是「抹除背景」（平面与提取首个）：没有像素网格覆盖层，播放按钮禁用。
    assert.equal(nodesByClass(tree, 'ofs-workshop-play')[0].props.disabled, true, '非序列帧工具不可播放')
    assert.ok(
      nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'cutout')
        .props.className.split(/\s+/).includes('is-on'),
      '首屏默认落在平面与提取的第一个工具',
    )

    // `?` 说明按需展开：默认折叠（控件优先），点开后才出现说明面板与示意图。
    assert.equal(nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props['aria-expanded'], 'false')
    nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props['aria-expanded'], 'true')
    assert.equal(countByClass(tree, 'ofs-workshop-guide'), 1, '展开后出现说明面板')
    assert.equal(countByClass(tree, 'ofs-ws-sample'), 1, '说明面板里带 Before/After 示意图')

    // 切到「序列帧切片」：滑动高亮跟随、网格覆盖层出现、播放按钮保留在结构里。
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

// ── 2b. 顶栏：从作品库 / 工坊单击「创作」直接回上次创作模式，不弹类型菜单 ──
await check('顶栏：从作品库 / 工坊单击「创作」直接回到上次创作模式，不弹类型菜单', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh-CN')
    const imagePreset = { ...preset }
    const videoPreset = { id: 'video-1', label: 'MiniMax', short: 'MiniMax', mediaType: 'video', video: {} }

    for (const fromView of ['gallery', 'workshop']) {
      const views = []
      const switched = []
      const tree = await client.mountRaw(client.components.TopBar, {
        t,
        isEn: false,
        // 非创作页：最后一次工作台模式是视频（form.creationMode 随表单保留）。
        ui: { view: fromView, setView: (view) => views.push(view), openLogs: () => {}, openSettings: () => {} },
        compute: {
          presets: [imagePreset, videoPreset],
          defaultPreset: imagePreset.id,
          provider: 'kaggle',
          status: { tone: 'idle', label: '云端未启动' },
          workspace: null,
        },
        form: {
          form: { presetId: videoPreset.id, mediaType: 'video' },
          creationMode: 'video',
          patchForm: () => {},
          selectPreset: () => {},
        },
        library: {},
        actions: { switchCreationMode: (mode) => switched.push(mode) },
      })
      const trigger = findNodes(
        tree,
        (node) => node.type === 'button' && node.props && node.props['aria-haspopup'] === 'menu',
      )[0]
      assert.ok(trigger, `[${fromView}] 创作按钮存在`)
      trigger.props.onClick()
      assert.deepEqual(views, ['studio'], `[${fromView}] 单击创作应直接回到工作台`)
      assert.deepEqual(switched, [], `[${fromView}] 返回工作台不应切换创作类型（保留上次的生图 / 视频模式）`)
      const after = await client.rerenderRaw()
      assert.equal(
        nodesByClass(after, 'ofs-creation-menu').length,
        0,
        `[${fromView}] 单击返回不应展开创作类型菜单（无需二次确认）`,
      )
      // 额外确认：在创作页里再点一次「创作」才展开类型菜单（切类型入口仍可用）。
      assert.equal(trigger.props['aria-expanded'], false, `[${fromView}] 返回后菜单应处于收起状态`)
      client.unmount()
    }
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

    // PBR：模型与步数进入 options。工具全部平铺，直接点。
    const pbrTree = await client.rerenderRaw()
    nodesByClass(pbrTree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pbr').props.onClick()
    const pbrParams = await client.rerenderRaw()
    nodesByClass(pbrParams, 'ofs-workshop-run')[0].props.onClick()
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

// ── 9. 已保存 SVG / Atlas 通道预览与 GPU 任务完成自动聚焦 ─────
await check('通道预览与自动聚焦：SVG 走矢量 <img>，Atlas JSON 不进 <img>，GPU 完成后自动切到新作品', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh-CN')
    const svgAtlasChannels = [
      { role: 'svg', file: 'svg.svg', format: 'svg', url: '/api/file?path=outputs%2Fw%2Fsvg.svg' },
      { role: 'atlas', file: 'atlas.json', format: 'json', url: '/api/file?path=outputs%2Fw%2Fatlas.json' },
    ]
    const svgEntry = {
      image: { ...sourceImage, path: 'outputs/w/01.png', url: '/api/file?path=outputs%2Fw%2F01.png' },
      item: { jobId: 'job-w-1', prompt: '切片矢量', channels: svgAtlasChannels },
    }
    const mounted = workshopProps(client, { gallery: [svgEntry], initialEntry: svgEntry })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)

    // atlas 通道胶囊不应渲染 <img src=".../atlas.json">，改渲染格式角标。
    const atlasBtn = nodesByClass(tree, 'ofs-workshop-channel').find((n) => n.props['data-role'] === 'atlas')
    assert.equal(findNodes(atlasBtn, (n) => n.type === 'img').length, 0, 'JSON 通道不能挂 <img> 缩略图')
    assert.equal(nodesByClass(atlasBtn, 'ofs-workshop-channel-badge').length, 1)

    // 点击 svg 通道：应切到矢量 <img> 且 <canvas> 隐藏。
    const svgBtn = nodesByClass(tree, 'ofs-workshop-channel').find((n) => n.props['data-role'] === 'svg')
    svgBtn.props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-svg'), 1)
    assert.equal(nodesByClass(tree, 'ofs-workshop-canvas-el')[0].props.hidden, true)

    // 点击 atlas 通道：渲染 JSON 预览容器，不送进 <canvas>。
    nodesByClass(tree, 'ofs-workshop-channel').find((n) => n.props['data-role'] === 'atlas').props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-json-wrap'), 1)

    // GPU 任务完成自动聚焦：切回源图提交 remove-bg，完成后列表出现新作品即自动切焦点与通道。
    nodesByClass(tree, 'ofs-workshop-tool').find((n) => n.props['data-tool'] === 'cutout').props.onClick()
    tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-run')[0].props.onClick()
    await client.settle()

    const cutoutResultEntry = {
      image: { ...sourceImage, path: 'outputs/cutout-1/cutout.png', file: 'cutout.png', url: '/api/file?path=outputs%2Fcutout-1%2Fcutout.png' },
      item: {
        jobId: 'job-workshop-1',
        prompt: 'cutout',
        channels: [{ role: 'cutout', file: 'cutout.png', format: 'png', url: '/api/file?path=outputs%2Fcutout-1%2Fcutout.png' }],
      },
    }
    mounted.props.compute = { activeJob: null, focusedJob: { id: 'job-workshop-1', tool: 'remove-bg', status: 'done' }, provider: 'kaggle' }
    mounted.props.library = { gallery: [cutoutResultEntry, svgEntry], workspaceMode: 'work', selected: svgEntry }
    tree = await client.rerenderRaw()
    await client.settle()
    tree = await client.rerenderRaw()
    const activeChannel = nodesByClass(tree, 'ofs-workshop-channel').find((n) => n.props['aria-pressed'] === 'true')
    assert.equal(activeChannel?.props['data-role'], 'cutout', 'GPU 任务完成后应自动聚焦新产物并选中 cutout 通道')
  } finally {
    client.unmount()
  }
})

// ── 10. M4.2c 静默感知：完整画作轻提示 ─────────────────────
await check('静默感知：完整画作首屏落在抹除背景，画布顶边给可关闭的返回创作台轻提示', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const photo = SCENE_SAMPLES.find((sample) => sample.scene === 'illustration_or_photo')
    const entry = {
      image: { ...sourceImage, path: 'outputs/photo-1/01.png', url: '/api/file?path=outputs%2Fphoto-1%2F01.png' },
      item: { jobId: 'job-photo-1', source: 'import', prompt: 'my-photo.png', channels: [] },
    }
    const mounted = workshopProps(client, {
      gallery: [entry],
      initialEntry: entry,
      props: { testSourcePixels: photo.image },
    })
    await client.mountRaw(client.components.Workshop, mounted.props)
    let tree = await client.rerenderRaw()

    // 前台不再有场景选择题：没有场景卡片、没有芯片、没有手动覆盖。
    assert.equal(countByClass(tree, 'ofs-workshop-scene'), 0, '不再渲染通栏场景卡片')
    assert.equal(countByClass(tree, 'ofs-workshop-scene-chip'), 0, '不再渲染 6 枚场景芯片')
    // 六个工具一次平铺，没有任何折叠开关。
    assert.equal(countByClass(tree, 'ofs-workshop-tool'), WORKSHOP.tools.length)
    assert.equal(countByClass(tree, 'ofs-workshop-tools-toggle'), 0, '工具全部平铺，不做折叠')

    const cutout = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'cutout')
    assert.equal(cutout.props['data-primary-recommend'], 'true', '首推工具带推荐点')
    assert.equal(countByClass(cutout, 'ofs-workshop-tool-dot'), 1, '推荐点只有一枚，不是文字角标')
    assert.ok(
      cutout.props.className.split(/\s+/).includes('is-on'),
      '首屏工具自动落到抹除背景，而不是像素对齐',
    )

    // 画布顶边轻提示：文案 + 纯文字链接 + 关闭按钮。
    const hint = nodesByClass(tree, 'ofs-workshop-canvas-hint')[0]
    assert.ok(hint, '完整画作应在画布顶部给出轻提示')
    assert.ok(collectText(hint).join('').includes('创作台精修'), '提示应指向创作台精修')
    nodesByClass(tree, 'ofs-workshop-canvas-hint-link')[0].props.onClick()
    assert.equal(mounted.actionState.closed, 1, '点文字链接回创作台')
  } finally {
    client.unmount()
  }
})

await check('静默感知：画布顶边的返回创作台轻提示可以关掉', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const photo = SCENE_SAMPLES.find((sample) => sample.scene === 'illustration_or_photo')
    const photoEntry = {
      image: { ...sourceImage, path: 'outputs/photo-3/01.png', url: '/api/file?path=outputs%2Fphoto-3%2F01.png' },
      item: { jobId: 'job-photo-3', source: 'import', channels: [] },
    }
    const mounted = workshopProps(client, {
      gallery: [photoEntry],
      initialEntry: photoEntry,
      props: { testSourcePixels: photo.image },
    })
    await client.mountRaw(client.components.Workshop, mounted.props)
    let tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-hint'), 1)

    nodesByClass(tree, 'ofs-workshop-canvas-hint-close')[0].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-hint'), 0, '点 ✕ 后不再显示')
  } finally {
    client.unmount()
  }
})

await check('静默感知：像素画把首屏工具切到像素对齐并给出格距白话解读', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art')
    const entry = {
      image: { ...sourceImage, path: 'outputs/pixel-1/01.png', url: '/api/file?path=outputs%2Fpixel-1%2F01.png' },
      item: { jobId: 'job-pixel-1', rootPrompt: 'pixel art, 16-bit hero', presetId: null, channels: [] },
    }
    const mounted = workshopProps(client, {
      gallery: [entry],
      initialEntry: entry,
      props: { testSourcePixels: pixel.image },
    })
    await client.mountRaw(client.components.Workshop, mounted.props)
    const tree = await client.rerenderRaw()

    const pixelTool = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pixel-snap')
    assert.equal(pixelTool.props['data-primary-recommend'], 'true')
    assert.ok(pixelTool.props.className.split(/\s+/).includes('is-on'), '首屏工具自动切到像素对齐')
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-hint'), 0, '专业资产不劝退')
    // 探测结果的白话解读保持单行，不铺说明块。
    assert.equal(countByClass(tree, 'ofs-workshop-guide'), 0, '说明默认折叠，不遮挡参数控件')
    const readout = nodesByClass(tree, 'ofs-workshop-guide-readout')
    assert.equal(readout.length, 1, '像素画应给出单行格距解读')
    assert.ok(collectText(readout[0]).join('').includes('像素格'), '解读应说明检测到像素格')
  } finally {
    client.unmount()
  }
})

await check('参数说明：`?` 展开后显示工具说明 / Before-After / 场景解读，且箭头图形完整', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art')
    const entry = {
      image: { ...sourceImage, path: 'outputs/pixel-2/01.png', url: '/api/file?path=outputs%2Fpixel-2%2F01.png' },
      item: { jobId: 'job-pixel-2', rootPrompt: 'pixel art hero', channels: [] },
    }
    const mounted = workshopProps(client, {
      gallery: [entry],
      initialEntry: entry,
      props: { testSourcePixels: pixel.image },
    })
    await client.mountRaw(client.components.Workshop, mounted.props)
    let tree = await client.rerenderRaw()

    nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props.onClick()
    tree = await client.rerenderRaw()
    const guide = nodesByClass(tree, 'ofs-workshop-guide')[0]
    assert.ok(guide, '展开后出现说明面板')
    assert.ok(collectText(guide).join('').includes('修复 AI 像素画'), '说明应描述这个工具做什么')
    assert.equal(countByClass(guide, 'ofs-ws-sample'), 1, '带 Before/After 示意图')
    assert.ok(collectText(guide).join('').includes('识别场景'), '说明面板内给出场景解读（不在前台做选择题）')

    // 箭头修复：`d` 里不能再出现字符串拼接产生的 "565.6" 之类坐标。
    const arrows = nodesByClass(guide, 'ofs-ws-sample-arrow')
    assert.ok(arrows.length > 0, '示意图应有箭头')
    const paths = findNodes(arrows[0], (node) => node.type === 'path')
    assert.ok(paths.length >= 2, '箭头应含横杠与箭头头部两条路径')
    for (const pathNode of paths) {
      assert.ok(!/["'][^"']*565/.test(String(pathNode.props.d)), `箭头路径出现了拼接脏坐标：${pathNode.props.d}`)
      assert.ok(!String(pathNode.props.d).includes('"'), '箭头路径不应带引号')
    }
  } finally {
    client.unmount()
  }
})
await check('工作流接力：底栏原位给一个最匹配的下一步，点击先保存当前结果再切换', async () => {
  const savedEntry = {
    image: { path: 'outputs/relay-out/01.png', file: '01.png', url: '/api/file?path=outputs%2Frelay-out%2F01.png', width: 4, height: 4 },
    item: { jobId: 'job-relay-1', prompt: '抠图派生', channels: [] },
  }
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/save': { ok: true, entry: savedEntry } },
    testBuild: true,
  })
  try {
    const prop = SCENE_SAMPLES.find((sample) => sample.scene === 'isolated_prop')
    const entry = {
      image: { ...sourceImage, path: 'outputs/prop-1/01.png', url: '/api/file?path=outputs%2Fprop-1%2F01.png' },
      item: { jobId: 'job-prop-1', rootPrompt: 'isometric game item, white background', channels: [] },
    }
    const primaryData = 'data:image/png;base64,iVBORw0KGgo='
    const mounted = workshopProps(client, {
      gallery: [entry],
      initialEntry: entry,
      testResult: {
        tool: 'cutout',
        primary: { data: primaryData, width: 4, height: 4 },
        channels: [{ role: 'cutout', format: 'png', data: primaryData, label: '抹除背景' }],
      },
      props: { testSourcePixels: prop.image },
    })
    await client.mountRaw(client.components.Workshop, mounted.props)
    let tree = await client.rerenderRaw()

    // 不再有独立的通栏接力卡：底栏原位只有一个最匹配的胶囊。
    assert.equal(countByClass(tree, 'ofs-workshop-handoff'), 0, '不再渲染独立接力卡')
    const foot = nodesByClass(tree, 'ofs-workshop-foot')[0]
    const continues = nodesByClass(foot, 'ofs-workshop-continue')
    assert.equal(continues.length, 1, '底栏只放一个接力胶囊')
    assert.equal(continues[0].props['data-tool'], 'pbr', '道具抠图后最匹配的是 PBR 拆解')
    assert.equal(continues[0].props['data-needs-save'], 'true', '未落盘的结果要标记「先保存」')
    assert.ok(collectText(continues[0]).join('').includes('拆解 PBR 材质'), '胶囊文案说明下一步做什么')

    // 点击：先 POST 保存，再切到 pbr。
    continues[0].props.onClick()
    await client.settle()
    const request = client.requests.find((item) => item.path === '/api/workshop/save')
    assert.ok(request, '接力前应先把当前结果落盘')
    assert.equal(request.body.tool, 'cutout', '保存的是产出这份结果的工具')
    tree = await client.rerenderRaw()
    const pbrTool = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pbr')
    assert.ok(pbrTool.props.className.split(/\s+/).includes('is-on'), '接力后焦点应切到 PBR')
    assert.equal(countByClass(tree, 'ofs-workshop-continue'), 0, '切换工具后不再显示上一条接力')
  } finally {
    client.unmount()
  }
})

summary()


