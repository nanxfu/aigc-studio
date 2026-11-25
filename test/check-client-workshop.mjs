/**
 * 客户端「资产工坊」（M4.2a / M4.2b / M4.2c）渲染测试。
 *
 * 覆盖：
 *  1. 工坊页结构：六工具 / 侧栏 / 画布 / 参数 / 动作区 / PBR 通道条，且没有底栏；
 *  2. 顶栏三段式导航：创作（保留下拉）/ 工坊 / 作品库，点击后的 setView 与创作类型切换；
 *  3. 舞台动作坞新增资产工坊组与两个按钮的回调绑定；
 *  4. Stage 中图片作品有资产工坊组、视频作品不渲染动作坞（保持既有行为）；
 *  5. Phase 1c：应用 / 生成 SVG 即落盘（成功切焦点 + Toast，失败保留结果）、
 *     画布操作区的接力胶囊、版本面板里的 `workshop` 行与在途幽灵行。
 *
 * 运行：node test/check-client-workshop.mjs（并发开发时设置 OFS_TEST_BUNDLE）
 */

import assert from 'node:assert/strict'

import { WORKSHOP } from '../shared/contract.js'
import { createCheckRunner } from './helpers/check.mjs'
import { SCENE_SAMPLES } from './helpers/workshop-samples.mjs'
import { toolsForScene } from '../web/logic/workshopPerception.js'
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
        'ofs-workshop-param-content': 1,
        'ofs-workshop-param-footer': 1,
        'ofs-workshop-guide-trigger': 1,
        'ofs-workshop-guide': 1,
        'ofs-ws-sample': 1,
        'ofs-workshop-canvas': 1,
        'ofs-workshop-checker': 1,
        'ofs-workshop-play': 1,
        'ofs-workshop-tile-toggle': 1,
        'ofs-workshop-channels': 1,
        'ofs-workshop-channel': 5,
      },
      // 首屏落在「抹除背景」：无网格覆盖层；也没有场景卡片、折叠开关、返回按钮或旧的单轨结构。
      // Phase 1c：底栏（保存 / 导出 / 状态行）整体取消，应用即落盘。
      forbidden: [
        'ofs-workshop-grid',
        'ofs-workshop-scene',
        'ofs-workshop-tools-toggle',
        'ofs-workshop-tools-sep',
        'ofs-workshop-back',
        'ofs-workshop-foot',
        'ofs-workshop-save',
        'ofs-workshop-export',
        'ofs-workshop-continue',
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
    // Phase 1c：没有底栏，也不再有保存 / 导出按钮；画布与操作区吃满全高。
    assert.equal(countByClass(tree, 'ofs-workshop-foot'), 0, '底栏已移除')
    assert.equal(countByClass(tree, 'ofs-workshop-save'), 0, '不再有「保存到作品库」按钮')
    assert.equal(countByClass(tree, 'ofs-workshop-export'), 0, '不再有「导出 ZIP」按钮')
    assert.equal(countByClass(tree, 'ofs-workshop-continue'), 0, '还没有结果时不出现接力胶囊')
    // 本地上传收进「最近作品」的标题行，不再占一整行 + 说明。
    const worksCard = nodesByClass(tree, 'ofs-workshop-works')[0]
    const worksHead = nodesByClass(worksCard, 'ofs-workshop-section-head')[0]
    assert.equal(countByClass(worksHead, 'ofs-workshop-upload'), 1, '上传按钮在最近作品的标题行里')
    assert.equal(countByClass(worksCard, 'ofs-workshop-hint'), 1, '只剩「只列图片作品」一条说明')
    // 模型许可内联在标签行右侧：默认本机模式带非商用提示，切云端 GPU 展示 BiRefNet (MIT + 极速)。
    const localModelNote = nodesByClass(tree, 'ofs-workshop-field-note')[0]
    assert.ok(localModelNote, '「运行方式」标签行右侧应有本机许可说明')
    const localNoteText = collectText(localModelNote).join('')
    assert.ok(localNoteText.includes('非商用'), `本机模式应含协议，实际「${localNoteText}」`)
    buttonByText(tree, '云端 GPU').props.onClick()
    tree = await client.rerenderRaw()
    const modelNote = nodesByClass(tree, 'ofs-workshop-field-note')[0]
    assert.ok(modelNote, '「模型」标签行右侧应有许可说明')
    const modelNoteText = collectText(modelNote).join('')
    assert.ok(modelNoteText.includes('MIT'), `许可应含协议，实际「${modelNoteText}」`)
    assert.ok(modelNoteText.includes('极速'), `许可应含档位，实际「${modelNoteText}」`)
    buttonByText(tree, '本机极速').props.onClick()
    tree = await client.rerenderRaw()
    // 默认工具是「抹除背景」（平面与提取首个）：没有像素网格覆盖层，播放按钮禁用。
    assert.equal(nodesByClass(tree, 'ofs-workshop-play')[0].props.disabled, true, '非序列帧工具不可播放')
    assert.ok(
      nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'cutout')
        .props.className.split(/\s+/).includes('is-on'),
      '首屏默认落在平面与提取的第一个工具',
    )

    // `?` 说明默认展开，让工具用途与 Before/After 直接可见；用户可收起并记住偏好。
    assert.equal(nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props['aria-expanded'], 'true')
    assert.equal(countByClass(tree, 'ofs-workshop-guide'), 1, '默认出现说明面板')
    assert.equal(countByClass(tree, 'ofs-ws-sample'), 1, '默认说明面板里带 Before/After 示意图')
    nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props['aria-expanded'], 'false')
    assert.equal(countByClass(tree, 'ofs-workshop-guide'), 0, '收起后说明面板消失')

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
await check('动作坞：asset 组只保留进工坊入口并绑定回调', async () => {
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
      onOpenWorkshop: () => calls.push('workshop'),
    })
    const groups = nodesByClass(tree, 'ofs-dock-group')
    assert.equal(groups.length, 3, '动作坞应有三组')
    assert.deepEqual(groups.map((group) => group.props['data-group']), ['process', 'reuse', 'asset'])
    const assetButtons = findNodes(groups[2], (node) => node.type === 'button')
    assert.deepEqual(assetButtons.map((node) => collectText(node).join('')), ['进工坊 ↗'])
    assetButtons[0].props.onClick()
    assert.deepEqual(calls, ['workshop'])
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
    assert.equal(countByClass(imageTree, 'ofs-dock-cutout'), 0, '抹除背景只在工坊内提供')
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

