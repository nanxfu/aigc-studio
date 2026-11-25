#!/usr/bin/env node
/**
 * 本机 GPU 架构收敛与算力分组客户端回归（不需要浏览器）。
 *
 * 覆盖：
 *  1. 设置抽屉「算力来源」按三大心智分组渲染（云端 GPU / 云 API / 私有部署），
 *     选择「本机 GPU」后渲染专属路径/策略/探测面板，不再与「私有 Worker」混用；
 *  2. 本机 GPU 探测与保存走 `/api/local-gpu/probe` 与 `/api/local-gpu/config`；
 *  3. 顶栏与算力弹层在 `local-gpu` 下显示本机显卡、发动机与权重状态，不串出远程地址/Token 或 Kaggle 配额；
 *  4. 模型卡（ModelCardPicker）统一「开源模型」不重复拆 Tab，按当前 provider 决定是否展示
 *     本机硬件预测分组，支持从云端自动切到 `local-gpu`，并在 `local-gpu` 下对可运行但未配
 *     权重的模型保留本机配置提示；
 *  5. 算力弹层（ComputePopover）支持直接切换后端，跨后端切换时同步状态并提示后台旧会话；
 *  6. `generateCapabilityOf` 拦截未声明/未映射 `local-gpu` 的模型，映射后放行。
 *
 * 运行：node test/check-client-local-gpu.mjs
 */

import assert from 'node:assert/strict'

import { evaluateDeviceCapability, matchGpuProfile } from '../shared/gpu-benchmark.js'
import { generateCapabilityOf } from '../web/logic/generate.js'
import { createCheckRunner } from './helpers/check.mjs'
import { collectText, createTestClient, nodesByClass } from './helpers/render.mjs'
import {
  NOW,
  mountSettingsDrawer,
  mountTopBarExpanded,
  preset,
  settingsView,
} from './helpers/client-fixtures.mjs'

const { check, summary } = createCheckRunner()

const textOf = (tree) => collectText(tree).join(' | ')

const localGpuPreset = {
  ...preset,
  id: 'realvisxl-lightning',
  label: 'RealVisXL V5 Lightning',
  short: 'RealVisXL',
  providers: ['local-gpu'],
  steadySeconds: 43.76,
}

const hwEval = evaluateDeviceCapability(matchGpuProfile({ presetId: 'amd-radeon-880m-apu' }), { diskFreeGb: 100 })
const mockHardware = { evaluation: hwEval }

await check('设置页：算力来源分三组呈现，本机 GPU 独立配置并支持探测与保存', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    {
      view: { ...settingsView, provider: 'local-gpu' },
      localGpuView: {
        ok: true,
        configured: true,
        errors: [],
        source: 'file',
        overrideByEnv: false,
        configPath: 'C:/Users/test/AppData/Roaming/aigc-studio/local-gpu.json',
        serverPath: 'D:/aigc-local/bin/sd-server.exe',
        modelPath: 'D:/aigc-local/models/realvisxl-v5.0-lightning-Q4_K.gguf',
        vaePath: '',
        modelName: 'realvisxl-v5.0-lightning-Q4_K.gguf',
        models: {},
        configuredPresets: ['realvisxl-lightning'],
        paramsBackend: 'disk',
        threads: 0,
        idleTimeoutSec: 300,
        vaeTiling: true,
      },
    },
  )
  try {
    let tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('云端 GPU') && text.includes('云 API') && text.includes('私有部署'), '应按三大心智分类渲染算力来源')
    assert.ok(text.includes('本机 GPU 直连'), '选中本机 GPU 应展示专属配置区')
    assert.ok(!text.includes('Worker 地址'), '本机 GPU 不得混入远程私有 Worker 地址输入框')
    assert.ok(!text.includes('空闲自动关机'), '本机 GPU 不得展示 Kaggle 空闲关机')

    const probeBtn = nodesByClass(tree, 'ofs-chip').find((n) => collectText(n).join('').includes('探测本机环境'))
    assert.ok(probeBtn, '应渲染「探测本机环境」按钮')
    probeBtn.props.onClick()
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()
    assert.ok(textOf(tree).includes('AMD Radeon(TM) 880M Graphics'), '探测后应展示本机显卡名称')

    const inputs = nodesByClass(tree, 'ofs-settings-input')
    const modelInput = inputs.find((n) => n.props.value === 'D:/aigc-local/models/realvisxl-v5.0-lightning-Q4_K.gguf')
    assert.ok(modelInput, '应渲染默认 GGUF 模型输入框')
    modelInput.props.onChange({ target: { value: 'D:/aigc-local/models/sdxl-lightning-Q4_K.gguf' } })
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()

    const saveBtn = nodesByClass(tree, 'ofs-settings-save')[0]
    assert.equal(saveBtn.props.disabled, false, '修改本机 GPU 路径后应可保存')
    saveBtn.props.onClick()
    await mounted.client.settle()

    const savedCall = mounted.calls.find((c) => c.path === '/api/local-gpu/config' && c.method === 'POST')
    assert.ok(savedCall, '保存应调用 POST /api/local-gpu/config')
    assert.equal(savedCall.body.modelPath, 'D:/aigc-local/models/sdxl-lightning-Q4_K.gguf')
  } finally {
    mounted.client.unmount()
  }
})

