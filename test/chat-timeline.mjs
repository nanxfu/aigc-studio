/**
 * 阶段十五 Phase A2：助手时间线测试（结果网格、舞台工具镜像、单图聚焦返回栈、intentHistory 隔离）。
 *
 * 纯逻辑直接 import `src/logic/chat.js` / `src/logic/intent.js`，不依赖 React；
 * hook 行为用 test/helpers/render.mjs 的假渲染器挂 `useChatThread`，断言真实状态流转。
 * 渲染层的网格 / 镜像卡 / 聚焦视图结构断言在 check-client-chat.mjs。
 *
 * 运行：$env:OFS_TEST_BUNDLE=".tmp/phase-a/build/timeline.js"; node test/chat-timeline.mjs
 */

import assert from 'node:assert/strict'

import { LIMITS, publicPresets } from '../shared/contract.js'
import { fallbackTranslate } from '../web/i18n.js'
import {
  agentThreadMessages,
  bubblePatch,
  bubbleUnchanged,
  currentFocusOf,
  focusBackLabelOf,
  focusEntryOf,
  focusNameOf,
  gridImagesOf,
  imageMetaOf,
  imagesKeyOf,
  mirrorToolEntries,
  popFocus,
  proposalTargetOf,
  pushFocus,
  strengthLabelOf,
} from '../web/logic/chat.js'
import { intentHistory } from '../web/logic/intent.js'
import { createCheckRunner } from './helpers/check.mjs'
import { createTestClient } from './helpers/render.mjs'
import { NOW } from './helpers/client-fixtures.mjs'

const { check, summary } = createCheckRunner()
const t = fallbackTranslate('zh')

/** 一组 4 张样本产物：与宿主 /state 的 job.output.images 同形。 */
const RESULT_IMAGES = [
  { path: 'imagen-output/job-1/01.png', file: '01.png', url: '/api/file?path=job1-01', width: 1024, height: 1024, seed: 7, seconds: 6.2 },
  { path: 'imagen-output/job-1/02.png', file: '02.png', url: '/api/file?path=job1-02', width: 1024, height: 1024, seed: 8, seconds: 6.2 },
  { path: 'imagen-output/job-1/03.png', file: '03.png', url: '/api/file?path=job1-03', width: 1024, height: 1024, seed: 9, seconds: 6.2 },
  { path: 'imagen-output/job-1/04.png', file: '04.png', url: '/api/file?path=job1-04', width: 1024, height: 1024, seed: 10, seconds: 6.2 },
]

/** 结果消息：模拟 bubblePatch 完成后的气泡形状（含首图兼容字段）。 */
const GRID_MESSAGE = {
  id: 10,
  role: 'assistant',
  kind: 'job',
  jobId: 'job-1',
  stage: 'done',
  text: '已生成，点击缩略图放大。',
  images: RESULT_IMAGES,
  image: RESULT_IMAGES[0].url,
  imagePath: RESULT_IMAGES[0].path,
  meta: '6.2 秒 · 种子 7',
}

// ── 6.2-1：任务完成气泡接收全部 1~4 张结果图 ──────────────────────

