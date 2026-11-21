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
import { convertToLlm } from '../server/agent/message-adapter.js'
import { createToolRegistry } from '../server/agent/tools.js'
import { createLlmService } from '../server/llm/service.js'
import { createAgentRoutes } from '../server/routes/agent.js'

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

function makeRegistry() {
  const registry = createToolRegistry()
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
        data: { prompt: args.prompt },
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
