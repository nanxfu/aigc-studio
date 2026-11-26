#!/usr/bin/env node
/**
 * 游戏 LoRA 风格锁定（shared/game-styles.js + Host validator/queue + Client Rail/form/generate）
 * 与工坊 PBR 模型过滤（隐藏未实现的 CHORD）离线回归。
 *
 * 运行：node test/game-styles.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../server/app.js'
import { normalizeLoraRequest } from '../server/jobs/validator.js'
import { APP_VERSION } from '../shared/contract.js'
import {
  GAME_STYLE_LORAS,
  STYLE_LORAS,
  applyLoraTriggerPrompt,
  normalizeLoraSpec,
  searchStyleLoras,
  styleLoraCatalogText,
  supportsStyleLora,
} from '../shared/game-styles.js'
import { formSnapshotOf, newCreationPatch, styleLoraChangedOf } from '../web/logic/form.js'
import { buildGenerateBody, iteratePatch, rerollOverrides } from '../web/logic/generate.js'
import { createCheckRunner } from './helpers/check.mjs'
import { closeServer, createFakeContext, startHost } from './helpers/fake-context.mjs'
import { collectText, createTestClient, findNodes, nodesByClass } from './helpers/render.mjs'

const { check, summary } = createCheckRunner()
const tempDirs = []
const DEV_TOKEN = 'dev-game-styles-token'
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function startMockWorker() {
  const bodies = []
  const jobs = new Map()
  const server = createServer((req, res) => {
    const send = (code, value) => {
      const buf = Buffer.from(JSON.stringify(value))
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': String(buf.length) })
      res.end(buf)
    }
    if (req.headers.authorization !== `Bearer ${DEV_TOKEN}`) return send(401, { error: { code: 'unauthorized' } })
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { status: 'ok', phase: 'ready', version: APP_VERSION, device: 'Mock T4', device_count: 1 })
    }
    if (req.method === 'POST' && req.url === '/generate') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        bodies.push(body)
        const jobId = String(body.jobId)
        jobs.set(jobId, {
          job_id: jobId,
          status: 'done',
          stage: '完成',
          results: [{ name: '01', seed: body.tasks?.[0]?.seed ?? 42, width: 1024, height: 1024, image_b64: PNG_B64 }],
        })
        send(200, { job_id: jobId, status: 'queued' })
      })
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/job')) {
      const url = new URL(req.url, 'http://127.0.0.1')
      const job = jobs.get(url.searchParams.get('id'))
      return send(job ? 200 : 404, job || { error: { code: 'not_found' } })
    }
    if (req.method === 'POST' && req.url === '/shutdown') return send(200, { ok: true })
    send(404, { error: { code: 'not_found' } })
  })
  return {
    bodies,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

try {
  await check('shared/game-styles：归一化、安全校验与触发词去重拼装', () => {
    assert.equal(GAME_STYLE_LORAS.length >= 4, true)
    assert.deepEqual(normalizeLoraSpec(null), { ok: true, value: null })
    assert.deepEqual(normalizeLoraSpec('none'), { ok: true, value: null })

    const pixel = normalizeLoraSpec({ id: 'pixel-art', scale: 2.5 })
    assert.equal(pixel.ok, true)
    assert.equal(pixel.value.repo, 'adirik/pixel-art-lora-flux.2-klein-4B')
    assert.equal(pixel.value.weight, 'pixelart_lora.safetensors')
    assert.equal(pixel.value.scale, 1.5, 'scale 超过上界应钳到 1.5')
    assert.equal(pixel.value.trigger, 'PXART4')

    assert.equal(normalizeLoraRequest({ repo: 'bad-repo', weight: 'a.safetensors' }).ok, false)
    assert.equal(normalizeLoraRequest({ repo: 'owner/model', weight: '../evil.safetensors' }).ok, false)
    assert.equal(normalizeLoraRequest({ repo: 'owner/model', weight: 'weights.bin' }).ok, false)

    assert.equal(applyLoraTriggerPrompt('knight sword icon', 'PXART4'), 'PXART4, knight sword icon')
    assert.equal(applyLoraTriggerPrompt('pxart4, knight sword icon', 'PXART4'), 'pxart4, knight sword icon')

    const klein = { pipeline: { loader: 'flux2' } }
    assert.equal(supportsStyleLora(klein, 'kaggle'), true)
    assert.equal(supportsStyleLora(klein, 'local-gpu'), true)
    assert.equal(supportsStyleLora(klein, 'cloud-api'), false)
    assert.equal(supportsStyleLora({ pipeline: { loader: 'sdxl-lora' } }, 'kaggle'), false)

    assert.equal(STYLE_LORAS.length, GAME_STYLE_LORAS.length)
    assert.equal(searchStyleLoras({ category: 'game' }).length, 2)
    assert.equal(searchStyleLoras({ category: 'photography' }).some((item) => item.id === 'realism-detail'), true)
    assert.equal(searchStyleLoras({ mode: 'quality' }).some((item) => item.id === 'old-gods'), true)
    assert.equal(searchStyleLoras({ keyword: '像素' }).some((item) => item.id === 'pixel-art'), true)
    assert.ok(styleLoraCatalogText().includes('pixel-art'))
    assert.ok(styleLoraCatalogText().includes('realism-detail'))
  })

  await check('Host JobQueue：校验 LoRA、写入 taskPayload 与 meta.json、拒绝不兼容后端/预设', async () => {
    const dir = await makeTempDir('aigc-game-style-host-')
    const mock = startMockWorker()
    const origin = await mock.start()
    const fake = createFakeContext(dir)
    const host = await startHost(fake.routes)
    fake.setOrigin(host.origin)
    const app = createApp({ ctx: fake.ctx, config: { devEndpoint: origin, devToken: DEV_TOKEN, pollIntervalMs: 20 } })
    try {
      await app.settings.whenReady()
      await app.settings.save({ provider: 'kaggle' })

      const badModel = app.queue.submit({
        prompt: 'pixel sword',
        presetId: 'sdxl-lightning',
        lora: { id: 'pixel-art' },
      })
      assert.equal(badModel.ok, false)
      assert.equal(badModel.code, 'invalid_request')

      const okSubmit = app.queue.submit({
        prompt: 'a gleaming knight shield icon',
        presetId: 'flux2-klein-4b',
        lora: { id: 'pixel-art', scale: 0.9 },
      })
      assert.equal(okSubmit.ok, true)
      const job = await app.queue.waitFor(okSubmit.job.id, 10)
      assert.equal(job.status, 'done')

      assert.equal(mock.bodies.length, 1)
      assert.deepEqual(mock.bodies[0].pipeline.lora, {
        repo: 'adirik/pixel-art-lora-flux.2-klein-4B',
        weight: 'pixelart_lora.safetensors',
        scale: 0.9,
      })
      assert.equal(mock.bodies[0].tasks[0].prompt, 'PXART4, a gleaming knight shield icon')

      const metaPath = join(dir, 'outputs', job.output.dir.split('/')[1], 'meta.json')
      const meta = JSON.parse(await readFile(metaPath, 'utf8'))
      assert.equal(meta.params.lora.id, 'pixel-art')
      assert.equal(meta.params.lora.scale, 0.9)
      assert.equal(meta.params.prompt, 'a gleaming knight shield icon', 'meta 保留原始提示词，不污染编辑态')
    } finally {
      app.dispose()
      await closeServer(host.server)
      await mock.close()
    }
  })

  await check('Client logic：锁定保留跨新建、请求体拼装、回填与再生成', () => {
    const base = { prompt: 'knight', negative: '', presetId: 'flux2-klein-4b', width: 1024, height: 1024, steps: 4, cfg: 1, seed: '42', count: 1, references: [] }
    const lockedStyle = { id: 'pixel-art', repo: 'adirik/pixel-art-lora-flux.2-klein-4B', weight: 'pixelart_lora.safetensors', scale: 0.9, trigger: 'PXART4' }

    // 未选择时请求体不含 lora 键
    const plainBody = buildGenerateBody(base)
    assert.equal(Object.prototype.hasOwnProperty.call(plainBody, 'lora'), false)

    const withStyleBody = buildGenerateBody({ ...base, styleLora: lockedStyle }, { loraActive: true })
    assert.equal(withStyleBody.lora.id, 'pixel-art')

    // 未锁定时新建创作清空 styleLora；锁定时保留
    const resetPatch = newCreationPatch({ ...base, styleLora: lockedStyle, styleLocked: false }, { id: 'flux2-klein-4b' })
    assert.equal(resetPatch.styleLora, null)
    const keepPatch = newCreationPatch({ ...base, styleLora: lockedStyle, styleLocked: true }, { id: 'flux2-klein-4b' })
    assert.equal(Object.prototype.hasOwnProperty.call(keepPatch, 'styleLora'), false)

    // styleLoraChangedOf 独立跟踪风格变更
    const cleanSnap = formSnapshotOf({ ...base, styleLora: null })
    assert.equal(styleLoraChangedOf({ ...base, styleLora: lockedStyle }, cleanSnap), true)

    // 回填与重抽恢复 styleLora
    const presets = [{ id: 'flux2-klein-4b', size: 1024, steps: 4, cfg: 1 }]
    const entry = {
      image: { width: 1024, height: 1024, seed: 42 },
      item: { presetId: 'flux2-klein-4b', prompt: 'knight', params: { steps: 4, cfg: 1, lora: lockedStyle } },
    }
    assert.equal(iteratePatch(entry, base, presets).styleLora.id, 'pixel-art')
    assert.equal(rerollOverrides(entry, presets).lora.id, 'pixel-art')
  })

  await check('UI：FLUX.2 显示风格锁定面板，PBR 展示已接入的 CHORD', async () => {
    const client = await createTestClient({ now: Date.now(), testBuild: true })
    try {
      const { Rail, WorkshopParams } = client.components
      const t = client.internals.i18n.fallbackTranslate('zh-CN')
      const patched = []
      const fluxPreset = { id: 'flux2-klein-4b', label: 'FLUX.2 Klein 4B', size: 1024, steps: 4, cfg: 1, pipeline: { loader: 'flux2' } }
      let tree = await client.mountRaw(Rail, {
        t,
        isEn: false,
        ui: {
          advancedOpen: false,
          toggleAdvancedOpen: () => {},
          negativeOpen: false,
          setNegativeOpen: () => {},
          panelMode: 'form',
          setPanelMode: () => {},
        },
        compute: { provider: 'kaggle', hfTokenConfigured: true },
        form: {
          form: { prompt: 'shield', negative: '', presetId: 'flux2-klein-4b', width: 1024, height: 1024, steps: 4, cfg: 1, seed: '', count: 1, references: [], styleLora: null, styleLocked: false },
          patchForm: (p) => patched.push(p),
          ratioId: '1:1',
          activePreset: fluxPreset,
          applyRatio: () => {},
          applyCustomSize: () => {},
          applyCfg: () => {},
          resetSeed: () => {},
          negativeActive: false,
          negativeHint: '',
          refineGroups: [],
          refineOriginPrompt: '',
          refineSelectedIds: [],
          refineNotice: null,
          dismissRefineNotice: () => {},
          enhancing: false,
          mergingRefine: false,
          enhance: () => {},
          translating: false,
          translate: () => {},
          toggleRefineOption: () => {},
          clearRefineSelection: () => {},
          applyRefineTweaks: () => {},
          restoreRefineOrigin: () => {},
          toggleRefine: () => {},
          englishPromptHint: false,
          newCreation: () => {},
          draftView: { active: false },
          cleanBaseline: '',
          referenceSupported: true,
          referenceSwitchLabel: '',
          referenceMax: 4,
        },
        library: { gallery: [], importLocked: false },
        actions: { sending: false, generate: () => {} },
      })
      const railText = collectText(tree).join(' ')
      assert.ok(railText.includes('风格锁定'), 'FLUX.2 下显示风格锁定标题')
      const styleToggle = findNodes(tree, (n) => n.type === 'button' && n.props?.['aria-label'] === '风格锁定')[0]
      assert.ok(styleToggle, '存在风格锁定折叠开关')
      styleToggle.props.onClick({ stopPropagation() {} })
      tree = await client.rerenderRaw()
      const chips = nodesByClass(tree, 'ofs-style-chip')
      assert.equal(chips.length, 6, '包含 原生 + 4 内置 + 自定义')
      const pixelChip = chips.find((n) => collectText(n).join('') === '像素风')
      pixelChip.props.onClick()
      assert.equal(patched[0].styleLora.id, 'pixel-art')

      const pbrTree = await client.mountRaw(WorkshopParams, {
        t,
        tool: 'pbr',
        guideOpen: false,
        pixel: { cell: 16, colors: 16, alphaThreshold: 128, scale: 1 },
        sprite: { rows: 2, cols: 2, frameMs: 120, trimAlpha: true },
        tile: { blend: false, blendRatio: 0.15 },
        vector: { colormode: 'color', mode: 'spline', colorPrecision: 6, filterSpeckle: 4, hierarchy: 'stacked' },
        pbrExecution: 'cloud',
        setPbrExecution: () => {},
        pbrCapability: { available: false, reason: 'gpu' },
        pbrModel: 'marigold',
        setPbrModel: () => {},
        pbrSteps: 4,
        setPbrSteps: () => {},
        canApply: true,
        canRunGpu: true,
        modelReady: true,
        onRunGpu: () => {},
      })
      const pbrText = collectText(pbrTree).join(' ')
      assert.ok(pbrText.includes('Marigold'))
      assert.ok(pbrText.includes('Ubisoft CHORD'), '已接入的 CHORD 应在 PBR 模型选择器暴露')
    } finally {
      client.unmount()
    }
  })

  summary()
} finally {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
}
