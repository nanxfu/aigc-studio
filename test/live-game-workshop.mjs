#!/usr/bin/env node
/**
 * 端到端真机闭环验收：真实 Host (server/standalone.js) → 真实 Kaggle 2×T4 GPU：
 *  1. 基础 3D 质感资产出图（`flux2-klein-4b` 原生，作为参考源图与 PBR 输入图）
 *  2. 游戏 LoRA 风格 1（文生图）：`pixel-art` (adirik/pixel-art-lora-flux.2-klein-4B, PXART4)
 *  3. 游戏 LoRA 风格 2（文生图）：`old-gods` (Norod78/flux2-klein-4b-lora-old-gods, old-gods)
 *  4. 游戏 LoRA 风格 3（参考图转 2×2 视图）：`spritesheet-2x2` (fal/flux-2-klein-4b-spritesheet-lora)
 *  5. 工坊 GPU PBR 算子：以第 1 步高清盾牌通过 `POST /api/workshop/op` 提交 `pbr` (marigold, 4 steps)
 *
 * 产物保存在 `bench-results/game-workshop/<timestamp>/`。
 *
 * 运行：node test/live-game-workshop.mjs
 */

import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startStandalone } from '../server/standalone.js'
import { WORKSHOP } from '../shared/contract.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_BASE = join(ROOT, 'bench-results', 'game-workshop')

function timestampDir() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

