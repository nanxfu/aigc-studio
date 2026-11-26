import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppConfig } from '../server/app-config.js'
import { createAppSettingsRoutes } from '../server/routes/app-settings.js'
import { createCheckRunner } from './helpers/check.mjs'
import { closeServer, json, startHost } from './helpers/fake-context.mjs'

const { check, summary } = createCheckRunner()
const log = { debug() {}, info() {}, warn() {}, error() {} }
const dirs = []
async function configDir() {
  const dir = await mkdtemp(join(tmpdir(), 'aigc-onboarding-'))
  dirs.push(dir)
  return dir
}
async function openConfig(dataDir) {
  const config = createAppConfig({ dataDir, log })
  await config.whenReady()
  return config
}

try {
  await check('新安装 pending；保存其它设置与重启仍保留引导状态', async () => {
    const dir = await configDir()
    const config = await openConfig(dir)
    assert.deepEqual(config.publicSettingsView().onboarding, { version: 1, status: 'pending' })
    assert.equal((await config.saveSettings({ ui: { lang: 'en' } })).ok, true)
    assert.deepEqual((await openConfig(dir)).publicSettingsView().onboarding, { version: 1, status: 'pending' })
  })

  await check('旧安装升级不弹引导；已保存的语言与模型保留', async () => {
    const dir = await configDir()
    await writeFile(join(dir, 'app-config.json'), JSON.stringify({ schema: 1, ui: { lang: 'en', theme: 'dark' }, llm: { provider: 'deepseek', model: 'deepseek-chat' } }))
    const config = await openConfig(dir)
    assert.deepEqual(config.publicSettingsView().onboarding, { version: 1, status: 'skipped' })
    assert.equal(config.publicSettingsView().llm.model, 'deepseek-chat')
    assert.equal(config.publicSettingsView().ui.lang, 'en')
  })

  await check('HTTP：完成与跳过状态持久化；API Key 不进入配置或响应', async () => {
    const dir = await configDir()
    const config = await openConfig(dir)
    const host = await startHost(createAppSettingsRoutes({ appConfig: config, log }))
    try {
      const get = await json(host.origin, '/api/app-settings')
      assert.equal(get.body.settings.onboarding.status, 'pending')
      const saved = await json(host.origin, '/api/app-settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'onboarding-test-secret' }, onboarding: { version: 1, status: 'completed', apiKey: 'ignored' } }),
      })
      assert.equal(saved.status, 200)
      assert.deepEqual(saved.body.settings.onboarding, { version: 1, status: 'completed' })
      assert.equal(saved.body.settings.llm.hasApiKey, true)
      assert.equal(JSON.stringify(saved.body).includes('onboarding-test-secret'), false)
      const disk = await readFile(join(dir, 'app-config.json'), 'utf8')
      assert.equal(disk.includes('onboarding-test-secret'), false)
      assert.equal(disk.includes('ignored'), false)
      assert.equal((await openConfig(dir)).publicSettingsView().onboarding.status, 'completed')
      const skipped = await config.saveSettings({ onboarding: { version: 1, status: 'skipped' } })
      assert.equal(skipped.ok, true)
      assert.equal((await openConfig(dir)).publicSettingsView().onboarding.status, 'skipped')
    } finally { await closeServer(host.server) }
  })

  await check('非法引导状态拒绝，且不保存同一请求中的其它配置', async () => {
    const config = await openConfig(await configDir())
    for (const onboarding of [null, [], { version: 2, status: 'completed' }, { version: 1, status: 'pending' }, { version: 1, status: 'unknown' }]) {
      const result = await config.saveSettings({ ui: { lang: 'en' }, onboarding })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'invalid_request')
      assert.equal(config.publicSettingsView().onboarding.status, 'pending')
      assert.equal(config.publicSettingsView().ui.lang, 'zh')
    }
  })
} finally {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
}
summary()
