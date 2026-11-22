#!/usr/bin/env node
/**
 * 商业生图 API 的客户端回归（M3.5 Phase A）。
 *
 * 覆盖：
 *  - 设置抽屉：切到「商业生图 API」显示服务商 / 模型 / 端点 / Key，隐藏空闲关机与 HF Token；
 *  - 表单补丁：未改动不脏、换服务商重置模型与 Key 输入、清除 Key 显式提交；
 *  - 模型卡：云端预设只在 cloud-api 下可选，本地预设不在云端列表里。
 *
 * 运行：node test/check-client-cloud.mjs
 */

import assert from 'node:assert/strict'

import {
  buildImageApiPatch,
  hasAppSettingsChanges,
  imageApiFormOf,
  imageApiVendorSwitchPatch,
  normalizeAppSettingsView,
} from '../web/logic/appSettings.js'
import { defaultModelTabIdOf } from '../web/logic/preset.js'
import { createCheckRunner } from './helpers/check.mjs'
import { collectText, createTestClient, findNodes, nodesByClass } from './helpers/render.mjs'
import { NOW, appSettingsView, mountSettingsDrawer, preset, settingsView } from './helpers/client-fixtures.mjs'

const { check, summary } = createCheckRunner()

const cloudAppView = {
  ...appSettingsView,
  imageApi: {
    vendor: 'siliconflow',
    model: 'Qwen/Qwen-Image',
    baseUrl: '',
    customModel: 'my-a, my-b',
    customBaseUrl: 'https://gw.example.com/v1',
    hasApiKey: true,
    apiKeysConfigured: ['siliconflow', 'fal'],
  },
}

await check('纯逻辑：视图归一 / 未改动不脏 / 内置厂商不交模型 / 清除 Key', () => {
  const view = normalizeAppSettingsView(cloudAppView)
  assert.equal(view.imageApi.vendor, 'siliconflow')
  assert.equal(view.imageApi.hasApiKey, true)
  assert.equal(view.imageApi.customModel, 'my-a, my-b')

  const form = imageApiFormOf(view)
  assert.equal(form.apiKey, '')
  assert.equal(hasAppSettingsChanges(buildImageApiPatch(form, view)), false, '未改动不能点亮保存')

  // 切换到内置 fal：只提交 vendor，不提交内置模型 id。
  const switched = { ...form, ...imageApiVendorSwitchPatch('fal', view.imageApi) }
  assert.equal(switched.vendor, 'fal')
  assert.equal(switched.baseUrl, '')
  const vendorPatch = buildImageApiPatch(switched, view)
  assert.equal(vendorPatch.imageApi.vendor, 'fal')
  assert.equal(Object.prototype.hasOwnProperty.call(vendorPatch.imageApi, 'model'), false)

  // 切换到 custom：保留已存 customModel / customBaseUrl，修改后提交。
  const toCustom = { ...form, ...imageApiVendorSwitchPatch('custom', view.imageApi) }
  assert.equal(toCustom.model, 'my-a, my-b')
  assert.equal(toCustom.baseUrl, 'https://gw.example.com/v1')
  const customEdited = { ...toCustom, model: 'my-a, my-b, my-c' }
  const customPatch = buildImageApiPatch(customEdited, view)
  assert.equal(customPatch.imageApi.vendor, 'custom')
  assert.equal(customPatch.imageApi.model, 'my-a, my-b, my-c')

  // 清除 Key 优先于同请求的 apiKey。
  const cleared = { ...form, apiKey: 'sk-new', clearApiKey: true }
  assert.deepEqual(buildImageApiPatch(cleared, view).imageApi, { clearApiKey: true })
})

await check('渲染：设置抽屉内置厂商不显示模型选择，切到 custom 才显示模型输入', async () => {
  const view = { ...settingsView, provider: 'cloud-api' }
  const mounted = await mountSettingsDrawer({ defaultTab: 'compute' }, { view, appView: cloudAppView })
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = collectText(tree).join(' | ')
    assert.ok(text.includes('商业生图 API'), `应出现配置区标题，实际：${text}`)
    assert.ok(text.includes('硅基流动'), '应出现服务商选项')
    assert.ok(!text.includes('Qwen-Image'), '内置厂商设置区不应再渲染模型选择器')
    assert.ok(text.includes('API Key'), '应出现 Key 输入')
    assert.ok(text.includes('去生成 API Key'), '应提供直接导航生成 API Key 的链接')
    assert.ok(text.includes('修改接口地址'), '内置厂商默认应折叠隐藏接口地址输入框')
    assert.equal(findNodes(tree, (node) => node.props && node.props.type === 'url').length, 0, '默认隐藏接口地址输入框')
    assert.ok(text.includes('阶段 A 只支持文生图'), '必须说明能力边界')
    assert.ok(!text.includes('空闲自动关机'), '商业 API 不应显示空闲关机')
    assert.ok(!text.includes('HF Token'), '商业 API 不应显示 HF Token')
    const inputs = findNodes(tree, (node) => node.props && node.props.type === 'password')
    assert.ok(inputs.length >= 1, '应有 Key 密码输入框')
    assert.equal(nodesByClass(tree, 'ofs-cloud-api').length, 1)
  } finally {
    mounted.client.unmount()
  }

  const customAppView = {
    ...cloudAppView,
    imageApi: { ...cloudAppView.imageApi, vendor: 'custom', model: 'my-a, my-b', baseUrl: 'https://gw.example.com/v1' },
  }
  const mountedCustom = await mountSettingsDrawer({ defaultTab: 'compute' }, { view, appView: customAppView })
  try {
    const customTree = await mountedCustom.client.rerenderRaw()
    const customText = collectText(customTree).join(' | ')
    assert.ok(customText.includes('自定义模型 ID'), 'custom 端点应保留模型 ID 输入框')
  } finally {
    mountedCustom.client.unmount()
  }
})