await check('顶栏与算力弹层：本机 GPU 不再串出私有 Worker 地址或 Kaggle 配额', async () => {
  const session = {
    state: 'ready',
    provider: 'local-gpu',
    device: 'AMD Radeon(TM) 880M Graphics',
    deviceCount: 1,
    idleTimeoutSec: 300,
    error: null,
  }
  const mounted = await mountTopBarExpanded(session, {
    provider: 'local-gpu',
    sessionState: 'ready',
    localGpu: {
      ok: true,
      serverPath: 'D:/aigc-local/bin/sd-server.exe',
      modelPath: 'D:/aigc-local/models/realvisxl.gguf',
      modelName: 'realvisxl.gguf',
    },
    hardware: mockHardware,
  })
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('本机 GPU') && text.includes('已就绪'), '顶栏应显示本机 GPU 就绪态')
    assert.ok(text.includes('realvisxl.gguf'), '弹层应显示当前本机权重文件名')
    assert.ok(text.includes('停止'), '本机 GPU 动作应为「停止」')
    assert.ok(!text.includes('访问令牌') && !text.includes('连接地址'), '本机 GPU 不得显示远程 Worker 地址/令牌行')
    assert.ok(!text.includes('Kaggle 每周额度'), '本机 GPU 不得显示 Kaggle 配额')
  } finally {
    mounted.client.unmount()
  }
})

