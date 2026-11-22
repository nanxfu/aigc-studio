#!/usr/bin/env node
/**
 * MCP Server stdio 回归（M3.3）：真实 spawn `mcp/server.mjs`，用 mock 本地 API 走完整协议。
 *
 * 覆盖：
 *  - `initialize` → `tools/list`（7 个）→ `tools/call`（recipes / history / generate / cancel / session）；
 *  - stdout 只有 JSON-RPC（日志全部走 stderr）；
 *  - runtime.json 缺失时工具调用返回可读错误，不崩溃；
 *  - Token 只从 runtime.json 读取，请求头带 Bearer。
 *
 * 运行：node test/mcp-server.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCheckRunner } from './helpers/check.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER = join(ROOT, 'mcp', 'server.mjs')
const TOKEN = 'mcp-test-token'
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const { check, results } = createCheckRunner()

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length })
  res.end(body)
}

/** mock 本地 API：只实现 MCP 用到的 6 条路由。 */
function createMockApi() {
  const state = { calls: [], authFailures: 0, jobs: new Map() }
  let sequence = 0
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      state.authFailures += 1
      json(res, 401, { message: 'unauthorized' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    state.calls.push(`${req.method} ${url.pathname}`)
    if (req.method === 'GET' && url.pathname === '/api/history') {
      json(res, 200, {
        items: [
          {
            createdAt: '2026-11-22T00:00:00Z',
            presetId: 'sdxl-lightning',
            prompt: 'a cat',
            images: [{ path: 'outputs/20261122-000000-j_1/01.png' }],
          },
        ],
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      sequence += 1
      const id = `j_mcp_${sequence}`
      state.jobs.set(id, {
        id,
        status: 'done',
        seconds: 1.2,
        presetId: body.presetId ?? 'sdxl-lightning',
        params: {
          width: body.width ?? 1024,
          height: body.height ?? 1024,
          steps: body.steps ?? 4,
          cfg: body.cfg ?? 0,
          seed: body.seed ?? 1,
          prompt: body.prompt ?? '',
        },
        output: {
          images: [
            {
              path: `outputs/20261122-000000-${id}/01.png`,
              width: 1,
              height: 1,
              seed: 1,
            },
          ],
        },
        error: null,
      })
      json(res, 200, state.jobs.get(id))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/job') {
      const job = state.jobs.get(url.searchParams.get('id'))
      if (!job) {
        json(res, 404, { message: '任务不存在' })
        return
      }
      json(res, 200, job)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      json(res, 200, { ok: true, disposition: 'dequeued', job: state.jobs.get(body.id) ?? null })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, {
        version: '0.15.0',
        protocol: '2.0.0',
        session: { state: 'ready', detail: '就绪', device: 'Mock GPU', deviceCount: 1 },
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/session/start') {
      json(res, 200, { ok: true, session: { state: 'ready', detail: '就绪' } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/session/stop') {
      json(res, 200, { ok: true, session: { state: 'stopped' } })
      return
    }
    json(res, 404, { message: 'unknown' })
  })
  return {
    state,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 极简 stdio JSON-RPC 客户端：按行解析，stdout 每行都必须是合法 JSON-RPC。 */
function createClient(child) {
  const pending = new Map()
  const stdoutLines = []
  let buffer = ''
  let nextId = 1
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        stdoutLines.push(line)
        let message = null
        try {
          message = JSON.parse(line)
        } catch {
          throw new Error(`stdout 出现非 JSON 输出：${line.slice(0, 200)}`)
        }
        if (message.id != null && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) reject(new Error(message.error.message ?? 'json-rpc error'))
          else resolve(message.result)
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  return { request, notify, stdoutLines }
}

async function startMcp(runtimePath) {
  const child = spawn(process.execPath, [SERVER, '--runtime', runtimePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const client = createClient(child)
  const initialized = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-test', version: '0.0.0' },
  })
  client.notify('notifications/initialized', {})
  return { child, client, initialized, stderrOf: () => stderr }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'aigc-mcp-test-'))
  const api = createMockApi()
  const port = await api.listen()
  const runtimePath = join(root, 'runtime.json')
  await writeFile(
    runtimePath,
    JSON.stringify({
      schema: 1,
      pid: process.pid,
      port,
      origin: `http://127.0.0.1:${port}`,
      token: TOKEN,
      version: '0.15.0',
      protocol: '2.0.0',
      workspace: root,
      startedAt: new Date().toISOString(),
    }),
  )

  let session = null
  try {
    await check('initialize 返回服务信息', async () => {
      session = await startMcp(runtimePath)
      assert.equal(session.initialized.serverInfo?.name, 'aigc-studio')
    })

    await check('tools/list 返回 7 个工具且含 JSON Schema', async () => {
      const result = await session.client.request('tools/list', {})
      assert.equal(result.tools.length, 7)
      assert.deepEqual(
        result.tools.map((tool) => tool.name),
        [
          'imagen_generate',
          'imagen_upscale',
          'imagen_batch',
          'imagen_recipes',
          'imagen_session',
          'imagen_history',
          'imagen_cancel',
        ],
      )
      for (const tool of result.tools) {
        assert.equal(tool.inputSchema.type, 'object')
      }
      const generate = result.tools.find((tool) => tool.name === 'imagen_generate')
      assert.equal(generate.inputSchema.properties.includeImage.type, 'boolean')
    })

    await check('imagen_recipes 纯本地检索（不请求服务）', async () => {
      const before = api.state.calls.length
      const result = await session.client.request('tools/call', {
        name: 'imagen_recipes',
        arguments: { keyword: '日系', limit: 2 },
      })
      assert.ok(result.content[0].text.length > 0)
      assert.equal(api.state.calls.length, before, '配方工具不应请求本地 API')
    })

    await check('imagen_history 映射 GET /api/history 并返回路径', async () => {
      const result = await session.client.request('tools/call', {
        name: 'imagen_history',
        arguments: { limit: 5 },
      })
      assert.match(result.content[0].text, /outputs\/20261122-000000-j_1\/01\.png/)
    })

    await check('imagen_generate 提交 + 轮询 + 文本汇总', async () => {
      const result = await session.client.request('tools/call', {
        name: 'imagen_generate',
        arguments: { prompt: 'a cat', count: 1, waitSeconds: 5 },
      })
      assert.equal(result.isError, undefined)
      assert.match(result.content[0].text, /任务 j_mcp_/)
      assert.match(result.content[0].text, /outputs\/20261122-000000-j_mcp_/)
      assert.ok(api.state.calls.includes('POST /api/generate'))
      assert.ok(api.state.calls.includes('GET /api/job'))
    })

    await check('imagen_session status 映射 /api/state', async () => {
      const result = await session.client.request('tools/call', {
        name: 'imagen_session',
        arguments: { action: 'status' },
      })
      assert.match(result.content[0].text, /会话状态：ready/)
      assert.match(result.content[0].text, /Mock GPU/)
    })

    await check('imagen_cancel 映射 POST /api/job/cancel', async () => {
      const result = await session.client.request('tools/call', {
        name: 'imagen_cancel',
        arguments: { jobId: 'j_mcp_1' },
      })
      assert.match(result.content[0].text, /已取消 j_mcp_1/)
      assert.ok(api.state.calls.includes('POST /api/job/cancel'))
    })

    await check('stdout 只有 JSON-RPC，没有日志噪声', () => {
      for (const line of session.client.stdoutLines) {
        const message = JSON.parse(line)
        assert.equal(message.jsonrpc, '2.0')
      }
      assert.ok(session.client.stdoutLines.length >= 7)
    })

    await check('runtime.json 缺失时工具调用返回可读错误且进程不崩溃', async () => {
      const missing = await startMcp(join(root, 'missing-runtime.json'))
      try {
        const result = await missing.client.request('tools/call', {
          name: 'imagen_history',
          arguments: { limit: 1 },
        })
        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /runtime_missing/)
        assert.match(result.content[0].text, /请先启动 AIGC Studio/)
      } finally {
        missing.child.stdin.end()
        await new Promise((resolve) => missing.child.on('exit', resolve))
      }
    })
  } finally {
    if (session) {
      session.child.stdin.end()
      await new Promise((resolve) => session.child.on('exit', resolve))
    }
    await api.close()
    await rm(root, { recursive: true, force: true })
  }

  const failed = results.filter((item) => !item.ok)
  if (failed.length > 0) {
    console.error(`\n${failed.length} 项失败`)
    process.exitCode = 1
    return
  }
  console.log(`\n全部通过（${results.length} 项）`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
