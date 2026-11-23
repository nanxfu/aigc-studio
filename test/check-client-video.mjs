#!/usr/bin/env node
/**
 * 视频产物界面与抽帧逻辑的离线回归（M4.1 / M4.2）。
 *
 * 覆盖：
 *  - 纯逻辑：`web/logic/video.js` 的目标时刻 / 产物命名 / 画布尺寸 / 可抽帧判定；
 *  - 纯逻辑：视频预设的切换补丁（mediaType / duration / resolution）与请求体形状；
 *  - 渲染：舞台选中视频作品时用原生 `<video controls>` 播放、动作坞让位给抽帧条、
 *    题注展示片长而不是生成耗时；视频模型下左栏参数区换成「视频参数」。
 *
 * 运行：node test/check-client-video.mjs（渲染段需要 `npm run build:test` 产物，
 * 由 createTestClient 按需重建）。
 */

import assert from 'node:assert/strict'

import { fallbackTranslate } from '../web/i18n.js'
import {
  canCaptureFrameOf,
  frameCanvasSize,
  frameNameOf,
  frameSeekOf,
} from '../web/logic/video.js'
import { creationModeOf, modePresetCandidateOf, presetSelectPatch } from '../web/logic/preset.js'
import { buildGenerateBody } from '../web/logic/generate.js'
import { referenceSwap } from '../web/logic/reference.js'
import { cloudVideoPresetOf } from '../shared/image-providers.js'
import { createCheckRunner } from './helpers/check.mjs'
import { createTestClient } from './helpers/render.mjs'
import { collectText, findNodes } from './helpers/render.mjs'
import { NOW } from './helpers/client-fixtures.mjs'

const { check, summary } = createCheckRunner()
const t = fallbackTranslate('zh')

function classNameOf(node) {
  return String((node && node.props && node.props.className) || '')
}

function nodesByClassToken(tree, token) {
  return findNodes(tree, (node) => classNameOf(node).split(/\s+/).includes(token))
}

/** 视频作品：与宿主 `/state.lastJob.output` / `/history` 条目同形。 */
const VIDEO_IMAGE = {
  path: 'outputs/20261123-091500-j_1a2b3c4d/01.mp4',
  file: '01.mp4',
  url: '/api/file?path=outputs%2F20261123-091500-j_1a2b3c4d%2F01.mp4',
  mediaType: 'video',
  width: 864,
  height: 480,
  seed: 7,
  seconds: 389.2,
  duration: 5,
}
const VIDEO_ITEM = {
  jobId: 'j_1a2b3c4d',
  prompt: 'a paper boat drifting on a pond',
  presetId: 'cloud:siliconflow:MiniMaxAI/MiniMax-H3',
  provider: 'cloud-api',
  device: 'siliconflow',
  mediaType: 'video',
  images: [VIDEO_IMAGE],
  params: { prompt: 'a paper boat drifting on a pond', width: 864, height: 480, duration: 5, resolution: '480p', seed: 7 },
}

/** 舞台最小假域对象（字段与 import-client 的 harness 同口径，只保留本次读到的）。 */
function stageHarness(items = {}) {
  const calls = { imported: [] }
  const base = {
    t,
    ui: {
      zoom: false,
      setZoom: () => {},
      copyPath: () => {},
      showToast: () => {},
      compareOpen: false,
      setCompareOpen: () => {},
    },
    compute: { activeJob: null, status: {}, presets: [] },
    form: { useInspiration: () => {}, form: { width: 1024, height: 1024, presetId: 'sdxl-lightning' } },
    library: {
      gallery: [],
      selected: null,
      workspaceMode: 'work',
      newDraftCard: {},
      isFavorite: () => false,
      toggleFavorite: () => {},
    },
    imageTool: null,
    actions: {
      reroll: () => {},
      openImageTool: () => {},
      activateImport: () => {},
      importFrame: (payload) => calls.imported.push(payload),
    },
    now: NOW,
  }
  return {
    props: {
      ...base,
      ...items,
      ui: { ...base.ui, ...(items.ui || {}) },
      library: { ...base.library, ...(items.library || {}) },
      actions: { ...base.actions, ...(items.actions || {}) },
    },
    calls,
  }
}

