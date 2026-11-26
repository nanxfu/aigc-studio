#!/usr/bin/env node
/**
 * Salad Z-Image compact-q4 真机验收。
 *
 * - 租 1 台指定 GPU（默认 RTX 3090），用新 Worker 镜像创建容器组；
 * - 记录容器就绪、Worker ready、compact 冷启/热图、峰值显存与出图；
 * - `--full` 会在同一容器里再跑一次满血 BF16，供同 Seed 画质对比；
 * - 无论成功失败都在 finally 删除容器组，并复查账户里没有该组残留。
 *
 * Key 只从 .env / 环境变量读取，不打印。
 *
 * 用法：
 *   node tools/probes/salad_zimage_validate.mjs --gpu "RTX 3090" --image ghcr.io/nanxfu/aigc-worker:manual-58e6674
 *   node tools/probes/salad_zimage_validate.mjs --gpu "RTX 4090" --image ... --full
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRESETS, SALAD } from '../../shared/contract.js'
import { createSaladApi, createSaladProvider } from '../../server/providers/salad.js'
import { fetchHealth, submitGenerate, waitForJob } from '../../server/remote.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PRESET_ID = 'z-image-turbo'
const VARIANT_ID = 'compact-q4'
const DEFAULT_PROMPT =
  'A minimalist travel poster with the Chinese headline "山城夜色" and the English ' +
  'subtitle "NIGHT CITY", layered neon reflections on wet stone stairs, cinematic ' +
  'lighting, crisp typography, high detail'

function envFile() {
  try {
    return readFileSync(resolve(ROOT, '.env'), 'utf8')
  } catch {
    return ''
  }
}

function envValue(name, source) {
  const fromProcess = String(process.env[name] ?? '').trim()
  if (fromProcess) return fromProcess
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
    if (match) return match[1].replace(/^['"]|['"]$/g, '').trim()
  }
  return ''
}

function parseArgs(argv) {
  const options = {
    gpu: 'RTX 3090',
    image: '',
    prompt: DEFAULT_PROMPT,
    seed: 42,
    width: 1024,
    height: 1024,
    steps: 9,
    full: false,
    anyRegion: false,
    json: '',
    outputDir: '',
    timeoutMin: 30,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} 需要一个值`)
      return argv[index]
    }
    if (arg === '--gpu') options.gpu = normalizeGpu(next())
    else if (arg === '--image') options.image = next()
    else if (arg === '--prompt') options.prompt = next()
    else if (arg === '--seed') options.seed = Number(next())
    else if (arg === '--width') options.width = Number(next())
    else if (arg === '--height') options.height = Number(next())
    else if (arg === '--steps') options.steps = Number(next())
    else if (arg === '--full') options.full = true
    else if (arg === '--any-region') options.anyRegion = true
    else if (arg === '--json') options.json = next()
    else if (arg === '--output-dir') options.outputDir = next()
    else if (arg === '--timeout-min') options.timeoutMin = Number(next())
    else if (arg === '--help' || arg === '-h') {
      console.log('node tools/probes/salad_zimage_validate.mjs --gpu <name> --image <tag> [--full] [--any-region]')
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  if (!options.image.trim()) throw new Error('必须传 --image（本轮新 Worker 镜像 Tag）')
  if (!Number.isFinite(options.seed) || options.seed < 0) throw new Error('--seed 非法')
  if (![256, 512, 768, 1024, 1152, 1280, 1536].includes(options.width)) {
    throw new Error(`--width 不支持：${options.width}`)
  }
  if (![256, 512, 768, 1024, 1152, 1280, 1536].includes(options.height)) {
    throw new Error(`--height 不支持：${options.height}`)
  }
  return options
}

function normalizeGpu(value) {
  const text = String(value || '').trim()
  if (/^(rtx[-_ ]?)?3090$/i.test(text)) return 'RTX 3090'
  if (/^(rtx[-_ ]?)?4090$/i.test(text)) return 'RTX 4090'
  return text
}

function nowMs() {
  return Date.now()
}

function elapsedSeconds(started) {
  return Math.round((nowMs() - started) / 10) / 100
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function jobBody(pipeline, options, label) {
  return {
    pipeline,
    presetId: PRESET_ID,
    modelId: 'Tongyi-MAI/Z-Image-Turbo',
    jobId: `salad-${slug(options.gpu)}-${label}-${Date.now().toString(36)}`,
    tasks: [
      {
        name: '01',
        prompt: options.prompt,
        negative_prompt: '',
        seed: options.seed,
        width: options.width,
        height: options.height,
        steps: options.steps,
        cfg: 0,
      },
    ],
  }
}

async function waitForEndpoint(provider, run, handle, deadline) {
  let current = handle
  while (nowMs() < deadline) {
    if (current.endpointUrl) return current
    const next = await provider.pollEndpoint(run, current)
    if (next?.endpointUrl) return { ...current, ...next }
    await sleep(5000)
  }
  throw new Error('Salad 容器在超时前没有拿到 Gateway 地址')
}

async function waitForWorker(endpoint, token, deadline) {
  let lastError = null
  while (nowMs() < deadline) {
    try {
      const health = await fetchHealth(endpoint, token, 15000)
      if (health?.phase === 'ready') return health
      if (health?.phase === 'error') {
        throw new Error(`Worker 启动失败：${health.last_error_code || 'unknown'} ${health.detail || ''}`.trim())
      }
    } catch (error) {
      lastError = error
    }
    await sleep(5000)
  }
  throw new Error(`Worker 在超时前没有 ready：${lastError?.message ?? 'no health response'}`)
}

async function runGeneration(endpoint, token, pipeline, options, label, timeoutMs) {
  const body = jobBody(pipeline, options, label)
  const started = nowMs()
  const submitted = await submitGenerate(endpoint, token, body, 60000)
  const result = await waitForJob(endpoint, token, submitted.job_id, {
    timeoutMs,
    pollMs: 3000,
    onProgress: (snapshot) => {
      if (snapshot?.status === 'running' || snapshot?.status === 'queued') {
        process.stderr.write(`[salad] ${label} ${snapshot.status}\r`)
      }
    },
  })
  const image = Array.isArray(result?.results) ? result.results[0] : null
  if (!image?.image_b64) throw new Error(`${label} 没有返回 image_b64`)
  let health = null
  try {
    health = await fetchHealth(endpoint, token, 15000)
  } catch {}
  const outputDir = options.outputDir
  mkdirSync(outputDir, { recursive: true })
  const outFile = join(outputDir, `${label}.png`)
  writeFileSync(outFile, Buffer.from(image.image_b64, 'base64'))
  return {
    label,
    jobId: submitted.job_id,
    elapsedSeconds: elapsedSeconds(started),
    loadSeconds: result.load_seconds ?? null,
    seconds: image.seconds ?? null,
    seed: image.seed ?? options.seed,
    width: image.width ?? options.width,
    height: image.height ?? options.height,
    peakVramMb: health?.gpu_memory?.max_allocated_mb ?? null,
    output: outFile,
  }
}

function containerList(api, config) {
  return api.listContainers({
    org: config.org,
    project: config.project,
    apiKey: config.apiKey,
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const env = envFile()
  const saladConfig = {
    apiKey: envValue('SALAD_API_KEY', env),
    org: envValue('SALAD_ORG', env).toLowerCase(),
    project: (envValue('SALAD_PROJECT', env) || 'default').toLowerCase(),
    tier: 'medium',
  }
  if (!saladConfig.apiKey || !saladConfig.org) {
    throw new Error('缺少 SALAD_API_KEY / SALAD_ORG')
  }
  const preset = PRESETS.find((item) => item.id === PRESET_ID)
  const compact = preset?.variants?.find((item) => item.id === VARIANT_ID)
  if (!compact?.pipeline) throw new Error('找不到 z-image-turbo compact-q4 pipeline')

  const outputDir = resolve(
    ROOT,
    options.outputDir || `bench-results/salad-zimage-20261126/${slug(options.gpu)}`,
  )
  options.outputDir = outputDir
  mkdirSync(outputDir, { recursive: true })
  const summaryPath = resolve(ROOT, options.json || join(outputDir, 'summary.json'))
  const workspace = join(outputDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const ctx = {
    get(name) {
      return name === 'workingDirectory' ? { defaultDirectory: workspace } : undefined
    },
  }

  const api = createSaladApi({ ctx })
  const log = {
    info: (message) => console.error(`[salad] ${message}`),
    warn: (message) => console.error(`[salad] WARN ${message}`),
    debug: () => {},
  }
  const provider = createSaladProvider({
    ctx,
    api,
    log,
    options: {
      getSaladConfig: () => saladConfig,
      image: options.image,
      gpuOverride: options.gpu,
      countryCodes: options.anyRegion ? [] : [...SALAD.countryCodes],
    },
  })
  const abort = new AbortController()
  const run = { signal: abort.signal, isCurrent: () => true }
  const timeoutMs = Math.max(5, options.timeoutMin) * 60 * 1000
  const provisionDeadline = nowMs() + timeoutMs
  const summary = {
    probe: 'salad-zimage-compact',
    startedAt: new Date().toISOString(),
    gpu: options.gpu,
    image: options.image,
    prompt: options.prompt,
    seed: options.seed,
    width: options.width,
    height: options.height,
    steps: options.steps,
    anyRegion: options.anyRegion,
    stages: {},
    outputs: [],
  }
  try {
    const before = await containerList(api, saladConfig)
    const names = Array.isArray(before?.items) ? before.items.map((item) => item.name).filter(Boolean) : []
    summary.beforeGroups = names
  } catch (error) {
    summary.beforeGroupsError = error?.message ?? String(error)
  }

  let handle = null
  let token = ''
  let groupName = ''
  let cleanupVerified = false
  try {
    const t0 = nowMs()
    const provisioned = await provider.provision(run, {
      presetId: PRESET_ID,
      variantId: VARIANT_ID,
      onProgress: (event) => {
        if (event?.detail) process.stderr.write(`[salad] ${event.detail}\n`)
      },
    })
    handle = provisioned.handle
    token = provisioned.token
    groupName = handle.groupName || ''
    summary.groupName = groupName
    summary.gpuSelected = handle.gpuName || null
    if (handle.gpuName && !handle.gpuName.toLowerCase().includes(options.gpu.toLowerCase())) {
      throw new Error(`Salad 选到了 ${handle.gpuName}，不是请求的 ${options.gpu}`)
    }
    handle = await waitForEndpoint(provider, run, handle, provisionDeadline)
    summary.stages.endpointReadySeconds = elapsedSeconds(t0)
    summary.endpointUrl = handle.endpointUrl
    const readyHealth = await waitForWorker(handle.endpointUrl, token, provisionDeadline)
    summary.stages.workerReadySeconds = elapsedSeconds(t0)
    summary.worker = {
      versions: readyHealth.versions ?? null,
      capabilities: readyHealth.capabilities ?? null,
      hardware: readyHealth.hardware ?? null,
      device: readyHealth.device ?? null,
    }

    const compactCold = await runGeneration(
      handle.endpointUrl,
      token,
      compact.pipeline,
      options,
      'compact-cold',
      timeoutMs,
    )
    summary.stages.compactColdSeconds = elapsedSeconds(t0)
    summary.outputs.push(compactCold)

    const compactWarm = await runGeneration(
      handle.endpointUrl,
      token,
      compact.pipeline,
      options,
      'compact-warm',
      timeoutMs,
    )
    summary.stages.compactWarmSeconds = elapsedSeconds(t0)
    summary.outputs.push(compactWarm)

    if (options.full) {
      const full = await runGeneration(
        handle.endpointUrl,
        token,
        preset.pipeline,
        options,
        'full-bf16',
        timeoutMs,
      )
      summary.outputs.push(full)
    }
  } finally {
    if (handle?.groupName) {
      const result = await provider.teardown(run, handle).catch((error) => ({
        ok: false,
        detail: error?.message ?? String(error),
      }))
      summary.teardown = result
      try {
        const containers = await containerList(api, saladConfig)
        const names = Array.isArray(containers?.items) ? containers.items.map((item) => item.name) : []
        cleanupVerified = !names.includes(handle.groupName)
        summary.remainingGroup = names.includes(handle.groupName)
        summary.activeGroups = names.filter((name) => String(name).startsWith('aigc-studio-'))
      } catch (error) {
        summary.cleanupCheckError = error?.message ?? String(error)
      }
    }
    summary.cleanupVerified = cleanupVerified
    summary.finishedAt = new Date().toISOString()
    mkdirSync(dirname(summaryPath), { recursive: true })
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify(summary, null, 2))
    console.error(`[salad] summary: ${summaryPath}`)
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? error)
  process.exitCode = 1
})
