#!/usr/bin/env node
/**
 * 客户端版本检查的离线回归（不联网、不写工作区）。
 *
 * 覆盖：
 *   A. shared/version.js：归一化、主版本号比较、脏数据不误判；
 *   B. server/update-check.js：GitHub Releases 解析、忽略 draft/prerelease、只认更高版本、
 *      结果缓存（cacheFile 与 dir）与重载、TTL 判定、失败保留上次结果、关闭开关不发请求。
 *
 * 运行：node test/update-check.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compareVersions, isNewerVersion, normalizeVersion } from '../shared/version.js'
import {
  GITHUB_RELEASE_API,
  UPDATE_CHECK_TTL_MS,
  UPDATE_RECORD_VERSION,
  createUpdateChecker,
  releaseUrlOf,
} from '../server/update-check.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()

const dir = await mkdtemp(join(tmpdir(), 'aigc-update-test-'))

/** 构造一个可以记录调用地址的假 fetch；按调用顺序返回给定结果。 */
function fakeFetch(handler) {
  const calls = []
  const fetchText = async (url, options) => {
    calls.push({ url, options })
    return handler(url, calls.length)
  }
  return { calls, fetchText }
}

function okRelease(payload) {
  return { ok: true, status: 200, text: JSON.stringify(payload) }
}