await check('纯逻辑：完成气泡收全部结果图，保留首图兼容字段', async () => {
  const current = { id: 1, role: 'assistant', kind: 'job', jobId: 'job-1', stage: 'pending', text: '已提交，等待开始…' }
  const patch = bubblePatch(t, { status: 'done', output: { images: RESULT_IMAGES } }, current)
  assert.equal(patch.stage, 'done')
  assert.equal(patch.images.length, 4, '完成态应映射全部 4 张结果图，不再只取首图')
  // images 项只保留气泡需要的六个字段（宿主的 file 等额外字段不进入消息）。
  assert.deepEqual(patch.images[2], {
    url: '/api/file?path=job1-03',
    path: 'imagen-output/job-1/03.png',
    width: 1024,
    height: 1024,
    seed: 9,
    seconds: 6.2,
  })
  // 首图兼容字段继续可用（旧组件 / 旧断言直接读 image / imagePath / meta）。
  assert.equal(patch.image, RESULT_IMAGES[0].url)
  assert.equal(patch.imagePath, RESULT_IMAGES[0].path)
  assert.ok(patch.meta.includes('6.2') && patch.meta.includes('种子 7'), '首图 meta 保留秒数与种子')
  // 结果图指纹变化时才需要重写气泡。
  assert.equal(imagesKeyOf(patch.images), RESULT_IMAGES.map((image) => image.path).join('|'))
  assert.equal(bubbleUnchanged({ ...current, ...patch }, patch), true, '内容相同的补丁不应重复写入')
  assert.equal(bubbleUnchanged({ ...current, ...patch, images: [RESULT_IMAGES[0]] }, patch), false, '结果图变化必须写入')
  // 缺 url 的旧记录按 /api/file?path= 补齐；缺失的数值保持 null。
  const withPath = bubblePatch(t, {
    status: 'done',
    output: { images: [{ path: 'imagen-output/old/01.png' }] },
  }, {})
  assert.equal(withPath.images[0].url, '/api/file?path=imagen-output%2Fold%2F01.png')
  assert.equal(withPath.images[0].seed, null)
  assert.equal(withPath.images[0].seconds, null)
  // 宿主快照临时缺产物时不覆盖已有结果图；非完成态仍是纯状态补丁。
  const kept = bubblePatch(t, { status: 'done', output: { images: [] } }, { images: patch.images })
  assert.deepEqual(kept.images, patch.images)
  assert.deepEqual(bubblePatch(t, { status: 'queued' }), { stage: 'queued', text: '排队等待出图…' })
  assert.deepEqual(bubblePatch(t, { status: 'running' }), { stage: 'running', text: '正在生成…' })
  assert.equal(bubblePatch(t, { status: 'mystery' }), null, '未知状态保持原样')
  // 消息 → 结果图：新版 images、旧版首图、超上限截断。
  assert.equal(gridImagesOf(GRID_MESSAGE).length, 4)
  assert.equal(gridImagesOf({ image: '/legacy/img.png', imagePath: 'imagen-output/a/01.png' }).length, 1, '旧记录回退成一张')
  assert.equal(gridImagesOf({}).length, 0)
  assert.equal(gridImagesOf({ images: [...RESULT_IMAGES, ...RESULT_IMAGES] }).length, LIMITS.count.max, '最多展示 4 张')
  // 网格标签与单图元信息。
  assert.equal(imageMetaOf(t, RESULT_IMAGES[0]), '6.2秒 · 种子 7')
  assert.equal(strengthLabelOf(t, 0.8), '重绘强度 0.8')
  assert.equal(strengthLabelOf(t, null), '')
})

// ── 6.2-2：舞台图片工具提交成功的镜像记录（两条带 kind） ──────────