// ── 6. 应用即落盘（Phase 1c）┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
await check('应用即落盘：点「应用」直接提交 save、切焦点并走全局 Toast，失败保留结果', async () => {
  const savedEntry = {
    image: { path: 'outputs/workshop-out/01.png', file: '01.png', url: '/api/file?path=outputs%2Fworkshop-out%2F01.png', width: 4, height: 4 },
    item: { jobId: 'workshop-out', prompt: 'pixel', workshop: true, workshopTool: 'pixel-snap', channels: [] },
  }
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/save': { ok: true, entry: savedEntry } },
    testBuild: true,
    canvas: true,
  })
  try {
    const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art')
    const mounted = workshopProps(client, {
      gallery: [sourceEntry],
      initialEntry: sourceEntry,
      props: { testSourcePixels: pixel.image },
    })
    await client.mountRaw(client.components.Workshop, mounted.props)
    let tree = await client.rerenderRaw()
    // 像素画首屏自动落到「像素对齐」，不再需要手动切工具。
    assert.ok(
      nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pixel-snap')
        .props.className.split(/\s+/).includes('is-on'),
      '首屏工具自动落到像素对齐',
    )
    nodesByClass(tree, 'ofs-workshop-apply')[0].props.onClick()
    await client.settle()

    const request = client.requests.find((item) => item.path === '/api/workshop/save')
    assert.ok(request, '点「应用」应直接发出 POST /api/workshop/save')
    assert.equal(request.method, 'POST')
    assert.equal(request.body.tool, 'pixel-snap', '工具 id 写进 body.tool')
    assert.ok(String(request.body.primary.data).startsWith('data:image/png'), '主图是 PNG dataURL')
    assert.equal(request.body.base.path, sourceImage.path, '版本树继承：base.path 指向源作品')
    assert.equal(Array.isArray(request.body.channels), true)
    assert.equal(request.body.channels[0].role, 'pixel')
    assert.equal(request.body.channels[0].format, 'png')
    assert.equal(mounted.actionState.saved.length, 1, '落盘成功后调用组合层收尾（刷新历史 / 切焦点）')
    assert.equal(mounted.actionState.saved[0].image.path, savedEntry.image.path)
    assert.ok(
      mounted.uiState.toasts.some((text) => text.includes('已应用并保存')),
      `成功提示应走全局 Toast，实际：${JSON.stringify(mounted.uiState.toasts)}`,
    )
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-status'), 0, '成功不在参数卡里留提示行')
    assert.equal(countByClass(tree, 'ofs-workshop-foot'), 0, '依然没有底栏')
  } finally {
    client.unmount()
  }

  // 失败路径：保存报错时结果留在画布上，提示落在参数按钮下方。
  const failing = await createTestClient({
    now: NOW,
    failures: { '/api/workshop/save': 'network down' },
    testBuild: true,
    canvas: true,
  })
  try {
    const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art')
    const mounted = workshopProps(failing, {
      gallery: [sourceEntry],
      initialEntry: sourceEntry,
      props: { testSourcePixels: pixel.image },
    })
    await failing.mountRaw(failing.components.Workshop, mounted.props)
    let tree = await failing.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-apply')[0].props.onClick()
    await failing.settle()
    tree = await failing.rerenderRaw()
    assert.equal(mounted.actionState.saved.length, 0, '保存失败不调用组合层收尾')
    const note = nodesByClass(tree, 'ofs-workshop-status')[0]
    assert.ok(note, '保存失败要在参数卡下方留一行提示')
    assert.ok(collectText(note).join('').includes('保存失败'), '提示应说明保存失败')
    assert.ok(
      mounted.uiState.toasts.some((text) => text.includes('保存失败')),
      '失败提示同样走全局 Toast',
    )
    // 结果不丢：画布仍在展示刚算出的主图（dataURL），接力胶囊也仍按产出工具给出下一步。
    const preview = nodesByClass(tree, 'ofs-workshop-canvas-el')[0]
    assert.ok(preview, '画布仍在')
    const continueBtn = nodesByClass(tree, 'ofs-workshop-continue')[0]
    assert.ok(continueBtn, '结果还在，接力胶囊仍可用')
    assert.equal(continueBtn.props['data-tool'], 'sprite-slice', '像素对齐之后最匹配序列帧切片')
  } finally {
    failing.unmount()
  }
})

// ── 7. 生成 SVG 即落盘，GPU 后处理调用参数 ───────────────────
await check('生成 SVG：按作品路径提交参数并直接落盘（svg 通道进作品库）', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'
  const savedEntry = {
    image: { path: 'outputs/ws-vector/01.png', file: '01.png', url: '/api/file?path=outputs%2Fws-vector%2F01.png', width: 4, height: 4 },
    item: { jobId: 'ws-vector', workshop: true, workshopTool: 'vectorize', channels: [{ role: 'svg', file: 'svg.svg', format: 'svg' }] },
  }
  const client = await createTestClient({
    now: NOW,
    responses: {
      '/api/workshop/vectorize': { ok: true, svg, width: 512, height: 512, bytes: 128 },
      '/api/workshop/save': { ok: true, entry: savedEntry },
    },
    testBuild: true,
    canvas: true,
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

    // 取回 SVG 后不再等用户点保存：直接作为复合资产落盘，svg 通道立即可切。
    const save = client.requests.find((item) => item.path === '/api/workshop/save')
    assert.ok(save, '生成 SVG 后应直接 POST /api/workshop/save')
    assert.equal(save.body.tool, 'vectorize')
    assert.equal(save.body.channels[0].role, 'svg', 'SVG 作为附属通道提交')
    assert.equal(save.body.channels[0].format, 'svg')
    assert.equal(mounted.actionState.saved.length, 1, '落盘后通知组合层刷新')
    assert.ok(
      mounted.uiState.toasts.some((text) => text.includes('已生成 SVG 并保存')),
      `Toast 应说明 SVG 已保存，实际：${JSON.stringify(mounted.uiState.toasts)}`,
    )
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-svg'), 1, 'SVG 结果保留在画布上')
  } finally {
    client.unmount()
  }
})