// ── 1. 抽帧纯逻辑 ─────────────────────────────────────────────
await check('抽帧逻辑：目标时刻 / 产物命名 / 画布尺寸 / 可抽帧判定', () => {
  assert.equal(frameSeekOf('first', 5.16), 0)
  assert.equal(frameSeekOf('last', 5.16), 5.1, '尾帧留 60ms 余量，避免落在最后一帧之后')
  assert.equal(frameSeekOf('last', 0), 0, '片长未知时退回首帧')
  assert.equal(frameSeekOf('last', null), 0)
  assert.equal(frameSeekOf('first', null), 0)

  assert.equal(frameNameOf('clip.mp4', 'first'), 'clip-首帧.png')
  assert.equal(frameNameOf('outputs/a/01.mp4', 'last'), '01-尾帧.png')
  assert.equal(frameNameOf('01.mp4', 'last', { zh: false }), '01-last-frame.png')
  assert.equal(frameNameOf('', 'first'), 'clip-首帧.png', '缺文件名时给稳定兜底')

  assert.deepEqual(frameCanvasSize(864, 480), { width: 864, height: 480 })
  assert.deepEqual(frameCanvasSize(2048, 1024), { width: 1536, height: 768 }, '长边超导入上限时等比缩小')
  assert.deepEqual(frameCanvasSize(0, 480), { width: 0, height: 0 }, '尺寸未知时不做画布')
  assert.deepEqual(frameCanvasSize(1024, 512, { maxEdge: 512 }), { width: 512, height: 256 })

  assert.equal(canCaptureFrameOf(VIDEO_IMAGE), true)
  assert.equal(canCaptureFrameOf({ mediaType: 'image', url: '/api/file?path=x' }), false)
  assert.equal(canCaptureFrameOf({ mediaType: 'video' }), false, '没有可播放地址不能抽帧')
  assert.equal(canCaptureFrameOf(null), false)
})

