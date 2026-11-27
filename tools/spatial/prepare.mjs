import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REAL_SCENES, SYNTHETIC_SCENES, DIRECTIONS } from './fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(root, process.argv[2] || '.tmp/spatial-e0-e2-2026-11-27')
await mkdir(path.join(out, 'baseline'), { recursive: true })
const manifest = {
  version: 1, purpose: 'E0/E1/E2 research; no production renderer replacement',
  baseline: [], realScenes: [], syntheticScenes: SYNTHETIC_SCENES, directions: DIRECTIONS,
  motion: { amplitude: 24, shiftX: -0.7, shiftY: 0.35, renderMaxEdge: 512 },
  zipDepth: { repository: 'fabiotosi92/ZipDepth', revision: '91f3fd21e131641f51e8d35736d1958350180e3a', checkpoint: 'zipdepth_base_npu.pth' },
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
for (const file of ['depthFx.js', 'depthFxWebGPU.js', 'depthFxWebGL.js', 'renderBufferKey.js']) {
  const bytes = await readFile(path.join(root, 'web/logic', file))
  await copyFile(path.join(root, 'web/logic', file), path.join(out, 'baseline', file))
  manifest.baseline.push({ file: `web/logic/${file}`, sha256: hash(bytes) })
}
for (const scene of REAL_SCENES) manifest.realScenes.push({ ...scene, sha256: hash(await readFile(path.join(root, scene.file))) })
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify({ out, realScenes: manifest.realScenes.length, analyticScenes: SYNTHETIC_SCENES.length, baseline: manifest.baseline }))
