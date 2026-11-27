#!/usr/bin/env node
/**
 * 工坊「类 Jev（System One）」感知层 L1 的离线回归（M4.2c Phase 1）。
 *
 * 覆盖 `web/logic/workshopPerception.js` 的纯逻辑，不依赖浏览器、canvas 或网络：
 *  - 六类场景构造样本（普通风景照、白底道具、像素画、4×4 序列帧、无缝材质、扁平图标）
 *    的 Choice 原语是否命中、概率是否归一、主推荐工具是否正确；
 *  - 三路信号的分工：本地导入图无 prompt 时仍按图像特征判定；prompt 只加分不翻盘；
 *    模型 `sceneTags` 加分同样不越过强图像证据；
 *  - 衍生状态去重：已抠图 / 已做 PBR 的派生图不再推荐同一个工具，改推下一步；
 *  - 场景只由引擎判定（不接受外部覆盖）与 `showStudioReturnHint`（完整画作返回创作台）的触发边界；
 *  - 工作流接力的五条链路；
 *  - 采样降幅与性能护栏（长边 512px 仍远低于交互预算）。
 *
 * 运行：node test/check-client-workshop-perception.mjs
 */

import assert from 'node:assert/strict'

import { WORKSHOP } from '../shared/contract.js'
import {
  normalizeWorkshopPerceptionTag,
} from '../shared/workshop-scenes.js'
import {
  WORKSHOP_SCENES,
  applyWorkshopPerceptionTag,
  derivedToolsOf,
  extractPixelFeatures,
  mergeWorkshopPerception,
  nextToolSuggestions,
  perceiveWorkshopWork,
  resolveWorkshopRootContext,
  samplePixels,
  scorePromptSignal,
  toolsForScene,
  workshopPerceptionTagFromResult,
  workshopToolGroups,
} from '../web/logic/workshopPerception.js'
import {
  clearPixelCache,
  pixelCacheStats,
  pixelsOfUrl,
  workshopVisionPixels,
} from '../web/studio/workshop/pixels.js'
import { createCheckRunner } from './helpers/check.mjs'
import { SCENE_SAMPLES, buildPhoto, createImage } from './helpers/workshop-samples.mjs'

const { check, summary } = createCheckRunner()

// ── 测试图像构造 ──────────────────────────────────────────────────────────

const sampleOf = (name) => SCENE_SAMPLES.find((sample) => sample.name === name)

/** 纯色空白图：用于验证「无信号时让位给提示词」。 */
function blankImage(size = 64) {
  const image = createImage(size, size)
  image.fill(255, 255, 255)
  return image
}

/** 概率分布必须归一且非负（Choice 原语的自洽性）。 */
function assertDistribution(probs) {
  const keys = Object.keys(probs)
  assert.deepEqual(keys.slice().sort(), WORKSHOP_SCENES.slice().sort(), '概率分布必须覆盖全部场景')
  let total = 0
  for (const key of keys) {
    assert.ok(Number.isFinite(probs[key]), `${key} 的概率必须是有限数字`)
    assert.ok(probs[key] >= 0, `${key} 的概率不能为负`)
    total += probs[key]
  }
  assert.ok(Math.abs(total - 1) < 1e-9, `概率之和必须为 1，实际 ${total}`)
}

// ── 1. 六类场景的分流 ─────────────────────────────────────────────────────

await check('L1 分流：六类场景构造样本各自命中预期场景，且概率分布归一', async () => {
  for (const sample of SCENE_SAMPLES) {
    const result = perceiveWorkshopWork({ pixels: sample.image, item: { source: 'ai' } })
    assertDistribution(result.sceneProbs)
    assert.equal(result.source, 'l1-heuristic', '当前只有 L1 基线引擎')
    assert.equal(result.scene, sample.scene, `${sample.name} 应判定为 ${sample.scene}，实际 ${result.scene}`)
    const top = Object.entries(result.sceneProbs).sort((left, right) => right[1] - left[1])[0][0]
    assert.equal(top, sample.scene, `${sample.name} 的最高概率场景应与判定一致`)
    assert.ok(result.sceneProbs[sample.scene] >= 0.5, `${sample.name} 的命中概率应过半（≥0.5）`)
  }
})

await check('L1 分流：场景推荐工具的第一项就是首屏默认工具', async () => {
  for (const sample of SCENE_SAMPLES) {
    const result = perceiveWorkshopWork({ pixels: sample.image, item: { source: 'ai' } })
    assert.equal(result.recommendedTools[0], sample.tool, `${sample.name} 的主推荐应为 ${sample.tool}`)
    assert.ok(result.recommendedTools.length >= 1 && result.recommendedTools.length <= 3, '推荐 1~3 个工具')
    for (const tool of result.recommendedTools) {
      assert.ok(WORKSHOP.tools.includes(tool), `${tool} 必须在契约工具白名单内`)
    }
  }
})

