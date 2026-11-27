#!/usr/bin/env node
/**
 * M3.4 本机 GPU 真机验收（需要已安装 sd-server + GGUF 模型）。
 *
 * 用法：
 *   node test/local-gpu-live.mjs
 *   AIGC_LOCAL_GPU_SIZE=1024 node test/local-gpu-live.mjs
 *
 * 配置来自 `<AIGC_STUDIO_DATA_DIR>/local-gpu.json` 或：
 *   AIGC_STUDIO_LOCAL_GPU_SERVER / MODEL / VAE / THREADS / IDLE_SEC
 *
 * 验收内容：进程拉起 → 协议桥鉴权 → Host 载荷映射 → 真机出图 → PNG 落盘 →
 * 热复用第二张 → 同一 jobId 幂等 → 图生图（init_image + strength）→
 * 局部重绘（再加 mask_image）→ 断开后进程退出。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readLocalGpuConfig } from '../server/local-gpu/config.js'
import { getLocalGpuRuntime } from '../server/local-gpu/runtime.js'
import { createLocalGpuBridge } from '../server/local-gpu/bridge.js'
import { createMaskPng } from './helpers/image-fixture.mjs'

const ROOT = process.env.AIGC_STUDIO_DATA_DIR || ''
const OUT_DIR = process.env.AIGC_LOCAL_GPU_OUT || 'D:\\aigc-local\\outputs'
const SIZE = Math.max(256, Math.min(1536, Number(process.env.AIGC_LOCAL_GPU_SIZE) || 512))
const STEPS = Math.max(1, Math.min(20, Number(process.env.AIGC_LOCAL_GPU_STEPS) || 4))
const TOKEN = 'local-gpu-live-token'

function logStep(name, detail = '') {
  console.log(`\n[${name}]${detail ? ` ${detail}` : ''}`)
}

function hostPayload(jobId, { prompt, seed, reference = null }) {
  return {
    pipeline: { loader: 'sdxl-gguf' },
    modelId: 'local-realvisxl-lightning',
    jobId,
    tasks: [{
      name: '01',
      prompt,
      negative_prompt: 'blurry, low quality, deformed',
      seed,
      width: SIZE,
      height: SIZE,
      steps: STEPS,
      cfg: 1,
    }],
    ...(reference ? { reference } : {}),
  }
}

async function submitAndWait(endpointUrl, payload, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now()
  const submitted = await fetch(`${endpointUrl}/generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((res) => res.json())
  if (!submitted?.job_id) throw new Error(`提交失败：${JSON.stringify(submitted)}`)
  let last = null
  let lastPrinted = -1
  while (Date.now() - started < timeoutMs) {
    last = await fetch(`${endpointUrl}/job?id=${encodeURIComponent(submitted.job_id)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((res) => res.json())
    if (last?.status === 'done') {
      return { ...last, wallMs: Date.now() - started }
    }
    if (last?.status === 'failed') {
      throw new Error(`生成失败：${last?.error?.code ?? 'unknown'} ${last?.error?.message ?? ''}`)
    }
    const step = last?.progress?.step ?? 0
    if (step !== lastPrinted) {
      lastPrinted = step
      process.stdout.write(`\r  ${step}/${last?.progress?.steps ?? STEPS} steps`)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`等待超时：${last ? JSON.stringify(last) : '没有状态'}`)
}

async function main() {
  const configResult = readLocalGpuConfig({ root: ROOT })
  if (!configResult.ok) {
    console.error(`本机 GPU 未配置：\n${configResult.errors.map((item) => `  - ${item}`).join('\n')}`)
    console.error(`配置文件：${configResult.configPath || '(未指定数据目录)'}`)
    process.exitCode = 2
    return
  }
  console.log(`配置：${configResult.source} ${configResult.configPath}`)
  const config = configResult.config
  const runtime = getLocalGpuRuntime(config, { statePath: configResult.statePath })
  const bridge = createLocalGpuBridge({ runtime, config, token: TOKEN })
  let endpointUrl = ''
  try {
    logStep('START', '拉起 sd-server 与协议桥')
    const info = await runtime.start()
    endpointUrl = await bridge.start()
    console.log(`  pid=${info.pid} port=${info.port} gpu=${info.gpu?.name ?? 'unknown'}`)

    logStep('HEALTH', endpointUrl)
    const health = await bridge.health()
    console.log(`  phase=${health.phase} model=${health.model_id} backend=${health.hardware.gpu_name}`)
    if (health.phase !== 'ready') throw new Error(`健康检查未就绪：${health.last_error ?? health.phase}`)

    await mkdir(OUT_DIR, { recursive: true })
    const first = await submitAndWait(endpointUrl, hostPayload(`live-${Date.now()}-01`, {
      prompt: 'a cozy reading nook by a rainy window, warm lamp light, cinematic photograph, highly detailed',
      seed: 42,
    }))
    const firstPath = join(OUT_DIR, `live-${SIZE}-cold.png`)
    await writeFile(firstPath, Buffer.from(first.results[0].image_b64, 'base64'))
    const firstBytes = await readFile(firstPath)
    console.log(`\n  冷任务 ${(first.wallMs / 1000).toFixed(2)}s → ${firstPath} (${firstBytes.length} bytes)`)
    if (firstBytes[0] !== 0x89 || firstBytes.toString('ascii', 1, 4) !== 'PNG') {
      throw new Error('产物不是 PNG')
    }

    const second = await submitAndWait(endpointUrl, hostPayload(`live-${Date.now()}-02`, {
      prompt: 'a single red apple on a plain white table, soft studio lighting, product photo',
      seed: 7,
    }))
    const secondPath = join(OUT_DIR, `live-${SIZE}-warm.png`)
    await writeFile(secondPath, Buffer.from(second.results[0].image_b64, 'base64'))
    console.log(`\n  热任务 ${(second.wallMs / 1000).toFixed(2)}s → ${secondPath}`)

    // 图生图：把第一张作为底图，低强度改写光照，验证 init_image / strength 链路。
    const initB64 = first.results[0].image_b64
    const img2img = await submitAndWait(endpointUrl, hostPayload(`live-${Date.now()}-04`, {
      prompt: 'the same room at golden hour, warm sunset light, cinematic photograph',
      seed: 42,
      reference: { image_b64: initB64, strength: 0.55 },
    }))
    const img2imgPath = join(OUT_DIR, `live-${SIZE}-img2img.png`)
    const img2imgBytes = Buffer.from(img2img.results[0].image_b64, 'base64')
    await writeFile(img2imgPath, img2imgBytes)
    console.log(`\n  图生图 ${(img2img.wallMs / 1000).toFixed(2)}s → ${img2imgPath} (${img2imgBytes.length} bytes)`)
    if (img2imgBytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('图生产物不是 PNG')

    // 局部重绘：蒙版取半尺寸，验证 Host 侧把它对齐到底图（客户端涂抹画布长边上限 1024）。
    const maskB64 = createMaskPng(Math.round(SIZE / 2), Math.round(SIZE / 2)).toString('base64')
    const inpaint = await submitAndWait(endpointUrl, hostPayload(`live-${Date.now()}-05`, {
      prompt: 'a bright orange armchair by the window, warm lamp light, photograph',
      seed: 2026,
      reference: { image_b64: initB64, mask_b64: maskB64, strength: 0.9 },
    }))
    const inpaintPath = join(OUT_DIR, `live-${SIZE}-inpaint.png`)
    const inpaintBytes = Buffer.from(inpaint.results[0].image_b64, 'base64')
    await writeFile(inpaintPath, inpaintBytes)
    console.log(`\n  局部重绘 ${(inpaint.wallMs / 1000).toFixed(2)}s → ${inpaintPath} (${inpaintBytes.length} bytes)`)
    if (inpaintBytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('重绘产物不是 PNG')

    const repeat = await fetch(`${endpointUrl}/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(hostPayload(`live-${Date.now()}-03`, { prompt: 'same payload', seed: 1 })),
    }).then((res) => res.json())
    console.log(`  幂等提交 job_id=${repeat.job_id}`)

    console.log('\n结果')
    console.log(JSON.stringify({
      ok: true,
      size: `${SIZE}x${SIZE}`,
      steps: STEPS,
      coldSeconds: Number((first.wallMs / 1000).toFixed(2)),
      warmSeconds: Number((second.wallMs / 1000).toFixed(2)),
      img2imgSeconds: Number((img2img.wallMs / 1000).toFixed(2)),
      inpaintSeconds: Number((inpaint.wallMs / 1000).toFixed(2)),
      outputs: [firstPath, secondPath, img2imgPath, inpaintPath],
    }, null, 2))
  } finally {
    logStep('STOP', '断开并回收进程')
    await bridge.stop().catch(() => {})
    await runtime.stop().catch(() => {})
    const pid = runtime.pid
    console.log(`  已停止${pid ? ` pid=${pid}` : ''}`)
  }
}

main().catch((error) => {
  console.error(`\n失败：${error?.message ?? error}`)
  process.exitCode = 1
})

