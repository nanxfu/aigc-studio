/**
 * 精度档（variants）离线契约：自动路由、显式选择与公开精度选项。
 *
 * 只读 shared/variants.js 与生成后的模型快照，不启动 Host / Worker。
 *
 * 运行：node test/check-variants.mjs
 */

import assert from 'node:assert/strict'

import { PRESETS } from '../shared/contract.js'
import { PUBLIC_PRESETS } from '../shared/models.generated.js'
import {
  AUTO_VARIANT_ID,
  FULL_VARIANT_ID,
  precisionOptionsOf,
  resolveVariant,
  variantLabelOf,
  variantRequestOf,
} from '../shared/variants.js'
import {
  buildGenerateBody,
  iteratePatch,
  rerollOverrides,
  retryOverrides,
} from '../web/logic/generate.js'
import { formSnapshotOf } from '../web/logic/form.js'
import { presetSelectPatch } from '../web/logic/preset.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()
const zImage = PRESETS.find((item) => item.id === 'z-image-turbo')
const zImagePublic = PUBLIC_PRESETS.find((item) => item.id === 'z-image-turbo')
const sdxl = PRESETS.find((item) => item.id === 'sdxl-lightning')

await check('Z-Image 满血档从 pipeline 回退读取下载体积', () => {
  const result = resolveVariant(zImage, undefined, 'salad')
  assert.equal(result.ok, true)
  assert.equal(result.id, FULL_VARIANT_ID)
  assert.equal(result.downloadGb, 30.64)
  assert.equal(result.pipeline.loader, 'zimage')
  assert.equal(result.quantizationScheme, null)
})

await check('显式 auto 在 Salad 上选择轻量档，并返回完整 pipeline', () => {
  const result = resolveVariant(zImage, AUTO_VARIANT_ID, 'salad')
  assert.equal(result.ok, true)
  assert.equal(result.id, 'compact-q4')
  assert.equal(result.downloadGb, 11.23)
  assert.equal(result.quantizationScheme, 'gguf')
  assert.equal(result.pipeline.downloads.length, 2)
  assert.equal(result.pipeline.quantization.components.transformer.file, 'z-image-turbo-Q4_K_M.gguf')
})

await check('显式 auto 在非 Salad 来源保持满血，避免无实测时误降画质', () => {
  for (const provider of ['colab', 'private-worker', 'kaggle']) {
    const result = resolveVariant(zImage, AUTO_VARIANT_ID, provider)
    assert.equal(result.ok, true)
    assert.equal(result.id, FULL_VARIANT_ID)
  }
})

await check('显式精度档必须命中且 provider 允许', () => {
  const compact = resolveVariant(zImage, 'compact-q4', 'colab')
  assert.equal(compact.ok, true)
  assert.equal(compact.id, 'compact-q4')

  const blocked = resolveVariant(zImage, 'compact-q4', 'kaggle')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'invalid_request')
  assert.match(blocked.message, /不支持当前算力来源/)

  const unknown = resolveVariant(zImage, 'nope', 'salad')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'invalid_request')
  assert.match(unknown.message, /未知精度档/)

  const badType = resolveVariant(zImage, 42, 'salad')
  assert.equal(badType.ok, false)
  assert.equal(badType.code, 'invalid_request')
})

await check('full 是保留值；没有 variants 的模型 auto 仍是满血', () => {
  const full = resolveVariant(zImage, FULL_VARIANT_ID, 'salad')
  assert.equal(full.ok, true)
  assert.equal(full.id, FULL_VARIANT_ID)

  const oldModel = resolveVariant(sdxl, 'auto', 'salad')
  assert.equal(oldModel.ok, true)
  assert.equal(oldModel.id, FULL_VARIANT_ID)
  assert.equal(oldModel.downloadGb, 6.78)
})

await check('公开快照只暴露 precisionOptions，不泄露 pipeline / variants', () => {
  assert.equal(Object.hasOwn(zImagePublic, 'pipeline'), false)
  assert.equal(Object.hasOwn(zImagePublic, 'variants'), false)
  const options = precisionOptionsOf(zImagePublic)
  assert.deepEqual(options.map((item) => item.id), ['full', 'compact-q4'])
  assert.equal(options[0].precision, 'BF16')
  assert.equal(options[1].precision, 'GGUF Q4_K_M')
  assert.equal(options[1].downloadGb, 11.23)
  assert.equal(variantLabelOf(options[1], false), '轻量 Q4')
  assert.equal(variantLabelOf(options[1], true), 'Compact Q4')

  const plain = PUBLIC_PRESETS.find((item) => item.id === 'sdxl-lightning')
  assert.equal(Object.hasOwn(plain, 'precisionOptions'), false)
})

