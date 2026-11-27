/** Follow-up: native client preprocessing and second LDI reference, preserving the first report. */
import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { REAL_SCENES, SYNTHETIC_SCENES, DIRECTIONS } from './fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const previous = path.join(root, '.tmp/spatial-e0-e2-2026-11-27')
const out = path.resolve(root, process.argv[2] || '.tmp/spatial-followup-2026-11-28')
await mkdir(path.join(out, 'renders'), { recursive: true })
await mkdir(path.join(out, 'references'), { recursive: true })
// esbuild resolves the client's React/runtime imports without changing the application.
await build({ stdin: { contents: "export * from './web/logic/localDepth.js'; export * from './web/logic/depthFx.js'", resolveDir: root }, bundle: true, format: 'esm', platform: 'browser', outfile: path.join(out, 'client-depth.mjs'), logLevel: 'silent' })
await copyFile(path.join(root, 'tools/spatial/adaptive-ldi.mjs'), path.join(out, 'adaptive-ldi.mjs'))
await copyFile(path.join(root, 'tools/spatial/soft-ldi.mjs'), path.join(out, 'soft-ldi.mjs'))
const report = { date: '2026-11-28', browser: '', models: [], synthetic: [], real: [], errors: [], scope: 'Research prototype; exact client runLocalDepth path with injected model bytes, optional ZipDepth through the same tensor functions.' }
report.inputHashes = []
for (const fixture of REAL_SCENES) report.inputHashes.push({ ...fixture, sha256: createHash('sha256').update(await readFile(path.join(root, fixture.file))).digest('hex') })
report.codeHashes = []
for (const file of ['client-depth.mjs', 'adaptive-ldi.mjs', 'soft-ldi.mjs']) report.codeHashes.push({ file, sha256: createHash('sha256').update(await readFile(path.join(out, file))).digest('hex') })
const require = createRequire(path.join(root, 'tools/promo/package.json'))
const { chromium } = require('playwright-core')
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Spatial follow-up</title>'); return }
  if (req.method === 'POST' && /^\/capture\/[a-z0-9-]+\.f32$/.test(url.pathname)) {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => { writeFile(path.join(out, 'references', path.basename(url.pathname)), Buffer.concat(chunks)).then(() => res.end('ok')).catch(e => { res.writeHead(500); res.end(String(e)) }) })
    return
  }
  const base = url.pathname.startsWith('/out/') ? out : url.pathname.startsWith('/previous/') ? previous : root
  const target = path.resolve(base, decodeURIComponent(url.pathname.replace(/^\/(?:out|previous|root)\//, '')))
  if (!target.startsWith(`${base}${path.sep}`) || !existsSync(target)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream')
  createReadStream(target).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const save = async (name, url) => writeFile(path.join(out, 'renders', `${name}.png`), Buffer.from(url.split(',')[1], 'base64'))
const persist = () => writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
let browser, page
try {
  const executablePath = [process.env.IMAGEN_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync)
  browser = await chromium.launch({ executablePath, headless: true })
  report.browser = browser.version()
  const fresh = async () => {
    if (page) await page.close()
    page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(async () => {
      const [client, adaptive, old, fixtures] = await Promise.all([
        import('/out/client-depth.mjs'), import('/out/adaptive-ldi.mjs'), import('/out/soft-ldi.mjs'), import('/root/tools/spatial/fixtures.mjs'),
      ])
      const encode = image => {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
        return canvas.toDataURL('image/png')
      }
      const pixels = async url => {
        const image = new Image(); image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data }
      }
      window.research = { client, adaptive, old, fixtures, encode, pixels }
    })
  }
  await fresh()
  // The actual runLocalDepth function is executed, including its resize/crop/quantile path.
  const models = await page.evaluate(async fixtures => {
    const { client, pixels } = window.research
    const ort = await import('/root/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs')
    ort.env.wasm.wasmPaths = `${location.origin}/root/node_modules/onnxruntime-web/dist/`
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false
    const da3Bytes = new Uint8Array(await (await fetch('/root/.tmp/m4e-da3-small.onnx')).arrayBuffer())
    const zipSession = await ort.InferenceSession.create('/previous/zipdepth-384-fp32.onnx', { executionProviders: ['webgpu'] })
    const results = []
    for (const fixture of fixtures) {
      const source = await pixels(`/root/${fixture.file}`)
      const started = performance.now()
      const da3 = await client.runLocalDepth({ sourcePixels: source, runtimeLoader: async () => ort, modelLoader: async () => da3Bytes })
      const da3TotalMs = performance.now() - started
      const zipStart = performance.now()
      const rect = client.fitDepthLetterbox(source.width, source.height, 384, 384)
      const resized = client.resizePixels(source, 384)
      const input = client.buildDepthInputTensor(resized, 384, 384, { input: { mean: [0, 0, 0], std: [1, 1, 1] } }, rect)
      const inputMs = performance.now() - zipStart
      const inferStart = performance.now()
      const outputs = await zipSession.run({ image: new ort.Tensor('float32', input, [1, 3, 384, 384]) })
      const zipInferMs = performance.now() - inferStart
      const cropped = client.cropDepthRaw(outputs.depth.data, 384, 384, rect)
      const zip = client.normalizeDepthOutput(cropped, rect.contentW, rect.contentH, { outputDepthDirection: 'near-large' })
      const zipTotalMs = performance.now() - zipStart
      const renderSource = client.resizePixels(source, 512)
      for (const [id, depth] of [['da3', da3.depth], ['zip', zip]]) {
        const aligned = client.resizeDepth(depth, renderSource.width, renderSource.height)
        const capture = await fetch(`/capture/${fixture.id}-${id}-depth.f32`, { method: 'POST', body: aligned.data })
        if (!capture.ok) throw new Error('Capture failed')
      }
      results.push({ id: fixture.id, sourceWidth: source.width, sourceHeight: source.height, renderWidth: renderSource.width, renderHeight: renderSource.height, da3TotalMs, da3PipelineMs: da3.elapsedMs, zipInputMs: inputMs, zipInferMs, zipTotalMs })
    }
    await zipSession.release()
    return results
  }, REAL_SCENES)
  report.models = models
  console.log(JSON.stringify({ phase: 'client-depth', samples: models.length }))
  await persist()
  for (const id of SYNTHETIC_SCENES) {
    await fresh()
    const result = await page.evaluate(async ({ id, directions }) => {
      const { adaptive, old, fixtures, encode } = window.research
      const source = fixtures.syntheticFrame(id), depth = fixtures.blurSyntheticDepth(source)
      const oldAsset = old.prepareSoftLdi(source, depth)
      const assets = {}, prepare = {}
      for (const [name, opts] of [['adaptive-pull', { maxLayers: 2, fill: 'pull' }], ['adaptive-patch', { maxLayers: 2 }]]) {
        const t = performance.now(); assets[name] = adaptive.prepareAdaptiveLdi(source, depth, opts); prepare[name] = performance.now() - t
      }
      const renderer = await import('/previous/baseline/depthFxWebGPU.js')
      const rows = [], images = { source: encode(source) }
      for (let direction = 0; direction < directions.length; direction++) {
        const [shiftX, shiftY] = directions[direction], vector = old.parallaxVector(source.width, source.height, { amplitude: 24, shiftX, shiftY })
        const target = fixtures.syntheticFrame(id, vector)
        const reference = await renderer.renderDepthFxWebGPU(source, depth, { mode: 'parallax', amplitude: 24, shiftX, shiftY, readPixels: true })
        if (!reference?.pixels) throw new Error('Baseline unavailable')
        const variants = { baseline: reference.pixels, 'soft-old': old.renderSoftLdi(oldAsset, vector) }
        for (const [name, asset] of Object.entries(assets)) variants[name] = adaptive.renderAdaptiveLdi(asset, vector)
        for (const [name, output] of Object.entries(variants)) {
          let error = 0, edgeError = 0, exposedError = 0, edgeN = 0, exposedN = 0, count = 0
          for (let y = 30; y < source.height - 30; y++) for (let x = 30; x < source.width - 30; x++) {
            const i = y * source.width + x
            const edge = target.alpha[i] > 0.001 && target.alpha[i] < 0.999 || Math.abs(target.alpha[i] - target.alpha[i - 2]) > 0.01 || Math.abs(target.alpha[i] - target.alpha[i + 2]) > 0.01
            const exposed = target.alpha[i] < 0.01 && source.alpha[i] > 0.1
            for (let c = 0; c < 3; c++) { const delta = Math.abs(output.data[i * 4 + c] - target.data[i * 4 + c]); error += delta; if (edge) edgeError += delta; if (exposed) exposedError += delta }
            count++; if (edge) edgeN++; if (exposed) exposedN++
          }
          rows.push({ name, direction, mae: error / (count * 3), edgeMae: edgeError / (edgeN * 3), exposedMae: exposedError / (exposedN * 3) })
          if (direction === 1) images[name] = encode(output)
        }
        if (direction === 1) images.target = encode(target)
      }
      return { id, rows, prepare, images, layers: assets['adaptive-patch'].centers }
    }, { id, directions: DIRECTIONS })
    for (const [name, url] of Object.entries(result.images)) await save(`synthetic-${id}-${name}`, url)
    delete result.images; report.synthetic.push(result); await persist()
    console.log(JSON.stringify({ phase: 'synthetic', id }))
  }
  for (const fixture of REAL_SCENES) {
    await fresh()
    const result = await page.evaluate(async ({ fixture }) => {
      const { client, adaptive, old, pixels, encode } = window.research
      const source = client.resizePixels(await pixels(`/root/${fixture.file}`), 512)
      const images = { source: encode(source) }, timings = [], motion = { amplitude: 24, shiftX: -0.7, shiftY: 0.35 }
      for (const id of ['da3', 'zip']) {
        const raw = new Float32Array(await (await fetch(`/out/references/${fixture.id}-${id}-depth.f32`)).arrayBuffer())
        const depth = { width: source.width, height: source.height, data: raw }
        const renderer = await import(`/previous/baseline/depthFxWebGPU.js?model=${id}`)
        const baseline = await renderer.renderDepthFxWebGPU(source, depth, { ...motion, mode: 'parallax', readPixels: true })
        if (!baseline?.pixels) throw new Error('Baseline unavailable')
        images[`${id}-baseline`] = encode(baseline.pixels)
        if (id === 'da3') {
          const t = performance.now(), asset = adaptive.prepareAdaptiveLdi(source, depth), prepareMs = performance.now() - t
          const r = performance.now(), output = adaptive.renderAdaptiveLdi(asset, old.parallaxVector(source.width, source.height, motion)), renderMs = performance.now() - r
          images.adaptive = encode(output)
          timings.push({ prepareMs, renderMs, centers: asset.centers })
        }
      }
      return { id: fixture.id, timings, images, groundTruth: false }
    }, { fixture })
    for (const [name, url] of Object.entries(result.images)) await save(`real-${fixture.id}-${name}`, url)
    delete result.images; report.real.push(result); await persist()
    console.log(JSON.stringify({ phase: 'real', id: fixture.id }))
  }
} catch (error) { report.errors.push(String(error.stack || error)); process.exitCode = 1 }
finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); await persist() }