await check('GPU 后处理：默认本机抠图落盘，切云端 GPU 按 op + model + options 提交', async () => {
  const savedCutoutEntry = {
    image: { ...sourceImage, path: 'outputs/cutout-local/01.png', url: '/api/file?path=outputs%2Fcutout-local%2F01.png' },
    item: { jobId: 'workshop-local', prompt: 'cutout', channels: [{ role: 'cutout', format: 'png', url: '/api/file?path=outputs%2Fcutout-local%2Fcutout.png' }] },
  }
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/save': { ok: true, entry: savedCutoutEntry } },
    testBuild: true,
  })
  try {
    let localCutoutCalls = 0
    const mounted = workshopProps(client, {
      gallery: [sourceEntry],
      initialEntry: sourceEntry,
      props: {
        runLocalCutout: async ({ sourceUrl }) => {
          localCutoutCalls += 1
          assert.equal(sourceUrl, sourceImage.url)
          return {
            data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            width: 512,
            height: 512,
            modelId: 'rmbg-1.4-fp16',
            ep: 'webgpu',
            elapsedMs: 120,
          }
        },
      },
    })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    // 默认「本机极速」：直接跑本机抠图并通过 /api/workshop/save 落盘，不触发云端队列。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'cutout').props.onClick()
    tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-run')[0].props.onClick()
    await client.settle()
    assert.equal(localCutoutCalls, 1, '默认应走本机抠图')
    assert.equal(mounted.actionState.ops.length, 0, '本机抠图不应提交云端任务')
    const saveReq = client.requests.find((item) => item.path === '/api/workshop/save')
    assert.ok(saveReq, '本机抠图应直接调 POST /api/workshop/save 落盘')
    assert.equal(saveReq.body.tool, 'cutout')
    assert.equal(saveReq.body.channels[0].role, 'cutout')
    assert.equal(mounted.actionState.saved.length, 1, '落盘后应通知宿主刷新作品库')

    // 切「云端 GPU」：动作层收到 op / path / 默认云端模型（聚焦已切到刚保存的作品）。
    buttonByText(tree, '云端 GPU').props.onClick()
    tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-run')[0].props.onClick()
    await client.settle()
    assert.deepEqual(mounted.actionState.ops[0], {
      op: WORKSHOP.cutout.op,
      path: savedCutoutEntry.image.path,
      model: WORKSHOP.cutout.defaultModel,
    })

    // PBR：模型与步数进入 options。工具全部平铺，直接点。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pbr').props.onClick()
    tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-run')[0].props.onClick()
    await client.settle()
    assert.deepEqual(mounted.actionState.ops[1], {
      op: WORKSHOP.pbr.op,
      path: savedCutoutEntry.image.path,
      model: WORKSHOP.pbr.defaultModel,
      options: { steps: WORKSHOP.pbr.steps.default },
    })
    // 排队提示落在参数卡下方的一行小字上（底栏已取消）。
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-foot'), 0, 'GPU 提交也不恢复底栏')
  } finally {
    client.unmount()
  }
})

// ── 8. 动作坞「进工坊」走真实组合层 → workshop 视图 ─────────
await check('动作坞进工坊：带着当前作品切到工坊视图，不直接提交 GPU 任务', async () => {
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
    const workshop = nodesByClass(tree, 'ofs-dock-workshop')[0]
    assert.ok(workshop, '图片作品的资产工坊组应有进工坊入口')
    workshop.props.onClick()
    await client.settle()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop'), 1, '应切到工坊视图')
    assert.equal(
      client.requests.some((item) => item.path === '/api/workshop/op'),
      false,
      '进工坊不能顺带提交抹除背景任务',
    )
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

    // GPU 任务完成自动聚焦：切回源图切云端 GPU 提交 remove-bg，完成后列表出现新作品即自动切焦点与通道。
    nodesByClass(tree, 'ofs-workshop-tool').find((n) => n.props['data-tool'] === 'cutout').props.onClick()
    tree = await client.rerenderRaw()
    buttonByText(tree, '云端 GPU').props.onClick()
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
    let tree = await client.rerenderRaw()

    const pixelTool = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pixel-snap')
    assert.equal(pixelTool.props['data-primary-recommend'], 'true')
    assert.ok(pixelTool.props.className.split(/\s+/).includes('is-on'), '首屏工具自动切到像素对齐')
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-hint'), 0, '专业资产不劝退')
    // 探测结果的白话解读保持单行；收起常驻说明后读数仍在。
    nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-guide'), 0, '说明收起后不占参数区高度')
    const readout = nodesByClass(tree, 'ofs-workshop-guide-readout')
    assert.equal(readout.length, 1, '像素画应给出单行格距解读')
    assert.ok(collectText(readout[0]).join('').includes('像素格'), '解读应说明检测到像素格')
  } finally {
    client.unmount()
  }
})