await check('纯逻辑：舞台工具镜像记录带 kind 且不进意图上下文', async () => {
  const target = {
    path: 'imagen-output/base/01.png',
    url: '/api/file?path=base-01',
    width: 1024,
    height: 768,
    prompt: '底图提示词',
  }
  const entries = mirrorToolEntries(t, {
    tool: 'inpaint',
    job: { id: 'job-tool-1', status: 'queued' },
    target,
    body: { reference: { path: target.path, strength: 0.8 } },
  })
  assert.equal(entries.length, 2, '一次工具提交应镜像两条记录')
  const [record, job] = entries
  assert.equal(record.role, 'user')
  assert.equal(record.kind, 'tool')
  assert.equal(record.tool, 'inpaint')
  assert.equal(record.text, '对当前图发起了局部涂抹')
  assert.equal(record.image, target.url, '镜像记录带底图缩略图')
  assert.equal(record.imagePath, target.path)
  assert.equal(record.strength, 0.8)
  assert.equal(job.role, 'assistant')
  assert.equal(job.kind, 'job')
  assert.equal(job.jobId, 'job-tool-1', '任务气泡绑定提交响应里的任务 id')
  assert.equal(job.stage, 'pending')
  assert.equal(job.text, '已提交，等待开始…')
  // 整图重绘 / 无请求体：文案换成 img2img，且没有强度胶囊字段。
  const redraw = mirrorToolEntries(t, { tool: 'img2img', job: { id: 'job-tool-2' }, target })
  assert.equal(redraw[0].text, '对当前图发起了整图重绘')
  assert.equal(Object.prototype.hasOwnProperty.call(redraw[0], 'strength'), false)
  // 高清放大：即时工具同样镜像，请求体没有强度（reference 只有 path）。
  const upscale = mirrorToolEntries(t, {
    tool: 'upscale',
    job: { id: 'job-tool-3' },
    target,
    body: { tool: 'upscale', reference: { path: target.path } },
  })
  assert.equal(upscale.length, 2)
  assert.equal(upscale[0].text, '对当前图发起了高清放大')
  assert.equal(Object.prototype.hasOwnProperty.call(upscale[0], 'strength'), false)
  // 扩图：强度胶囊沿用 reference.strength（默认 1.0）。
  const outpaint = mirrorToolEntries(t, {
    tool: 'outpaint',
    job: { id: 'job-tool-4' },
    target,
    body: { tool: 'outpaint', reference: { path: target.path, strength: 1 } },
  })
  assert.equal(outpaint[0].text, '对当前图发起了扩图')
  assert.equal(outpaint[0].strength, 1)
  assert.equal(outpaint[1].jobId, 'job-tool-4')
  // 参数不全 / 未知工具：不追加（失败路径不会留下半条记录）。
  assert.deepEqual(mirrorToolEntries(t, { tool: 'nope', job: { id: 'x' }, target }), [])
  assert.deepEqual(mirrorToolEntries(t, { tool: 'inpaint', job: {}, target }), [])
  assert.deepEqual(mirrorToolEntries(t, { tool: 'inpaint', job: { id: 'x' } }), [])
  // 上下文隔离：kind='tool' 的用户记录与 kind='job' 的助手记录都被 intentHistory 跳过。
  const messages = [
    { id: 1, role: 'user', text: '画一只橘猫' },
    { id: 2, ...record },
    { id: 3, ...job },
    { id: 4, role: 'assistant', kind: 'intent', prompt: 'an orange cat' },
  ]
  assert.deepEqual(intentHistory(messages), [
    { role: 'user', content: '画一只橘猫' },
    { role: 'assistant', content: 'an orange cat' },
  ], '镜像记录不得进入意图模型的纯文本历史')
})

// ── 6.2-3：单图聚焦返回栈（逐层回退、栈空回线程） ────────────────

await check('纯逻辑：单图聚焦返回栈逐层回退与面包屑文案', async () => {
  const entry = focusEntryOf({ messageId: 10, image: RESULT_IMAGES[2], index: 2, count: 4 })
  assert.ok(entry, '合法图片应生成聚焦栈项')
  assert.equal(entry.messageId, 10)
  assert.equal(entry.index, 2)
  assert.equal(entry.count, 4)
  assert.equal(entry.path, RESULT_IMAGES[2].path)
  assert.equal(entry.seed, 9)
  assert.equal(focusEntryOf({ image: {} }), null, '既无路径也无地址的图不能聚焦')
  let stack = []
  assert.equal(currentFocusOf(stack), null)
  assert.equal(focusBackLabelOf(t, stack), '', '普通线程视图没有面包屑')
  stack = pushFocus(stack, entry)
  assert.equal(stack.length, 1)
  assert.equal(currentFocusOf(stack).path, RESULT_IMAGES[2].path)
  // 第一层的上一层是结果网格：用本批张数（「4 张生成结果」）。
  assert.equal(focusBackLabelOf(t, stack), '4 张生成结果')
  // 再钻一层：上一层变成父级单图，标签用层级名（带种子）。
  const deeper = pushFocus(stack, focusEntryOf({ messageId: 12, image: RESULT_IMAGES[3], index: 0, count: 1 }))
  assert.equal(deeper.length, 2)
  assert.equal(focusNameOf(t, entry), '单图聚焦 · 种子 9')
  assert.equal(focusBackLabelOf(t, deeper), '单图聚焦 · 种子 9')
  // 逐层出栈，入参不被就地修改。
  const backOne = popFocus(deeper)
  assert.equal(deeper.length, 2, 'popFocus 不得改写入参栈')
  assert.equal(backOne.length, 1)
  assert.equal(currentFocusOf(backOne).path, RESULT_IMAGES[2].path)
  const backToThread = popFocus(backOne)
  assert.equal(backToThread.length, 0)
  assert.equal(currentFocusOf(backToThread), null)
  // 无效入参不产生半层。
  assert.equal(pushFocus(stack, null).length, 1)
  assert.equal(popFocus([]).length, 0)
})

