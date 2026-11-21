#!/usr/bin/env node
/**
 * 更新器纯逻辑回归（不启动 Electron、不联网）。
 *
 * 覆盖（docs/M2_8_RELEASE_AND_UPDATER_SPEC.md §3.1/§3.2/§3.4/§3.7）：
 *  - 七种运行形态判定与 canAutoUpdate；
 *  - 镜像 URL 校验（https / 回环 http / userinfo / query / fragment / 长度）；
 *  - 错误分类（网络、HTTP、校验、磁盘、权限）；
 *  - UpdateState 归一化不变量（downloaded 只在可更新形态、progress 只在下载中、error 与 status 配对）；
 *  - 安装护栏 canInstallNow（未下载 / 状态未知 / 过期 / 会话活跃 / 队列活跃）。
 *
 * 运行：node test/update-policy.mjs
 */

import assert from 'node:assert/strict'

import { resolveInstallForm, isMirrorUrlAllowed } from '../electron/updater/policy.mjs'
import {
  canInstallNow,
  classifyUpdateError,
  normalizeMirrorUrl,
  normalizeUpdateState,
} from '../shared/update-state.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

const WIN_EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\AIGC Studio\\AIGC Studio.exe'
const WIN_RESOURCES = 'C:\\Users\\me\\AppData\\Local\\Programs\\AIGC Studio\\resources'

function formOf(overrides = {}) {
  return resolveInstallForm({
    isPackaged: true,
    platform: 'win32',
    env: {},
    execPath: WIN_EXE,
    resourcesPath: WIN_RESOURCES,
    hasUpdateConfig: true,
    ...overrides,
  })
}