await check('参数说明：工具标题带图标，展开后显示效果与输出格式，隐藏内部场景分类', async () => {
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

    assert.equal(nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props['aria-expanded'], 'true')
    const guide = nodesByClass(tree, 'ofs-workshop-guide')[0]
    assert.ok(guide, '默认展开说明面板')
    assert.ok(collectText(guide).join('').includes('像素画格距'), '说明应简洁描述这个工具做什么')
    assert.equal(countByClass(guide, 'ofs-ws-sample'), 1, '带 Before/After 示意图')
    const heading = nodesByClass(tree, 'ofs-workshop-tool-title')[0]
    assert.ok(collectText(heading).join('').includes('像素对齐'), '主标题应显示当前工具名')
    assert.equal(countByClass(heading, 'ofs-icon'), 1, '标题带工具图标')
    assert.equal(countByClass(guide, 'ofs-workshop-guide-tag'), 0, '不展示内部场景分类胶囊')
    assert.equal(countByClass(guide, 'ofs-workshop-guide-scene'), 0, '不展示内部识别理由')
    assert.ok(collectText(guide).join('').includes('整格对齐'), '示意图标明当前工具的结果')
    assert.equal(findNodes(guide, (node) => node.type === 'img').length, 2, '示例展示具体输入和算子输出')
    const content = nodesByClass(tree, 'ofs-workshop-param-content')[0]
    const footer = nodesByClass(tree, 'ofs-workshop-param-footer')[0]
    assert.equal(countByClass(content, 'ofs-workshop-actions'), 0, '滚动内容不包含提交按钮')
    assert.equal(countByClass(footer, 'ofs-workshop-actions'), 1, '提交按钮放在固定底部')
    assert.equal(content.props.tabIndex, 0, '键盘可以聚焦并滚动参数区')

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
// ── 10. 接力胶囊：画布操作区 + 已落盘直达 ─────────────────────
await check('接力胶囊：迁到画布操作区，点击先保存未落盘结果再切工具', async () => {
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

    // 不再有独立接力卡，也不再有底栏：胶囊落在画布右下角操作区（播放 / 平铺按钮左侧）。
    assert.equal(countByClass(tree, 'ofs-workshop-handoff'), 0, '不再渲染独立接力卡')
    assert.equal(countByClass(tree, 'ofs-workshop-foot'), 0, '底栏已移除')
    const actions = nodesByClass(tree, 'ofs-workshop-canvas-actions')[0]
    assert.ok(actions, '画布操作区存在')
    const continues = nodesByClass(actions, 'ofs-workshop-continue')
    assert.equal(continues.length, 1, '画布操作区只放一个接力胶囊')
    assert.equal(continues[0].props['data-tool'], 'pbr', '道具抠图后最匹配的是 PBR 拆解')
    assert.equal(continues[0].props['data-needs-save'], 'true', '测试注入的未落盘结果要标记「先保存」')
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

await check('接力胶囊：应用即落盘后直接带着新作品切换，不重复保存', async () => {
  const savedEntry = {
    image: { path: 'outputs/pixel-out/01.png', file: '01.png', url: '/api/file?path=outputs%2Fpixel-out%2F01.png', width: 4, height: 4 },
    item: { jobId: 'workshop-pixel-out', workshop: true, workshopTool: 'pixel-snap', channels: [] },
  }
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/save': { ok: true, entry: savedEntry } },
    testBuild: true,
    canvas: true,
  })
  try {
    const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art')
    const mounted = workshopProps(client, {
      gallery: [sourceEntry],
      initialEntry: sourceEntry,
      props: { testSourcePixels: pixel.image },
    })
    await client.mountRaw(client.components.Workshop, mounted.props)
    let tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-apply')[0].props.onClick()
    await client.settle()

    tree = await client.rerenderRaw()
    const continues = nodesByClass(tree, 'ofs-workshop-canvas-actions')[0]
    const continueBtn = nodesByClass(continues, 'ofs-workshop-continue')[0]
    assert.ok(continueBtn, '落盘后画布操作区出现接力胶囊')
    assert.equal(continueBtn.props['data-tool'], 'sprite-slice', '像素对齐之后最匹配序列帧切片')
    assert.equal(continueBtn.props['data-needs-save'], 'false', '应用即落盘后不再需要二次保存')

    // 宿主会把刚保存的新作品写回 `actions.workshopEntry`（Studio 的 initialEntry），
    // 那会让工坊再收到一次新的 initialPath；这一轮必须只同步焦点，不能清掉结果与接力。
    mounted.props.initialEntry = { image: savedEntry.image, item: savedEntry.item }
    tree = await client.rerenderRaw()
    const echoed = nodesByClass(tree, 'ofs-workshop-canvas-actions')[0]
    assert.ok(
      nodesByClass(echoed, 'ofs-workshop-continue')[0],
      '宿主回写 workshopEntry 后结果与接力胶囊仍保留',
    )
    const stillPixel = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pixel-snap')
    assert.ok(stillPixel.props.className.split(/\s+/).includes('is-on'), '回写后仍停在刚做完的工具上')

    const savesBefore = client.requests.filter((item) => item.path === '/api/workshop/save').length
    assert.equal(savesBefore, 1, '应用时已经保存过一次')
    nodesByClass(echoed, 'ofs-workshop-continue')[0].props.onClick()
    await client.settle()
    const savesAfter = client.requests.filter((item) => item.path === '/api/workshop/save').length
    assert.equal(savesAfter, savesBefore, '接力不再重复保存')
    tree = await client.rerenderRaw()
    const spriteTool = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'sprite-slice')
    assert.ok(spriteTool.props.className.split(/\s+/).includes('is-on'), '接力后焦点切到序列帧切片')
  } finally {
    client.unmount()
  }
})

// ── 11. 版本树里的工坊语义（VersionPanel / Filmstrip）────────────
await check('版本面板：工坊产物显示具体工具名与通道数，不把 cutout 当生成提示词', async () => {
  const rootImage = {
    path: 'outputs/20261124-090000-root/01.png',
    file: '01.png',
    url: '/api/file?path=outputs%2F20261124-090000-root%2F01.png',
    width: 512,
    height: 512,
    seed: 1,
  }
  const rootItem = {
    jobId: 'job-root-ws',
    dir: 'outputs/20261124-090000-root',
    prompt: 'isometric potion, white background',
    presetId: 'sdxl-lightning',
    finishedAt: '2026-11-24T01:00:00.000Z',
    images: [rootImage],
  }
  const workshopImage = {
    ...rootImage,
    path: 'outputs/20261124-091000-workshop-1/01.png',
    url: '/api/file?path=outputs%2F20261124-091000-workshop-1%2F01.png',
  }
  const workshopItem = {
    jobId: 'workshop-20261124-091000',
    dir: 'outputs/20261124-091000-workshop-1',
    prompt: 'cutout',
    presetId: null,
    workshop: true,
    workshopTool: 'cutout',
    sourceImage: rootImage.path,
    rootImage: rootImage.path,
    finishedAt: '2026-11-24T01:10:00.000Z',
    images: [workshopImage],
    channels: [
      { role: 'cutout', file: 'cutout.png', format: 'png', url: '/api/file?path=x' },
      { role: 'albedo', file: 'albedo.png', format: 'png', url: '/api/file?path=y' },
    ],
  }
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh-CN')
    let tree = await client.mountRaw(client.components.Filmstrip, {
      t,
      ui: { setView: () => {} },
      compute: { pendingJobs: [], sessionState: 'ready', startSession: () => {}, status: {}, cancelJob: () => {}, cancellingIds: [] },
      library: {
        items: [workshopItem, rootItem],
        gallery: [
          { image: rootImage, item: rootItem },
          { image: workshopImage, item: workshopItem },
        ],
        selected: { image: rootImage, item: rootItem },
        selectImage: () => {},
        workspaceMode: 'work',
        newDraftCard: {},
      },
      actions: { previewWork: () => {} },
    })
    const badge = nodesByClass(tree, 'ofs-version-badge')[0]
    assert.ok(badge, '一根树里有两代版本，应出现版本角标')
    badge.props.onClick({ stopPropagation() {}, preventDefault() {} })
    tree = await client.rerenderRaw()

    const rows = nodesByClass(tree, 'ofs-version-row')
    assert.equal(rows.length, 2, '根节点 + 工坊产物两行')
    const workshopRow = rows.find((row) => row.props['data-kind'] === 'workshop')
    assert.ok(workshopRow, '工坊产物行的 kind 是 workshop，不是 img2img')
    const kind = nodesByClass(workshopRow, 'ofs-version-kind')[0]
    assert.equal(kind.props['aria-label'], '抹除背景', '类型标签显示具体工具名')
    const rowText = collectText(workshopRow).join(' ')
    assert.ok(rowText.includes('抹除背景'), '行内文字含工具名')
    assert.ok(rowText.includes('2 通道'), '行摘要显示通道数')
    assert.ok(!rowText.includes('cutout'), `版本行不能把英文 slug 当提示词展示：${rowText}`)
    assert.equal(countByClass(workshopRow, 'ofs-version-thumb-ghost'), 0, '已完成版本不是幽灵行')
  } finally {
    client.unmount()
  }
})

