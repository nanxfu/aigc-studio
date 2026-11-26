import assert from 'node:assert/strict'

import { fallbackTranslate } from '../web/i18n.js'
import { createCheckRunner } from './helpers/check.mjs'
import { buttonByText, collectText, createTestClient, findNodes, nodesByClass } from './helpers/render.mjs'

const { check, summary } = createCheckRunner()
const t = fallbackTranslate('zh')
const settings = { llm: { provider: 'openai', model: 'gpt-4o-mini', hasApiKey: false, configured: false } }
async function mount({ step = 2, response, view = settings, compute = {} } = {}) {
  const closed = []
  const client = await createTestClient({ responses: {
    '/api/app-settings': ({ method, body }) => method === 'GET' ? { ok: true, settings: view } : response ? response(body) : { ok: true, settings: { ...view, llm: { ...view.llm, hasApiKey: true, configured: true } } },
    '/api/settings': ({ body }) => ({ ok: true, settings: { provider: 'kaggle', ...body } }),
  } })
  const tree = await client.mountRaw(client.components.Onboarding, { t, compute, defaultStep: step, onClose: (result) => closed.push(result) })
  return { client, tree, closed }
}
const posts = (client) => client.requests.filter((request) => request.method === 'POST')
const keyInput = (tree) => findNodes(tree, (node) => node.type === 'input' && node.props.type === 'password')[0]

await check('先看演示：切换能力不调用 API；演示可以暂停和重播', async () => {
  const { client, tree } = await mount({ step: 0 })
  try {
    assert.equal(nodesByClass(tree, 'ofs-onboarding-demo').length, 1)
    buttonByText(tree, '创作助手').props.onClick()
    const next = await client.rerenderRaw()
    assert.equal(nodesByClass(next, 'ofs-onboarding-demo')[0].props['data-feature'], 'agent')
    assert.equal(posts(client).length, 0)
    assert.ok(findNodes(next, (node) => node.type === 'button' && node.props['aria-label'] === '暂停演示')[0])
    assert.ok(findNodes(next, (node) => node.type === 'button' && node.props['aria-label'] === '重新播放演示')[0])
  } finally { client.unmount() }
})

await check('缺少 API Key 时留在配置页，不发保存请求', async () => {
  const { client, tree } = await mount()
  try {
    await buttonByText(tree, '保存并继续').props.onClick()
    const next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /请填写所选服务商的 API Key/)
    assert.equal(posts(client).length, 0)
  } finally { client.unmount() }
})

await check('清空默认模型或只留空格时，提示补充模型且不保存', async () => {
  for (const emptyModel of ['', '   ']) {
    const { client, tree } = await mount({ view: { llm: { ...settings.llm, hasApiKey: true, configured: true } } })
    try {
      const modelInput = findNodes(tree, (node) => node.type === 'input' && node.props['aria-label'] === t('settings.llm.model.label'))[0]
      assert.equal(modelInput.props.value, 'gpt-4o-mini')
      modelInput.props.onChange({ target: { value: emptyModel } })
      let next = await client.rerenderRaw()
      await buttonByText(next, '保存并继续').props.onClick()
      next = await client.rerenderRaw()
      assert.match(collectText(next).join(''), /请填写模型名称/)
      assert.ok(keyInput(next), '模型无效时保留助手配置页')
      assert.equal(posts(client).length, 0)
    } finally { client.unmount() }
  }
})

await check('保存真实模型配置后前进，Key 从表单清除', async () => {
  const { client, tree } = await mount()
  try {
    keyInput(tree).props.onChange({ target: { value: 'new-test-key' } })
    let next = await client.rerenderRaw()
    await buttonByText(next, '保存并继续').props.onClick()
    next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /助手设置已保存/)
    assert.deepEqual(posts(client)[0].body, { llm: { apiKey: 'new-test-key' } })
    buttonByText(next, '上一步').props.onClick()
    next = await client.rerenderRaw()
    assert.equal(keyInput(next).props.value, '')
  } finally { client.unmount() }
})

await check('保存失败保留输入，允许重试且不显示成功', async () => {
  const { client, tree } = await mount({ response: () => { throw new TypeError('测试保存失败') } })
  try {
    keyInput(tree).props.onChange({ target: { value: 'retry-key' } })
    let next = await client.rerenderRaw()
    await buttonByText(next, '保存并继续').props.onClick()
    next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /测试保存失败/)
    assert.equal(keyInput(next).props.value, 'retry-key')
    assert.equal(buttonByText(next, '保存并继续').props.disabled, false)
  } finally { client.unmount() }
})