// ── 2. 视频预设的表单与请求体 ─────────────────────────────────
await check('视频预设：切换补丁写入 mediaType / 时长 / 分辨率，请求体不带步数与 CFG', () => {
  const preset = cloudVideoPresetOf('siliconflow', 'MiniMaxAI/MiniMax-H3')
  const patch = presetSelectPatch(preset, { presetId: '', width: 1024, height: 1024 }, [preset])
  assert.equal(patch.presetId, preset.id)
  assert.equal(patch.mediaType, 'video')
  assert.equal(patch.ratio, '1:1', '能匹配当前画幅时保留对应比例，否则用默认比例')
  assert.equal(patch.steps, 0)
  assert.equal(patch.cfg, 0)
  assert.equal(patch.count, 1, '视频固定单条')
  assert.equal(patch.duration, 5, '缺省取模型默认时长')
  assert.equal(patch.resolution, '768p', '缺省取模型默认分辨率')

  // 用户在视频档位里已经选了合法值（含 21:9）时不被重置。
  const kept = presetSelectPatch(preset, { presetId: preset.id, ratio: '21:9', duration: 12, resolution: '480p' }, [preset])
  assert.equal(kept.ratio, '21:9')
  assert.equal(kept.duration, 12)
  assert.equal(kept.resolution, '480p')

  // 切回图片模型时清掉视频参数，避免把 15 秒时长或 21:9 留在图片请求里。
  const back = presetSelectPatch({ id: 'sdxl-lightning', size: 1024, steps: 4, cfg: 0, mediaType: 'image' }, { presetId: preset.id, ratio: '21:9', duration: 12, resolution: '480p' }, [preset])
  assert.equal(back.mediaType, 'image')
  assert.equal(back.ratio, '')
  assert.equal(back.duration, null)
  assert.equal(back.resolution, '')

  const body = buildGenerateBody(
    { prompt: 'a paper boat', presetId: preset.id, mediaType: 'video', ratio: '21:9', width: 1536, height: 768, steps: 20, cfg: 3.5, count: 4, duration: 10, resolution: '480p', seed: '' },
    { defaultPreset: preset.id },
  )
  assert.equal(body.presetId, preset.id)
  assert.equal(body.ratio, '21:9', '请求体携带显式 ratio，不被 clampSize 误判成 16:9')
  assert.equal(body.steps, 0)
  assert.equal(body.cfg, 0)
  assert.equal(body.count, 1)
  assert.equal(body.duration, 10)
  assert.equal(body.resolution, '480p')

  // 固定时长模型（Wan 系列）不写 duration 字段。
  const fixed = cloudVideoPresetOf('siliconflow', 'Wan-AI/Wan2.2-I2V-A14B')
  const fixedBody = buildGenerateBody(
    { prompt: 'x', presetId: fixed.id, mediaType: 'video', width: 720, height: 1280, duration: null, resolution: '' },
    { defaultPreset: fixed.id },
  )
  assert.equal(Object.prototype.hasOwnProperty.call(fixedBody, 'duration'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(fixedBody, 'resolution'), false)

  // 首尾帧对调与模式切换候选解析。
  const swapped = referenceSwap(['outputs/a/01.png', 'outputs/b/02.png'])
  assert.deepEqual(swapped.map((item) => item.path), ['outputs/b/02.png', 'outputs/a/01.png'])
  const imgPreset = { id: 'sdxl-lightning', mediaType: 'image' }
  assert.equal(creationModeOf(preset, {}), 'video')
  assert.equal(creationModeOf(imgPreset, {}), 'image')
  assert.equal(modePresetCandidateOf([imgPreset, preset], 'video')?.id, preset.id)
  assert.equal(modePresetCandidateOf([imgPreset, preset], 'image', { defaultPreset: 'sdxl-lightning' })?.id, 'sdxl-lightning')

  // 回归（2026-11-23）：切视频工作台时 `modePresetCandidateOf` 会带着当前算力来源调用
  // `presetAvailableForProvider`。该判定在 `web/logic/preset.js` 里曾经只 `export ... from`
  // 而未 import（纯 re-export 不建立本地绑定），运行到候选解析时抛
  // `ReferenceError: presetAvailableForProvider is not defined`，表现为顶栏切「视频」无反应、
  // 只在渲染进程日志里留一行报错。离线用例此前都没传 provider，所以漏检。
  const kaggleOnly = { id: 'kaggle-only', mediaType: 'image', providers: ['kaggle'] }
  const colabOnly = { id: 'colab-only', mediaType: 'image', providers: ['colab'] }
  assert.equal(
    modePresetCandidateOf([kaggleOnly, preset], 'image', { defaultPreset: 'kaggle-only', provider: 'kaggle' })?.id,
    'kaggle-only',
    '默认模型在当前来源可用时应保持选中（模块内必须能直接调用来源判定）',
  )
  assert.equal(
    modePresetCandidateOf([colabOnly, kaggleOnly], 'image', { provider: 'kaggle' })?.id,
    'kaggle-only',
    '没有默认模型时优先挑当前算力来源可运行的模型',
  )
})

// ── 3. 渲染：舞台播放与抽帧入口 ───────────────────────────────
await check('Stage：视频作品用原生播放器、动作坞让位抽帧条、题注展示片长', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const localT = client.internals.i18n.fallbackTranslate('zh')
  const harness = stageHarness({
    library: {
      selected: { image: VIDEO_IMAGE, item: VIDEO_ITEM },
      gallery: [{ image: VIDEO_IMAGE, item: VIDEO_ITEM }],
      workspaceMode: 'work',
      newDraftCard: {},
      isFavorite: () => false,
      toggleFavorite: () => {},
    },
    t: localT,
  })
  try {
    const tree = await client.mountRaw(client.components.Stage, harness.props)
    const videos = findNodes(tree, (node) => node.type === 'video')
    assert.equal(videos.length, 1, '舞台应渲染一个 <video>')
    assert.equal(videos[0].props.src, VIDEO_IMAGE.url)
    assert.equal(videos[0].props.controls, true, '原生播放器要带控制条')
    assert.equal(videos[0].props.autoPlay, true)

    assert.equal(nodesByClassToken(tree, 'ofs-dock').length, 0, '视频没有重绘/扩图语义，动作坞不出现')

    const captures = nodesByClassToken(tree, 'ofs-video-capture')
    assert.equal(captures.length, 2, '抽帧条给首帧 / 尾帧两个入口')
    const labels = captures.map((node) => collectText(node).join(''))
    assert.deepEqual(labels, ['取首帧', '取尾帧'])

    const meta = nodesByClassToken(tree, 'ofs-stage-meta')[0]
    // collectText 会把 JSX 里的排版空白也拼进来，先归一空白再断言读数。
    const metaText = collectText(meta).join(' ').replace(/\s+/g, ' ')
    assert.ok(metaText.includes('864 × 480'), `题注应展示真实像素：${metaText}`)
    assert.ok(metaText.includes('5 秒'), `题注应展示片长：${metaText}`)
    assert.equal(metaText.includes('389'), false, '不把生成耗时当片长展示')
  } finally {
    client.unmount()
  }
})