await check('版本面板：在途 remove-bg / pbr 幽灵行标成工坊加工，显示工具名', async () => {
  const rootImage = {
    path: 'outputs/20261124-090000-root2/01.png',
    file: '01.png',
    url: '/api/file?path=outputs%2F20261124-090000-root2%2F01.png',
    width: 512,
    height: 512,
  }
  const rootItem = {
    jobId: 'job-root-ws2',
    dir: 'outputs/20261124-090000-root2',
    prompt: '砖墙材质',
    presetId: 'sdxl-lightning',
    finishedAt: '2026-11-24T02:00:00.000Z',
    images: [rootImage],
  }
  const pendingJobs = [
    { id: 'job-cut-1', tool: 'remove-bg', status: 'running', parentPath: rootImage.path, rootImage: rootImage.path, params: { prompt: 'cutout' } },
    { id: 'job-pbr-1', tool: 'pbr', status: 'queued', parentPath: rootImage.path, rootImage: rootImage.path, params: { prompt: 'pbr' } },
  ]
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const t = client.internals.i18n.fallbackTranslate('zh-CN')
    let tree = await client.mountRaw(client.components.Filmstrip, {
      t,
      ui: { setView: () => {} },
      compute: {
        pendingJobs,
        sessionState: 'ready',
        startSession: () => {},
        status: {},
        cancelJob: () => {},
        cancellingIds: [],
      },
      library: {
        items: [rootItem],
        gallery: [{ image: rootImage, item: rootItem }],
        selected: { image: rootImage, item: rootItem },
        selectImage: () => {},
        workspaceMode: 'work',
        newDraftCard: {},
      },
      actions: { previewWork: () => {} },
    })
    const badge = nodesByClass(tree, 'ofs-version-badge')[0]
    assert.ok(badge, '在途任务也要让版本角标可展开')
    badge.props.onClick({ stopPropagation() {}, preventDefault() {} })
    tree = await client.rerenderRaw()

    const rows = nodesByClass(tree, 'ofs-version-row')
    const ghostRows = rows.filter((row) => row.props['data-ghost'] === 'true')
    assert.equal(ghostRows.length, 2, '两个在途工坊任务各占一行幽灵')
    assert.deepEqual(ghostRows.map((row) => row.props['data-kind']), ['workshop', 'workshop'])
    assert.deepEqual(
      ghostRows.map((row) => nodesByClass(row, 'ofs-version-kind')[0].props['aria-label']),
      ['抹除背景', 'PBR 材质拆解'],
      '幽灵行按具体工具名标注，而不是「整图重绘」',
    )
    for (const row of ghostRows) {
      assert.ok(!collectText(row).join(' ').includes('cutout'), '幽灵行也不展示英文 slug')
    }
  } finally {
    client.unmount()
  }
})

// ── 12. 创作切工坊：由 Jev 判定默认工具，不被旧 workshopTool 锁死 ──
await check('创作切工坊：按 Jev 判定默认展开工具，已抠图产物自动切到下一步推荐', async () => {
  const pixelItem = {
    ...historyItem,
    jobId: 'job-pixel-from-studio',
    prompt: 'pixel art knight sprite, 16-bit',
    rootPrompt: 'pixel art knight sprite, 16-bit',
    images: [{ ...sourceImage, path: 'outputs/pixel-from-studio/01.png', url: '/api/file?path=outputs%2Fpixel-from-studio%2F01.png' }],
  }
  const cutoutDoneItem = {
    ...historyItem,
    jobId: 'job-cutout-from-studio',
    prompt: 'cutout',
    rootPrompt: 'isometric game potion prop, white background',
    workshop: true,
    workshopTool: 'cutout',
    channels: [{ role: 'cutout', file: 'cutout.png', format: 'png', url: '/api/file?path=outputs%2Fcutout-from-studio%2Fcutout.png' }],
    images: [{ ...sourceImage, path: 'outputs/cutout-from-studio/01.png', url: '/api/file?path=outputs%2Fcutout-from-studio%2F01.png' }],
  }
  const client = await createTestClient({
    now: NOW,
    responses: studioResponses(readyState, { items: [pixelItem, cutoutDoneItem] }),
    testBuild: true,
  })
  try {
    let tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'work' })
    // 1) 从创作态带着像素画点「进工坊」：首屏即按 Jev 判定展开「像素对齐」。
    nodesByClass(tree, 'ofs-dock-workshop')[0].props.onClick()
    tree = await client.rerenderRaw()
    const pixelTool = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pixel-snap')
    assert.ok(pixelTool.props.className.split(/\s+/).includes('is-on'), '像素画切进工坊应默认展开像素对齐')

    // 2) 回创作台选中已抠图的道具作品，再切到工坊：不应被 workshopTool=cutout 锁死在抹除背景。
    buttonByText(tree, '创作').props.onClick()
    tree = await client.rerenderRaw()
    const thumbs = nodesByClass(tree, 'ofs-thumb')
    thumbs[1].props.onClick()
    tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-dock-workshop')[0].props.onClick()
    tree = await client.rerenderRaw()
    const activeTool = nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props.className.split(/\s+/).includes('is-on'))
    assert.notEqual(activeTool.props['data-tool'], 'cutout', '已抠图产物切进工坊应按 Jev 推进到下一工具，而非锁死在 cutout')
  } finally {
    client.unmount()
  }
})