await check('渲染：模型胶囊支持多服务商 Tab（方式 B）与多模态 Tab 分类', async () => {
  const cloudPresets = [
    {
      ...preset,
      id: 'cloud:siliconflow:Qwen/Qwen-Image',
      label: 'Qwen-Image',
      short: 'Qwen-Image',
      family: 'Qwen',
      category: 'image',
      providers: ['cloud-api'],
      cloud: { vendor: 'siliconflow', model: 'Qwen/Qwen-Image', estCostPerImage: 0.05, supportsNegative: true, supportsSteps: true },
    },
    {
      ...preset,
      id: 'cloud:fal:fal-ai/flux/schnell',
      label: 'FLUX.1 schnell',
      short: 'FLUX.1 schnell',
      family: 'FLUX',
      category: 'image',
      providers: ['cloud-api'],
      cloud: { vendor: 'fal', model: 'fal-ai/flux/schnell', estCostPerImage: 0.02, supportsNegative: false, supportsSteps: false },
    },
  ]
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const openedSettings = []
  const t = client.internals.i18n.fallbackTranslate('zh')
  const initialTree = await client.mountRaw(client.components.ModelCardPicker, {
    t,
    isEn: false,
    presets: [preset, ...cloudPresets],
    value: cloudPresets[0].id,
    defaultPreset: cloudPresets[0].id,
    provider: 'cloud-api',
    imageApi: { apiKeysConfigured: ['siliconflow'] },
    open: true,
    onOpenChange: () => {},
    onOpenSettings: (target) => openedSettings.push(target),
    onChange: () => {},
  })
  const initialTabs = nodesByClass(initialTree, 'ofs-model-tab')
  assert.equal(initialTabs.length, 4, '应渲染：全部 / 本地 · GPU / 硅基流动 / fal.ai')
  const sfTab = initialTabs.find((n) => collectText(n).join('').includes('硅基流动'))
  assert.equal(sfTab.props['aria-selected'], 'true', '选择商业 API 时打开默认展开对应服务商 Tab')
  // 切到「全部」Tab 查看全部模型：
  initialTabs[0].props.onClick()
  const tree = await client.rerenderRaw()
  const options = nodesByClass(tree, 'ofs-model-option')
  assert.equal(options.length, 3, '应同时列出本地与全部商业 API 模型')
  const sfOption = options.find((n) => n.props['data-preset-id'] === 'cloud:siliconflow:Qwen/Qwen-Image')
  const falOption = options.find((n) => n.props['data-preset-id'] === 'cloud:fal:fal-ai/flux/schnell')
  assert.equal(sfOption.props['aria-disabled'], undefined, '已配 Key 的硅基流动模型应可选')
  assert.equal(falOption.props['aria-disabled'], 'true', '未配 Key 的 fal 模型应置灰')
  const tabs = nodesByClass(tree, 'ofs-model-tab')
  assert.equal(tabs.length, 4, '应渲染：全部 / 本地 · GPU / 硅基流动 / fal.ai')
  const fullText = collectText(tree).join(' ')
  assert.ok(fullText.includes('硅基流动') && fullText.includes('fal.ai'), '卡片应标注对应服务商名称')
  assert.ok(fullText.includes('未配 Key'), '未配 Key 的服务商模型应显示未配 Key 角标')
  assert.ok(fullText.includes('约 ¥0.05/张'), '模型卡应显示预估单价')

  // 点击未配 Key 的 fal 模型：弹出引导提示与「前往设置」按钮，点按钮跳转到设置页。
  falOption.props.onClick()
  const afterClick = await client.rerenderRaw()
  const notice = nodesByClass(afterClick, 'ofs-model-notice')
  assert.equal(notice.length, 1, '点击置灰模型应弹出提示条')
  assert.ok(collectText(notice[0]).join(' ').includes('fal.ai'), '提示应指明需要配置哪家 Key')
  const goBtn = nodesByClass(afterClick, 'ofs-model-notice-btn')[0]
  assert.ok(goBtn, '提示条应提供前往设置按钮')
  goBtn.props.onClick()
  assert.equal(openedSettings.length, 1)
  assert.equal(openedSettings[0].cloud.vendor, 'fal')
  client.unmount()

  // 多模态 presets（如 M4 接入视频 + 游戏·UI）自动切换为主模态 Tab。
  const multiModalPresets = [
    cloudPresets[0],
    { ...cloudPresets[1], id: 'video-wan', category: 'video', mediaType: 'video', label: 'Wan 2.2', short: 'Wan 2.2' },
    { ...cloudPresets[1], id: 'game-tile', category: 'game', mediaType: 'image', label: 'Game Tile', short: 'Game Tile' },
  ]
  const modalTree = await client.mountRaw(client.components.ModelCardPicker, {
    t,
    isEn: false,
    presets: multiModalPresets,
    value: multiModalPresets[0].id,
    defaultPreset: multiModalPresets[0].id,
    provider: 'cloud-api',
    open: true,
    onOpenChange: () => {},
    onChange: () => {},
  })
  const modalTabLabels = nodesByClass(modalTree, 'ofs-model-tab').map((n) => collectText(n).join(' '))
  assert.ok(modalTabLabels.some((s) => s.includes('视频')), `应有视频分类 Tab，实际：${modalTabLabels.join(', ')}`)
  assert.ok(modalTabLabels.some((s) => s.includes('游戏')), `应有游戏·UI分类 Tab，实际：${modalTabLabels.join(', ')}`)
  client.unmount()
})

