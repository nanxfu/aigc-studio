import assert from 'node:assert/strict'
import { pullPush, prepareSoftLdi, renderSoftLdi, parallaxVector } from '../tools/spatial/soft-ldi.mjs'
import { REAL_SCENES, DIRECTIONS, syntheticFrame, blurSyntheticDepth } from '../tools/spatial/fixtures.mjs'
import { exemplarFill, prepareAdaptiveLdi, renderAdaptiveLdi } from '../tools/spatial/adaptive-ldi.mjs'

assert.equal(REAL_SCENES.length, 16)
assert.equal(new Set(REAL_SCENES.map(scene => scene.id)).size, 16)
for (const [x, y] of DIRECTIONS) assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-12)
const known = new Float32Array([0.2, 0, 0, 0.8])
const filled = pullPush(known, new Float32Array([1, 0, 0, 1]), 2, 2, 1)
assert.equal(filled[0], known[0])
assert.equal(filled[3], known[3])
assert.ok(filled[1] > 0.2 && filled[1] < 0.8)
assert.ok(filled[2] > 0.2 && filled[2] < 0.8)
const allUnknown = pullPush(new Float32Array(12), new Float32Array(4), 2, 2, 3)
assert.ok(allUnknown.every(Number.isFinite))
const scene = syntheticFrame('soft-disc', { width: 64, height: 48 })
const depth = blurSyntheticDepth(scene, 1)
const asset = prepareSoftLdi(scene, depth)
assert.deepEqual(renderSoftLdi(asset).data, scene.data, 'Zero motion must preserve the original bytes')
const moved = renderSoftLdi(asset, { vx: 4, vy: -2 })
assert.equal(moved.data.length, scene.data.length)
assert.ok(moved.data.some((value, i) => value !== scene.data[i]))
assert.ok(asset.alpha.every(value => Number.isFinite(value) && value >= 0 && value <= 1))
const matteMae = asset.alpha.reduce((sum, value, i) => sum + Math.abs(value - scene.alpha[i]), 0) / scene.alpha.length
assert.ok(matteMae < 0.08, `Color-line matte on analytic soft boundary: ${matteMae}`)
assert.throws(() => prepareSoftLdi(scene, { ...depth, width: 12 }), /Aligned/)
const vector = parallaxVector(768, 512, { amplitude: 24, shiftX: -0.7, shiftY: 0.35 })
assert.ok(Math.abs(vector.vx + 33.6) < 1e-9 && Math.abs(vector.vy - 16.8) < 1e-9)
const patchValues = new Float32Array(8 * 8 * 4)
const patchKnown = new Uint8Array(8 * 8).fill(1)
const patchAllowed = new Uint8Array(8 * 8).fill(1)
for (let i = 0; i < 64; i++) { patchValues[i * 4] = (i % 8) / 8; patchValues[i * 4 + 3] = 0.8 }
patchKnown[3 * 8 + 3] = 0
const patched = exemplarFill(patchValues, patchKnown, patchAllowed, 8, 8, { radius: 1 })
for (let i = 0; i < 64; i++) if (patchKnown[i]) {
  assert.deepEqual(patched.values.slice(i * 4, i * 4 + 4), patchValues.slice(i * 4, i * 4 + 4), 'Patch fill must preserve known samples')
}
const adaptive = prepareAdaptiveLdi(scene, depth, { maxLayers: 3 })
assert.deepEqual(renderAdaptiveLdi(adaptive).data, scene.data)
assert.ok(adaptive.layers.every(layer => layer.premultiplied.every(Number.isFinite)))
const invalidDepth = { ...depth, data: new Float32Array(depth.data) }
invalidDepth.data[8] = NaN
assert.throws(() => prepareAdaptiveLdi(scene, invalidDepth), /Nonfinite/)
console.log(JSON.stringify({ checks: 'corpus, unit directions, known-pixel preservation, empty masks, zero identity, movement, matte accuracy, alignment, motion units', matteMae }))
