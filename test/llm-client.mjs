#!/usr/bin/env node
/**
 * LLM 客户端离线测试（零外部依赖、零网络）。
 *
 * 起一个本地 `node:http` mock 服务模拟三类后端，直接 import `server/llm/` 的流式实现：
 *  - OpenAI 兼容：POST /v1/chat/completions（SSE，含 reasoning_content 与工具调用分片）；
 *  - Anthropic：POST /v1/messages（SSE，event: 事件名 + text_delta / stop_reason）；
 *  - Ollama：POST /api/chat（NDJSON，done + done_reason）。
 *
 * 断言：流式分片类型与文本汇总、终止原因归一、工具调用累积、鉴权头与请求形状、
 * HTTP 错误归一，以及 `server/llm.js` 的 invokeLlm 在构造 ctx 下收集最终文本。
 *
 * 运行：node test/llm-client.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createCheckRunner } from './helpers/check.mjs'
import { invokeLlm } from '../server/llm.js'
import { createLlmService } from '../server/llm/service.js'

const { check, summary } = createCheckRunner()

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** 按固定切分写响应：用于验证 SSE / NDJSON 解析器不假设 chunk 边界对齐。 */
async function writeSplit(res, text, sizes = [5, 17, 9]) {
  let offset = 0
  for (const size of sizes) {
    if (offset >= text.length) break
    res.write(text.slice(offset, offset + size))
    offset += size
    await sleep(2)
  }
  if (offset < text.length) res.write(text.slice(offset))
}

const sse = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const anthropicEvent = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

/** OpenAI 兼容端点的 SSE 响应体（思考 + 两段正文 + stop + [DONE]）。 */
const OPENAI_SSE = [
  sse({ choices: [{ delta: { reasoning_content: '先想一想' } }] }),
  sse({ choices: [{ delta: { content: '你好' } }] }),
  sse({ choices: [{ delta: { content: '，世界' } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  sse('[DONE]'),
].join('')

/** OpenAI 兼容端点的工具调用分片（同一索引分两次下发名字与参数）。 */
const OPENAI_TOOL_SSE = [
  sse({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'aigc_generate', arguments: '' } }],
      },
    }],
  }),
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"prompt":"猫"}' } }] } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  sse('[DONE]'),
].join('')

/** Anthropic Messages SSE 响应体。 */
const ANTHROPIC_SSE = [
  anthropicEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 3 } } }),
  anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  anthropicEvent('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthro' },
  }),
  anthropicEvent('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pic' },
  }),
  anthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  anthropicEvent('message_stop', { type: 'message_stop' }),
].join('')

/** Ollama 原生 NDJSON 响应体。 */
const OLLAMA_NDJSON = [
  JSON.stringify({ model: 'llama-test', message: { role: 'assistant', content: 'Olla' }, done: false }),
  JSON.stringify({ model: 'llama-test', message: { role: 'assistant', content: 'ma' }, done: false }),
  JSON.stringify({
    model: 'llama-test',
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    eval_count: 2,
    prompt_eval_count: 1,
  }),
].join('\n') + '\n'

/** 启动 mock LLM 服务，记录每个请求（method / url / headers / body）。 */
async function startMockLlm() {
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
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })

    const sendJson = (status, payload) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    const sendStream = async (contentType, text) => {
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' })
      await writeSplit(res, text)
      res.end()
    }

    if (req.method !== 'POST') return sendJson(405, { error: { message: 'method not allowed' } })
    if (req.url === '/v1/chat/completions') {
      if (body?.model === 'fail-model') {
        return sendJson(500, { error: { message: '模拟服务端错误', code: 'server_error' } })
      }
      if (body?.model === 'tool-model') return sendStream('text/event-stream', OPENAI_TOOL_SSE)
      return sendStream('text/event-stream', OPENAI_SSE)
    }
    if (req.url === '/v1/messages') return sendStream('text/event-stream', ANTHROPIC_SSE)
    if (req.url === '/api/chat') return sendStream('application/x-ndjson', OLLAMA_NDJSON)
    return sendJson(404, { error: { message: `unknown path ${req.url}` } })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    requests,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.()
        server.close(() => resolveClose())
      }),
  }
}

