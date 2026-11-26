#!/usr/bin/env node
/**
 * 协议 v2 Host 侧离线回归：流式下载 / Range 续传 / sha256 / SSE 解析 / binary 出图落盘。
 *
 * 全部走本地 mock Worker（127.0.0.1 随机端口），不联网、不烧 GPU：
 *  - `httpStream`：完整下载、断点续传（206）、sha256 与体积上限；
 *  - `downloadArtifact`：哈希不一致删除半截文件并重试、404 立即失败；
 *  - `openEvents`：SSE 帧解析、心跳注释忽略、close 断开；
 *  - `JobQueue`：能力协商后下发 `result_mode=binary`、从 `/artifact` 下载、
 *    `saveJobOutput` 读 tempPath 落盘、任务结束后清理临时目录。
 *
 * 运行：node test/remote-v2.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JobQueue } from '../server/jobs.js'
import { downloadArtifact, openEvents } from '../server/remote.js'
import { buildCurlInvocation, httpStream } from '../server/net-stream.js'
import { createCheckRunner } from './helpers/check.mjs'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')
const PNG_SHA = createHash('sha256').update(PNG).digest('hex')

const { check, results } = createCheckRunner()

await check('httpStream：curl 降级命令与参数不重复，跨平台可执行', async () => {
  const win = buildCurlInvocation({
    url: 'https://example.test/model.gguf',
    destPath: 'D:/models/model.gguf',
    timeoutMs: 4000,
    platform: 'win32',
  })
  const linux = buildCurlInvocation({
    url: 'https://example.test/model.gguf',
    destPath: '/tmp/model.gguf',
    timeoutMs: 4000,
    platform: 'linux',
  })
  assert.equal(win.command, 'curl.exe')
  assert.equal(linux.command, 'curl')
  assert.equal(win.argv[0], '-sS', 'argv 第一项必须是 curl 参数，不能重复命令名')
  assert.equal(win.argv.at(-1), 'https://example.test/model.gguf')
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(label, predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${label}`)
}

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

/** 带单段 Range 的字节响应（与 Worker `/artifact` 同形）。 */
function serveBytes(req, res, bytes) {
  const range = req.headers.range
  let start = 0
  let end = bytes.length - 1
  let status = 200
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!match) {
      res.writeHead(416, { 'content-range': `bytes */${bytes.length}`, 'content-length': 0 })
      res.end()
      return
    }
    start = Number(match[1])
    end = match[2] === '' ? bytes.length - 1 : Number(match[2])
    if (start >= bytes.length || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${bytes.length}`, 'content-length': 0 })
      res.end()
      return
    }
    end = Math.min(end, bytes.length - 1)
    status = 206
  }
  const slice = bytes.subarray(start, end + 1)
  res.writeHead(status, {
    'content-type': 'image/png',
    'content-length': slice.length,
    'accept-ranges': 'bytes',
    ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}),
  })
  res.end(slice)
}

/**
 * mock Worker：/health、/generate、/job、/artifact、/events。
 * `/job` 第一次回 running（带 step），第二次回 done（results 只带元数据）。
 */
function createMockWorker() {
  const state = {
    generateCalls: [],
    artifactCalls: [],
    eventCalls: 0,
    jobPolls: 0,
    resultMode: null,
    failArtifactOnce: false,
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        phase: 'ready',
        protocol_version: '2.0.0',
        capabilities: { result_modes: ['inline', 'binary'], events: true, artifact_range: true },
        hardware: { gpu_name: 'Mock GPU', vram_total_mb: 24576, count: 1 },
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/generate') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      state.generateCalls.push(body)
      state.resultMode = body.result_mode ?? 'inline'
      state.jobPolls = 0
      json(res, 202, {
        status: 'accepted',
        job_id: body.jobId ?? 'remote-job-1',
        tool: body.tool ?? 'generate',
        model_id: body.modelId ?? 'mock/model',
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/job') {
      state.jobPolls += 1
      if (state.jobPolls < 2) {
        json(res, 200, {
          status: 'running',
          job_id: url.searchParams.get('id'),
          progress: { done: 0, total: 1, step: 2, steps: 8 },
        })
        return
      }
      json(res, 200, {
        status: 'done',
        job_id: url.searchParams.get('id'),
        model_id: 'mock/model',
        load_seconds: 0.1,
        progress: { done: 1, total: 1 },
        results: [
          {
            index: 0,
            name: '01',
            seed: 7,
            seconds: 0.2,
            width: 1,
            height: 1,
            steps: 8,
            cfg: 0,
            bytes: PNG.length,
            sha256: PNG_SHA,
            media_type: 'image/png',
          },
        ],
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/artifact416') {
      // 模拟「本地已有完整文件但服务端认为范围越界」：第一次 416，去掉 Range 后正常返回。
      if (req.headers.range) {
        res.writeHead(416, { 'content-range': `bytes */${PNG.length}`, 'content-length': 0 })
        res.end()
        return
      }
      serveBytes(req, res, PNG)
      return
    }
    if (req.method === 'GET' && url.pathname === '/artifact') {
      state.artifactCalls.push(url.searchParams.get('index'))
      if (state.failArtifactOnce) {
        state.failArtifactOnce = false
        json(res, 500, { error: { code: 'artifact_failed', message: 'mock failure' } })
        return
      }
      serveBytes(req, res, PNG)
      return
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      state.eventCalls += 1
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': ping\n\n')
      res.write(
        `id: 1\nevent: job\ndata: ${JSON.stringify({
          id: 'remote-job-1',
          status: 'running',
          progress: { done: 0, total: 1, step: 3, steps: 8 },
        })}\n\n`,
      )
      // 保持连接，等待客户端 close()；测试结束由 server.close 兜底。
      return
    }
    json(res, 404, { error: { code: 'not_found', message: 'unknown' } })
  })

  return {
    state,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'aigc-remote-v2-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const worker = createMockWorker()
  const endpoint = await worker.listen()
  const token = 'remote-v2-token'

  try {
    await check('httpStream：完整下载并计算 sha256', async () => {
      const dest = join(root, 'full.png')
      const result = await httpStream(null, `${endpoint}/artifact?id=x&index=0`, { destPath: dest })
      assert.equal(result.status, 200)
      assert.equal(result.bytes, PNG.length)
      assert.equal(result.sha256, PNG_SHA)
      assert.deepEqual(await readFile(dest), PNG)
    })

    await check('httpStream：断点续传（206）只追加缺失字节，哈希仍是整文件', async () => {
      const dest = join(root, 'resume.png')
      await writeFile(dest, PNG.subarray(0, 20))
      const result = await httpStream(null, `${endpoint}/artifact?id=x&index=0`, {
        destPath: dest,
        resume: true,
      })
      assert.equal(result.status, 206)
      assert.equal(result.bytes, PNG.length)
      assert.equal(result.sha256, PNG_SHA)
      assert.deepEqual(await readFile(dest), PNG)
    })

    await check('httpStream：续传遇 416 时删文件重下一次', async () => {
      const dest = join(root, 'range416.png')
      await writeFile(dest, PNG)
      const result = await httpStream(null, `${endpoint}/artifact416?id=x&index=0`, {
        destPath: dest,
        resume: true,
      })
      assert.equal(result.status, 200)
      assert.equal(result.sha256, PNG_SHA)
      assert.deepEqual(await readFile(dest), PNG)
    })

    await check('downloadArtifact：哈希不一致时删除半截文件并重试成功', async () => {
      const dest = join(root, 'retry.png')
      worker.state.failArtifactOnce = true
      const result = await downloadArtifact(endpoint, token, 'remote-job-1', 0, {
        destPath: dest,
        sha256: PNG_SHA,
        retries: 2,
      })
      assert.equal(result.sha256, PNG_SHA)
      assert.deepEqual(await readFile(dest), PNG)
      assert.ok(worker.state.artifactCalls.length >= 2, '失败后应重试一次')
    })

    await check('downloadArtifact：sha256 不匹配时抛 artifact_failed 且不留半截文件', async () => {
      const dest = join(root, 'bad.png')
      await assert.rejects(
        () =>
          downloadArtifact(endpoint, token, 'remote-job-1', 0, {
            destPath: dest,
            sha256: 'deadbeef'.repeat(8),
            retries: 0,
          }),
        (error) => error?.code === 'artifact_failed',
      )
      await assert.rejects(() => stat(dest), '校验失败的文件必须删除')
    })

    await check('openEvents：解析 SSE 帧、忽略心跳注释', async () => {
      const seen = []
      const stream = openEvents(endpoint, token, {
        onEvent: (event) => seen.push(event),
      })
      await stream.ready
      await waitUntil('SSE 事件到达', () => seen.length >= 1)
      stream.close()
      assert.equal(seen[0].event, 'job')
      assert.equal(seen[0].data.progress.step, 3)
      assert.equal(seen[0].data.progress.steps, 8)
      assert.equal(worker.state.eventCalls, 1)
    })

    await check('JobQueue：能力协商后走 binary，产物经 /artifact 落盘并清理临时目录', async () => {
      const session = {
        isReady: true,
        provider: { id: 'private-worker' },
        connection: () => ({ endpoint, token }),
        snapshot: () => ({ state: 'ready', provider: 'private-worker', error: null }),
        capabilities: () => ({ result_modes: ['inline', 'binary'], events: true }),
        start: async () => ({ state: 'ready' }),
      }
      const queue = new JobQueue({
        ctx: {
          get(name) {
            return name === 'workingDirectory' ? { defaultDirectory: workspace } : undefined
          },
        },
        session,
        defaultPreset: 'sdxl-lightning',
        options: { pollMs: 20, generateTimeoutMs: 10000 },
      })
      try {
        const submitted = queue.submit({ prompt: 'binary 落盘测试', count: 1 })
        assert.equal(submitted.ok, true)
        const job = await queue.waitFor(submitted.job.id, 8)
        assert.equal(job.status, 'done', JSON.stringify(job.error))
        assert.equal(worker.state.resultMode, 'binary')
        assert.equal(worker.state.generateCalls[0].result_mode, 'binary')
        assert.ok(worker.state.eventCalls >= 1, '应订阅 /events 获取步数')
        assert.ok(job.output?.images?.length === 1)
        const image = job.output.images[0]
        const absolute = join(workspace, image.path)
        const stored = await readFile(absolute)
        // saveJobOutput 会写入 PNG tEXt 生成参数，字节不再与远端完全一致；
        // 这里断言「确实是 PNG 且不小于源图」，二进制链路的字节一致性由上面的下载用例覆盖。
        assert.equal(stored.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
        assert.ok(stored.length >= PNG.length)
        assert.equal(image.width, 1)
        assert.equal(image.height, 1)
        // 临时目录在任务收尾后删除（persistResult 之后由 runNext 的 finally 清理）。
        const tempDir = join(tmpdir(), 'aigc-studio', 'artifacts', submitted.job.id)
        await waitUntil('临时产物目录被清理', async () => {
          try {
            await stat(tempDir)
            return false
          } catch {
            return true
          }
        })
      } finally {
        queue.dispose()
      }
    })

    await check('JobQueue：旧 Worker 无 capabilities 时不下发 result_mode（inline 兼容）', async () => {
      worker.state.generateCalls = []
      const session = {
        isReady: true,
        provider: { id: 'private-worker' },
        connection: () => ({ endpoint, token }),
        snapshot: () => ({ state: 'ready', provider: 'private-worker', error: null }),
        capabilities: () => null,
        start: async () => ({ state: 'ready' }),
      }
      const queue = new JobQueue({
        ctx: {
          get(name) {
            return name === 'workingDirectory' ? { defaultDirectory: workspace } : undefined
          },
        },
        session,
        defaultPreset: 'sdxl-lightning',
        options: { pollMs: 20, generateTimeoutMs: 10000 },
      })
      try {
        const submitted = queue.submit({ prompt: 'inline 兼容测试', count: 1 })
        await queue.waitFor(submitted.job.id, 8)
        assert.equal(worker.state.generateCalls.length, 1)
        assert.equal(worker.state.generateCalls[0].result_mode, undefined)
      } finally {
        queue.dispose()
      }
    })
  } finally {
    await worker.close()
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