await check('交互：已接入 Colab 与商业 API 时，跨来源模型不置灰且点选自动附带 switchToProvider', async () => {
  const localColabPreset = {
    ...preset,
    id: 'flux2-klein-9b',
    label: 'FLUX.2 Klein 9B',
    short: 'Klein 9B',
    providers: ['colab'],
  }
  const sfPreset = {
    ...preset,
    id: 'cloud:siliconflow:Qwen/Qwen-Image',
    label: 'Qwen-Image',
    short: 'Qwen-Image',
    family: 'Qwen',
    providers: ['cloud-api'],
    cloud: { vendor: 'siliconflow', model: 'Qwen/Qwen-Image', estCostPerImage: 0.3, supportsNegative: true, supportsSteps: true },
  }
  const falPreset = {
    ...preset,
    id: 'cloud:fal:fal-ai/flux/schnell',
    label: 'FLUX.1 schnell',
    short: 'FLUX.1 schnell',
    family: 'FLUX.1',
    providers: ['cloud-api'],
    cloud: { vendor: 'fal', model: 'fal-ai/flux/schnell', estCostPerImage: 0.02, supportsNegative: false, supportsSteps: false },
  }
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const picks = []

  // 场景 A：当前在 cloud-api，Colab 已授权接入 → 默认打开硅基流动 Tab；切回全部/本地时 Colab 模型不置灰，点选携带 switchToProvider='colab'
  const initTreeA = await client.mountRaw(client.components.ModelCardPicker, {
    t,
    isEn: false,
    presets: [preset, localColabPreset, sfPreset],
    value: sfPreset.id,
    defaultPreset: sfPreset.id,
    provider: 'cloud-api',
    configuredProviders: ['cloud-api', 'colab'],
    imageApi: { apiKeysConfigured: ['siliconflow'] },
    open: true,
    onOpenChange: () => {},
    onChange: (next, meta) => picks.push({ id: next.id, meta }),
  })
  nodesByClass(initTreeA, 'ofs-model-tab')[0].props.onClick()
  const treeA = await client.rerenderRaw()
  const colabNode = nodesByClass(treeA, 'ofs-model-option').find((n) => n.props['data-preset-id'] === 'flux2-klein-9b')
  assert.equal(colabNode.props['aria-disabled'], undefined, 'Colab 已接入时，商业 API 下不得把 Colab 模型置灰')
  colabNode.props.onClick()
  assert.deepEqual(picks[0], { id: 'flux2-klein-9b', meta: { switchToProvider: 'colab' } })
  client.unmount()

  // 场景 B：当前在 colab → 默认展开「本地 / GPU」Tab；切到「全部」时，硅基流动已配 Key 不置灰、fal 未配 Key 仍置灰
  const picksB = []
  const initTreeB = await client.mountRaw(client.components.ModelCardPicker, {
    t,
    isEn: false,
    presets: [localColabPreset, sfPreset, falPreset],
    value: localColabPreset.id,
    defaultPreset: localColabPreset.id,
    provider: 'colab',
    configuredProviders: ['colab', 'cloud-api'],
    imageApi: { apiKeysConfigured: ['siliconflow'] },
    open: true,
    onOpenChange: () => {},
    onChange: (next, meta) => picksB.push({ id: next.id, meta }),
  })
  const localTabB = nodesByClass(initTreeB, 'ofs-model-tab').find((n) => collectText(n).join('').includes('本地'))
  assert.equal(localTabB.props['aria-selected'], 'true', 'Colab 来源下打开默认展开本地 / GPU Tab')
  nodesByClass(initTreeB, 'ofs-model-tab')[0].props.onClick()
  const treeB = await client.rerenderRaw()
  const sfNode = nodesByClass(treeB, 'ofs-model-option').find((n) => n.props['data-preset-id'] === sfPreset.id)
  const falNode = nodesByClass(treeB, 'ofs-model-option').find((n) => n.props['data-preset-id'] === falPreset.id)
  assert.equal(sfNode.props['aria-disabled'], undefined, '已配 Key 的商业 API 模型在 Colab 下也应直接可选')
  assert.equal(falNode.props['aria-disabled'], 'true', '未配 Key 的服务商仍应置灰')
  sfNode.props.onClick()
  assert.deepEqual(picksB[0], { id: sfPreset.id, meta: { switchToProvider: 'cloud-api' } })
  client.unmount()

  // 默认 Tab 自动定位：cloud-api 展开对应厂商 Tab，本地 GPU 来源展开本地 Tab。
  const sampleTabs = [
    { id: 'all', kind: 'all' },
    { id: 'scope:local', kind: 'local' },
    { id: 'vendor:siliconflow', kind: 'vendor', value: 'siliconflow' },
    { id: 'vendor:openai', kind: 'vendor', value: 'openai' },
  ]
  assert.equal(defaultModelTabIdOf(sampleTabs, { provider: 'cloud-api', active: sfPreset }), 'vendor:siliconflow')
  assert.equal(
    defaultModelTabIdOf(sampleTabs, { provider: 'cloud-api', active: null, imageApi: { vendor: 'openai' } }),
    'vendor:openai',
  )
  assert.equal(defaultModelTabIdOf(sampleTabs, { provider: 'colab', active: localColabPreset }), 'scope:local')
  assert.equal(defaultModelTabIdOf(sampleTabs, { provider: 'kaggle', active: preset }), 'scope:local')
})