// ── M2.7：Agent 上下文回写与提案卡目标后端 ────────────────────────

await check('纯逻辑：Agent 历史回写产物路径，展示型气泡不进上下文', async () => {
  const messages = [
    { id: 1, role: 'user', text: '直接画一只橘猫' },
    {
      id: 2,
      role: 'assistant',
      kind: 'agent',
      text: '画好了。',
      images: [
        { path: 'outputs/job-a/01.png', url: '/api/file?path=a' },
        { path: 'outputs/job-a/02.png', url: '/api/file?path=b' },
        { path: 'outputs/job-a/01.png', url: '/api/file?path=a' },
      ],
    },
    { id: 3, role: 'user', kind: 'form', text: '表单提示词' },
    { id: 4, role: 'assistant', kind: 'job', jobId: 'job-a', text: '正在生成…' },
    { id: 5, role: 'assistant', kind: 'intent', summary: '一只橘猫', prompt: 'an orange cat' },
    { id: 6, role: 'assistant', kind: 'error', text: '失败' },
    { id: 7, role: 'assistant', kind: 'agent', text: '', images: [{ path: 'outputs/job-b/01.png' }] },
    { id: 8, role: 'assistant', kind: 'agent', text: '想先确认一下', clarify: { question: '要什么风格？' } },
  ]
  const history = agentThreadMessages(messages, '把它放大两倍')
  assert.deepEqual(history, [
    { role: 'user', content: '直接画一只橘猫' },
    { role: 'assistant', content: '画好了。\n[已生成图片] outputs/job-a/01.png、outputs/job-a/02.png' },
    { role: 'assistant', content: '一只橘猫' },
    { role: 'assistant', content: '[已生成图片] outputs/job-b/01.png' },
    { role: 'assistant', content: '想先确认一下' },
    { role: 'user', content: '把它放大两倍' },
  ], '产物路径必须回写，表单 / 任务 / 错误气泡必须跳过')
  // 空线程只发本轮输入；空输入不产生 message。
  assert.deepEqual(agentThreadMessages([], '你好'), [{ role: 'user', content: '你好' }])
  assert.deepEqual(agentThreadMessages([], ''), [])
})

