/**
 * 顶栏模型选择卡（ModelCardPicker）。
 *
 * 触发器只保留当前模型的三个事实：家族徽标、模型主名、实测稳态耗时；
 * 展开后是一列海报卡：56×56 海报 + 家族 + 主名 + 定位描述 + 参数规格 + 实测耗时。
 *
 * 交互按 WAI-ARIA listbox：方向键循环、Enter/Space 选中、Esc 关闭并把焦点还给触发器、
 * 点击外部关闭；两个顶栏弹层（算力 / 模型）由 TopBar 负责互斥。
 *
 * 算力来源门控（资产可选字段 `providers`）：当前 provider 跑不了的模型（如 9B 仅 Colab）
 * 置灰禁用、标「仅 Colab」角标并给原因提示；键盘导航复用现有 disabled 过滤自动跳过。
 * 缺省 providers 的模型保持既有行为（两种来源都可选）。
 */

import React from 'react'

import { benchmarkModelById, evaluatePresetLocalFit } from '../../shared/gpu-benchmark.js'
import { formatSeconds, formatText } from '../logic/format.js'
import {
  defaultModelTabIdOf,
  presetAvailableForProvider,
  presetCategoryOf,
  presetProviderRestrictionOf,
  presetProvidersOf,
  providerNameKeyOf,
} from '../logic/preset.js'
import { usePresence } from './hooks/usePresence.js'
import { Icon } from './icons.jsx'
import { ModelSamplePreview } from './ModelSamplePreview.jsx'
import { MODEL_SAMPLES, SAMPLE_DIMS } from './modelSamples.generated.js'
import posterAnima from './posters/anima-turbo-v1.1.webp'
import posterFlux1 from './posters/flux1.webp'
import posterFlux from './posters/flux2-klein-4b.webp'
import posterFlux9b from './posters/flux2-klein-9b.webp'
import posterKolors from './posters/kolors.webp'
import posterLightning from './posters/sdxl-lightning.webp'
import posterOpenai from './posters/openai.webp'
import posterQwen from './posters/qwen-image-2.1.webp'
import posterSana from './posters/sana-sprint-1.6b.webp'
import posterZImage from './posters/z-image-turbo.webp'

const MENU_ID = 'ofs-model-menu'

/** 模型海报：按模型 id 对应 src/studio/posters/*.webp，构建期内联为 data URL。 */
const POSTERS = {
  'sdxl-lightning': posterLightning,
  'sana-sprint-1.6b': posterSana,
  'z-image-turbo': posterZImage,
  'qwen-image-2.1': posterQwen,
  'flux2-klein-4b': posterFlux,
  'flux2-klein-9b': posterFlux9b,
  'anima-turbo-v1.1': posterAnima,
}

const LABELS = {
  menuTitle: 'studio.preset.menuTitle',
  measured: 'studio.preset.measured',
  default: 'studio.preset.default',
  langZhEn: 'studio.preset.langZhEn',
  langEnOnly: 'studio.preset.langEnOnly',
  imageToolOnly: 'studio.preset.imageToolOnly',
  // 算力来源门控：当前 provider 跑不了的模型置灰 + 「仅 Colab」角标与原因提示。
  providerOnly: 'studio.preset.providerOnly',
  providerBlocked: 'studio.preset.providerBlocked',
  gated: 'studio.preset.gated',
  gatedHint: 'studio.preset.gatedHint',
  footer: 'studio.preset.footer',
  steps: 'studio.preset.stepsUnit',
  dualGpu: 'studio.preset.dualGpu',
}

/** 算力来源展示名（无效 id 由 providerNameKeyOf 回退到契约默认来源）。 */
function providerText(t, provider) {
  return t(providerNameKeyOf(provider))
}

function shortOf(preset) {
  return preset.short || preset.label || preset.id
}

function descriptionOf(preset, isEn) {
  const value = preset.description
  if (!value) return ''
  if (typeof value === 'string') return value
  return value[isEn ? 'en' : 'zh'] || value.zh || value.en || ''
}

function etaOf(t, preset) {
  const seconds = Number(preset.steadySeconds)
  return Number.isFinite(seconds) ? `~${formatSeconds(t, seconds)}` : ''
}

