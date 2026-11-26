#!/usr/bin/env node
/**
 * 桌面端匿名遥测（app-config.telemetry / createTelemetry / Pages Function）离线回归。
 *
 * 运行：node test/telemetry.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppConfig } from '../server/app-config.js'
import { createAppSettingsRoutes } from '../server/routes/app-settings.js'
import { createTelemetry } from '../server/telemetry.js'
import { handleTelemetryPost } from '../site/functions/api/telemetry.js'
import { createCheckRunner } from './helpers/check.mjs'
import { closeServer, json, startHost } from './helpers/fake-context.mjs'

const { check, summary } = createCheckRunner()
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const tempDirs = []

async function makeDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

try {
  await check('app-config 默认开启遥测并持久化匿名 installId，公开视图隐藏 installId', async () => {
    const dataDir = await makeDir('aigc-telemetry-cfg-')
    const appConfig = createAppConfig({ dataDir, log: silentLog })
    await appConfig.whenReady()

    const internal = appConfig.getTelemetry()
    assert.equal(internal.enabled, true)
    assert.match(internal.installId, /^[a-zA-Z0-9_-]{8,64}$/)

    const pub = appConfig.publicSettingsView()
    assert.deepEqual(pub.telemetry, { enabled: true })
    assert.equal(Object.prototype.hasOwnProperty.call(pub.telemetry, 'installId'), false)

    // 重启后保持同一个 installId
    const appConfig2 = createAppConfig({ dataDir, log: silentLog })
    await appConfig2.whenReady()
    assert.equal(appConfig2.getTelemetry().installId, internal.installId)
  })

  await check('/api/app-settings 可开关 telemetry.enabled 并持久化，非法值返回 400', async () => {
    const dataDir = await makeDir('aigc-telemetry-route-')
    const appConfig = createAppConfig({ dataDir, log: silentLog })
    await appConfig.whenReady()
    const routes = createAppSettingsRoutes({ appConfig, version: '0.16.0', log: silentLog })
    const host = await startHost(routes)
    try {
      const bad = await json(host.origin, '/api/app-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telemetry: { enabled: 'yes' } }),
      })
      assert.equal(bad.status, 400)

      const off = await json(host.origin, '/api/app-settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telemetry: { enabled: false } }),
      })
      assert.equal(off.status, 200)
      assert.deepEqual(off.body.settings.telemetry, { enabled: false })

      const saved = JSON.parse(await readFile(join(dataDir, 'app-config.json'), 'utf8'))
      assert.equal(saved.telemetry.enabled, false)
    } finally {
      await closeServer(host.server)
    }
  })

  await check('createTelemetry 测试进程默认禁用外部请求；mock sender 验证脱敏与开关控制', async () => {
    const dataDir = await makeDir('aigc-telemetry-send-')
    const appConfig = createAppConfig({ dataDir, log: silentLog })
    await appConfig.whenReady()

    // 未传入自定义 sender 时，test/ 目录脚本下默认禁用外部发送
    const defaultInstance = createTelemetry({ appConfig, version: '0.16.0', log: silentLog })
    assert.equal(defaultInstance.enabled, false)
    assert.equal(defaultInstance.track('app_launch', { provider: 'kaggle' }), false)

    const sent = []
    const telemetry = createTelemetry({
      appConfig,
      version: '0.16.0',
      getLang: () => 'zh',
      log: silentLog,
      sender: async (endpoint, payload) => {
        sent.push({ endpoint, payload })
      },
    })

    assert.equal(telemetry.enabled, true)
    assert.equal(
      telemetry.track('generate_done', {
        provider: 'kaggle',
        presetId: 'z-image-turbo',
        prompt: 'secret prompt must be stripped',
        apiKey: 'sk-secret',
        path: 'C:/secret/a.png',
        seconds: 4.2,
      }),
      true,
    )
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.event, 'generate_done')
    assert.equal(sent[0].payload.version, '0.16.0')
    assert.equal(sent[0].payload.lang, 'zh')
    assert.deepEqual(sent[0].payload.props, {
      provider: 'kaggle',
      presetId: 'z-image-turbo',
      seconds: 4.2,
    })

    // 关闭开关后立即停止上报
    await appConfig.saveSettings({ telemetry: { enabled: false } })
    assert.equal(telemetry.track('workshop_op', { action: 'vectorize' }), false)
    assert.equal(telemetry.track('unknown_event', {}), false)
    telemetry.dispose()
  })

  await check('Cloudflare Pages Function 校验事件、脱敏并在绑定 D1 时写入', async () => {
    const reqInit = (body) =>
      new Request('https://aigc-studio-8rj.pages.dev/api/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })

    // 未绑定 D1 时静默 202
    const unconfigured = await handleTelemetryPost(
      reqInit({
        installId: 'install-12345678',
        event: 'app_launch',
        version: '0.16.0',
        os: 'win32',
        lang: 'zh',
        props: { provider: 'kaggle' },
      }),
      {},
    )
    assert.equal(unconfigured.status, 202)

    // 非法事件返回 400
    const badEvent = await handleTelemetryPost(
      reqInit({ installId: 'install-12345678', event: 'evil_event' }),
      {},
    )
    assert.equal(badEvent.status, 400)

    // 绑定 mock D1 后写入成功
    const boundArgs = []
    const mockEnv = {
      TELEMETRY_DB: {
        prepare(sql) {
          assert.match(sql, /^INSERT INTO events/)
          return {
            bind(...args) {
              boundArgs.push(args)
              return { run: async () => ({ success: true }) }
            },
          }
        },
      },
    }
    const ok = await handleTelemetryPost(
      reqInit({
        installId: 'install-12345678',
        event: 'generate_fail',
        version: '0.16.0',
        os: 'win32',
        lang: 'en',
        props: { provider: 'colab', errorCode: 'session_timeout', nested: { bad: 1 } },
      }),
      mockEnv,
    )
    assert.equal(ok.status, 200)
    assert.equal(boundArgs.length, 1)
    assert.equal(boundArgs[0][1], 'install-12345678')
    assert.equal(boundArgs[0][2], 'generate_fail')
    assert.equal(boundArgs[0][3], '0.16.0')
    assert.equal(boundArgs[0][7], JSON.stringify({ provider: 'colab', errorCode: 'session_timeout' }))
  })
} finally {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
}

summary()
