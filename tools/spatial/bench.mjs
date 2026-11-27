/** Reproducible real-browser E0/E1/E2 probe. Uses the project's existing browser stack. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(root, process.argv.slice(2).find(arg => !arg.startsWith('--')) || '.tmp/spatial-e0-e2-2026-11-27')
const require = createRequire(path.join(root, 'tools/promo/package.json'))
const { chromium } = require('playwright-core')
const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'))
const cpu = JSON.parse(await readFile(path.join(out, 'model-cpu-report.json'), 'utf8'))
if (process.argv.includes('--resume')) {
  const previous = JSON.parse(await readFile(path.join(out, 'browser-report.json'), 'utf8'))
  assert.deepEqual(previous.manifest, manifest, 'Resume requires identical manifest/baseline')
}
const report = process.argv.includes('--resume')
  ? JSON.parse(await readFile(path.join(out, 'browser-report.json'), 'utf8'))
  : { manifest, browser: '', modelChecks: [], synthetic: [], real: [], errors: [], timingScope: 'Wall time including readback; CPU reference timings are not GPU frame timings.' }
await mkdir(path.join(out, 'renders'), { recursive: true })

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'POST' && /^\/capture\/[a-z0-9-]+\.f32$/.test(url.pathname)) {
    const chunks = []
    let length = 0
    req.on('data', chunk => { length += chunk.length; if (length > 1024 * 1024) req.destroy(); else chunks.push(chunk) })
    req.on('end', async () => {
      try {
        await writeFile(path.join(out, 'references', path.basename(url.pathname)), Buffer.concat(chunks))
        res.end('ok')
      } catch (error) { res.writeHead(500); res.end(String(error.message)) }
    })
    return
  }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Spatial research</title>'); return }
  const base = url.pathname.startsWith('/out/') ? out : root
  const relative = decodeURIComponent(url.pathname.replace(/^\/(?:out|root)\//, ''))
  const file = path.resolve(base, relative)
  if (!file.startsWith(`${base}${path.sep}`) || !existsSync(file)) { res.writeHead(404); res.end(); return }
  const extension = path.extname(file)
  res.setHeader('Content-Type', ({ '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp' })[extension] || 'application/octet-stream')
  createReadStream(file).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
const persist = () => writeFile(path.join(out, 'browser-report.json'), JSON.stringify(report, null, 2))
const save = async (name, dataUrl) => {
  if (dataUrl) await writeFile(path.join(out, 'renders', `${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'))
}
try {
  const executablePath = [process.env.IMAGEN_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync)
  assert.ok(executablePath, 'Installed Chrome/Edge required')
  browser = await chromium.launch({ executablePath, headless: true })
  report.browser = browser.version()
  let page
  const freshPage = async () => {
    if (page) await page.close()
    page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.evaluate(async () => {
    const [soft, fixtures, gpu, gl, cpu] = await Promise.all([
      import('/root/tools/spatial/soft-ldi.mjs'), import('/root/tools/spatial/fixtures.mjs'),
      import('/out/baseline/depthFxWebGPU.js'), import('/out/baseline/depthFxWebGL.js'), import('/out/baseline/depthFx.js'),
    ])
    const ort = await import('/root/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs')
    ort.env.wasm.wasmPaths = `${location.origin}/root/node_modules/onnxruntime-web/dist/`
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    window.research = {
      soft, fixtures, gpu, gl, cpu, ort,
      encode: image => {
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
        return canvas.toDataURL('image/png')
      },
      readImage: async url => {
        const image = await createImageBitmap(await (await fetch(url)).blob())
        const canvas = new OffscreenCanvas(image.width, image.height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0); image.close()
        return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data }
      },
    }
    })
  }
  await freshPage()
  report.adapter = await page.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null })
  // Model outputs must agree with the CPU oracle before they are considered viable.
  for (const model of cpu.models) for (const ep of model.id === 'da3' ? ['wasm'] : ['wasm', 'webgpu']) {
    if (report.modelChecks.some(row => row.id === model.id && row.ep === ep)
      && (model.id !== 'da3' || existsSync(path.join(out, 'references', 'portrait-hair-da3-wasm.f32')))) continue
    const result = await page.evaluate(async ({ model, ep, ids }) => {
      const { ort } = window.research
      let session
      const started = performance.now()
      try {
        const modelUrl = model.id === 'da3' ? `/root/${model.file.replaceAll('\\', '/')}` : `/out/${model.id === 'zip-fp16' ? 'zipdepth-384-fp16.onnx' : 'zipdepth-384-fp32.onnx'}`
        session = await ort.InferenceSession.create(modelUrl, { executionProviders: [ep] })
        const sessionMs = performance.now() - started
        const samples = []
        for (const id of ids) {
          const name = `${id}-${model.id}`
          const input = new Float32Array(await (await fetch(`/out/references/${name}-input.f32`)).arrayBuffer())
          const reference = new Float32Array(await (await fetch(`/out/references/${name}-raw.f32`)).arrayBuffer())
          let output
          const times = []
          for (let i = 0; i < 3; i++) {
            const runStart = performance.now()
            const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, model.inputShape) })
            output = outputs[session.outputNames[0]].data
            times.push(performance.now() - runStart)
          }
          let error = 0, maximum = 0, finite = 0, sum = 0, sumSquare = 0
          for (let i = 0; i < reference.length; i++) { sum += reference[i]; sumSquare += reference[i] ** 2 }
          const std = Math.sqrt(Math.max(0, sumSquare / reference.length - (sum / reference.length) ** 2))
          const lengthMatches = output.length === reference.length
          for (let i = 0; i < reference.length; i++) {
            if (Number.isFinite(output[i])) finite++
            const delta = Math.abs(reference[i] - output[i]); error += delta; maximum = Math.max(maximum, delta)
          }
          const mae = error / reference.length
          if (model.id === 'da3') {
            const capture = await fetch(`/capture/${id}-da3-wasm.f32`, {
              method: 'POST', body: new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
            })
            if (!capture.ok) throw new Error(`Reference capture HTTP ${capture.status}`)
          }
          samples.push({ id, times, lengthMatches, finiteFraction: finite / reference.length, mae, maxError: maximum, relativeMae: mae / Math.max(1e-8, std), pass: lengthMatches && finite === reference.length && mae / Math.max(1e-8, std) < 0.01 })
        }
        return { id: model.id, ep, sessionMs, samples, pass: samples.every(sample => sample.pass) }
      } catch (error) { return { id: model.id, ep, error: String(error?.message || error), pass: false } }
      finally { if (session) await session.release() }
    }, { model, ep, ids: ['portrait-hair', 'anime-hair', 'diorama', 'street-text'] })
    report.modelChecks = report.modelChecks.filter(row => row.id !== model.id || row.ep !== ep)
    report.modelChecks.push(result)
    console.log(JSON.stringify({ phase: 'models', model: model.id, ep, pass: result.pass, error: result.error, samples: result.samples?.map(s => ({ id: s.id, ms: s.times[1], relativeMae: s.relativeMae })) }))
    await persist()
  }
  // Analytic target views are independent of the candidate renderer.
  for (const id of manifest.syntheticScenes) {
    if (report.synthetic.some(scene => scene.id === id && scene.rows.some(row => row.name === 'soft-fill-only'))) continue
    await freshPage() // Baseline cache fingerprints sample only six values; avoid cross-fixture collisions.
    const result = await page.evaluate(async ({ id, directions }) => {
      const { soft, fixtures, gpu, gl, cpu, encode } = window.research
      const source = fixtures.syntheticFrame(id)
      const depth = fixtures.blurSyntheticDepth(source)
      const variants = {
        'soft-only': soft.prepareSoftLdi(source, depth, { recoverColor: false, fill: false }),
        'soft-recover': soft.prepareSoftLdi(source, depth, { recoverColor: true, fill: false }),
        'soft-fill-only': soft.prepareSoftLdi(source, depth, { recoverColor: false, fill: true }),
        'soft-full': soft.prepareSoftLdi(source, depth),
        'oracle-alpha': soft.prepareSoftLdi(source, depth, { alphaOracle: source.alpha }),
      }
      const rows = [], images = { source: encode(source) }
      for (let direction = 0; direction < directions.length; direction++) {
        const [shiftX, shiftY] = directions[direction]
        const vector = soft.parallaxVector(source.width, source.height, { amplitude: 24, shiftX, shiftY })
        const expected = fixtures.syntheticFrame(id, { width: source.width, height: source.height, ...vector })
        const referenceOptions = { mode: 'parallax', amplitude: 24, shiftX, shiftY, readPixels: true }
        const started = performance.now()
        const gpuResult = await gpu.renderDepthFxWebGPU(source, depth, referenceOptions)
        const gpuMs = performance.now() - started
        const glStarted = performance.now()
        const glResult = gl.renderDepthFxWebGL(source, depth, referenceOptions)
        const glMs = performance.now() - glStarted
        if (!gpuResult?.pixels || !glResult?.pixels) throw new Error(`Baseline unavailable: ${id}/${direction}`)
        const candidates = { webgpu: { pixels: gpuResult.pixels, ms: gpuMs }, webgl: { pixels: glResult.pixels, ms: glMs } }
        if (direction === 0) { const t = performance.now(); candidates.cpu = { pixels: cpu.applyDepthFx(source, depth, referenceOptions), ms: performance.now() - t } }
        for (const [name, asset] of Object.entries(variants)) { const t = performance.now(); candidates[name] = { pixels: soft.renderSoftLdi(asset, vector), ms: performance.now() - t } }
        for (const [name, { pixels, ms }] of Object.entries(candidates)) {
          let error = 0, edgeError = 0, edgeCount = 0, exposedError = 0, exposedCount = 0
          const margin = 30
          for (let y = margin; y < source.height - margin; y++) for (let x = margin; x < source.width - margin; x++) {
            const i = y * source.width + x
            const edge = expected.alpha[i] > 0.001 && expected.alpha[i] < 0.999
              || Math.abs(expected.alpha[i] - expected.alpha[Math.max(0, i - 2)]) > 0.01
              || Math.abs(expected.alpha[i] - expected.alpha[Math.min(expected.alpha.length - 1, i + 2)]) > 0.01
            const exposed = expected.alpha[i] < 0.01 && source.alpha[i] > 0.1
            for (let c = 0; c < 3; c++) {
              const delta = Math.abs(pixels.data[i * 4 + c] - expected.data[i * 4 + c])
              error += delta
              if (edge) edgeError += delta
              if (exposed) exposedError += delta
            }
            if (edge) edgeCount++
            if (exposed) exposedCount++
          }
          rows.push({ name, direction, ms, mae: error / ((source.width - margin * 2) * (source.height - margin * 2) * 3), edgeMae: edgeCount ? edgeError / (edgeCount * 3) : null, exposedMae: exposedCount ? exposedError / (exposedCount * 3) : null })
          if (direction === 1) images[name] = encode(pixels)
        }
        if (direction === 1) images.expected = encode(expected)
      }
      const full = variants['soft-full']
      const alphaMae = full.alpha.reduce((sum, a, i) => sum + Math.abs(a - source.alpha[i]), 0) / source.alpha.length
      return { id, rows, alphaMae, images }
    }, { id, directions: manifest.directions })
    for (const [name, data] of Object.entries(result.images)) await save(`synthetic-${id}-${name}`, data)
    delete result.images
    report.synthetic = report.synthetic.filter(scene => scene.id !== id)
    report.synthetic.push(result)
    console.log(JSON.stringify({ phase: 'synthetic', id, alphaMae: result.alphaMae }))
    await persist()
  }
  for (const fixture of manifest.realScenes) {
    if (report.real.some(scene => scene.id === fixture.id)) continue
    await freshPage()
    const sample = cpu.samples.find(s => s.id === fixture.id && s.model === 'da3')
    const result = await page.evaluate(async ({ fixture, sample, motion }) => {
      const { soft, cpu, gpu, gl, encode, readImage } = window.research
      const source = cpu.resizePixels(await readImage(`/root/${fixture.file}`), motion.renderMaxEdge)
      const raw = new Float32Array(await (await fetch(`/out/references/${fixture.id}-da3-depth.f32`)).arrayBuffer())
      const depth = cpu.resizeDepth({ width: sample.depthWidth, height: sample.depthHeight, data: raw }, source.width, source.height)
      const options = { mode: 'parallax', amplitude: motion.amplitude, shiftX: motion.shiftX, shiftY: motion.shiftY, readPixels: true }
      const t = performance.now(), asset = soft.prepareSoftLdi(source, depth), prepareMs = performance.now() - t
      const start = performance.now(), full = soft.renderSoftLdi(asset, soft.parallaxVector(source.width, source.height, options)), renderMs = performance.now() - start
      const webgpu = await gpu.renderDepthFxWebGPU(source, depth, options)
      const webgl = gl.renderDepthFxWebGL(source, depth, options)
      if (!webgpu?.pixels || !webgl?.pixels) throw new Error(`Baseline unavailable: ${fixture.id}`)
      const images = { source: encode(source), webgpu: encode(webgpu.pixels), webgl: encode(webgl.pixels), 'soft-full': encode(full) }
      const alphaPixels = { width: source.width, height: source.height, data: new Uint8ClampedArray(source.width * source.height * 4) }
      for (let i = 0; i < asset.alpha.length; i++) { alphaPixels.data.fill(Math.round(asset.alpha[i] * 255), i * 4, i * 4 + 3); alphaPixels.data[i * 4 + 3] = 255 }
      images.alpha = encode(alphaPixels)
      return { id: fixture.id, prepareMs, renderMs, near: asset.near, far: asset.far, images, groundTruth: false }
    }, { fixture, sample, motion: manifest.motion })
    for (const [name, data] of Object.entries(result.images)) await save(`real-${fixture.id}-${name}`, data)
    delete result.images
    report.real.push(result)
    console.log(JSON.stringify({ phase: 'real', id: fixture.id, prepareMs: result.prepareMs, renderMs: result.renderMs }))
    await persist()
  }
  // Hold the production WebGPU renderer fixed while changing only the depth model.
  report.depthRendererComparison ||= []
  for (const fixture of manifest.realScenes) {
    if (report.depthRendererComparison.some(scene => scene.id === fixture.id)) continue
    await freshPage()
    const samples = cpu.samples.filter(sample => sample.id === fixture.id && ['da3', 'zip-fp32'].includes(sample.model))
    const result = await page.evaluate(async ({ fixture, samples, motion }) => {
      const { cpu, gpu, encode, readImage } = window.research
      const source = cpu.resizePixels(await readImage(`/root/${fixture.file}`), motion.renderMaxEdge)
      const images = {}, timings = []
      for (const sample of samples) {
        // Import a fresh baseline module per model: a six-value cache fingerprint can collide.
        const renderer = await import(`/out/baseline/depthFxWebGPU.js?model=${sample.model}`)
        const raw = new Float32Array(await (await fetch(`/out/references/${fixture.id}-${sample.model}-depth.f32`)).arrayBuffer())
        const depth = cpu.resizeDepth({ width: sample.depthWidth, height: sample.depthHeight, data: raw }, source.width, source.height)
        const started = performance.now()
        const rendered = await renderer.renderDepthFxWebGPU(source, depth, { ...motion, mode: 'parallax', readPixels: true })
        if (!rendered?.pixels) throw new Error(`Renderer unavailable: ${fixture.id}/${sample.model}`)
        timings.push({ model: sample.model, coldRenderReadbackMs: performance.now() - started })
        images[sample.model] = encode(rendered.pixels)
      }
      return { id: fixture.id, timings, images, groundTruth: false }
    }, { fixture, samples, motion: manifest.motion })
    for (const [name, data] of Object.entries(result.images)) await save(`model-parallax-${fixture.id}-${name}`, data)
    delete result.images
    report.depthRendererComparison.push(result)
    console.log(JSON.stringify({ phase: 'model-parallax', id: fixture.id }))
    await persist()
  }
} catch (error) { report.errors.push(String(error.stack || error)); process.exitCode = 1 }
finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); await persist() }
