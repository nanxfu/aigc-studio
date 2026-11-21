#!/usr/bin/env node
/**
 * 主进程更新器状态机回归（假 autoUpdater，不启动 Electron、不联网）。
 *
 * 覆盖（docs/M2_8_RELEASE_AND_UPDATER_SPEC.md §3.3/§3.4/§3.7）：
 *  - electron-updater 事件 → UpdateState 迁移（checking / available / progress / downloaded / error）；
 *  - 下载进度节流（1% 或 500ms）；
 *  - 「退出时安装」只在下载完成后生效；
 *  - 安装护栏：活跃会话 / 队列阻止安装，空闲才触发 onInstallReady；
 *  - 自动检查开关与手动检查（manual 不受开关限制）；
 *  - 自定义更新源 setFeedURL(generic)。
 *
 * 运行：node test/updater-main.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createUpdater } from '../electron/updater.mjs'
import { resolveInstallForm } from '../electron/updater/policy.mjs'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super()
    this.checkCalls = 0
    this.downloadCalls = 0
    this.quitCalls = []
    this.feed = null
  }

  async checkForUpdates() {
    this.checkCalls += 1
    return null
  }

  async downloadUpdate() {
    this.downloadCalls += 1
  }

  quitAndInstall(...args) {
    this.quitCalls.push(args)
  }

  setFeedURL(options) {
    this.feed = options
  }
}

const POLICY = resolveInstallForm({
  isPackaged: true,
  platform: 'win32',
  env: {},
  execPath: 'C:\\AIGC Studio\\AIGC Studio.exe',
  resourcesPath: 'C:\\AIGC Studio\\resources',
  hasUpdateConfig: true,
})

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * @param {{ settings?: object, serverState?: object | (() => object), now?: () => number }} [options]
 */
async function makeUpdater(options = {}) {
  const autoUpdater = new FakeAutoUpdater()
  const clock = { time: 1_000_000 }
  const installed = { count: 0 }
  const states = []
  const updater = await createUpdater({
    autoUpdater,
    policy: POLICY,
    currentVersion: '0.14.0',
    log: silentLog,
    now: options.now ?? (() => clock.time),
    getSettings: async () => options.settings ?? { updateCheck: true, updateSource: 'github', updateMirrorUrl: '' },
    getServerState: async () => {
      if (typeof options.serverState === 'function') return options.serverState()
      return options.serverState ?? {
        ok: true,
        at: clock.time,
        session: { state: 'absent' },
        queue: { running: false, pending: 0 },
        jobs: [],
      }
    },
    onInstallReady: () => {
      installed.count += 1
    },
    onStateChange: (state) => states.push(state),
  })
  return { updater, autoUpdater, clock, installed, states }
}

await check('事件映射：checking → available → downloading → downloaded', async () => {
  const { updater, autoUpdater, states } = await makeUpdater()
  assert.equal(updater.getState().status, 'idle')
  assert.equal(updater.getState().canAutoUpdate, true)
  assert.equal(updater.getState().current, '0.14.0')

  autoUpdater.emit('checking-for-update')
  assert.equal(updater.getState().status, 'checking')

  autoUpdater.emit('update-available', { version: '0.15.0', releaseName: 'AIGC Studio 0.15.0' })
  let state = updater.getState()
  assert.equal(state.status, 'available')
  assert.equal(state.latest, '0.15.0')
  assert.equal(state.hasUpdate, true)
  assert.equal(state.releaseName, 'AIGC Studio 0.15.0')
  assert.ok(state.releaseUrl && state.releaseUrl.endsWith('/tag/v0.15.0'))
  assert.ok(state.checkedAt)

  autoUpdater.emit('download-progress', { percent: 12.5, transferred: 1_000, total: 8_000, bytesPerSecond: 500 })
  state = updater.getState()
  assert.equal(state.status, 'downloading')
  assert.equal(state.progress.percent, 12.5)
  assert.equal(state.progress.transferred, 1_000)

  autoUpdater.emit('update-downloaded', { version: '0.15.0' })
  state = updater.getState()
  assert.equal(state.status, 'downloaded')
  assert.equal(state.progress, null)
  assert.equal(state.hasUpdate, true)

  // 最后一次推送与状态一致
  assert.equal(states.at(-1).status, 'downloaded')
})

await check('update-not-available：保留最新版本号，hasUpdate=false', async () => {
  const { updater, autoUpdater } = await makeUpdater()
  autoUpdater.emit('update-not-available', { version: '0.14.0' })
  const state = updater.getState()
  assert.equal(state.status, 'up-to-date')
  assert.equal(state.latest, '0.14.0')
  assert.equal(state.hasUpdate, false)
  assert.equal(state.releaseUrl, null)
})

await check('错误事件：分类为可读错误码，恢复检查时先清 error', async () => {
  const { updater, autoUpdater } = await makeUpdater()
  autoUpdater.emit('error', new Error('sha512 checksum mismatch'))
  let state = updater.getState()
  assert.equal(state.status, 'error')
  assert.equal(state.error.code, 'checksum')

  autoUpdater.emit('checking-for-update')
  state = updater.getState()
  assert.equal(state.status, 'checking')
  assert.equal(state.error, null)
})

