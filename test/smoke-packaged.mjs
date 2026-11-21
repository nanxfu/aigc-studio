#!/usr/bin/env node
/**
 * 安装形态 / 打包产物的「带真实图片」桌面冒烟（M2 验收用）。
 *
 * 与 test/smoke-image.mjs 的区别：后者用 node_modules/electron 以开发目录启动，
 * 验证的是「源码 + dist/web」；本用例直接启动 **打包后的可执行文件**（win-unpacked、
 * NSIS 安装目录或 portable 自解压），因此在真机安装形态下复核同一条图片链路：
 *
 *   - 打包布局完整（resources/app 下的 server/standalone.js、dist/web/index.html）；
 *   - 应用版本与仓库 package.json 一致；
 *   - 冒烟进程 exit 0 并输出 SMOKE_OK；/api/state 探针 200、根节点有内容；
 *   - 工作区里预置的真实 PNG 能通过 /api/file 解码（imageCount / imagesLoaded / imageFailures）；
 *   - 截图非空白；
 *   - 退出后没有残留的 AIGC Studio 进程（服务子进程被正确回收）。
 *
 * 用法：
 *   node test/smoke-packaged.mjs                                   # 默认 release/win-unpacked/AIGC Studio.exe
 *   node test/smoke-packaged.mjs --exe "release/win-unpacked/AIGC Studio.exe"
 *   node test/smoke-packaged.mjs --exe "C:\...\AIGC Studio.exe" --timeout 240000 --keep
 *
 * 参数：--exe <path> 可执行文件路径（相对仓库根或绝对路径）；--timeout <ms> 冒烟超时（默认 180000）；
 *       --keep 保留临时目录（排查失败用，路径会打印出来）。
 *
 * 该用例不进入 test/run-all.mjs 的默认分组：它依赖先构建好安装包，属于发布验收步骤。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCheckRunner } from './helpers/check.mjs'
import { seedWorkspaceWithImage } from './helpers/image-fixture.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_EXE = join(ROOT, 'release', 'win-unpacked', 'AIGC Studio.exe')
const DEFAULT_TIMEOUT_MS = 180_000

const { check, summary } = createCheckRunner()

function parseArgs(argv) {
  const options = { exe: DEFAULT_EXE, timeoutMs: DEFAULT_TIMEOUT_MS, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--exe') {
      options.exe = argv[++index] ?? ''
    } else if (arg === '--timeout') {
      const value = Number(argv[++index] ?? '')
      if (Number.isInteger(value) && value > 0) options.timeoutMs = value
    } else if (arg === '--keep') {
      options.keep = true
    }
  }
  options.exe = isAbsolute(options.exe) ? options.exe : resolve(ROOT, options.exe)
  return options
}

function extractJsonLine(output, prefix) {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const index = line.indexOf(`${prefix} `)
    if (index === -1) continue
    try {
      return JSON.parse(line.slice(index + prefix.length + 1).trim())
    } catch {
      // 日志行里可能夹带无关 JSON，继续找
    }
  }
  return null
}

/** 读取主进程写的 `<capture>.json` 自检结果；最多等 10 秒（外壳退出与写盘有先后差）。 */
async function readSmokeResultFile(capturePath) {
  const resultPath = `${capturePath}.json`
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultPath, 'utf8'))
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200))
    }
  }
  return null
}

/** 当前进程名列表（Windows tasklist）；非 Windows 返回 null。 */
function listProcessNames() {
  if (process.platform !== 'win32') return null
  const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^"([^"]+)"/)?.[1] ?? '')
    .filter(Boolean)
}

/** 本应用相关进程名：打包后统一是 "AIGC Studio.exe"；portable 外壳是安装包文件名。 */
function isAppProcess(name) {
  const lower = name.toLowerCase()
  return lower === 'aigc studio.exe' || lower.startsWith('aigc-studio-') || lower.startsWith('aigc studio')
}

/** Windows 下按进程树清理，避免超时留下窗口与服务子进程。 */
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

