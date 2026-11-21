/**
 * 站内作品拖拽快捷交互测试：
 *  1. drag.js 纯逻辑：WORK_DRAG_MIME 优先于 Files（不误判为本地导入），不写 text/plain；
 *  2. 底部作品条 / 版本面板拖到舞台 → 直接切换预览（不走 /api/import），同作品不触发，编辑态拦截；
 *  3. 底部作品条拖到左栏参考图槽 → 直接挂载原路径（不走 /api/import），支持重复/满额提示与不支持模型隐藏边界；
 *  4. 两层高亮（起拖即亮 + 悬停激活）与舞台有图/无图时的外部文件导入文案区分；
 *  5. 其它非拖出源图片（舞台大图 / 参考槽缩略图 / 助手缩略图 / 画廊卡片）一律 draggable={false}。
 */

import assert from 'node:assert/strict'

import {
  WORK_DRAG_MIME,
  beginWorkDrag,
  endWorkDrag,
  hasFilePayload,
  hasWorkDragPayload,
  workDragPathOf,
  writeWorkDrag,
} from '../web/studio/drag.js'
import { createCheckRunner } from './helpers/check.mjs'
import { preset, probeOk, studioResponses } from './helpers/client-fixtures.mjs'
import { collectText, createTestClient, findNodes } from './helpers/render.mjs'

const NOW = Date.parse('2026-11-22T00:25:00.000Z')

const klein = {
  ...preset,
  id: 'flux2-klein-4b',
  label: 'FLUX.2 Klein 4B',
  short: 'Klein 4B',
  supportsImg2Img: false,
  supportsInpaint: false,
  supportsReference: true,
}

const toolCapable = {
  ...preset,
  id: 'sdxl-lightning',
  supportsImg2Img: true,
  supportsInpaint: true,
  supportsReference: false,
}

function makeWork(id, minutesAgo) {
  const path = `outputs/20261122-000000-${id}/01.png`
  const image = {
    path,
    file: '01.png',
    url: `/api/file?path=${encodeURIComponent(path)}`,
    width: 1024,
    height: 1024,
    seed: 100 + minutesAgo,
    seconds: 8.5,
  }
  const item = {
    jobId: id,
    dir: `outputs/20261122-000000-${id}`,
    prompt: `作品 ${id}`,
    presetId: 'flux2-klein-4b',
    finishedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    images: [image],
  }
  return { image, item }
}

const WORK_A = makeWork('job-a', 10)
const WORK_B = makeWork('job-b', 20)
const WORK_C = makeWork('job-c', 30)

function classTokensOf(node) {
  return String((node && node.props && node.props.className) || '').split(/\s+/).filter(Boolean)
}

function nodesByClass(tree, token) {
  return findNodes(tree, (node) => classTokensOf(node).includes(token))
}

function fakeDataTransfer(initialTypes = []) {
  const store = new Map()
  const types = [...initialTypes]
  return {
    types,
    files: [],
    dropEffect: '',
    effectAllowed: '',
    setData(mime, value) {
      store.set(mime, String(value))
      if (!types.includes(mime)) types.push(mime)
    },
    getData(mime) {
      return store.get(mime) || ''
    },
  }
}

function fakeWorkDragEvent(path) {
  const dataTransfer = fakeDataTransfer(['Files'])
  writeWorkDrag(dataTransfer, { image: { path } })
  return {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer,
  }
}

function fakeFileDragEvent(files = []) {
  return {
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { types: ['Files'], files, dropEffect: '' },
  }
}

function studioState(presets, defaultPreset) {
  return {
    defaultPreset,
    presets,
    session: { state: 'ready', modelId: defaultPreset, device: 'Tesla T4', idleTimeoutSec: 1800, error: null },
    jobs: [],
    lastJob: null,
    probe: probeOk,
  }
}

