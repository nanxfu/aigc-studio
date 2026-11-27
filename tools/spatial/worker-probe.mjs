/** Execute the existing inference Worker unchanged, with production tensor preprocessing. */
import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REAL_SCENES } from './fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(root, process.argv[2] || '.tmp/spatial-followup-2026-11-28')
const previous = path.join(root, '.tmp/spatial-e0-e2-2026-11-27')
const { chromium } = createRequire(path.join(root, 'tools/promo/package.json'))('playwright-core')
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Existing inference Worker</title>'); return }
  const base = url.pathname.startsWith('/out/') ? out : url.pathname.startsWith('/previous/') ? previous : root
  const file = path.resolve(base, decodeURIComponent(url.pathname.replace(/^\/(?:out|previous|root)\//, '')))
  if (!file.startsWith(`${base}${path.sep}`) || !existsSync(file)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' })[path.extname(file)] || 'application/octet-stream')
  createReadStream(file).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  const executablePath = [process.env.IMAGEN_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const results = await page.evaluate(async fixtures => {
    const client = await import('/out/client-depth.mjs')
    const worker = new Worker('/root/web/logic/localInference.worker.js', { type: 'module' })
    const pending = new Map()
    let nextId = 1
    worker.onmessage = ({ data }) => {
      if (typeof data.ok !== 'boolean') return
      const request = pending.get(data.reqId)
      if (!request) return
      pending.delete(data.reqId)
      if (data.ok) request.resolve(data)
      else request.reject(new Error(data.error))
    }
    worker.onerror = error => { for (const entry of pending.values()) entry.reject(new Error(error.message)); pending.clear() }
    const run = (modelId, ep, tensor, width, height) => new Promise((resolve, reject) => {
      const reqId = nextId++, copy = new Float32Array(tensor)
      pending.set(reqId, { resolve, reject })
      worker.postMessage({
        reqId, modelId, ep,
        ortUrl: `${location.origin}/root/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs`,
        wasmDir: `${location.origin}/root/node_modules/onnxruntime-web/dist/`,
        modelUrl: modelId === 'da3' ? '/root/.tmp/m4e-da3-small.onnx' : '/previous/zipdepth-384-fp32.onnx',
        headers: {}, inputName: 'image', outputName: 'depth', dims: [1, 3, height, width], tensorBuffer: copy.buffer,
      }, [copy.buffer])
    })
    const rows = []
    try {
      for (const fixture of fixtures) {
        const image = new Image(); image.src = `/root/${fixture.file}`; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        const pixels = { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data }
        for (const modelId of ['da3', 'zip']) {
          const started = performance.now(), width = modelId === 'da3' ? 504 : 384, height = modelId === 'da3' ? 378 : 384
          const rect = client.fitDepthLetterbox(pixels.width, pixels.height, width, height)
          const spec = modelId === 'da3' ? undefined : { input: { mean: [0, 0, 0], std: [1, 1, 1] } }
          const input = client.buildDepthInputTensor(client.resizePixels(pixels, Math.max(width, height)), width, height, spec, rect)
          const prepared = performance.now()
          const result = await run(modelId, modelId === 'da3' ? 'wasm' : 'webgpu', input, width, height)
          const inferenceDone = performance.now()
          const raw = new Float32Array(result.data)
          const cropped = client.cropDepthRaw(raw, width, height, rect)
          const depth = client.normalizeDepthOutput(cropped, rect.contentW, rect.contentH, { outputDepthDirection: modelId === 'da3' ? 'far-large' : 'near-large' })
          const completed = performance.now()
          const renderScale = Math.min(1, 512 / Math.max(pixels.width, pixels.height))
          const aligned = client.resizeDepth(depth, Math.round(pixels.width * renderScale), Math.round(pixels.height * renderScale))
          const reference = new Float32Array(await (await fetch(`/out/references/${fixture.id}-${modelId}-depth.f32`)).arrayBuffer())
          let error = 0
          if (aligned.data.length !== reference.length) throw new Error('Worker depth shape differs')
          for (let i = 0; i < reference.length; i++) error += Math.abs(aligned.data[i] - reference[i])
          rows.push({ id: fixture.id, modelId, prepareMs: prepared - started, workerRoundTripMs: inferenceDone - prepared, postprocessMs: completed - inferenceDone, totalMs: completed - started, directVsWorkerNormalizedMae: error / reference.length, finite: raw.every(Number.isFinite) })
        }
      }
    } finally { worker.terminate() }
    return rows
  }, REAL_SCENES)
  const report = { browser: browser.version(), rows: results, scope: 'Existing Worker unchanged; local pre-cached bytes; excludes network download, image decoding and renderer; first request includes Session creation.' }
  await writeFile(path.join(out, 'worker-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)) }