try {
  // ── A. 版本号工具 ────────────────────────────────────────────────
  console.log('\n── 版本号工具')

  await check('归一化：合法版本原样保留，非法值返回 null', () => {
    assert.equal(normalizeVersion('0.12.0'), '0.12.0')
    assert.equal(normalizeVersion(' 0.12.0 '), '0.12.0')
    assert.equal(normalizeVersion('1'), '1')
    assert.equal(normalizeVersion('0.12.0-beta.1'), '0.12.0-beta.1')
    assert.equal(normalizeVersion('v0.12.0'), null)
    assert.equal(normalizeVersion(''), null)
    assert.equal(normalizeVersion(null), null)
    assert.equal(normalizeVersion(120), null)
    assert.equal(normalizeVersion('1'.repeat(33)), null)
  })

  await check('比较：按主版本号三段比较，任一侧不可解析返回 null', () => {
    assert.equal(compareVersions('0.12.0', '0.11.9'), 1)
    assert.equal(compareVersions('0.11.9', '0.12.0'), -1)
    assert.equal(compareVersions('0.11.0', '0.11.0'), 0)
    assert.equal(compareVersions('0.11', '0.11.0'), 0)
    assert.equal(compareVersions('bad', '0.11.0'), null)
    assert.equal(compareVersions(undefined, '0.11.0'), null)
  })

  await check('isNewerVersion：只认更高版本，预发布后缀不参与排序', () => {
    assert.equal(isNewerVersion('0.12.0', '0.11.0'), true)
    assert.equal(isNewerVersion('0.11.0', '0.11.0'), false)
    assert.equal(isNewerVersion('0.10.9', '0.11.0'), false)
    assert.equal(isNewerVersion('0.12.0-beta', '0.11.0'), true)
    assert.equal(isNewerVersion('0.11.0', 'bad'), false)
  })

  await check('Release 链接只接受可解析版本', () => {
    assert.equal(
      releaseUrlOf('0.12.0'),
      'https://github.com/nanxfu/aigc-studio/releases/tag/v0.12.0',
    )
    assert.equal(releaseUrlOf('bad'), null)
  })

  // ── B. 检查器 ────────────────────────────────────────────────────
  console.log('\n── 检查器')

  await check('GitHub Releases 成功：识别 v 前缀 tag_name 与 release 链接', async () => {
    const ok = fakeFetch(() => okRelease({
      tag_name: 'v0.15.0',
      html_url: 'https://github.com/nanxfu/aigc-studio/releases/tag/v0.15.0',
      draft: false,
      prerelease: false,
    }))
    const checker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: ok.fetchText })
    const snapshot = await checker.check()
    assert.equal(snapshot.current, '0.14.0')
    assert.equal(snapshot.latest, '0.15.0')
    assert.equal(snapshot.hasUpdate, true)
    assert.equal(snapshot.releaseUrl, 'https://github.com/nanxfu/aigc-studio/releases/tag/v0.15.0')
    assert.equal(snapshot.stale, false)
    assert.equal(ok.calls.length, 1)
    assert.equal(ok.calls[0].url, GITHUB_RELEASE_API)
    assert.equal(ok.calls[0].options.headers.accept, 'application/vnd.github+json')
  })

  await check('非本仓库 html_url 自动回退到可信 releaseUrlOf', async () => {
    const ok = fakeFetch(() => okRelease({
      tag_name: 'v0.15.0',
      html_url: 'https://evil.example/phish',
    }))
    const checker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: ok.fetchText })
    const snapshot = await checker.check()
    assert.equal(snapshot.hasUpdate, true)
    assert.equal(snapshot.releaseUrl, 'https://github.com/nanxfu/aigc-studio/releases/tag/v0.15.0')
  })

  await check('网络或 HTTP 失败：不误报更新，错误只留给诊断', async () => {
    const offline = fakeFetch(() => {
      throw new Error('fetch failed')
    })
    const checker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: offline.fetchText })
    const snapshot = await checker.check()
    assert.equal(snapshot.hasUpdate, false)
    assert.equal(snapshot.latest, null)
    assert.equal(snapshot.releaseUrl, null)
    assert.equal(snapshot.error, 'network')
    assert.equal(offline.calls.length, 1)
  })

  await check('同版本 / 旧版本：hasUpdate=false', async () => {
    const same = fakeFetch(() => okRelease({ tag_name: 'v0.14.0' }))
    const sameChecker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: same.fetchText })
    const sameSnapshot = await sameChecker.check()
    assert.equal(sameSnapshot.hasUpdate, false)
    assert.equal(sameSnapshot.latest, '0.14.0')

    const older = fakeFetch(() => okRelease({ tag_name: 'v0.13.0' }))
    const olderChecker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: older.fetchText })
    const olderSnapshot = await olderChecker.check()
    assert.equal(olderSnapshot.hasUpdate, false)
    assert.equal(olderSnapshot.releaseUrl, null)
  })

  await check('draft / prerelease / 非法 JSON 不写进结果', async () => {
    const draft = fakeFetch(() => okRelease({ tag_name: 'v0.99.0', draft: true }))
    const draftChecker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: draft.fetchText })
    assert.equal((await draftChecker.check()).latest, null)

    const pre = fakeFetch(() => okRelease({ tag_name: 'v0.99.0', prerelease: true }))
    const preChecker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: pre.fetchText })
    assert.equal((await preChecker.check()).latest, null)

    const dirty = fakeFetch(() => ({ ok: true, status: 200, text: 'not json' }))
    const dirtyChecker = createUpdateChecker({ dir, currentVersion: '0.14.0', fetchText: dirty.fetchText })
    const snapshot = await dirtyChecker.check()
    assert.equal(snapshot.hasUpdate, false)
    assert.equal(snapshot.error, 'invalid_manifest')
  })

  await check('成功检查写入缓存（支持 cacheFile 与 dir）：新实例 load() 不联网也能恢复结果', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'aigc-update-cache-'))
    const cacheFile = join(fresh, 'global-update-check.json')
    const online = fakeFetch(() => okRelease({ tag_name: 'v0.16.0' }))
    const writer = createUpdateChecker({ cacheFile, currentVersion: '0.14.0', fetchText: online.fetchText })
    await writer.check()
    const raw = JSON.parse(await readFile(cacheFile, 'utf8'))
    assert.equal(raw.version, UPDATE_RECORD_VERSION)
    assert.equal(raw.latest, '0.16.0')

    const offline = fakeFetch(() => {
      throw new Error('should not be called')
    })
    const reader = createUpdateChecker({ cacheFile, currentVersion: '0.14.0', fetchText: offline.fetchText })
    const snapshot = await reader.load()
    assert.equal(snapshot.latest, '0.16.0')
    assert.equal(snapshot.hasUpdate, true)
    assert.equal(snapshot.stale, false)
    assert.equal(offline.calls.length, 0)
    await rm(fresh, { recursive: true, force: true })
  })

  await check('TTL 过期：stale=true；再次检查后回来', async () => {
    const clock = { time: 1_700_000_000_000 }
    const online = fakeFetch(() => okRelease({ tag_name: 'v0.15.0' }))
    const checker = createUpdateChecker({
      dir,
      currentVersion: '0.14.0',
      fetchText: online.fetchText,
      now: () => clock.time,
    })
    await checker.check()
    assert.equal(checker.snapshot().stale, false)
    clock.time += UPDATE_CHECK_TTL_MS - 1
    assert.equal(checker.snapshot().stale, false)
    clock.time += 2
    assert.equal(checker.snapshot().stale, true)
  })

  await check('成功之后再失败：保留上次成功结果，error 只做诊断', async () => {
    const dirKeep = await mkdtemp(join(tmpdir(), 'aigc-update-keep-'))
    let mode = 'ok'
    const flaky = fakeFetch(() => {
      if (mode === 'ok') return okRelease({ tag_name: 'v0.15.5' })
      throw new Error('down')
    })
    const checker = createUpdateChecker({ dir: dirKeep, currentVersion: '0.14.0', fetchText: flaky.fetchText })
    await checker.check()
    mode = 'down'
    const snapshot = await checker.check()
    assert.equal(snapshot.latest, '0.15.5')
    assert.equal(snapshot.hasUpdate, true)
    assert.equal(snapshot.error, 'network')
    await rm(dirKeep, { recursive: true, force: true })
  })

  await check('enabled=false：不发起请求、不写缓存', async () => {
    const disabledDir = await mkdtemp(join(tmpdir(), 'aigc-update-off-'))
    const fetch = fakeFetch(() => okRelease({ tag_name: 'v9.9.9' }))
    const checker = createUpdateChecker({
      dir: disabledDir,
      currentVersion: '0.14.0',
      enabled: false,
      fetchText: fetch.fetchText,
    })
    const snapshot = await checker.check()
    assert.equal(snapshot.hasUpdate, false)
    assert.equal(snapshot.latest, null)
    assert.equal(fetch.calls.length, 0)
    const cacheExists = await readFile(join(disabledDir, '.aigc-studio', 'update-check.json'), 'utf8').then(
      () => true,
      () => false,
    )
    assert.equal(cacheExists, false)
    await rm(disabledDir, { recursive: true, force: true })
  })
} finally {
  await rm(dir, { recursive: true, force: true })
}

summary()
