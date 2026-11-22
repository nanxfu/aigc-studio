#!/usr/bin/env node
/**
 * 创作 Agent 运行时测试（基于 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）。
 *
 * 覆盖：
 *  1. OpenAI 兼容多轮工具调用：模型首轮返回 tool_calls → pi-agent-core 执行工具并回传标准 toolResult → 模型次轮输出终稿；
 *  2. Anthropic Messages 多轮工具调用：content_block tool_use → tool_result 交替消息合法性；
 *  3. `extractGeneratedImages` 与 `tool-result` 事件自动提取产物图信息；
 *  4. `convertToLlm` 过滤 UI 自定义消息、保留标准上下文；
 *  5. `/api/agent/chat` 路由的非流式与 SSE 流式事件契约（含 `text-delta` / `tool-start` / `tool-result` / `done`）。
 *
 * 运行：node test/agent-runtime.mjs
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCheckRunner } from './helpers/check.mjs'
import { createAppConfig } from '../server/app-config.js'
import { createAgentRuntime } from '../server/agent/runtime.js'
import { registerAguiTools } from '../server/agent/agui.js'
import { convertToLlm } from '../server/agent/message-adapter.js'
import { createToolRegistry } from '../server/agent/tools.js'
import { createLlmService } from '../server/llm/service.js'
import { hasLocalKaggleCredentials } from '../server/kaggle-client.js'
import { createAgentRoutes } from '../server/routes/agent.js'
import { createChatRoutes } from '../server/routes/chat.js'

const { check, summary } = createCheckRunner()

const sse = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const anthropicEvent = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

async function startMultiTurnMock() {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    const pathname = String(req.url || '/').split('?')[0]
    requests.push({ method: req.method, pathname, headers: req.headers, body })

    const sendSse = (text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(text)
    }

    if (pathname === '/v1/chat/completions') {
      const hasToolResult = Array.isArray(body?.messages) && body.messages.some((m) => m.role === 'tool')
      if (!hasToolResult) {
        return sendSse([
          sse({
            choices: [{
              delta: {
                tool_calls: [{ index: 0, id: 'call_gen_1', type: 'function', function: { name: 'imagen_generate', arguments: '{"prompt":"blue cat"}' } }],
              },
            }],
          }),
          sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          sse('[DONE]'),
        ].join(''))
      }
      return sendSse([
        sse({ choices: [{ delta: { content: '已经' } }] }),
        sse({ choices: [{ delta: { content: '帮你画好啦。' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        sse('[DONE]'),
      ].join(''))
    }

    if (pathname === '/v1/messages') {
      const hasToolResult = Array.isArray(body?.messages)
        && body.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
      if (!hasToolResult) {
        return sendSse([
          anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 4 } } }),
          anthropicEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'imagen_recipes', input: {} },
          }),
          anthropicEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"keyword":"cyberpunk"}' },
          }),
          anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
          anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
          anthropicEvent('message_stop', { type: 'message_stop' }),
        ].join(''))
      }
      return sendSse([
        anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 6 } } }),
        anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '找到赛博朋克配方。' } }),
        anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
        anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
        anthropicEvent('message_stop', { type: 'message_stop' }),
      ].join(''))
    }

    res.writeHead(404)
    res.end('not found')
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolveClose) => {
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    }),
  }
}

/**
 * AGUI 专用 mock：第一轮按用户意图返回对应工具调用，第二轮（若发生）返回终稿。
 * 记录每个请求，供断言「UI 工具展示后本轮立即结束、不再多跑一次 LLM」。
 */
