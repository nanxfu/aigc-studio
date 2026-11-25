#!/usr/bin/env node
/**
 * SaladCloud Provider 真机冒烟与大模型压测（默认不进 npm test）。
 *
 * 用法：
 *   node --env-file=.env test/salad-live.mjs
 *   node --env-file=.env test/salad-live.mjs --preset flux2-klein-4b --tier medium --generate --warm
 *   node --env-file=.env test/salad-live.mjs --preset z-image-turbo --gpu "RTX A5000" --generate --warm --gen-timeout-sec 900
 *
 * 会真实创建一个容器组并计费；脚本在成功、失败、超时后都会调用 teardown，
 * 最后再次列出 aigc-studio-* 容器组确认为空。只打印容器组名 / GPU / phase，
 * 不打印 API Key 或 Worker Token。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRESETS } from '../shared/contract.js'
import { createSaladApi, createSaladProvider, pickSaladGpu, requiredVramGbOf, saladResourcesFor } from '../server/providers/salad.js'
import { probeWorkerConnection } from '../server/providers/worker-connection.js'
import { workspaceContext } from './helpers/fake-context.mjs'

function liveContext(workspace) {
  const base = workspaceContext(workspace)
  return {
    ...base,
    subprocess: {
      async resolveExecutable(name) {
        return name
      },
      spawn({ argv, cwd, signal }) {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: cwd ?? process.cwd(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
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
          stdin: child.stdin,
          done,
          collected: {
            stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8') }) },
            stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8') }) },
          },
          terminate: async () => child.kill(),
          waitForExit: () => done,
        }
      },
    },
  }
}

function argOf(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

async function workerRequest(endpointUrl, pathname, { token = '', method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${endpointUrl}${pathname}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 300) }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

async function runGenerate(endpointUrl, token, preset, label, timeoutSec) {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutSec * 1000
  const sub = await workerRequest(endpointUrl, '/generate', {
    token,
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      tool: 'generate',
      result_mode: 'binary',
      pipeline: preset.pipeline,
      tasks: [
        {
          name: `salad-${label}`,
          prompt: 'a crisp studio photograph of a ceramic teapot beside a window at dawn, natural light',
          negative_prompt: preset.negativeHint || '',
          width: 1024,
          height: 1024,
          steps: preset.steps || 4,
          cfg: preset.cfg ?? 1,
          seed: label === 'warm' ? 43 : 42,
        },
      ],
    },
  })
  if (!sub.ok || !sub.json?.job_id) {
    throw new Error(`/generate(${label}) 失败: status=${sub.status} ${sub.error || sub.text}`)
  }
  const jobId = sub.json.job_id
  let lastLine = ''
  while (Date.now() < deadline) {
    const j = await workerRequest(endpointUrl, `/job?id=${encodeURIComponent(jobId)}`, { token, timeoutMs: 15_000 })
    if (j.ok && j.json) {
      const st = j.json.status
      const step = j.json.progress?.step != null ? `${j.json.progress.step}/${j.json.progress.steps}` : ''
      const detail = j.json.progress?.detail || j.json.stage || ''
      const line = `${st} ${step} ${detail}`.trim()
      if (line && line !== lastLine) {
        const sec = ((Date.now() - startedAt) / 1000).toFixed(1)
        console.log(`[live] gen(${label}) +${sec}s ${line}`)
        lastLine = line
      }
      if (st === 'done' || st === 'failed' || st === 'error' || st === 'cancelled') {
        let artifactBytes = null
        let validPng = false
        let logsTail = null
        if (st === 'done') {
          const art = await fetch(`${endpointUrl}/artifact?id=${encodeURIComponent(jobId)}&index=0`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (art.ok) {
            const buf = Buffer.from(await art.arrayBuffer())
            artifactBytes = buf.length
            validPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
          }
        } else {
          const logsRes = await workerRequest(endpointUrl, '/logs?since=0', { token, timeoutMs: 10_000 })
          const lines = Array.isArray(logsRes.json?.lines) ? logsRes.json.lines : []
          logsTail = lines.slice(-25).join('\n')
        }
        return {
          status: st,
          elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
          artifactBytes,
          validPng,
          error: j.json.error ?? j.json.error_code ?? null,
          logsTail,
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  const logsRes = await workerRequest(endpointUrl, '/logs?since=0', { token, timeoutMs: 10_000 }).catch(() => null)
  const lines = Array.isArray(logsRes?.json?.lines) ? logsRes.json.lines : []
  if (lines.length > 0) {
    console.error(`[live] timeout logsTail:\n${lines.slice(-25).join('\n')}`)
  }
  throw new Error(`/generate(${label}) 超时（${timeoutSec}s）`)
}

const apiKey = String(process.env.SALAD_API_KEY ?? '').trim()
const org = String(process.env.SALAD_ORG ?? '').trim().toLowerCase()
const project = String(process.env.SALAD_PROJECT ?? 'default').trim().toLowerCase()
if (!apiKey || !org) {
  console.error('缺少 SALAD_API_KEY / SALAD_ORG；请用 `node --env-file=.env test/salad-live.mjs` 运行')
  process.exit(2)
}

const presetId = argOf('preset', 'sdxl-lightning')
const preset = PRESETS.find((item) => item.id === presetId)
if (!preset) {
  console.error(`未知 preset: ${presetId}`)
  process.exit(2)
}
const tier = argOf('tier', 'medium')
const gpuOverride = argOf('gpu', '')
const timeoutSec = Math.max(60, Number(argOf('timeout-sec', '900')) || 900)
const genTimeoutSec = Math.max(120, Number(argOf('gen-timeout-sec', '900')) || 900)
const doGenerate = hasFlag('generate')
const doWarm = hasFlag('warm')

const workspace = await mkdtemp(join(tmpdir(), 'aigc-salad-live-'))
const ctx = liveContext(workspace)
const api = createSaladApi({ ctx })
const provider = createSaladProvider({
  ctx,
  api,
  log: {
    debug() {},
    info(line) {
      console.log(`[info] ${line}`)
    },
    warn(line) {
      console.warn(`[warn] ${line}`)
    },
    error(line) {
      console.error(`[error] ${line}`)
    },
  },
  options: {
    getSaladConfig: () => ({ apiKey, org, project, tier }),
    ...(gpuOverride ? { gpuOverride } : {}),
  },
})

let handle = null
let token = ''
let deleted = false
let hourlyPrice = 0
let runningAt = null

const onSigInt = async () => {
  if (handle) await provider.teardown({}, handle).catch(() => {})
  process.exit(130)
}
process.once('SIGINT', onSigInt)

try {
  const startedAt = Date.now()
  const gpusDoc = await api.listGpuClasses({ org, apiKey })
  const picked = pickSaladGpu(gpusDoc?.items, {
    tier,
    requiredVramGb: requiredVramGbOf(presetId),
    override: gpuOverride,
  })
  hourlyPrice = Number(picked?.prices?.[tier] ?? 0)
  const resSpec = saladResourcesFor(presetId)
  console.log(
    `[live] preset=${presetId} (dl≈${preset.pipeline?.downloadGb ?? '?'}GB, vramReq=${requiredVramGbOf(presetId)}GB) ` +
      `ram=${resSpec.memoryMb}MB disk=${resSpec.storageGb}GB gpu=${picked.name} tier=${tier} ($${hourlyPrice}/hr)`,
  )

  const provisioned = await provider.provision(
    { signal: new AbortController().signal, isCurrent: () => true },
    { presetId },
  )
  handle = provisioned.handle
  token = provisioned.token
  console.log(`[live] created group=${handle.groupName} gpu=${handle.gpuName} tier=${handle.tier} awaiting=gateway`)

  let endpointUrl = ''
  let lastLog = 0
  while (Date.now() - startedAt < timeoutSec * 1000) {
    const found = await provider.pollEndpoint({}, handle)
    if (found?.endpointUrl) {
      endpointUrl = found.endpointUrl
      runningAt = Date.now()
      break
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    if (elapsed - lastLog >= 20) {
      lastLog = elapsed
      console.log(`[live] +${elapsed}s waiting for running gateway`)
    }
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  if (!endpointUrl) throw new Error(`等待 Gateway running 超时（${timeoutSec}s）`)
  console.log(`[live] gateway ready in ${Math.round((Date.now() - startedAt) / 1000)}s`)

  let health = null
  while (Date.now() - startedAt < timeoutSec * 1000) {
    const probe = await probeWorkerConnection({ ctx, endpointUrl, token, timeoutMs: 10000 })
    if (probe.ok && probe.phase === 'ready') {
      health = probe
      break
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    if (elapsed - lastLog >= 15) {
      lastLog = elapsed
      console.log(`[live] +${elapsed}s worker ${probe.phase ?? probe.error?.code ?? 'starting'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  if (!health) throw new Error(`Worker /health 未在 ${timeoutSec}s 内就绪`)
  console.log(
    `[live] worker ready in ${Math.round((Date.now() - startedAt) / 1000)}s ` +
      `(billedBoot=${((Date.now() - runningAt) / 1000).toFixed(1)}s) phase=${health.phase} ` +
      `gpu=${health.hardware?.gpu_name ?? 'unknown'} vram=${health.hardware?.vram_total_mb ?? '?'}MB`,
  )

  if (doGenerate) {
    const cold = await runGenerate(endpointUrl, token, preset, 'cold', genTimeoutSec)
    console.log(`[live] cold result:`, JSON.stringify(cold))
    if (cold.status !== 'done' || !cold.validPng) {
      throw new Error(`冷启生图失败: ${JSON.stringify(cold)}`)
    }
    if (doWarm) {
      const warm = await runGenerate(endpointUrl, token, preset, 'warm', 300)
      console.log(`[live] warm result:`, JSON.stringify(warm))
      if (warm.status !== 'done' || !warm.validPng) {
        throw new Error(`热图生成失败: ${JSON.stringify(warm)}`)
      }
    }
  }

  const billedSec = runningAt ? (Date.now() - runningAt) / 1000 : 0
  const estCost = (billedSec / 3600) * hourlyPrice
  console.log(
    `[live] summary: total=${((Date.now() - startedAt) / 1000).toFixed(1)}s billed=${billedSec.toFixed(1)}s ` +
      `estCost=$${estCost.toFixed(5)}`,
  )
} finally {
  process.off('SIGINT', onSigInt)
  if (handle) {
    let result = await provider.teardown({}, handle).catch((error) => ({
      ok: false,
      detail: String(error?.message ?? error),
    }))
    if (!result.ok) {
      for (let attempt = 0; attempt < 2 && !result.ok; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
        result = await provider.teardown({}, handle).catch((error) => ({
          ok: false,
          detail: String(error?.message ?? error),
        }))
      }
    }
    deleted = result.ok === true
    console.log(`[live] teardown group=${handle.groupName} ok=${deleted} detail=${result.detail ?? ''}`)
  }
  const containers = await api.listContainers({ org, project, apiKey }).catch(() => null)
  const cleanupListOk = Boolean(containers)
  const leftovers = (containers?.items ?? [])
    .map((item) => String(item?.name ?? ''))
    .filter((name) => name.startsWith('aigc-studio-'))
  console.log(`[live] leftover aigc-studio-* groups=${leftovers.length}${leftovers.length ? ` (${leftovers.join(', ')})` : ''}`)
  if (!cleanupListOk || leftovers.length > 0) {
    console.error(`[live] 清理未完成。待清理记录保留在 ${workspace}；请用 Salad 控制台或同一 API Key 删除上述容器组`)
  } else {
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
  if (!deleted || !cleanupListOk || leftovers.length > 0) process.exitCode = 1
}
