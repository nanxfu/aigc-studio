#!/usr/bin/env node
/**
 * Release 产物校验（M2.8 阶段 A）。
 *
 * 校验 electron-builder 产出的 `latest.yml` 与磁盘文件是否真正对齐：
 *  - `version` 与期望版本一致；
 *  - `files[].url` / `path` 指向的文件存在，大小一致；
 *  - `files[].sha512` 与文件实际 SHA-512（base64）一致；
 *  - NSIS 安装包旁边有非空 `.blockmap`；
 *  - Portable 产物存在（可用 `--skip-portable` 跳过）；
 *  - 生成 `SHA256SUMS.txt` 供手动下载者校验。
 *
 * 用法：
 *   node tools/verify-release.mjs
 *   node tools/verify-release.mjs --dir release --expect-version 0.14.0
 *   node tools/verify-release.mjs --latest .tmp/latest.bad.yml   # 负向验证：用篡改过的清单
 *
 * 退出码：0 通过；1 校验失败；2 参数/文件读取错误。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG_PATH = join(ROOT, 'package.json')
const SUMS_FILE = 'SHA256SUMS.txt'

function parseArgs(argv) {
  const options = {
    dir: join(ROOT, 'release'),
    latest: null,
    expectVersion: null,
    skipPortable: false,
    quiet: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--skip-portable') {
      options.skipPortable = true
      continue
    }
    if (arg === '--quiet') {
      options.quiet = true
      continue
    }
    if (arg === '--dir' || arg === '--latest' || arg === '--expect-version') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      if (arg === '--dir') options.dir = resolve(ROOT, value)
      if (arg === '--latest') options.latest = resolve(ROOT, value)
      if (arg === '--expect-version') options.expectVersion = value.trim()
      index += 1
      continue
    }
    if (arg.startsWith('--dir=')) {
      options.dir = resolve(ROOT, arg.slice('--dir='.length))
      continue
    }
    if (arg.startsWith('--latest=')) {
      options.latest = resolve(ROOT, arg.slice('--latest='.length))
      continue
    }
    if (arg.startsWith('--expect-version=')) {
      options.expectVersion = arg.slice('--expect-version='.length).trim()
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  options.latest = options.latest ?? join(options.dir, 'latest.yml')
  return options
}

function printHelp() {
  console.log(`用法：node tools/verify-release.mjs [选项]

选项：
  --dir <目录>              产物目录（默认 release/）
  --latest <文件>           latest.yml 路径（默认 <dir>/latest.yml；负向验证时可指向篡改副本）
  --expect-version <版本>   期望版本（默认 package.json.version）
  --skip-portable           不要求 portable 产物
  --quiet                   只输出错误
  -h, --help                显示帮助`)
}

async function statFile(filePath) {
  try {
    const info = await stat(filePath)
    return info.isFile() ? info : null
  } catch {
    return null
  }
}

/** 一次读取同时算多个摘要；大文件不整体载入内存。latest.yml 用 base64 sha512，SHA256SUMS 用 hex sha256。 */
async function hashFile(filePath, algorithms) {
  const hashes = new Map(algorithms.map((algorithm) => [algorithm, createHash(algorithm)]))
  const stream = createReadStream(filePath)
  for await (const chunk of stream) {
    for (const hash of hashes.values()) hash.update(chunk)
  }
  const result = {}
  for (const [algorithm, hash] of hashes) {
    result[algorithm] = hash.digest(algorithm === 'sha512' ? 'base64' : 'hex')
  }
  return result
}

/** 把 latest.yml 里的 url 归一成产物目录下的相对路径；绝对 URL 取 basename。 */
function fileNameOfUrl(rawUrl) {
  const text = String(rawUrl ?? '').trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) {
    try {
      return basename(decodeURIComponent(new URL(text).pathname))
    } catch {
      return ''
    }
  }
  const decoded = decodeURIComponent(text)
  if (isAbsolute(decoded)) return ''
  return decoded.replace(/\\/g, '/')
}