async function startAguiMock() {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    requests.push({ pathname: String(req.url || '/').split('?')[0], body })
    const sendSse = (text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(text)
    }
    if (String(req.url || '').split('?')[0] !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const hasToolResult = Array.isArray(body?.messages) && body.messages.some((m) => m.role === 'tool')
    const lastUser = [...(Array.isArray(body?.messages) ? body.messages : [])]
      .reverse()
      .find((m) => m.role === 'user')
    const text = typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content) ? lastUser.content.map((b) => b.text || '').join('') : ''

    if (hasToolResult) {
      return sendSse([
        sse({ choices: [{ delta: { content: '已经处理好了。' } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        sse('[DONE]'),
      ].join(''))
    }

    let call = null
    if (text.includes('提案')) {
      call = {
        name: 'ui_propose_generation',
        arguments: JSON.stringify({
          prompt: 'a black cat on a neon rooftop in the rain, cinematic 16:9',
          summaryZh: '雨夜霓虹屋顶上的黑猫',
          negativePrompt: 'blurry',
          presetId: 'sdxl-lightning',
          ratioId: '16:9',
          count: 2,
          notes: '建议 16:9 电影感',
        }),
      }
    } else if (text.includes('澄清')) {
      call = {
        name: 'ui_ask_clarify',
        arguments: JSON.stringify({
          question: '想要什么风格？',
          dimensions: [{
            id: 'style',
            label: '风格',
            multi: false,
            options: [{ label: '写实', value: '写实' }, { label: '插画', value: '插画' }],
          }],
          draft: { prompt: 'draft cat in rain', summaryZh: '雨夜猫草稿', presetId: 'sdxl-lightning', count: 1 },
        }),
      }
    } else if (text.includes('舞台')) {
      call = { name: 'imagen_stage_context', arguments: '{}' }
    } else if (text.includes('直接生成')) {
      call = { name: 'imagen_generate', arguments: JSON.stringify({ prompt: 'a cat' }) }
    }

    if (text.includes('同轮并发')) {
      return sendSse([
        sse({
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_prop_1',
                  type: 'function',
                  function: {
                    name: 'ui_propose_generation',
                    arguments: JSON.stringify({ prompt: 'safe cat prompt', summaryZh: '安全提案' }),
                  },
                },
                {
                  index: 1,
                  id: 'call_gen_2',
                  type: 'function',
                  function: {
                    name: 'imagen_generate',
                    arguments: JSON.stringify({ prompt: 'should not run' }),
                  },
                },
              ],
            },
          }],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        sse('[DONE]'),
      ].join(''))
    }
    if (call) {
      return sendSse([
        sse({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: `call_${call.name}`, type: 'function', function: call }] },
          }],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        sse('[DONE]'),
      ].join(''))
    }
    return sendSse([
      sse({ choices: [{ delta: { content: '好的。' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sse('[DONE]'),
    ].join(''))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolveClose) => {
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    }),
  }
}

/** 带 AGUI 工具的注册表：业务工具与提案 / 澄清 / 舞台上下文共存。 */
function makeAguiRegistry() {
  const registry = makeRegistry()
  registerAguiTools(registry)
  return registry
}

function makeRegistry() {  const registry = createToolRegistry()
  registry.register({
    name: 'imagen_generate',
    description: 'generate image',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    },
    async execute(args) {
      return {
        text: [
          '任务 j_1：done（1.2s）',
          '产物：',
          '- outputs/20261121-100000-j_1/01.png（1024×1024，seed 42）',
          '  /api/file?path=outputs%2F20261121-100000-j_1%2F01.png',
        ].join('\n'),
        data: {
          prompt: args.prompt,
          jobId: 'j_1',
          jobIds: ['j_1'],
          presetId: 'sdxl-lightning',
          count: 1,
        },
      }
    },
  })
  registry.register({
    name: 'imagen_recipes',
    description: 'search recipes',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string' } },
    },
    async execute(args) {
      return { text: `找到配方：${args.keyword || 'all'}` }
    },
  })
  return registry
}