await check('进度节流：1% 或 500ms 内不重复推送，超过阈值才更新', async () => {
  const { updater, autoUpdater, clock, states } = await makeUpdater()
  autoUpdater.emit('update-available', { version: '0.15.0' })
  autoUpdater.emit('download-progress', { percent: 10, transferred: 10, total: 100, bytesPerSecond: 1 })
  assert.equal(updater.getState().progress.percent, 10)
  const before = states.length

  autoUpdater.emit('download-progress', { percent: 10.4, transferred: 10, total: 100, bytesPerSecond: 1 })
  assert.equal(updater.getState().progress.percent, 10, '不足 1% 且未到 500ms，应被节流')
  assert.equal(states.length, before)

  clock.time += 600
  autoUpdater.emit('download-progress', { percent: 10.4, transferred: 10, total: 100, bytesPerSecond: 1 })
  assert.equal(updater.getState().progress.percent, 10.4, '超过 500ms 应放行')
  assert.ok(states.length > before)
})

await check('退出时安装：只有 downloaded 之后才生效', async () => {
  const { updater, autoUpdater } = await makeUpdater()
  autoUpdater.emit('update-available', { version: '0.15.0' })
  updater.setInstallOnQuit(true)
  assert.equal(updater.getState().installOnQuit, false, '未下载完成时应忽略')

  autoUpdater.emit('update-downloaded', { version: '0.15.0' })
  updater.setInstallOnQuit(true)
  assert.equal(updater.getState().installOnQuit, true)

  updater.setInstallOnQuit(false)
  assert.equal(updater.getState().installOnQuit, false)
})

await check('安装护栏：会话活跃 / 队列活跃时阻止，且不触发安装回调', async () => {
  let mode = 'ready'
  const serverStates = {
    ready: { ok: true, at: 1_000_000, session: { state: 'ready' }, queue: { running: false, pending: 0 } },
    queued: { ok: true, at: 1_000_000, session: { state: 'absent' }, queue: { running: false, pending: 1 } },
    idle: { ok: true, at: 1_000_000, session: { state: 'absent' }, queue: { running: false, pending: 0 } },
  }
  const { updater, autoUpdater, installed } = await makeUpdater({ serverState: () => serverStates[mode] })
  autoUpdater.emit('update-available', { version: '0.15.0' })
  autoUpdater.emit('update-downloaded', { version: '0.15.0' })

  mode = 'ready'
  assert.deepEqual(await updater.install(), { ok: false, reason: 'session_active' })
  assert.equal(installed.count, 0)

  mode = 'queued'
  assert.deepEqual(await updater.install(), { ok: false, reason: 'queue_active' })
  assert.equal(installed.count, 0)

  mode = 'idle'
  assert.deepEqual(await updater.install(), { ok: true, reason: null })
  assert.equal(installed.count, 1)
})

await check('安装护栏：无法读取云端状态时阻止安装', async () => {
  const { updater, autoUpdater, installed } = await makeUpdater({
    serverState: () => {
      throw new Error('ECONNREFUSED 127.0.0.1')
    },
  })
  autoUpdater.emit('update-available', { version: '0.15.0' })
  autoUpdater.emit('update-downloaded', { version: '0.15.0' })
  assert.deepEqual(await updater.install(), { ok: false, reason: 'state_unknown' })
  assert.equal(installed.count, 0)
})

await check('自动检查开关：check() 受开关约束，manual 不受约束', async () => {
  const { updater, autoUpdater } = await makeUpdater({
    settings: { updateCheck: false, updateSource: 'github', updateMirrorUrl: '' },
  })
  await updater.check()
  assert.equal(autoUpdater.checkCalls, 0, '关闭自动检查时不应发起检查')

  await updater.check({ manual: true })
  assert.equal(autoUpdater.checkCalls, 1, '手动检查必须能发起')
  assert.equal(updater.isAutoCheckEnabled(), false)
})

await check('自定义更新源：setFeedURL(generic)，源变更后旧结果作废', async () => {
  const { updater, autoUpdater } = await makeUpdater({
    settings: { updateCheck: true, updateSource: 'custom', updateMirrorUrl: 'https://mirror.example.com/aigc' },
  })
  assert.deepEqual(autoUpdater.feed, { provider: 'generic', url: 'https://mirror.example.com/aigc' })
  assert.equal(updater.getState().source, 'custom')

  autoUpdater.emit('update-available', { version: '0.15.1' })
  assert.ok(updater.getState().releaseUrl.startsWith('https://mirror.example.com/aigc'))

  updater.setSource('github', '')
  const state = updater.getState()
  assert.equal(state.source, 'github')
  assert.equal(state.latest, null)
  assert.equal(state.status, 'idle')
  assert.equal(autoUpdater.clientPromise, null, '切回 GitHub 应清掉 generic provider 缓存')
})

await check('quitAndInstall：只在主进程调用时触发一次', async () => {
  const { updater, autoUpdater } = await makeUpdater()
  assert.equal(updater.quitAndInstall(), true)
  assert.equal(autoUpdater.quitCalls.length, 1)
  assert.deepEqual(autoUpdater.quitCalls[0], [true, true])
  updater.dispose()
})

summary()