await check('纯逻辑：提案卡目标后端按实时 provider 计算', async () => {
  // flux2-klein-4b 两种来源都支持；qwen-image-2.1 仅 Colab；flux2-klein-9b 仅 Colab 且 gated。
  const same = proposalTargetOf('flux2-klein-4b', { provider: 'kaggle' })
  assert.equal(same.kind, 'same')
  assert.equal(same.targetProvider, 'kaggle')
  assert.equal(same.gated, false)
  const cross = proposalTargetOf('qwen-image-2.1', { provider: 'kaggle' })
  assert.equal(cross.kind, 'cross')
  assert.equal(cross.targetProvider, 'colab')
  assert.equal(cross.preset.id, 'qwen-image-2.1')
  // 已经在目标后端时不再提示切换（按钮文案必须跟着实时状态变）。
  const already = proposalTargetOf('qwen-image-2.1', { provider: 'colab' })
  assert.equal(already.kind, 'same')
  assert.equal(already.targetProvider, 'colab')
  const gated = proposalTargetOf('flux2-klein-9b', { provider: 'kaggle' })
  assert.equal(gated.kind, 'cross')
  assert.equal(gated.gated, true)
  // 未知 / 空模型：回落普通按钮，不指向任何后端。
  assert.equal(proposalTargetOf('', { provider: 'kaggle' }).kind, 'none')
  assert.equal(proposalTargetOf('nope', { provider: 'kaggle' }).kind, 'none')
  // 旧字段缺失（旧宿主）按默认来源判断，不抛错。
  assert.equal(proposalTargetOf('qwen-image-2.1', {}).kind, 'cross')
  assert.equal(publicPresets().some((preset) => preset.id === 'qwen-image-2.1'), true)
})

// ── hook 行为：mirrorTool / focusImage / focusBack / newChat ──────

/**
 * 挂载 useChatThread 的最小 Harness：state / form / generate 固定，
 * 测试通过 latest.chat 直接调 hook 暴露的动作，断言真实消息与聚焦栈。
 */
async function mountChatThread() {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const React = client.react
  const h = React.createElement
  const { useChatThread } = client.hooks
  const latest = {}
  const form = {
    form: { presetId: 'sdxl-lightning', cfg: 0, seed: '' },
    negativeActive: false,
    patchForm: () => {},
    applyIntent: () => true,
  }
  function Harness(props) {
    const chat = useChatThread({
      t,
      isEn: false,
      alive: async (promise) => promise,
      state: { lastJob: null },
      form,
      generate: async () => true,
    })
    props.latest.chat = chat
    return h('div', { className: 'ofs-timeline-harness' }, String(chat.messages.length))
  }
  try {
    await client.mountRaw(Harness, { latest })
    await client.settle()
    return { client, latest }
  } catch (error) {
    client.unmount()
    throw error
  }
}

await check('hook：mirrorTool 追加工具记录与任务气泡，newChat 清空聚焦栈', async () => {
  const { client, latest } = await mountChatThread()
  try {
    // 舞台工具提交成功：组合层调用 mirrorTool（参数形状即 useStudio 的接线口径）。
    const ok = latest.chat.mirrorTool({
      tool: 'inpaint',
      job: { id: 'job-tool-1', status: 'queued' },
      target: { path: 'imagen-output/base/01.png', url: '/api/file?path=base-01', width: 1024, height: 1024 },
      body: { reference: { path: 'imagen-output/base/01.png', strength: 0.8 } },
    })
    assert.equal(ok, true, '合法入参应追加镜像记录')
    await client.rerenderRaw()
    let messages = latest.chat.messages
    assert.equal(messages.length, 2, '一条工具记录 + 一条任务气泡')
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].kind, 'tool')
    assert.equal(messages[0].imagePath, 'imagen-output/base/01.png')
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1].kind, 'job')
    assert.equal(messages[1].jobId, 'job-tool-1')
    assert.deepEqual(intentHistory(messages), [], '镜像记录不得进入意图上下文')
    // 参数不全时返回 false 且不追加半条记录。
    assert.equal(latest.chat.mirrorTool({ tool: 'inpaint', job: { id: '' } }), false)
    await client.rerenderRaw()
    assert.equal(latest.chat.messages.length, 2)
    // 聚焦后再新建对话：聚焦栈清空、线程清空。
    assert.equal(latest.chat.focusImage(GRID_MESSAGE, RESULT_IMAGES[2], 2), true)
    await client.rerenderRaw()
    assert.equal(latest.chat.focusDepth, 1, '点图后应进入单图聚焦')
    latest.chat.newChat()
    await client.rerenderRaw()
    assert.equal(latest.chat.focus, null, '新建对话应清空聚焦栈')
    assert.equal(latest.chat.focusDepth, 0)
    assert.equal(latest.chat.messages.length, 0)
    assert.equal(latest.chat.focusBackLabel, '')
  } finally {
    client.unmount()
  }
})