async function api(origin, token, path, { method = 'GET', body = null } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  }
  if (body !== null) headers['content-type'] = 'application/json'
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitSessionReady(origin, token, timeoutMs = 45 * 60 * 1000, { maxQueueMs = 4 * 60 * 1000, maxReplace = 3 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastTag = ''
  let queueSince = Date.now()
  let replaceCount = 0
  while (Date.now() < deadline) {
    const res = await api(origin, token, '/api/state')
    assert.equal(res.status, 200, `GET /api/state failed: ${JSON.stringify(res.body)}`)
    const session = res.body?.session || {}
    const tag = `${session.state}/${session.phase || '-'} ${session.kernelStatus || ''} ${session.detail || ''}`.trim()
    if (tag !== lastTag) {
      lastTag = tag
      console.log(`  [session] ${tag}`)
    }
    if (session.state === 'ready') return session
    if (session.state === 'error' || session.state === 'absent') {
      throw new Error(`会话异常结束：${JSON.stringify(session)}`)
    }
    if (session.state === 'provisioning' && session.phase === 'queue') {
      if (Date.now() - queueSince >= maxQueueMs && replaceCount < maxReplace) {
        replaceCount += 1
        console.log(`  [session] 排队超过 ${Math.round(maxQueueMs / 60000)} 分钟，换新实例重排（第 ${replaceCount}/${maxReplace} 次）…`)
        const replaced = await api(origin, token, '/api/session/start', {
          method: 'POST',
          body: { presetId: 'flux2-klein-4b', replace: true },
        })
        assert.equal(replaced.status, 200, `重排失败：${JSON.stringify(replaced.body)}`)
        queueSince = Date.now()
        lastTag = ''
      }
    } else {
      queueSince = Date.now()
    }
    await sleep(3000)
  }
  throw new Error('等待 Kaggle GPU 会话就绪超时')
}

async function waitJobDone(origin, token, jobId, label, timeoutMs = 25 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  let lastTag = ''
  while (Date.now() < deadline) {
    const res = await api(origin, token, `/api/job?id=${encodeURIComponent(jobId)}`)
    assert.equal(res.status, 200, `GET /api/job failed: ${JSON.stringify(res.body)}`)
    const job = res.body?.job || res.body
    const tag = `${job.status} ${job.stage || ''} ${job.progress?.step ? `${job.progress.step}/${job.progress.steps}` : ''}`.trim()
    if (tag !== lastTag) {
      lastTag = tag
      console.log(`  [${label}] ${tag}`)
    }
    if (job.status === 'done') return job
    if (job.status === 'failed' || job.status === 'canceled') {
      throw new Error(`${label} 失败：${JSON.stringify(job.error || job)}`)
    }
    await sleep(2500)
  }
  throw new Error(`${label} 等待完成超时`)
}

async function runGenerateAndSave(host, workspaceDir, outDir, { label, body, outFile }) {
  const res = await api(host.origin, host.token, '/api/generate', { method: 'POST', body })
  assert.equal(res.status, 200, `${label} 提交失败：${JSON.stringify(res.body)}`)
  const jobId = res.body?.job?.id || res.body?.id
  const job = await waitJobDone(host.origin, host.token, jobId, label)
  const rel = job.output?.images?.[0]?.path
  assert.ok(rel, `${label} 缺少输出图片：${JSON.stringify(job)}`)
  const abs = join(workspaceDir, rel)
  const st = await stat(abs)
  const meta = JSON.parse(await readFile(join(dirname(abs), 'meta.json'), 'utf8'))
  await copyFile(abs, join(outDir, outFile))
  console.log(`  ✓ ${label} 完成：${job.seconds}s, ${st.size} bytes`)
  return { jobId, seconds: job.seconds, path: rel, bytes: st.size, meta }
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'aigc-live-game-workshop-'))
  const dataDir = join(tempRoot, 'data')
  const workspaceDir = join(tempRoot, 'workspace')
  await mkdir(dataDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(join(workspaceDir, 'outputs'), { recursive: true })

  const outDir = join(OUT_BASE, timestampDir())
  await mkdir(outDir, { recursive: true })

  let host = null
  let sessionStarted = false
  const report = {
    startedAt: new Date().toISOString(),
    outDir,
    session: null,
    baseShield: null,
    pixelArt: null,
    oldGods: null,
    spritesheet: null,
    pbr: null,
    error: null,
  }

  try {
    console.log('[1/6] 启动真实 Host 服务 (server/standalone.js)...')
    host = await startStandalone({
      ...process.env,
      AIGC_STUDIO_PORT: '0',
      AIGC_STUDIO_DATA_DIR: dataDir,
      AIGC_STUDIO_WORKSPACE: workspaceDir,
      AIGC_STUDIO_TELEMETRY_DISABLED: '1',
    })
    console.log(`  Host 就绪：${host.origin}`)

    const hfToken = typeof process.env.HF_TOKEN === 'string' ? process.env.HF_TOKEN.trim() : ''
    const setRes = await api(host.origin, host.token, '/api/settings', {
      method: 'POST',
      body: {
        provider: 'kaggle',
        accelerator: 'NvidiaTeslaT4',
        kaggleTransport: 'direct',
        idleTimeoutSec: 900,
        ...(hfToken ? { hfToken } : {}),
      },
    })
    assert.equal(setRes.status, 200, `设置保存失败：${JSON.stringify(setRes.body)}`)
    console.log(`  设置已写入（HF_TOKEN=${hfToken ? 'configured' : 'missing'}）`)

    console.log('[2/6] 启动 Kaggle GPU 会话（预热 flux2-klein-4b）...')
    const startRes = await api(host.origin, host.token, '/api/session/start', {
      method: 'POST',
      body: { presetId: 'flux2-klein-4b' },
    })
    assert.equal(startRes.status, 200, `启动会话失败：${JSON.stringify(startRes.body)}`)
    sessionStarted = true
    const readySession = await waitSessionReady(host.origin, host.token)
    report.session = {
      device: readySession.device || null,
      deviceCount: readySession.deviceCount || null,
      kernelId: readySession.kernelId || null,
    }
    console.log(`  GPU 就绪：${report.session.device} x${report.session.deviceCount} (${report.session.kernelId})`)

    console.log('[3/6] 生成 3D 质感骑士盾牌（用于 PBR 拆解 + 2×2 多视角输入）...')
    const baseRun = await runGenerateAndSave(host, workspaceDir, outDir, {
      label: 'base-shield',
      outFile: '01-base-shield.png',
      body: {
        presetId: 'flux2-klein-4b',
        prompt: 'A stylized 3D medieval knight heater shield made of brushed dark steel rim, weathered oak wood center, and raised golden lion emblem, isolated on clean plain neutral gray studio background, sharp metallic bevels and rivets, front view',
        width: 768,
        height: 768,
        steps: 4,
        cfg: 1,
        seed: 42,
        count: 1,
      },
    })
    report.baseShield = { jobId: baseRun.jobId, seconds: baseRun.seconds, path: baseRun.path, bytes: baseRun.bytes }

    console.log('[4/6] 实测 LoRA 风格 1：pixel-art (adirik/pixel-art-lora-flux.2-klein-4B, PXART4)...')
    const pixelRun = await runGenerateAndSave(host, workspaceDir, outDir, {
      label: 'pixel-art',
      outFile: '02-lora-pixel-art-shield.png',
      body: {
        presetId: 'flux2-klein-4b',
        prompt: 'A medieval knight shield with a golden lion emblem on a clean light gray background, crisp game item icon',
        lora: { id: 'pixel-art', scale: 0.9 },
        width: 768,
        height: 768,
        steps: 4,
        cfg: 1,
        seed: 42,
        count: 1,
      },
    })
    assert.equal(pixelRun.meta.params?.lora?.id, 'pixel-art')
    report.pixelArt = { jobId: pixelRun.jobId, seconds: pixelRun.seconds, path: pixelRun.path, bytes: pixelRun.bytes, lora: pixelRun.meta.params.lora }

    console.log('[5/6] 实测 LoRA 风格 2 & 3：old-gods 与 spritesheet-2x2（带参考图）...')
    const oldGodsRun = await runGenerateAndSave(host, workspaceDir, outDir, {
      label: 'old-gods',
      outFile: '03-lora-old-gods-shield.png',
      body: {
        presetId: 'flux2-klein-4b',
        prompt: 'An ornate dark fantasy knight shield with carved glowing runes on a clean stone pedestal',
        lora: { id: 'old-gods', scale: 0.8 },
        width: 768,
        height: 768,
        steps: 4,
        cfg: 1,
        seed: 7,
        count: 1,
      },
    })
    assert.equal(oldGodsRun.meta.params?.lora?.id, 'old-gods')
    report.oldGods = { jobId: oldGodsRun.jobId, seconds: oldGodsRun.seconds, path: oldGodsRun.path, bytes: oldGodsRun.bytes, lora: oldGodsRun.meta.params.lora }

    const sheetRun = await runGenerateAndSave(host, workspaceDir, outDir, {
      label: 'spritesheet-2x2',
      outFile: '04-lora-spritesheet-2x2.png',
      body: {
        presetId: 'flux2-klein-4b',
        prompt: 'medieval knight shield',
        references: [baseRun.path],
        lora: { id: 'spritesheet-2x2', scale: 1.1 },
        width: 768,
        height: 768,
        steps: 4,
        cfg: 1,
        seed: 7,
        count: 1,
      },
    })
    assert.equal(sheetRun.meta.params?.lora?.id, 'spritesheet-2x2')
    report.spritesheet = { jobId: sheetRun.jobId, seconds: sheetRun.seconds, path: sheetRun.path, bytes: sheetRun.bytes, lora: sheetRun.meta.params.lora }

    const runPbrAndSave = async (model, filePrefix, options = {}) => {
      const pbrSubmit = await api(host.origin, host.token, '/api/workshop/op', {
        method: 'POST',
        body: {
          op: WORKSHOP.pbr.op,
          path: baseRun.path,
          model,
          execution: 'cloud',
          ...(Object.keys(options).length > 0 ? { options } : {}),
        },
      })
      assert.equal(pbrSubmit.status, 200, `${model} PBR 提交失败：${JSON.stringify(pbrSubmit.body)}`)
      const pbrJobId = pbrSubmit.body?.jobId
      const pbrJob = await waitJobDone(host.origin, host.token, pbrJobId, `pbr-${model}`)
      const pbrDir = join(workspaceDir, pbrJob.output?.dir)
      const pbrMeta = JSON.parse(await readFile(join(pbrDir, 'meta.json'), 'utf8'))
      assert.equal(pbrMeta.workshop, true)
      assert.equal(pbrMeta.workshopTool, 'pbr')
      assert.equal(pbrMeta.channels.length, 4)
      const channelStats = []
      for (const ch of pbrMeta.channels) {
        const chAbs = join(pbrDir, ch.file)
        const st = await stat(chAbs)
        assert.ok(st.size > 1000, `${model} PBR 通道 ${ch.role} 文件过小：${st.size}`)
        await copyFile(chAbs, join(outDir, `${filePrefix}-${ch.file}`))
        channelStats.push({ role: ch.role, file: ch.file, bytes: st.size, width: ch.width, height: ch.height })
      }
      return {
        jobId: pbrJobId,
        seconds: pbrJob.seconds,
        model: pbrMeta.modelId,
        channels: channelStats,
      }
    }

    console.log('[6/7] 实测工坊 GPU PBR 算子：Marigold (4 steps)...')
    report.pbr = await runPbrAndSave('marigold', '05-pbr-marigold', { steps: 4 })
    console.log(`  ✓ Marigold PBR 完成：${report.pbr.seconds}s, 4 通道全部落盘`)

    console.log('[7/7] 实测工坊 GPU PBR 算子：Ubisoft CHORD（同源骑士盾牌对比）...')
    report.chord = await runPbrAndSave('chord', '06-pbr-chord')
    console.log(`  ✓ Ubisoft CHORD PBR 完成：${report.chord.seconds}s, 4 通道全部落盘`)
  } catch (error) {
    report.error = String(error?.stack || error)
    throw error
  } finally {
    if (host && sessionStarted) {
      console.log('正在关闭 Kaggle GPU 会话…')
      await api(host.origin, host.token, '/api/session/stop', { method: 'POST', body: {} }).catch(() => {})
    }
    if (host) {
      await host.shutdown('live-test-complete').catch(() => {})
    }
    report.finishedAt = new Date().toISOString()
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8').catch(() => {})
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((err) => {
  console.error('真机验收失败：', err)
  process.exitCode = 1
})
