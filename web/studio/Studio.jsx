/**
 * 生图工作台（Studio）：顶栏 + 顶部生图流水线 + 单轨创作面板 + 画面预览 + 最近生成 + 画廊。
 *
 * 独立客户端里由 web/main.jsx 挂载为整页视图；语言与主题由入口层初始化，
 * 主题切换通过 props.onAppearanceChange 回传给入口层。
 *
 * 左侧面板两种形态共用一份状态：
 *   表单式（Rail）—— 适合精确调参；
 *   对话式（ChatPanel）—— 适合自然语言描述与迭代。
 */

import React from 'react'

import { LIMITS } from '../../shared/contract.js'
import { guidanceSurfaceOf } from '../logic/guidance.js'
import { ChatPanel } from './ChatPanel.jsx'
import { Filmstrip } from './Filmstrip.jsx'
import { Gallery } from './Gallery.jsx'
import { JobFlyOverlay } from './JobFlyOverlay.jsx'
import { LogsDrawer } from './LogsDrawer.jsx'
import { PanelModeTabs } from './PanelModeTabs.jsx'
import { Rail } from './Rail.jsx'
import { ReferenceFlyOverlay } from './ReferenceFlyOverlay.jsx'
import { SettingsDrawer } from './SettingsDrawer.jsx'
import { Onboarding } from './onboarding/Onboarding.jsx'
import { Stage } from './Stage.jsx'
import { Toast } from './Toast.jsx'
import { TopBar } from './TopBar.jsx'
import { Workshop } from './workshop/Workshop.jsx'
import { PromptCompareModal } from './rail/PromptCompareModal.jsx'
import { useStudioLogs } from './hooks/useStudioLogs.js'
import { canAnimatePresence, usePresence } from './hooks/usePresence.js'
import { useCompletionNotice } from './hooks/useStudioUi.js'
import { useStudio } from './useStudio.js'

