import assert from 'node:assert/strict'
import { publicPresets } from '../shared/contract.js'
import { createTestClient, collectText, findNodes } from './helpers/render.mjs'

const presets = publicPresets()
const realvis = presets.find((p) => p.id === 'realvisxl-lightning')
const flux = presets.find((p) => p.id === 'flux2-klein-4b')
const style = { id: 'custom', repo: 'test/sdxl', weight: 'skin.safetensors', family: 'sdxl', basePresetId: realvis.id, scale: 0.6, trigger: '' }
const client = await createTestClient({ testBuild: true, responses: {
  '/api/generate': { ok: true, id: 'edit-lora-job', status: 'queued' },
  '/api/local-gpu/loras/import': { ok: true, lora: { id: 'local', source: 'local', assetId: 'a'.repeat(64), family: 'sdxl', basePresetId: realvis.id, name: 'skin.safetensors' } },
} })
const t = client.internals.i18n.fallbackTranslate('zh')
const target = { image: { path: 'outputs/source/01.png', width: 512, height: 512 }, item: { prompt: 'coat' } }
let tool, form = { presetId: realvis.id, variantId: 'full', styleLora: style, steps: 7, cfg: 1.5 }
function Harness() {
  tool = client.hooks.useImageTool({ t, alive: async (promise) => promise, ui: { showToast() {}, setError() {}, fail() {} }, presets, provider: 'local-gpu', defaultPreset: realvis.id, currentPresetId: form.presetId, currentForm: form })
  return client.react.createElement('div', {})
}
try {
  await client.mountRaw(Harness, {})
  tool.openTool('img2img', target)
  await client.rerenderRaw()
  assert.equal(await tool.submit(), true)
  const sent = client.requests.find((r) => r.path === '/api/generate').body
  assert.equal(sent.lora.repo, style.repo)
  assert.equal(sent.steps, 7)
  assert.equal(sent.cfg, 1.5)
  assert.equal(sent.variantId, 'full')
  form = { ...form, presetId: flux.id, styleLora: { id: 'pixel-art' } }
  await client.rerenderRaw()
  tool.openTool('img2img', target)
  await client.rerenderRaw()
  assert.equal(tool.loraConflict, true)
  assert.equal(await tool.submit(), false)
  tool.clearToolLora()
  await client.rerenderRaw()
  assert.equal(tool.loraConflict, false)
  client.unmount()
  let railForm = { prompt: 'portrait', negative: '', presetId: flux.id, variantId: 'quality-q4', steps: 32, cfg: 4, width: 1024, height: 1024, seed: '', count: 1 }
  const props = { t, isEn: false, compute: { provider: 'local-gpu' }, ui: { advancedOpen: true, toggleAdvancedOpen() {}, panelMode: 'form', setPanelMode() {} }, actions: { generate() {} }, form: { form: railForm, patchForm(patch) { Object.assign(railForm, patch) }, activePreset: flux, negativeHint: '', refineGroups: [], refineSelectedIds: [] } }
  const tree = await client.mountRaw(client.components.Rail, props)
  const texts = collectText(tree).join('')
  assert.ok(texts.includes('质量 Base GGUF Q4_0'))
  assert.ok(texts.includes('质量 Base GGUF Q8_0'))
  assert.ok(!texts.includes('质量 Base (BF16)'))
  const quality = findNodes(tree, (node) => node.type === 'button' && node.props['data-thumb-key'] === 'quality')[0]
  assert.equal(quality.props.disabled, false)
  assert.ok(texts.includes('挂机精修'))
  client.unmount()
  const patched = []
  const styleTree = await client.mountRaw(client.components.Rail, { ...props, form: { ...props.form, activePreset: realvis, form: { ...railForm, presetId: realvis.id, styleLora: { ...style, source: 'local' } }, patchForm: (patch) => patched.push(patch) } })
  const pathInput = findNodes(styleTree, (node) => node.type === 'input' && node.props['aria-label'] === '.safetensors 文件路径')[0]
  pathInput.props.onChange({ target: { value: 'D:/weights/skin.safetensors' } })
  const updated = await client.rerenderRaw()
  findNodes(updated, (node) => node.type === 'button' && collectText(node).join('') === '导入文件')[0].props.onClick()
  await client.settle()
  assert.equal(patched.at(-1).styleLora.assetId, 'a'.repeat(64))
  console.log('PASS stage LoRA/variant snapshot, cross-model opt-out, local Q4/Q8 quality choices and file import UI')
} finally { client.unmount() }
