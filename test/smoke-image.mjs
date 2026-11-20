#!/usr/bin/env node
/**
 * 「带真实图片」的桌面冒烟（本轮新增，堵住「空工作区绿灯、有图就裂」的盲区）。
 *
 * 背景：Phase 1 验收时工作区是空的，Electron 全链路自检（SMOKE_CAPTURE）显示页面正常，
 * 但 `<img src="/api/file?...">` 无法携带 Bearer Token，一旦工作区有图就会 401、页面裂图。
 * 本用例把一张真实 PNG 与 meta.json 放进临时工作区的 `outputs/`，再启动 Electron 生产形态
 * （dist/web + 本地服务），由主进程 SMOKE 模式校验：
 *   - `/api/file` 图片 `complete && naturalWidth > 0`（Cookie / 头注入链路真的生效）；
 *   - 页面无 /api/file 图片解码失败（`complete && naturalWidth===0`）；
 *   - 基础探针（/api/state）200，截图产出非空。
 *
 * 运行：node test/smoke-image.mjs
 * 依赖：node_modules/electron（缺失时 SKIP，不算失败）；dist/web（缺失时自动 `vite build`）。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { createCheckRunner } from './helpers/check.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ELECTRON_BIN = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
)
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const WEB_DIST = join(ROOT, 'dist', 'web')
const SMOKE_TIMEOUT_MS = 180_000

const { check, summary } = createCheckRunner()

// ── 真实 PNG 夹具（64×64 渐变）：不引入图片依赖，运行期用 zlib 生成 ─────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 生成 64×64 RGB PNG（蓝→紫渐变），返回 Buffer。 */
export function createTestPng(width = 64, height = 64) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      raw[offset] = Math.round(40 + (x / (width - 1)) * 120)
      raw[offset + 1] = Math.round(90 + (y / (height - 1)) * 80)
      raw[offset + 2] = Math.round(200 - (x / (width - 1)) * 60)
      offset += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 在临时工作区里造一条「真实产物」历史记录（目录名 = 时间戳倒序即时间序）。
 *
 * 目录布局与 `server/output.js` 的 saveJobOutput 保持一致：
 * `<workspace>/outputs/<YYYYMMDD-HHmmss>-<jobId>/{01.png, meta.json}`。
 */
export async function seedWorkspaceWithImage(workspace) {
  const dirName = '20260101-120000-j_smokeimage'
  const dir = join(workspace, 'outputs', dirName)
  await mkdir(dir, { recursive: true })
  const png = createTestPng()
  await writeFile(join(dir, '01.png'), png)
  const meta = {
    version: 1,
    mediaType: 'image',
    jobId: 'j_smokeimage',
    presetId: 'sdxl-lightning',
    modelId: null,
    createdAt: '2026-01-01T04:00:00.000Z',
    finishedAt: '2026-01-01T04:00:06.200Z',
    params: {
      prompt: 'smoke test seed image',
      negativePrompt: '',
      width: 64,
      height: 64,
      steps: 4,
      cfg: 0,
      seed: 20260101,
      count: 1,
      presetId: 'sdxl-lightning',
    },
    images: [
      {
        file: '01.png',
        mediaType: 'image',
        seed: 20260101,
        seconds: 6.2,
        width: 64,
        height: 64,
        prompt: 'smoke test seed image',
        negativePrompt: '',
      },
    ],
  }
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { dir, relative: `outputs/${dirName}/01.png`, bytes: png.length }
}

// ── Electron 冒烟进程 ───────────────────────────────────────────────────────

/** 从子进程输出里提取 `SMOKE_DIAG {...}` / `SMOKE_OK {...}` 的 JSON 负载。 */
function extractJsonLine(output, prefix) {
  const lines = String(output ?? '').split(/\r?\n/)
  for (const line of lines) {
    const index = line.indexOf(`${prefix} `)
    if (index === -1) continue
    const text = line.slice(index + prefix.length + 1).trim()
    try {
      return JSON.parse(text)
    } catch {
      // 继续找下一行（日志行里可能夹带无关 JSON）
    }
  }
  return null
}