await check('L1 分流：场景 → 工具优先级只使用契约内的工具 id', async () => {
  for (const scene of WORKSHOP_SCENES) {
    const list = toolsForScene(scene)
    assert.ok(list.length > 0, `${scene} 必须有推荐工具`)
    for (const tool of list) assert.ok(WORKSHOP.tools.includes(tool), `${scene} 推荐了未知工具 ${tool}`)
  }
  assert.deepEqual(toolsForScene('pixel_art')[0], 'pixel-snap')
  assert.deepEqual(toolsForScene('sprite_sheet')[0], 'sprite-slice')
})

// ── 2. 专业倾向度与返回创作台 ──────────────────────────────────────────────

await check('Score：普通风景照的专业倾向度低于阈值并给出返回创作台提示', async () => {
  const photo = sampleOf('普通风景照')
  const result = perceiveWorkshopWork({ pixels: photo.image, item: { source: 'ai' } })
  assert.ok(
    result.professionalScore < WORKSHOP.professionalThreshold,
    `风景照 professionalScore=${result.professionalScore} 应低于阈值 ${WORKSHOP.professionalThreshold}`,
  )
  assert.equal(result.showStudioReturnHint, true, '完整画作应提示返回创作台精修')
  assert.equal(result.recommendedTools[0], 'cutout', '普通用户默认落在「抹除背景」而不是像素工具')
})

await check('Score：游戏资产场景的专业倾向度高于阈值，不弹返回创作台提示', async () => {
  for (const name of ['像素画', '4×4 序列帧', '白底道具']) {
    const sample = sampleOf(name)
    const result = perceiveWorkshopWork({ pixels: sample.image, item: { source: 'ai' } })
    assert.ok(
      result.professionalScore >= WORKSHOP.professionalThreshold,
      `${name} 的 professionalScore=${result.professionalScore} 应达到阈值`,
    )
    assert.equal(result.showStudioReturnHint, false, `${name} 不需要返回创作台引导`)
  }
})

// ── 3. 三路信号的分工 ────────────────────────────────────────────────────

await check('信号 B：本地导入图没有 prompt 也按图像特征判定（降级不失效）', async () => {
  const icon = sampleOf('扁平图标')
  const result = perceiveWorkshopWork({
    pixels: icon.image,
    item: { source: 'import', prompt: '', presetId: null, rootPrompt: null },
  })
  assert.equal(result.scene, 'flat_icon_logo', '无 prompt 的导入图仍应识别为扁平图标')
  const prompt = scorePromptSignal('')
  assert.deepEqual(Object.values(prompt), WORKSHOP_SCENES.map(() => 0), '空提示词不产生任何证据')
})

await check('信号 B：提示词只加分不翻盘，长词组不重复计数', async () => {
  // 风景照 + 写了 pixel art：图像证据仍然占主导。
  const photo = sampleOf('普通风景照')
  const result = perceiveWorkshopWork({
    pixels: photo.image,
    item: { source: 'ai', rootPrompt: 'pixel art, 16-bit hero' },
  })
  assert.equal(result.scene, 'illustration_or_photo', 'prompt 不能一票否决图像客观特征')

  // 空白图 + 写了 sprite sheet：提示词足以把场景拉到序列帧。
  const blank = blankImage(64)
  const hinted = perceiveWorkshopWork({
    pixels: blank,
    item: { source: 'ai', prompt: 'character sprite sheet, walk cycle 4x4' },
  })
  assert.equal(hinted.scene, 'sprite_sheet', '提示词命中序列帧词组时应给出序列帧场景')

  const sheet = scorePromptSignal('sprite sheet')
  assert.equal(sheet.pixel_art, 0, '`sprite` 不能从 `sprite sheet` 里重复计分')
  assert.ok(sheet.sprite_sheet > 0, '`sprite sheet` 应计入序列帧证据')

  // 常见海报 / 插画提示词里的 "paper grain texture" 不得被裸词 "texture" 误判为无缝平铺材质。
  const posterPrior = perceiveWorkshopWork({
    pixels: null,
    item: {
      source: 'ai',
      prompt: 'A minimalist Swiss-style exhibition poster. Flat vector graphic aesthetic, subtle paper grain texture, balanced negative space.',
    },
  })
  assert.ok(
    scorePromptSignal('paper grain texture').seamless_texture > 0,
    '裸词 texture 已恢复到词表，由权重模型而不是删词来防止误判',
  )
  assert.notEqual(
    posterPrior.recommendedTools[0],
    'tile',
    '普通海报里的 paper grain texture 不应被先验误判成无缝平铺',
  )
  assert.ok(
    posterPrior.professionalScore < WORKSHOP.professionalThreshold,
    `无像素普通海报的专业度 ${posterPrior.professionalScore} 应低于阈值`,
  )
})

