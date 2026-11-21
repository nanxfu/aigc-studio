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
import { GuidanceCard } from './GuidanceCard.jsx'
import { LogsDrawer } from './LogsDrawer.jsx'
import { PanelModeTabs } from './PanelModeTabs.jsx'
import { PipelineBar } from './PipelineBar.jsx'
import { QueueNotice } from './QueueNotice.jsx'
import { Rail } from './Rail.jsx'
import { SettingsDrawer } from './SettingsDrawer.jsx'
import { Stage } from './Stage.jsx'
import { Toast } from './Toast.jsx'
import { TopBar } from './TopBar.jsx'
import { PromptCompareModal } from './rail/PromptCompareModal.jsx'
import { useStudioLogs } from './hooks/useStudioLogs.js'
import { canAnimatePresence, usePresence } from './hooks/usePresence.js'
import { useCompletionNotice } from './hooks/useStudioUi.js'
import { useStudio } from './useStudio.js'

export function Studio(props) {
  const { t, isEn, ui, compute, form, chat, library, imageTool, guidance, actions } = useStudio(props)
  const status = compute.status
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
          : <Rail embedded t={t} ui={ui} compute={compute} form={form} actions={actions} library={library} />}
      </div>
    </aside>
  )

  // 指引按严重度分流：全局阻塞/环境前置卡走顶部横幅，局部可恢复/一次性提醒走右上角通知。
  const guidanceSurface = guidance && guidance.kind
    ? (guidance.surface || guidanceSurfaceOf(guidance.kind))
    : ''
  const bannerGuidance = guidanceSurface === 'banner' ? guidance : null
  const noticeGuidance = guidanceSurface === 'toast' ? guidance : null

  return (
    <div className="ofs-root">
      <div className="ofs-app">
        <TopBar t={t} isEn={isEn} ui={ui} compute={compute} form={form} library={library} defaultModelOpen={props.defaultModelOpen} />

        {/* 状态区：流水线 / 排队卡 / 阻塞指引自上而下堆叠；右上角通知从这条带子的下沿展开，
            不再压住流水线右侧的等待读数。 */}
        <div className="ofs-status-area">
          {/* 顶部生图流水线：替换原先的一行云端状态条，五节点展示等待流程。
              原始输入直接交给组件，读秒与可见性判定都在 PipelineBar 内部完成。 */}
          <PipelineBar
            t={t}
            session={compute.session}
            provider={compute.provider}
            activeJob={compute.activeJob}
            focusedJob={compute.focusedJob}
            pendingCount={compute.pendingJobs.length}
            queuePolicy={compute.queue.policy}
            failureDismissed={Boolean(guidance.key) && ui.dismissed === guidance.key}
            transient={Boolean(status && status.transient)}
          />

          {/* 排队卡住（10 分钟档）是非错误提示：横幅给「换新实例重排」，不阻挡工作区。 */}
          <QueueNotice t={t} notice={compute.queueNotice} />

          {bannerGuidance ? (
            <GuidanceCard t={t} guidance={bannerGuidance} compute={compute} actions={actions} ui={ui} />
          ) : null}

          <Toast t={t} toast={ui.toast} guidance={noticeGuidance} compute={compute} actions={actions} ui={ui} />
        </div>

        <div className={`ofs-body${ui.view === 'gallery' ? ' is-gallery' : ''}`}>
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
            ) : (
              <Stage t={t} ui={ui} compute={compute} form={form} library={library} imageTool={imageTool} actions={actions} viewEnter={enteringStudio} />
            )}
          </div>
        </div>

        {ui.view === 'studio' ? (
          <Filmstrip t={t} ui={ui} compute={compute} library={library} actions={actions} viewEnter={enteringStudio} />
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
    </div>
  )
}