await check('顶栏与算力弹层：支持直接切换算力后端，切换后立即更新视角并提示旧会话', async () => {
  const switched = []
  const closedMounted = await mountTopBarExpanded(
    { state: 'ready', provider: 'kaggle', device: 'Tesla T4' },
    {
      provider: 'kaggle',
      configuredProviders: ['kaggle', 'local-gpu'],
      switchProvider: async () => true,
    },
    { defaultOpen: false },
  )
  try {
    assert.equal(nodesByClass(closedMounted.tree, 'ofs-compute-popover').length, 0, '初始关闭时不挂载算力弹层')
    const pill = nodesByClass(closedMounted.tree, 'ofs-compute')[0]
    pill.props.onClick()
    const openedTree = await closedMounted.client.rerenderRaw()
    assert.equal(nodesByClass(openedTree, 'ofs-compute-popover').length, 1, '从关闭态展开算力弹层不应触发 Hooks 顺序异常')
  } finally {
    closedMounted.client.unmount()
  }

  const mounted = await mountTopBarExpanded(
    {
      state: 'ready',
      provider: 'kaggle',
      device: 'Tesla T4',
      idleSeconds: 600,
      idleTimeoutSec: 1800,
    },
    {
      provider: 'kaggle',
      configuredProviders: ['kaggle', 'local-gpu'],
      switchProvider: async (next) => {
        switched.push(next)
        return true
      },
    },
  )
  try {
    const switchBtns = nodesByClass(mounted.tree, 'ofs-compute-switch-item')
    assert.ok(switchBtns.length >= 4, '算力弹层应渲染各算力后端切换按钮')
    const localBtn = switchBtns.find((n) => collectText(n).join('').includes('本机 GPU'))
    assert.ok(localBtn, '切换栏应包含本机 GPU')
    await localBtn.props.onClick()
    assert.deepEqual(switched, ['local-gpu'], '点击切换项应直接调用 switchProvider')
  } finally {
    mounted.client.unmount()
  }

  // 当设置已切到 local-gpu 但旧 Kaggle 会话仍在运行：顶栏与弹层应立刻切换为本机 GPU 视角并给温和提示，不串出 Kaggle 设备名。
  const pendingMounted = await mountTopBarExpanded(
    { state: 'ready', provider: 'kaggle', device: 'Tesla T4' },
    {
      provider: 'local-gpu',
      configuredProviders: ['kaggle', 'local-gpu'],
      localGpu: { ok: true, serverPath: 'D:/aigc-local/bin/sd-server.exe', modelPath: 'D:/aigc-local/models/realvisxl.gguf', modelName: 'realvisxl.gguf' },
      hardware: mockHardware,
    },
  )
  try {
    const text = textOf(pendingMounted.tree)
    assert.ok(text.includes('本机 GPU · 未启动'), `切到 local-gpu 后应立刻显示本机 GPU 状态，实际：${text}`)
    assert.ok(text.includes('当前仍有 Kaggle 会话运行中'), '应提示后台仍有旧会话将在下次运行时切换')
    assert.ok(!text.includes('Tesla T4'), '切到本机 GPU 后不得串出旧 Kaggle 显卡型号')
  } finally {
    pendingMounted.client.unmount()
  }
})