await check('无像素纯 prompt：单个弱关键词不越过专业阈值；硬先验仍可直接落焦', () => {
  for (const prompt of ['paper grain texture', 'brick wall', 'gold sword']) {
    const result = perceiveWorkshopWork({
      pixels: null,
      item: { source: 'ai', prompt },
    })
    assert.ok(
      result.professionalScore < WORKSHOP.professionalThreshold,
      `“${prompt}” 的专业度 ${result.professionalScore} 不应越过 ${WORKSHOP.professionalThreshold}`,
    )
    assert.equal(result.recommendedTools[0], 'cutout', `“${prompt}” 应保持普通图的默认落点`)
  }

  // sceneTags 是确定性硬先验：无像素时仍可立即把场景 / 推荐拉到像素画。
  const tagged = perceiveWorkshopWork({
    pixels: null,
    item: { source: 'ai' },
    preset: { sceneTags: ['pixel_art'] },
  })
  assert.equal(tagged.scene, 'pixel_art')
  assert.equal(tagged.recommendedTools[0], 'pixel-snap')
  assert.ok(tagged.professionalScore >= WORKSHOP.professionalThreshold)

  // doneTools 同样属于硬先验：工坊产物不会因为「无像素」退回普通图基线。
  const derived = perceiveWorkshopWork({
    pixels: null,
    item: {
      source: 'ai',
      workshop: true,
      workshopTool: 'cutout',
      rootPrompt: 'isometric game item, white background',
      channels: [{ role: 'cutout' }],
    },
  })
  assert.equal(derived.derived.hardPrior, true)
  assert.ok(!derived.recommendedTools.includes('cutout'))
  assert.equal(derived.recommendedTools[0], 'pbr')
})

await check('信号 A：模型 sceneTags 加分但不越过强图像证据', async () => {
  const photo = sampleOf('普通风景照')
  const tagged = perceiveWorkshopWork({
    pixels: photo.image,
    item: { source: 'ai' },
    preset: { sceneTags: ['pixel_art'] },
  })
  assert.equal(tagged.scene, 'illustration_or_photo', '单靠 sceneTags 不能把照片判成像素画')

  const pixelPreset = perceiveWorkshopWork({
    pixels: sampleOf('像素画').image,
    item: { source: 'ai' },
    preset: { sceneTags: ['pixel_art', '未知标签'] },
  })
  assert.equal(pixelPreset.scene, 'pixel_art')
  assert.ok(pixelPreset.sceneProbs.pixel_art >= 0.9, '图像 + 模型标签同向时命中概率应很高')
})

await check('信号 C：Alpha 已存在的图不再推荐抠图（needsCutout 归零）', async () => {
  const prop = sampleOf('白底道具')
  const opaque = perceiveWorkshopWork({ pixels: prop.image, item: { source: 'ai' } })
  assert.ok(opaque.noul.needsCutout >= 0.7, `白底道具的 needsCutout=${opaque.noul.needsCutout} 应很高`)

  // 把主体外的白底改成全透明，模拟已经抠完的派生图。
  const cut = createImage(prop.image.width, prop.image.height)
  cut.fill(0, 0, 0, 0)
  const source = prop.image.data
  for (let offset = 0; offset < source.length; offset += 4) {
    if (source[offset + 3] === 255 && source[offset] !== 255) {
      cut.data[offset] = source[offset]
      cut.data[offset + 1] = source[offset + 1]
      cut.data[offset + 2] = source[offset + 2]
      cut.data[offset + 3] = 255
    }
  }
  const transparent = perceiveWorkshopWork({ pixels: cut, item: { source: 'ai' } })
  assert.ok(
    transparent.noul.needsCutout <= 0.1,
    `已有透明像素时 needsCutout=${transparent.noul.needsCutout} 应接近 0`,
  )
  assert.ok(!transparent.recommendedTools.includes('cutout'), '已透明的图不该再推荐抠图')
  assert.equal(transparent.showStudioReturnHint, false, '已透明的抠图产物不该再弹出「回创作台精修」')
})

// ── 4. 衍生状态去重 ──────────────────────────────────────────────────────

await check('衍生去重：cutout 派生图结合 rootPrompt 跳过重复抠图，改推下一步', async () => {
  const prop = sampleOf('白底道具')
  const derived = {
    source: 'ai',
    workshop: true,
    workshopTool: 'cutout',
    rootPrompt: 'isometric healing potion, game item, white background',
    channels: [{ role: 'cutout', format: 'png' }],
  }
  const result = perceiveWorkshopWork({ pixels: prop.image, item: derived })
  assert.deepEqual(
    result.derived.doneTools.sort(),
    ['cutout'],
    '派生状态应记录已经做过抠图',
  )
  assert.equal(result.scene, 'isolated_prop', 'rootPrompt 提供道具先验')
  assert.ok(!result.recommendedTools.includes('cutout'), '不能重复推荐已经做过的抠图')
  assert.equal(result.recommendedTools[0], 'pbr', '下一步应推 PBR 材质拆解')
})

await check('衍生去重：PBR 四通道通道说明材质已拆，不再推荐 pbr', async () => {
  const texture = sampleOf('无缝材质')
  const done = derivedToolsOf({
    workshopTool: 'pbr',
    channels: ['albedo', 'normal', 'roughness', 'metallic'].map((role) => ({ role })),
  })
  assert.deepEqual([...done], ['pbr'], 'pbr 与实际通道是同一个工具')
  const result = perceiveWorkshopWork({
    pixels: texture.image,
    item: { source: 'ai', workshopTool: 'pbr', channels: [{ role: 'albedo' }] },
  })
  assert.ok(!result.recommendedTools.includes('pbr'), '已拆过材质的不再推 pbr')
})