function runElectronSmoke({ dataDir, workspace, capturePath }) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    // 本机宿主可能全局设置了 ELECTRON_RUN_AS_NODE=1：不清掉就不会创建窗口。
    delete env.ELECTRON_RUN_AS_NODE
    env.AIGC_STUDIO_SMOKE_CAPTURE = capturePath
    env.AIGC_STUDIO_SMOKE_REQUIRE_IMAGE = '1'
    env.AIGC_STUDIO_SMOKE_TIMEOUT_MS = String(SMOKE_TIMEOUT_MS)
    env.AIGC_STUDIO_DATA_DIR = dataDir
    env.AIGC_STUDIO_WORKSPACE = workspace
    env.AIGC_STUDIO_WEB_DIST = WEB_DIST
    // Electron 生产形态：不让窗口走 Vite dev-server。
    delete env.VITE_DEV_SERVER_URL
    delete env.AIGC_STUDIO_PORT
    delete env.AIGC_STUDIO_TOKEN
    delete env.AIGC_STUDIO_DEV

    const child = spawn(ELECTRON_BIN, [ROOT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...payload, stdout, stderr })
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish({ timedOut: true, code: null })
    }, SMOKE_TIMEOUT_MS + 20_000)
    child.once('error', (error) => finish({ error }))
    child.once('exit', (code, signal) => finish({ code, signal }))
  })
}

/** Windows 下 Electron 会拉起服务子进程：超时/异常时按进程树清理，避免留下孤儿。 */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程可能已退出
  }
}

// ── 用例 ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(ELECTRON_BIN)) {
    console.log(`SKIP 未找到 Electron 二进制（${ELECTRON_BIN}），跳过桌面图片冒烟`)
    return
  }

  // 生产形态加载 dist/web：缺失时用本地 vite 构建（离线可用）。
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    console.log('· dist/web 不存在，先执行 vite build …')
    const built = spawnSync(process.execPath, [VITE_BIN, 'build'], { cwd: ROOT, stdio: 'inherit' })
    if (built.status !== 0) {
      console.log('SKIP vite build 失败，跳过桌面图片冒烟')
      return
    }
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'aigc-smoke-image-'))
  const dataDir = join(tempRoot, 'data')
  const workspace = join(tempRoot, 'workspace')
  const capturePath = join(tempRoot, 'smoke-image.png')
  await mkdir(workspace, { recursive: true })

  try {
    const seeded = await seedWorkspaceWithImage(workspace)

    await check('夹具：临时工作区里有一张可读的 PNG 产物', async () => {
      const info = await stat(join(workspace, seeded.relative))
      assert.ok(info.isFile() && info.size === seeded.bytes, 'PNG 落盘大小不符')
      const head = await readFile(join(workspace, seeded.relative))
      assert.equal(head.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 魔数不符')
    })

    const result = await runElectronSmoke({ dataDir, workspace, capturePath })

    // 失败时把关键输出带进断言消息，CI 里不用再去翻日志。
    const tail = `${String(result.stdout ?? '').slice(-1500)}\n${String(result.stderr ?? '').slice(-1500)}`
    const diagnostics = extractJsonLine(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, 'SMOKE_DIAG')
    const okPayload = extractJsonLine(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, 'SMOKE_OK')

    await check('Electron 冒烟进程按预期退出（exit 0，并输出 SMOKE_OK）', () => {
      assert.ok(!result.timedOut, `冒烟进程超时（>${SMOKE_TIMEOUT_MS}ms）\n${tail}`)
      assert.ok(!result.error, `进程启动失败：${result.error?.message ?? ''}`)
      assert.equal(result.code, 0, `退出码应为 0，实际 ${result.code ?? result.signal}\n${tail}`)
      assert.ok(okPayload, `未找到 SMOKE_OK 输出\n${tail}`)
    })

    await check('页面渲染：根节点与本地服务探针正常', () => {
      assert.ok(diagnostics, `未找到 SMOKE_DIAG 输出\n${tail}`)
      assert.equal(Number(diagnostics.rootChildren) > 0, true, 'root 无子节点（页面白屏）')
      assert.equal(diagnostics.stateProbe?.status, 200, `/api/state 探针非 200：${JSON.stringify(diagnostics.stateProbe)}`)
    })

    await check('图片加载：/api/file 产物图 complete 且 naturalWidth>0', () => {
      assert.ok(diagnostics, `未找到 SMOKE_DIAG 输出\n${tail}`)
      assert.ok(Number(diagnostics.imageCount) >= 1, `页面没有渲染任何 /api/file 图片（imageCount=${diagnostics.imageCount}）`)
      assert.equal(Number(diagnostics.imagesLoaded) >= 1, true, '没有任何一张产物图成功解码')
      assert.equal(Number(diagnostics.imageFailures), 0, `存在解码失败的产物图：${JSON.stringify(diagnostics.imageFailureDetails)}`)
      const sample = (diagnostics.imageSamples ?? [])[0] ?? null
      assert.ok(sample && sample.naturalWidth > 0, `图片样张宽高异常：${JSON.stringify(sample)}`)
    })

    await check('截图产出非空（页面不是白屏）', async () => {
      const info = await stat(capturePath)
      assert.ok(info.size > 10_000, `截图只有 ${info.size} 字节，疑似白屏`)
    })
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }

  summary({ prefix: '\n', suffix: '通过' })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
