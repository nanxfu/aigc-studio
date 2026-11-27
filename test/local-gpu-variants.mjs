import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_GPU_ENGINE, LOCAL_GPU_ENGINE_MARKER, localGpuAssetOf, localGpuModelKeyOf, localGpuModelStateOf } from '../shared/local-gpu-assets.js'
import { createLocalGpuSetup } from '../server/local-gpu/setup.js'
import { readLocalGpuConfig, resolveLocalGpuModel, publicLocalGpuView } from '../server/local-gpu/config.js'
import { createLocalGpuBridge } from '../server/local-gpu/bridge.js'
import { resolveVariant, modeSwitchPatch } from '../shared/variants.js'
import { PRESETS, publicPresets } from '../shared/contract.js'
import { JobQueue } from '../server/jobs/queue.js'

const root = await mkdtemp(join(tmpdir(), 'aigc-local-variants-'))
const presetId = 'flux2-klein-4b'
const createFile = (key, file, text) => ({ key, file, payload: Buffer.from(text), bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'), url: `https://huggingface.co/test/weights/resolve/fixed/${file}` })
try {
  const engineDir = join(root, 'engine'), modelsDir = join(root, 'models')
  await mkdir(engineDir)
  await mkdir(modelsDir)
  for (const file of ['sd-server.exe', 'ggml-base.dll', 'ggml-vulkan.dll', 'ggml.dll', 'stable-diffusion.dll', 'stable-diffusion.cpp.txt']) await writeFile(join(engineDir, file), 'engine')
  await writeFile(join(engineDir, LOCAL_GPU_ENGINE_MARKER), LOCAL_GPU_ENGINE.sha256)
  const shared = [createFile('vaePath', 'vae.safetensors', 'same-vae'), createFile('llmPath', 'qwen.gguf', 'same-qwen')]
  const definitions = [[presetId, 'q4.gguf'], [`${presetId}::local-q8`, 'q8.gguf'], [`${presetId}::quality-q4`, 'base-q4.gguf'], [`${presetId}::quality-q8`, 'base-q8.gguf']]
  const assets = Object.fromEntries(definitions.map(([key, file]) => {
    const files = [createFile('modelPath', file, file), ...shared]
    return [key, { id: key, available: true, files, bytes: files.reduce((n, file) => n + file.bytes, 0) }]
  }))
  const downloads = [], tokens = []
  const env = { AIGC_STUDIO_BUNDLED_SD_DIR: engineDir }
  const setup = createLocalGpuSetup({ appConfig: { root }, localModels: { effectiveDir: () => modelsDir }, env, platform: 'win32', arch: 'x64', modelAssets: assets,
    detectNvidia: async () => false, getHfToken: () => 'hf_variant_test',
    listDevices: async () => ({ ok: true, devices: [{ id: 'Vulkan0', name: '880M', backend: 'vulkan' }] }),
    diskInfo: async () => ({ bavail: 1000000, bsize: 4096 }),
    download: async (_ctx, url, opts) => {
      const file = Object.values(assets).flatMap((a) => a.files).find((f) => f.url === url)
      downloads.push(file.file); tokens.push(opts.headers?.Authorization)
      await writeFile(opts.destPath, file.payload); opts.onProgress?.(file.bytes)
      return { bytes: file.bytes, sha256: file.sha256 }
    },
  })
  async function prepare(variant) {
    await setup.start(presetId, variant)
    for (let n = 0; n < 200 && setup.busy(); n++) await new Promise((resolve) => setTimeout(resolve, 5))
    const state = await setup.snapshot(localGpuModelKeyOf(presetId, variant))
    assert.equal(state.phase, 'ready', state.message)
    return state
  }
  await prepare('local-q4')
  const second = await prepare('quality-q8')
  assert.equal(second.totalBytes, Buffer.byteLength('base-q8.gguf'), 'download budget excludes shared components')
  await prepare('local-q8')
  await prepare('quality-q4')
  assert.equal(downloads.filter((name) => name === 'vae.safetensors').length, 1)
  assert.equal(downloads.filter((name) => name === 'qwen.gguf').length, 1)
  assert.ok(tokens.every((token) => token === 'Bearer hf_variant_test'))
  const config = readLocalGpuConfig({ root, env }).config
  assert.equal(config.defaultVariantId, 'quality-q4')
  assert.equal(resolveLocalGpuModel(config, presetId, 'quality-q8').modelPath, join(modelsDir, 'base-q8.gguf'))
  assert.equal(resolveLocalGpuModel(config, presetId, 'unavailable'), null)
  const view = publicLocalGpuView({ config, ok: true })
  assert.equal(localGpuModelStateOf(presetId, view, 'quality-q8').downloaded, true)
  assert.equal(localGpuModelStateOf(presetId, view, 'unavailable').downloaded, false)
  assert.equal(localGpuModelStateOf(presetId, { configuredPresets: [presetId], modelStates: { [`${presetId}::local-q8`]: { ready: true } } }, 'local-q4').downloaded, false)
  assert.equal(localGpuModelStateOf(presetId, { configuredPresets: [presetId], modelStates: { [`${presetId}::local-q8`]: { ready: true } } }).downloaded, true, 'model picker can select a preset with a downloaded Q8 variant')
  assert.equal(localGpuAssetOf(presetId, 'quality-q8').files[1], localGpuAssetOf(presetId).files[1])
  const preset = PRESETS.find((p) => p.id === presetId)
  assert.equal(resolveVariant(preset, 'auto', 'local-gpu').id, 'local-q4')
  assert.equal(modeSwitchPatch(publicPresets().find((p) => p.id === presetId), 'quality', {}, 'local-gpu').variantId, 'quality-q4')
  const firstQuality = modeSwitchPatch(publicPresets().find((p) => p.id === presetId), 'quality', { qualitySteps: null, qualityCfg: null }, 'local-gpu')
  assert.equal(firstQuality.steps, 32)
  assert.equal(firstQuality.cfg, 4)
  const switched = [], requests = []
  const runtime = { health: async () => ({ ok: true, phase: 'ready' }), info: () => ({}), logsSince: () => ({ lines: [], next: 0 }), submit: async (body) => { requests.push(body); return { id: 'sd' } }, job: async () => ({ status: 'completed', result: { images: [{ b64_json: 'AA==' }] } }) }
  const bridge = createLocalGpuBridge({ runtime, config: { ...config, modelPath: join(modelsDir, 'q4.gguf') }, token: 'test', resolveModel: (id, variant) => resolveLocalGpuModel(config, id, variant), onEnsureModel: async (id, model) => { switched.push(model); return { runtime, config: { ...config, ...model, defaultPreset: id, defaultVariantId: model.variantId } } } })
  try {
    const endpoint = await bridge.start()
    const response = await fetch(`${endpoint}/generate`, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'variant-check', presetId, variantId: 'quality-q8', pipeline: {}, tasks: [{ prompt: 'lake', width: 512, height: 512, steps: 32, cfg: 4 }] }) })
    assert.equal(response.status, 202)
    assert.equal(switched[0].modelPath, join(modelsDir, 'base-q8.gguf'))
    const conflicting = await fetch(`${endpoint}/generate`, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: 'variant-check', presetId, variantId: 'quality-q4', pipeline: {}, tasks: [{ prompt: 'lake', width: 512, height: 512, steps: 32, cfg: 4 }] }) })
    assert.equal(conflicting.status, 409, 'same job ID cannot silently select another quantized model')
  } finally { await bridge.stop() }
  assert.ok(JobQueue.prototype.generationBudgetMs.call({ options: { generateTimeoutMs: 600000 } }, { provider: 'local-gpu', variantId: 'quality-q4' }) >= 3600000)
  await setup.dispose()
  console.log('PASS four variants, shared downloads, HF token, exact config/bridge selection, readiness and quality timeout')
} finally { await rm(root, { recursive: true, force: true }) }