await check('客户端请求体透传 variantId，空值不写字段', () => {
  const base = { presetId: 'z-image-turbo', prompt: 'a cat', width: 1024, height: 1024 }
  assert.equal(buildGenerateBody({ ...base, variantId: 'auto' }).variantId, 'auto')
  assert.equal(buildGenerateBody({ ...base, variantId: 'compact-q4' }).variantId, 'compact-q4')
  assert.equal(buildGenerateBody({ ...base, variantId: '  full  ' }).variantId, 'full')
  assert.equal(Object.hasOwn(buildGenerateBody({ ...base, variantId: '' }), 'variantId'), false)
})

await check('新客户端表单：有档位时空值/非法值回落 auto，无档位不下发', () => {
  assert.equal(variantRequestOf(zImagePublic, ''), 'auto')
  assert.equal(variantRequestOf(zImagePublic, 'nope'), 'auto')
  assert.equal(variantRequestOf(zImagePublic, 'compact-q4'), 'compact-q4')
  assert.equal(variantRequestOf(zImagePublic, 'full'), 'full')
  assert.equal(variantRequestOf(PUBLIC_PRESETS.find((item) => item.id === 'sdxl-lightning'), 'auto'), '')
})

await check('切换精度档也算未提交修改，草稿不会丢掉选择', () => {
  const base = { prompt: 'cat', negative: '', presetId: 'z-image-turbo', seed: '42', width: 1024, height: 1024 }
  assert.notEqual(
    formSnapshotOf({ ...base, variantId: 'auto' }),
    formSnapshotOf({ ...base, variantId: 'compact-q4' }),
  )
})

await check('回填 / 变体 / 重试保留产物实际精度档', () => {
  const entry = {
    image: { path: 'outputs/a/01.png', width: 1024, height: 1024, seed: 42 },
    item: {
      presetId: 'z-image-turbo',
      variantId: 'compact-q4',
      params: { prompt: 'cat', width: 1024, height: 1024, steps: 9, cfg: 0, seed: 42 },
      images: [],
    },
  }
  const patch = iteratePatch(entry, {}, PUBLIC_PRESETS, [])
  assert.equal(patch.variantId, 'compact-q4')
  const reroll = rerollOverrides(entry, PUBLIC_PRESETS, [], null)
  assert.equal(reroll.variantId, 'compact-q4')
  const retry = retryOverrides({ presetId: 'z-image-turbo', variantId: 'compact-q4', params: { prompt: 'cat' } })
  assert.equal(retry.variantId, 'compact-q4')

  const oldEntry = { ...entry, item: { ...entry.item, variantId: null } }
  assert.equal(Object.hasOwn(iteratePatch(oldEntry, {}, PUBLIC_PRESETS, []), 'variantId'), false)
  assert.equal(
    buildGenerateBody(
      { presetId: 'z-image-turbo', prompt: 'cat', variantId: 'full' },
      { overrides: { variantId: 'compact-q4' } },
    ).variantId,
    'compact-q4',
  )
})

await check('切模型时精度档跟随：有档位默认 auto，无档位清空', () => {
  const toZImage = presetSelectPatch(
    zImagePublic,
    { presetId: 'sdxl-lightning', width: 1024, height: 1024, variantId: '' },
    PUBLIC_PRESETS,
  )
  assert.equal(toZImage.variantId, 'auto')

  const keepCompact = presetSelectPatch(
    zImagePublic,
    { presetId: 'z-image-turbo', width: 1024, height: 1024, variantId: 'compact-q4' },
    PUBLIC_PRESETS,
  )
  assert.equal(keepCompact.variantId, 'compact-q4')

  const toPlain = presetSelectPatch(
    PUBLIC_PRESETS.find((item) => item.id === 'sdxl-lightning'),
    { presetId: 'z-image-turbo', width: 1024, height: 1024, variantId: 'compact-q4' },
    PUBLIC_PRESETS,
  )
  assert.equal(toPlain.variantId, '')
})

summary()
