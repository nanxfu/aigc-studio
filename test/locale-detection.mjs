#!/usr/bin/env node
/**
 * 多语言探测、Electron 壳层文案、OAuth 回调 HTML 与硬件基准英文分支回归测试。
 *
 * 运行：node test/locale-detection.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppConfig } from '../server/app-config.js'
import { callbackHtml, resolveCallbackLocale } from '../server/kaggle/oauth/callback-server.js'
import { evaluateDeviceCapability, matchGpuProfile } from '../shared/gpu-benchmark.js'
import { detectPreferredLang, mapLocaleToUiLang, normalizeUiLang, parseAcceptLanguage } from '../shared/locale.js'
import { shellText } from '../electron/i18n.mjs'
import { createCheckRunner } from './helpers/check.mjs'

const { check, summary } = createCheckRunner()
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const tempDirs = []

async function makeDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

try {
  await check('shared/locale.js：归一化与系统区域探测', async () => {
    assert.equal(normalizeUiLang('zh-CN'), 'zh')
    assert.equal(normalizeUiLang('zh_TW.UTF-8'), 'zh')
    assert.equal(normalizeUiLang('en-US'), 'en')
    assert.equal(normalizeUiLang('fr-FR'), null)

    assert.equal(mapLocaleToUiLang('ja-JP'), 'en')
    assert.equal(mapLocaleToUiLang('de_DE.UTF-8'), 'en')
    assert.equal(mapLocaleToUiLang('C.UTF-8'), null)
    assert.equal(mapLocaleToUiLang('POSIX'), null)

    assert.equal(parseAcceptLanguage('fr-FR,fr;q=0.9,zh-CN;q=0.8'), 'en')
    assert.equal(parseAcceptLanguage('en-US;q=0.5,zh-CN;q=0.9'), 'zh')

    assert.equal(detectPreferredLang({ locale: 'en-US', env: { LANG: 'zh_CN.UTF-8' } }), 'en')
    assert.equal(detectPreferredLang({ locale: 'zh-Hans-CN', env: { LANG: 'en_US.UTF-8' } }), 'zh')
    assert.equal(detectPreferredLang({ env: { LC_ALL: 'C.UTF-8', LANG: 'fr_FR.UTF-8' } }), 'en')
    assert.equal(detectPreferredLang({ env: { AIGC_STUDIO_LOCALE: 'ja-JP', LANG: 'zh_CN.UTF-8' } }), 'en')
  })

  await check('app-config：新安装继承 defaultLang，已有配置保留原语言', async () => {
    const freshDir = await makeDir('aigc-locale-fresh-')
    const freshEn = createAppConfig({ dataDir: freshDir, defaultLang: 'en', log: silentLog })
    await freshEn.whenReady()
    assert.equal(freshEn.publicSettingsView().ui.lang, 'en')

    const existingDir = await makeDir('aigc-locale-existing-')
    await writeFile(
      join(existingDir, 'app-config.json'),
      JSON.stringify({ schema: 1, ui: { lang: 'zh', theme: 'dark' } }),
    )
    const existing = createAppConfig({ dataDir: existingDir, defaultLang: 'en', log: silentLog })
    await existing.whenReady()
    assert.equal(existing.publicSettingsView().ui.lang, 'zh')

    const defaultCfg = createAppConfig({ dataDir: await makeDir('aigc-locale-default-'), log: silentLog })
    await defaultCfg.whenReady()
    assert.equal(defaultCfg.publicSettingsView().ui.lang, 'zh')
  })

  await check('electron/i18n.mjs：壳层双语与插值替换', async () => {
    assert.equal(shellText('zh', 'tray.show'), '显示主窗口')
    assert.equal(shellText('en', 'tray.show'), 'Show Window')
    assert.equal(shellText('en', 'tray.running', { count: 2 }), 'Running 2')
    assert.equal(shellText('en', 'dialog.activeSession.quit'), 'Quit Anyway')
  })

  await check('OAuth 回调页面：按配置或 Accept-Language 切换中英文', async () => {
    assert.equal(resolveCallbackLocale({ headers: { 'accept-language': 'en-US,en;q=0.9' } }, null), 'en')
    assert.equal(resolveCallbackLocale({ headers: { 'accept-language': 'en-US' } }, () => 'zh'), 'zh')
    assert.ok(callbackHtml(true, 'en').includes('Authorization Complete'))
    assert.ok(callbackHtml(false, 'en').includes('Authorization Failed'))
    assert.ok(callbackHtml(true, 'zh').includes('授权已完成'))
  })

  await check('gpu-benchmark：locale=en 输出英文显卡档位与状态原因', async () => {
    const enProfile = matchGpuProfile({ presetId: 'intel-arc-igpu', locale: 'en' })
    const enEval = evaluateDeviceCapability(enProfile, { locale: 'en' })
    assert.equal(enProfile.shortName, 'Intel iGPU / Ultrabook')
    assert.match(enEval.tier.badge, /Ultrabook \/ Cloud-First/)
    assert.ok(enEval.modelStatuses.every((m) => !/[\u4e00-\u9fa5]/.test(m.reason)))

    const zhProfile = matchGpuProfile({ presetId: 'intel-arc-igpu' })
    const zhEval = evaluateDeviceCapability(zhProfile)
    assert.equal(zhProfile.shortName, 'Intel 核显 / 轻薄本')
    assert.match(zhEval.tier.badge, /轻薄本/)
  })
} finally {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
}

summary()
