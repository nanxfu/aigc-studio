#!/usr/bin/env node
/**
 * 资产工坊 Host 侧离线回归（M4.2a / M4.2b）。
 *
 * 覆盖：
 *  - `POST /api/workshop/save`：主图 + 通道落盘、meta 形状、通道命名去重、参数清洗、
 *    版本树（sourceImage / rootImage）继承、响应 entry 与 /history 条目同形；
 *  - `GET /api/workshop/export`：ZIP 字节（PK 头 / 条目名 / 体积）、目录与图片路径两种入参、
 *    越界与不存在路径的 400/404、文件数护栏；
 *  - `POST /api/workshop/vectorize`：真实小 PNG 矢量化为 SVG、参数非法 400、非 PNG / 超长边拒绝；
 *  - `POST /api/workshop/op`：fake queue 断言 remove-bg / pbr 的入队形状、模型白名单、
 *    尺寸边界与队列拒绝错误码透传。
 *
 * 不依赖 Kaggle、不联网：用假 cordis Context 注册真实路由，请求打到本机 HTTP 服务，
 * 工作区用 fs.mkdtemp 建在 `.tmp/m4-workshop/` 下。
 *
 * 运行：node test/host-workshop.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { saveJobOutput } from '../server/output.js'
import { createFileRoutes } from '../server/routes/files.js'
import { createJobRoutes } from '../server/routes/jobs.js'
import { createWorkshopRoutes } from '../server/routes/workshop.js'
import { registerRoutes } from '../server/route-kit.js'
import { ROUTES, WORKSHOP } from '../shared/contract.js'
import { createCheckRunner } from './helpers/check.mjs'
import { closeServer, createFakeContext, json, startHost } from './helpers/fake-context.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const { check, summary } = createCheckRunner()

/** 路由层需要的最小 log 替身（测试不关心日志内容）。 */
const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} }

// ── PNG fixture（测试内独立实现，不借用被测模块的 CRC / chunk 逻辑）──────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length)
  return chunk
}

/**
 * 构造结构合法（IHDR/IDAT/IEND + 正确 CRC）的 RGBA PNG。
 *
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number, number]} painter 像素着色函数
 */
function makePng(width, height, painter) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = painter(x, y)
      const offset = y * stride + 1 + x * 4
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 四色横条 PNG：给 vtracer 足够的颜色区域，避免全透明图输出空 SVG。 */
function makeColorPng(width, height) {
  return makePng(width, height, (x, y) => {
    const column = Math.floor((x / width) * 4)
    if (column === 0) return [220, 40, 40, 255]
    if (column === 1) return [40, 180, 60, 255]
    if (column === 2) return [40, 80, 220, 255]
    return y < height / 2 ? [250, 220, 40, 255] : [20, 20, 20, 255]
  })
}