await check('衍生去重：depth + normal 只表示深度已算，不能误判 PBR 已完成', async () => {
  const done = derivedToolsOf({
    workshopTool: 'depth-fx',
    channels: [{ role: 'depth' }, { role: 'normal' }],
  })
  assert.ok(done.has('depth-fx'))
  assert.ok(!done.has('pbr'), 'depth 附带法线不等于 PBR 四通道已完成')
  const relit = derivedToolsOf({
    workshopTool: 'relight',
    channels: [{ role: 'relit' }, { role: 'depth' }, { role: 'normal' }],
  })
  assert.ok(relit.has('relight'))
  assert.ok(!relit.has('pbr'))
})

// ── 5. 场景只在内部判定 ──────────────────────────────────────────────────

await check('场景判定：只由引擎决定，不接受外部场景覆盖参数', async () => {
  const photo = sampleOf('普通风景照')
  // Phase 1b 起前台不再有「6 选 1」纠偏墙，引擎也不该留一个能绕过图像证据的口子。
  const forced = perceiveWorkshopWork({
    pixels: photo.image,
    item: { source: 'ai' },
    sceneOverride: 'pixel_art',
  })
  assert.equal(forced.scene, 'illustration_or_photo', '外部传入的场景值必须被忽略')
  assert.equal(forced.overridden, undefined, '不再对外暴露 overridden 字段')
  assert.ok(forced.reasonKey.startsWith('studio.workshop.scene.reason.'), '理由仍是词典键')
  assertDistribution(forced.sceneProbs)
})

// ── 6. 工作流接力 ────────────────────────────────────────────────────────

await check('接力：五条链路的下一步建议都落在契约工具内', async () => {
  const prop = perceiveWorkshopWork({ pixels: sampleOf('白底道具').image, item: {} })
  const cutoutNext = nextToolSuggestions({ tool: 'cutout', perception: prop })
  assert.equal(cutoutNext[0].tool, 'pbr', '道具抠图后推 PBR 拆解')

  const icon = perceiveWorkshopWork({ pixels: sampleOf('扁平图标').image, item: {} })
  const iconNext = nextToolSuggestions({ tool: 'cutout', perception: icon })
  assert.equal(iconNext[0].tool, 'vectorize', '图标抠图后推矢量化')

  const sheet = perceiveWorkshopWork({ pixels: sampleOf('4×4 序列帧').image, item: {} })
  const sheetNext = nextToolSuggestions({ tool: 'cutout', perception: sheet })
  assert.equal(sheetNext[0].tool, 'sprite-slice', '多格动作图抠图后推序列帧切片')

  const pixelNext = nextToolSuggestions({ tool: 'pixel-snap', perception: sheet })
  assert.equal(pixelNext[0].tool, 'sprite-slice', '像素对齐后推序列帧切片')

  const tileNext = nextToolSuggestions({
    tool: 'tile',
    perception: perceiveWorkshopWork({ pixels: sampleOf('无缝材质').image, item: {} }),
  })
  assert.equal(tileNext[0].tool, 'pbr', '平铺完成后推 PBR 拆解')

  for (const list of [cutoutNext, iconNext, sheetNext, pixelNext, tileNext]) {
    for (const item of list) {
      assert.ok(WORKSHOP.tools.includes(item.tool), `${item.tool} 必须是契约工具`)
      assert.ok(item.reasonKey.startsWith('studio.workshop.handoff.reason.'), '理由必须是词典键')
    }
  }
  assert.equal(
    nextToolSuggestions({ tool: 'pbr', perception: prop })[0]?.tool,
    'depth-fx',
    'PBR 之后应把同一份材质与深度接给空间滤镜',
  )
  assert.deepEqual(nextToolSuggestions({ tool: 'unknown', perception: prop }), [], '未知工具不接力')
})

// ── 7. 分组与降级 ────────────────────────────────────────────────────────

await check('分组：平面与提取 / 游戏与 3D / 光影与空间三栏不重不漏地覆盖全部工具', async () => {
  const groups = workshopToolGroups()
  const union = [...groups.plane, ...groups.game3d, ...groups.atmosphere]
  assert.equal(union.length, WORKSHOP.tools.length, '三栏之和等于工具总数')
  assert.deepEqual(union.slice().sort(), WORKSHOP.tools.slice().sort(), '三栏必须覆盖全部工具')
  assert.deepEqual(groups.plane, ['cutout', 'vectorize', 'tile'], '平面与提取三项，顺序即顶栏顺序')
  assert.deepEqual(groups.game3d, ['pixel-snap', 'sprite-slice', 'pbr'], '游戏与 3D 三项')
  assert.deepEqual(groups.atmosphere, ['depth-fx', 'relight'], '光影与空间两项')
})

