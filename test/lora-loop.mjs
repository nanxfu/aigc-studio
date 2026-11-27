import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalLoraStore, ensureLocalLora } from '../server/local-gpu/loras.js'
import { buildSaladContainerSpec } from '../server/providers/salad.js'
import { styleLoraCompatibility, normalizeLoraSpec } from '../shared/game-styles.js'
import { buildImageToolBody } from '../web/logic/imageTool.js'
import { PRESETS } from '../shared/contract.js'
import { JobQueue } from '../server/jobs/queue.js'
import { createFakeContext } from './helpers/fake-context.mjs'
import { createMaskPng } from './helpers/image-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'aigc-lora-loop-'))
try {
  const store = createLocalLoraStore({ root, modelsDir: () => root })
  const header = Buffer.from(JSON.stringify({ 'lora_unet_test.lora_down.weight': { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }))
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length))
  const file = join(root, 'skin.safetensors')
  await writeFile(file, Buffer.concat([size, header, Buffer.alloc(4)]))
  const imported = await store.importFile({ path: file, family: 'sdxl', basePresetId: 'realvisxl-lightning' })
  await rm(file)
  assert.match(imported.assetId, /^[a-f0-9]{64}$/)
  const result = await ensureLocalLora(imported, { loraDir: join(root, 'engine-loras'), store })
  assert.ok(result.downloaded)
  assert.ok((await readFile(result.absolutePath)).length > 4)
  assert.equal((await ensureLocalLora(imported, { loraDir: join(root, 'engine-loras'), store })).downloaded, false)
  const realvis = PRESETS.find((p) => p.id === 'realvisxl-lightning')
  assert.equal(styleLoraCompatibility(imported, realvis, 'local-gpu').ok, true)
  assert.equal(styleLoraCompatibility(imported, realvis, 'salad').reason, 'local')
  assert.equal(styleLoraCompatibility(normalizeLoraSpec('pixel-art').value, realvis, 'local-gpu').ok, false)
  await writeFile(file, Buffer.from('invalid-file-with-safetensors-extension'))
  await assert.rejects(store.importFile({ path: file, family: 'sdxl' }))
  let headers
  await ensureLocalLora({ repo: 'private/style', weight: 'skin.safetensors' }, {
    loraDir: join(root, 'hf-loras'), hfToken: 'hf_test_private',
    download: async (_ctx, _url, opts) => { headers = opts.headers; await writeFile(opts.destPath, 'test'); return { bytes: 4 } },
  })
  assert.equal(headers.Authorization, 'Bearer hf_test_private')
  const container = buildSaladContainerSpec({ groupName: 'test', gpu: { id: 'gpu', vramGb: 24 }, workerToken: 'worker', hfToken: 'hf_test_private' })
  assert.equal(container.container.environment_variables.HF_TOKEN, 'hf_test_private')
  const mask = createMaskPng(16, 16).toString('base64')
  const body = buildImageToolBody({ tool: 'inpaint', targetPath: 'outputs/source/01.png', preset: realvis, prompt: 'coat', styleLora: imported, variantId: 'full', steps: 7, cfg: 1.5, mask: { data: mask, coverage: 0.5 } })
  assert.equal(body.lora.assetId, imported.assetId)
  assert.equal(body.variantId, 'full')
  assert.equal(body.steps, 7)
  assert.ok(body.reference.mask, 'local inpaint must carry both LoRA and mask')
  const fake = createFakeContext(root)
  const queue = new JobQueue({ ctx: fake.ctx, session: {}, defaultPreset: 'sdxl-lightning' })
  const preset = PRESETS.find((p) => p.id === 'sdxl-lightning')
  const style = { repo: 'someone/sdxl-style', weight: 'style.safetensors', scale: 0.6 }
  const payload = queue.taskPayload({ id: 'test', params: { lora: style, prompt: 'coat', seed: 1 } }, preset, 0)
  assert.deepEqual(payload.pipeline.lora, preset.pipeline.lora, 'acceleration LoRA must survive')
  assert.deepEqual(payload.pipeline.styleLora, style)
  queue.dispose()
  console.log('PASS local import, moved source, validation, token, inpaint inheritance and acceleration preservation')
} finally { await rm(root, { recursive: true, force: true }) }
