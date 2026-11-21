#!/usr/bin/env node
/**
 * Release 版本一致性检查（M2.8 阶段 A）。
 *
 * 目的：在打包/发布前一次性确认「Tag、package.json、shared/contract.js」三处版本一致，
 * 避免出现 latest.yml 写 0.15.0、安装包叫 0.14.0、客户端却认为自己 0.15.0 的错位。
 *
 * 用法：
 *   node tools/check-release-version.mjs                 # 本地检查 package 与契约
 *   node tools/check-release-version.mjs --tag v0.15.0   # 额外检查 Tag
 *   node tools/check-release-version.mjs --require-tag   # CI Tag 构建；没有 Tag 直接失败
 *
 * 兼容 M3.0 的版本分离：产品版本优先读 `contract.APP_VERSION`，回退旧的 `contract.VERSION`。
 * 协议版本（PROTOCOL_VERSION）不在这里比较；它由 `test/check-contract.mjs` 与 worker 契约校验。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { normalizeVersion } from '../shared/version.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG_PATH = join(ROOT, 'package.json')
const CONTRACT_PATH = join(ROOT, 'shared', 'contract.js')

function parseArgs(argv) {
  const options = { tag: '', requireTag: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--require-tag') {
      options.requireTag = true
      continue
    }
    if (arg === '--tag') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error('--tag 需要一个版本号，例如 v0.15.0')
      options.tag = value
      index += 1
      continue
    }
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  return options
}

function printHelp() {
  console.log(`用法：node tools/check-release-version.mjs [--tag v0.15.0] [--require-tag]

检查项：
  1. package.json.version 必须是合法版本号；
  2. package.json.version 必须等于 shared/contract.js 的 APP_VERSION（缺失时回退 VERSION）；
  3. 提供 Tag 时，去掉 v 前缀后必须与 package.json.version 完全一致。`)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[release-version] ${error.message}`)
    return 2
  }
  if (options.help) {
    printHelp()
    return 0
  }

  const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'))
  const contract = await import(pathToFileURL(CONTRACT_PATH).href)
  // M3.0 会把产品版本与协议版本拆开；这里提前按 APP_VERSION 优先读取，避免脚本误报。
  const appVersion = contract.APP_VERSION ?? contract.VERSION
  const packageVersion = typeof pkg?.version === 'string' ? pkg.version.trim() : ''
  const contractVersion = typeof appVersion === 'string' ? appVersion.trim() : ''

  const envTag = process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME ?? '') : ''
  const rawTag = options.tag || envTag
  const tagVersion = rawTag ? rawTag.trim().replace(/^[vV](?=[0-9])/, '') : ''

  const errors = []
  if (!normalizeVersion(packageVersion)) {
    errors.push(`package.json.version 不是合法版本号：${JSON.stringify(pkg?.version)}`)
  }
  if (!normalizeVersion(contractVersion)) {
    errors.push(`shared/contract.js 的 APP_VERSION/VERSION 不是合法版本号：${JSON.stringify(appVersion)}`)
  }
  if (packageVersion && contractVersion && packageVersion !== contractVersion) {
    errors.push(`package.json.version=${packageVersion} 与契约版本=${contractVersion} 不一致`)
  }
  if (options.requireTag && !rawTag) {
    errors.push('要求 Tag 构建，但没有拿到 --tag 或 GITHUB_REF_NAME（GITHUB_REF_TYPE=tag）')
  }
  if (tagVersion) {
    if (!normalizeVersion(tagVersion)) {
      errors.push(`Tag 不是合法版本号：${JSON.stringify(rawTag)}`)
    } else if (tagVersion !== packageVersion) {
      errors.push(`Tag=${rawTag}（解析为 ${tagVersion}）与 package.json.version=${packageVersion} 不一致`)
    }
  }

  if (errors.length > 0) {
    console.error('[release-version] 检查失败：')
    for (const line of errors) console.error(`  - ${line}`)
    return 1
  }

  console.log(
    `[release-version] OK package=${packageVersion} contract=${contractVersion} tag=${tagVersion || '（未提供，跳过）'}`,
  )
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`[release-version] 未预期错误：${error?.stack ?? error}`)
    process.exitCode = 1
  })
