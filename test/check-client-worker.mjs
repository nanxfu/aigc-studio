/**
 * 私有 Worker 客户端回归（M3.1-b，不需要浏览器）。
 *
 * 覆盖：
 *  - 设置抽屉：选择私有 Worker 后只显示地址 / Token / 测试连接，隐藏 Kaggle/Colab 专属项；
 *  - 测试连接：调用 /api/worker/probe 并展示协议与 GPU；
 *  - 保存：地址与 Token 走 /api/app-settings 的 worker 段（Token 不回显）；
 *  - 顶栏：已连接显示设备与「断开」，未连接显示「连接」，不出现 Kaggle 配额文案。
 *
 * 运行：node test/check-client-worker.mjs
 */

import assert from 'node:assert/strict'

import { createCheckRunner } from './helpers/check.mjs'
import { buttonByText, collectText, findNodes, nodesByClass } from './helpers/render.mjs'
import {
  appSettingsView,
  mountSettingsDrawer,
  mountTopBarExpanded,
  settingsView,
} from './helpers/client-fixtures.mjs'

const { check, summary } = createCheckRunner()

const WORKER_VIEW = { ...settingsView, provider: 'private-worker' }
const WORKER_APP_VIEW = {
  ...appSettingsView,
  worker: { endpointUrl: 'http://127.0.0.1:8765', tokenConfigured: true },
}
const textOf = (tree) => collectText(tree).join(' | ')

function inputByPlaceholder(tree, needle) {
  return findNodes(tree, (node) => node.type === 'input' && typeof node.props?.placeholder === 'string' && node.props.placeholder.includes(needle))[0] || null
}

await check('设置页：私有 Worker 只显示连接配置，隐藏 Kaggle/Colab 专属项', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    { view: WORKER_VIEW, appView: WORKER_APP_VIEW },
  )
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('私有 Worker（自有 GPU）'), '算力来源应出现私有 Worker 选项')
    assert.ok(text.includes('Worker 地址'), '应显示 Worker 地址')
    assert.ok(text.includes('访问令牌'), '应显示访问令牌')
    assert.ok(text.includes('测试连接'), '应显示测试连接')
    assert.ok(text.includes('已保存'), '已保存 Token 应显示状态')
    // Kaggle / Colab 专属项不应出现在私有 Worker 下。
    assert.ok(!text.includes('空闲自动关机'), `私有 Worker 不应显示空闲关机：${text}`)
    assert.ok(!text.includes('HF Token'), '私有 Worker 不应显示 HF Token')
    assert.ok(!text.includes('GPU 加速器'), '私有 Worker 不应显示 Kaggle 加速器')
    assert.ok(!text.includes('预挂载 Kaggle Dataset'), '私有 Worker 不应显示 Dataset 预挂载')
  } finally {
    mounted.client.unmount()
  }
})

await check('设置页：测试连接展示协议与 GPU', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    { view: WORKER_VIEW, appView: WORKER_APP_VIEW },
  )
  try {
    let tree = await mounted.client.rerenderRaw()
    const probeButton = buttonByText(tree, '测试连接')
    assert.ok(probeButton, '应渲染「测试连接」按钮')
    probeButton.props.onClick()
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('连接正常 · 协议 2.0.0'), `应展示协议版本：${text}`)
    assert.ok(text.includes('Mock RTX 4090'), '应展示 Worker 上报的 GPU')
    assert.ok(text.includes('24 GB'), '显存应换算为 GB')
    const call = mounted.calls.find((item) => item.path === '/api/worker/probe' && item.method === 'POST')
    assert.ok(call, '必须调用 /api/worker/probe')
    assert.equal(call.body.endpointUrl, 'http://127.0.0.1:8765')
  } finally {
    mounted.client.unmount()
  }
})

