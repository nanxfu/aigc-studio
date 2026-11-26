/**
 * 真实浏览器预览宿主（Vite + React 19 + 原生 CSS）。
 *
 * 仅由 `tools/preview.mjs` 启动的 Vite 开发服务器加载，不进入生产产物 `dist/web`。
 * 通过拦截 `/api/*` 的 fetch 请求注入离线场景状态，用真实 React 19 与真实浏览器渲染工作台。
 */

import React from 'react'
import { createRoot } from 'react-dom/client'

import '../../web/styles/tokens.css'
import '../../web/styles/base.css'
import '../../web/styles/shell.css'
import '../../web/styles/pipeline.css'
import '../../web/styles/model-picker.css'
import '../../web/styles/guidance.css'
import '../../web/styles/drawers.css'
import '../../web/styles/panel.css'
import '../../web/styles/stage.css'
import '../../web/styles/filmstrip.css'
import '../../web/styles/gallery.css'
import '../../web/styles/chat.css'
import '../../web/styles/import.css'
import '../../web/styles/workshop.css'
import '../../web/styles/onboarding.css'
import '../../web/styles/responsive.css'

import { fallbackTranslate, setLanguage } from '../../web/i18n.js'
import { ChatPanel } from '../../web/studio/ChatPanel.jsx'
import { Filmstrip } from '../../web/studio/Filmstrip.jsx'
import { Gallery } from '../../web/studio/Gallery.jsx'
import { Rail } from '../../web/studio/Rail.jsx'
import { SettingsDrawer } from '../../web/studio/SettingsDrawer.jsx'
import { Stage } from '../../web/studio/Stage.jsx'
import { Studio } from '../../web/studio/Studio.jsx'
import { TopBar } from '../../web/studio/TopBar.jsx'

const noop = () => {}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function installApiMock(scenario, library) {
  let appSettings = {
    ui: { lang: scenario.lang || 'zh', theme: scenario.dark ? 'dark' : 'light' },
    llm: { provider: 'openai', configured: false },
    ...(scenario.appSettings || {}),
  }
  let computeSettings = { provider: 'kaggle', accelerator: 'NvidiaTeslaT4', kaggleTransport: 'direct', idleTimeoutSec: 1800, ...(scenario.settings || {}) }
  let localGpuSetup = scenario.localGpuSetup
  let localModels = scenario.localModels
  const logins = { kaggle: { state: 'idle', mode: 'browser' }, colab: { state: 'idle', mode: 'browser' } }
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input?.url || ''
    const url = new URL(rawUrl, window.location.origin)
    if (url.pathname === '/api/state') {
      return jsonResponse(scenario.state)
    }
    if (url.pathname === '/api/history') {
      return jsonResponse({ items: scenario.history, hasMore: false, total: scenario.history.length })
    }
    if (url.pathname === '/api/library') {
      return jsonResponse(library)
    }
    if (url.pathname === '/api/app-settings') {
      if (init?.method === 'POST') {
        const patch = JSON.parse(init.body || '{}')
        const { apiKey, ...llmPatch } = patch.llm || {}
        appSettings = {
          ...appSettings,
          ...(patch.ui ? { ui: { ...appSettings.ui, ...patch.ui } } : {}),
          ...(patch.onboarding ? { onboarding: patch.onboarding } : {}),
          ...(patch.llm ? { llm: { ...appSettings.llm, ...llmPatch, hasApiKey: Boolean(apiKey || appSettings.llm.hasApiKey), configured: true } } : {}),
        }
      }
      return jsonResponse({ ok: true, settings: appSettings })
    }
    if (url.pathname === '/api/llm/models') {
      return jsonResponse({ ok: true, source: 'catalog', models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }], warning: null })
    }
    if (url.pathname === '/api/ui-state') {
      return jsonResponse({})
    }
    // 运行设置（云端算力页）：场景自带脱敏视图，未提供时回空对象让页面停在加载态。
    if (url.pathname === '/api/settings') {
      if (init?.method === 'POST') computeSettings = { ...computeSettings, ...JSON.parse(init.body || '{}') }
      return jsonResponse({ ok: true, settings: computeSettings })
    }
    if (url.pathname === '/api/local-gpu/config' && scenario.localGpuView) {
      return jsonResponse({ ok: true, config: scenario.localGpuView })
    }
    if (url.pathname === '/api/local-gpu/setup' && localGpuSetup) {
      if (init?.method === 'POST') {
        const { action } = JSON.parse(init.body || '{}')
        localGpuSetup = { ...localGpuSetup, phase: action === 'cancel' ? 'cancelled' : 'downloading', downloadedBytes: 15 * 1024 ** 2 }
      }
      return jsonResponse({ ok: true, setup: localGpuSetup })
    }
    if (url.pathname === '/api/local-gpu/probe' && scenario.localGpuHardware) {
      return jsonResponse({ ok: true, probe: { ok: true, gpu: { name: scenario.localGpuHardware.evaluation.profile.shortName }, errors: [] } })
    }
    if (url.pathname === '/api/local-models/hardware' && scenario.localGpuHardware) {
      return jsonResponse({ ok: true, hardware: scenario.localGpuHardware })
    }
    if (url.pathname === '/api/local-models' && localModels) {
      return jsonResponse({ ok: true, ...localModels })
    }
    if (url.pathname === '/api/local-models/dir' && localModels) {
      const { dir } = JSON.parse(init.body || '{}')
      localModels = { ...localModels, customDir: dir, dir: dir || localModels.defaultDir }
      return jsonResponse({ ok: true, ...localModels })
    }
    if (url.pathname === '/api/kaggle/login' || url.pathname === '/api/colab/login') {
      const provider = url.pathname.includes('colab') ? 'colab' : 'kaggle'
      if (init?.method === 'POST') {
        const { action } = JSON.parse(init.body || '{}')
        logins[provider] = { state: action === 'cancel' ? 'cancelled' : 'done', mode: 'browser', username: 'preview-user', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
      }
      return jsonResponse({ ok: true, login: logins[provider], ...(provider === 'colab' ? { auth: { authorized: logins[provider].state === 'done' } } : {}) })
    }
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ ok: true })
    }
    return realFetch(input, init)
  }
}

