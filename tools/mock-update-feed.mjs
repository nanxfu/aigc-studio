#!/usr/bin/env node
/**
 * 本地更新源（generic provider）联调服务。
 *
 * 用途：不发布真实 Release 也能把「检查 → 有新版本 → 下载进度 → 已下载」跑通。
 * 生成的 exe 是假文件，**不要真的安装**；只用于 UI / 状态机联调。
 *
 * 用法：
 *   node tools/mock-update-feed.mjs                 # 默认 0.15.1，端口 8787
 *   node tools/mock-update-feed.mjs --version 0.15.2 --port 9000
 *
 * 桌面端开发态启用更新器：
 *   AIGC_STUDIO_UPDATE_DEV=1 AIGC_STUDIO_UPDATE_FEED=http://127.0.0.1:8787/feed npm run dev
 *
 * 产物写到 `.tmp/mock-update-feed/`：latest.yml + aigc-studio-<version>-x64.exe（含 .blockmap）。
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  const options = { port: 8787, version: '0.15.1', dir: join(ROOT, '.tmp', 'mock-update-feed') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') {
      options.port = Number(argv[index + 1])
      index += 1
    } else if (arg === '--version') {
      options.version = String(argv[index + 1] ?? '').trim() || options.version
      index += 1
    } else if (arg === '--dir') {
      options.dir = resolve(String(argv[index + 1] ?? ''))
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log('node tools/mock-update-feed.mjs [--port 8787] [--version 0.15.1] [--dir .tmp/mock-update-feed]')
      process.exit(0)
    }
  }
  return options
}

const MIME = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
}

async function prepare(dir, version) {
  await mkdir(dir, { recursive: true })
  const artifact = `aigc-studio-${version}-x64.exe`
  // 假安装包：2 MB 的可辨识内容，足够让下载进度可见，又不会占磁盘。
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x41)
  payload.write(`AIGC Studio mock update ${version} — do not install`, 0, 'utf8')
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const blockmap = Buffer.from(`mock blockmap for ${version}\n`, 'utf8')
  const latestYml = [
    `version: ${version}`,
    'files:',
    `  - url: ${artifact}`,
    `    sha512: ${sha512}`,
    `    size: ${payload.length}`,
    `path: ${artifact}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    `releaseName: Mock ${version}`,
    'releaseNotes: Local mock feed for UI development.',
    '',
  ].join('\n')
  await writeFile(join(dir, artifact), payload)
  await writeFile(join(dir, `${artifact}.blockmap`), blockmap)
  await writeFile(join(dir, 'latest.yml'), latestYml, 'utf8')
  return { artifact, size: payload.length }
}

function safePath(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0])
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null
  return target
}

const options = parseArgs(process.argv.slice(2))
if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
  console.error(`端口非法：${options.port}`)
  process.exit(1)
}

const { artifact, size } = await prepare(options.dir, options.version)

const server = createServer(async (req, res) => {
  const target = safePath(options.dir, req.url ?? '/')
  if (!target) {
    res.writeHead(400)
    res.end('bad path')
    return
  }
  try {
    const body = await readFile(target)
    const extension = target.slice(target.lastIndexOf('.'))
    res.writeHead(200, {
      'content-type': MIME[extension] ?? 'application/octet-stream',
      'content-length': body.length,
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})

server.listen(options.port, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${options.port}`
  console.log(`mock update feed ready: ${base}/latest.yml`)
  console.log(`artifact: ${artifact} (${size} bytes, sha512 in latest.yml)`)
  console.log('桌面端联调：AIGC_STUDIO_UPDATE_DEV=1 AIGC_STUDIO_UPDATE_FEED=' + base + ' npm run dev')
  console.log('注意：这是假安装包，只用于 UI / 状态机联调，不要点击安装。')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
