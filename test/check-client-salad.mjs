/**
 * SaladCloud 设置区渲染与提交回归（M3.6）。
 *
 * 覆盖：档位默认 medium / 隐藏显卡、Key 留空保持不变 / 显式清除、
 * 只读连接测试、保存时只提交真正变化的字段，以及表单不出现 Kaggle 专属项。
 *
 * 运行：node test/check-client-salad.mjs
 */

import assert from 'node:assert/strict'

import {
  buildSaladPatch,
  normalizeAppSettingsView,
  saladFormOf,
} from '../web/logic/appSettings.js'
import { collectText, findNodes, nodesByClass } from './helpers/render.mjs'
import { createCheckRunner } from './helpers/check.mjs'
import {
  appSettingsView,
  mountSettingsDrawer,
  mountTopBarExpanded,
  settingsView,
} from './helpers/client-fixtures.mjs'

const { check, summary } = createCheckRunner()
const saladAppView = {
  ...appSettingsView,
  salad: { org: 'aigc-studio', project: 'default', tier: 'medium', hasApiKey: true },
}
const textOf = (tree) => collectText(tree).join(' | ')
const buttonWithText = (tree, label) => findNodes(
  tree,
  (node) => node.type === 'button'
    && node.props && typeof node.props.onClick === 'function'
    && collectText([node]).join('').includes(label),
)[0] || null

await check('纯逻辑：缺省 salad 视图回落 medium/default，补丁只提交变化字段', () => {
  const { salad: _savedSalad, ...withoutSalad } = appSettingsView
  const normalized = normalizeAppSettingsView(withoutSalad)
  assert.deepEqual(normalized.salad, {
    org: '',
    project: 'default',
    tier: 'medium',
    hasApiKey: false,
  })
  const form = saladFormOf(saladAppView)
  assert.equal(form.tier, 'medium')
  assert.equal(form.apiKey, '')
  assert.deepEqual(buildSaladPatch(form, saladAppView), {})

  const changed = { ...form, org: 'studio-team', tier: 'high', apiKey: 'new-secret' }
  assert.deepEqual(buildSaladPatch(changed, saladAppView), {
    salad: { org: 'studio-team', tier: 'high', apiKey: 'new-secret' },
  })
  assert.deepEqual(
    buildSaladPatch({ ...form, apiKey: 'ignored', clearApiKey: true }, saladAppView),
    { salad: { clearApiKey: true } },
  )
})

await check('渲染：Salad 区显示凭据 / 档位与推荐标记，不出现 Kaggle 专属项', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    { view: { ...settingsView, provider: 'salad' }, appView: saladAppView },
  )
  try {
    const tree = await mounted.client.rerenderRaw()
    const text = textOf(tree)
    assert.ok(text.includes('SaladCloud'), `应出现 SaladCloud 来源，实际：${text}`)
    assert.ok(text.includes('稳定性档位'), '应出现档位选择')
    assert.ok(text.includes('高稳定') && text.includes('均衡') && text.includes('低价') && text.includes('批量'))
    assert.ok(text.includes('推荐'), 'medium 应带推荐标记')
    assert.ok(text.includes('API Key 已保存'), '已保存 Key 只显示状态')
    assert.ok(text.includes('无需手动挑卡'), '应说明显卡由应用自动选择')
    assert.ok(!text.includes('空闲自动关机'), 'Salad 不应显示空闲关机')
    assert.ok(!text.includes('HF Token'), 'Salad 不应显示 Kaggle/Colab 的 HF Token')
    assert.ok(!text.includes('加速器'), 'Salad 不应显示 Kaggle 加速器')
    assert.equal(nodesByClass(tree, 'ofs-salad').length, 1)
  } finally {
    mounted.client.unmount()
  }
})