await check('降级：无像素 / 无 DOM 时安全返回兜底结果，不抛异常', async () => {
  for (const bad of [null, undefined, {}, { width: 0, height: 0, data: [] }, { width: 4, height: 4 }]) {
    const result = perceiveWorkshopWork({ pixels: bad, item: null })
    assertDistribution(result.sceneProbs)
    assert.equal(result.features, null, '非法像素输入时特征为 null')
    assert.equal(result.scene, 'illustration_or_photo', '无任何信号时回落到最普通的场景')
    assert.equal(result.professionalScore, 0, '没有任何信号时专业倾向度必须是 0，不能拿均匀分布冒充')
    assert.equal(
      result.showStudioReturnHint,
      false,
      '还没读到像素时不劝退：首屏按最普通场景兜底，不该提示「返回创作台」',
    )
    assert.ok(result.recommendedTools.length > 0, '兜底也要给出推荐工具')
    assert.ok(result.noul.needsCutout >= 0 && result.noul.needsCutout <= 1)
  }
  // 纯白图同样没有场景信息：不劝退，但给出常用工具。
  const blankResult = perceiveWorkshopWork({ pixels: blankImage(64), item: {} })
  assert.equal(blankResult.scene, 'illustration_or_photo')
  assert.equal(blankResult.showStudioReturnHint, false, '纯色空白图不触发返回创作台提示')
  assert.equal(blankResult.recommendedTools[0], 'cutout', '空白图仍推荐最安全的抹除背景')
  assert.equal(extractPixelFeatures(null), null)
  assert.equal(samplePixels({ width: 8, height: 8, data: new Uint8Array(8) }), null, '像素长度不足时返回 null')
})

await check('采样：长边超过 256 的图按步长降采样，特征计算与图幅解耦', async () => {
  const photo = buildPhoto(768)
  const sample = samplePixels(photo, 256)
  assert.ok(sample.step >= 3, `768px 图的采样步长应为 3，实际 ${sample.step}`)
  assert.ok(Math.max(sample.width, sample.height) <= 256, '采样后长边不超过 256')
  const features = extractPixelFeatures(photo)
  assert.ok(features && features.width <= 256, '特征提取内部同样走降采样')
})

// ── 8. 性能护栏 ──────────────────────────────────────────────────────────

await check('性能：大图的 L1 感知与图幅解耦，仍低于交互预算', async () => {
  const small = buildPhoto(256)
  const large = buildPhoto(1024)
  // 先各跑一次预热，避免把 JIT 编译时间算进读数。
  perceiveWorkshopWork({ pixels: small, item: {} })
  perceiveWorkshopWork({ pixels: large, item: {} })
  const started = Date.now()
  const result = perceiveWorkshopWork({ pixels: large, item: {} })
  const elapsed = Date.now() - started
  assert.ok(result.latencyMs >= 0, '延迟读数应为非负数')
  // 设计目标是 <10ms（256px 采样）。这里留足 CI 抖动余量，只用来卡住
  // 「把周期网格 / 接缝评估退回全分辨率」这类会让 1024px 直接超百毫秒的回归。
  assert.ok(elapsed < 100, `1024px 单次感知耗时 ${elapsed}ms，超出护栏`)
  assert.equal(result.features.width, 256, '1024px 图应采样到 256px 再算特征')
})

await check('根作品先验：旧派生记录按 rootImage 补齐已加载根图，不覆盖 Host 字段', () => {
  const rootPath = 'outputs/root-pixel/01.png'
  const root = { prompt: 'pixel art, 16-bit hero', presetId: 'pixel-model' }
  const works = [{ image: { path: rootPath }, item: root }]
  const derived = { rootImage: rootPath, workshop: true, prompt: 'hero-cutout.png' }
  const before = JSON.stringify({ derived, works })
  assert.deepEqual(resolveWorkshopRootContext(derived, works), {
    rootPrompt: root.prompt,
    rootPresetId: root.presetId,
  })
  assert.deepEqual(resolveWorkshopRootContext({ ...derived, rootPrompt: 'seamless texture' }, works), {
    rootPrompt: 'seamless texture',
    rootPresetId: root.presetId,
  })
  assert.equal(JSON.stringify({ derived, works }), before, '不能修改图库或作品记录')
})

await check('根作品先验：缺根、导入根图与工坊作品名安全降级，不能借用其它图的意图', () => {
  const path = 'outputs/root/01.png'
  const item = { rootImage: path }
  const empty = { rootPrompt: null, rootPresetId: null }
  assert.deepEqual(resolveWorkshopRootContext(item, [{ image: { path: 'other' }, item: { prompt: 'pixel art' } }]), empty)
  assert.deepEqual(resolveWorkshopRootContext(item, [{ image: { path }, item: { source: 'import', prompt: 'pixel art' } }]), empty)
  assert.deepEqual(resolveWorkshopRootContext(item, [{ image: { path }, item: { workshop: true, prompt: 'pixel-cutout.png' } }]), empty)
  assert.deepEqual(resolveWorkshopRootContext({ source: 'import', rootPrompt: 'pixel art' }), empty)
  assert.deepEqual(resolveWorkshopRootContext(null), empty)
})