function posterOf(preset) {
  if (!preset) return ''
  if (POSTERS[preset.id]) return POSTERS[preset.id]
  const fam = String(preset.family || '').toLowerCase()
  const model = String(preset.cloud?.model || preset.repo || preset.id || '').toLowerCase()
  if (fam.includes('kolors') || model.includes('kolors')) return posterKolors
  if (fam.includes('gpt image') || fam.includes('openai') || model.includes('gpt-image') || model.includes('dall-e')) {
    return posterOpenai
  }
  if (fam.includes('qwen') || model.includes('qwen')) return posterQwen
  if (fam.includes('flux.1') || model.includes('flux.1') || model.includes('flux/schnell') || model.includes('flux/dev')) {
    return posterFlux1
  }
  if (model.includes('klein-9b')) return posterFlux9b
  if (fam.includes('flux') || model.includes('flux')) return posterFlux
  if (fam.includes('sdxl') || model.includes('sdxl')) return posterLightning
  if (fam.includes('sana') || model.includes('sana')) return posterSana
  if (fam.includes('anima') || model.includes('anima')) return posterAnima
  if (fam.includes('z-image') || model.includes('z-image')) return posterZImage
  return ''
}

function isFastPreset(preset) {
  if (!preset) return false
  if (preset.tier === 'fast') return true
  const steps = Number(preset.steps)
  return Number.isFinite(steps) && steps > 0 && steps <= 8
}

function isPresetLocalReady(preset, localGpu) {
  if (!preset || !localGpu || !localGpu.ok) return false
  const configuredList = Array.isArray(localGpu.configuredPresets) ? localGpu.configuredPresets : []
  return configuredList.includes(preset.id) || presetAvailableForProvider(preset, 'local-gpu')
}

function isLocalDeployCandidate(preset, localGpu, hardware) {
  if (!preset || preset.cloud || preset.inpaintOnly === true) return false
  if (presetAvailableForProvider(preset, 'local-gpu')) return true
  if (isPresetLocalReady(preset, localGpu)) return true
  return Boolean((hardware?.evaluation || localGpu?.ok) && benchmarkModelById(preset.id))
}

function isPresetAllowedOnProvider(preset, provider, localGpu) {
  if (!preset) return false
  if (provider === 'local-gpu') {
    return presetAvailableForProvider(preset, 'local-gpu') || isPresetLocalReady(preset, localGpu)
  }
  return presetAvailableForProvider(preset, provider)
}

function buildFilterTabs(t, list, { localGpu = null, hardware = null } = {}) {
  if (list.length <= 1) return []
  const hasLocalDeploySplit =
    list.some((item) => Array.isArray(item?.providers) && item.providers.includes('local-gpu'))
    || Boolean(hardware?.evaluation)
    || Boolean(localGpu?.ok)
  const localCount = list.filter((item) => !item?.cloud).length
  const vendors = []
  for (const item of list) {
    const v = item?.cloud?.vendor
    if (v && !vendors.includes(v)) vendors.push(v)
  }
  if (hasLocalDeploySplit || (localCount > 0 && vendors.length > 0) || vendors.length > 1) {
    const tabs = [{ id: 'all', label: t('studio.preset.tab.all'), kind: 'all', count: list.length }]
    if (hasLocalDeploySplit) {
      const localDeployCount = list.filter((item) => isLocalDeployCandidate(item, localGpu, hardware)).length
      const cloudOpenCount = list.filter((item) => !item?.cloud && presetProvidersOf(item).some((id) => id !== 'local-gpu')).length
      if (localDeployCount > 0) {
        tabs.push({ id: 'scope:local-deploy', label: t('studio.preset.tab.localDeploy'), kind: 'local-deploy', count: localDeployCount })
      }
      if (cloudOpenCount > 0) {
        tabs.push({ id: 'scope:cloud-open', label: t('studio.preset.tab.cloudOpen'), kind: 'cloud-open', count: cloudOpenCount })
      }
    } else if (localCount > 0) {
      tabs.push({ id: 'scope:local', label: t('studio.preset.tab.local'), kind: 'local', count: localCount })
    }
    for (const vendorId of vendors) {
      tabs.push({
        id: `vendor:${vendorId}`,
        label: t(`studio.settings.cloudApi.vendorName.${vendorId}`),
        kind: 'vendor',
        value: vendorId,
        count: list.filter((item) => item?.cloud?.vendor === vendorId).length,
      })
    }
    return tabs
  }
  const fastCount = list.filter((item) => isFastPreset(item)).length
  const qualityCount = list.length - fastCount
  if (fastCount > 0 && qualityCount > 0) {
    return [
      { id: 'all', label: t('studio.preset.tab.all'), kind: 'all', count: list.length },
      { id: 'tier:fast', label: t('studio.preset.tab.fast'), kind: 'tier', value: 'fast', count: fastCount },
      { id: 'tier:quality', label: t('studio.preset.tab.quality'), kind: 'tier', value: 'quality', count: qualityCount },
    ]
  }
  return []
}