await check('切图感知：新图载入前不借旧像素落焦，到位后仍采用新图推荐', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art').image
    const photo = SCENE_SAMPLES.find((sample) => sample.scene === 'illustration_or_photo').image
    const entries = ['pixel-a', 'photo-b', 'pixel-c'].map((name) => ({
      image: { ...sourceImage, path: `outputs/${name}/01.png`, url: `/${name}.png` },
      item: { source: 'import', channels: [] },
    }))
    const mounted = workshopProps(client, {
      gallery: entries,
      initialEntry: entries[0],
      props: { testSourcePixels: pixel },
    })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    const active = (node) => nodesByClass(node, 'ofs-workshop-tool').find((tool) => tool.props['aria-pressed'] === 'true')
    assert.equal(active(tree).props['data-tool'], 'pixel-snap')

    mounted.props.testSourcePixels = null
    nodesByClass(tree, 'ofs-workshop-work')[1].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-guide-readout'), 0, '新图未载入时不显示旧像素格读数')
    mounted.props.testSourcePixels = photo
    tree = await client.rerenderRaw()
    assert.equal(active(tree).props['data-tool'], 'cutout', '新照片到位后要采用它自己的推荐')
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-hint'), 1)

    mounted.props.testSourcePixels = null
    nodesByClass(tree, 'ofs-workshop-work')[2].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-canvas-hint'), 0, '载入下一张时不能沿用旧照片提示')
    nodesByClass(tree, 'ofs-workshop-tool').find((tool) => tool.props['data-tool'] === 'vectorize').props.onClick()
    tree = await client.rerenderRaw()
    mounted.props.testSourcePixels = pixel
    tree = await client.rerenderRaw()
    assert.equal(active(tree).props['data-tool'], 'vectorize', '等待载入时手动选工具，不能被迟到的推荐覆盖')
    const recommend = nodesByClass(tree, 'ofs-workshop-tool').find((tool) => tool.props['data-primary-recommend'] === 'true')
    assert.equal(recommend.props['data-tool'], 'pixel-snap', '推荐点仍更新为新图的建议')
  } finally {
    client.unmount()
  }
})

await check('像素格距：手动值跨工具和迟到像素保持，显式探测与换图可重新采用检测值', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art').image
    const entries = ['grid-a', 'grid-b'].map((name) => ({
      image: { ...sourceImage, path: `outputs/${name}/01.png`, url: `/${name}.png` },
      item: { source: 'import', channels: [] },
    }))
    const mounted = workshopProps(client, { gallery: entries, props: { initialTool: 'pixel-snap' } })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    const gridInput = (node) => findNodes(node, (input) => input.type === 'input' && input.props.max === WORKSHOP.pixel.grid.max)[0]
    const selectTool = (node, id) => nodesByClass(node, 'ofs-workshop-tool').find((tool) => tool.props['data-tool'] === id).props.onClick()

    gridInput(tree).props.onChange({ target: { value: '3' } })
    tree = await client.rerenderRaw()
    mounted.props.testSourcePixels = pixel
    tree = await client.rerenderRaw()
    assert.equal(gridInput(tree).props.value, 3, '迟到的图像检测不能覆盖手动值')
    selectTool(tree, 'tile')
    tree = await client.rerenderRaw()
    selectTool(tree, 'pixel-snap')
    tree = await client.rerenderRaw()
    assert.equal(gridInput(tree).props.value, 3, '切回工具仍保留格距')

    nodesByClass(tree, 'ofs-workshop-detect')[0].props.onClick()
    tree = await client.rerenderRaw()
    const detectedCell = gridInput(tree).props.value
    assert.ok(detectedCell > 1 && detectedCell !== 3, '显式探测采用真实格距')
    gridInput(tree).props.onChange({ target: { value: '3' } })
    tree = await client.rerenderRaw()
    nodesByClass(tree, 'ofs-workshop-work')[1].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(gridInput(tree).props.value, detectedCell, '换图后可以自动采用新图检测值')
  } finally {
    client.unmount()
  }
})

await check('旧作品感知：已加载根图的提示词与模型标签参与首屏工具推荐', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const root = {
      image: { ...sourceImage, path: 'outputs/root-legacy/01.png' },
      item: { prompt: 'pixel art, 16-bit sprite', presetId: 'pixel-legacy', channels: [] },
    }
    const derived = {
      image: { ...sourceImage, path: 'outputs/legacy-cutout/01.png' },
      item: { workshop: true, workshopTool: 'cutout', prompt: 'hero-cutout.png', rootImage: root.image.path, channels: [] },
    }
    const mounted = workshopProps(client, {
      gallery: [derived, root],
      initialEntry: derived,
      props: { compute: { presets: [{ id: 'pixel-legacy', sceneTags: ['pixel_art'] }] } },
    })
    const tree = await client.mountRaw(client.components.Workshop, mounted.props)
    const active = nodesByClass(tree, 'ofs-workshop-tool').find((tool) => tool.props['aria-pressed'] === 'true')
    assert.equal(active.props['data-tool'], 'pixel-snap')
    assert.equal(active.props['data-primary-recommend'], 'true')
  } finally {
    client.unmount()
  }
})

await check('格距自动建议：普通照片的弱周期只提示读数，不自动采用低置信度格距', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const photo = SCENE_SAMPLES.find((sample) => sample.scene === 'illustration_or_photo').image
    const mounted = workshopProps(client, { props: { initialTool: 'pixel-snap', testSourcePixels: photo } })
    const tree = await client.mountRaw(client.components.Workshop, mounted.props)
    const input = findNodes(tree, (node) => node.type === 'input' && node.props.max === WORKSHOP.pixel.grid.max)[0]
    assert.equal(input.props.value, WORKSHOP.pixel.grid.default)
    const readout = nodesByClass(tree, 'ofs-workshop-guide-readout')[0]
    assert.ok(collectText(readout).join('').includes('置信度较低'), '低置信度仍如实显示')
  } finally {
    client.unmount()
  }
})