// ── 9. L2 渐进融合（M4.2c Phase 2）────────────────────────────────────────

/** 构造一份形状完整、可被 merge 的 L2 结果；概率默认集中在 `scene`。 */
function visionOf(scene, options = {}) {
  const sceneProbs = Object.fromEntries(WORKSHOP_SCENES.map((name) => [name, 0]))
  const top = Number.isFinite(Number(options.top)) ? Number(options.top) : 0.8
  sceneProbs[scene] = top
  const rest = WORKSHOP_SCENES.filter((name) => name !== scene)
  for (const name of rest) sceneProbs[name] = (1 - top) / rest.length
  const second = Math.max(...rest.map((name) => sceneProbs[name]))
  return {
    source: 'l2-onnx-vision',
    model: 'mobileclip-s0-fp16',
    latencyMs: 42,
    scene,
    sceneProbs,
    confidence: {
      scene,
      top,
      margin: Number.isFinite(Number(options.margin)) ? Number(options.margin) : top - second,
    },
    noul: {
      needsCutout: 0.1,
      isGridSprite: 0.1,
      isPixelGrid: 0.1,
      isTileable: 0.1,
      isVectorFriendly: 0.1,
      wantsPbr: 0.1,
      ...(options.noul || {}),
    },
    professionalScore: 0.9,
    recommendedTools: toolsForScene(scene),
    showStudioReturnHint: false,
    reasonKey: `studio.workshop.scene.reason.${scene}`,
    reasonParams: { scene, score: 0.9 },
    features: null,
    derived: { doneTools: [], hasTransparency: false, priorTool: null },
  }
}

await check('L2 融合：高置信度 + 足够 margin 时覆盖 L1 场景，并保留 L1 像素特征', () => {
  const pixel = sampleOf('像素画')
  const l1 = perceiveWorkshopWork({ pixels: pixel.image, item: { source: 'ai' } })
  assert.equal(l1.scene, 'pixel_art')
  const merged = mergeWorkshopPerception(l1, visionOf('sprite_sheet', { top: 0.82 }))
  assert.equal(merged.source, 'l1+l2')
  assert.equal(merged.scene, 'sprite_sheet', '像素证据确认的像素画可升级为序列帧语义')
  assert.equal(merged.recommendedTools[0], 'sprite-slice')
  assert.deepEqual(merged.features, l1.features, 'L1 的像素特征必须原样保留')
  assert.equal(merged.vision.appliedScene, true)
  assert.equal(merged.vision.model, 'mobileclip-s0-fp16')
  assert.equal(merged.vision.latencyMs, 42)
})

await check('L2 融合：低置信度或 top1-top2 间隔不足时不覆盖 L1 场景', () => {
  const pixel = sampleOf('像素画')
  const l1 = perceiveWorkshopWork({ pixels: pixel.image, item: { source: 'ai' } })
  for (const options of [
    { top: WORKSHOP.vision.sceneMinConfidence - 0.01 },
    { top: 0.62, margin: WORKSHOP.vision.sceneMinMargin - 0.01 },
  ]) {
    const merged = mergeWorkshopPerception(l1, visionOf('sprite_sheet', options))
    assert.equal(merged.source, 'l1+l2')
    assert.equal(merged.scene, 'pixel_art', `top=${options.top} margin=${options.margin} 不应覆盖`)
    assert.equal(merged.recommendedTools[0], 'pixel-snap')
    assert.equal(merged.vision.appliedScene, false)
  }
})

await check('L2 融合：透明通道 / 像素格等硬证据优先，普通照片不被 CLIP 改走', () => {
  const prop = sampleOf('白底道具')
  const l1 = perceiveWorkshopWork({ pixels: prop.image, item: { source: 'ai' } })
  assert.ok(l1.noul.needsCutout >= 0.7)
  const merged = mergeWorkshopPerception(l1, visionOf('illustration_or_photo', { top: 0.95 }))
  assert.equal(merged.scene, l1.scene, '没有像素格 / 透明 / 接缝证据时，照片场景不被语义模型推翻')
  assert.equal(merged.vision.appliedScene, false)

  const pixel = sampleOf('像素画')
  const pixelL1 = perceiveWorkshopWork({ pixels: pixel.image, item: { source: 'ai' } })
  const blocked = mergeWorkshopPerception(pixelL1, visionOf('seamless_texture', { top: 0.95 }))
  assert.equal(blocked.scene, 'pixel_art', '已确认的像素格不能被材质场景覆盖')
  assert.equal(blocked.recommendedTools[0], 'pixel-snap')
})

