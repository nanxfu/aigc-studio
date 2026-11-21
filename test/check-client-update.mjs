#!/usr/bin/env node
/**
 * 客户端更新状态的纯逻辑回归（不需要浏览器 / Electron）。
 *
 * 覆盖（docs/M2_8_RELEASE_AND_UPDATER_SPEC.md §3.2/§3.6/§3.7）：
 *  - `updateStateOf`：只读形态从 /api/state.update 归一，禁止被快照抬成可自动更新；
 *  - `updateActionsOf`：只读 → 打开发布页；安装版 → 下载 / 立即安装；检查中 / 下载中禁用；
 *  - `updateStatusKey` / `errorMessageKey` / `installGateMessageKey` 的词典键必须存在（中英同构）；
 *  - 进度百分比钳制、字节格式化、下载进度文案。
 *
 * 运行：node test/check-client-update.mjs
 */

import assert from 'node:assert/strict'

import { en } from '../web/dict/en.js'
import { zh } from '../web/dict/zh.js'
import {
  formatBytes,
  installGateText,
  installGateMessageKey,
  normalizeUpdateState,
  progressPercentOf,
  progressTextOf,
  updateActionsOf,
  updateErrorText,
  updateStateOf,
  updateStatusKey,
} from '../web/logic/update.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

const zhKeys = new Set(Object.keys(zh))
const enKeys = new Set(Object.keys(en))

function assertKey(key) {
  assert.ok(zhKeys.has(key), `zh 缺少 ${key}`)
  assert.ok(enKeys.has(key), `en 缺少 ${key}`)
}

await check('updateStateOf：只读快照归一，不接受 canAutoUpdate / downloaded', () => {
  const state = updateStateOf({
    current: '0.14.0',
    latest: '0.15.0',
    hasUpdate: true,
    source: 'github',
    releaseUrl: 'https://github.com/nanxfu/aigc-studio/releases/tag/v0.15.0',
    checkedAt: '2026-11-22T00:00:00.000Z',
    error: null,
  })
  assert.equal(state.mode, 'readonly')
  assert.equal(state.canAutoUpdate, false)
  assert.equal(state.status, 'available')
  assert.equal(state.hasUpdate, true)
  assert.equal(state.latest, '0.15.0')

  const forged = updateStateOf({
    mode: 'electron-updater',
    canAutoUpdate: true,
    form: 'nsis',
    current: '0.14.0',
    latest: '0.15.0',
    status: 'downloaded',
    releaseUrl: 'http://evil.example/x',
  })
  assert.equal(forged.mode, 'readonly')
  assert.equal(forged.canAutoUpdate, false)
  assert.equal(forged.status, 'available')
  assert.equal(forged.releaseUrl, null)

  assert.equal(updateStateOf(null), null)
  assert.equal(updateStateOf('bad'), null)
})

await check('updateActionsOf：只读有新版本 → 打开发布页；安装版 → 下载 / 安装', () => {
  const readonlyAvailable = normalizeUpdateState({
    mode: 'readonly',
    form: 'portable',
    current: '0.14.0',
    latest: '0.15.0',
    hasUpdate: true,
    status: 'available',
    releaseUrl: 'https://github.com/nanxfu/aigc-studio/releases/tag/v0.15.0',
  })
  const readonlyActions = updateActionsOf(readonlyAvailable)
  assert.equal(readonlyActions.canDownload, false)
  assert.equal(readonlyActions.canInstall, false)
  assert.equal(readonlyActions.canOpenRelease, true)
  assert.equal(readonlyActions.primary, 'open-release')

  const installerAvailable = normalizeUpdateState({
    mode: 'electron-updater',
    form: 'nsis',
    canAutoUpdate: true,
    current: '0.14.0',
    latest: '0.15.0',
    status: 'available',
  })
  const downloadActions = updateActionsOf(installerAvailable)
  assert.equal(downloadActions.canDownload, true)
  assert.equal(downloadActions.canInstall, false)
  assert.equal(downloadActions.primary, 'download')

  const installerDownloaded = normalizeUpdateState({
    mode: 'electron-updater',
    form: 'nsis',
    canAutoUpdate: true,
    current: '0.14.0',
    latest: '0.15.0',
    status: 'downloaded',
  })
  const installActions = updateActionsOf(installerDownloaded)
  assert.equal(installActions.canInstall, true)
  assert.equal(installActions.canInstallOnQuit, true)
  assert.equal(installActions.primary, 'install')

  // 下载中 / 检查中：检查按钮与主按钮都禁用。
  for (const status of ['checking', 'downloading']) {
    const busyState = normalizeUpdateState({
      mode: 'electron-updater',
      form: 'nsis',
      canAutoUpdate: true,
      current: '0.14.0',
      latest: '0.15.0',
      status,
    })
    const actions = updateActionsOf(busyState, { busy: true })
    assert.equal(actions.canCheck, false)
    assert.equal(actions.canDownload, false)
    assert.equal(actions.primary, 'none')
  }

  // 无状态（启动早期）：仍允许手动检查。
  assert.equal(updateActionsOf(null).primary, 'check')
})