export function Studio(props) {
  const { t, isEn, ui, compute, form, chat, library, imageTool, guidance, actions } = useStudio(props)
  const status = compute.status
  const [onboardingOpen, setOnboardingOpen] = React.useState(Boolean(props.defaultOnboardingOpen))
  // 阶段十五 Phase C0：1Hz 读秒下沉到真正读时间的叶子节点（PipelineBar / Filmstrip），
  // 这里不再持有 useNow —— 等待出图期间不驱动整页每秒重渲染。
  const chatMode = ui.panelMode === 'chat'
  // 日志抽屉只在打开时轮询；完成提醒在页面隐藏期间用标签页标题提示。
  const logs = useStudioLogs(ui.logsOpen)
  const logsPresence = usePresence(ui.logsOpen, 175)
  const settingsPresence = usePresence(ui.settingsOpen, 175)
  useCompletionNotice({ t, ui, job: compute.focusedJob, activeJob: compute.activeJob })

  // 外壳（卡片边框 / 标题 / 模式胶囊）在表单 ↔ 助手切换时保持常驻，只让内容区按方向滑入，
  // 避免整张面板及标签栏闪动。首次挂载不播切入动画。
  const prevPanelModeRef = React.useRef(ui.panelMode)
  const panelEnterClass = prevPanelModeRef.current === ui.panelMode
    ? ''
    : (ui.panelMode === 'chat' ? ' is-enter-right' : ' is-enter-left')
  React.useEffect(() => {
    prevPanelModeRef.current = ui.panelMode
  }, [ui.panelMode])

  React.useEffect(() => {
    if (!form.refineOriginPrompt && ui.promptCompareOpen) {
      ui.closePromptCompare()
    }
  }, [form.refineOriginPrompt, ui.promptCompareOpen])

  // 创作 ↔ 画廊视图切换：首次挂载不播；切换时记录方向并保持到下次切换，
  // 避免动画结束后移除属性触发基础 animation 重播而闪烁。
  const prevViewRef = React.useRef(ui.view)
  const viewDirRef = React.useRef('')
  if (prevViewRef.current !== ui.view) {
    viewDirRef.current = canAnimatePresence()
      ? (ui.view === 'gallery' ? 'to-gallery' : 'to-studio')
      : ''
    prevViewRef.current = ui.view
  }
  const enteringGallery = viewDirRef.current === 'to-gallery'
  const enteringStudio = viewDirRef.current === 'to-studio'

  const startNewCreation = form && typeof form.newCreation === 'function'
    ? form.newCreation
    : (actions && typeof actions.newDraft === 'function' ? actions.newDraft : undefined)

  const panel = (
    <aside
      className={`ofs-panel ${chatMode ? 'ofs-panel--chat' : 'ofs-panel--form'}`}
      data-view-enter={enteringStudio ? 'true' : undefined}
    >
      <PanelModeTabs
        t={t}
        mode={ui.panelMode}
        setMode={ui.setPanelMode}
        onNewCreation={startNewCreation}
      />
      <div key={ui.panelMode} className={`ofs-panel-body${panelEnterClass}`}>
        {chatMode
          ? <ChatPanel embedded t={t} ui={ui} compute={compute} form={form} chat={chat} library={library} actions={actions} />
          : <Rail embedded t={t} isEn={isEn} ui={ui} compute={compute} form={form} actions={actions} library={library} />}
      </div>
    </aside>
  )

  // 指引按严重度分流：全局阻塞/环境前置卡走顶部横幅，局部可恢复/一次性提醒走右上角通知。
  const guidanceSurface = guidance && guidance.kind
    ? (guidance.surface || guidanceSurfaceOf(guidance.kind))
    : ''
  const bannerGuidance = guidanceSurface === 'banner' ? guidance : null
  const noticeGuidance = guidanceSurface === 'toast' ? guidance : null

  if (onboardingOpen) {
    return (
      <div className="ofs-root ofs-root--onboarding">
        <Onboarding
          t={t}
          compute={compute}
          ui={ui}
          defaultStep={props.defaultOnboardingStep}
          defaultFeature={props.defaultOnboardingFeature}
          defaultDemoSettled={Boolean(props.defaultDemoSettled)}
          onClose={({ settingsTab } = {}) => {
            setOnboardingOpen(false)
            compute.refreshState()
            if (settingsTab) {
              const target = typeof settingsTab === 'object' ? settingsTab : { tab: settingsTab }
              ui.openSettings(null, target.tab, target.provider ? { provider: target.provider } : null)
            }
          }}
        />
      </div>
    )
  }

  return (
    <div className="ofs-root">
      <div className="ofs-app">
        <TopBar
          t={t}
          isEn={isEn}
          ui={ui}
          compute={compute}
          form={form}
          library={library}
          actions={actions}
          guidance={guidance}
          defaultModelOpen={props.defaultModelOpen}
          defaultQueueOpen={props.defaultQueueOpen}
        />

        {/* 状态区只作右上角浮层定位锚点（0px 占位）：流水线与排队卡收进顶栏任务队列弹层，
            阻塞指引随通知叠层右上角浮动呈现，不再把整块工作区往下顶。 */}
        <div className="ofs-status-area">
          <Toast t={t} toast={ui.toast} guidance={noticeGuidance} bannerGuidance={bannerGuidance} compute={compute} actions={actions} ui={ui} />
        </div>

        <div className={`ofs-body${ui.view === 'gallery' ? ' is-gallery' : ''}${ui.view === 'workshop' ? ' is-workshop' : ''}`}>
          {ui.view === 'studio' ? panel : null}

          <div className="ofs-main">
            {ui.view === 'gallery' ? (
              <Gallery
                t={t}
                viewEnter={enteringGallery}
                gallery={library.gallery}
                presets={compute.presets}
                favorites={library.favorites}
                hasMore={library.hasMore}
                loadingMore={library.loadingMore}
                onLoadMore={library.loadMore}
                onRefresh={library.loadHistory}
                onDelete={library.deleteImages}
                onExport={library.exportPaths}
                onRedraw={(entry) => actions.openImageTool('inpaint', entry, { recall: true })}
                onToggleFavorite={library.toggleFavorite}
                onZoom={(entry) => actions.zoomWork(entry)}
                onOpenStudio={(entry) => {
                  // 阶段十五 A1：画廊「在工作台打开」与主点击同义——切回工作台并回填参数；
                  // 左栏若有未提交草稿，由 previewWork 先行托管进草稿卡，不会丢。
                  actions.previewWork(entry)
                  ui.setView('studio')
                  ui.setZoom(false)
                }}
              />
            ) : ui.view === 'workshop' ? (
              // 资产工坊（M4.2a / M4.2b）：独立整页视图，工坊态不渲染左栏面板与底部作品条，
              // 让画布吃满宽度；返回创作由工坊页头部按钮负责。
              <Workshop
                t={t}
                isEn={isEn}
                ui={ui}
                compute={compute}
                library={library}
                actions={actions}
                initialEntry={actions.workshopEntry}
                initialTool={actions.workshopInitialTool}
                viewEnter={enteringStudio}
                {...(props.workshopProps || {})}
              />
            ) : (
              <Stage t={t} ui={ui} compute={compute} form={form} library={library} imageTool={imageTool} actions={actions} viewEnter={enteringStudio} />
            )}
          </div>
        </div>

        {ui.view === 'studio' ? (
          <Filmstrip t={t} ui={ui} compute={compute} library={library} actions={actions} viewEnter={enteringStudio} showPendingJobs={false} />
        ) : null}
      </div>

      {logsPresence.mounted ? (
        <LogsDrawer t={t} ui={ui} compute={compute} logs={logs} exiting={logsPresence.exiting} onClose={ui.closeLogs} />
      ) : null}

      {settingsPresence.mounted ? (
        <SettingsDrawer
          t={t}
          ui={ui}
          defaultTab={ui.settingsTab}
          colabAuth={compute.colabAuth}
          colabLogin={compute.colabLogin}
          copyText={ui.copyText}
          exiting={settingsPresence.exiting}
          onClose={ui.closeSettings}
          // 保存云端算力设置（HF Token / provider）后立即刷新 /state，避免预检与顶栏滞后 10s。
          onSaved={compute.refreshState}
          // 语言 / 主题保存成功后交给入口层（main.jsx）应用并重渲染整棵界面。
          onAppearanceChange={props.onAppearanceChange}
          onOpenOnboarding={() => {
            ui.closeSettings()
            setOnboardingOpen(true)
          }}
        />
      ) : null}

      {ui.promptCompareOpen && form.refineOriginPrompt ? (
        <PromptCompareModal
          t={t}
          open
          onClose={ui.closePromptCompare}
          originPrompt={form.refineOriginPrompt}
          prompt={form.form.prompt}
          maxLength={LIMITS.prompt.maxChars}
          patchForm={form.patchForm}
          onRestoreOrigin={form.restoreRefineOrigin}
        />
      ) : null}

      <ReferenceFlyOverlay
        fly={actions && actions.referenceFly ? actions.referenceFly : null}
        onDone={actions && typeof actions.clearReferenceFly === 'function' ? actions.clearReferenceFly : undefined}
      />

      <JobFlyOverlay
        fly={actions && actions.queueFly ? actions.queueFly : null}
        onDone={actions && typeof actions.clearQueueFly === 'function' ? actions.clearQueueFly : undefined}
      />
    </div>
  )
}