await check('hook：聚焦逐层回退且全程不改 messages', async () => {
  const { client, latest } = await mountChatThread()
  try {
    latest.chat.pushMessages([{ ...GRID_MESSAGE }])
    await client.rerenderRaw()
    const message = latest.chat.messages[0]
    const snapshot = JSON.stringify(latest.chat.messages)
    // 点击第 3 张 → 进入单图聚焦；messages 一个字都不该变。
    assert.equal(latest.chat.focusImage(message, RESULT_IMAGES[2], 2), true)
    await client.rerenderRaw()
    assert.equal(latest.chat.focus.path, RESULT_IMAGES[2].path)
    assert.equal(latest.chat.focus.index, 2)
    assert.equal(latest.chat.focus.count, 4, '聚焦栈项记录本批张数')
    assert.equal(latest.chat.focusBackLabel, '4 张生成结果')
    assert.equal(JSON.stringify(latest.chat.messages), snapshot, '聚焦不得改 messages')
    // 再钻一层（更深的层级），面包屑改为父级单图。
    latest.chat.focusImage(message, RESULT_IMAGES[1], 1)
    await client.rerenderRaw()
    assert.equal(latest.chat.focusDepth, 2)
    assert.equal(latest.chat.focus.path, RESULT_IMAGES[1].path)
    assert.equal(latest.chat.focusBackLabel, '单图聚焦 · 种子 9', '上一层是父级单图')
    // 逐层返回：第一次回到第 3 张，第二次回到普通线程。
    const first = latest.chat.focusBack()
    await client.rerenderRaw()
    assert.equal(first.path, RESULT_IMAGES[2].path, 'focusBack 返回新的栈顶供舞台同步')
    assert.equal(latest.chat.focusDepth, 1)
    assert.equal(latest.chat.focus.path, RESULT_IMAGES[2].path)
    const second = latest.chat.focusBack()
    await client.rerenderRaw()
    assert.equal(second, null, '栈空时返回 null，界面回到普通线程')
    assert.equal(latest.chat.focus, null)
    assert.equal(latest.chat.focusBackLabel, '')
    assert.equal(JSON.stringify(latest.chat.messages), snapshot, '返回全程不得改 messages')
  } finally {
    client.unmount()
  }
})

