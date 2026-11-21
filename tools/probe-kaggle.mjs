#!/usr/bin/env node
/**
 * Kaggle 环境探测（只读，不推 Kernel、不消耗 GPU 配额）。
 *
 * 与客户端启动时的 `/api/state` 探测走同一条代码路径（server/kaggle-direct.js 的 probeKaggle）：
 * 读取本机凭据 → access token 过期则用 refresh_token 续期 → 调 ListKernels 鉴权探测 + 配额统计。
 *
 * 用法：
 *   node tools/probe-kaggle.mjs            # 人类可读摘要
 *   node tools/probe-kaggle.mjs --json     # 原样输出 probe JSON（脚本/CI 用）
 *   node tools/probe-kaggle.mjs --timeout 30000
 *
 * 退出码：0 = 鉴权正常；2 = 鉴权失败或凭据缺失；1 = 脚本异常。
 * 安全：probe 返回结构里不含 token 原文，只含 ok / 用户名 / 配额 / 说明。
 */

import { spawn } from 'node:child_process'

import { probeKaggle } from '../server/kaggle-direct.js'

const DEFAULT_TIMEOUT_MS = 20_000

/** 最小 subprocess 适配器：probeKaggle 只在 fetch 失败时才需要 curl 兜底。 */
function createSubprocess() {
  return {
    async resolveExecutable(name) {
      return name
    },
    spawn({ argv, cwd, signal }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: cwd ?? process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const out = []
      const err = []
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      const done = new Promise((resolve) => {
        child.on('error', (error) => resolve({ exitCode: -1, error: String(error?.message ?? error) }))
        child.on('close', (code, sig) => resolve({ exitCode: code ?? -1, signal: sig }))
      })
      signal?.addEventListener?.('abort', () => child.kill())
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8') }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8') }) },
        },
        terminate: async () => {
          child.kill()
        },
        waitForExit: () => done,
      }
    },
  }
}

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

async function main() {
  const asJson = process.argv.includes('--json')
  const timeoutMs = Number(argOf('timeout', String(DEFAULT_TIMEOUT_MS)))
  const startedAt = Date.now()
  const probe = await probeKaggle(
    { subprocess: createSubprocess() },
    { timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS },
  )
  const elapsedMs = Date.now() - startedAt

  if (asJson) {
    console.log(JSON.stringify({ elapsedMs, probe }, null, 2))
    process.exit(probe?.auth?.ok ? 0 : 2)
  }

  console.log(`Kaggle 环境探测（耗时 ${elapsedMs} ms）`)
  console.log(`  访问方式：${probe.cli?.direct ? '直连（Kaggle JSON API）' : 'kaggle CLI'}`)
  console.log(`  账号：${probe.cli?.username || '未知'}`)
  console.log(`  鉴权：${probe.auth?.ok ? '正常' : `失败（${probe.auth?.errorCode ?? 'unknown'}）`}`)
  if (probe.quota?.available) {
    console.log(`  GPU 配额：${probe.quota.raw}`)
  } else {
    console.log('  GPU 配额：不可用（账号可能未绑定手机号或未启用 GPU）')
  }
  if (Array.isArray(probe.notes) && probe.notes.length > 0) {
    console.log('  说明：')
    for (const note of probe.notes) console.log(`    - ${note}`)
  }
  process.exit(probe?.auth?.ok ? 0 : 2)
}

main().catch((error) => {
  console.error('探测异常：', error?.message ?? error)
  process.exit(1)
})