async function main() {
  const mock = await startMultiTurnMock()
  try {
    await check('pi-agent-core OpenAI 多轮工具循环与图片产物提取', async () => {
      const llm = createLlmService({
        getConfig: () => ({
          provider: 'openai',
          baseUrl: `${mock.origin}/v1`,
          model: 'gpt-4o-mini',
          apiKey: 'sk-test',
        }),
      })
      const runtime = createAgentRuntime({ llm, tools: makeRegistry() })
      const events = []
      const result = await runtime.run({
        messages: [{ role: 'user', content: '帮我画一只蓝猫' }],
        system: '你是创作助手',
        onEvent: (event) => events.push(event),
      })
      assert.equal(result.text, '已经帮你画好啦。')
      assert.equal(result.steps, 2, '首轮调工具 + 次轮输出终稿应为 2 步')
      assert.equal(result.toolResults.length, 1)
      assert.equal(result.toolResults[0].name, 'imagen_generate')
      assert.equal(result.images.length, 1)
      assert.equal(result.images[0].path, 'outputs/20261121-100000-j_1/01.png')
      assert.ok(events.some((e) => e.type === 'tool-start' && e.name === 'imagen_generate'))
      assert.ok(events.some((e) => e.type === 'tool-result' && e.images?.length === 1))
      assert.ok(events.some((e) => e.type === 'text-delta'))

      const secondReq = mock.requests.filter((r) => r.pathname === '/v1/chat/completions').at(-1)
      assert.ok(secondReq.body.messages.some((m) => m.role === 'tool'), '第二轮应发送标准 role=tool 消息而非 user 文本')
    })

    await check('pi-agent-core Anthropic 原生 tool_use / tool_result 多轮循环', async () => {
      const llm = createLlmService({
        getConfig: () => ({
          provider: 'anthropic',
          baseUrl: mock.origin,
          model: 'claude-sonnet-4-5',
          apiKey: 'sk-ant-test',
        }),
      })
      const runtime = createAgentRuntime({ llm, tools: makeRegistry() })
      const result = await runtime.run({
        messages: [{ role: 'user', content: '查一下赛博朋克配方' }],
      })
      assert.equal(result.text, '找到赛博朋克配方。')
      assert.equal(result.steps, 2)
      const secondReq = mock.requests.filter((r) => r.pathname === '/v1/messages').at(-1)
      const toolResultMsg = secondReq.body.messages.find(
        (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
      )
      assert.ok(toolResultMsg, 'Anthropic 第二轮应带原生 tool_result 内容块')
    })

    await check('convertToLlm 过滤 UI 自定义消息并保留标准消息', async () => {
      const converted = convertToLlm([
        { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
        { role: 'ui-card', kind: 'intent', prompt: 'ignore me' },
        { role: 'custom', content: '补充说明', timestamp: 2 },
        { role: 'toolResult', toolCallId: 'c1', toolName: 't', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 },
      ])
      assert.equal(converted.length, 3)
      assert.equal(converted[0].role, 'user')
      assert.equal(converted[1].role, 'user')
      assert.equal(converted[2].role, 'toolResult')
    })

    await check('/api/agent/chat SSE 路由输出流式事件与终态图片', async () => {
      const llm = createLlmService({
        getConfig: () => ({
          provider: 'openai',
          baseUrl: `${mock.origin}/v1`,
          model: 'gpt-4o-mini',
          apiKey: 'sk-test',
        }),
      })
      const tools = makeRegistry()
      const routes = createAgentRoutes({ llm, tools })
      const route = routes.find((r) => r.name === 'agentChat')
      assert.ok(route)

      const apiServer = createServer((req, res) => route.handler(req, res))
      await new Promise((resolveListen) => apiServer.listen(0, '127.0.0.1', resolveListen))
      try {
        const { port } = apiServer.address()
        const response = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: '画蓝猫' }] }),
        })
        assert.equal(response.status, 200)
        const raw = await response.text()
        const events = raw
          .split(/\n\n+/)
          .filter((block) => block.startsWith('data: '))
          .map((block) => JSON.parse(block.slice(6)))
        assert.ok(events.some((e) => e.type === 'tool-start'))
        assert.ok(events.some((e) => e.type === 'tool-result' && e.images?.length === 1))
        const done = events.find((e) => e.type === 'done')
        assert.ok(done, '应有 done 事件')
        assert.equal(done.text, '已经帮你画好啦。')
        assert.equal(done.images.length, 1)
      } finally {
        await new Promise((resolveClose) => {
          apiServer.closeAllConnections?.()
          apiServer.close(() => resolveClose())
        })
      }
    })

    await check('Agent 系统提示词：参考图槽、跨后端目录与凭据账本（M2.7）', async () => {
      const mock = await startMultiTurnMock()
      const llm = createLlmService({
        getConfig: () => ({
          provider: 'openai',
          baseUrl: `${mock.origin}/v1`,
          model: 'gpt-4o-mini',
          apiKey: 'sk-test',
        }),
      })
      const tools = makeRegistry()
      const routes = createAgentRoutes({
        llm,
        tools,
        getProvider: () => 'kaggle',
        getBackends: () => [
          { id: 'kaggle', configured: true, note: '账号可用' },
          { id: 'colab', configured: true, note: 'Google 账号已授权' },
        ],
        getHfTokenConfigured: () => false,
        getSession: () => ({ state: 'ready', provider: 'kaggle', device: 'T4' }),
        getQueue: () => ({ running: false, pending: 0 }),
      })
      const route = routes.find((item) => item.name === 'agentChat')
      const apiServer = createServer((req, res) => route.handler(req, res))
      await new Promise((resolveListen) => apiServer.listen(0, '127.0.0.1', resolveListen))
      try {
        const { port } = apiServer.address()
        const response = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: '参考这张图画一只猫' }],
            presetId: 'sdxl-lightning',
            references: [
              'outputs/2026/11/22/ref-a.png',
              'outputs/2026/11/22/ref-a.png',
              '../etc/passwd',
              'outputs/2026/11/22/ref-b.png',
            ],
            stream: false,
          }),
        })
        assert.equal(response.status, 200)
        await response.json()
        const system = (mock.requests[0]?.body?.messages ?? [])
          .filter((message) => message.role === 'system')
          .map((message) => (typeof message.content === 'string' ? message.content : ''))
          .join('\n')
        assert.ok(system.includes('待生成参考图槽'), '应把 references 注入 Layer 2')
        assert.ok(system.includes('outputs/2026/11/22/ref-a.png'))
        assert.ok(system.includes('outputs/2026/11/22/ref-b.png'))
        assert.ok(!system.includes('ref-a.png、outputs/2026/11/22/ref-a.png'), '重复路径应去重')
        assert.ok(!system.includes('../etc/passwd'), '非法路径应丢弃，不进入模型上下文')
        assert.ok(system.includes('当前表单模型：SDXL Lightning'), '应注入当前表单模型及其参考能力')
        assert.ok(system.includes('不支持原生参考图'))
        assert.ok(system.includes('FLUX.2 Klein 9B'), '跨已配置后端的目录应包含 9B 模型（Colab / 私有 Worker）')
        assert.ok(!system.includes('仅 Colab'), '9B 已补 private-worker 来源，不再只有 Colab')
        assert.ok(system.includes('可切换后端：Colab'), '应告知可切换的后端')
        assert.ok(system.includes('HuggingFace Token：未配置'), '应注入 HF Token 门控事实')
        assert.ok(system.includes('需 HF Token'), '目录里的 gated 标签应可见')
      } finally {
        await new Promise((resolveClose) => {
          apiServer.closeAllConnections?.()
          apiServer.close(() => resolveClose())
        })
        await mock.close().catch(() => {})
      }
    })

    await check('Agent 本地兜底：挂了参考图且当前模型不支持时优先改选支持参考的模型（M2.7）', async () => {
      const llm = createLlmService({ getConfig: () => ({}) })
      assert.equal(llm.getSelection(), null, '无配置时应走本地兜底')
      const routes = createAgentRoutes({ llm, tools: makeRegistry(), getProvider: () => 'kaggle' })
      const route = routes.find((item) => item.name === 'agentChat')
      const apiServer = createServer((req, res) => route.handler(req, res))
      await new Promise((resolveListen) => apiServer.listen(0, '127.0.0.1', resolveListen))
      try {
        const { port } = apiServer.address()
        const post = async (references) => {
          const response = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              messages: [{ role: 'user', content: '参考这张图生成一张新海报' }],
              presetId: 'sdxl-lightning',
              ...(references ? { references } : {}),
              stream: false,
            }),
          })
          assert.equal(response.status, 200)
          return response.json()
        }
        const withRefs = await post(['outputs/2026/11/22/ref-a.png'])
        assert.equal(withRefs.pending?.type, 'proposal')
        assert.equal(withRefs.pending.presetId, 'flux2-klein-4b', 'kaggle 上应改选支持参考的 flux2-klein-4b')
        assert.ok(withRefs.pending.notes.includes('已为参考图改选'), '本地兜底应说明为什么换模型')
        // 没有参考图时不改模型，仍是当前预设。
        const noRefs = await post(null)
        assert.equal(noRefs.pending.presetId, 'sdxl-lightning')
        assert.ok(noRefs.pending.notes.includes('本地模式'))
      } finally {
        await new Promise((resolveClose) => {
          apiServer.closeAllConnections?.()
          apiServer.close(() => resolveClose())
        })
      }
    })

    await check('AGUI 提案卡：ui_propose_generation 触发 proposal 事件并立即结束本轮', async () => {
      const agui = await startAguiMock()
      try {
        const llm = createLlmService({
          getConfig: () => ({
            provider: 'openai',
            baseUrl: `${agui.origin}/v1`,
            model: 'gpt-4o-mini',
            apiKey: 'sk-test',
          }),
        })
        const runtime = createAgentRuntime({ llm, tools: makeAguiRegistry() })
        const events = []
        const result = await runtime.run({
          messages: [{ role: 'user', content: '帮我提案画一只雨夜黑猫' }],
          system: '你是创作助手',
          locale: 'zh',
          onEvent: (event) => events.push(event),
        })
        const proposal = events.find((event) => event.type === 'proposal')
        assert.ok(proposal, '应发出 proposal 事件')
        assert.equal(proposal.prompt, 'a black cat on a neon rooftop in the rain, cinematic 16:9')
        assert.equal(proposal.summaryZh, '雨夜霓虹屋顶上的黑猫')
        assert.equal(proposal.presetId, 'sdxl-lightning')
        assert.equal(proposal.ratioId, '16:9')
        assert.equal(proposal.count, 2)
        assert.equal(result.pending?.type, 'proposal', 'done 应带 pending 供非流式客户端兜底')
        assert.equal(result.stopReason, 'awaiting-user', '展示卡片后本轮应以 awaiting-user 结束')
        assert.equal(result.text, '', '提案卡轮不应再输出第二段正文')
        assert.equal(agui.requests.length, 1, '卡片展示后不得再跑一次 LLM（省 Token 且避免重复提交）')
        assert.equal(events.some((event) => event.type === 'tool-result'), false, 'UI 工具不再重复发 tool-result')
      } finally {
        await agui.close().catch(() => {})
      }
    })

    await check('AGUI 澄清卡：dimensions + draft 进入 clarify 事件', async () => {
      const agui = await startAguiMock()
      try {
        const llm = createLlmService({
          getConfig: () => ({
            provider: 'openai',
            baseUrl: `${agui.origin}/v1`,
            model: 'gpt-4o-mini',
            apiKey: 'sk-test',
          }),
        })
        const runtime = createAgentRuntime({ llm, tools: makeAguiRegistry() })
        const events = []
        const result = await runtime.run({
          messages: [{ role: 'user', content: '先澄清一下要什么风格' }],
          onEvent: (event) => events.push(event),
        })
        const clarify = events.find((event) => event.type === 'clarify')
        assert.ok(clarify, '应发出 clarify 事件')
        assert.equal(clarify.question, '想要什么风格？')
        assert.equal(clarify.dimensions[0].id, 'style')
        assert.deepEqual(clarify.dimensions[0].options.map((option) => option.value), ['写实', '插画'])
        assert.equal(clarify.options.length, 2, '旧版 options 字段也要有，兼容旧客户端')
        assert.equal(clarify.draft.prompt, 'draft cat in rain', '草稿方案随澄清卡下发')
        assert.equal(result.pending?.type, 'clarify')
        assert.equal(result.stopReason, 'awaiting-user')
        assert.equal(agui.requests.length, 1)
      } finally {
        await agui.close().catch(() => {})
      }
    })

    await check('AGUI 作业绑定：工具返回 jobIds 时发出 job-bound', async () => {
      const agui = await startAguiMock()
      try {
        const llm = createLlmService({
          getConfig: () => ({
            provider: 'openai',
            baseUrl: `${agui.origin}/v1`,
            model: 'gpt-4o-mini',
            apiKey: 'sk-test',
          }),
        })
        const runtime = createAgentRuntime({ llm, tools: makeAguiRegistry() })
        const events = []
        const result = await runtime.run({
          messages: [{ role: 'user', content: '直接生成一只猫' }],
          onEvent: (event) => events.push(event),
        })
        const bound = events.find((event) => event.type === 'job-bound')
        assert.ok(bound, '直接生成应发出 job-bound，前端据此显示进度')
        assert.equal(bound.jobId, 'j_1')
        assert.equal(bound.presetId, 'sdxl-lightning')
        assert.equal(result.stopReason, 'stop', '直接执行路径应正常跑完第二轮到终稿')
        assert.equal(result.text, '已经处理好了。')
        assert.equal(agui.requests.length, 2, '直接执行需要第二轮把工具结果交回模型')
      } finally {
        await agui.close().catch(() => {})
      }
    })

    await check('舞台上下文工具：读取本轮 stage 并返回当前作品信息', async () => {
      const agui = await startAguiMock()
      try {
        const llm = createLlmService({
          getConfig: () => ({
            provider: 'openai',
            baseUrl: `${agui.origin}/v1`,
            model: 'gpt-4o-mini',
            apiKey: 'sk-test',
          }),
        })
        const runtime = createAgentRuntime({ llm, tools: makeAguiRegistry() })
        const events = []
        await runtime.run({
          messages: [{ role: 'user', content: '把舞台这张图记下来' }],
          stage: {
            imagePath: 'imagen-output/20260101-120000-j_1/01.png',
            presetId: 'sdxl-lightning',
            width: 1024,
            height: 1024,
            seed: 42,
            prompt: 'stage prompt',
          },
          onEvent: (event) => events.push(event),
        })
        const toolResult = events.find((event) => event.type === 'tool-result' && event.name === 'imagen_stage_context')
        assert.ok(toolResult, '应产生 imagen_stage_context 的工具结果')
        assert.ok(toolResult.text.includes('imagen-output/20260101-120000-j_1/01.png'), '应返回舞台作品路径')
        assert.ok(toolResult.text.includes('seed：42'), '应返回 seed')
        assert.ok(toolResult.text.includes('stage prompt'), '应返回原始 Prompt')
      } finally {
        await agui.close().catch(() => {})
      }
    })

    await check('无 LLM Key：/api/agent/chat 本地兜底返回提案卡而不是 503', async () => {
      const llm = createLlmService({ getConfig: () => ({}) })
      const tools = makeAguiRegistry()
      const routes = createAgentRoutes({ llm, tools })
      const route = routes.find((r) => r.name === 'agentChat')
      const apiServer = createServer((req, res) => route.handler(req, res))
      await new Promise((resolveListen) => apiServer.listen(0, '127.0.0.1', resolveListen))
      try {
        const { port } = apiServer.address()
        const response = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: '画一只橘猫' }], locale: 'zh' }),
        })
        assert.equal(response.status, 200, '未配置模型时应静默降级，不返回 503')
        const raw = await response.text()
        const events = raw.split(/\n\n+/).filter((block) => block.startsWith('data: ')).map((block) => JSON.parse(block.slice(6)))
        const proposal = events.find((event) => event.type === 'proposal')
        assert.ok(proposal, '降级路径也应产出提案卡')
        assert.equal(proposal.source, 'local')
        assert.ok(proposal.prompt.includes('橘猫'))
        const done = events.find((event) => event.type === 'done')
        assert.equal(done.pending?.type, 'proposal')
      } finally {
        await new Promise((resolveClose) => {
          apiServer.closeAllConnections?.()
          apiServer.close(() => resolveClose())
        })
      }
    })

    await check('并发工具护栏：同轮出现 ui_propose_generation 后阻止后续 imagen_generate 执行', async () => {
      const agui = await startAguiMock()
      let generateCalls = 0
      const registry = createToolRegistry()
      registerAguiTools(registry)
      registry.register({
        name: 'imagen_generate',
        description: 'generate image',
        parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        async execute() {
          generateCalls += 1
          return { text: 'should not execute' }
        },
      })
      try {
        const llm = createLlmService({
          getConfig: () => ({
            provider: 'openai',
            baseUrl: `${agui.origin}/v1`,
            model: 'gpt-4o-mini',
            apiKey: 'sk-test',
          }),
        })
        const runtime = createAgentRuntime({ llm, tools: registry })
        const events = []
        const result = await runtime.run({
          messages: [{ role: 'user', content: '同轮并发测试' }],
          onEvent: (event) => events.push(event),
        })
        assert.equal(generateCalls, 0, '产生交互卡片后同轮后续生成工具必须被拦截，不得消耗 GPU')
        assert.equal(result.stopReason, 'awaiting-user')
        assert.equal(result.pending?.type, 'proposal')
        assert.ok(events.some((event) => event.type === 'proposal'))
      } finally {
        await agui.close().catch(() => {})
      }
    })

    await check('SSE 断连透传 AbortSignal：前端中止时立即 abort agent.run', async () => {
      let receivedSignal = null
      let abortedObserved = false
      const fakeRuntime = {
        run(input) {
          receivedSignal = input.signal
          return new Promise((_resolve, reject) => {
            input.onEvent?.({ type: 'text-delta', step: 1, text: 'hi' })
            input.signal?.addEventListener('abort', () => {
              abortedObserved = true
              const err = new Error('aborted')
              err.code = 'llm_aborted'
              reject(err)
            }, { once: true })
          })
        },
      }
      const llm = { getSelection: () => ({ provider: 'openai', model: 'gpt-4o-mini' }) }
      const routes = createAgentRoutes({ llm, tools: makeRegistry(), runtime: fakeRuntime })
      const route = routes.find((r) => r.name === 'agentChat')
      const apiServer = createServer((req, res) => route.handler(req, res))
      await new Promise((resolveListen) => apiServer.listen(0, '127.0.0.1', resolveListen))
      try {
        const { port } = apiServer.address()
        const clientAbort = new AbortController()
        const response = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
          signal: clientAbort.signal,
        })
        const reader = response.body.getReader()
        await reader.read()
        clientAbort.abort()
        await reader.cancel().catch(() => {})
        await new Promise((resolveWait) => setTimeout(resolveWait, 60))
        assert.ok(receivedSignal, 'agent.run 必须收到 AbortSignal')
        assert.equal(receivedSignal.aborted, true, '连接断开后 signal.aborted 必须变为 true')
        assert.equal(abortedObserved, true, 'agent.run 的 abort 监听器应被触发')
      } finally {
        await new Promise((resolveClose) => {
          apiServer.closeAllConnections?.()
          apiServer.close(() => resolveClose())
        })
      }
    })

    await check('app-config 使用 AES-256-GCM 加密存放 llm.json 并自动迁移明文旧配置', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'aigc-appcfg-enc-'))
      try {
        const keyHex = randomBytes(32).toString('hex')
        const cfg1 = createAppConfig({ dataDir: dir, credentialKey: keyHex })
        await cfg1.whenReady()
        const saved = await cfg1.saveSettings({ llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-secret-abc123' } })
        assert.equal(saved.ok, true)

        const rawDisk = JSON.parse(await readFile(join(dir, 'credentials', 'llm.json'), 'utf8'))
        assert.equal(rawDisk.enc, 'aes-256-gcm', '有主密钥时磁盘应写入 AES-256-GCM 密文')
        assert.equal(rawDisk.apiKey, undefined, '加密模式下磁盘不得出现明文 apiKey')

        const cfg2 = createAppConfig({ dataDir: dir, credentialKey: keyHex })
        await cfg2.whenReady()
        assert.equal(cfg2.getLlmConfig().apiKey, 'sk-secret-abc123', '用同一主密钥应能正确解密恢复')

        // 明文迁移：写入旧版明文 llm.json，再用带主密钥的实例读取应自动升级为密文。
        const dirLegacy = await mkdtemp(join(tmpdir(), 'aigc-appcfg-legacy-'))
        try {
          await mkdir(join(dirLegacy, 'credentials'), { recursive: true })
          await writeFile(join(dirLegacy, 'credentials', 'llm.json'), JSON.stringify({ schema: 1, apiKey: 'sk-legacy-plain' }), 'utf8')
          const cfgLegacy = createAppConfig({ dataDir: dirLegacy, credentialKey: keyHex })
          await cfgLegacy.whenReady()
          assert.equal(cfgLegacy.getLlmConfig().apiKey, 'sk-legacy-plain')
          const migratedDisk = JSON.parse(await readFile(join(dirLegacy, 'credentials', 'llm.json'), 'utf8'))
          assert.equal(migratedDisk.enc, 'aes-256-gcm', '旧明文配置应在加载后自动升级为密文')
        } finally {
          await rm(dirLegacy, { recursive: true, force: true }).catch(() => {})
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    })

    await check('chat-store 与 /api/chat 路由：工作区对话落盘、损坏回落与清空', async () => {
      const wsDir = await mkdtemp(join(tmpdir(), 'aigc-chat-ws-'))
      try {
        const ctx = { config: { outputDir: wsDir } }
        const routes = createChatRoutes({ ctx, log: console })
        const route = routes[0]
        const apiServer = createServer((req, res) => route.handler(req, res))
        await new Promise((resolveListen) => apiServer.listen(0, '127.0.0.1', resolveListen))
        try {
          const { port } = apiServer.address()
          const base = `http://127.0.0.1:${port}/api/chat`
          const empty = await (await fetch(base)).json()
          assert.deepEqual(empty.messages, [])

          const saved = await (await fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              messages: [
                { id: 1, role: 'user', text: '画一只猫' },
                { id: 2, role: 'assistant', kind: 'job', jobId: 'j1', stage: 'running', text: '生成中' },
                { id: 3, role: 'assistant', kind: 'agent', stage: 'running', text: '这是猫' },
              ],
            }),
          })).json()
          assert.equal(saved.ok, true)
          assert.equal(saved.messages.length, 2, '任务气泡不应落盘')
          assert.equal(saved.messages[1].stage, 'done', '中断生成中应收敛为 done')

          const reloaded = await (await fetch(base)).json()
          assert.equal(reloaded.messages.length, 2)
          assert.equal(reloaded.messages[0].text, '画一只猫')

          const cleared = await (await fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [] }),
          })).json()
          assert.deepEqual(cleared.messages, [])
          const afterClear = await (await fetch(base)).json()
          assert.deepEqual(afterClear.messages, [])
        } finally {
          await new Promise((resolveClose) => {
            apiServer.closeAllConnections?.()
            apiServer.close(() => resolveClose())
          })
        }
      } finally {
        await rm(wsDir, { recursive: true, force: true }).catch(() => {})
      }
    })

    await check('hasLocalKaggleCredentials：纯本地识别 Kaggle 凭据且无凭据时返回 false', async () => {
      const home = await mkdtemp(join(tmpdir(), 'aigc-kaggle-home-'))
      try {
        assert.equal(await hasLocalKaggleCredentials({}, { homeDir: home, env: {} }), false)
        await mkdir(join(home, '.kaggle'), { recursive: true })
        await writeFile(join(home, '.kaggle', 'kaggle.json'), JSON.stringify({ username: 'demo', key: 'k123' }), 'utf8')
        assert.equal(await hasLocalKaggleCredentials({}, { homeDir: home, env: {} }), true)
        assert.equal(await hasLocalKaggleCredentials({}, { homeDir: join(home, 'empty'), env: { KAGGLE_API_TOKEN: 'tok' } }), true)
      } finally {
        await rm(home, { recursive: true, force: true }).catch(() => {})
      }
    })
  } finally {
    await mock.close().catch(() => {})
  }

  const result = summary()
  process.exitCode = result.failed > 0 ? 1 : process.exitCode
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