function chatFormStub() {
  return {
    form: { prompt: '', negative: '', presetId: 'sdxl-lightning', width: 1024, height: 1024, steps: 4, cfg: 0, seed: '', count: 1 },
    patchForm: noop,
    negativeActive: false,
    applyIntent: () => true,
  }
}

function PreviewScene({ name, scenario, library, now, heroPrompt, isShot = false }) {
  const lang = scenario.lang === 'en' ? 'en' : 'zh'
  const t = React.useMemo(() => fallbackTranslate(lang), [lang])

  if (scenario.kind === 'studio') {
    return <Studio t={t} defaultDemoSettled={isShot} {...(scenario.props ?? {})} />
  }

  if (scenario.kind === 'gallery') {
    const gallery = scenario.history.flatMap((item) => item.images.map((image) => ({ image, item })))
    return (
      <div className="ofs-root">
        <div className="ofs-app">
          <div className="ofs-body is-gallery">
            <div className="ofs-main">
              <Gallery
                t={t}
                gallery={gallery}
                now={now}
                presets={scenario.state.presets}
                favorites={library.favorites}
                hasMore={false}
                loadingMore={false}
                onLoadMore={noop}
                onDelete={noop}
                onExport={noop}
                onOpenStudio={noop}
                onRedraw={noop}
                onToggleFavorite={noop}
                onZoom={noop}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (scenario.kind === 'chat') {
    return (
      <div className="ofs-root">
        <div className="ofs-app">
          <div className="ofs-body">
            <ChatPanel
              t={t}
              ui={{ panelMode: 'chat', setPanelMode: noop, showToast: noop }}
              form={chatFormStub()}
              chat={{
                messages: scenario.messages,
                interpreting: false,
                interpret: noop,
                generateIntent: noop,
                resolveClarify: noop,
                newChat: noop,
              }}
              library={{ openMessage: noop }}
              actions={{ sending: false }}
            />
            <div className="ofs-main" />
          </div>
        </div>
      </div>
    )
  }

  if (scenario.kind === 'chat-composed') {
    const selected = { image: scenario.selectedImage, item: scenario.selectedItem }
    const batches = scenario.history.map((item) => ({
      key: item.jobId,
      presetId: item.presetId,
      prompt: item.prompt,
      entries: item.images.map((image) => ({ image, item })),
    }))
    return (
      <div className="ofs-root">
        <div className="ofs-app">
          <TopBar
            t={t}
            isEn={false}
            ui={{ view: 'studio', setView: noop, openLogs: noop, openSettings: noop }}
            compute={{
              sessionState: 'ready',
              session: scenario.state.session,
              quota: scenario.state.probe?.quota,
              presets: scenario.state.presets,
              busy: '',
              probing: false,
              probe: scenario.state.probe,
              probeReport: null,
              startSession: noop,
              stopSession: noop,
              runProbe: noop,
              openFolder: noop,
            }}
            form={{
              form: { presetId: scenario.selectedItem.presetId, width: scenario.selectedImage.width, height: scenario.selectedImage.height, steps: 4, cfg: 0 },
              patchForm: noop,
            }}
            library={{ loadHistory: noop }}
          />
          <div className="ofs-body">
            <ChatPanel
              t={t}
              ui={{ panelMode: 'chat', setPanelMode: noop, showToast: noop }}
              form={chatFormStub()}
              chat={{
                messages: scenario.messages,
                interpreting: false,
                interpret: noop,
                generateIntent: noop,
                resolveClarify: noop,
                newChat: noop,
              }}
              library={{ openMessage: noop }}
              actions={{ sending: false }}
            />
            <div className="ofs-main">
              <Stage
                t={t}
                ui={{ zoom: false, setZoom: noop, copyPath: noop }}
                compute={{ activeJob: null, sessionState: 'ready', presets: scenario.state.presets, status: { stopped: false } }}
                form={{
                  form: {
                    presetId: scenario.selectedItem.presetId,
                    width: scenario.selectedImage.width,
                    height: scenario.selectedImage.height,
                    steps: 4,
                    cfg: 1.5,
                    seed: '',
                    count: 1,
                  },
                  useInspiration: noop,
                }}
                library={{ selected, isFavorite: () => true, toggleFavorite: noop }}
                actions={{ iterate: noop, reroll: noop }}
              />
            </div>
          </div>
          <Filmstrip
            t={t}
            ui={{ setView: noop }}
            compute={{ pendingJobs: [], sessionState: 'ready', startSession: noop, status: { stopped: false } }}
            library={{ batches, selected, selectImage: noop }}
            now={now}
          />
        </div>
      </div>
    )
  }

  if (scenario.kind === 'refine') {
    const groups = [
      { dimension: 'lighting', options: [{ id: 'a', text: '柔和漫射光', applied: true }, { id: 'b', text: '侧逆光轮廓' }] },
      { dimension: 'material', options: [{ id: 'c', text: '湿润粗糙质感' }, { id: 'd', text: '金属拉丝高光' }] },
      { dimension: 'composition', options: [{ id: 'e', text: '对称中心构图' }, { id: 'f', text: '浅景深电影画幅' }] },
      { dimension: 'atmosphere', options: [{ id: 'g', text: '静谧雾气' }, { id: 'h', text: '漂浮尘埃粒子' }] },
    ]
    return (
      <div className="ofs-root">
        <div className="ofs-app">
          <div className="ofs-body">
            <Rail
              t={t}
              ui={{
                advancedOpen: false,
                setAdvancedOpen: noop,
                negativeOpen: false,
                setNegativeOpen: noop,
                panelMode: 'form',
                setPanelMode: noop,
              }}
              form={{
                form: {
                  prompt: '雨夜的未来城市街景，湿润地面倒映霓虹招牌，柔和漫射光',
                  negative: '',
                  presetId: 'sdxl-lightning',
                  width: 1024,
                  height: 1024,
                  steps: 4,
                  cfg: 1.5,
                  seed: '',
                  count: 1,
                },
                patchForm: noop,
                ratioId: '1:1',
                applyRatio: noop,
                applyCustomSize: noop,
                negativeActive: true,
                negativeHint: 'blurry, low quality, deformed, extra limbs',
                applyCfg: noop,
                resetSeed: noop,
                refineGroups: groups,
                refineSource: 'model',
                enhancing: false,
                enhance: noop,
                translating: false,
                translate: noop,
                toggleRefine: noop,
                useInspiration: noop,
                englishPromptHint: false,
              }}
              actions={{ sending: false, generate: noop }}
            />
            <div className="ofs-main" />
          </div>
        </div>
      </div>
    )
  }

  if (scenario.kind === 'rail') {
    const refs = scenario.refs
      ? [
          { path: 'outputs/a.png', url: scenario.history[0]?.images[0]?.url, name: 'a.png', width: 1024, height: 1024 },
          { path: 'outputs/b.png', url: scenario.history[1]?.images[0]?.url, name: 'b.png', width: 1024, height: 1024 },
        ]
      : []
    return (
      <div className="ofs-root">
        <div className="ofs-app">
          <div className="ofs-body">
            <Rail
              t={t}
              ui={{
                advancedOpen: true,
                setAdvancedOpen: noop,
                negativeOpen: true,
                setNegativeOpen: noop,
                panelMode: 'form',
                setPanelMode: noop,
              }}
              form={{
                form: {
                  prompt: heroPrompt,
                  negative: 'blurry, low quality',
                  presetId: 'sdxl-lightning',
                  width: 832,
                  height: 1216,
                  steps: 6,
                  cfg: 2.5,
                  seed: '884512',
                  count: 2,
                  references: refs,
                },
                patchForm: noop,
                ratioId: '9:16',
                applyRatio: noop,
                applyCustomSize: noop,
                negativeActive: true,
                negativeHint: 'blurry, low quality, deformed, extra limbs, watermark',
                applyCfg: noop,
                resetSeed: noop,
                refineGroups: [],
                refineSource: 'model',
                enhancing: false,
                enhance: noop,
                translating: false,
                translate: noop,
                toggleRefine: noop,
                englishPromptHint: false,
                referenceSupported: true,
                referenceSwitchLabel: '',
                referenceMax: 2,
              }}
              library={{ gallery: scenario.history.flatMap((item) => item.images.map((image) => ({ image, item }))) }}
              actions={{ sending: false, generate: noop, removeReference: noop, uploadReferenceFiles: noop }}
            />
            <div className="ofs-main" />
          </div>
        </div>
      </div>
    )
  }

  if (scenario.kind === 'settings') {
    return (
      <div className="ofs-root">
        <div className="ofs-app">
          <div className="ofs-body">
            <div className="ofs-main" />
          </div>
          <SettingsDrawer
            t={t}
            ui={{}}
            defaultTab={scenario.tab || 'compute'}
            defaultAdvancedOpen={Boolean(scenario.advanced)}
            colabAuth={scenario.colabAuth || null}
            colabLogin={scenario.colabLogin || null}
            copyText={noop}
            onClose={noop}
          />
        </div>
      </div>
    )
  }

  if (scenario.kind === 'compute-popover') {
    return (
      <div className="ofs-root">
        <div className="ofs-app" style={{ overflow: 'visible' }}>
          <div className="ofs-topbar-slot">
            <TopBar
              t={t}
              ui={{ view: 'studio', setView: noop, openLogs: noop, openSettings: noop }}
              compute={{
                sessionState: 'ready',
                busy: '',
                probing: false,
                // 场景可覆盖来源 / 授权 / Worker 等字段，用于逐个分支对版。
                ...(scenario.compute || {}),
                session: scenario.state.session,
                quota: scenario.state.probe?.quota,
                presets: scenario.state.presets,
                probe: scenario.state.probe,
                probeReport: null,
                startSession: noop,
                stopSession: noop,
                runProbe: noop,
                openFolder: noop,
              }}
              form={{
                form: { presetId: 'sdxl-lightning', width: 1024, height: 1024, steps: 4, cfg: 0 },
                patchForm: noop,
              }}
              library={{ loadHistory: noop }}
              defaultOpen={true}
            />
          </div>
        </div>
      </div>
    )
  }

  return <div style={{ padding: 24 }}>未知预览场景：{name}</div>
}

function ScenarioSwitcher({ current, names, dark }) {
  const switchTo = (nextName, nextDark = null) => {
    const url = new URL(window.location.href)
    url.searchParams.set('scenario', nextName)
    if (nextDark === null) url.searchParams.delete('theme')
    else url.searchParams.set('theme', nextDark ? 'dark' : 'light')
    window.location.href = url.toString()
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 9999,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '6px 10px',
        borderRadius: 10,
        background: 'rgba(20, 20, 22, 0.86)',
        color: '#f4f4f6',
        fontSize: 12,
        backdropFilter: 'blur(8px)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
      }}
    >
      <span style={{ opacity: 0.72 }}>Preview</span>
      <select
        value={current}
        onChange={(e) => switchTo(e.target.value)}
        style={{
          background: '#2b2b30',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 6,
          padding: '3px 6px',
          fontSize: 12,
        }}
      >
        {names.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => switchTo(current, !dark)}
        style={{
          background: '#2b2b30',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 6,
          padding: '3px 8px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {dark ? '深色' : '浅色'}
      </button>
    </div>
  )
}

async function waitForVisualSettle() {
  if (document.fonts && document.fonts.ready) {
    await Promise.race([
      document.fonts.ready.catch(() => {}),
      new Promise((r) => setTimeout(r, 1000)),
    ])
  }
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise((r) => setTimeout(r, 250)),
  ])
  const imgs = Array.from(document.querySelectorAll('img'))
  await Promise.all(
    imgs.map((img) => {
      if (img.complete) return Promise.resolve()
      return new Promise((resolveImg) => {
        const done = () => resolveImg()
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
        setTimeout(done, 4000)
      })
    }),
  )
  await new Promise((r) => setTimeout(r, 80))
}