function buildModalityFilters(t, list) {
  if (list.length <= 1) return []
  const modalities = ['image', 'video', 'game', 'mesh3d'].filter((cat) =>
    list.some((item) => presetCategoryOf(item) === cat),
  )
  if (modalities.length <= 1) return []
  return [
    { id: 'all', label: t('studio.preset.tab.all'), count: list.length },
    ...modalities.map((cat) => ({
      id: cat,
      label: t(`studio.preset.tab.${cat}`),
      count: list.filter((item) => presetCategoryOf(item) === cat).length,
    })),
  ]
}

function matchesTab(preset, tab, { localGpu = null, hardware = null } = {}) {
  if (!tab || tab.kind === 'all') return true
  if (tab.kind === 'category') return presetCategoryOf(preset) === tab.value
  if (tab.kind === 'local-deploy') return isLocalDeployCandidate(preset, localGpu, hardware)
  if (tab.kind === 'cloud-open') return !preset?.cloud && presetProvidersOf(preset).some((id) => id !== 'local-gpu')
  if (tab.kind === 'local') return !preset?.cloud
  if (tab.kind === 'vendor') return preset?.cloud?.vendor === tab.value
  if (tab.kind === 'tier') return tab.value === 'fast' ? isFastPreset(preset) : !isFastPreset(preset)
  return true
}

function specOf(t, preset) {
  const parts = []
  // 视频模型（M4.1）：展示时长 / 分辨率与单条估价，不展示「固定步数」这类图像参数。
  if (preset.mediaType === 'video') {
    if (preset.params) parts.push(preset.params)
    const cost = Number(preset.cloud?.estCostPerVideo)
    if (Number.isFinite(cost) && cost > 0) {
      parts.push(formatText(t('studio.preset.costPerVideo'), { cost: cost.toFixed(2) }))
    }
    if (preset.video?.supportsDuration === true) {
      parts.push(formatText(t('studio.preset.videoSpec'), {
        duration: preset.video.duration?.default ?? 5,
        resolution: preset.video.defaultResolution ?? '768p',
      }))
    } else {
      parts.push(t('studio.preset.videoFixed'))
    }
    if (preset.cloud?.supportsNegative === false) parts.push(t('studio.preset.noNegative'))
    return parts.join(' · ')
  }
  if (preset.cloud) {
    if (preset.params) parts.push(preset.params)
    const cost = Number(preset.cloud.estCostPerImage)
    if (Number.isFinite(cost) && cost > 0) {
      parts.push(formatText(t('studio.preset.costPerImage'), { cost: cost.toFixed(cost < 0.01 ? 3 : 2) }))
    }
    if (preset.size) parts.push(`${preset.size}px`)
    if (preset.cloud.supportsSteps && Number(preset.steps) > 0) parts.push(`${preset.steps} ${t(LABELS.steps)}`)
    else if (preset.cloud.supportsSteps === false) parts.push(t('studio.preset.fixedSteps'))
    if (preset.cloud.supportsNegative === false) parts.push(t('studio.preset.noNegative'))
    return parts.join(' · ')
  }
  if (preset.params) parts.push(preset.params)
  if (preset.size) parts.push(`${preset.size}px`)
  if (Number(preset.gpus) > 1) parts.push(t(LABELS.dualGpu))
  else if (Number.isFinite(Number(preset.steps))) parts.push(`${preset.steps} ${t(LABELS.steps)}`)
  return parts.join(' · ')
}

function autoSwitchTargetOf(preset, currentProvider, configuredSet, session, isCloudKeyMissingFn, localGpu = null) {
  if (!preset || preset.inpaintOnly === true) return ''
  if (isPresetAllowedOnProvider(preset, currentProvider, localGpu)) return ''
  if (preset.cloud?.vendor) {
    if (!configuredSet.has('cloud-api')) return ''
    return isCloudKeyMissingFn(preset) ? '' : 'cloud-api'
  }
  const candidates = presetProvidersOf(preset).filter((id) => configuredSet.has(id))
  if (isPresetLocalReady(preset, localGpu) && configuredSet.has('local-gpu') && !candidates.includes('local-gpu')) {
    candidates.push('local-gpu')
  }
  if (candidates.length === 0) return ''
  const activeSessionProvider =
    session && session.state && session.state !== 'absent' && session.state !== 'error'
      ? session.provider
      : ''
  if (activeSessionProvider && candidates.includes(activeSessionProvider)) {
    return activeSessionProvider
  }
  const order = ['local-gpu', 'private-worker', 'colab', 'kaggle']
  for (const id of order) {
    if (candidates.includes(id)) return id
  }
  return candidates[0]
}