await check('L2 融合：已抠图 / 已做 PBR 的派生状态不被 L2 重新推荐同一工具', () => {
  const prop = sampleOf('白底道具')
  const cut = createImage(prop.image.width, prop.image.height)
  cut.fill(0, 0, 0, 0)
  for (let offset = 0; offset < prop.image.data.length; offset += 4) {
    if (prop.image.data[offset + 3] !== 255 || prop.image.data[offset] === 255) continue
    cut.data[offset] = prop.image.data[offset]
    cut.data[offset + 1] = prop.image.data[offset + 1]
    cut.data[offset + 2] = prop.image.data[offset + 2]
    cut.data[offset + 3] = 255
  }
  const l1 = perceiveWorkshopWork({
    pixels: cut,
    item: {
      source: 'ai',
      workshopTool: 'pbr',
      channels: [{ role: 'cutout' }, { role: 'albedo' }, { role: 'normal' }],
    },
  })
  assert.equal(l1.derived.hasTransparency, true)
  assert.ok(l1.derived.doneTools.includes('cutout'))
  assert.ok(l1.derived.doneTools.includes('pbr'))

  const merged = mergeWorkshopPerception(l1, visionOf('isolated_prop', {
    noul: { needsCutout: 0.99, wantsPbr: 0.99 },
  }))
  assert.equal(merged.noul.needsCutout, 0, '已有透明通道 / 已抠图时 needsCutout 必须归零')
  assert.equal(merged.noul.wantsPbr, 0, '已拆过 PBR 时 wantsPbr 必须归零')
  assert.ok(!merged.recommendedTools.includes('cutout'), '不能重复推荐抠图')
  assert.ok(!merged.recommendedTools.includes('pbr'), '不能重复推荐 PBR')
})

await check('L2 融合：纯函数，不修改 L1；无有效 L2 时原样返回 L1', () => {
  const l1 = perceiveWorkshopWork({ pixels: sampleOf('4×4 序列帧').image, item: { source: 'ai' } })
  const before = JSON.stringify(l1)
  const merged = mergeWorkshopPerception(l1, visionOf('sprite_sheet'))
  assert.equal(JSON.stringify(l1), before, '融合不得修改 L1 输入')
  assert.notEqual(merged, l1)
  assert.equal(mergeWorkshopPerception(l1, null), l1)
  assert.equal(mergeWorkshopPerception(l1, { scene: 'unknown' }), l1)
})

await check('L2 输入：RGBA → 256×256 RGB base64，透明合成白底、按短边缩放并中心裁切', () => {
  const image = createImage(128, 64)
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      // 左半红、右半完全透明且 RGB 为黑：后者必须合成为白色，而不是保留黑色。
      if (x < 64) image.set(x, y, 232, 40, 48, 255)
      else image.set(x, y, 0, 0, 0, 0)
    }
  }
  const pixels = workshopVisionPixels(image)
  assert.equal(pixels.width, 256)
  assert.equal(pixels.height, 256)
  const rgb = Buffer.from(pixels.data, 'base64')
  assert.equal(rgb.length, 256 * 256 * 3, '必须恰好是 256×256 RGB')
  const at = (x, y) => {
    const offset = (y * 256 + x) * 3
    return [rgb[offset], rgb[offset + 1], rgb[offset + 2]]
  }
  const [leftR, leftG, leftB] = at(16, 128)
  assert.ok(leftR > 220 && leftG < 60 && leftB < 70, `左半应保持红色，实际 ${leftR},${leftG},${leftB}`)
  const [rightR, rightG, rightB] = at(240, 128)
  assert.ok(rightR > 245 && rightG > 245 && rightB > 245, '透明右半必须合成为白底')
  assert.equal(workshopVisionPixels(null), null)
  assert.equal(workshopVisionPixels({ width: 8, height: 8, data: new Uint8Array(8) }), null)
})

// ── 10. 感知打标持久化（M4.2c Phase 2.5）──────────────────────────────────

await check('持久化标签：只保留最终摘要，版本失配降级，非法字段不落盘', () => {
  const l1 = perceiveWorkshopWork({ pixels: sampleOf('像素画').image, item: { source: 'ai' } })
  const merged = mergeWorkshopPerception(l1, visionOf('sprite_sheet', { top: 0.86 }))
  const tag = workshopPerceptionTagFromResult(merged, { now: '2026-11-25T10:00:00.000Z' })
  assert.ok(tag, '有效融合结果应能生成标签')
  assert.equal(tag.version, WORKSHOP.perception.tagVersion)
  assert.equal(tag.source, 'l1+l2')
  assert.equal(tag.model, WORKSHOP.vision.model)
  assert.equal(tag.scene, 'sprite_sheet')
  assert.deepEqual(tag.recommendedTools, merged.recommendedTools)
  assert.equal(tag.updatedAt, '2026-11-25T10:00:00.000Z')
  assert.ok(!Object.hasOwn(tag, 'features'), '标签不得包含像素特征')
  assert.ok(!Object.hasOwn(tag, 'sceneProbs'), '标签不得包含完整概率分布')

  assert.equal(normalizeWorkshopPerceptionTag({ ...tag, version: tag.version + 1 }), null, '版本旧于当前口径必须失效')
  assert.equal(normalizeWorkshopPerceptionTag({ ...tag, scene: 'unknown' }), null)
  assert.equal(normalizeWorkshopPerceptionTag({ ...tag, updatedAt: 'not-a-date' }), null)
  assert.equal(normalizeWorkshopPerceptionTag({ ...tag, professionalScore: 1.2 }), null)
  assert.equal(normalizeWorkshopPerceptionTag({ ...tag, recommendedTools: ['nope'] }), null)
  assert.equal(normalizeWorkshopPerceptionTag({ ...tag, source: 'l1+l2', model: null }), null)

  const cleaned = normalizeWorkshopPerceptionTag({
    ...tag,
    extra: 'must-not-persist',
    recommendedTools: [...tag.recommendedTools, 'unknown', tag.recommendedTools[0]],
  })
  assert.ok(cleaned)
  assert.ok(!Object.hasOwn(cleaned, 'extra'), '未知字段必须被白名单过滤')
  assert.deepEqual(
    cleaned.recommendedTools,
    [...new Set(tag.recommendedTools)].slice(0, 3),
    '工具去重、过滤非法项并保留 1~3 项',
  )
})