/** 创建指向 mock 服务的 LLM 服务；overrides 覆盖 provider / model 等配置。 */
function makeService(origin, overrides = {}) {
  const provider = overrides.provider ?? 'openai'
  const baseUrl = overrides.baseUrl ?? (provider === 'anthropic' || provider === 'ollama' ? origin : `${origin}/v1`)
  const config = {
    provider,
    baseUrl,
    model: overrides.model ?? (provider === 'ollama' ? 'llama-test' : 'test-model'),
    apiKey: overrides.apiKey ?? (provider === 'ollama' ? '' : provider === 'anthropic' ? 'sk-ant-test' : 'sk-test'),
  }
  return createLlmService({ getConfig: () => ({ ...config, ...overrides }) })
}

/** 收集异步流分片。 */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const reasoningOf = (chunks) => chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')?.reason ?? null

async function main() {
  const mock = await startMockLlm()
  try {
    await check('OpenAI 兼容流：分片类型、文本汇总与请求形状', async () => {
      const service = makeService(mock.origin)
      const chunks = await collect(service.stream({
        messages: [{ role: 'user', content: '你好' }],
        system: '你是助手',
        maxTokens: 64,
      }))
      assert.deepEqual(chunks.map((chunk) => chunk.type), ['reasoning-delta', 'text-delta', 'text-delta', 'finish'])
      assert.equal(reasoningOf(chunks), '先想一想')
      assert.equal(textOf(chunks), '你好，世界')
      assert.equal(finishOf(chunks)?.kind, 'stop')

      const request = mock.requests.filter((item) => item.url === '/v1/chat/completions').at(-1)
      assert.ok(request, '应请求 /v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer sk-test', 'OpenAI 兼容端点应带 Bearer 鉴权')
      assert.equal(request.body.stream, true)
      assert.equal(request.body.model, 'test-model')
      assert.equal(request.body.messages[0].role, 'system', 'system prompt 应作为首条消息')
      assert.equal(request.body.messages[0].content, '你是助手')
      assert.equal(request.body.messages.at(-1).content, '你好')
    })

    await check('OpenAI 工具调用分片按索引累积并进入 finish', async () => {
      const service = makeService(mock.origin, { model: 'tool-model' })
      const chunks = await collect(service.stream({ messages: [{ role: 'user', content: '画猫' }] }))
      const finish = chunks.find((chunk) => chunk.type === 'finish')
      assert.ok(finish, '缺少 finish 分片')
      assert.equal(finish.reason.kind, 'tool-calls')
      assert.deepEqual(finish.toolCalls, [
        { id: 'call_1', name: 'aigc_generate', arguments: '{"prompt":"猫"}' },
      ])
    })

    await check('Anthropic Messages 流：事件解析、鉴权头与终止原因', async () => {
      const service = makeService(mock.origin, { provider: 'anthropic' })
      const chunks = await collect(service.stream({
        messages: [{ role: 'user', content: 'ping' }],
        system: 'sys',
        maxTokens: 32,
      }))
      assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'text-delta', 'finish'])
      assert.equal(textOf(chunks), 'Anthropic')
      assert.equal(finishOf(chunks)?.kind, 'stop')

      const request = mock.requests.filter((item) => item.url === '/v1/messages').at(-1)
      assert.ok(request, '应请求 /v1/messages')
      assert.equal(request.headers['x-api-key'], 'sk-ant-test')
      assert.equal(request.headers['anthropic-version'], '2023-06-01')
      assert.equal(request.body.system, 'sys', 'system prompt 应放顶层 system 字段')
      assert.equal(request.body.messages[0].content[0].text, 'ping', 'Anthropic 消息内容应为文本块数组')
    })

    await check('Ollama 原生 NDJSON 流：正文汇总与 usage', async () => {
      const service = makeService(mock.origin, { provider: 'ollama' })
      const chunks = await collect(service.stream({ messages: [{ role: 'user', content: 'hi' }] }))
      assert.equal(textOf(chunks), 'Ollama')
      assert.equal(finishOf(chunks)?.kind, 'stop')
      const finish = chunks.find((chunk) => chunk.type === 'finish')
      assert.deepEqual(finish.usage, { outputTokens: 2, inputTokens: 1 })
      const request = mock.requests.filter((item) => item.url === '/api/chat').at(-1)
      assert.ok(request, '应请求 /api/chat')
      assert.equal(request.headers.authorization, undefined, 'Ollama 不需要 Bearer 鉴权')
    })

    await check('HTTP 错误归一为 llm_http_error（状态码与 provider 错误码）', async () => {
      const service = makeService(mock.origin, { model: 'fail-model' })
      await assert.rejects(
        () => collect(service.stream({ messages: [{ role: 'user', content: 'x' }] })),
        (error) => {
          assert.equal(error.code, 'llm_http_error')
          assert.equal(error.status, 500)
          assert.equal(error.providerCode, 'server_error')
          return true
        },
      )
    })

    await check('未配置时 getSelection 为 null，stream 抛 llm_not_configured', async () => {
      const service = createLlmService({ getConfig: () => ({}) })
      assert.equal(service.getSelection(), null)
      await assert.rejects(
        () => collect(service.stream({ messages: [{ role: 'user', content: 'x' }] })),
        (error) => error.code === 'llm_not_configured',
      )
    })

    await check('complete() 汇总正文 / 思考 / 终止原因', async () => {
      const service = makeService(mock.origin)
      const result = await service.complete({ messages: [{ role: 'user', content: '你好' }] })
      assert.equal(result.text, '你好，世界')
      assert.equal(result.reasoning, '先想一想')
      assert.equal(result.finish?.kind, 'stop')
      assert.deepEqual(result.toolCalls, [])
    })

    await check('prepareCall 返回可复用的 stream 配置', async () => {
      const service = makeService(mock.origin)
      const call = await service.prepareCall({ provider: 'openai', model: 'test-model', maxTokens: 32 }, undefined, (controls) => controls)
      assert.ok(call, 'prepareCall 应返回调用配置')
      assert.equal(call.config.model, 'test-model')
      const chunks = await collect(call.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 32 }))
      assert.equal(textOf(chunks), '你好，世界')
    })

    await check('invokeLlm：经 ctx.get("llm") 收集最终文本', async () => {
      const service = makeService(mock.origin)
      const ctx = {
        get(name) {
          if (name === 'llm') return service
          if (name === 'agentDefaultModel') return { currentSelection: () => service.getSelection() }
          return undefined
        },
      }
      const text = await invokeLlm(ctx, {
        prompt: '写一句测试文案',
        systemPrompt: '你是提示词助手',
        maxTokens: 64,
        purpose: 'imagen-test',
        timeoutMs: 5000,
      })
      assert.equal(text, '你好，世界', 'invokeLlm 应只收集 text-delta 正文（不含 reasoning）')
    })

    await check('invokeLlm：未配置时静默返回空串（本地兜底语义）', async () => {
      const unconfigured = createLlmService({ getConfig: () => ({}) })
      const ctx = {
        get(name) {
          if (name === 'llm') return unconfigured
          if (name === 'agentDefaultModel') return { currentSelection: () => unconfigured.getSelection() }
          return undefined
        },
      }
      const text = await invokeLlm(ctx, { prompt: 'x', purpose: 'imagen-test', timeoutMs: 2000 })
      assert.equal(text, '')
    })

    await check('invokeLlm：ctx 没有 llm 服务时静默返回空串', async () => {
      const text = await invokeLlm({ get: () => null }, { prompt: 'x', timeoutMs: 2000 })
      assert.equal(text, '')
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