await check('模型卡：统一开源列表不重复，按当前 provider 展示硬件适配与切换语义', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const picks = []
  const t = client.internals.i18n.fallbackTranslate('zh')
  try {
    // 1) Kaggle 上下文：不拆「本机部署 / 云端开源」重复 Tab，不混入本地待配置徽章；点选仅本机模型可自动切到 local-gpu。
    const kaggleTree = await client.mountRaw(client.components.ModelCardPicker, {
      t,
      isEn: false,
      presets: [preset, localGpuPreset],
      value: 'sdxl-lightning',
      defaultPreset: 'sdxl-lightning',
      provider: 'kaggle',
      configuredProviders: ['kaggle', 'local-gpu'],
      localGpu: { ok: true, configuredPresets: ['realvisxl-lightning'] },
      hardware: mockHardware,
      open: true,
      onOpenChange: () => {},
      onChange: (next, meta) => picks.push({ id: next.id, meta }),
    })
    const tabLabels = nodesByClass(kaggleTree, 'ofs-model-tab').map((n) => collectText(n).join(' '))
    assert.ok(!tabLabels.some((s) => s.includes('本机部署') || s.includes('云端开源')), `不应再拆分重复的本机/云端开源 Tab，实际：${tabLabels.join(', ')}`)
    assert.equal(
      nodesByClass(kaggleTree, 'ofs-model-group').filter((n) => Boolean(n.props?.['data-local-group'])).length,
      0,
      '云端 GPU 下不应渲染本机显存分组头',
    )
    const realvisOnKaggle = nodesByClass(kaggleTree, 'ofs-model-option').find((n) => n.props['data-preset-id'] === 'realvisxl-lightning')
    assert.equal(realvisOnKaggle.props['aria-disabled'], undefined, 'local-gpu 已配置时从 Kaggle 点选可自动切过去')
    realvisOnKaggle.props.onClick()
    assert.deepEqual(picks[0], { id: 'realvisxl-lightning', meta: { switchToProvider: 'local-gpu' } })
  } finally {
    client.unmount()
  }

  // 2) 本机 GPU 上下文：展示硬件预测分组（可运行 / 已配置 / 待配置）；点击可运行但未配权重的模型保留在本机并提示配置，不反弹回 Kaggle。
  const localClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const localPicks = []
  try {
    const localTree = await localClient.mountRaw(localClient.components.ModelCardPicker, {
      t: localClient.internals.i18n.fallbackTranslate('zh'),
      isEn: false,
      presets: [preset, localGpuPreset],
      value: 'realvisxl-lightning',
      defaultPreset: 'realvisxl-lightning',
      provider: 'local-gpu',
      configuredProviders: ['kaggle', 'local-gpu'],
      localGpu: { ok: true, configuredPresets: ['realvisxl-lightning'] },
      hardware: mockHardware,
      open: true,
      onOpenChange: () => {},
      onChange: (next, meta) => localPicks.push({ id: next.id, meta }),
    })
    const localText = textOf(localTree)
    assert.ok(localText.includes('可运行'), '本机 GPU 下应显示「可运行」分组与结论')
    assert.ok(localText.includes('已配置'), '已配置权重应显示「已配置」状态')
    assert.ok(localText.includes('待配置'), '能跑但尚未绑定权重的模型应标注「待配置」')
    assert.ok(!localText.includes('GGUF 可跑'), '模型卡不应向用户暴露 GGUF 等底层术语')
    assert.equal(nodesByClass(localTree, 'ofs-model-group-head').length >= 1, true, '本机 GPU 下应渲染硬件适配分组头')

    const sdxlOpt = nodesByClass(localTree, 'ofs-model-option').find((n) => n.props['data-preset-id'] === 'sdxl-lightning')
    assert.equal(sdxlOpt.props['aria-disabled'], 'true', '本机未绑定权重时点击不应静默切回 Kaggle')
    sdxlOpt.props.onClick()
    const afterNotice = await localClient.rerenderRaw()
    assert.equal(localPicks.length, 0, '未配置本机权重时不得误切模型')
    assert.ok(textOf(afterNotice).includes('未配置本机模型文件'), '应弹出本机模型配置指引')
  } finally {
    localClient.unmount()
  }

  // 3) Kaggle 下未配本机 GPU 时：RealVisXL 默认折叠进「其他算力专属模型」，带「仅 本机 GPU」胶囊，
  //    点击弹出提示并提供「切换至 本机 GPU 并配置」的一键引导；多来源 Colab 模型标「需 Colab」/「切至 Colab」。
  const qwenColabPreset = {
    ...preset,
    id: 'qwen-image-2.1',
    label: 'Qwen-Image 2.1',
    short: 'Qwen 2.1',
    providers: ['colab', 'private-worker'],
  }
  const unconfiguredClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const openedSettings = []
  const switchedProviders = []
  try {
    const gatedTree = await unconfiguredClient.mountRaw(unconfiguredClient.components.ModelCardPicker, {
      t: unconfiguredClient.internals.i18n.fallbackTranslate('zh'),
      isEn: false,
      presets: [preset, qwenColabPreset, localGpuPreset],
      value: 'sdxl-lightning',
      defaultPreset: 'sdxl-lightning',
      provider: 'kaggle',
      configuredProviders: ['kaggle'],
      localGpu: { ok: false, configuredPresets: [] },
      open: true,
      onOpenChange: () => {},
      onSwitchProvider: async (next) => {
        switchedProviders.push(next)
        return true
      },
      onOpenSettings: (target, meta) => openedSettings.push({ id: target.id, meta }),
      onChange: () => {},
    })
    const gatedText = textOf(gatedTree)
    assert.ok(gatedText.includes('其他算力专属模型'), '不可用模型应折叠收进「其他算力专属模型」')
    assert.ok(gatedText.includes('需 Colab'), '多来源大显存模型（如 Qwen 2.1）在 Kaggle 下应明确标出「需 Colab」')
    assert.ok(gatedText.includes('仅 本机 GPU'), '本机专属模型应带「仅 本机 GPU」胶囊标识')
    const unavailGroups = nodesByClass(gatedTree, 'ofs-model-group').filter((n) => n.props?.['data-unavailable-group'] === 'true')
    assert.equal(unavailGroups.length, 1, '应渲染 data-unavailable-group 分组')
    assert.equal(unavailGroups[0].props.open, true, '其他算力专属模型默认应展开展示')
    const realvisGated = nodesByClass(gatedTree, 'ofs-model-option').find((n) => n.props['data-preset-id'] === 'realvisxl-lightning')
    realvisGated.props.onClick()
    const afterRealvisClick = await unconfiguredClient.rerenderRaw()
    const noticeText = textOf(afterRealvisClick)
    assert.ok(noticeText.includes('配置本地引擎与模型文件'), `RealVisXL 提示应指向本机配置，实际：${noticeText}`)
    assert.ok(!noticeText.includes('对应凭据'), '本机模型提示不得出现「对应凭据」')
    const noticeBtn = nodesByClass(afterRealvisClick, 'ofs-model-notice-btn')[0]
    assert.ok(collectText(noticeBtn).join('').includes('切换至 本机 GPU 并配置'), '提示条主动作应引导自动切换算力并配置')
    noticeBtn.props.onClick()
    assert.deepEqual(switchedProviders, ['local-gpu'], '点击引导按钮应自动触发切换至 local-gpu')
    assert.deepEqual(openedSettings[0], { id: 'realvisxl-lightning', meta: { provider: 'local-gpu' } })
  } finally {
    unconfiguredClient.unmount()
  }

  const colabReadyClient = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  try {
    const switchBadgeTree = await colabReadyClient.mountRaw(colabReadyClient.components.ModelCardPicker, {
      t: colabReadyClient.internals.i18n.fallbackTranslate('zh'),
      isEn: false,
      presets: [preset, qwenColabPreset],
      value: 'sdxl-lightning',
      defaultPreset: 'sdxl-lightning',
      provider: 'kaggle',
      configuredProviders: ['kaggle', 'colab'],
      open: true,
      onOpenChange: () => {},
      onChange: () => {},
    })
    assert.ok(textOf(switchBadgeTree).includes('切至 Colab'), 'Colab 已接入时多来源模型应提示「切至 Colab」')
    const colabUnavailGroup = nodesByClass(switchBadgeTree, 'ofs-model-group').filter((n) => n.props?.['data-unavailable-group'] === 'true')
    assert.equal(colabUnavailGroup.length, 1, '即使 Colab 已接入，Kaggle 下需切至 Colab 的模型也应归入「其他算力专属模型」折叠区')
    assert.ok(collectText(colabUnavailGroup[0]).join('').includes('Qwen 2.1'), 'Qwen 2.1 应位于其他算力专属模型组内')
  } finally {
    colabReadyClient.unmount()
  }
})

await check('生成前预检：未配置 local-gpu 映射的模型在 local-gpu 下拦下，配置映射后放行', () => {
  const blocked = generateCapabilityOf({
    preset,
    presets: [preset, localGpuPreset],
    provider: 'local-gpu',
    localGpuPresets: ['realvisxl-lightning'],
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'provider')

  const allowed = generateCapabilityOf({
    preset,
    presets: [preset, localGpuPreset],
    provider: 'local-gpu',
    localGpuPresets: ['realvisxl-lightning', 'sdxl-lightning'],
  })
  assert.equal(allowed.ok, true)
})

summary()