await check('状态与错误文案键：状态 / 错误码 / 安装护栏在 zh 与 en 都存在', () => {
  for (const status of ['idle', 'checking', 'available', 'downloading', 'downloaded', 'up-to-date', 'error']) {
    assertKey(updateStatusKey({ status }))
  }
  assert.equal(updateStatusKey(null), 'studio.update.status.idle')

  // 与 shared/update-state.js 的错误码集合保持一致（这里是渲染层能展示的全部码）。
  const codes = [
    'offline', 'dns', 'timeout', 'http_401', 'http_403', 'http_404', 'http_429', 'http_5xx',
    'checksum', 'signature', 'feed_invalid', 'disk_full', 'permission', 'unsupported_form',
    'state_unknown', 'state_stale', 'session_active', 'queue_active', 'not_downloaded', 'unknown',
  ]
  for (const code of codes) assertKey(`studio.update.error.${code}`)
  for (const reason of ['session_active', 'queue_active', 'state_unknown', 'state_stale', 'not_downloaded', 'unsupported_form', 'unknown']) {
    assertKey(installGateMessageKey(reason))
  }
  for (const form of ['portable', 'unpacked', 'dev', 'macUnsigned', 'linuxAppimage', 'unsupported']) {
    assertKey(`studio.update.form.${form}`)
  }
  for (const key of ['studio.update.open', 'studio.update.title', 'studio.update.action.installOnQuit', 'settings.nav.update']) {
    assertKey(key)
  }
})

await check('错误 / 护栏文案：查表命中时用词典，缺失时回退 message / unknown', () => {
  const t = (key) => (zhKeys.has(key) ? zh[key] : key)
  const state = normalizeUpdateState({
    mode: 'readonly',
    form: 'portable',
    current: '0.14.0',
    status: 'error',
    error: { code: 'http_404', message: 'server said 404' },
  })
  assert.match(updateErrorText(t, state), /更新清单不存在/)
  assert.match(installGateText(t, 'session_active'), /云端会话仍在运行/)

  const unknown = normalizeUpdateState({
    mode: 'readonly',
    form: 'portable',
    current: '0.14.0',
    status: 'error',
    error: { code: 'something_new', message: 'boom' },
  })
  assert.equal(unknown.error.code, 'unknown')
  assert.match(updateErrorText(t, unknown), /更新失败/)
})

await check('进度与字节：百分比钳制、0 值安全、下载文案', () => {
  const downloading = normalizeUpdateState({
    mode: 'electron-updater',
    form: 'nsis',
    canAutoUpdate: true,
    current: '0.14.0',
    status: 'downloading',
    progress: { percent: 33.33, transferred: 1024 * 1024 * 2, total: 1024 * 1024 * 6, bytesPerSecond: 1024 * 300 },
  })
  assert.equal(progressPercentOf(downloading), 33)
  assert.equal(progressPercentOf(null), 0)
  assert.match(progressTextOf(downloading), /2\.0 MB \/ 6\.0 MB/)
  assert.match(progressTextOf(downloading), /300 KB\/s/)
  assert.equal(progressTextOf(normalizeUpdateState({ mode: 'readonly', form: 'portable', status: 'available' })), '')

  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(1024 * 1024 * 1.5), '1.5 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024 * 2), '2.00 GB')
  assert.equal(formatBytes('x'), '0 B')
})

summary()
