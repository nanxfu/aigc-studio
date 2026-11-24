#!/usr/bin/env node
/**
 * 7 模型 × 9 维统一盲测批跑脚本（支持 Kaggle / Colab 并行独立运行与断点续跑）。
 *
 * 用法：
 *   node tools/bench-9dim.mjs --provider kaggle
 *   node tools/bench-9dim.mjs --provider colab --gpu L4
 *   node tools/bench-9dim.mjs --provider kaggle --models sdxl-lightning --dims 01-typography-poster
 *   node tools/bench-9dim.mjs --provider kaggle --dry-run
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { PRESETS } from '../shared/contract.js'
import { SessionManager } from '../server/session.js'
import { fetchHealth, requestGenerate } from '../server/remote.js'
import { saveJobOutput } from '../server/output.js'
import {
  deleteKernel as directDeleteKernel,
  kaggleUsername as directKaggleUsername,
  kernelLogs as directKernelLogs,
  kernelStatus as directKernelStatus,
  pushKernel as directPushKernel,
} from '../server/kaggle-direct.js'
import { readHfToken } from './verify-model.mjs'
import { BENCH_DIMS, COLAB_MODELS, KAGGLE_MODELS } from './bench-9dim-prompts.mjs'

const REPO_ROOT = process.cwd()
const DEFAULT_WORKSPACE = resolve(REPO_ROOT, '.aigc-studio-data', 'workspace')
const DEFAULT_OUT = resolve(REPO_ROOT, 'bench-results', '9dim')
const REQUEST_TIMEOUT_MS = 25 * 60 * 1000
const MAX_START_ATTEMPTS = 4

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
const argVal = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}

const provider = String(argVal('--provider', '')).trim().toLowerCase()
if (provider !== 'kaggle' && provider !== 'colab') {
  console.error('请指定 --provider kaggle 或 --provider colab')
  process.exit(1)
}

const gpu = String(argVal('--gpu', 'L4')).trim().toUpperCase()
const outDir = resolve(REPO_ROOT, argVal('--out', DEFAULT_OUT))
const realWorkspace = hasFlag('--no-workspace') ? null : resolve(REPO_ROOT, argVal('--workspace', DEFAULT_WORKSPACE))
const force = hasFlag('--force')
const dryRun = hasFlag('--dry-run')

const defaultModelIds = provider === 'colab' ? COLAB_MODELS : KAGGLE_MODELS
const modelIds = argVal('--models')
  ? argVal('--models').split(',').map((s) => s.trim()).filter(Boolean)
  : [...defaultModelIds]

const dimFilter = argVal('--dims')
  ? new Set(argVal('--dims').split(',').map((s) => s.trim()).filter(Boolean))
  : null
const dims = dimFilter ? BENCH_DIMS.filter((d) => dimFilter.has(d.id) || dimFilter.has(String(d.index))) : [...BENCH_DIMS]

const presets = modelIds.map((id) => {
  const preset = PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`未知模型预设：${id}`)
  return preset
})

const ts = () => new Date().toISOString().slice(11, 19)
const log = (msg) => console.log(`[${provider} ${ts()}] ${msg}`)
const sink = {
  debug: () => {},
  info: (...a) => log(a.join(' ')),
  warn: (...a) => log(`WARN ${a.join(' ')}`),
  error: (...a) => log(`ERROR ${a.join(' ')}`),
}

function resolveColabCreds() {
  if (process.env.AIGC_STUDIO_COLAB_CREDENTIALS) return process.env.AIGC_STUDIO_COLAB_CREDENTIALS
  const candidates = [
    join(REPO_ROOT, '.aigc-studio-data', 'credentials', 'colab-credentials.json'),
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'aigc-studio', 'credentials', 'colab-credentials.json'),
    join(homedir(), '.aigc-studio', 'colab-credentials.json'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) process.env.AIGC_STUDIO_COLAB_CREDENTIALS = found
  return found ?? null
}

function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function writeAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data)
  await rename(tmp, filePath)
}

function buildTodoList() {
  const todo = []
  for (const preset of presets) {
    for (const dim of dims) {
      const dir = join(outDir, preset.id)
      const pngPath = join(dir, `${dim.id}.png`)
      const jsonPath = join(dir, `${dim.id}.json`)
      const exists = existsSync(pngPath) && existsSync(jsonPath)
      if (!force && exists) continue
      todo.push({ preset, dim, dir, pngPath, jsonPath })
    }
  }
  return todo
}

async function main() {
  const colabCreds = provider === 'colab' ? resolveColabCreds() : null
  const hfToken = (await readHfToken().catch(() => null)) || String(process.env.HF_TOKEN ?? '').trim() || null
  const todo = buildTodoList()

  log(`计划：模型 [${presets.map((p) => p.id).join(', ')}] × ${dims.length} 维，待跑 ${todo.length}/${presets.length * dims.length} 张`)
  log(`输出目录：${outDir}`)
  log(`真实作品集工作区：${realWorkspace ?? '(禁用)'}`)
  if (provider === 'colab') log(`Colab 凭据：${colabCreds ?? '(未找到)'}，GPU=${gpu}，HF_TOKEN=${hfToken ? '已配置' : '未配置'}`)

  if (dryRun) {
    log('dry-run 完成，未启动远端 GPU。')
    return
  }
  if (todo.length === 0) {
    log('全部目标图片均已存在，无需重复生成（加 --force 可覆盖重跑）。')
    return
  }
  if (provider === 'colab' && !colabCreds) {
    throw new Error('未找到 colab-credentials.json，无法启动 Colab 会话')
  }

  const sessionWorkspace = resolve(REPO_ROOT, '.tmp', `bench-9dim-session-${provider}`)
  await mkdir(sessionWorkspace, { recursive: true })
  await mkdir(outDir, { recursive: true })

  const firstPreset = todo[0].preset
  const sessionOptions =
    provider === 'colab'
      ? {
          provider: 'colab',
          colabGpu: gpu,
          colabHighRam: false,
          hfToken,
          enableGpu: true,
          idleTimeoutSec: 1800,
          provisionTimeoutMs: 30 * 60 * 1000,
          tunnelTimeoutMs: 15 * 60 * 1000,
        }
      : {
          provider: 'kaggle',
          enableGpu: true,
          accelerator: 'NvidiaTeslaT4',
          hfToken,
          idleTimeoutSec: 1800,
          provisionTimeoutMs: 45 * 60 * 1000,
          tunnelTimeoutMs: 15 * 60 * 1000,
          kernelTimeoutSec: 10800,
        }

  const sessionDeps =
    provider === 'kaggle'
      ? {
          log: sink,
          kaggleUsername: directKaggleUsername,
          pushKernel: directPushKernel,
          kernelStatus: directKernelStatus,
          kernelLogs: directKernelLogs,
          deleteKernel: directDeleteKernel,
        }
      : { log: sink }

  const session = new SessionManager({
    ctx: { workspace: sessionWorkspace },
    defaultPreset: firstPreset.id,
    options: sessionOptions,
    deps: sessionDeps,
  })

  let stopping = false
  const shutdown = async (reason) => {
    if (stopping) return
    stopping = true
    log(`正在关闭 ${provider} 会话（${reason}）…`)
    await session.stop().catch((e) => log(`关闭会话异常：${e?.message ?? e}`))
    log(`${provider} 会话已关闭。`)
  }
  process.on('SIGINT', () => {
    shutdown('SIGINT').finally(() => process.exit(130))
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').finally(() => process.exit(143))
  })

  const runSummary = {
    provider,
    gpu: provider === 'colab' ? gpu : '2xT4',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    completed: 0,
    failed: [],
  }

  try {
    log(`启动 ${provider} 会话（首个模型 ${firstPreset.id}）…`)
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      try {
        const started = await session.start(firstPreset.id)
        if (started?.state === 'error') {
          throw new Error(started?.error?.message ?? 'start 返回 error')
        }
        let lastLabel = ''
        await session.ensureReady({
          timeoutMs: 35 * 60 * 1000,
          onTick(st) {
            const label = `${st.state}/${st.phase ?? '-'} ${st.detail ?? ''}`.trim()
            if (label !== lastLabel) {
              lastLabel = label
              log(`  · ${label}`)
            }
          },
        })
        break
      } catch (err) {
        log(`第 ${attempt}/${MAX_START_ATTEMPTS} 次启动失败：${err?.message ?? err}`)
        if (attempt >= MAX_START_ATTEMPTS) throw err
        await session.stop().catch(() => {})
        await new Promise((r) => setTimeout(r, 30_000))
      }
    }

    const conn = session.connection()
    const health = await fetchHealth(conn.endpoint, conn.token, 10_000).catch(() => null)
    const deviceName = health?.device ?? (provider === 'colab' ? `Colab ${gpu}` : 'Kaggle 2xT4')
    const deviceCount = Number.isFinite(health?.device_count) ? health.device_count : null
    log(`会话就绪：device=${deviceName} count=${deviceCount ?? '?'}`)

    let doneCount = 0
    for (const item of todo) {
      const { preset, dim, dir, pngPath, jsonPath } = item
      await mkdir(dir, { recursive: true })
      const shortModel = preset.id.replace(/[^a-z0-9]/gi, '').slice(0, 8)
      const jobId = `bench_${shortModel}_d${dim.index}_${randomBytes(3).toString('hex')}`
      const createdAt = new Date().toISOString()

      let response = null
      let lastErr = null
      for (let retry = 1; retry <= 2; retry += 1) {
        try {
          const activeConn = session.connection()
          response = await requestGenerate(
            activeConn.endpoint,
            activeConn.token,
            {
              pipeline: preset.pipeline,
              modelId: preset.repo,
              jobId,
              tasks: [
                {
                  name: `${preset.id}-${dim.id}`,
                  prompt: dim.prompt,
                  negative_prompt: preset.negativeHint ?? '',
                  seed: dim.seed,
                  width: preset.size,
                  height: preset.size,
                  steps: preset.steps,
                  cfg: preset.cfg,
                },
              ],
            },
            { timeoutMs: REQUEST_TIMEOUT_MS, requestMs: session.provider.jobRequestTimeoutMs },
          )
          break
        } catch (err) {
          lastErr = err
          log(`  ! [${preset.id}][${dim.id}] 第 ${retry} 次失败：${err?.message ?? err}`)
          if (retry < 2) await new Promise((r) => setTimeout(r, 5000))
        }
      }

      if (!response) {
        runSummary.failed.push({ presetId: preset.id, dimId: dim.id, error: String(lastErr?.message ?? lastErr) })
        continue
      }

      const result = response.results?.[0]
      const b64 = result?.image_b64 ?? ''
      const buf = Buffer.from(b64, 'base64')
      const size = pngSize(buf)
      if (!size) {
        runSummary.failed.push({ presetId: preset.id, dimId: dim.id, error: `非 PNG 响应 (${buf.length}B)` })
        continue
      }

      await writeAtomic(pngPath, buf)

      let workspaceImagePath = null
      if (realWorkspace) {
        const wsCtx = {
          get(key) {
            return key === 'workingDirectory' ? { defaultDirectory: realWorkspace } : undefined
          },
        }
        const saved = await saveJobOutput(
          wsCtx,
          {
            id: jobId,
            presetId: preset.id,
            modelId: preset.repo,
            provider,
            device: deviceName,
            deviceCount,
            createdAt,
            finishedAt: new Date().toISOString(),
            params: {
              prompt: dim.prompt,
              negativePrompt: preset.negativeHint ?? '',
              width: size.width,
              height: size.height,
              steps: preset.steps,
              cfg: preset.cfg,
              seed: dim.seed,
              count: 1,
            },
          },
          [
            {
              image_b64: b64,
              seed: dim.seed,
              seconds: result?.seconds ?? null,
              width: size.width,
              height: size.height,
            },
          ],
        )
        workspaceImagePath = saved.images?.[0]?.path ?? null
      }

      const meta = {
        presetId: preset.id,
        presetLabel: preset.label,
        dimId: dim.id,
        dimIndex: dim.index,
        titleZh: dim.titleZh,
        titleEn: dim.titleEn,
        prompt: dim.prompt,
        seed: dim.seed,
        width: size.width,
        height: size.height,
        steps: preset.steps,
        cfg: preset.cfg,
        seconds: result?.seconds ?? null,
        loadSeconds: response.load_seconds ?? null,
        pngBytes: buf.length,
        provider,
        device: deviceName,
        workspaceImagePath,
        generatedAt: new Date().toISOString(),
      }
      await writeAtomic(jsonPath, JSON.stringify(meta, null, 2))
      doneCount += 1
      runSummary.completed = doneCount
      log(
        `  [${doneCount}/${todo.length}] ${preset.id} × ${dim.id}：${result?.seconds ?? '?'}s` +
          `${response.load_seconds ? ` (load ${response.load_seconds}s)` : ''} · ${size.width}×${size.height}` +
          `${workspaceImagePath ? ` → ${workspaceImagePath}` : ''}`,
      )
    }
  } finally {
    runSummary.finishedAt = new Date().toISOString()
    await writeAtomic(join(outDir, `run-${provider}.json`), JSON.stringify(runSummary, null, 2)).catch(() => {})
    await shutdown('completed')
  }

  log(`完成：成功 ${runSummary.completed}/${todo.length}，失败 ${runSummary.failed.length}`)
  if (runSummary.failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(`[${provider}] FATAL:`, err?.stack ?? err)
  process.exit(1)
})