function resolveArtifact(dir, fileName) {
  const absolute = resolve(dir, fileName)
  const rel = relative(dir, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return absolute
}

function fail(errors, message) {
  errors.push(message)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[release-verify] ${error.message}`)
    return 2
  }
  if (options.help) {
    printHelp()
    return 0
  }

  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  const expectVersion = options.expectVersion || pkg.version
  const errors = []
  const info = (message) => {
    if (!options.quiet) console.log(`[release-verify] ${message}`)
  }

  let latestText
  try {
    latestText = await readFile(options.latest, 'utf8')
  } catch (error) {
    console.error(`[release-verify] 读取 latest.yml 失败：${options.latest}（${error.message}）`)
    return 2
  }

  let latest
  try {
    latest = yaml.load(latestText)
  } catch (error) {
    console.error(`[release-verify] latest.yml 不是合法 YAML：${error.message}`)
    return 2
  }
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
    console.error('[release-verify] latest.yml 顶层必须是对象')
    return 1
  }

  const latestVersion = typeof latest.version === 'string' ? latest.version.trim() : ''
  if (!latestVersion) fail(errors, 'latest.yml 缺少 version')
  else if (latestVersion !== expectVersion) fail(errors, `latest.yml version=${latestVersion}，期望 ${expectVersion}`)

  const files = Array.isArray(latest.files) ? latest.files : []
  if (files.length === 0) fail(errors, 'latest.yml 缺少 files[]')

  const verified = new Map() // absolute path -> { sha256, sha512, size, file }
  const versionsOfFiles = new Map()

  for (const [index, item] of files.entries()) {
    if (!item || typeof item !== 'object') {
      fail(errors, `files[${index}] 不是对象`)
      continue
    }
    const fileName = fileNameOfUrl(item.url)
    if (!fileName) {
      fail(errors, `files[${index}].url 为空或不是合法相对路径`)
      continue
    }
    const absolute = resolveArtifact(options.dir, fileName)
    if (!absolute) {
      fail(errors, `files[${index}].url 越出产物目录：${item.url}`)
      continue
    }
    const fileInfo = await statFile(absolute)
    if (!fileInfo) {
      fail(errors, `files[${index}] 文件不存在：${fileName}`)
      continue
    }
    versionsOfFiles.set(fileName, absolute)

    const expectedSha512 = typeof item.sha512 === 'string' ? item.sha512.trim() : ''
    if (!expectedSha512) fail(errors, `files[${index}] 缺少 sha512`)
    if (item.size != null && Number(item.size) !== fileInfo.size) {
      fail(errors, `files[${index}] 大小不一致：latest=${item.size}，实际=${fileInfo.size}（${fileName}）`)
    }

    const hashes = await hashFile(absolute, ['sha256', 'sha512'])
    if (expectedSha512 && hashes.sha512 !== expectedSha512) {
      fail(
        errors,
        `files[${index}] sha512 不一致：${fileName}（latest=${expectedSha512.slice(0, 16)}…，实际=${hashes.sha512.slice(0, 16)}…）`,
      )
    }
    verified.set(absolute, { ...hashes, size: fileInfo.size, file: fileName })
  }

  // 顶层 path / sha512 是 electron-updater 实际读取的字段，必须与 files[] 同源。
  const pathName = fileNameOfUrl(latest.path)
  if (!pathName) {
    fail(errors, 'latest.yml 缺少 path')
  } else {
    const pathAbsolute = resolveArtifact(options.dir, pathName)
    if (!pathAbsolute) {
      fail(errors, `latest.yml path 越出产物目录：${latest.path}`)
    } else if (!versionsOfFiles.has(pathName)) {
      fail(errors, `latest.yml path=${pathName} 不在 files[] 中`)
    } else {
      const entry = verified.get(pathAbsolute)
      const topSha512 = typeof latest.sha512 === 'string' ? latest.sha512.trim() : ''
      if (topSha512 && entry && topSha512 !== entry.sha512) {
        fail(errors, `latest.yml 顶层 sha512 与 path 文件不一致：${pathName}`)
      }
    }
  }

  // 每个非 portable 的 .exe 都必须有非空 .blockmap（差分下载依赖）。
  for (const [absolute, entry] of verified) {
    if (!/\.exe$/i.test(entry.file) || /-portable\.exe$/i.test(entry.file)) continue
    const blockmap = `${absolute}.blockmap`
    const blockmapInfo = await statFile(blockmap)
    if (!blockmapInfo) fail(errors, `缺少 blockmap：${entry.file}.blockmap`)
    else if (blockmapInfo.size <= 0) fail(errors, `blockmap 为空：${entry.file}.blockmap`)
    else {
      const blockmapHashes = await hashFile(blockmap, ['sha256'])
      verified.set(blockmap, { ...blockmapHashes, size: blockmapInfo.size, file: `${entry.file}.blockmap` })
    }
  }

  // Portable 不在 latest.yml 里，但发布资产契约要求它存在。
  if (!options.skipPortable) {
    const portableName = `${pkg.name}-${expectVersion}-portable.exe`
    const portablePath = join(options.dir, portableName)
    const portableInfo = await statFile(portablePath)
    if (!portableInfo) {
      fail(errors, `缺少 portable 产物：${portableName}（可用 --skip-portable 跳过）`)
    } else if (portableInfo.size <= 0) {
      fail(errors, `portable 产物为空：${portableName}`)
    } else {
      const portableHashes = await hashFile(portablePath, ['sha256', 'sha512'])
      verified.set(portablePath, { ...portableHashes, size: portableInfo.size, file: portableName })
    }
  }

  // 产物目录里是否残留旧版本的可执行文件：不阻断，但提示清理，避免误上传。
  const topLevel = await readdir(options.dir, { withFileTypes: true })
  const stale = topLevel
    .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !name.includes(expectVersion))
  if (stale.length > 0) info(`提示：release/ 下存在非 ${expectVersion} 的 exe（未计入校验）：${stale.join(', ')}`)

  if (errors.length > 0) {
    console.error('[release-verify] 校验失败：')
    for (const line of errors) console.error(`  - ${line}`)
    return 1
  }

  // 只有校验通过才写 SHA256SUMS，避免半套产物留下看似可用的校验文件。
  const lines = []
  for (const entry of [...verified.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    lines.push(`${entry.sha256}  ${entry.file}`)
  }
  const latestInfo = await statFile(options.latest)
  if (latestInfo) {
    const latestHashes = await hashFile(options.latest, ['sha256'])
    lines.push(`${latestHashes.sha256}  ${basename(options.latest)}`)
  }
  await writeFile(join(options.dir, SUMS_FILE), `${lines.join('\n')}\n`, 'utf8')

  info(`OK version=${expectVersion} files=${verified.size} sums=${basename(join(options.dir, SUMS_FILE))}`)
  for (const entry of [...verified.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const digest = entry.sha512 ? `sha512=${entry.sha512.slice(0, 16)}…` : `sha256=${entry.sha256.slice(0, 16)}…`
    info(`  ${entry.file}  ${entry.size} bytes  ${digest}`)
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`[release-verify] 未预期错误：${error?.stack ?? error}`)
    process.exitCode = 1
  })