// ── 4. 渲染：视频左栏参数准确率、首尾帧角色与导演取景框 ──────────
await check('视频工作台：左栏显示 21:9 画幅与首尾帧标记、直出视频规格；舞台切为导演取景框', async () => {
  const videoPreset = cloudVideoPresetOf('siliconflow', 'MiniMaxAI/MiniMax-H3')
  const imagePreset = { id: 'sdxl-lightning', label: 'SDXL Lightning', short: 'Lightning', mediaType: 'image', size: 1024, steps: 4, cfg: 0 }
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const localT = client.internals.i18n.fallbackTranslate('zh')

  // 4.1 顶栏创作入口：下拉菜单选择类型，保留画廊并列导航。
  const switched = []
  const views = []
  const topTree = await client.mountRaw(client.components.TopBar, {
    t: localT,
    isEn: false,
    ui: { view: 'studio', setView: (view) => views.push(view), openLogs: () => {}, openSettings: () => {}, showToast: () => {} },
    compute: { presets: [imagePreset, videoPreset], defaultPreset: imagePreset.id, provider: 'cloud-api', status: { tone: 'ok', label: '就绪' } },
    form: { form: { presetId: imagePreset.id, mediaType: 'image' }, creationMode: 'image', patchForm: () => {}, selectPreset: () => {} },
    library: {},
    actions: { switchCreationMode: (mode) => switched.push(mode), applyModePreset: () => {} },
  })
  const creationTrigger = findNodes(topTree, (node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu')[0]
  assert.ok(creationTrigger, '创作导航应打开类型菜单')
  creationTrigger.props.onClick()
  let openedTree = await client.rerenderRaw()
  const creationMenu = nodesByClassToken(openedTree, 'ofs-creation-menu')[0]
  assert.ok(creationMenu, '创作菜单应展开')
  const modeItems = findNodes(creationMenu, (node) => node.props?.role === 'menuitemradio')
  assert.equal(modeItems.length, 2, '当前可用图片和视频类型都应出现')
  assert.equal(modeItems[0].props['aria-checked'], true, '当前图片类型应有选中状态')
  modeItems[1].props.onClick()
  await client.rerenderRaw()
  assert.deepEqual(switched, ['video'])
  assert.deepEqual(views, ['studio'])
  client.unmount()

  // 4.2 左栏视频表单：显示 21:9、无自定义像素宽高、视频规格默认直接展开、首尾帧带角标与对调且过滤视频作品
  const swappedCalls = []
  const railTree = await client.mountRaw(client.components.Rail, {
    t: localT,
    embedded: true,
    ui: {
      advancedOpen: false,
      setAdvancedOpen: () => {},
      negativeOpen: false,
      setNegativeOpen: () => {},
      panelMode: 'form',
      setPanelMode: () => {},
    },
    compute: { presets: [imagePreset, videoPreset], provider: 'cloud-api' },
    library: {
      gallery: [
        { image: VIDEO_IMAGE, item: VIDEO_ITEM },
        { image: { path: 'outputs/a/01.png', url: '/api/file?path=outputs/a/01.png', width: 1024, height: 1024 }, item: { prompt: 'img' } },
      ],
    },
    actions: {
      sending: false,
      generate: () => {},
      swapReferences: () => swappedCalls.push('swap'),
    },
    form: {
      form: {
        prompt: 'a paper boat',
        negative: '',
        presetId: videoPreset.id,
        mediaType: 'video',
        ratio: '21:9',
        width: 1536,
        height: 768,
        duration: 8,
        resolution: '768p',
        seed: '',
        count: 1,
        references: [
          { path: 'outputs/a/01.png', url: '/api/file?path=outputs/a/01.png', width: 1024, height: 1024, name: '01.png' },
          { path: 'outputs/b/02.png', url: '/api/file?path=outputs/b/02.png', width: 1024, height: 1024, name: '02.png' },
        ],
      },
      patchForm: () => {},
      ratioId: '',
      activePreset: videoPreset,
      applyRatio: () => {},
      applyCustomSize: () => {},
      applyCfg: () => {},
      resetSeed: () => {},
      negativeActive: false,
      negativeHint: '',
      refineGroups: [],
      refineOriginPrompt: '',
      refineSelectedIds: [],
      refineNotice: null,
      englishPromptHint: false,
      referenceSupported: true,
      referenceSwitchLabel: '',
      referenceMax: 2,
    },
  })
  const railText = collectText(railTree).join(' ')
  assert.ok(railText.includes('21:9'), '视频画幅区应提供模型支持的 21:9 比例')
  assert.ok(railText.includes('跟随首帧'), '挂载首帧时应明确提示画幅跟随首帧')
  assert.equal(nodesByClassToken(railTree, 'ofs-custom-toggle').length, 0, '视频模式不应出现自定义像素宽高开关')
  assert.ok(nodesByClassToken(railTree, 'ofs-step-slider').length > 0, '视频时长滑杆应直接展示，不埋在折叠高级区里')
  const roleBadges = nodesByClassToken(railTree, 'ofs-ref-role-badge').map((n) => collectText(n).join(''))
  assert.deepEqual(roleBadges, ['首帧', '尾帧'], '首尾帧缩略图应显式标注角色')
  const swapBtn = nodesByClassToken(railTree, 'ofs-ref-swap')[0]
  assert.ok(swapBtn, '挂载两张帧图时应提供对调首尾按钮')
  swapBtn.props.onClick()
  assert.deepEqual(swappedCalls, ['swap'])
  const pickWorks = nodesByClassToken(railTree, 'ofs-ref-work')
  assert.equal(pickWorks.length, 0, '已选 2 张满额且作品列表中唯一非视频图已在槽中，且不应列出 .mp4 视频作品')
  client.unmount()

  // 4.3 视频空态与等待态舞台：导演取景框 + 动态模式提示
  const stageHarnessDraft = stageHarness({
    t: localT,
    compute: { activeJob: { id: 'j_v', mediaType: 'video', params: { ratio: '21:9' } }, status: {}, presets: [videoPreset] },
    form: {
      useInspiration: () => {},
      form: {
        presetId: videoPreset.id,
        mediaType: 'video',
        ratio: '21:9',
        duration: 8,
        resolution: '768p',
        references: [{ path: 'outputs/a/01.png', url: '/api/file?path=outputs/a/01.png', width: 1024, height: 1024 }],
      },
    },
    library: { workspaceMode: 'new_draft', newDraftCard: { explicit: true, pending: true } },
  })
  const stageTree = await client.mountRaw(client.components.Stage, stageHarnessDraft.props)
  assert.equal(nodesByClassToken(stageTree, 'ofs-frame--video').length, 1, '视频草稿/等待态应渲染导演取景框')
  assert.equal(nodesByClassToken(stageTree, 'is-video-timeline').length, 1, '视频生成等待态应展示时间线进度条')
  const hudText = collectText(nodesByClassToken(stageTree, 'ofs-video-hud')[0]).join(' ')
  assert.ok(hudText.includes('首帧生视频'), `取景框 HUD 应展示当前模式，实际：${hudText}`)
  client.unmount()
})

summary()