await check('渲染：TopBar 在商业 API 下隐藏连接/断开与探测按钮，展示计费信息', async () => {
  const sfPreset = {
    ...preset,
    id: 'cloud:siliconflow:Qwen/Qwen-Image',
    label: 'Qwen-Image',
    short: 'Qwen-Image',
    family: 'Qwen',
    providers: ['cloud-api'],
    cloud: { vendor: 'siliconflow', model: 'Qwen/Qwen-Image', estCostPerImage: 0.3, supportsNegative: true, supportsSteps: true },
  }
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const t = client.internals.i18n.fallbackTranslate('zh')
  const tree = await client.mountRaw(client.components.TopBar, {
    t,
    isEn: false,
    defaultOpen: true,
    ui: { view: 'studio', setView: () => {}, openLogs: () => {}, openSettings: () => {} },
    form: { form: { presetId: sfPreset.id, count: 2 }, patchForm: () => {}, selectPreset: () => {} },
    library: { items: [] },
    compute: {
      provider: 'cloud-api',
      presets: [sfPreset, preset],
      session: { state: 'ready', provider: 'colab', device: 'NVIDIA L4' },
      sessionState: 'ready',
      imageApi: { vendor: 'siliconflow', hasApiKey: true, apiKeysConfigured: ['siliconflow'] },
      startSession: () => {},
      stopSession: () => {},
      runProbe: () => {},
    },
  })
  const text = collectText(tree).join(' | ')
  assert.ok(text.includes('商业 API 计费'), `应显示计费标题，实际：${text}`)
  assert.ok(text.includes('¥0.30/张') && text.includes('2 张 ¥0.60'), `应显示单价与本次预估计费，实际：${text}`)
  assert.ok(!text.includes('NVIDIA L4'), '切到商业 API 后不得串显后台 Colab GPU 型号')
  assert.equal(nodesByClass(tree, 'ofs-popover-btn-grid').length, 0, '商业 API 不应渲染连接/断开按钮栏')
  assert.ok(!text.includes('检查环境'), '商业 API 不应渲染检查环境按钮')
  assert.equal(nodesByClass(tree, 'ofs-popover-fallback').length, 0, '商业 API 不应渲染 Kaggle 配额回退区块')
  client.unmount()
})

summary()