await check('持久化标签：应用到 UI 时保留当前 L1 特征 / 派生状态，非法标签安全忽略', () => {
  const l1 = perceiveWorkshopWork({
    pixels: sampleOf('像素画').image,
    item: {
      source: 'ai',
      workshopTool: 'pixel-snap',
      channels: [{ role: 'pixel' }],
    },
  })
  const merged = mergeWorkshopPerception(l1, visionOf('sprite_sheet', { top: 0.88 }))
  const tag = workshopPerceptionTagFromResult(merged, { now: '2026-11-25T10:00:00.000Z' })
  const applied = applyWorkshopPerceptionTag(l1, tag)
  assert.equal(applied.source, 'l1+l2')
  assert.equal(applied.scene, 'sprite_sheet')
  assert.equal(applied.recommendedTools[0], 'sprite-slice')
  assert.equal(applied.professionalScore, tag.professionalScore)
  assert.deepEqual(applied.noul, tag.noul)
  assert.equal(applied.showStudioReturnHint, tag.showStudioReturnHint)
  assert.deepEqual(applied.features, l1.features, 'L1 像素特征仍供工具参数 / 接力使用')
  assert.deepEqual(applied.derived, l1.derived, '派生状态不能被标签覆盖')
  assert.equal(applied.perceptionTag.updatedAt, tag.updatedAt)
  assert.equal(applyWorkshopPerceptionTag(l1, null), l1, '无标签时原样返回 L1')
  assert.equal(applyWorkshopPerceptionTag(l1, { ...tag, version: 0 }), l1, '版本失配按无标签处理')
})

await check('像素缓存：同一 URL 复用 RGBA、在途请求去重，LRU 不无限增长', async () => {
  const previous = { Image: globalThis.Image, document: globalThis.document }
  let loads = 0
  globalThis.Image = class FakeImage {
    constructor() {
      this.naturalWidth = 2
      this.naturalHeight = 2
      this.width = 2
      this.height = 2
      this.onload = null
      this.onerror = null
    }

    set src(value) {
      assert.ok(value)
      loads += 1
      queueMicrotask(() => this.onload?.())
    }
  }
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
            getImageData(_x, _y, width, height) {
              return { data: new Uint8ClampedArray(width * height * 4) }
            },
          }
        },
      }
    },
  }
  try {
    clearPixelCache()
    const first = await pixelsOfUrl('/api/file?path=cache-a.png')
    const again = await pixelsOfUrl('/api/file?path=cache-a.png')
    assert.equal(loads, 1, '同一 URL 第二次应从 LRU 命中，不再解码')
    assert.equal(first, again, '命中缓存时应返回同一个像素对象')

    const pendingA = pixelsOfUrl('/api/file?path=cache-pending.png')
    const pendingB = pixelsOfUrl('/api/file?path=cache-pending.png')
    const [left, right] = await Promise.all([pendingA, pendingB])
    assert.equal(left, right, '并发请求必须共享同一个在途 Promise')
    assert.equal(loads, 2, '在途去重后只解码一次')

    const workspaceA = await pixelsOfUrl('/api/file?path=same-relative.png', { namespace: 'workspace-a' })
    const workspaceB = await pixelsOfUrl('/api/file?path=same-relative.png', { namespace: 'workspace-b' })
    assert.notEqual(workspaceA, workspaceB, '不同工作区同相对路径必须各自解码，不能串用像素')
    assert.equal(loads, 4, '工作区隔离后两个命名空间各产生一次解码')

    for (let index = 0; index < 10; index += 1) {
      await pixelsOfUrl(`/api/file?path=cache-${index}.png`)
    }
    const stats = pixelCacheStats()
    assert.ok(stats.entries <= 8, `LRU 条目应封顶 8，实际 ${stats.entries}`)
    assert.ok(stats.bytes <= 64 * 1024 * 1024, 'LRU 字节上限必须生效')
    assert.equal(stats.pending, 0)
  } finally {
    clearPixelCache()
    globalThis.Image = previous.Image
    globalThis.document = previous.document
  }
})

summary({ prefix: '\n', suffix: '项通过' })