export function ModelCardPicker(props) {
  const {
    t,
    isEn,
    presets,
    value,
    defaultPreset,
    provider = '',
    configuredProviders = null,
    session = null,
    imageApi = null,
    localGpu = null,
    hardware = null,
    onChange,
    onOpenSettings = null,
    open,
    onOpenChange,
  } = props
  const list = Array.isArray(presets) ? presets : []
  const active = list.find((preset) => preset.id === value) || list[0] || null
  const tabs = React.useMemo(() => buildFilterTabs(t, list, { localGpu, hardware }), [t, list, localGpu, hardware])
  const modalityFilters = React.useMemo(() => buildModalityFilters(t, list), [t, list])
  const [activeTabId, setActiveTabId] = React.useState('all')
  const [activeModality, setActiveModality] = React.useState('all')
  const [noticePreset, setNoticePreset] = React.useState(null)
  const [hoveredPresetId, setHoveredPresetId] = React.useState(null)
  const [previewDimId, setPreviewDimId] = React.useState(() => SAMPLE_DIMS[0]?.id || '')
  const [previewViewMode, setPreviewViewMode] = React.useState('detail')
  const hoverTimerRef = React.useRef(null)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null
  const visibleList = React.useMemo(
    () => list.filter((preset) => {
      if (activeTab && !matchesTab(preset, activeTab, { localGpu, hardware })) return false
      if (activeModality !== 'all' && presetCategoryOf(preset) !== activeModality) return false
      return true
    }),
    [list, activeTab, activeModality, localGpu, hardware],
  )
  const configuredCloudSet = React.useMemo(() => {
    if (!imageApi || !Array.isArray(imageApi.apiKeysConfigured)) return null
    return new Set(imageApi.apiKeysConfigured)
  }, [imageApi])
  const configuredProviderSet = React.useMemo(() => {
    const set = new Set(Array.isArray(configuredProviders) ? configuredProviders : [])
    if (provider) set.add(provider)
    return set
  }, [configuredProviders, provider])
  const [isOpening, setIsOpening] = React.useState(false)
  const menuPresence = usePresence(open, 150)
  const rootRef = React.useRef(null)
  const triggerRef = React.useRef(null)
  const listRef = React.useRef(null)
  const wasOpenRef = React.useRef(false)
  const openingTimerRef = React.useRef(null)

  const cancelHoverSwitch = React.useCallback(() => {
    if (hoverTimerRef.current) {
      globalThis.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const scheduleHoverPreset = React.useCallback(
    (presetId, immediate = false) => {
      cancelHoverSwitch()
      if (immediate) {
        setHoveredPresetId(presetId)
        return
      }
      hoverTimerRef.current = globalThis.setTimeout(() => {
        hoverTimerRef.current = null
        setHoveredPresetId(presetId)
      }, 85)
    },
    [cancelHoverSwitch],
  )

  React.useEffect(() => {
    if (!open) {
      cancelHoverSwitch()
      setNoticePreset(null)
      setHoveredPresetId(null)
      setIsOpening(false)
      wasOpenRef.current = false
      if (openingTimerRef.current) {
        globalThis.clearTimeout(openingTimerRef.current)
        openingTimerRef.current = null
      }
    }
    return cancelHoverSwitch
  }, [open, cancelHoverSwitch])

  React.useEffect(() => {
    if (activeTabId !== 'all' && !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId('all')
    }
  }, [activeTabId, tabs])

  React.useEffect(() => {
    if (activeModality !== 'all' && !modalityFilters.some((item) => item.id === activeModality)) {
      setActiveModality('all')
    }
  }, [activeModality, modalityFilters])

  // 仅在菜单首次打开时切换默认分类 Tab、播放入场动画并定位焦点到当前选中项；切 Tab 时不再重置焦点或重播动画。
  React.useEffect(() => {
    if (!open || !menuPresence.mounted || wasOpenRef.current) return undefined
    wasOpenRef.current = true
    const defaultTab = defaultModelTabIdOf(tabs, { provider, active, imageApi })
    setActiveTabId(defaultTab)
    setActiveModality('all')
    setIsOpening(true)
    if (openingTimerRef.current) globalThis.clearTimeout(openingTimerRef.current)
    openingTimerRef.current = globalThis.setTimeout(() => {
      setIsOpening(false)
      openingTimerRef.current = null
    }, 260)
    const focusTimer = globalThis.setTimeout(() => {
      if (!listRef.current) return
      const options = listRef.current.querySelectorAll('[role="option"]')
      if (options.length === 0) return
      const targetTab = tabs.find((tab) => tab.id === defaultTab) || activeTab
      const currentVisible = targetTab ? list.filter((preset) => matchesTab(preset, targetTab, { localGpu, hardware })) : list
      const index = Math.max(0, currentVisible.findIndex((preset) => preset.id === value))
      const target = options[index] || options[0]
      if (typeof target.focus === 'function') target.focus({ preventScroll: true })
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
    }, 0)
    return () => globalThis.clearTimeout(focusTimer)
  }, [open, menuPresence.mounted])

  // 点击外部 / Esc / Tab 关闭；Esc 后焦点回到触发器。
  React.useEffect(() => {
    if (!open) return undefined
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
        if (triggerRef.current) triggerRef.current.focus({ preventScroll: true })
      } else if (event.key === 'Tab') {
        onOpenChange(false)
      }
    }
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) onOpenChange(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, onOpenChange])

  function isCloudKeyMissing(preset) {
    const vendor = preset?.cloud?.vendor
    return Boolean(vendor && configuredCloudSet && !configuredCloudSet.has(vendor))
  }

  function choose(preset) {
    // 专用局部重绘权重只服务舞台图片工具：主表单选择器不给选（Lead 决策 D3）。
    if (!preset || preset.inpaintOnly === true) return
    const autoSwitchTo = autoSwitchTargetOf(preset, provider, configuredProviderSet, session, isCloudKeyMissing, localGpu)
    const blockedByProvider = !isPresetAllowedOnProvider(preset, provider, localGpu) && !autoSwitchTo
    const missingKey = isCloudKeyMissing(preset)
    if (blockedByProvider || missingKey) {
      setNoticePreset(preset)
      return
    }
    setNoticePreset(null)
    if (onChange) onChange(preset, autoSwitchTo ? { switchToProvider: autoSwitchTo } : undefined)
    onOpenChange(false)
    if (triggerRef.current) triggerRef.current.focus({ preventScroll: true })
  }

  function noticeTextOf(target) {
    if (!target) return ''
    const modelName = shortOf(target)
    if (target.cloud?.vendor) {
      const vendorName = t(`studio.settings.cloudApi.vendorName.${target.cloud.vendor}`)
      if (isCloudKeyMissing(target)) {
        return formatText(t('studio.preset.needVendorKey'), { model: modelName, vendor: vendorName })
      }
      return formatText(t('studio.preset.needCloudSwitch'), { model: modelName, vendor: vendorName })
    }
    if (provider === 'local-gpu' && !isPresetAllowedOnProvider(target, 'local-gpu', localGpu)) {
      const vram = hardware?.evaluation?.profile?.vramGb ?? '—'
      return formatText(t('studio.preset.localNeedSetup'), { model: modelName, vram })
    }
    const needed = presetProviderRestrictionOf(target) || 'colab'
    return formatText(t('studio.preset.needProviderSwitch'), {
      model: modelName,
      provider: providerText(t, needed),
    })
  }

  function onListKeyDown(event) {
    if (!listRef.current) return
    const options = Array.prototype.slice
      .call(listRef.current.querySelectorAll('[role="option"]'))
      // 禁用项（仅图片工具可用）不可聚焦：方向键在可选模型之间循环。
      .filter((option) => option.disabled !== true && option.getAttribute('aria-disabled') !== 'true')
    if (options.length === 0) return
    const current = options.indexOf(document.activeElement)
    let next = null
    if (event.key === 'ArrowDown') next = options[(current + 1) % options.length]
    else if (event.key === 'ArrowUp') next = options[(current - 1 + options.length) % options.length]
    else if (event.key === 'Home') next = options[0]
    else if (event.key === 'End') next = options[options.length - 1]
    if (!next) return
    event.preventDefault()
    next.focus({ preventScroll: true })
    if (typeof next.scrollIntoView === 'function') next.scrollIntoView({ block: 'nearest' })
  }

  if (!active) {
    return (
      <span className="ofs-model is-empty" aria-hidden="true">
        <Icon name="sliders" size={14} />
        <span className="ofs-model-now">—</span>
      </span>
    )
  }

  const eta = etaOf(t, active)
  const poster = posterOf(active)
  const previewPreset = hoveredPresetId
    ? visibleList.find((preset) => preset.id === hoveredPresetId) || null
    : null
  const previewSamples = previewPreset ? MODEL_SAMPLES[previewPreset.id] || null : null

  return (
    <div className="ofs-model-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ofs-model"
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={MENU_ID}
        aria-label={t('studio.preset')}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            onOpenChange(true)
          }
        }}
      >
        {poster ? (
          <span
            className="ofs-model-thumb"
            style={{ backgroundImage: `url(${poster})` }}
            aria-hidden="true"
          />
        ) : (
          <span className="ofs-model-thumb is-fallback" aria-hidden="true">
            {(active.family || active.id || 'M').slice(0, 1)}
          </span>
        )}
        {active.family ? <span className="ofs-model-family">{active.family}</span> : null}
        <span className="ofs-model-now">{shortOf(active)}</span>
        {eta ? (
          <>
            <span className="ofs-model-div" aria-hidden="true" />
            <span className="ofs-model-eta">{eta}</span>
          </>
        ) : null}
        <Icon name="chevronDown" size={13} className="ofs-model-caret" />
      </button>

      {menuPresence.mounted ? (
        <div
          className={isOpening ? 'ofs-model-menu is-opening' : 'ofs-model-menu'}
          id={MENU_ID}
          data-exiting={menuPresence.exiting ? 'true' : undefined}
        >
          <div className="ofs-model-head">
            <span>{`${t(LABELS.menuTitle)}${list.length > 1 ? ` · ${list.length}` : ''}`}</span>
            <span>{t(LABELS.measured)}</span>
          </div>
          {tabs.length > 1 ? (
            <div className="ofs-model-tabs" role="tablist" aria-label={t(LABELS.menuTitle)}>
              {tabs.map((tab) => {
                const isSelected = activeTab && activeTab.id === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected ? 'true' : 'false'}
                    className={`ofs-model-tab${isSelected ? ' is-on' : ''}`}
                    onClick={() => {
                      setIsOpening(false)
                      setActiveTabId(tab.id)
                    }}
                  >
                    <span>{tab.label}</span>
                    {tab.kind !== 'all' ? <span className="ofs-model-tab-count">{tab.count}</span> : null}
                  </button>
                )
              })}
            </div>
          ) : null}
          {modalityFilters.length > 1 ? (
            <div className="ofs-model-filters" role="group" aria-label={t('studio.preset.modalityLabel')}>
              {modalityFilters.map((filter) => {
                const isSelected = activeModality === filter.id
                const scopedCount = filter.id === 'all'
                  ? (activeTab ? list.filter((item) => matchesTab(item, activeTab, { localGpu, hardware })).length : list.length)
                  : list.filter((item) => (!activeTab || matchesTab(item, activeTab, { localGpu, hardware })) && presetCategoryOf(item) === filter.id).length
                return (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={isSelected ? 'true' : 'false'}
                    className={`ofs-model-filter${isSelected ? ' is-on' : ''}`}
                    onClick={() => {
                      setIsOpening(false)
                      setActiveModality(filter.id)
                    }}
                  >
                    <span>{filter.label}</span>
                    {filter.id !== 'all' ? <span className="ofs-model-tab-count">{scopedCount}</span> : null}
                  </button>
                )
              })}
            </div>
          ) : null}
          <div className="ofs-model-list" role="listbox" aria-label={t(LABELS.menuTitle)} ref={listRef} onKeyDown={onListKeyDown}>
            {visibleList.length === 0 ? (
              <div className="ofs-model-empty">{t('studio.preset.emptyTab')}</div>
            ) : (() => {
              const localContext = (activeTab && activeTab.kind === 'local-deploy') || provider === 'local-gpu'
              const renderPresetOption = (preset, index) => {
                const selected = preset.id === active.id
                const image = posterOf(preset)
                const isDefault = preset.id === defaultPreset
                const imageToolOnly = preset.inpaintOnly === true
                const restrictedProvider = presetProviderRestrictionOf(preset)
                const autoSwitchTo = autoSwitchTargetOf(preset, provider, configuredProviderSet, session, isCloudKeyMissing, localGpu)
                const allowedOnCurrent = isPresetAllowedOnProvider(preset, provider, localGpu)
                const providerBlocked = !allowedOnCurrent && !autoSwitchTo
                const cloudVendorId = preset.cloud?.vendor || ''
                const missingKey = isCloudKeyMissing(preset)
                const unavailable = providerBlocked || missingKey
                const localFit = localContext ? evaluatePresetLocalFit(preset, hardware?.evaluation, localGpu) : null
                const localUnsupported = Boolean(localFit && localFit.verdict === 'unsupported')
                const localToneClass = localFit
                  ? (localUnsupported ? ' is-local-unsupported' : localFit.verdict === 'tight' ? ' is-local-tight' : ' is-local-ready')
                  : ''
                const gated = preset.gated === true
                const blockedTitle = unavailable
                  ? (cloudVendorId && missingKey
                      ? formatText(t('studio.preset.needVendorKey'), {
                          model: shortOf(preset),
                          vendor: t(`studio.settings.cloudApi.vendorName.${cloudVendorId}`),
                        })
                      : provider === 'local-gpu' && !allowedOnCurrent
                        ? formatText(t('studio.preset.localNeedSetup'), {
                            model: shortOf(preset),
                            vram: hardware?.evaluation?.profile?.vramGb ?? '—',
                          })
                        : formatText(t(LABELS.providerBlocked), {
                            provider: providerText(t, provider),
                            needed: providerText(t, restrictedProvider || (cloudVendorId ? 'cloud-api' : 'colab')),
                          }))
                  : autoSwitchTo
                    ? formatText(t('studio.preset.autoSwitchHint'), { provider: providerText(t, autoSwitchTo) })
                    : localFit && localFit.reason
                      ? localFit.reason
                      : gated
                        ? t(LABELS.gatedHint)
                        : undefined
                const optionEta = localContext && localFit?.estSeconds
                  ? `~${formatSeconds(t, localFit.estSeconds)}`
                  : etaOf(t, preset)
                const description = descriptionOf(preset, isEn)
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="option"
                    aria-selected={selected ? 'true' : 'false'}
                    aria-disabled={imageToolOnly || unavailable ? 'true' : undefined}
                    disabled={imageToolOnly}
                    className={`ofs-model-option${selected ? ' is-on' : ''}${imageToolOnly ? ' is-tool-only' : ''}${unavailable ? ' is-provider-gated' : ''}${localToneClass}`}
                    style={{ '--ofs-stagger': `${Math.min(index, 5) * 24}ms` }}
                    data-preset-id={preset.id}
                    title={imageToolOnly ? t(LABELS.imageToolOnly) : blockedTitle}
                    onMouseEnter={() => scheduleHoverPreset(preset.id, !hoveredPresetId)}
                    onFocus={() => scheduleHoverPreset(preset.id, true)}
                    onClick={() => choose(preset)}
                  >
                    <span className="ofs-model-poster" aria-hidden="true">
                      {image ? (
                        <img src={image} alt="" width="56" height="56" draggable="false" />
                      ) : (
                        <span className="ofs-model-poster-fallback">{(preset.family || preset.id || 'M').slice(0, 1)}</span>
                      )}
                    </span>
                    <span className="ofs-model-copy">
                      <span className="ofs-model-line">
                        {preset.family ? <span className="ofs-model-fam">{preset.family}</span> : null}
                        <span className="ofs-model-name">{shortOf(preset)}</span>
                        {isDefault ? <span className="ofs-model-default">{t(LABELS.default)}</span> : null}
                      </span>
                      {description ? <span className="ofs-model-desc">{description}</span> : null}
                      <span className="ofs-model-tags">
                        {imageToolOnly ? (
                          <span className="ofs-model-lang is-tool-only">{t(LABELS.imageToolOnly)}</span>
                        ) : (
                          <span className={preset.supportsChinese === true ? 'ofs-model-lang is-zh' : 'ofs-model-lang'}>
                            {t(preset.supportsChinese === true ? LABELS.langZhEn : LABELS.langEnOnly)}
                          </span>
                        )}
                        {preset.mediaType === 'video' ? (
                          <span className="ofs-model-media is-video">
                            <Icon name="film" size={10} />
                            {t('studio.preset.mediaBadge.video')}
                          </span>
                        ) : null}
                        {localFit ? (
                          <span className={`ofs-model-fit is-${localFit.tone}`} title={localFit.reason || undefined}>
                            {t(`studio.preset.verdict.${localFit.verdict}`)}
                          </span>
                        ) : null}
                        {localContext && localFit && localFit.configured ? (
                          <span className="ofs-model-fit is-ok">{t('studio.preset.fit.localReady')}</span>
                        ) : null}
                        {localContext && localFit && !localFit.configured && localFit.verdict !== 'unsupported' ? (
                          <span className="ofs-model-fit is-muted">{t('studio.preset.fit.localPending')}</span>
                        ) : null}
                        {cloudVendorId ? (
                          <span className="ofs-model-vendor">
                            {t(`studio.settings.cloudApi.vendorName.${cloudVendorId}`)}
                          </span>
                        ) : restrictedProvider && !localContext ? (
                          <span className="ofs-model-provider">
                            {formatText(t(LABELS.providerOnly), { provider: providerText(t, restrictedProvider) })}
                          </span>
                        ) : null}
                        {missingKey ? (
                          <span className="ofs-model-missing-key">{t('studio.preset.missingKeyBadge')}</span>
                        ) : null}
                        {gated && !unavailable ? (
                          <span className="ofs-model-gated">{t(LABELS.gated)}</span>
                        ) : null}
                      </span>
                      <span className="ofs-model-spec">{specOf(t, preset)}</span>
                    </span>
                    <span className="ofs-model-side">
                      {optionEta ? <span className="ofs-model-option-eta">{optionEta}</span> : <span className="ofs-model-option-eta" />}
                      <span className="ofs-model-check" aria-hidden="true">
                        <Icon name="check" size={15} />
                      </span>
                    </span>
                  </button>
                )
              }

              if (activeTab && activeTab.kind === 'local-deploy' && hardware?.evaluation) {
                const groups = { ready: [], tight: [], unsupported: [] }
                for (const item of visibleList) {
                  const fit = evaluatePresetLocalFit(item, hardware.evaluation, localGpu)
                  const bucket = fit?.verdict || 'ready'
                  groups[bucket].push({ item, fit })
                }
                const sortByConfigured = (a, b) => (b.fit?.configured ? 1 : 0) - (a.fit?.configured ? 1 : 0)
                groups.ready.sort(sortByConfigured)
                groups.tight.sort(sortByConfigured)
                let runningIndex = 0
                return ['ready', 'tight', 'unsupported']
                  .filter((key) => groups[key].length > 0)
                  .map((key) => {
                    const dotTone = key === 'ready' ? 'is-ok' : key === 'tight' ? 'is-warn' : 'is-idle'
                    return (
                      <div key={key} className="ofs-model-group" data-local-group={key}>
                        <div className={`ofs-model-group-head is-${key}`} role="presentation">
                          <i className={`ofs-dot ${dotTone}`} aria-hidden="true" />
                          <span className="ofs-model-group-title">{t(`studio.preset.localGroup.${key}`)}</span>
                          <span className="ofs-model-group-count">{groups[key].length}</span>
                        </div>
                        {groups[key].map(({ item }) => renderPresetOption(item, runningIndex++))}
                      </div>
                    )
                  })
              }

              return visibleList.map((preset, index) => renderPresetOption(preset, index))
            })()}
          </div>
          {noticePreset ? (
            <div className="ofs-model-notice" role="status">
              <span className="ofs-model-notice-text">{noticeTextOf(noticePreset)}</span>
              {onOpenSettings ? (
                <button
                  type="button"
                  className="ofs-model-notice-btn"
                  onClick={() => {
                    const target = noticePreset
                    setNoticePreset(null)
                    onOpenChange(false)
                    onOpenSettings(target)
                  }}
                >
                  {t('studio.preset.goSettings')}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="ofs-model-foot">{t(LABELS.footer)}</div>
          {previewPreset && previewSamples ? (
            <ModelSamplePreview
              t={t}
              isEn={isEn}
              preset={previewPreset}
              samples={previewSamples}
              dims={SAMPLE_DIMS}
              selectedDimId={previewDimId}
              onSelectDim={setPreviewDimId}
              viewMode={previewViewMode}
              onViewModeChange={setPreviewViewMode}
              onMouseEnter={cancelHoverSwitch}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}