await check('hook：跨后端提案卡一步到位，在途任务与 Token 前置拦截', async () => {
  const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
  const React = client.react
  const h = React.createElement
  const { useChatThread } = client.hooks
  const latest = {}
  const calls = { switches: [], generates: [], presets: [], toasts: [] }
  const presets = publicPresets()
  const form = {
    form: { presetId: 'flux2-klein-4b', cfg: 1, seed: '9999', references: [] },
    negativeActive: false,
    dirty: false,
    draftEditing: false,
    patchForm: () => {},
    selectPreset: (id) => calls.presets.push(id),
    clearOrigin: () => {},
    markClean: () => {},
    parkDraft: () => {},
    applyIntent: () => true,
  }
  let context = { provider: 'kaggle', activeJob: null, hfTokenConfigured: true }
  function Harness(props) {
    const chat = useChatThread({
      t,
      isEn: false,
      alive: async (promise) => promise,
      ui: { showToast: (text) => calls.toasts.push(text) },
      state: { presets, lastJob: null },
      form,
      generate: async (overrides, options) => {
        calls.generates.push({ overrides, options })
        return true
      },
      getProviderContext: () => context,
      switchProvider: async (id) => {
        calls.switches.push(id)
        context = { ...context, provider: id }
        return true
      },
    })
    props.latest.chat = chat
    return h('div', { className: 'ofs-cross-harness' }, String(chat.messages.length))
  }
  try {
    await client.mountRaw(Harness, { latest })
    await client.settle()
    const card = {
      id: 1,
      proposal: true,
      prompt: 'a cat on a windowsill',
      count: 1,
      presetId: 'qwen-image-2.1',
      ratioId: '',
      negative: '',
      seed: null,
      lockSeed: false,
    }
    assert.equal(await latest.chat.generateIntent(card), true, '一步切换后应提交生成')
    assert.deepEqual(calls.switches, ['colab'], '应先把运行设置切到目标后端')
    assert.deepEqual(calls.presets, ['qwen-image-2.1'], '切换后应选中卡片推荐模型')
    assert.equal(calls.generates.length, 1)
    assert.equal(calls.generates[0].overrides.presetId, 'qwen-image-2.1')
    assert.equal(calls.generates[0].options.provider, 'colab', '能力预检必须按新后端判断')
    assert.equal(calls.generates[0].options.pushUser, false)
    assert.equal(calls.generates[0].overrides.seed, null, '卡片未指定种子时应清掉左栏旧固定种子残留')

    // 连点护栏：同一张卡片并发触发只应产生一次切换与一次提交。
    calls.switches.length = 0
    calls.generates.length = 0
    context = { provider: 'kaggle', activeJob: null, hfTokenConfigured: true }
    const [first, second] = await Promise.all([
      latest.chat.generateIntent(card),
      latest.chat.generateIntent(card),
    ])
    assert.equal(calls.switches.length, 1, '连点只允许切一次后端')
    assert.equal(calls.generates.length, 1, '连点只允许提交一次生成')
    assert.ok(first === true || second === true)

    // 在途任务：禁止跨后端一步切换（不切设置、不消耗 GPU）。
    calls.switches.length = 0
    calls.generates.length = 0
    calls.toasts.length = 0
    context = { provider: 'kaggle', activeJob: { id: 'job-running' }, hfTokenConfigured: true }
    assert.equal(await latest.chat.generateIntent(card), false)
    assert.deepEqual(calls.switches, [], '有在途任务时不得切后端')
    assert.equal(calls.generates.length, 0)
    assert.ok(calls.toasts.some((text) => text.includes('任务')), '应提示等待或取消在途任务')

    // gated 模型 + 未配置 HF Token：切换前拦下，避免先关旧会话再被远端 401。
    calls.toasts.length = 0
    context = { provider: 'kaggle', activeJob: null, hfTokenConfigured: false }
    const gatedCard = { ...card, presetId: 'flux2-klein-9b' }
    assert.equal(await latest.chat.generateIntent(gatedCard), false)
    assert.deepEqual(calls.switches, [], '缺 Token 时不得先切后端')
    assert.equal(calls.generates.length, 0)
    assert.ok(calls.toasts.some((text) => text.includes('HF Token')), '应提示补齐 Token')
  } finally {
    client.unmount()
  }
})

