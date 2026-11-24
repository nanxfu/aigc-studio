#!/usr/bin/env node
/**
 * 本机 GPU 架构收敛与算力分组客户端回归（不需要浏览器）。
 *
 * 覆盖：
 *  1. 设置抽屉「算力来源」按三大心智分组渲染（云端 GPU / 云 API / 私有部署），
 *     选择「本机 GPU」后渲染专属路径/策略/探测面板，不再与「私有 Worker」混用；
 *  2. 本机 GPU 探测与保存走 `/api/local-gpu/probe` 与 `/api/local-gpu/config`；
 *  3. 顶栏与算力弹层在 `local-gpu` 下显示本机显卡、发动机与权重状态，不串出远程地址/Token 或 Kaggle 配额；
 *  4. 模型卡（ModelCardPicker）分离「本机部署 / 云端开源」Tab，展示硬件预测徽章，
 *     并在 `local-gpu` 已配置时支持自动切换算力来源；
 *  5. `generateCapabilityOf` 拦截未声明/未映射 `local-gpu` 的模型，映射后放行。
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

await check('模型卡：本机部署 Tab 与硬件适配徽章联动，并支持自动切到 local-gpu', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const picks = []
  const t = client.internals.i18n.fallbackTranslate('zh')
  try {
    const tree = await client.mountRaw(client.components.ModelCardPicker, {
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
    const tabLabels = nodesByClass(tree, 'ofs-model-tab').map((n) => collectText(n).join(' '))
    assert.ok(tabLabels.some((s) => s.includes('本机部署')), `应渲染「本机部署」Tab，实际：${tabLabels.join(', ')}`)
    assert.ok(tabLabels.some((s) => s.includes('云端开源')), `应渲染「云端开源」Tab，实际：${tabLabels.join(', ')}`)

    const localTab = nodesByClass(tree, 'ofs-model-tab').find((n) => collectText(n).join('').includes('本机部署'))
    localTab.props.onClick()
    const localTree = await client.rerenderRaw()
    const localText = textOf(localTree)
    assert.ok(localText.includes('可流畅运行'), 'RealVisXL 应显示通俗的「可流畅运行」分组与结论')
    assert.ok(localText.includes('已就绪'), '已配置权重应显示「已就绪」徽章')
    assert.ok(localText.includes('待配置'), '能跑但尚未绑定权重的模型应标注「待配置」')
    assert.ok(!localText.includes('GGUF 可跑'), '模型卡不应向用户暴露 GGUF 等底层术语')
    assert.equal(nodesByClass(localTree, 'ofs-model-group-head').length >= 1, true, '本机部署 Tab 应渲染分组头')

    const realvisOpt = nodesByClass(localTree, 'ofs-model-option').find((n) => n.props['data-preset-id'] === 'realvisxl-lightning')
    assert.equal(realvisOpt.props['aria-disabled'], undefined, 'local-gpu 已配置时切过去不得置灰')
    realvisOpt.props.onClick()
    assert.deepEqual(picks[0], { id: 'realvisxl-lightning', meta: { switchToProvider: 'local-gpu' } })
  } finally {
    client.unmount()
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