async function boot() {
  const params = new URLSearchParams(window.location.search)
  const isShot = params.get('shot') === '1'
  const isClean = params.get('clean') === '1'
  const requested = params.get('scenario') || 'studio-ready'

  const res = await fetch('/__preview/scenarios.json', { cache: 'no-store' })
  const payload = await res.json()
  const names = Object.keys(payload.scenarios)
  const name = payload.scenarios[requested] ? requested : names[0]
  const scenario = payload.scenarios[name]

  const themeOverride = params.get('theme')
  const dark = themeOverride ? themeOverride === 'dark' : Boolean(scenario.dark)

  Date.now = () => payload.now
  try {
    window.sessionStorage.clear()
  } catch {}
  setLanguage(scenario.lang === 'en' ? 'en' : 'zh')
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'

  if (isShot) {
    // 截图态禁用过渡动画与收拢抽屉延迟，确保落帧稳定。
    const settle = document.createElement('style')
    settle.textContent = '*,*::before,*::after{animation:none !important;transition:none !important;}.ofs-drawer{grid-template-rows:1fr !important;}'
    document.head.appendChild(settle)
  }

  installApiMock({ ...scenario, dark }, payload.library)

  const root = createRoot(document.getElementById('root'))
  root.render(
    <>
      <PreviewScene
        name={name}
        scenario={scenario}
        library={payload.library}
        now={payload.now}
        heroPrompt={payload.heroPrompt}
        isShot={isShot}
      />
      {!isShot && !isClean ? <ScenarioSwitcher current={name} names={names} dark={dark} /> : null}
    </>,
  )

  await waitForVisualSettle()
  // Onboarding screenshots show a settled example, not the brief empty typing state.
  if (isShot && scenario.props?.defaultOnboardingOpen) {
    const demo = () => document.querySelector('.ofs-onboarding-demo')
    if (demo()) {
      for (let attempt = 0; attempt < 220 && demo()?.dataset.playing === 'true'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (params.get('demo-confirm') === '1' || scenario.demoConfirm) {
        document.querySelector('.ofs-onboarding-demo-proposal button')?.click()
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        for (let attempt = 0; attempt < 220 && demo()?.dataset.playing === 'true'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
  }
  // 动效采样只记录交互反馈，停掉场景里常驻的状态点 / 空画布循环。
  // 不影响本次交互后新建的动画，也保留正常预览的全部动态效果。
  if (params.get('motion') === '1') {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations === Infinity) animation.cancel()
    }
  }
  window.__PREVIEW_READY__ = true
}

boot().catch((error) => {
  console.error(error)
  window.__PREVIEW_ERROR__ = String(error?.stack ?? error)
})