await check('最近作品切换：像素加载前保持当前工具，避免先验推荐来回跳动', async () => {
  const photo = SCENE_SAMPLES.find((sample) => sample.scene === 'illustration_or_photo').image
  const entries = [
    {
      image: { ...sourceImage, path: 'outputs/stable-photo/01.png', url: '/stable-photo.png' },
      item: { source: 'import', channels: [] },
    },
    {
      image: { ...sourceImage, path: 'outputs/prompted-photo/01.png', url: '/prompted-photo.png' },
      item: { source: 'ai', rootPrompt: 'pixel art character', channels: [] },
    },
  ]
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const activeTool = (tree) => nodesByClass(tree, 'ofs-workshop-tool')
      .find((tool) => tool.props['aria-pressed'] === 'true')
    const mounted = workshopProps(client, {
      gallery: entries,
      initialEntry: entries[0],
      props: { testSourcePixels: photo },
    })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    assert.equal(activeTool(tree).props['data-tool'], 'cutout')

    mounted.props.testSourcePixels = null
    nodesByClass(tree, 'ofs-workshop-work')[1].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(
      activeTool(tree).props['data-tool'],
      'cutout',
      '最近作品像素尚未加载时不能先按提示词切到另一个工具',
    )

    mounted.props.testSourcePixels = photo
    tree = await client.rerenderRaw()
    assert.equal(activeTool(tree).props['data-tool'], 'cutout', '新图到位后只采用最终图像推荐')
  } finally {
    client.unmount()
  }
})

// ── 13. L2 渐进融合（M4.2c Phase 2）─────────────────────────────────────

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** 构造 Host `/api/workshop/perceive` 的成功响应体。 */
function visionResponse(scene = 'sprite_sheet', top = 0.82) {
  const sceneProbs = Object.fromEntries(WORKSHOP.scenes.map((name) => [name, 0]))
  sceneProbs[scene] = top
  const rest = WORKSHOP.scenes.filter((name) => name !== scene)
  for (const name of rest) sceneProbs[name] = (1 - top) / rest.length
  return {
    ok: true,
    perception: {
      source: 'l2-onnx-vision',
      model: 'mobileclip-s0-fp16',
      latencyMs: 36,
      scene,
      sceneProbs,
      confidence: { scene, top, margin: top - Math.max(...rest.map((name) => sceneProbs[name])) },
      noul: {
        needsCutout: 0.1,
        isGridSprite: 0.1,
        isPixelGrid: 0.1,
        isTileable: 0.1,
        isVectorFriendly: 0.1,
        wantsPbr: 0.1,
      },
      professionalScore: 0.9,
      recommendedTools: toolsForScene(scene),
      showStudioReturnHint: false,
      reasonKey: `studio.workshop.scene.reason.${scene}`,
      reasonParams: { scene, score: 0.9 },
      features: null,
      derived: { doneTools: [], hasTransparency: false, priorTool: null },
    },
  }
}

const activeToolOf = (tree) => nodesByClass(tree, 'ofs-workshop-tool')
  .find((node) => node.props['aria-pressed'] === 'true')

await check('L2 渐进：L1 先落焦，Host 返回后只微调一次并保留 L1 像素证据', async () => {
  const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art').image
  const gate = deferred()
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/perceive': () => gate.promise },
    testBuild: true,
  })
  try {
    const mounted = workshopProps(client, { props: { testSourcePixels: pixel } })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    assert.equal(activeToolOf(tree).props['data-tool'], 'pixel-snap', 'L2 未返回前必须已经按 L1 落焦')
    const request = client.requests.find((item) => item.path === '/api/workshop/perceive')
    assert.ok(request, '像素到位后应异步请求 Host')
    assert.equal(request.body.pixels.width, WORKSHOP.vision.imageSize)
    assert.equal(request.body.pixels.height, WORKSHOP.vision.imageSize)
    assert.equal(
      request.body.pixels.data.length,
      Math.ceil((WORKSHOP.vision.imageSize ** 2 * 3) / 3) * 4,
      '只上传 256×256 RGB base64',
    )

    gate.resolve(visionResponse('sprite_sheet'))
    await client.settle()
    tree = await client.rerenderRaw()
    assert.equal(activeToolOf(tree).props['data-tool'], 'sprite-slice', 'L2 高置信度语义可微调工具')
    const primary = nodesByClass(tree, 'ofs-workshop-tool')
      .find((node) => node.props['data-primary-recommend'] === 'true')
    assert.equal(primary.props['data-tool'], 'sprite-slice', '推荐点同步到融合结果')

    // 再渲染一次（例如展开说明）不能再次改工具：L2 只允许一次自动落焦。
    nodesByClass(tree, 'ofs-workshop-guide-trigger')[0].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(activeToolOf(tree).props['data-tool'], 'sprite-slice', 'L2 只微调一次，不反复改焦点')
    assert.equal(
      client.requests.filter((item) => item.path === '/api/workshop/perceive').length,
      1,
      '同一张图只请求一次 L2',
    )
  } finally {
    client.unmount()
  }
})

await check('L2 渐进：L2 到达前用户已手动选工具时，迟到的结果完全忽略', async () => {
  const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art').image
  const gate = deferred()
  const client = await createTestClient({
    now: NOW,
    responses: { '/api/workshop/perceive': () => gate.promise },
    testBuild: true,
  })
  try {
    const mounted = workshopProps(client, { props: { testSourcePixels: pixel } })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'vectorize').props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(activeToolOf(tree).props['data-tool'], 'vectorize')

    gate.resolve(visionResponse('sprite_sheet'))
    await client.settle()
    tree = await client.rerenderRaw()
    assert.equal(activeToolOf(tree).props['data-tool'], 'vectorize', '手动选择不能被迟到的 L2 打断')
    const primary = nodesByClass(tree, 'ofs-workshop-tool')
      .find((node) => node.props['data-primary-recommend'] === 'true')
    assert.equal(primary.props['data-tool'], 'pixel-snap', '迟到的 L2 连推荐点也不更新')
    assert.equal(mounted.uiState.toasts.length, 0, 'L2 全程无可见提示')
  } finally {
    client.unmount()
  }
})

