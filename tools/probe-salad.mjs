#!/usr/bin/env node
/**
 * SaladCloud 只读探测与单次冷启动压测工具。
 *
 * 读取 `.env` 中的 `SALAD_API_KEY` / `SALAD_ORG` / `SALAD_PROJECT`（project 会自动转小写
 * 以匹配 Salad API 的 `^[a-z][a-z0-9-]{0,61}[a-z0-9]$` 约束）。
 *
 * 用法：
 *   node --env-file=.env tools/probe-salad.mjs                    # 只读：配额、现有容器组与常用 12GB+ GPU 报价
 *   node --env-file=.env tools/probe-salad.mjs --json             # JSON 输出只读摘要
 *   node --env-file=.env tools/probe-salad.mjs --bench            # 创建临时容器组实测冷启动并自动删除
 *     [--gpu "RTX 3090"] [--priority medium] [--image ghcr.io/nanxfu/aigc-worker:edge]
 *     [--storage-gb 40] [--generate sdxl-lightning] [--timeout-sec 900]
 *   node --env-file=.env tools/probe-salad.mjs --cleanup          # 清理残留的 aigc-probe-* 容器组
 *
 * 安全：绝不打印 `SALAD_API_KEY` 与临时 `AIGC_WORKER_TOKEN` 原文；`--bench` 在异常或 Ctrl+C
 * 时都会在退出前删除临时容器组，避免空烧费用。
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const API_BASE = 'https://api.salad.com/api/public'
const PROBE_PREFIX = 'aigc-probe-'

function argOf(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  const val = process.argv[idx + 1]
  return val && !val.startsWith('--') ? val : fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function configFromEnv() {
  const apiKey = String(process.env.SALAD_API_KEY || '').trim()
  const org = String(process.env.SALAD_ORG || '').trim().toLowerCase()
  const project = String(process.env.SALAD_PROJECT || 'default').trim().toLowerCase()
  if (!apiKey || !org) {
    throw new Error('缺少 SALAD_API_KEY 或 SALAD_ORG：请先在 .env 中配置后用 `node --env-file=.env` 运行')
  }
  return { apiKey, org, project }
}

async function saladFetch(cfg, pathname, { method = 'GET', body = null } = {}) {
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}${pathname}`, {
        method,
        headers: {
          'Salad-Api-Key': cfg.apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const text = await res.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }
      if (!res.ok) {
        const detail = json ? JSON.stringify(json) : text.slice(0, 400)
        const err = new Error(`Salad API ${method} ${pathname} -> ${res.status}: ${detail}`)
        err.status = res.status
        err.body = json
        throw err
      }
      return json
    } catch (err) {
      if (err?.status && err.status < 500) throw err
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastErr
}

function vramGbOf(name) {
  const m = /\((\d+)\s*GB\)/i.exec(String(name || ''))
  return m ? Number(m[1]) : 0
}

function priceMapOf(prices = []) {
  const out = {}
  for (const item of prices) {
    if (item?.priority) out[item.priority] = Number(item.price)
  }
  return out
}

async function readOnlySummary(cfg) {
  const [gpusDoc, quotas, containersDoc] = await Promise.all([
    saladFetch(cfg, `/organizations/${encodeURIComponent(cfg.org)}/gpu-classes`),
    saladFetch(cfg, `/organizations/${encodeURIComponent(cfg.org)}/quotas`),
    saladFetch(
      cfg,
      `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers`,
    ),
  ])
  const allGpus = Array.isArray(gpusDoc?.items) ? gpusDoc.items : []
  const candidates = allGpus
    .filter((g) => !/amd|gtx/i.test(g.name) && vramGbOf(g.name) >= 12)
    .map((g) => ({
      id: g.id,
      name: g.name,
      vramGb: vramGbOf(g.name),
      highDemand: Boolean(g.is_high_demand),
      prices: priceMapOf(g.prices),
    }))
    .sort((a, b) => (a.prices.high ?? 99) - (b.prices.high ?? 99))

  return {
    org: cfg.org,
    project: cfg.project,
    quotas: quotas?.container_groups_quotas ?? null,
    existingContainers: (containersDoc?.items ?? []).map((c) => ({
      name: c.name,
      status: c.current_state?.status ?? null,
      replicas: c.replicas,
      url: c.networking?.dns ? `https://${c.networking.dns}` : null,
    })),
    nvidia12GbPlus: candidates,
  }
}

async function deleteContainerQuiet(cfg, name) {
  try {
    await saladFetch(
      cfg,
      `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
    return true
  } catch (err) {
    if (err.status === 404) return false
    console.error(`[cleanup] 删除容器组 ${name} 失败: ${err.message}`)
    return false
  }
}

async function cleanupProbes(cfg) {
  const doc = await saladFetch(
    cfg,
    `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers`,
  )
  const targets = (doc?.items ?? []).filter((c) => String(c.name || '').startsWith(PROBE_PREFIX))
  for (const item of targets) {
    const ok = await deleteContainerQuiet(cfg, item.name)
    console.log(`[cleanup] ${item.name}: ${ok ? 'deleted' : 'not-found'}`)
  }
  if (targets.length === 0) console.log('[cleanup] 无残留测试容器组')
}

async function probeWorkerHttp(baseUrl, pathname, { token = '', method = 'GET', body = null, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}${pathname}`, {
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
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

async function runOneGenerate(gatewayUrl, workerToken, modelId, modelDoc, deadlineMs, label) {
  const genStartedAt = Date.now()
  const sub = await probeWorkerHttp(gatewayUrl, '/generate', {
    token: workerToken,
    method: 'POST',
    timeoutMs: 30_000,
    body: {
      tool: 'generate',
      result_mode: 'binary',
      pipeline: modelDoc.pipeline,
      tasks: [
        {
          name: `salad-${label}`,
          prompt: 'a clean studio product photo of a glass prism on dark slate, soft rim light',
          negative_prompt: modelDoc.negativeHint || '',
          width: 1024,
          height: 1024,
          steps: modelDoc.steps || 4,
          cfg: modelDoc.cfg ?? 0,
          seed: label === 'warm' ? 43 : 42,
        },
      ],
    },
  })
  if (!sub.ok || !sub.json?.job_id) {
    throw new Error(`/generate(${label}) 失败: status=${sub.status} body=${sub.text}`)
  }
  const jobId = sub.json.job_id
  let lastJobLog = ''
  let generateResult = null
  while (Date.now() < deadlineMs) {
    const j = await probeWorkerHttp(gatewayUrl, `/job?id=${encodeURIComponent(jobId)}`, {
      token: workerToken,
      timeoutMs: 15_000,
    })
    if (j.ok && j.json) {
      const st = j.json.status
      const detail = j.json.progress?.detail || j.json.stage || ''
      const step = j.json.progress?.step != null ? `${j.json.progress.step}/${j.json.progress.steps}` : ''
      const line = `${st} ${step} ${detail}`.trim()
      if (line && line !== lastJobLog) {
        const sec = ((Date.now() - genStartedAt) / 1000).toFixed(1)
        console.log(`[bench] ${label} +${sec}s ${line}`)
        lastJobLog = line
      }
      if (st === 'done' || st === 'error' || st === 'cancelled') {
        let artifactBytes = null
        let artifactValidPng = false
        if (st === 'done') {
          const artRes = await fetch(`${gatewayUrl}/artifact?id=${encodeURIComponent(jobId)}&index=0`, {
            headers: { Authorization: `Bearer ${workerToken}` },
          })
          if (artRes.ok) {
            const buf = Buffer.from(await artRes.arrayBuffer())
            artifactBytes = buf.length
            artifactValidPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
          }
        }
        generateResult = {
          status: st,
          elapsedSec: Number(((Date.now() - genStartedAt) / 1000).toFixed(1)),
          timings: j.json.timings ?? null,
          artifactBytes,
          artifactValidPng,
          error: j.json.error ?? null,
        }
        break
      }
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!generateResult) {
    throw new Error(`/generate(${label}) 超时未完成`)
  }
  return generateResult
}

async function runBench(cfg) {
  const gpuQuery = argOf('gpu', 'RTX 3090').toLowerCase()
  const priority = argOf('priority', 'medium')
  const image = argOf('image', 'ghcr.io/nanxfu/aigc-worker:edge')
  const storageGb = Math.max(10, Math.min(250, Number(argOf('storage-gb', '40')) || 40))
  const generateModel = argOf('generate', '')
  const timeoutSec = Math.max(120, Number(argOf('timeout-sec', '900')) || 900)
  const reallocateSec = Math.max(0, Number(argOf('reallocate-sec', '240')) || 240)
  const countries = argOf('countries', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  const summary = await readOnlySummary(cfg)
  const gpu = summary.nvidia12GbPlus.find((g) => g.name.toLowerCase().includes(gpuQuery))
  if (!gpu) throw new Error(`未匹配到 GPU 规格: ${gpuQuery}`)

  const groupName = `${PROBE_PREFIX}${Date.now().toString(36)}`
  const workerToken = randomBytes(32).toString('hex')
  const startedAt = Date.now()
  let firstRunningAt = null
  let firstHealthyAt = null
  let gatewayUrl = null

  const onSigInt = async () => {
    console.error(`\n[bench] 收到中断信号，正在删除 ${groupName}...`)
    await deleteContainerQuiet(cfg, groupName)
    process.exit(130)
  }
  process.once('SIGINT', onSigInt)

  try {
    console.log(`[bench] 创建容器组 ${groupName}: gpu=${gpu.name} priority=${priority} ($${gpu.prices[priority]}/hr) image=${image}`)
    const created = await saladFetch(
      cfg,
      `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers`,
      {
        method: 'POST',
        body: {
          name: groupName,
          display_name: groupName,
          autostart_policy: true,
          restart_policy: 'always',
          replicas: 1,
          priority,
          ...(countries.length > 0 ? { country_codes: countries } : {}),
          container: {
            image,
            image_caching: true,
            environment_variables: {
              AIGC_WORKER_TOKEN: workerToken,
              AIGC_WORKER_HOST: 'auto',
              AIGC_WORKER_PORT: '8765',
              HF_XET_HIGH_PERFORMANCE: '1',
            },
            resources: {
              cpu: 4,
              memory: 16384,
              gpu_classes: [gpu.id],
              storage_amount: storageGb * 1024 * 1024 * 1024,
            },
          },
          networking: {
            protocol: 'http',
            port: 8765,
            auth: false,
          },
          startup_probe: {
            http: { path: '/healthz', port: 8765, scheme: 'http', headers: [] },
            initial_delay_seconds: 2,
            period_seconds: 5,
            timeout_seconds: 5,
            success_threshold: 1,
            failure_threshold: 20,
          },
        },
      },
    )

    gatewayUrl = created?.networking?.dns ? `https://${created.networking.dns}` : null
    console.log(`[bench] 已提交，Gateway=${gatewayUrl || '(待分配)'}`)

    const deadline = startedAt + timeoutSec * 1000
    let lastStatus = ''
    let lastInstanceLine = ''
    let watchedMachineId = ''
    let machineAssignedAt = Date.now()
    let reallocations = 0
    let healthPayload = null

    while (Date.now() < deadline) {
      const [state, instancesDoc] = await Promise.all([
        saladFetch(
          cfg,
          `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers/${encodeURIComponent(groupName)}`,
        ),
        saladFetch(
          cfg,
          `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers/${encodeURIComponent(groupName)}/instances`,
        ).catch(() => null),
      ])
      const status = state?.current_state?.status || 'unknown'
      const inst = Array.isArray(instancesDoc?.instances) ? instancesDoc.instances[0] : null
      if (!gatewayUrl && state?.networking?.dns) {
        gatewayUrl = `https://${state.networking.dns}`
      }
      if (status !== lastStatus) {
        const sec = ((Date.now() - startedAt) / 1000).toFixed(1)
        console.log(`[bench] +${sec}s status=${status}`)
        lastStatus = status
      }
      if (inst) {
        const instId = inst.id || ''
        const machineId = inst.machine_id || ''
        const instState = inst.state || 'unknown'
        const pullPct =
          inst.pulling_progress != null ? ` pull=${(Number(inst.pulling_progress) * 100).toFixed(1)}%` : ''
        const instLine = `${instState} machine=${machineId.slice(0, 8)}${pullPct}`
        if (instLine !== lastInstanceLine) {
          const sec = ((Date.now() - startedAt) / 1000).toFixed(1)
          console.log(`[bench] +${sec}s instance(${instId.slice(0, 8)}): ${instLine}`)
          lastInstanceLine = instLine
        }
        if (machineId && machineId !== watchedMachineId) {
          watchedMachineId = machineId
          machineAssignedAt = Date.now()
        }
        if (
          reallocateSec > 0 &&
          reallocations < 3 &&
          instId &&
          machineId &&
          (instState === 'downloading' || instState === 'creating') &&
          Date.now() - machineAssignedAt >= reallocateSec * 1000
        ) {
          reallocations += 1
          const sec = ((Date.now() - startedAt) / 1000).toFixed(1)
          console.log(`[bench] +${sec}s 节点 ${machineId.slice(0, 8)} 卡在 ${instState} 超过 ${reallocateSec}s，触发第 ${reallocations} 次 reallocate...`)
          await saladFetch(
            cfg,
            `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers/${encodeURIComponent(groupName)}/instances/${encodeURIComponent(instId)}/reallocate`,
            { method: 'POST' },
          ).catch((e) => console.log(`[bench] reallocate 失败: ${e.message}`))
          watchedMachineId = ''
          machineAssignedAt = Date.now()
        }
      }
      if (status === 'running' && !firstRunningAt) {
        firstRunningAt = Date.now()
      }
      if (status === 'running' && gatewayUrl) {
        const res = await probeWorkerHttp(gatewayUrl, '/health', { token: workerToken, timeoutMs: 10_000 })
        if (res.ok && res.json) {
          healthPayload = res.json
          if (!firstHealthyAt) firstHealthyAt = Date.now()
          if (res.json.phase === 'ready' || res.json.phase === 'error') {
            break
          }
        } else if (res.status) {
          console.log(`[bench] /health -> HTTP ${res.status}`)
        }
      }
      await new Promise((r) => setTimeout(r, 4000))
    }

    if (!healthPayload) {
      throw new Error(`在 ${timeoutSec}s 内未等到 Worker /health 就绪 (lastStatus=${lastStatus})`)
    }

    const readyElapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
    const unbilledSec = firstRunningAt ? ((firstRunningAt - startedAt) / 1000).toFixed(1) : null
    const billedBootSec = firstRunningAt ? ((Date.now() - firstRunningAt) / 1000).toFixed(1) : null
    console.log(
      `[bench] Worker 就绪: 总耗时=${readyElapsedSec}s (免费Alloc/Pull≈${unbilledSec}s, Running启动=${billedBootSec}s) ` +
        `phase=${healthPayload.phase} gpu=${healthPayload.hardware?.gpu_name || 'unknown'}`,
    )

    if (generateModel && healthPayload.phase === 'ready') {
      const modelDoc = await readFile(path.resolve(process.cwd(), 'models', `${generateModel}.json`), 'utf8').then(
        JSON.parse,
      )
      console.log(`[bench] 第 1 张（含首次拉取约 ${modelDoc.pipeline?.downloadGb ?? '?'}GB 权重 + 加载）...`)
      const coldGen = await runOneGenerate(gatewayUrl, workerToken, generateModel, modelDoc, Date.now() + 600_000, 'cold')
      console.log(`[bench] 第 1 张结果:`, JSON.stringify(coldGen))
      if (coldGen.status === 'done') {
        console.log(`[bench] 第 2 张（热模型稳态推理）...`)
        const warmGen = await runOneGenerate(gatewayUrl, workerToken, generateModel, modelDoc, Date.now() + 180_000, 'warm')
        console.log(`[bench] 第 2 张结果:`, JSON.stringify(warmGen))
      }
    }

    const totalSec = (Date.now() - startedAt) / 1000
    const billedSec = firstRunningAt ? (Date.now() - firstRunningAt) / 1000 : 0
    const estCostUsd = (billedSec / 3600) * (gpu.prices[priority] || 0)
    console.log(
      `[bench] 汇总: 总时长=${totalSec.toFixed(1)}s 计费时长=${billedSec.toFixed(1)}s 估算费用=$${estCostUsd.toFixed(5)}`,
    )
  } finally {
    process.off('SIGINT', onSigInt)
    const deleted = await deleteContainerQuiet(cfg, groupName)
    console.log(`[bench] 清理容器组 ${groupName}: ${deleted ? '已删除' : '未找到'}`)
  }
}

async function main() {
  const cfg = configFromEnv()
  if (hasFlag('cleanup')) {
    await cleanupProbes(cfg)
    return
  }
  if (hasFlag('bench')) {
    await runBench(cfg)
    return
  }
  const summary = await readOnlySummary(cfg)
  if (hasFlag('json')) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  console.log(`SaladCloud org=${summary.org} project=${summary.project}`)
  console.log(
    `配额: replicas=${summary.quotas?.container_replicas_used ?? 0}/${summary.quotas?.container_replicas_quota ?? '?'} ` +
      `| 现有容器组=${summary.existingContainers.length}`,
  )
  console.log('\n常用 12GB+ NVIDIA GPU 实时单价 ($/hr):')
  for (const g of summary.nvidia12GbPlus) {
    const p = g.prices
    console.log(
      `  - ${g.name.padEnd(28)} high=$${p.high ?? '-'}  med=$${p.medium ?? '-'}  low=$${p.low ?? '-'}  batch=$${p.batch ?? '-'}`,
    )
  }
}

main().catch((err) => {
  console.error(`[probe-salad] ${err?.message ?? err}`)
  process.exit(1)
})