await check('交互：测试连接 → 修改组织 / 档位 → 保存提交 salad 补丁', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    { view: { ...settingsView, provider: 'salad' }, appView: saladAppView },
  )
  try {
    let tree = await mounted.client.rerenderRaw()
    const probeButton = buttonWithText(tree, '测试连接')
    assert.ok(probeButton, '应有测试连接按钮')
    probeButton.props.onClick()
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()
    assert.ok(textOf(tree).includes('已连接 aigc-studio / default'), '测试连接应显示账号与配额')
    const probeCall = mounted.calls.find((item) => item.path === '/api/salad/probe' && item.method === 'POST')
    assert.ok(probeCall, '应调用 Salad 探测路由')
    assert.equal(probeCall.body.org, 'aigc-studio')

    const orgInput = findNodes(tree, (node) => node.props && node.props['aria-label'] === '组织（Org）')[0]
    assert.ok(orgInput, '应有组织输入框')
    orgInput.props.onChange({ target: { value: 'studio-team' } })
    tree = await mounted.client.rerenderRaw()
    const highTier = findNodes(
      tree,
      (node) => node.props && node.props.type === 'radio' && node.props.value === 'high',
    )[0]
    assert.ok(highTier, '应有 high 档位')
    highTier.props.onChange()
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()

    const saveButton = findNodes(
      tree,
      (node) => node.props && typeof node.props.onClick === 'function'
        && String(node.props.className || '').includes('is-primary')
        && collectText([node]).join('').includes('保存设置'),
    )[0]
    assert.ok(saveButton, '底部应有保存按钮')
    saveButton.props.onClick()
    await mounted.client.settle()
    const saveCall = mounted.calls.filter((item) => item.path === '/api/app-settings' && item.method === 'POST').at(-1)
    assert.ok(saveCall, '应提交应用设置')
    assert.deepEqual(saveCall.body, { salad: { org: 'studio-team', tier: 'high' } })
  } finally {
    mounted.client.unmount()
  }
})

await check('交互：清除 Key 后保存只提交 clearApiKey', async () => {
  const mounted = await mountSettingsDrawer(
    { defaultTab: 'compute' },
    { view: { ...settingsView, provider: 'salad' }, appView: saladAppView },
  )
  try {
    let tree = await mounted.client.rerenderRaw()
    const clearButton = buttonWithText(tree, '清除')
    assert.ok(clearButton, '已保存 Key 时应提供清除按钮')
    clearButton.props.onClick()
    await mounted.client.settle()
    tree = await mounted.client.rerenderRaw()
    const saveButton = findNodes(
      tree,
      (node) => node.props && typeof node.props.onClick === 'function'
        && String(node.props.className || '').includes('is-primary')
        && collectText([node]).join('').includes('保存设置'),
    )[0]
    saveButton.props.onClick()
    await mounted.client.settle()
    const saveCall = mounted.calls.filter((item) => item.path === '/api/app-settings' && item.method === 'POST').at(-1)
    assert.deepEqual(saveCall.body, { salad: { clearApiKey: true } })
  } finally {
    mounted.client.unmount()
  }
})

await check('算力弹层：Salad 显示档位与设备，不串出 Kaggle 周配额 / 探测入口', async () => {
  const session = {
    state: 'ready',
    provider: 'salad',
    device: 'RTX 3090',
    idleTimeoutSec: null,
    error: null,
  }
  const mounted = await mountTopBarExpanded(session, {
    provider: 'salad',
    sessionState: 'ready',
    salad: { org: 'aigc-studio', project: 'default', tier: 'medium', hasApiKey: true },
    configuredProviders: ['salad'],
    quota: { usedHours: 3, totalHours: 30 },
  })
  try {
    const text = textOf(mounted.tree)
    assert.ok(text.includes('SaladCloud'), `应显示 SaladCloud，实际：${text}`)
    assert.ok(text.includes('稳定性档位') && text.includes('均衡'), '应显示 medium 档位')
    assert.ok(!text.includes('每周额度'), 'Salad 不应显示 Kaggle 周配额')
    assert.ok(!text.includes('检查环境'), 'Salad 不应显示 Kaggle 环境探测')
  } finally {
    mounted.client.unmount()
  }
})

summary()