await check('L2 渐进：换图后旧响应被丢弃，新图的 L1 落点不被污染', async () => {
  const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art').image
  const photo = SCENE_SAMPLES.find((sample) => sample.scene === 'illustration_or_photo').image
  const gate = deferred()
  let calls = 0
  const client = await createTestClient({
    now: NOW,
    responses: {
      '/api/workshop/perceive': () => {
        calls += 1
        if (calls === 1) return gate.promise
        throw new Error('second image vision failed')
      },
    },
    testBuild: true,
  })
  try {
    const entries = ['l2-pixel', 'l2-photo'].map((name) => ({
      image: { ...sourceImage, path: `outputs/${name}/01.png`, url: `/${name}.png` },
      item: { source: 'import', channels: [] },
    }))
    const mounted = workshopProps(client, {
      gallery: entries,
      initialEntry: entries[0],
      props: { testSourcePixels: pixel },
    })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    assert.equal(activeToolOf(tree).props['data-tool'], 'pixel-snap')

    mounted.props.testSourcePixels = photo
    nodesByClass(tree, 'ofs-workshop-work')[1].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(activeToolOf(tree).props['data-tool'], 'cutout', '新照片先按自己的 L1 落焦')

    // 旧图的请求现在才返回；它已随作品切换被 abort / 丢弃，不能把照片改回 sprite-slice。
    gate.resolve(visionResponse('sprite_sheet'))
    await client.settle()
    tree = await client.rerenderRaw()
    assert.equal(activeToolOf(tree).props['data-tool'], 'cutout', '换图后旧 L2 响应必须无效')
    assert.equal(calls, 2, '新图也发起了自己的 L2 请求')
  } finally {
    client.unmount()
  }
})

await check('L2 渐进：请求失败静默保留 L1，不出现 Toast / 错误状态', async () => {
  const pixel = SCENE_SAMPLES.find((sample) => sample.scene === 'pixel_art').image
  const client = await createTestClient({
    now: NOW,
    responses: {
      '/api/workshop/perceive': () => {
        throw new Error('vision offline')
      },
    },
    testBuild: true,
  })
  try {
    const mounted = workshopProps(client, { props: { testSourcePixels: pixel } })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)
    await client.settle()
    tree = await client.rerenderRaw()
    assert.equal(activeToolOf(tree).props['data-tool'], 'pixel-snap', 'L2 失败时 L1 工具保持可用')
    assert.equal(mounted.uiState.toasts.length, 0, 'L2 失败没有可见 Toast')
    assert.equal(countByClass(tree, 'ofs-workshop-status'), 0, 'L2 失败不写参数区状态行')
  } finally {
    client.unmount()
  }
})

await check('工坊控件改版：抹除背景速度/质量挡位、SVG 预设与拉帘对比、平铺诊断卡与序列帧/PBR UI', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const texture = SCENE_SAMPLES.find((sample) => sample.scene === 'seamless_texture').image
    const svgSample = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h32v32z"/><circle cx="16" cy="16" r="8"/></svg>'
    const mounted = workshopProps(client, {
      gallery: [sourceEntry],
      initialEntry: sourceEntry,
      props: { testSourcePixels: texture },
    })
    let tree = await client.mountRaw(client.components.Workshop, mounted.props)

    // 1) 抹除背景：默认本机极速；切到云端 GPU 后提供速度优先 / 质量优先切换，切到质量优先时提交 rmbg-2.0 并带警告。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'cutout').props.onClick()
    tree = await client.rerenderRaw()
    buttonByText(tree, '云端 GPU').props.onClick()
    tree = await client.rerenderRaw()
    const qualityBtn = buttonByText(tree, '质量优先')
    assert.ok(qualityBtn, '抹除背景应提供「质量优先」挡位')
    qualityBtn.props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-model-warn'), 1, '切到质量优先应展示非商用与授权提示')
    nodesByClass(tree, 'ofs-workshop-run')[0].props.onClick()
    await client.settle()
    assert.equal(mounted.actionState.ops[0].model, 'rmbg-2.0')

    // 2) SVG 矢量：精简参数（风格预设 + 分段切换 + 可折叠高级微调）+ 结果对比开关。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'vectorize').props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-adv-box'), 0, '高级微调默认折叠')
    nodesByClass(tree, 'ofs-workshop-adv-toggle')[0].props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-adv-box'), 1, '点击后展开高级微调')
    buttonByText(tree, '黑白线稿').props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(
      findNodes(tree, (n) => n.type === 'button' && n.props['data-thumb-key'] === 'binary')[0].props['aria-pressed'],
      'true',
      '点「黑白线稿」预设应同步切换到黑白模式',
    )

    // 3) 无缝平铺：双通道接缝诊断卡 + 分段切换。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'tile').props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-workshop-stat-card'), 1, '平铺工具展示接缝诊断卡')
    assert.equal(countByClass(tree, 'ofs-workshop-seam'), 1)
    assert.ok(buttonByText(tree, '边缘混边'), '平铺工具使用分段切换控制边缘混边')

    // 4) 序列帧切片：常用切分预设 + 行列对齐的 sprite 网格覆盖层。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'sprite-slice').props.onClick()
    tree = await client.rerenderRaw()
    const gridOverlay = nodesByClass(tree, 'ofs-workshop-grid')[0]
    assert.equal(gridOverlay.props['data-mode'], 'sprite', '序列帧画布网格应按行列模式绘制')
    assert.equal(countByClass(tree, 'ofs-workshop-switch'), 1, '跳过全透明帧使用工作室开关')

    // 5) PBR 材质拆解：步数滑块 + 四通道输出清单。
    nodesByClass(tree, 'ofs-workshop-tool').find((node) => node.props['data-tool'] === 'pbr').props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(countByClass(tree, 'ofs-step-slider-wrap'), 1, 'PBR 采样步数使用工作室滑块')
    assert.equal(countByClass(tree, 'ofs-workshop-output-chip'), 4, 'PBR 展示四通道输出清单')

    // 6) SVG 结果拉帘对比与指标统计。
    const vecClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
    try {
      const vecMounted = workshopProps(vecClient, {
        initialEntry: sourceEntry,
        initialResult: { tool: 'vectorize', svg: svgSample },
        props: { initialTool: 'vectorize' },
      })
      let vecTree = await vecClient.mountRaw(vecClient.components.Workshop, vecMounted.props)
      assert.equal(countByClass(vecTree, 'ofs-workshop-svg-pill'), 1, 'SVG 结果应展示路径与体积统计')
      assert.equal(countByClass(vecTree, 'ofs-workshop-compare-toggle'), 1, 'SVG 结果应提供拉帘对比入口')
      nodesByClass(vecTree, 'ofs-workshop-compare-toggle')[0].props.onClick()
      vecTree = await vecClient.rerenderRaw()
      assert.equal(countByClass(vecTree, 'ofs-compare'), 1, '开启拉帘对比后挂载 CompareSlider')
    } finally {
      vecClient.unmount()
    }
  } finally {
    client.unmount()
  }
})

summary()