function runPackagedSmoke({ exePath, dataDir, workspace, capturePath, timeoutMs }) {  return new Promise((resolveRun) => {
    const env = { ...process.env }
    // 本机宿主可能全局设置了 ELECTRON_RUN_AS_NODE=1：不清掉就不会创建窗口。
    delete env.ELECTRON_RUN_AS_NODE
    delete env.VITE_DEV_SERVER_URL
    delete env.AIGC_STUDIO_PORT
    delete env.AIGC_STUDIO_TOKEN
    delete env.AIGC_STUDIO_DEV
    delete env.AIGC_STUDIO_WEB_DIST
    delete env.AIGC_STUDIO_SERVER_ENTRY
    env.AIGC_STUDIO_SMOKE_CAPTURE = capturePath
    env.AIGC_STUDIO_SMOKE_REQUIRE_IMAGE = '1'
    env.AIGC_STUDIO_SMOKE_TIMEOUT_MS = String(timeoutMs)
    env.AIGC_STUDIO_DATA_DIR = dataDir
    env.AIGC_STUDIO_WORKSPACE = workspace

    const child = spawn(exePath, [], { cwd: dirname(exePath), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
      resolveRun({ ...payload, stdout, stderr })
    }
    const timer = setTimeout(() => {
      killTree(child.pid)
      finish({ timedOut: true, code: null })
    }, timeoutMs + 30_000)
    child.once('error', (error) => finish({ error }))
    child.once('exit', (code, signal) => finish({ code, signal }))
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const exePath = options.exe
  const tailOf = (result) => `${String(result.stdout ?? '').slice(-1800)}\n${String(result.stderr ?? '').slice(-1800)}`

  let tempRoot = null
  let result = null
  try {
    await check(`可执行文件存在：${options.exe}`, async () => {
      const info = await stat(exePath)
      assert.ok(info.isFile(), `${exePath} 不是文件`)
      assert.ok(info.size > 1_000_000, `可执行文件只有 ${info.size} 字节，疑似未正确构建`)
    })

    // 单实例锁按默认 userData 计算，与 AIGC_STUDIO_DATA_DIR 无关：先确认没有别的实例。
    await check('没有其它 AIGC Studio 实例占用单实例锁', () => {
      const names = listProcessNames()
      if (!names) return
      const running = names.filter(isAppProcess)
      assert.equal(running.length, 0, `检测到正在运行的实例：${running.join('、')}；请先全部退出再验收`)
    })

    // 打包布局与版本（portable 是自解压外壳，运行前没有可检查的 app 目录）。
    const appRoot = dirname(exePath)
    const packagedAppDir = join(appRoot, 'resources', 'app')
    const hasPackagedAppDir = existsSync(join(packagedAppDir, 'package.json'))
    if (hasPackagedAppDir) {
      await check('打包布局完整（resources/app 下 server/standalone.js 与 dist/web/index.html）', () => {
        assert.ok(existsSync(join(packagedAppDir, 'server', 'standalone.js')), '缺少 server/standalone.js')
        assert.ok(existsSync(join(packagedAppDir, 'dist', 'web', 'index.html')), '缺少 dist/web/index.html')
        assert.ok(existsSync(join(packagedAppDir, 'worker', 'daemon.py')), '缺少 worker/daemon.py（Kernel 打包依赖）')
        assert.ok(existsSync(join(packagedAppDir, 'models')), '缺少 models/ 资产目录')
      })
      await check('应用版本与仓库一致', async () => {
        const [packaged, repo] = await Promise.all([
          readFile(join(packagedAppDir, 'package.json'), 'utf8').then(JSON.parse),
          readFile(join(ROOT, 'package.json'), 'utf8').then(JSON.parse),
        ])
        assert.equal(packaged.version, repo.version, `打包版本 ${packaged.version} ≠ 仓库版本 ${repo.version}`)
      })
    } else {
      console.log('· portable / 自解压形态：跳过打包布局与版本文件检查')
    }

    tempRoot = await mkdtemp(join(tmpdir(), 'aigc-smoke-packaged-'))
    const dataDir = join(tempRoot, 'data')
    const workspace = join(tempRoot, 'workspace')
    const capturePath = join(tempRoot, 'smoke-packaged.png')
    await mkdir(workspace, { recursive: true })

    await check('夹具：临时工作区里有一张可读取的产物 PNG', async () => {
      const seeded = await seedWorkspaceWithImage(workspace)
      const info = await stat(join(workspace, seeded.relative))
      assert.ok(info.isFile() && info.size === seeded.bytes, 'PNG 落盘大小不符')
      const head = await readFile(join(workspace, seeded.relative))
      assert.equal(head.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 魔数不符')
    })

    result = await runPackagedSmoke({
      exePath,
      dataDir,
      workspace,
      capturePath,
      timeoutMs: options.timeoutMs,
    })

    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    let diagnostics = extractJsonLine(combined, 'SMOKE_DIAG')
    let okPayload = extractJsonLine(combined, 'SMOKE_OK')
    // portable 是 NSIS 自解压外壳：窗口进程由外壳另起，stdout 不转发；
    // 主进程同时会把结果落到 `<capture>.json`，这里作为 stdout 不可用时的兜底。
    if (!okPayload || !diagnostics) {
      const resultFile = await readSmokeResultFile(capturePath)
      if (!diagnostics) diagnostics = resultFile?.diagnostics ?? null
      if (!okPayload) okPayload = resultFile?.ok === true ? resultFile : null
      if (!okPayload && resultFile?.ok === false) console.log(`· 自检结果文件报告失败：${resultFile.reason ?? ''}`)
    }
    const failPayload = extractJsonLine(combined, 'SMOKE_FAIL') ?? null

    await check('冒烟进程按预期退出（exit 0 且自检成功）', () => {
      assert.ok(!result.timedOut, `冒烟进程超时\n${tailOf(result)}`)
      assert.ok(!result.error, `进程启动失败：${result.error?.message ?? ''}`)
      assert.equal(result.code, 0, `退出码应为 0，实际 ${result.code ?? result.signal}${failPayload ? `（SMOKE_FAIL ${failPayload}）` : ''}\n${tailOf(result)}`)
      assert.ok(okPayload, `未找到 SMOKE_OK 输出\n${tailOf(result)}`)
    })

    await check('页面渲染：根节点有内容且 /api/state 探针 200', () => {
      assert.ok(diagnostics, `未找到 SMOKE_DIAG 输出\n${tailOf(result)}`)
      assert.ok(Number(diagnostics.rootChildren) > 0, 'root 无子节点（页面白屏）')
      assert.equal(diagnostics.stateProbe?.status, 200, `/api/state 探针非 200：${JSON.stringify(diagnostics.stateProbe)}`)
    })

    await check('图片加载：/api/file 产物图 complete 且 naturalWidth>0', () => {
      assert.ok(diagnostics, `未找到 SMOKE_DIAG 输出\n${tailOf(result)}`)
      assert.ok(Number(diagnostics.imageCount) >= 1, `页面没有渲染任何 /api/file 图片（imageCount=${diagnostics.imageCount}）`)
      assert.ok(Number(diagnostics.imagesLoaded) >= 1, '没有任何一张产物图成功解码')
      assert.equal(Number(diagnostics.imageFailures), 0, `存在解码失败的产物图：${JSON.stringify(diagnostics.imageFailureDetails)}`)
      const sample = (diagnostics.imageSamples ?? [])[0] ?? null
      assert.ok(sample && sample.naturalWidth > 0, `图片样张宽高异常：${JSON.stringify(sample)}`)
    })

    await check('截图产出非空（页面不是白屏）', async () => {
      const info = await stat(capturePath)
      assert.ok(info.size > 10_000, `截图只有 ${info.size} 字节，疑似白屏`)
    })

    await check('退出后没有残留的 AIGC Studio 进程', async () => {
      const names = listProcessNames()
      if (!names) return
      const deadline = Date.now() + 5_000
      let running = names.filter(isAppProcess)
      while (running.length > 0 && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250))
        running = (listProcessNames() ?? []).filter(isAppProcess)
      }
      assert.equal(running.length, 0, `仍有残留进程：${running.join('、')}`)
    })
  } finally {
    if (tempRoot && options.keep) {
      console.log(`· 临时目录已保留：${tempRoot}`)
    } else if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    }
  }

  summary({ prefix: '\n', suffix: '通过' })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