/** 只有 PNG 头部（IHDR）的夹具：只用于 Host 的宽高解析，不用于 wasm 解码。 */
function headerOnlyPng(width, height) {
  const buffer = Buffer.alloc(33)
  PNG_SIGNATURE.copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function dataUrlOf(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`
}

// ── 请求小工具 ─────────────────────────────────────────────────────────────

function postJson(origin, path, body) {
  return json(origin, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** 读取二进制 ZIP 响应（json() 会把响应体当文本解析，这里直接用 fetch）。 */
async function getExport(origin, requestedPath) {
  const url = `/api/workshop/export?path=${encodeURIComponent(requestedPath)}`
  const res = await fetch(new URL(url, origin))
  const buffer = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, buffer }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const baseDir = join(ROOT, '.tmp', 'm4-workshop')
  await mkdir(baseDir, { recursive: true })
  const workspace = await mkdtemp(join(baseDir, 'host-workshop-'))
  const outputDir = join(workspace, 'outputs')
  const fake = createFakeContext(workspace)

  // fake queue：记录 enqueue 入参并回放固定 jobId；reject 用于模拟「队列暂不支持该 tool」。
  const fakeQueue = {
    calls: [],
    reject: null,
    async enqueue(request) {
      this.calls.push(request)
      if (this.reject) return this.reject
      return { ok: true, job: { id: `workshop-job-${this.calls.length}` } }
    },
  }

  registerRoutes(fake.ctx, [
    // /api/history 与工坊路由一起挂：验证保存结果能被历史接口原样读回。
    ...createJobRoutes({ ctx: fake.ctx, queue: fakeQueue, log: SILENT_LOG }),
    ...createWorkshopRoutes({ ctx: fake.ctx, log: SILENT_LOG, queue: fakeQueue }),
    // /api/file 只用于验证通道 url 可访问（fileUrl 拼的是工作区相对路径）。
    ...createFileRoutes({ ctx: fake.ctx, log: SILENT_LOG }),
  ])
  const host = await startHost(fake.routes)
  fake.setOrigin(host.origin)

  /** 保存一次工坊资产，返回解析后的响应体（失败时返回完整响应便于断言状态码）。 */
  async function saveAsset(body) {
    return postJson(host.origin, '/api/workshop/save', body)
  }

  try {
    // ── 0. 路由登记 ────────────────────────────────────────────────────────
    await check('工坊 4 条路由已注册（save / export / vectorize / op）', () => {
      for (const route of [
        ROUTES.workshopSave,
        ROUTES.workshopExport,
        ROUTES.workshopVectorize,
        ROUTES.workshopOp,
      ]) {
        const matched = fake.routes.filter((item) => item.path === route.path)
        assert.equal(matched.length, 1, `${route.path} 应恰好注册一条，实际 ${matched.length}`)
      }
    })

    // ── 1. 保存：主图 + SVG / JSON 通道（独立根）────────────────────────────
    const colorPng = makeColorPng(96, 64)
    const svgText =
      '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"></svg>'
    const atlas = { frames: [], meta: { app: 'aigc-studio', size: { w: 96, h: 64 } } }

    const saved = await saveAsset({
      tool: 'vectorize',
      name: '矢量测试',
      primary: { data: dataUrlOf(colorPng) },
      channels: [
        { role: 'svg', label: '矢量稿', format: 'svg', data: svgText },
        { role: 'atlas', format: 'json', data: JSON.stringify(atlas) },
      ],
      meta: { colorPrecision: 6, mode: 'spline' },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.ok, true)
    const firstItem = saved.body.entry.item
    const firstImage = saved.body.entry.image

    await check('保存：响应 entry 与 meta 形状', async () => {
      assert.equal(firstImage.file, '01.png')
      assert.equal(firstImage.width, 96)
      assert.equal(firstImage.height, 64)
      assert.equal(firstImage.mediaType, 'image')
      assert.ok(firstImage.url.startsWith('/api/file?path='), `图片 url 形状异常：${firstImage.url}`)
      assert.match(firstItem.dir, /^outputs\/\d{8}-\d{6}-workshop-[0-9a-f]{6}$/)
      assert.equal(firstItem.workshop, true)
      assert.equal(firstItem.workshopTool, 'vectorize')
      assert.deepEqual(firstItem.workshopParams, { colorPrecision: 6, mode: 'spline' })
      assert.equal(firstItem.sourceImage, null, '没有 base 时 sourceImage 应为 null')
      assert.equal(firstItem.rootImage, null, '没有 base 时 rootImage 应为 null')
      assert.equal(firstItem.params.source, 'workshop')
      assert.equal(firstItem.params.prompt, '矢量测试')
      assert.deepEqual(firstItem.params.workshop, {
        tool: 'vectorize',
        params: { colorPrecision: 6, mode: 'spline' },
      })
      assert.equal(firstItem.channels.length, 2)
      const [svgChannel, atlasChannel] = firstItem.channels
      assert.equal(svgChannel.file, 'svg.svg')
      assert.equal(svgChannel.role, 'svg')
      assert.equal(svgChannel.label, '矢量稿')
      assert.equal(svgChannel.format, 'svg')
      assert.equal(svgChannel.width, null)
      assert.equal(svgChannel.height, null)
      assert.ok(svgChannel.bytes === Buffer.byteLength(svgText, 'utf8'))
      assert.ok(svgChannel.url.startsWith('/api/file?path='))
      assert.equal(atlasChannel.file, 'atlas.json')
      assert.equal(atlasChannel.format, 'json')

      // /api/file 读取 SVG 通道时必须返回 image/svg+xml，浏览器 <img> 才会正常渲染。
      const svgResponse = await fetch(`${host.origin}${svgChannel.url}`)
      assert.equal(svgResponse.status, 200)
      assert.match(String(svgResponse.headers.get('content-type') || ''), /^image\/svg\+xml/)

      // 落盘 meta.json：最后写入的提交标记，字段与响应一致。
      const meta = JSON.parse(
        await readFile(join(workspace, ...firstItem.dir.split('/'), 'meta.json'), 'utf8'),
      )
      assert.equal(meta.workshop, true)
      assert.equal(meta.workshopTool, 'vectorize')
      assert.equal(meta.jobId, `workshop-${firstItem.dir.split('/')[1]}`)
      assert.equal(meta.params.source, 'workshop')
      assert.equal(meta.channels.length, 2)
      assert.equal(meta.channels[0].file, 'svg.svg')
      // 通道文件真实存在且字节数与 meta 一致。
      const svgOnDisk = await stat(join(workspace, ...firstItem.dir.split('/'), 'svg.svg'))
      assert.equal(svgOnDisk.size, Buffer.byteLength(svgText, 'utf8'))
    })

    await check('保存：通道文件可通过 /api/file 访问', async () => {
      const served = await fetch(new URL(firstItem.channels[0].url, host.origin))
      assert.equal(served.status, 200)
      assert.equal(await served.text(), svgText)
    })

    // ── 2. 保存校验：tool / 图片格式 / 通道内容 / 名称清洗与去重 ─────────────
    await check('保存：非法 tool / 非 PNG 主图 / 坏 SVG·JSON 通道返回 400', async () => {
      const badTool = await saveAsset({ tool: 'nope', primary: { data: dataUrlOf(colorPng) } })
      assert.equal(badTool.status, 400)
      assert.equal(badTool.body.error.code, 'invalid_request')

      const notPng = await saveAsset({
        tool: 'pixel-snap',
        primary: { data: Buffer.from('hello').toString('base64') },
      })
      assert.equal(notPng.status, 400)
      assert.equal(notPng.body.error.code, 'invalid_request')

      const badSvg = await saveAsset({
        tool: 'vectorize',
        primary: { data: dataUrlOf(colorPng) },
        channels: [{ role: 'svg', format: 'svg', data: '<html>不是 SVG</html>' }],
      })
      assert.equal(badSvg.status, 400)
      assert.equal(badSvg.body.error.code, 'invalid_request')

      const badJson = await saveAsset({
        tool: 'sprite-slice',
        primary: { data: dataUrlOf(colorPng) },
        channels: [{ role: 'atlas', format: 'json', data: '{"frames":' }],
      })
      assert.equal(badJson.status, 400)
      assert.equal(badJson.body.error.code, 'invalid_request')

      const badBody = await saveAsset('不是 JSON')
      assert.equal(badBody.status, 400)
      assert.equal(badBody.body.error.code, 'invalid_body')
      const arrayBody = await saveAsset('[]')
      assert.equal(arrayBody.status, 400)
      assert.equal(arrayBody.body.error.code, 'invalid_body')
    })

    await check('保存：重复 role 通道按 -2/-3 去重，name 清洗并截断', async () => {
      const tilePng = makeColorPng(32, 32)
      const name = `A\u0001B${'x'.repeat(200)}`
      const saved2 = await saveAsset({
        tool: 'tile',
        name,
        primary: { data: dataUrlOf(tilePng) },
        channels: [
          { role: 'tile', format: 'png', data: dataUrlOf(tilePng) },
          { role: 'tile', format: 'png', data: dataUrlOf(tilePng) },
          { role: 'tile', format: 'png', data: dataUrlOf(tilePng) },
        ],
      })
      assert.equal(saved2.status, 200, JSON.stringify(saved2.body))
      const item = saved2.body.entry.item
      assert.deepEqual(
        item.channels.map((channel) => channel.file),
        ['tile.png', 'tile-2.png', 'tile-3.png'],
      )
      // 控制字符被清掉，prompt 按字符截断到契约上限 120。
      assert.equal(item.params.prompt.length, WORKSHOP.save.maxNameChars)
      assert.ok(item.params.prompt.startsWith('AB'))
      assert.ok(!/[\u0000-\u001f]/.test(item.params.prompt))
    })

    // ── 3. 版本树继承（base.path → sourceImage / rootImage）─────────────────
    await check('保存：base.path 继承版本树（父 rootImage 链一路沿用）', async () => {
      const rootPath = firstItem.images[0].path
      const second = await saveAsset({
        tool: 'pixel-snap',
        name: '派生一',
        base: { path: rootPath },
        primary: { data: dataUrlOf(makeColorPng(32, 32)) },
      })
      assert.equal(second.status, 200, JSON.stringify(second.body))
      const secondItem = second.body.entry.item
      assert.equal(secondItem.sourceImage, rootPath)
      assert.equal(secondItem.rootImage, rootPath, '父作品没有 rootImage 时退回 base 自身作为根')

      const third = await saveAsset({
        tool: 'pixel-snap',
        name: '派生二',
        base: { path: secondItem.images[0].path },
        primary: { data: dataUrlOf(makeColorPng(32, 32)) },
      })
      assert.equal(third.status, 200, JSON.stringify(third.body))
      const thirdItem = third.body.entry.item
      assert.equal(thirdItem.sourceImage, secondItem.images[0].path)
      assert.equal(thirdItem.rootImage, rootPath, '应继承父作品的 rootImage，而不是父作品本身')

      // 非法 base.path 不阻断保存，按独立根处理。
      const ignored = await saveAsset({
        tool: 'pixel-snap',
        base: { path: '../escape.png' },
        primary: { data: dataUrlOf(makeColorPng(32, 32)) },
      })
      assert.equal(ignored.status, 200)
      assert.equal(ignored.body.entry.item.sourceImage, null)
      assert.equal(ignored.body.entry.item.rootImage, null)
    })

    // ── 4. /history 读回（字段与响应逐字段同形）──────────────────────────────
    await check('/api/history 能看到工坊条目且带 channels / workshopTool', async () => {
      const history = await json(host.origin, '/api/history?limit=50')
      assert.equal(history.status, 200)
      const found = history.body.items.find((item) => item.jobId === firstItem.jobId)
      assert.ok(found, '工坊产物应出现在 /history')
      // 通道里的 absolute / bytes 由 stat 求得，应与保存响应完全一致。
      assert.deepEqual(found, firstItem, '保存响应 item 必须与 /history 条目同形')
      assert.equal(found.channels.length, 2)
      assert.equal(found.workshopTool, 'vectorize')
      // 旧产物（非工坊）channels 恒为 []、workshopTool 为 null——用导入夹具核对读取端缺省。
      const legacyDir = join(outputDir, '20990101-000000-legacy')
      await mkdir(legacyDir, { recursive: true })
      await writeFile(join(legacyDir, '01.png'), colorPng)
      await writeFile(
        join(legacyDir, 'meta.json'),
        JSON.stringify({ version: 1, jobId: 'legacy', params: { prompt: '旧产物' }, images: [{ file: '01.png' }] }),
      )
      const history2 = await json(host.origin, '/api/history?limit=50')
      const legacy = history2.body.items.find((item) => item.jobId === 'legacy')
      assert.deepEqual(legacy.channels, [], '旧产物 channels 必须是空数组')
      assert.equal(legacy.workshop, false)
      assert.equal(legacy.workshopTool, null)
      assert.equal(legacy.workshopParams, null)
    })

    // ── 5. ZIP 导出 ────────────────────────────────────────────────────────
    await check('导出 ZIP：PK 头 / content-type / 条目名 / 体积', async () => {
      const exported = await getExport(host.origin, firstItem.dir)
      assert.equal(exported.status, 200, exported.buffer.toString('utf8').slice(0, 200))
      assert.match(exported.headers.get('content-type'), /application\/zip/)
      assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename=".+\.zip"/)
      assert.ok(exported.buffer.subarray(0, 2).equals(Buffer.from([0x50, 0x4b])), 'ZIP 应以 PK 开头')
      assert.equal(exported.buffer.subarray(2, 4).toString('latin1'), '\x03\x04')
      assert.equal(Number(exported.headers.get('content-length')), exported.buffer.length)
      const names = exported.buffer.toString('latin1')
      for (const expected of ['01.png', 'meta.json', 'svg.svg', 'atlas.json']) {
        assert.ok(names.includes(expected), `ZIP 应包含条目 ${expected}`)
      }
      // 同一作品用「作品目录」与「主图路径」两种入参导出，字节应完全一致（createZip 确定性）。
      const byImage = await getExport(host.origin, firstImage.path)
      assert.equal(byImage.status, 200)
      assert.ok(byImage.buffer.equals(exported.buffer), '目录入参与图片入参应导出相同字节')
    })

    await check('导出 ZIP：越界 / 不存在 / 超量路径全部拒绝', async () => {
      // 工作区根目录放一个「机密文件」，确认任何路径都不能把它读出来。
      await writeFile(join(workspace, 'secret.txt'), 'TOP-SECRET')

      for (const badPath of ['../secret.txt', 'outputs/../secret.txt', 'secret.txt', '']) {
        const response = await getExport(host.origin, badPath)
        assert.equal(response.status, 400, `${badPath} 应返回 400，实际 ${response.status}`)
        assert.equal(JSON.parse(response.buffer.toString('utf8')).error.code, 'invalid_path')
      }
      const outside = await getExport(host.origin, 'outputs')
      assert.equal(outside.status, 400, '不允许导出整个 outputs/ 根目录')

      const missing = await getExport(host.origin, 'outputs/20990101-000000-nope')
      assert.equal(missing.status, 404)
      assert.equal(JSON.parse(missing.buffer.toString('utf8')).error.code, 'not_found')

      // 文件数护栏：24 个上限，25 个文件必须拒绝而不是打包。
      const crowded = join(outputDir, '20990101-000000-crowded')
      await mkdir(crowded, { recursive: true })
      for (let index = 0; index < WORKSHOP.export.maxFiles + 1; index += 1) {
        await writeFile(join(crowded, `f${index}.txt`), `file-${index}`)
      }
      const tooMany = await getExport(host.origin, 'outputs/20990101-000000-crowded')
      assert.equal(tooMany.status, 400)
      assert.equal(JSON.parse(tooMany.buffer.toString('utf8')).error.code, 'too_many')

      // 空目录：没有可导出的常规文件 → 404。
      const empty = join(outputDir, '20990101-000000-empty')
      await mkdir(empty, { recursive: true })
      const noFiles = await getExport(host.origin, 'outputs/20990101-000000-empty')
      assert.equal(noFiles.status, 404)
    })

    // ── 6. SVG 矢量 ────────────────────────────────────────────────────────
    await check('矢量：真实小 PNG 返回 SVG 与宽高', async () => {
      const result = await postJson(host.origin, '/api/workshop/vectorize', {
        path: firstImage.path,
        options: { colormode: 'color', hierarchy: 'stacked', mode: 'spline', colorPrecision: 6, filterSpeckle: 4 },
      })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      assert.equal(result.body.ok, true)
      assert.ok(
        result.body.svg.startsWith('<svg') || result.body.svg.startsWith('<?xml'),
        `SVG 开头异常：${result.body.svg.slice(0, 60)}`,
      )
      assert.equal(result.body.width, 96)
      assert.equal(result.body.height, 64)
      assert.equal(result.body.bytes, Buffer.byteLength(result.body.svg, 'utf8'))
      assert.ok(result.body.svg.includes('<svg'))
    })

    await check('矢量：非法参数 / 非 PNG / 超长边 / 越界路径返回 400', async () => {
      const badPrecision = await postJson(host.origin, '/api/workshop/vectorize', {
        path: firstImage.path,
        options: { colorPrecision: 999 },
      })
      assert.equal(badPrecision.status, 400)
      assert.equal(badPrecision.body.error.code, 'invalid_request')

      const badMode = await postJson(host.origin, '/api/workshop/vectorize', {
        path: firstImage.path,
        options: { colormode: 'rainbow' },
      })
      assert.equal(badMode.status, 400)
      assert.equal(badMode.body.error.code, 'invalid_request')

      const escape = await postJson(host.origin, '/api/workshop/vectorize', { path: '../secret.txt' })
      assert.equal(escape.status, 400)
      assert.equal(escape.body.error.code, 'invalid_path')

      // 非 outputs 前缀 / 不存在的作品路径。
      const missing = await postJson(host.origin, '/api/workshop/vectorize', { path: 'outputs/nope/01.png' })
      assert.equal(missing.status, 400)

      // 非 PNG 后缀的常规文件（resolveOutputPath 认可文件存在，但魔数校验必须拒绝）。
      const notPngDir = join(outputDir, '20990101-000000-notpng')
      await mkdir(notPngDir, { recursive: true })
      await writeFile(join(notPngDir, 'note.txt'), '不是图片')
      const notPng = await postJson(host.origin, '/api/workshop/vectorize', {
        path: `outputs/20990101-000000-notpng/note.txt`,
      })
      assert.equal(notPng.status, 400)
      assert.equal(notPng.body.error.code, 'invalid_request')

      // 长边超过 WORKSHOP.vector.maxInputEdge（头部合法即可在解码前拒绝）。
      const hugeDir = join(outputDir, '20990101-000000-huge')
      await mkdir(hugeDir, { recursive: true })
      await writeFile(join(hugeDir, 'big.png'), headerOnlyPng(WORKSHOP.vector.maxInputEdge + 1, 32))
      const tooLarge = await postJson(host.origin, '/api/workshop/vectorize', {
        path: 'outputs/20990101-000000-huge/big.png',
      })
      assert.equal(tooLarge.status, 400)
      assert.equal(tooLarge.body.error.code, 'invalid_request')
    })

    // ── 7. GPU 后处理算子入队（fake queue）─────────────────────────────────
    const bigSource = await saveAsset({
      tool: 'pixel-snap',
      name: 'PBR 源图',
      primary: { data: dataUrlOf(makeColorPng(256, 256)) },
    })
    assert.equal(bigSource.status, 200, JSON.stringify(bigSource.body))
    const bigItem = bigSource.body.entry.item
    const bigPath = bigItem.images[0].path

    await check('op：remove-bg / pbr 入队形状与模型白名单', async () => {
      fakeQueue.calls.length = 0
      fakeQueue.reject = null

      const cutout = await postJson(host.origin, '/api/workshop/op', { op: 'remove-bg', path: bigPath })
      assert.equal(cutout.status, 200, JSON.stringify(cutout.body))
      assert.deepEqual(cutout.body, { ok: true, jobId: 'workshop-job-1' })
      assert.equal(fakeQueue.calls.length, 1)
      const cutoutCall = fakeQueue.calls[0]
      assert.equal(cutoutCall.tool, 'remove-bg')
      assert.deepEqual(cutoutCall.reference, { path: bigPath })
      assert.equal(cutoutCall.prompt, '')
      assert.equal(cutoutCall.presetId, null)
      assert.equal(cutoutCall.model, WORKSHOP.cutout.defaultModel)
      assert.equal(cutoutCall.width, 256)
      assert.equal(cutoutCall.height, 256)

      const pbr = await postJson(host.origin, '/api/workshop/op', {
        op: 'pbr',
        path: bigPath,
        model: 'marigold',
        options: { steps: 4 },
      })
      assert.equal(pbr.status, 200, JSON.stringify(pbr.body))
      assert.equal(fakeQueue.calls.length, 2)
      const pbrCall = fakeQueue.calls[1]
      assert.equal(pbrCall.tool, 'pbr')
      assert.equal(pbrCall.model, 'marigold')
      assert.equal(pbrCall.options.steps, 4)
      assert.equal(pbrCall.steps, 4)

      // 非法模型：白名单外 400，且不得入队（避免无效任务占用队列）。
      const badModel = await postJson(host.origin, '/api/workshop/op', {
        op: 'remove-bg',
        path: bigPath,
        model: 'marigold',
      })
      assert.equal(badModel.status, 400)
      assert.equal(badModel.body.error.code, 'invalid_request')
      assert.equal(fakeQueue.calls.length, 2, '非法模型不应入队')

      const badOp = await postJson(host.origin, '/api/workshop/op', { op: 'upscale', path: bigPath })
      assert.equal(badOp.status, 400)

      const badSteps = await postJson(host.origin, '/api/workshop/op', {
        op: 'pbr',
        path: bigPath,
        options: { steps: 999 },
      })
      assert.equal(badSteps.status, 400)
      assert.equal(badSteps.body.error.code, 'invalid_request')
    })

    await check('op：尺寸不足 / 越界路径 / 队列拒绝错误码透传', async () => {
      fakeQueue.calls.length = 0
      // 96×64 的源图短边低于 remove-bg 的 minInputEdge（128）。
      const tooSmall = await postJson(host.origin, '/api/workshop/op', {
        op: 'remove-bg',
        path: firstImage.path,
      })
      assert.equal(tooSmall.status, 400)
      assert.equal(tooSmall.body.error.code, 'invalid_request')
      assert.equal(fakeQueue.calls.length, 0)

      const escape = await postJson(host.origin, '/api/workshop/op', { op: 'remove-bg', path: '../secret.txt' })
      assert.equal(escape.status, 400)
      assert.equal(escape.body.error.code, 'invalid_path')

      const missing = await postJson(host.origin, '/api/workshop/op', { op: 'remove-bg', path: 'outputs/nope.png' })
      assert.equal(missing.status, 400)

      // 队列尚未支持该 tool 时（T-D 未合并前）：路由必须原样透传队列错误码，不能伪造成功。
      fakeQueue.reject = { ok: false, code: 'queue_full', message: '队列已满，请等待当前任务完成' }
      const rejected = await postJson(host.origin, '/api/workshop/op', { op: 'pbr', path: bigPath })
      assert.equal(rejected.status, 400)
      assert.equal(rejected.body.error.code, 'queue_full')
      assert.equal(rejected.body.error.message, '队列已满，请等待当前任务完成')
      fakeQueue.reject = null

      // 缺 body / 非对象 body：invalid_body。
      const emptyBody = await postJson(host.origin, '/api/workshop/op', '[]')
      assert.equal(emptyBody.status, 400)
      assert.equal(emptyBody.body.error.code, 'invalid_body')
    })

    // ── 8. GPU 结果多通道落盘（saveJobOutput，供 T-D 的队列落盘复用）──────────
    await check('saveJobOutput：channel 结果按 <role>.png 落盘并登记 channels', async () => {
      const channelPng = makeColorPng(64, 48)
      const baseJob = {
        id: 'gpu-cutout-test',
        tool: 'remove-bg',
        presetId: null,
        provider: null,
        device: null,
        createdAt: '2099-01-02T00:00:00.000Z',
        finishedAt: '2099-01-02T00:00:01.000Z',
        params: { prompt: '', width: 64, height: 48, count: 1 },
      }

      // remove-bg：只有一个通道，它同时作为画廊主图。
      const cutoutOutput = await saveJobOutput(fake.ctx, baseJob, [
        { image_b64: channelPng.toString('base64'), channel: 'cutout', width: 64, height: 48, seconds: 0.1 },
      ])
      assert.equal(cutoutOutput.images.length, 1)
      assert.equal(cutoutOutput.images[0].file, 'cutout.png', '通道文件不占 01.png 序号')
      const cutoutMeta = JSON.parse(
        await readFile(join(workspace, ...cutoutOutput.dir.split('/'), 'meta.json'), 'utf8'),
      )
      assert.equal(cutoutMeta.workshop, true)
      assert.equal(cutoutMeta.workshopTool, 'cutout', 'remove-bg 的工坊工具 id 是 cutout')
      assert.deepEqual(cutoutMeta.channels.map((channel) => channel.role), ['cutout'])
      assert.equal(cutoutMeta.channels[0].file, 'cutout.png')
      assert.equal(cutoutMeta.channels[0].format, 'png')
      assert.equal(cutoutMeta.images[0].file, 'cutout.png', '第一个通道同时进 images[]')

      // pbr：四个通道，第一个（albedo）进 images[]，其余只进 channels[]。
      const pbrOutput = await saveJobOutput(fake.ctx, { ...baseJob, id: 'gpu-pbr-test', tool: 'pbr' }, [
        { image_b64: channelPng.toString('base64'), channel: 'albedo', width: 64, height: 48 },
        { image_b64: channelPng.toString('base64'), channel: 'normal', width: 64, height: 48 },
        { image_b64: channelPng.toString('base64'), channel: 'roughness', width: 64, height: 48 },
        { image_b64: channelPng.toString('base64'), channel: 'metallic', width: 64, height: 48 },
      ])
      assert.equal(pbrOutput.images.length, 1)
      assert.equal(pbrOutput.images[0].file, 'albedo.png')
      const pbrMeta = JSON.parse(
        await readFile(join(workspace, ...pbrOutput.dir.split('/'), 'meta.json'), 'utf8'),
      )
      assert.equal(pbrMeta.workshopTool, 'pbr')
      assert.deepEqual(
        pbrMeta.channels.map((channel) => channel.file),
        ['albedo.png', 'normal.png', 'roughness.png', 'metallic.png'],
      )
      assert.equal(pbrMeta.images.length, 1, '其余通道不能占用画廊卡片')

      // 历史读取端：GPU 产物同样带 channels / workshopTool。
      const history = await json(host.origin, '/api/history?limit=50')
      const cutoutItem = history.body.items.find((item) => item.jobId === 'gpu-cutout-test')
      assert.ok(cutoutItem, 'GPU 产物应出现在 /history')
      assert.equal(cutoutItem.workshopTool, 'cutout')
      assert.equal(cutoutItem.channels.length, 1)
      assert.equal(cutoutItem.channels[0].role, 'cutout')
      assert.equal(cutoutItem.images[0].file, 'cutout.png')
      const pbrItem = history.body.items.find((item) => item.jobId === 'gpu-pbr-test')
      assert.equal(pbrItem.channels.length, 4)
      assert.deepEqual(
        pbrItem.channels.map((channel) => channel.role),
        ['albedo', 'normal', 'roughness', 'metallic'],
      )

      // 旧链路零影响：没有 channel 的结果仍是 01.png / 02.png，且不写 channels / workshopTool。
      const legacyOutput = await saveJobOutput(fake.ctx, { ...baseJob, id: 'legacy-naming-test', tool: 'generate' }, [
        { image_b64: channelPng.toString('base64'), width: 64, height: 48 },
        { image_b64: channelPng.toString('base64'), width: 64, height: 48 },
      ])
      assert.deepEqual(
        legacyOutput.images.map((image) => image.file),
        ['01.png', '02.png'],
        '无 channel 的旧命名必须完全不变',
      )
      const legacyMeta = JSON.parse(
        await readFile(join(workspace, ...legacyOutput.dir.split('/'), 'meta.json'), 'utf8'),
      )
      assert.equal(legacyMeta.channels, undefined, '无通道时不写 meta.channels')
      assert.equal(legacyMeta.workshopTool, undefined)
      assert.equal(legacyMeta.workshop, undefined)
    })
  } finally {
    await closeServer(host.server)
    fake.dispose()
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }

  summary()
}

try {
  await main()
} catch (error) {
  console.error(error?.stack ?? error)
  process.exitCode = 1
}