await check('hook：对话历史按工作区隔离持久化（刷新 / 切换不串记录）', async () => {
  const store = new Map()
  // 测试渲染器自带 sessionStorage 替身：把同一份存储注入每个 client，模拟「同一标签页刷新 / 切换」。
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  }
  const mounts = []
  async function mountAt(workspace) {
    const client = await createTestClient({ now: NOW, responses: {}, testBuild: true, sessionStorage: storage })
    const ReactLocal = client.react
    const h = ReactLocal.createElement
    const { useChatThread } = client.hooks
    const latest = {}
    function Harness(props) {
      const chat = useChatThread({
        t,
        isEn: false,
        alive: async (promise) => promise,
        state: { workspace: { current: workspace }, lastJob: null },
        form: { form: { presetId: 'sdxl-lightning', cfg: 0, seed: '' }, negativeActive: false },
        generate: async () => true,
      })
      props.latest.chat = chat
      return h('div', { className: 'ofs-persist-harness' }, String(chat.messages.length))
    }
    await client.mountRaw(Harness, { latest })
    await client.settle()
    mounts.push(client)
    return { client, latest }
  }
  try {
    const a1 = await mountAt('/workspace/a')
    a1.latest.chat.pushMessages([{ role: 'user', text: 'A 的对话' }])
    await a1.client.rerenderRaw()
    assert.ok(store.has('our-imagen.studio.chat.v1::/workspace/a'), '消息应写入 A 工作区的快照键')
    a1.client.unmount()
    mounts.pop()

    const b1 = await mountAt('/workspace/b')
    assert.equal(b1.latest.chat.messages.length, 0, 'B 工作区不能看到 A 的对话')
    b1.latest.chat.pushMessages([{ role: 'user', text: 'B 的对话' }])
    await b1.client.rerenderRaw()
    assert.ok(store.has('our-imagen.studio.chat.v1::/workspace/b'))
    b1.client.unmount()
    mounts.pop()

    const a2 = await mountAt('/workspace/a')
    await a2.client.settle()
    assert.equal(a2.latest.chat.messages.length, 1, '回到 A 应恢复自己的对话')
    assert.equal(a2.latest.chat.messages[0].text, 'A 的对话')
    // 「新建对话」同时清掉该工作区的持久化快照。
    a2.latest.chat.newChat()
    await a2.client.rerenderRaw()
    assert.equal(store.has('our-imagen.studio.chat.v1::/workspace/a'), false, '新建对话应清空该工作区快照')
  } finally {
    for (const client of mounts) client.unmount()
  }
})

await check('hook：sessionStorage 为空时从 Host /api/chat 恢复并回写（模拟重启端口变更）', async () => {
  const activeWorkspace = '/workspace/disk'
  const responses = {
    '/api/chat': {
      ok: true,
      workspace: activeWorkspace,
      messages: [
        { id: 10, role: 'user', text: '磁盘上的旧问题' },
        { id: 11, role: 'assistant', kind: 'agent', stage: 'done', text: '磁盘上的旧回答' },
      ],
    },
  }
  const client = await createTestClient({ now: NOW, responses, testBuild: true })
  const ReactLocal = client.react
  const h = ReactLocal.createElement
  const { useChatThread } = client.hooks
  const latest = {}
  function Harness(props) {
    const chat = useChatThread({
      t,
      isEn: false,
      alive: async (promise) => promise,
      state: { workspace: { current: activeWorkspace }, lastJob: null },
      form: { form: { presetId: 'sdxl-lightning', cfg: 0, seed: '' }, negativeActive: false },
      generate: async () => true,
    })
    props.latest.chat = chat
    return h('div', { className: 'ofs-disk-persist' }, String(chat.messages.length))
  }
  try {
    await client.mountRaw(Harness, { latest })
    await client.settle()
    assert.equal(latest.chat.messages.length, 2, 'sessionStorage 为空时应从 Host /api/chat 恢复旧对话')
    assert.equal(latest.chat.messages[1].text, '磁盘上的旧回答')
    // 新增消息经防抖回写 Host；验证序号推进到 12（不与 10/11 撞车）。
    latest.chat.pushMessages([{ role: 'user', text: '重启后新问一句' }])
    await client.rerenderRaw()
    assert.equal(latest.chat.messages[2].id, 12)
    client.advanceTimers(320)
    await client.settle()
    const posts = client.requests.filter((item) => item.path === '/api/chat' && item.method === 'POST')
    assert.ok(posts.length >= 1, '新增消息应防抖同步到 POST /api/chat')
    assert.equal(posts[posts.length - 1].body.messages.length, 3)
    // 「新建对话」立即传空数组清空磁盘记录。
    latest.chat.newChat()
    await client.settle()
    const clearPosts = client.requests.filter((item) => item.path === '/api/chat' && item.method === 'POST')
    assert.deepEqual(clearPosts[clearPosts.length - 1].body.messages, [], 'newChat 应立即清空 Host 对话记录')
  } finally {
    client.unmount()
  }
})

summary()
