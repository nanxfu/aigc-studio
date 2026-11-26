#!/usr/bin/env node
/**
 * 本机 GPU 架构收敛与算力分组客户端回归（不需要浏览器）。
 *
 * 覆盖：
 *  1. 设置抽屉「算力来源」按三大心智分组渲染（云端 GPU / 云 API / 私有部署），
 *     选择「本机 GPU」后渲染精简准备/显卡检测面板，自定义路径默认收起；
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
import { readFile } from 'node:fs/promises'

import { evaluateDeviceCapability, matchGpuProfile } from '../shared/gpu-benchmark.js'
import { LOCAL_GPU_ENGINE } from '../shared/local-gpu-assets.js'
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

const fluxLocalPreset = {
  ...preset,
  id: 'flux2-klein-4b',
  label: 'FLUX.2 Klein 4B',
  short: 'Klein 4B',
  providers: ['local-gpu'],
  steadySeconds: 10.24,
}

const hwEval = evaluateDeviceCapability(matchGpuProfile({ presetId: 'amd-radeon-880m-apu' }), { diskFreeGb: 100 })
const mockHardware = { evaluation: hwEval }

await check('设置页：本机 GPU 只展示引擎、显卡结论与共享模型目录', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    {
      view: { ...settingsView, provider: 'local-gpu' },
      localGpuView: {
        ok: true,
        configured: true,
        engineReady: true,
        engineBackend: 'vulkan',
        errors: [],
        source: 'file',
        overrideByEnv: false,
        configPath: 'C:/Users/test/AppData/Roaming/aigc-studio/local-gpu.json',
        serverPath: 'D:/aigc-local/bin/sd-server.exe',
        modelPath: 'D:/aigc-local/models/realvisxl-v5.0-lightning-Q4_K.gguf',
        vaePath: '',
        modelName: 'realvisxl-v5.0-lightning-Q4_K.gguf',
        models: { 'realvisxl-lightning': { modelPath: 'D:/aigc-local/models/realvisxl-v5.0-lightning-Q4_K.gguf' } },
        modelStates: { 'realvisxl-lightning': { ready: true, available: true } },
        configuredPresets: ['realvisxl-lightning'],
        paramsBackend: 'auto',
        threads: 0,
        idleTimeoutSec: 300,
        vaeTiling: null,
      },
    },
  )
  try {
    let tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('云端 GPU') && text.includes('云 API') && text.includes('私有部署'), '应按三大心智分类渲染算力来源')
    assert.ok(text.includes('本机 GPU') && text.includes('已就绪'), '选中本机 GPU 应展示专属状态区')
    assert.ok(text.includes('推理引擎已就绪'), '应展示引擎状态，而不是模型绑定状态')
    assert.ok(text.includes('本机模型目录'), '应复用全局本机模型目录')
    assert.ok(!text.includes('Worker 地址'), '本机 GPU 不得混入远程私有 Worker 地址输入框')
    assert.ok(!text.includes('空闲自动关机'), '本机 GPU 不得展示 Kaggle 空闲关机')
    for (const term of ['stable-diffusion.cpp', 'sd-server', 'vulkaninfo', 'GGUF', 'fp16-fix', 'local-gpu.json', 'Vulkan']) {
      assert.ok(!text.includes(term), `本机 GPU 主视图不应暴露内部术语 ${term}：${text}`)
    }
    assert.ok(!text.includes('权重内存策略'), '不应再展示权重内存策略')
    assert.ok(!text.includes('空闲卸载权重'), '不应再展示空闲卸载权重')
    assert.ok(!text.includes('VAE 分块解码'), '不应再展示 VAE 分块解码')

    assert.ok(!text.includes('自定义路径'), '正式版不应再渲染自定义路径区')
    const initialInputs = nodesByClass(tree, 'ofs-settings-input')
    assert.ok(
      !initialInputs.some((node) => String(node.props.value || '').includes('.gguf')),
      '界面不得渲染模型文件路径输入框',
    )

    const probeBtn = nodesByClass(tree, 'ofs-chip').find((n) => collectText(n).join('').includes('检测本机显卡'))
    assert.ok(probeBtn, '应渲染「检测本机显卡」按钮')
    probeBtn.props.onClick()
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()
    assert.ok(textOf(tree).includes('Radeon 880M'), '探测后应展示显卡与显存建议结论')
    const probeCall = mounted.calls.find((call) => call.path === '/api/local-gpu/probe' && call.method === 'POST')
    assert.deepEqual(probeCall.body, {}, '探测只使用已保存配置，不再向界面收集路径')
    assert.ok(!mounted.calls.some((call) => call.path === '/api/local-gpu/config' && call.method === 'POST'), '纯状态页保存不应写路径配置')
  } finally {
    mounted.client.unmount()
  }
})

await check('设置页：不支持自动准备时也不回退到路径表单', async () => {
  const mounted = await mountSettingsDrawer({ defaultTab: 'compute' }, {
    view: { ...settingsView, provider: 'local-gpu' },
    localGpuView: {
      ok: false,
      configured: false,
      source: 'none',
      errors: ['配置未就绪'],
      serverPath: '',
      modelPath: '',
      vaePath: '',
      models: {},
      configuredPresets: [],
    },
    localGpuSetup: { supported: false, phase: 'idle', downloadedBytes: 0, totalBytes: 0, freeBytes: null },
  })
  try {
    let tree = await mounted.client.rerenderRaw()
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(!text.includes('自定义路径'), '不得把路径表单作为兜底')
    assert.ok(text.includes('需准备轻量推理引擎'), '应明确告诉用户引擎未就绪')
    assert.ok(nodesByClass(tree, 'ofs-settings-input').every((node) => !String(node.props.value || '').includes('.gguf')))
  } finally {
    mounted.client.unmount()
  }
})

await check('设置页：引擎未就绪时提供轻量准备入口，不下载绘画模型', async () => {
  const mounted = await mountSettingsDrawer({ defaultTab: 'compute' }, {
    view: { ...settingsView, provider: 'local-gpu' },
    localGpuView: { ok: false, configured: false, engineReady: false, source: 'none', errors: ['配置未就绪'], serverPath: '', modelPath: '', vaePath: '', models: {}, configuredPresets: [], paramsBackend: 'auto', idleTimeoutSec: 300, vaeTiling: null },
    localGpuSetup: { supported: true, phase: 'idle', downloadedBytes: 0, totalBytes: LOCAL_GPU_ENGINE.bytes, freeBytes: 20 * 1024 ** 3 },
  })
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('准备本机推理引擎'))
    const action = nodesByClass(tree, 'ofs-btn').find((node) => collectText(node).join('').includes('准备引擎'))
    assert.ok(action, '显示准备引擎动作')
    action.props.onClick()
    await mounted.client.settle()
    assert.ok(mounted.calls.some((call) => call.path === '/api/local-gpu/setup'
      && call.method === 'POST'
      && call.body.action === 'start'
      && !call.body.presetId))
    assert.ok(!mounted.calls.some((call) => call.path === '/api/local-gpu/config' && call.method === 'POST'))
  } finally {
    mounted.client.unmount()
  }
})

await check('设置页：引擎下载进度可读且显示取消操作', async () => {
  const mounted = await mountSettingsDrawer({ defaultTab: 'compute' }, {
    view: { ...settingsView, provider: 'local-gpu' },
    localGpuView: { ok: false, configured: false, engineReady: false, source: 'none', errors: ['配置未就绪'], serverPath: '', modelPath: '', vaePath: '', models: {}, configuredPresets: [], paramsBackend: 'auto', idleTimeoutSec: 300, vaeTiling: null },
    localGpuSetup: { supported: true, phase: 'downloading', downloadedBytes: Math.round(LOCAL_GPU_ENGINE.bytes / 2), totalBytes: LOCAL_GPU_ENGINE.bytes, freeBytes: null },
  })
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(collectText(tree).join('').includes('50%'), text)
    assert.ok(nodesByClass(tree, 'ofs-chip').some((node) => collectText(node).join('').includes('取消准备')))
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
      engineReady: true,
      serverPath: 'D:/aigc-local/bin/sd-server.exe',
      modelPath: 'D:/aigc-local/models/realvisxl.gguf',
      modelName: 'realvisxl.gguf',
      configuredPresets: ['realvisxl-lightning'],
      modelStates: { 'realvisxl-lightning': { ready: true, available: true } },
    },
    hardware: mockHardware,
  })
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('本机 GPU') && text.includes('已就绪'), '顶栏应显示本机 GPU 就绪态')
    assert.ok(text.includes('880M'), '弹层应显示本机显卡短名')
    assert.ok(!text.includes('realvisxl.gguf') && !text.includes('sd-server.exe'), '弹层不应透出权重/引擎文件名')
    assert.ok(text.includes('停止'), '本机 GPU 动作应为「停止」')
    assert.ok(!text.includes('访问令牌') && !text.includes('连接地址'), '本机 GPU 不得显示远程 Worker 地址/令牌行')
    assert.ok(!text.includes('Kaggle 每周额度'), '本机 GPU 不得显示 Kaggle 配额')
  } finally {
    mounted.client.unmount()
  }
})

await check('顶栏与算力弹层：只有一个已配置来源时不渲染切换网格，也不透出底层报错', async () => {
  const mounted = await mountTopBarExpanded(
    { state: 'ready', provider: 'local-gpu', device: 'Radeon 880M' },
    {
      provider: 'local-gpu',
      configuredProviders: ['local-gpu'],
      sessionState: 'ready',
      localGpu: {
        ok: true,
        engineReady: true,
        configuredPresets: ['realvisxl-lightning'],
        modelStates: { 'realvisxl-lightning': { ready: true, available: true } },
        errors: ['缺少 sd-server 可执行文件路径（serverPath / AIGC_STUDIO_LOCAL_GPU_SERVER）'],
      },
      hardware: mockHardware,
    },
  )
  try {
    const tree = await mounted.client.rerenderRaw()
    assert.equal(nodesByClass(tree, 'ofs-compute-switch-item').length, 0, '单来源不应渲染 2×3 / 胶囊切换网格')
    assert.ok(nodesByClass(tree, 'ofs-compute-more-item').length >= 1, '应保留未配置算力的轻量引导入口')
    assert.ok(textOf(tree).includes('算力设置'), '底部应保留算力设置入口')
    for (const term of ['sd-server', 'serverPath', 'AIGC_STUDIO_LOCAL_GPU_SERVER', 'GGUF', 'fp16-fix']) {
      assert.ok(!textOf(tree).includes(term), `弹层不得透出底层术语 ${term}`)
    }
  } finally {
    mounted.client.unmount()
  }

  // 当引擎已就绪但当前所选模型未下载且未启动时，主动作应引导去模型卡下载，而不是直接点启动报错。
  const needDownloadMounted = await mountTopBarExpanded(
    { state: 'absent', provider: 'local-gpu' },
    {
      provider: 'local-gpu',
      configuredProviders: ['local-gpu'],
      localGpu: {
        ok: true,
        engineReady: true,
        configuredPresets: [],
        modelStates: {},
      },
      hardware: mockHardware,
    },
  )
  try {
    const tree = await needDownloadMounted.client.rerenderRaw()
    assert.ok(textOf(tree).includes('前往模型卡下载'), '当前模型未下载时主动作应引导打开模型卡下载')
  } finally {
    needDownloadMounted.client.unmount()
  }
})

await check('算力弹层：条件返回后不再调用 Hooks，关闭后展开不会改变 Hook 顺序', async () => {
  const source = await readFile(new URL('../web/studio/ComputePopover.jsx', import.meta.url), 'utf8')
  const earlyReturn = source.indexOf('if (!presence.mounted) return null')
  assert.ok(earlyReturn > 0, '应保留 presence 未挂载时的条件返回')
  assert.doesNotMatch(
    source.slice(earlyReturn),
    /\bReact\.use(?:State|Ref|Effect|Memo|Callback|LayoutEffect|Reducer|Id)\b/,
    '条件返回之后不能出现任何 Hook',
  )
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
    assert.equal(switchBtns.length, 2, '只渲染已配置的两个算力来源')
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
      localGpu: {
        ok: true,
        engineReady: true,
        configuredPresets: [],
        modelStates: {},
        serverPath: 'D:/aigc-local/bin/sd-server.exe',
      },
      hardware: mockHardware,
    },
  )
  try {
    const text = textOf(pendingMounted.tree)
    assert.ok(text.includes('本机 GPU · 本机待机'), `切到 local-gpu 后应立刻显示本机 GPU 状态，实际：${text}`)
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

  // 2) 本机 GPU 上下文：已下载显示就绪；可下载显示体积并就地启动准备；无本机权重则明确不可用。
  const localClient = await createTestClient({
    now: NOW,
    testBuild: true,
    responses: {
      '/api/local-gpu/setup': () => ({
        ok: true,
        setup: {
          supported: true,
          phase: 'checking',
          presetId: 'flux2-klein-4b',
          downloadedBytes: 0,
          totalBytes: 2_460_378_560,
        },
      }),
    },
  })
  const localPicks = []
  try {
    const localTree = await localClient.mountRaw(localClient.components.ModelCardPicker, {
      t: localClient.internals.i18n.fallbackTranslate('zh'),
      isEn: false,
      presets: [preset, localGpuPreset, fluxLocalPreset],
      value: 'realvisxl-lightning',
      defaultPreset: 'realvisxl-lightning',
      provider: 'local-gpu',
      configuredProviders: ['kaggle', 'local-gpu'],
      localGpu: {
        ok: true,
        engineReady: true,
        configuredPresets: ['realvisxl-lightning'],
        modelStates: {
          'realvisxl-lightning': { ready: true, available: true },
          'flux2-klein-4b': { ready: false, available: true },
        },
      },
      hardware: mockHardware,
      open: true,
      onOpenChange: () => {},
      onChange: (next, meta) => localPicks.push({ id: next.id, meta }),
    })
    const localText = textOf(localTree)
    assert.ok(localText.includes('可运行'), '本机 GPU 下应显示「可运行」分组与结论')
    assert.ok(localText.includes('已配置'), '已下载权重应显示「已配置」状态')
    assert.ok(localText.includes('需下载'), '未下载权重应显示体积与下载入口')
    assert.ok(localText.includes('暂不支持本机'), '无可靠本机权重的模型应明确标注不可用')
    assert.ok(!localText.includes('GGUF 可跑'), '模型卡不应向用户暴露 GGUF 等底层术语')
    assert.equal(nodesByClass(localTree, 'ofs-model-group-head').length >= 1, true, '本机 GPU 下应渲染硬件适配分组头')

    const sdxlOpt = nodesByClass(localTree, 'ofs-model-option').find((n) => n.props['data-preset-id'] === 'sdxl-lightning')
    assert.equal(sdxlOpt.props['aria-disabled'], 'true', '无本机权重时不可静默选中')
    sdxlOpt.props.onClick()
    const afterNotice = await localClient.rerenderRaw()
    assert.equal(localPicks.length, 0, '未配置本机权重时不得误切模型')
    assert.ok(textOf(afterNotice).includes('暂无可校验的本机权重'), '应说明该模型暂不支持本机下载')

    const fluxOpt = nodesByClass(afterNotice, 'ofs-model-option').find((n) => n.props['data-preset-id'] === 'flux2-klein-4b')
    fluxOpt.props.onClick()
    await localClient.settle()
    const started = localClient.requests.find((call) => call.path === '/api/local-gpu/setup'
      && call.method === 'POST'
      && call.body.action === 'start')
    assert.deepEqual(started.body, { action: 'start', presetId: 'flux2-klein-4b' }, '下载必须按 presetId 参数化')
    const cancel = nodesByClass(await localClient.rerenderRaw(), 'ofs-model-download')
      .find((node) => collectText(node).join('').includes('取消'))
    assert.ok(cancel, '下载中应提供行内取消按钮')
    cancel.props.onClick({ stopPropagation() {} })
    await localClient.settle()
    assert.ok(localClient.requests.some((call) => call.path === '/api/local-gpu/setup'
      && call.method === 'POST'
      && call.body.action === 'cancel'
      && call.body.presetId === 'flux2-klein-4b'))
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