await check('跳过引导只保存跳过状态，不保存未提交的密钥', async () => {
  const { client, tree, closed } = await mount()
  try {
    keyInput(tree).props.onChange({ target: { value: 'do-not-save' } })
    const next = await client.rerenderRaw()
    await buttonByText(next, '跳过设置').props.onClick()
    assert.deepEqual(posts(client)[0].body, { onboarding: { version: 1, status: 'skipped' } })
    assert.equal(closed.length, 1)
  } finally { client.unmount() }
})

await check('本机 GPU 与生图 API 引导到对应的真实设置入口', async () => {
  for (const [text, provider] of [['本机 GPU', 'local-gpu'], ['生图 API', 'cloud-api']]) {
    const { client, tree, closed } = await mount({ step: 3 })
    try {
      await buttonByText(tree, text).props.onClick()
      assert.deepEqual(closed, [{ settingsTab: { tab: 'compute', provider } }])
      assert.deepEqual(posts(client)[0].body, { onboarding: { version: 1, status: 'completed' } })
    } finally { client.unmount() }
  }
})

await check('减少动态效果时直接展示完整结果，默认不播放', async () => {
  const client = await createTestClient()
  try {
    const tree = await client.mountRaw(client.components.OnboardingDemo, { t, feature: 'polish', reducedMotion: true })
    assert.equal(nodesByClass(tree, 'ofs-onboarding-demo')[0].props['data-phase'], 'output')
    assert.match(collectText(tree).join(''), /Close-up of a plush red panda/)
    assert.ok(findNodes(tree, (node) => node.type === 'button' && node.props['aria-label'] === '播放演示')[0])
  } finally { client.unmount() }
})

await check('算力初始选择只展开所选来源，不提交其它服务配置', async () => {
  const { client, tree } = await mount({ step: 1, compute: { kaggleLogin: { login: { state: 'idle' }, start() {} }, colabLogin: { login: { state: 'idle' }, start() {} } } })
  try {
    assert.equal(nodesByClass(tree, 'ofs-onboarding-path-detail').length, 1)
    assert.equal(findNodes(tree, (node) => node.type === 'input').length, 0)
    buttonByText(tree, 'Google Colab').props.onClick()
    const next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /在浏览器中授权 Google/)
    assert.equal(buttonByText(next, '在浏览器中登录 Kaggle'), null)
    assert.equal(posts(client).length, 0)
  } finally { client.unmount() }
})

await check('已有 Colab 授权只保存 Colab 默认配置，随后进入可选助手配置', async () => {
  const { client, tree } = await mount({ step: 1, compute: { colabAuth: { authorized: true }, colabLogin: { login: { state: 'idle' } } } })
  try {
    buttonByText(tree, 'Google Colab').props.onClick()
    let next = await client.rerenderRaw()
    await buttonByText(next, '保存这条出图路径').props.onClick()
    next = await client.rerenderRaw()
    assert.ok(keyInput(next))
    assert.deepEqual(posts(client)[0].body, { provider: 'colab', colabGpu: 'T4', colabHighRam: false, idleTimeoutSec: 1800 })
    assert.equal(posts(client).some((request) => request.path.includes('session')), false)
  } finally { client.unmount() }
})

await check('Agent 演示等用户确认，之后展示内置作品，且不发出图请求', async () => {
  const client = await createTestClient()
  try {
    let tree = await client.mountRaw(client.components.OnboardingDemo, { t, feature: 'agent', reducedMotion: true })
    assert.equal(buttonByText(tree, '按这个方案继续').props.disabled, false)
    assert.equal(nodesByClass(tree, 'ofs-onboarding-demo-image')[0].props.className.includes('is-visible'), false)
    buttonByText(tree, '按这个方案继续').props.onClick()
    tree = await client.rerenderRaw()
    assert.equal(nodesByClass(tree, 'ofs-onboarding-demo-image')[0].props.className.includes('is-visible'), true)
    assert.match(collectText(tree).join(''), /已保存到本机画廊/)
    assert.equal(posts(client).length, 0)
  } finally { client.unmount() }
})

await check('算力草稿选择在切换步骤并返回后保留；完成页区分已保存与稍后连接文案', async () => {
  const { client, tree } = await mount({ step: 1, compute: { kaggleLogin: { login: { state: 'idle' }, start() {} }, colabLogin: { login: { state: 'idle' }, start() {} } } })
  try {
    buttonByText(tree, 'Google Colab').props.onClick()
    let next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /在浏览器中授权 Google/)
    buttonByText(next, '先体验，稍后连接').props.onClick()
    next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /接入后可以使用/)
    buttonByText(next, '上一步').props.onClick()
    next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /在浏览器中授权 Google/)
    buttonByText(next, '先体验，稍后连接').props.onClick()
    next = await client.rerenderRaw()
    buttonByText(next, '稍后配置').props.onClick()
    next = await client.rerenderRaw()
    assert.match(collectText(next).join(''), /还需要一条出图方式/)
  } finally { client.unmount() }
})

summary()
