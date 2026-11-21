#!/usr/bin/env node
/**
 * M2 安装包端到端验收：静默安装 → 目录与版本校验 → 安装形态图片冒烟 → 静默卸载 → 残留检查。
 *
 * 验证的是 roadmap M2「正式安装包构建与干净环境验证」的交付物：
 *   - `npm run dist` 产出的 NSIS 安装包能在全新目录静默安装（无需人工点击）；
 *   - 安装目录结构完整（可执行文件、resources/app 下的服务与前端产物、卸载器）；
 *   - Windows 版本资源写对（ProductName / FileVersion 与仓库版本一致）；
 *   - 安装后的 exe 走 test/smoke-packaged.mjs 同一套「带真实图片」冒烟；
 *   - 静默卸载后安装目录被清理、没有残留进程。
 *
 * 用法：
 *   node test/smoke-installer.mjs                          # 默认 release/aigc-studio-<version>-x64.exe
 *   node test/smoke-installer.mjs --installer <安装包路径>
 *   node test/smoke-installer.mjs --keep                    # 保留临时安装目录（排查失败用）
 *
 * 该用例依赖先执行 `npm run dist`，不进入 test/run-all.mjs 默认分组（属于发布验收步骤）。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCheckRunner } from './helpers/check.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SMOKE_PACKAGED = join(ROOT, 'test', 'smoke-packaged.mjs')
const INSTALL_TIMEOUT_MS = 180_000
const UNINSTALL_TIMEOUT_MS = 120_000

const { check, summary } = createCheckRunner()

/** 只接受 Windows：NSIS 安装包与 tasklist/版本资源检查都是 Windows 语义。 */
if (process.platform !== 'win32') {
  console.log('SKIP 该用例只支持 Windows')
  process.exit(0)
}

function parseArgs(argv) {
  const options = { installer: null, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--installer') options.installer = argv[++index] ?? ''
    else if (argv[index] === '--keep') options.keep = true
  }
  return options
}

function runToExit(exePath, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(exePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      finish({ timedOut: true, code: null })
    }, timeoutMs)
    child.once('error', (error) => finish({ error }))
    child.once('exit', (code, signal) => finish({ code, signal }))
  })
}

function listProcessNames() {
  const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || typeof result.stdout !== 'string') return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^"([^"]+)"/)?.[1] ?? '')
    .filter(Boolean)
}

function isAppProcess(name) {
  const lower = name.toLowerCase()
  return lower === 'aigc studio.exe' || lower.startsWith('aigc studio')
}

/** 读取 Windows 可执行文件的版本资源（ProductName / FileVersion / CompanyName）。 */
function readVersionInfo(exePath) {
  const script = `$i = (Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo; `
    + `[pscustomobject]@{ productName = $i.ProductName; fileVersion = $i.FileVersion; companyName = $i.CompanyName } | ConvertTo-Json -Compress`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  try {
    return JSON.parse(result.stdout.trim())
  } catch {
    return null
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
  }
  return false
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repoPackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const defaultInstaller = join(ROOT, 'release', `aigc-studio-${repoPackage.version}-x64.exe`)
  const installer = options.installer
    ? (isAbsolute(options.installer) ? options.installer : resolve(ROOT, options.installer))
    : defaultInstaller

  let tempRoot = null
  let installDir = null
  let uninstallerPath = null
  try {
    await check(`安装包存在：${installer}`, async () => {
      const info = await stat(installer)
      assert.ok(info.isFile(), '不是文件')
      assert.ok(info.size > 10_000_000, `安装包只有 ${info.size} 字节，疑似构建失败`)
    })

    await check('验收前没有其它 AIGC Studio 实例在运行', () => {
      const running = listProcessNames().filter(isAppProcess)
      assert.equal(running.length, 0, `检测到正在运行的实例：${running.join('、')}；请先全部退出`)
    })

    tempRoot = await mkdtemp(join(tmpdir(), 'aigc-installer-'))
    installDir = join(tempRoot, 'AIGC Studio')

    await check('静默安装到全新目录（exit 0）', async () => {
      // NSIS：/S 静默，/D= 必须是最后一个参数且不能加引号。
      const result = await runToExit(installer, ['/S', `/D=${installDir}`], INSTALL_TIMEOUT_MS)
      assert.ok(!result.timedOut, '安装进程超时')
      assert.ok(!result.error, `安装进程启动失败：${result.error?.message ?? ''}`)
      assert.equal(result.code, 0, `安装退出码应为 0，实际 ${result.code ?? result.signal}\n${result.stdout}\n${result.stderr}`)
    })

    await check('安装目录结构完整（exe / resources/app / 卸载器）', async () => {
      const exe = join(installDir, 'AIGC Studio.exe')
      assert.ok(existsSync(exe), `缺少主程序：${exe}`)
      const appDir = join(installDir, 'resources', 'app')
      assert.ok(existsSync(join(appDir, 'server', 'standalone.js')), '缺少 server/standalone.js')
      assert.ok(existsSync(join(appDir, 'dist', 'web', 'index.html')), '缺少 dist/web/index.html')
      assert.ok(existsSync(join(appDir, 'worker', 'daemon.py')), '缺少 worker/daemon.py')
      const entries = await readdir(installDir)
      const uninstaller = entries.find((name) => /^Uninstall .*\.exe$/i.test(name))
      assert.ok(uninstaller, `没有找到卸载器，目录内容：${entries.join('、')}`)
      uninstallerPath = join(installDir, uninstaller)
    })

    await check('Windows 版本资源正确（ProductName / FileVersion）', () => {
      const info = readVersionInfo(join(installDir, 'AIGC Studio.exe'))
      assert.ok(info, '读取版本资源失败（PowerShell 不可用？）')
      assert.equal(info.productName, 'AIGC Studio', `ProductName=${info.productName}`)
      assert.equal(info.fileVersion, repoPackage.version, `FileVersion=${info.fileVersion}，仓库版本=${repoPackage.version}`)
    })

    await check('安装形态「带真实图片」冒烟通过（复用 test/smoke-packaged.mjs）', () => {
      const result = spawnSync(process.execPath, [SMOKE_PACKAGED, '--exe', join(installDir, 'AIGC Studio.exe')], {
        cwd: ROOT,
        stdio: 'inherit',
        windowsHide: true,
      })
      assert.equal(result.status, 0, `安装形态冒烟失败（exit ${result.status}）`)
    })

    await check('静默卸载（exit 0）', async () => {
      assert.ok(uninstallerPath, '缺少卸载器路径')
      const result = await runToExit(uninstallerPath, ['/S'], UNINSTALL_TIMEOUT_MS)
      assert.ok(!result.timedOut, '卸载进程超时')
      assert.equal(result.code, 0, `卸载退出码应为 0，实际 ${result.code ?? result.signal}`)
    })

    await check('卸载后安装目录被清理', async () => {
      const removed = await waitFor(async () => !existsSync(installDir), 30_000)
      if (!removed) {
        const entries = existsSync(installDir) ? (await readdir(installDir)).join('、') : ''
        assert.fail(`卸载 30 秒后安装目录仍存在：${installDir}（${entries}）`)
      }
    })

    await check('卸载后没有残留的 AIGC Studio 进程', async () => {
      const clean = await waitFor(() => Promise.resolve(listProcessNames().filter(isAppProcess).length === 0), 10_000)
      assert.ok(clean, `仍有残留进程：${listProcessNames().filter(isAppProcess).join('、')}`)
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
