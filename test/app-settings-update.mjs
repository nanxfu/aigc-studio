#!/usr/bin/env node
/**
 * 更新配置（app-config.update）与 /api/app-settings 的离线回归。
 *
 * 覆盖（docs/M2_8_RELEASE_AND_UPDATER_SPEC.md §3.5/§3.7）：
 *  - GET /api/app-settings 返回 update 段（默认关闭、GitHub 源）；
 *  - POST 可持久化 updateCheck / updateSource / updateMirrorUrl，保存后重启进程仍能读回；
 *  - 非法枚举 / 非 https / userinfo / query / 超长 URL / custom 缺镜像 → 400；
 *  - 旧 compute.updateCheck 一次性迁移到 update.updateCheck（写回后 compute 不再保留）；
 *  - 保存 update 后触发 onUpdateChanged 回调（服务端只读检查器立即按新源排期）。
 *
 * 运行：node test/app-settings-update.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppConfig } from '../server/app-config.js'
import { createAppSettingsRoutes } from '../server/routes/app-settings.js'
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

async function makeHost(options = {}) {
  const dataDir = options.dataDir ?? await makeDir('aigc-update-config-')
  const appConfig = createAppConfig({ dataDir, log: silentLog })
  await appConfig.whenReady()
  const calls = { updateChanged: 0 }
  const routes = createAppSettingsRoutes({
    appConfig,
    version: '0.14.0',
    log: silentLog,
    onUpdateChanged: () => {
      calls.updateChanged += 1
    },
  })
  const host = await startHost(routes)
  return { dataDir, appConfig, host, calls }
}

function postUpdate(origin, update) {
  return json(origin, '/api/app-settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update }),
  })
}

try {
  await check('GET：默认 update 段为「关闭自动检查 + GitHub 源 + 空镜像」', async () => {
    const { host } = await makeHost()
    try {
      const res = await json(host.origin, '/api/app-settings')
      assert.equal(res.status, 200)
      assert.deepEqual(res.body.settings.update, {
        updateCheck: false,
        updateSource: 'github',
        updateMirrorUrl: '',
      })
    } finally {
      await closeServer(host.server)
    }
  })

  await check('POST：开启自动检查 + 自定义镜像，地址去尾斜杠并持久化', async () => {
    const { host, appConfig, dataDir, calls } = await makeHost()
    try {
      const saved = await postUpdate(host.origin, {
        updateCheck: true,
        updateSource: 'custom',
        updateMirrorUrl: ' https://mirror.example.com/aigc-studio/ ',
      })
      assert.equal(saved.status, 200)
      assert.deepEqual(saved.body.settings.update, {
        updateCheck: true,
        updateSource: 'custom',
        updateMirrorUrl: 'https://mirror.example.com/aigc-studio',
      })
      assert.equal(calls.updateChanged, 1, '保存 update 后应通知检查器刷新')
      assert.deepEqual(appConfig.getUpdate(), {
        updateCheck: true,
        updateSource: 'custom',
        updateMirrorUrl: 'https://mirror.example.com/aigc-studio',
      })

      // 重启进程（同一 dataDir 重新加载）仍能读回。
      const reopened = createAppConfig({ dataDir, log: silentLog })
      await reopened.whenReady()
      assert.deepEqual(reopened.getUpdate(), {
        updateCheck: true,
        updateSource: 'custom',
        updateMirrorUrl: 'https://mirror.example.com/aigc-studio',
      })
      const raw = JSON.parse(await readFile(join(dataDir, 'app-config.json'), 'utf8'))
      assert.equal(raw.update.updateCheck, true)
      assert.equal(raw.update.updateSource, 'custom')
      assert.equal(Object.prototype.hasOwnProperty.call(raw.compute ?? {}, 'updateCheck'), false, 'compute 不应再保留 updateCheck')
    } finally {
      await closeServer(host.server)
    }
  })

  await check('POST：非法枚举 / 非 https / userinfo / query / 超长 / custom 缺镜像 → 400', async () => {
    const { host, appConfig } = await makeHost()
    try {
      const cases = [
        { updateCheck: 'yes' },
        { updateSource: 'ftp' },
        { updateMirrorUrl: 'http://mirror.example.com' },
        { updateMirrorUrl: 'https://user:pass@mirror.example.com' },
        { updateMirrorUrl: 'https://mirror.example.com?a=1' },
        { updateMirrorUrl: `https://mirror.example.com/${'a'.repeat(600)}` },
        { updateSource: 'custom', updateMirrorUrl: '' },
      ]
      for (const patch of cases) {
        const res = await postUpdate(host.origin, patch)
        assert.equal(res.status, 400, `应拒绝：${JSON.stringify(patch)}`)
        assert.equal(res.body.error.code, 'invalid_request')
      }
      // 失败请求不能改动已落盘配置。
      assert.deepEqual(appConfig.getUpdate(), {
        updateCheck: false,
        updateSource: 'github',
        updateMirrorUrl: '',
      })
    } finally {
      await closeServer(host.server)
    }
  })

  await check('迁移：旧 compute.updateCheck 搬到 update 段并写回，compute 键被移除', async () => {
    const dataDir = await makeDir('aigc-update-migrate-')
    const legacy = {
      schema: 1,
      workspace: { current: null, recent: [] },
      ui: { lang: 'zh', theme: 'system' },
      llm: { provider: 'openai', baseUrl: '', model: '', reasoningEffort: '' },
      compute: { provider: 'kaggle', updateCheck: true, idleTimeoutSec: 1800 },
    }
    await writeFile(join(dataDir, 'app-config.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

    const appConfig = createAppConfig({ dataDir, log: silentLog })
    await appConfig.whenReady()
    assert.deepEqual(appConfig.getUpdate(), {
      updateCheck: true,
      updateSource: 'github',
      updateMirrorUrl: '',
    })
    // compute 其它键保留，updateCheck 不再出现。
    assert.equal(appConfig.getCompute().provider, 'kaggle')
    assert.equal(appConfig.getCompute().idleTimeoutSec, 1800)
    assert.equal(Object.prototype.hasOwnProperty.call(appConfig.getCompute(), 'updateCheck'), false)

    // 一次性迁移会写回文件。
    const migrated = JSON.parse(await readFile(join(dataDir, 'app-config.json'), 'utf8'))
    assert.deepEqual(migrated.update, {
      updateCheck: true,
      updateSource: 'github',
      updateMirrorUrl: '',
    })
    assert.equal(Object.prototype.hasOwnProperty.call(migrated.compute, 'updateCheck'), false)
  })
} finally {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
}

summary()
