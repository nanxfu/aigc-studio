import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(root, process.argv[2] || '.tmp/spatial-e0-e2-2026-11-27')
const readJson = async file => JSON.parse(await readFile(path.join(out, file), 'utf8'))
const [manifest, browser, cpu, html] = await Promise.all([readJson('manifest.json'), readJson('browser-report.json'), readJson('model-cpu-report.json'), readFile(path.join(out, 'index.html'), 'utf8')])
assert.deepEqual(browser.manifest, manifest)
assert.deepEqual(browser.errors, [])
assert.equal(browser.real.length, 16)
assert.equal(browser.depthRendererComparison.length, 16)
assert.equal(cpu.samples.length, 48)
assert.equal(browser.synthetic.length, 4)
for (const scene of browser.synthetic) {
  for (const name of ['webgpu', 'webgl', 'soft-only', 'soft-recover', 'soft-fill-only', 'soft-full', 'oracle-alpha']) {
    const rows = scene.rows.filter(row => row.name === name)
    assert.equal(rows.length, 8, `${scene.id}/${name}: missing motion directions`)
    assert.ok(rows.every(row => Number.isFinite(row.mae) && Number.isFinite(row.ms)))
  }
}
for (const source of [...manifest.realScenes, ...manifest.baseline]) {
  const frozenFile = source.file.startsWith('web/logic/') ? path.join(out, 'baseline', path.basename(source.file)) : path.join(root, source.file)
  const actual = createHash('sha256').update(await readFile(frozenFile)).digest('hex')
  assert.equal(actual, source.sha256, `Frozen source changed: ${source.file}`)
}
let links = 0
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^https?:/.test(match[1])) continue
  const file = path.resolve(out, match[1])
  assert.ok(file.startsWith(`${out}${path.sep}`))
  assert.ok((await stat(file)).size > 0, `Empty report resource ${match[1]}`)
  links++
}
assert.ok(browser.modelChecks.some(row => row.id === 'zip-fp32' && row.ep === 'webgpu' && row.pass))
assert.ok(cpu.pytorchVsOnnx.every(row => row.relativeMae < 0.001))
console.log(JSON.stringify({ realScenes: 16, analyticScenes: 4, directions: 8, ablations: 7, reportLinks: links, outputErrors: browser.errors.length }))
