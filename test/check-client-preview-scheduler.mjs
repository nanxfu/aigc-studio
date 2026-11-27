import assert from 'node:assert/strict'
import { createTestClient } from './helpers/render.mjs'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

await check('实时预览：最多一个渲染在途，输入合并到最新值，切作品丢弃旧结果', async () => {
  const client = await createTestClient({ responses: {}, testBuild: true })
  const input = { value: 1, context: 'first' }
  const running = []
  const published = []
  function Harness() {
    const value = input.value
    client.hooks.useLatestPreview(async (isCurrent) => {
      let release
      const gate = new Promise((resolve) => { release = resolve })
      running.push({ value, release })
      await gate
      if (isCurrent()) published.push(value)
    }, [value, input.context], input.context)
    return client.react.createElement('div')
  }
  try {
    await client.mountRaw(Harness, {})
    await client.advanceTimers(1)
    assert.deepEqual(running.map((item) => item.value), [1])
    input.value = 2
    await client.rerenderRaw()
    input.value = 3
    await client.rerenderRaw()
    await client.advanceTimers(1)
    assert.equal(running.length, 1, '不得并发启动第二个 GPU 渲染')
    running[0].release()
    await client.settle()
    await client.advanceTimers(1)
    assert.deepEqual(running.map((item) => item.value), [1, 3], '中间输入必须合并')
    input.context = 'second'
    input.value = 4
    await client.rerenderRaw()
    running[1].release()
    await client.settle()
    await client.advanceTimers(1)
    assert.deepEqual(published, [1], '旧作品渲染不得覆盖新作品')
    assert.equal(running[2].value, 4)
    client.unmount()
    running[2].release()
    await client.settle()
    assert.deepEqual(published, [1], '卸载后不得发布迟到结果')
  } finally {
    client.unmount()
  }
})

summary()