await check('形态判定：便携版优先于解压版，只读', () => {
  const portable = formOf({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\aigc-studio-portable.exe' } })
  assert.equal(portable.form, 'portable')
  assert.equal(portable.canAutoUpdate, false)
  assert.equal(portable.mode, 'readonly')
  assert.equal(portable.reason, 'portable')

  const portableDir = formOf({ env: { PORTABLE_EXECUTABLE_DIR: 'D:\\portable' } })
  assert.equal(portableDir.form, 'portable')
})

await check('形态判定：Linux AppImage 只读', () => {
  const appimage = formOf({ platform: 'linux', env: { APPIMAGE: '/home/me/AIGC_Studio.AppImage' }, resourcesPath: '/tmp/resources' })
  assert.equal(appimage.form, 'linux-appimage')
  assert.equal(appimage.canAutoUpdate, false)
  assert.equal(appimage.reason, 'appimage')
})

await check('形态判定：开发态默认不初始化更新器；显式开关 + 合法 feed 才允许联调', () => {
  const dev = formOf({ isPackaged: false, hasUpdateConfig: false })
  assert.equal(dev.form, 'dev')
  assert.equal(dev.canAutoUpdate, false)
  assert.equal(dev.reason, 'dev')

  const missingFeed = formOf({
    isPackaged: false,
    hasUpdateConfig: false,
    env: { AIGC_STUDIO_UPDATE_DEV: '1' },
  })
  assert.equal(missingFeed.form, 'dev')
  assert.equal(missingFeed.canAutoUpdate, false)
  assert.equal(missingFeed.reason, 'dev_feed_missing')

  const forced = formOf({
    isPackaged: false,
    hasUpdateConfig: false,
    env: { AIGC_STUDIO_UPDATE_DEV: '1', AIGC_STUDIO_UPDATE_FEED: 'http://127.0.0.1:8787/feed/' },
  })
  assert.equal(forced.form, 'dev')
  assert.equal(forced.canAutoUpdate, true)
  assert.equal(forced.mode, 'electron-updater')
  assert.equal(forced.forcedDev, true)
  assert.equal(forced.feedUrl, 'http://127.0.0.1:8787/feed')

  // 开发态也不允许非回环的 http。
  const remoteHttp = formOf({
    isPackaged: false,
    hasUpdateConfig: false,
    env: { AIGC_STUDIO_UPDATE_DEV: '1', AIGC_STUDIO_UPDATE_FEED: 'http://mirror.example.com' },
  })
  assert.equal(remoteHttp.canAutoUpdate, false)
})

await check('形态判定：解压版 / macOS 未签名 / 缺少 app-update.yml 都只读', () => {
  const unpacked = formOf({
    execPath: 'D:\\build\\win-unpacked\\AIGC Studio.exe',
    resourcesPath: 'D:\\build\\win-unpacked\\resources',
  })
  assert.equal(unpacked.form, 'unpacked')
  assert.equal(unpacked.canAutoUpdate, false)

  const mac = formOf({ platform: 'darwin', execPath: '/Applications/AIGC Studio.app/Contents/MacOS/AIGC Studio', resourcesPath: '/Applications/AIGC Studio.app/Contents/Resources' })
  assert.equal(mac.form, 'mac-unsigned')
  assert.equal(mac.canAutoUpdate, false)

  const missing = formOf({ hasUpdateConfig: false })
  assert.equal(missing.form, 'unsupported')
  assert.equal(missing.canAutoUpdate, false)
  assert.equal(missing.reason, 'missing_update_config')

  const linux = formOf({ platform: 'linux', resourcesPath: '/opt/aigc/resources' })
  assert.equal(linux.form, 'unsupported')
  assert.equal(linux.canAutoUpdate, false)
})

await check('形态判定：NSIS 安装版是唯一允许自动更新的形态', () => {
  const nsis = formOf()
  assert.equal(nsis.form, 'nsis')
  assert.equal(nsis.canAutoUpdate, true)
  assert.equal(nsis.mode, 'electron-updater')
  assert.equal(nsis.reason, null)
  assert.ok(nsis.updateConfigPath && nsis.updateConfigPath.endsWith('app-update.yml'))
})

await check('镜像 URL：https 归一、回环 http 仅开发放行、非法输入拒绝', () => {
  assert.equal(normalizeMirrorUrl('https://mirror.example.com/aigc/'), 'https://mirror.example.com/aigc')
  assert.equal(normalizeMirrorUrl('https://mirror.example.com'), 'https://mirror.example.com')
  assert.equal(normalizeMirrorUrl('  https://mirror.example.com/updates  '), 'https://mirror.example.com/updates')
  assert.equal(normalizeMirrorUrl(''), '')
  assert.equal(normalizeMirrorUrl('   '), '')
  assert.equal(normalizeMirrorUrl(null), '')

  assert.equal(normalizeMirrorUrl('http://mirror.example.com'), null)
  assert.equal(normalizeMirrorUrl('ftp://mirror.example.com'), null)
  assert.equal(normalizeMirrorUrl('https://user:pass@mirror.example.com'), null)
  assert.equal(normalizeMirrorUrl('https://mirror.example.com?x=1'), null)
  assert.equal(normalizeMirrorUrl('https://mirror.example.com#frag'), null)
  assert.equal(normalizeMirrorUrl(`https://mirror.example.com/${'a'.repeat(600)}`), null)
  assert.equal(normalizeMirrorUrl('not-a-url'), null)

  assert.equal(normalizeMirrorUrl('http://127.0.0.1:8787/feed', { allowInsecure: true }), 'http://127.0.0.1:8787/feed')
  assert.equal(normalizeMirrorUrl('http://localhost:8787', { allowInsecure: true }), 'http://localhost:8787')
  assert.equal(normalizeMirrorUrl('http://192.168.1.10', { allowInsecure: true }), null)

  assert.equal(isMirrorUrlAllowed('https://mirror.example.com', { dev: false }), 'https://mirror.example.com')
  assert.equal(isMirrorUrlAllowed('http://127.0.0.1:1', { dev: false }), null)
  assert.equal(isMirrorUrlAllowed('http://127.0.0.1:1', { dev: true }), 'http://127.0.0.1:1')
})

await check('错误分类：网络 / HTTP / 校验 / 磁盘 / 权限 / 未知', () => {
  assert.equal(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com')), 'dns')
  assert.equal(classifyUpdateError(new Error('connect ETIMEDOUT 1.2.3.4:443')), 'timeout')
  assert.equal(classifyUpdateError(new Error('fetch failed')), 'offline')
  assert.equal(classifyUpdateError({ status: 404 }), 'http_404')
  assert.equal(classifyUpdateError({ status: 403 }), 'http_403')
  assert.equal(classifyUpdateError({ status: 401 }), 'http_401')
  assert.equal(classifyUpdateError({ status: 429 }), 'http_429')
  assert.equal(classifyUpdateError({ status: 503 }), 'http_5xx')
  assert.equal(classifyUpdateError(new Error('sha512 checksum mismatch')), 'checksum')
  assert.equal(classifyUpdateError(new Error('code signature validation failed')), 'signature')
  assert.equal(classifyUpdateError(new Error('ENOSPC: no space left on device')), 'disk_full')
  assert.equal(classifyUpdateError(new Error('EACCES: permission denied')), 'permission')
  assert.equal(classifyUpdateError('invalid_manifest'), 'feed_invalid')
  assert.equal(classifyUpdateError('network'), 'offline')
  assert.equal(classifyUpdateError(new Error('odd failure')), 'unknown')
  assert.equal(classifyUpdateError(null, 'offline'), 'offline')
})

await check('状态归一：downloaded 只在可自动更新形态出现，progress 只在下载中', () => {
  const readonlyDownloaded = normalizeUpdateState({
    mode: 'readonly',
    form: 'portable',
    current: '0.14.0',
    latest: '0.15.0',
    hasUpdate: true,
    status: 'downloaded',
    progress: { percent: 42 },
    installOnQuit: true,
  })
  assert.equal(readonlyDownloaded.status, 'available')
  assert.equal(readonlyDownloaded.canAutoUpdate, false)
  assert.equal(readonlyDownloaded.progress, null)
  assert.equal(readonlyDownloaded.installOnQuit, false)
  assert.equal(readonlyDownloaded.hasUpdate, true)

  const downloading = normalizeUpdateState({
    mode: 'electron-updater',
    form: 'nsis',
    canAutoUpdate: true,
    current: '0.14.0',
    latest: '0.15.0',
    status: 'downloading',
    progress: { percent: 120, transferred: 10, total: 100, bytesPerSecond: 5 },
  })
  assert.deepEqual(downloading.progress, { percent: 100, transferred: 10, total: 100, bytesPerSecond: 5 })

  const noProgress = normalizeUpdateState({
    mode: 'electron-updater',
    form: 'nsis',
    canAutoUpdate: true,
    current: '0.14.0',
    status: 'downloading',
  })
  assert.deepEqual(noProgress.progress, { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
})

await check('状态归一：error 与 status 配对，releaseUrl 只留 https，installOnQuit 跟随下载完成', () => {
  const failed = normalizeUpdateState({
    mode: 'readonly',
    form: 'portable',
    current: '0.14.0',
    status: 'available',
    error: 'http_503',
    releaseUrl: 'http://evil.example/x',
  })
  assert.equal(failed.status, 'error')
  assert.deepEqual(failed.error, { code: 'http_5xx', message: '' })
  assert.equal(failed.releaseUrl, null)

  const downloaded = normalizeUpdateState({
    mode: 'electron-updater',
    form: 'nsis',
    canAutoUpdate: true,
    current: '0.14.0',
    latest: '0.15.0',
    status: 'downloaded',
    installOnQuit: true,
    checkedAt: '2026-11-22T00:00:00.000Z',
  })
  assert.equal(downloaded.installOnQuit, true)
  assert.equal(downloaded.checkedAt, '2026-11-22T00:00:00.000Z')

  const notDownloaded = normalizeUpdateState({
    mode: 'electron-updater',
    form: 'nsis',
    canAutoUpdate: true,
    current: '0.14.0',
    latest: '0.15.0',
    status: 'available',
    installOnQuit: true,
  })
  assert.equal(notDownloaded.installOnQuit, false)

  assert.equal(normalizeUpdateState(null), null)
  assert.equal(normalizeUpdateState('bad'), null)
})

// ── 安装护栏 ──────────────────────────────────────────────────────

const downloadedState = {
  mode: 'electron-updater',
  form: 'nsis',
  canAutoUpdate: true,
  current: '0.14.0',
  latest: '0.15.0',
  status: 'downloaded',
}

await check('安装护栏：未下载 / 只读形态直接拒绝', () => {
  assert.deepEqual(
    canInstallNow({ state: { ...downloadedState, status: 'available' }, serverState: {} }),
    { ok: false, reason: 'not_downloaded' },
  )
  assert.deepEqual(
    canInstallNow({ state: { ...downloadedState, mode: 'readonly', canAutoUpdate: false }, serverState: {} }),
    { ok: false, reason: 'unsupported_form' },
  )
})

await check('安装护栏：云端状态未知 / 过期都阻止安装', () => {
  assert.deepEqual(canInstallNow({ state: downloadedState, serverState: null }), { ok: false, reason: 'state_unknown' })
  assert.deepEqual(canInstallNow({ state: downloadedState, serverState: { ok: false } }), { ok: false, reason: 'state_unknown' })
  assert.deepEqual(
    canInstallNow({
      state: downloadedState,
      serverState: { ok: true, at: 1_000, session: { state: 'absent' } },
      now: 20_000,
      maxAgeMs: 8_000,
    }),
    { ok: false, reason: 'state_stale' },
  )
})

await check('安装护栏：活跃会话 / 队列 / 任务都阻止，空闲才放行', () => {
  const base = { ok: true, at: 1_000, queue: { running: false, pending: 0 }, jobs: [] }
  assert.deepEqual(
    canInstallNow({ state: downloadedState, serverState: { ...base, session: { state: 'ready' } }, now: 2_000 }),
    { ok: false, reason: 'session_active' },
  )
  assert.deepEqual(
    canInstallNow({ state: downloadedState, serverState: { ...base, session: { state: 'stopping' } }, now: 2_000 }),
    { ok: false, reason: 'session_active' },
  )
  assert.deepEqual(
    canInstallNow({ state: downloadedState, serverState: { ...base, session: { state: 'absent' }, queue: { running: false, pending: 2 } }, now: 2_000 }),
    { ok: false, reason: 'queue_active' },
  )
  assert.deepEqual(
    canInstallNow({ state: downloadedState, serverState: { ...base, session: { state: 'absent' }, jobs: [{ status: 'running' }] }, now: 2_000 }),
    { ok: false, reason: 'queue_active' },
  )
  assert.deepEqual(
    canInstallNow({ state: downloadedState, serverState: { ...base, session: { state: 'absent' } }, now: 2_000 }),
    { ok: true, reason: null },
  )
})

summary()