async function main() {
  const { check, summary } = createCheckRunner()

  await check('drag.js：站内作品 MIME 优先于 Files，且不写入 text/plain', () => {
    const dt = fakeDataTransfer(['Files'])
    const written = writeWorkDrag(dt, WORK_A)
    assert.equal(written, WORK_A.image.path)
    assert.equal(dt.getData('text/plain'), '', '不写 text/plain，避免误填入输入框')
    assert.equal(workDragPathOf(dt), WORK_A.image.path)

    const workEvent = { dataTransfer: dt }
    assert.equal(hasWorkDragPayload(workEvent), true)
    assert.equal(hasFilePayload(workEvent), false, '携带站内作品 MIME 时即使并存 Files 也不视为文件导入')

    const fileEvent = fakeFileDragEvent([{ name: 'a.png', type: 'image/png', size: 100 }])
    assert.equal(hasWorkDragPayload(fileEvent), false)
    assert.equal(hasFilePayload(fileEvent), true)

    let active = null
    const ui = { setDraggingWork: (next) => { active = next } }
    beginWorkDrag({ dataTransfer: fakeDataTransfer() }, WORK_B, ui)
    assert.equal(active.path, WORK_B.image.path)
    endWorkDrag(ui)
    assert.equal(active, null)
  })

  await check('Studio 集成：拖底部作品到舞台切预览（两层高亮、零 /import、同图忽略）', async () => {
    const responses = studioResponses(
      studioState([klein, toolCapable], klein.id),
      { items: [WORK_A.item, WORK_B.item] },
    )
    const client = await createTestClient({ now: NOW, responses, testBuild: true })
    try {
      let tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'work' })
      await client.settle()
      tree = await client.rerenderRaw()

      // 源头：Filmstrip 缩略图按钮 draggable=true、内图 draggable=false；舞台大图 draggable=false。
      const thumbs = nodesByClass(tree, 'ofs-thumb')
      assert.equal(thumbs.length, 2)
      assert.equal(thumbs[0].props.draggable, true)
      const thumbImgs = findNodes(thumbs[0], (node) => node.type === 'img')
      assert.equal(thumbImgs[0].props.draggable, false)
      const stageImgs = nodesByClass(tree, 'ofs-image')
      assert.equal(stageImgs[0].props.draggable, false, '舞台大图禁止原生拖出')

      // 起拖 WORK_B（第 2 张）：两层第一层高亮立即出现（舞台 + 左栏参考槽）。
      const dragStartEvent = { dataTransfer: fakeDataTransfer() }
      thumbs[1].props.onDragStart(dragStartEvent)
      tree = await client.rerenderRaw()
      assert.ok(dragStartEvent.dataTransfer.types.includes(WORK_DRAG_MIME))
      assert.equal(nodesByClass(tree, 'is-drop-ready').length, 2, '舞台与左栏参考槽同时进入可放置高亮态')
      assert.ok(collectText(tree).join(' | ').includes('拖到此处在舞台预览'))
      assert.ok(collectText(tree).join(' | ').includes('拖到此处设为参考图'))

      // 悬停进入舞台：第二层高亮激活，文案切换为「松开以在舞台预览」。
      const zone = nodesByClass(tree, 'ofs-import-zone')[0]
      zone.props.onDragEnter(fakeWorkDragEvent(WORK_B.image.path))
      tree = await client.rerenderRaw()
      assert.ok(classTokensOf(nodesByClass(tree, 'ofs-import-zone')[0]).includes('is-dragging'))
      assert.ok(collectText(tree).join(' | ').includes('松开以在舞台预览'))

      // 松手落定：切到 WORK_B，不发 /api/import。
      nodesByClass(tree, 'ofs-import-zone')[0].props.onDrop(fakeWorkDragEvent(WORK_B.image.path))
      await client.settle()
      tree = await client.rerenderRaw()
      assert.equal(client.requests.filter((item) => item.path === '/api/import').length, 0, '站内拖拽绝不调用 /api/import')
      assert.equal(nodesByClass(tree, 'ofs-image')[0].props.src, WORK_B.image.url, '舞台应切换为 WORK_B')
      assert.equal(nodesByClass(tree, 'is-drop-ready').length, 0, '落定后高亮复位')

      // 拖当前已经在舞台上的 WORK_B 自己：不触发舞台高亮，也不触发悬停切换。
      nodesByClass(tree, 'ofs-thumb')[1].props.onDragStart({ dataTransfer: fakeDataTransfer() })
      tree = await client.rerenderRaw()
      assert.ok(
        !classTokensOf(nodesByClass(tree, 'ofs-import-zone')[0]).includes('is-drop-ready'),
        '拖当前舞台作品自身时舞台不亮起可放置提示',
      )
      nodesByClass(tree, 'ofs-import-zone')[0].props.onDragEnter(fakeWorkDragEvent(WORK_B.image.path))
      tree = await client.rerenderRaw()
      assert.ok(!classTokensOf(nodesByClass(tree, 'ofs-import-zone')[0]).includes('is-dragging'))
      nodesByClass(tree, 'ofs-thumb')[1].props.onDragEnd()
    } finally {
      client.unmount()
    }
  })

  await check('Studio 集成：拖底部作品到左栏参考槽（原路径入槽、零 /import、重复与满额反馈）', async () => {
    const responses = studioResponses(
      studioState([klein, toolCapable], klein.id),
      { items: [WORK_A.item, WORK_B.item, WORK_C.item] },
    )
    const client = await createTestClient({ now: NOW, responses, testBuild: true })
    try {
      let tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'work' })
      await client.settle()
      tree = await client.rerenderRaw()

      // 起拖 WORK_B，悬停并释放到左侧参考槽。
      nodesByClass(tree, 'ofs-thumb')[1].props.onDragStart({ dataTransfer: fakeDataTransfer() })
      tree = await client.rerenderRaw()
      let refZone = nodesByClass(tree, 'ofs-ref-zone')[0]
      refZone.props.onDragEnter(fakeWorkDragEvent(WORK_B.image.path))
      tree = await client.rerenderRaw()
      assert.ok(collectText(tree).join(' | ').includes('松开以设为参考图'))

      nodesByClass(tree, 'ofs-ref-zone')[0].props.onDrop(fakeWorkDragEvent(WORK_B.image.path))
      await client.settle()
      tree = await client.rerenderRaw()
      assert.equal(client.requests.filter((item) => item.path === '/api/import').length, 0, '参考槽站内拖拽不走 /api/import')
      const refThumbs = nodesByClass(tree, 'ofs-ref-thumb')
      assert.equal(refThumbs.length, 1)
      assert.equal(refThumbs[0].props.src, WORK_B.image.url)
      assert.equal(refThumbs[0].props.draggable, false, '参考槽已挂缩略图禁止再次拖出')
      assert.equal(nodesByClass(tree, 'ofs-image')[0].props.src, WORK_A.image.url, '拖到参考槽不抢走舞台焦点')

      // 再起拖已在槽中的 WORK_B：参考槽显示重复不可放提示。
      nodesByClass(tree, 'ofs-thumb')[1].props.onDragStart({ dataTransfer: fakeDataTransfer() })
      tree = await client.rerenderRaw()
      refZone = nodesByClass(tree, 'ofs-ref-zone')[0]
      assert.ok(classTokensOf(refZone).includes('is-drop-blocked'))
      assert.ok(collectText(refZone).join(' | ').includes('这张图已在参考图槽里'))
      nodesByClass(tree, 'ofs-thumb')[1].props.onDragEnd()

      // 加入 WORK_C 达到 2 张满额后，再起拖 WORK_A：参考槽显示满额不可放提示。
      nodesByClass(tree, 'ofs-ref-zone')[0].props.onDrop(fakeWorkDragEvent(WORK_C.image.path))
      await client.settle()
      tree = await client.rerenderRaw()
      assert.equal(nodesByClass(tree, 'ofs-ref-thumb').length, 2)
      nodesByClass(tree, 'ofs-thumb')[0].props.onDragStart({ dataTransfer: fakeDataTransfer() })
      tree = await client.rerenderRaw()
      refZone = nodesByClass(tree, 'ofs-ref-zone')[0]
      assert.ok(classTokensOf(refZone).includes('is-drop-blocked'))
      assert.ok(collectText(refZone).join(' | ').includes('参考图已满 2 张'))
      nodesByClass(tree, 'ofs-thumb')[0].props.onDragEnd()
    } finally {
      client.unmount()
    }
  })

  await check('边界 1.A 与 2.A：不支持参考模型不展开参考槽；编辑态拒绝拖入切图', async () => {
    const responses = studioResponses(
      studioState([toolCapable, klein], toolCapable.id),
      { items: [WORK_A.item, WORK_B.item] },
    )
    const client = await createTestClient({ now: NOW, responses, testBuild: true })
    try {
      let tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'work' })
      await client.settle()
      tree = await client.rerenderRaw()

      // 1.A：SDXL 下槽位为空，起拖作品时参考槽保持隐藏，不发生布局跳动。
      assert.equal(nodesByClass(tree, 'ofs-ref-zone').length, 0)
      nodesByClass(tree, 'ofs-thumb')[1].props.onDragStart({ dataTransfer: fakeDataTransfer() })
      tree = await client.rerenderRaw()
      assert.equal(nodesByClass(tree, 'ofs-ref-zone').length, 0, '不支持参考的模型下起拖不展开参考区')
      assert.ok(classTokensOf(nodesByClass(tree, 'ofs-import-zone')[0]).includes('is-drop-ready'))
      nodesByClass(tree, 'ofs-thumb')[1].props.onDragEnd()

      // 2.A：进入局部涂抹编辑态后，起拖不亮引导框；悬停提示拦截；drop 不切图不丢草稿。
      const inpaintBtn = findNodes(
        nodesByClass(tree, 'ofs-dock')[0],
        (node) => node.type === 'button' && collectText(node).join('').includes('局部重绘'),
      )[0]
      inpaintBtn.props.onClick()
      await client.settle()
      tree = await client.rerenderRaw()
      assert.equal(nodesByClass(tree, 'ofs-mask-editor').length, 1)

      nodesByClass(tree, 'ofs-thumb')[1].props.onDragStart({ dataTransfer: fakeDataTransfer() })
      tree = await client.rerenderRaw()
      assert.ok(!classTokensOf(nodesByClass(tree, 'ofs-import-zone')[0]).includes('is-drop-ready'))

      nodesByClass(tree, 'ofs-import-zone')[0].props.onDragEnter(fakeWorkDragEvent(WORK_B.image.path))
      tree = await client.rerenderRaw()
      assert.ok(collectText(tree).join(' | ').includes('请先退出或暂存当前涂抹，再切换作品'))

      nodesByClass(tree, 'ofs-import-zone')[0].props.onDrop(fakeWorkDragEvent(WORK_B.image.path))
      await client.settle()
      tree = await client.rerenderRaw()
      assert.equal(nodesByClass(tree, 'ofs-mask-editor').length, 1, '编辑态拖入作品被拦截，不退出编辑态')
      assert.ok(collectText(tree).join(' | ').includes('请先退出或暂存当前涂抹，再切换作品'))
    } finally {
      client.unmount()
    }
  })

  await check('舞台外部文件导入文案区分：空态「松开以导入图片」vs 有作品「松开以导入为新作品」', async () => {
    const client = await createTestClient({
      now: NOW,
      responses: studioResponses(studioState([klein], klein.id), { items: [WORK_A.item] }),
      testBuild: true,
    })
    try {
      // 新画布空态
      let tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'new_draft' })
      await client.settle()
      tree = await client.rerenderRaw()
      nodesByClass(tree, 'ofs-import-zone')[0].props.onDragEnter(fakeFileDragEvent())
      tree = await client.rerenderRaw()
      assert.ok(collectText(tree).join(' | ').includes('松开以导入图片'))
      nodesByClass(tree, 'ofs-import-zone')[0].props.onDragLeave(fakeFileDragEvent())
      client.unmount()

      // 已有作品浏览态
      tree = await client.mountRaw(client.components.Studio, { workspaceMode: 'work' })
      await client.settle()
      tree = await client.rerenderRaw()
      nodesByClass(tree, 'ofs-import-zone')[0].props.onDragEnter(fakeFileDragEvent())
      tree = await client.rerenderRaw()
      assert.ok(collectText(tree).join(' | ').includes('松开以导入为新作品'))
    } finally {
      client.unmount()
    }
  })

  await check('VersionPanel 展开行支持拖拽且内图 draggable=false', async () => {
    const childImage = {
      path: 'outputs/20261122-000001-child/01.png',
      file: '01.png',
      url: '/api/file?path=outputs%2F20261122-000001-child%2F01.png',
      width: 1024,
      height: 1024,
      seed: 200,
    }
    const childItem = {
      jobId: 'child',
      dir: 'outputs/20261122-000001-child',
      prompt: '局部重绘子版本',
      presetId: 'flux2-klein-4b',
      sourceImage: WORK_A.image.path,
      rootImage: WORK_A.image.path,
      inpaint: true,
      finishedAt: new Date(NOW - 60_000).toISOString(),
      images: [childImage],
    }
    const client = await createTestClient({ now: NOW, responses: {}, testBuild: true })
    const t = client.internals.i18n.fallbackTranslate('zh')
    let dragging = null
    try {
      let tree = await client.mountRaw(client.components.Filmstrip, {
        t,
        ui: { setView: () => {}, setDraggingWork: (next) => { dragging = next } },
        compute: { pendingJobs: [], sessionState: 'ready', startSession: () => {}, status: {}, cancelJob: () => {}, cancellingIds: [] },
        library: {
          items: [childItem, WORK_A.item],
          gallery: [WORK_A, { image: childImage, item: childItem }],
          selected: WORK_A,
          selectImage: () => {},
          workspaceMode: 'work',
          newDraftCard: {},
        },
        actions: { previewWork: () => {} },
      })
      const badge = nodesByClass(tree, 'ofs-version-badge')[0]
      badge.props.onClick({ stopPropagation() {}, preventDefault() {} })
      tree = await client.rerenderRaw()
      const rowBtns = nodesByClass(tree, 'ofs-version-row-main')
      assert.equal(rowBtns.length, 2)
      assert.equal(rowBtns[0].props.draggable, true)
      assert.equal(findNodes(rowBtns[0], (node) => node.type === 'img')[0].props.draggable, false)

      const dt = fakeDataTransfer()
      rowBtns[0].props.onDragStart({ dataTransfer: dt })
      assert.equal(dragging.path, WORK_A.image.path)
      assert.equal(dt.getData(WORK_DRAG_MIME), WORK_A.image.path)
      rowBtns[0].props.onDragEnd()
      assert.equal(dragging, null)
    } finally {
      client.unmount()
    }
  })

  summary()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