await check('设置页：保存地址与 Token 走 app-settings 的 worker 段', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    {
      view: WORKER_VIEW,
      appView: WORKER_APP_VIEW,
      appSavedView: {
        ...WORKER_APP_VIEW,
        worker: { endpointUrl: 'https://gpu2.example.com:8765', tokenConfigured: true },
      },
    },
  )
  try {
    let tree = await mounted.client.rerenderRaw()
    const endpointInput = inputByPlaceholder(tree, 'https://gpu.example.com:8765')
    assert.ok(endpointInput, '应渲染 Worker 地址输入框')
    endpointInput.props.onChange({ target: { value: 'https://gpu2.example.com:8765' } })
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()
    const tokenInput = findNodes(tree, (node) => node.type === 'input' && node.props?.type === 'password')[0]
    assert.ok(tokenInput, '应渲染 Token 输入框')
    tokenInput.props.onChange({ target: { value: 'new-worker-token' } })
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()

    const saveButton = nodesByClass(tree, 'ofs-settings-save')[0]
    assert.ok(saveButton, '应有底部保存按钮')
    assert.equal(saveButton.props.disabled, false, '有改动时应可保存')
    saveButton.props.onClick()
    await mounted.client.settle()

    const appSave = mounted.calls.find((item) => item.path === '/api/app-settings' && item.method === 'POST')
    assert.ok(appSave, '必须调用 /api/app-settings 保存 worker')
    assert.deepEqual(appSave.body, {
      worker: { endpointUrl: 'https://gpu2.example.com:8765', token: 'new-worker-token' },
    })
    assert.ok(mounted.toasts.includes('运行设置已保存'), '保存成功应提示')
  } finally {
    mounted.client.unmount()
  }
})

await check('顶栏：私有 Worker 已连接显示设备与「断开」，不出现 Kaggle 配额', async () => {
  const session = {
    state: 'ready',
    provider: 'private-worker',
    device: 'NVIDIA RTX 4090',
    deviceCount: 1,
    idleTimeoutSec: null,
    error: null,
  }
  const mounted = await mountTopBarExpanded(session, {
    provider: 'private-worker',
    sessionState: 'ready',
    worker: { endpointUrl: 'https://gpu.internal:8765', tokenConfigured: true },
  })
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('私有 Worker'), '顶栏应标出来源')
    assert.ok(text.includes('已连接'), '就绪态应显示已连接')
    assert.ok(text.includes('RTX 4090'), '应显示 Worker 的设备型号')
    assert.ok(text.includes('断开'), '断开文案应使用「断开」')
    assert.ok(text.includes('gpu.internal:8765'), '应显示连接地址')
    assert.ok(text.includes('已保存'), '应显示 Token 已配置')
    assert.ok(!text.includes('Kaggle 每周额度'), '私有 Worker 不得显示 Kaggle 配额')
    assert.ok(!text.includes('Colab 计算单元'), '私有 Worker 不得显示 Colab 计算单元')
    assert.ok(!text.includes('检查环境'), '私有 Worker 不显示 Kaggle 环境检查')
  } finally {
    mounted.client.unmount()
  }
})

await check('顶栏：私有 Worker 未连接显示「连接」与地址', async () => {
  const session = { state: 'absent', provider: 'private-worker', error: null }
  const mounted = await mountTopBarExpanded(session, {
    provider: 'private-worker',
    sessionState: 'absent',
    worker: { endpointUrl: 'https://gpu.internal:8765', tokenConfigured: false },
  })
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('未连接'), `未连接态应显示「未连接」：${text}`)
    assert.ok(text.includes('连接'), '主操作应为「连接」')
    assert.ok(text.includes('gpu.internal:8765'), '应显示已保存地址')
    assert.ok(text.includes('未设置'), '未保存 Token 时应有提示')
    assert.ok(!text.includes('Kaggle 每周额度'), '私有 Worker 不得显示 Kaggle 配额')
  } finally {
    mounted.client.unmount()
  }
})

summary()