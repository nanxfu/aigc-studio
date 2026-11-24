/**
 * 创作助手（对话式面板，单轨 Agent）。
 *
 * 模块拆分：
 *  - `chat/ChatEmptyState.jsx`：印相室气质空态与场景快捷启动；
 *  - `chat/ChatCards.jsx`：生成确认卡（含已提交历史态收敛）、澄清卡、步骤时间线、探索方案卡；
 *  - `chat/ChatResultGrid.jsx`：1~4 格缩略图网格 + 不打断聊天流的内联单图快捷操作面板；
 *  - `chat/ChatComposer.jsx`：一体化紧凑输入坞（内置按需展开的参考图托盘 + 粘贴图片 + 原位发送/停止）；
 *  - `chat/ChatMarkdown.jsx`：零依赖轻量 Markdown 排版。
 */

import React from 'react'

import { gridImagesOf, lastUserPromptBefore, strengthLabelOf } from '../logic/chat.js'
import { formatText } from '../logic/format.js'
import { AgentStepTimeline, ClarifyCard, CopyMiniButton, ExploreCard, ExploreProgress, IntentCard, isWorkingStage, modelLabelOf } from './chat/ChatCards.jsx'
import { ChatComposer } from './chat/ChatComposer.jsx'
import { ChatEmptyState } from './chat/ChatEmptyState.jsx'
import { ChatMarkdown } from './chat/ChatMarkdown.jsx'
import { ChatResultGrid, FocusActionBar, ThreadImage } from './chat/ChatResultGrid.jsx'
import { Icon } from './icons.jsx'
import { PanelModeTabs } from './PanelModeTabs.jsx'

const MIRROR_TOOL_IDS = Object.freeze(['inpaint', 'img2img', 'upscale', 'outpaint'])

function formSyncTitle(t, source) {
  if (source === 'variant') return t('studio.chat.formSync.variant')
  if (source === 'retry') return t('studio.chat.formSync.retry')
  return t('studio.chat.formSync.form')
}

function formSyncChips(t, message) {
  const summary = message && message.summary && typeof message.summary === 'object' ? message.summary : null
  if (!summary) return []
  const chips = []
  const model = modelLabelOf(summary.presetId) || (typeof summary.presetId === 'string' ? summary.presetId : '')
  if (model) chips.push({ key: 'model', text: model })
  const width = Number(summary.width)
  const height = Number(summary.height)
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    const size = `${Math.round(width)} × ${Math.round(height)}`
    chips.push({
      key: 'size',
      text: typeof summary.ratioId === 'string' && summary.ratioId ? `${summary.ratioId} · ${size}` : size,
    })
  }
  const count = Number(summary.count)
  if (Number.isFinite(count) && count > 0) {
    chips.push({ key: 'count', text: `${Math.round(count)} ${t('unit.image')}` })
  }
  const seedValue = summary.seed
  const seed = seedValue === null || seedValue === undefined || seedValue === '' ? NaN : Number(seedValue)
  if (Number.isFinite(seed) && seed >= 0) {
    chips.push({ key: 'seed', text: formatText(t('studio.chat.formSync.seed'), { seed: Math.trunc(seed) }) })
  } else {
    chips.push({ key: 'seed', text: t('studio.chat.formSync.seedRandom') })
  }
  return chips
}

export function ChatPanel(props) {
  const { t, ui, compute, form, chat, library, actions, embedded } = props
  const { panelMode: mode, setPanelMode: setMode } = ui
  const {
    messages,
    interpreting,
    streamingAgent = false,
    stopAgent = null,
    interpret,
    updateIntentField,
    generateIntent,
    handoffIntent,
    toggleIntentLockSeed,
    canLockSeed,
    resolveClarify,
    startExplore,
    newChat,
    focus,
    focusBack,
    focusBackLabel,
    focusImage,
    focusClear,
  } = chat
  const { openMessage: openImage } = library
  const { sending } = actions
  const negativeActive = Boolean(form && form.negativeActive === true)
  const locked = Boolean(library && library.importLocked)

  const references = form && form.form && Array.isArray(form.form.references) ? form.form.references : []
  const referenceSupported = Boolean(form && form.referenceSupported === true)
  const referenceSwitchLabel = form && typeof form.referenceSwitchLabel === 'string' ? form.referenceSwitchLabel : ''
  const referenceMax = form && form.referenceMax
  const referenceBusy = Boolean(actions && actions.referenceUploading)

  const [brokenImages, setBrokenImages] = React.useState({})
  const [compareSets, setCompareSets] = React.useState({})
  const [draft, setDraft] = React.useState('')
  const [showScrollBottom, setShowScrollBottom] = React.useState(false)

  const threadRef = React.useRef(null)
  const composerInputRef = React.useRef(null)
  const stickyBottomRef = React.useRef(true)
  const initialIdsRef = React.useRef(null)

  if (initialIdsRef.current === null) {
    initialIdsRef.current = new Set(
      (Array.isArray(messages) ? messages : [])
        .map((item) => item && item.id)
        .filter((id) => id !== undefined && id !== null),
    )
  }

  const isNewMessage = (id) => id === undefined || id === null || !initialIdsRef.current.has(id)
  const toggleCompareSet = (messageId) => setCompareSets((prev) => ({ ...prev, [messageId]: !prev[messageId] }))
  const markBroken = (path) => {
    const key = typeof path === 'string' ? path.trim() : ''
    if (!key) return
    setBrokenImages((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
  }
  const isBrokenPath = (path) => Boolean(typeof path === 'string' && path.trim() && brokenImages[path.trim()])
  const warnMissing = () => {
    if (ui && typeof ui.showToast === 'function') ui.showToast(t('studio.chat.imageMissing'))
  }

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const lastStage = (lastMessage && lastMessage.stage) || ''
  const lastStreamPulse = lastMessage
    ? `${(lastMessage.text || '').length}:${(lastMessage.reasoning || '').length}:${(lastMessage.tools || []).length}:${(lastMessage.images || []).length}`
    : ''

  // 智能贴底：用户在底部时跟随新消息与流式吐字；主动上翻历史时暂停跟滚。
  React.useEffect(() => {
    const node = threadRef.current
    if (!node || !stickyBottomRef.current) return
    if (typeof node.scrollTo === 'function') node.scrollTo({ top: node.scrollHeight })
  }, [messages.length, lastStage, lastStreamPulse, interpreting])

  function handleThreadScroll() {
    const node = threadRef.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const nearBottom = distance <= 48
    stickyBottomRef.current = nearBottom
    setShowScrollBottom((prev) => (prev === !nearBottom ? prev : !nearBottom))
  }

  function scrollToBottom() {
    const node = threadRef.current
    if (!node) return
    stickyBottomRef.current = true
    setShowScrollBottom(false)
    if (typeof node.scrollTo === 'function') {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
    }
  }

  function send() {
    const text = draft.trim()
    if (!text || sending || interpreting || locked) return
    stickyBottomRef.current = true
    setShowScrollBottom(false)
    setDraft('')
    interpret(text)
  }

  function pickStarterPrompt(text) {
    setDraft(text)
    const input = composerInputRef.current
    if (input && typeof input.focus === 'function') input.focus()
  }

  function startNewChat() {
    if (typeof newChat === 'function') newChat()
    setDraft('')
    stickyBottomRef.current = true
    setShowScrollBottom(false)
  }

  function openPath(path) {
    const target = typeof path === 'string' ? path.trim() : ''
    if (target && typeof openImage === 'function') openImage(target)
  }

  function libraryEntryOf(path) {
    const target = typeof path === 'string' ? path.trim() : ''
    if (!target) return null
    const gallery = Array.isArray(library && library.gallery) ? library.gallery : []
    const found = gallery.find((entry) => entry && entry.image && entry.image.path === target)
    if (found) return found
    const items = Array.isArray(library && library.items) ? library.items : []
    for (const item of items) {
      const images = item && Array.isArray(item.images) ? item.images : []
      const image = images.find((candidate) => candidate && candidate.path === target)
      if (image) return { image, item }
    }
    return null
  }

  function openGridImage(message, image, index) {
    const path = image && typeof image.path === 'string' ? image.path : ''
    if (path && brokenImages[path]) {
      warnMissing()
      return
    }
    if (path) openPath(path)
    // 再点同一张已聚焦图时收起内联操作条，切图则更新焦点。
    if (focus && path && focus.path === path && typeof focusClear === 'function') {
      focusClear()
      return
    }
    if (typeof focusImage === 'function') focusImage(message, image, index)
  }

  function backFromFocus() {
    if (typeof focusBack !== 'function') return
    const next = focusBack()
    const path = next && typeof next.path === 'string' ? next.path : ''
    if (path) openPath(path)
  }

  function focusEntryOfPath() {
    if (!focus) return null
    const found = libraryEntryOf(focus.path)
    if (found) return found
    return {
      image: { path: focus.path, url: focus.url, width: focus.width, height: focus.height },
      item: null,
    }
  }

  React.useEffect(() => {
    if (!focus) return
    const path = typeof focus.path === 'string' ? focus.path : ''
    if (!path || libraryEntryOf(path)) return
    if (library && typeof library.loadTree === 'function') void library.loadTree(path)
  }, [focus, library.items])

  function compareFocus(entry) {
    if (!entry || !entry.item || !entry.item.sourceImage) return
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (!ui || typeof ui.setCompareOpen !== 'function') return
    const targetPath = entry.image && typeof entry.image.path === 'string' ? entry.image.path.trim() : ''
    const stagePath = library && library.selected && library.selected.image && typeof library.selected.image.path === 'string'
      ? library.selected.image.path.trim()
      : ''
    if (targetPath && targetPath !== stagePath) {
      openPath(targetPath)
      ui.setCompareOpen(true)
      return
    }
    ui.setCompareOpen(!ui.compareOpen)
  }

  function continueFocus(entry) {
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (!entry || !actions || typeof actions.openImageTool !== 'function') return
    const opened = actions.openImageTool('inpaint', entry, { keepPanel: true })
    if (opened && typeof focusClear === 'function') focusClear()
  }

  function regenerateFocus(entry) {
    if (locked) return
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (!entry || !actions || typeof actions.reroll !== 'function') return
    actions.reroll(entry)
  }

  function variantFocus() {
    if (locked || interpreting) return
    const path = typeof focus?.path === 'string' ? focus.path.trim() : ''
    if (!path || isBrokenPath(path)) {
      warnMissing()
      return
    }
    if (typeof focusClear === 'function') focusClear()
    interpret(formatText(t('studio.chat.explore.variantPrompt'), { path }))
  }

  function zoomFocus() {
    if (isBrokenPath(focus && focus.path)) {
      warnMissing()
      return
    }
    if (focus && focus.path) openPath(focus.path)
    if (ui && typeof ui.setZoom === 'function') ui.setZoom(true)
  }

  function handoff(message) {
    if (locked || typeof handoffIntent !== 'function') return
    const result = handoffIntent(message)
    if (!result) return
    if (typeof setMode === 'function') setMode('form')
    if (result !== 'cross' && ui && typeof ui.showToast === 'function') {
      ui.showToast(t('studio.chat.intent.handoffDone'))
    }
  }

  function retryAt(index) {
    if (locked || interpreting || sending) return
    const prompt = lastUserPromptBefore(messages, index)
    if (prompt) interpret(prompt)
  }

  function renderToolSync(message, isNew) {
    const tool = MIRROR_TOOL_IDS.includes(message.tool) ? message.tool : ''
    const title = tool ? t(`studio.chat.tool.${tool}`) : (typeof message.text === 'string' ? message.text : '')
    const strength = tool && message.strength !== undefined && message.strength !== null
      ? strengthLabelOf(t, message.strength)
      : ''
    const path = typeof message.imagePath === 'string' ? message.imagePath : ''
    return (
      <div className={isNew ? 'ofs-msg ofs-tool-sync is-new' : 'ofs-msg ofs-tool-sync'} key={message.id}>
        <div className="ofs-event-card ofs-tool-sync-card">
          {message.image ? (
            <button
              type="button"
              className="ofs-tool-sync-thumb"
              onClick={() => {
                if (isBrokenPath(path)) {
                  warnMissing()
                  return
                }
                openPath(path)
              }}
              title={title}
              aria-label={title}
            >
              <ThreadImage src={message.image} alt="" onDead={() => markBroken(path)} />
            </button>
          ) : null}
          <div className="ofs-tool-sync-body">
            <span className="ofs-tool-sync-title">{title}</span>
            {strength ? (
              <div className="ofs-tool-sync-chips">
                <span className="ofs-chip ofs-tool-sync-chip">{strength}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  function renderFormSync(message, isNew) {
    const chips = formSyncChips(t, message)
    const prompt = typeof message.text === 'string' ? message.text : ''
    return (
      <div className={isNew ? 'ofs-msg ofs-form-sync is-new' : 'ofs-msg ofs-form-sync'} key={message.id}>
        <div className="ofs-event-card ofs-form-sync-card">
          <div className="ofs-event-head">
            <Icon name="sliders" size={11} />
            <span className="ofs-form-sync-title">{formSyncTitle(t, message.source)}</span>
          </div>
          {prompt ? <p className="ofs-form-sync-prompt" title={prompt}>{prompt}</p> : null}
          {chips.length > 0 ? (
            <div className="ofs-form-sync-chips">
              {chips.map((chip) => (
                <span className="ofs-chip ofs-form-sync-chip" key={chip.key}>{chip.text}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  const focusEntry = focusEntryOfPath()
  const focusMountedInline = Boolean(
    focus
    && messages.some((msg) => {
      if (!msg || msg.role !== 'assistant' || msg.kind === 'intent') return false
      const imgs = gridImagesOf(msg)
      if (imgs.length === 0) return false
      return (focus.messageId !== null && focus.messageId !== undefined && focus.messageId === msg.id)
        || imgs.some((img) => img.path && focus.path && img.path === focus.path)
    }),
  )

  function renderAssistant(message, index) {
    if (message.kind === 'intent') {
      if (message.clarify) {
        return <ClarifyCard key={message.id} t={t} message={message} resolve={resolveClarify} locked={locked} />
      }
      if (message.explore) {
        return (
          <ExploreCard
            key={message.id}
            t={t}
            message={message}
            startExplore={startExplore}
            locked={locked}
            sending={sending}
            interpreting={interpreting}
          />
        )
      }
      return (
        <IntentCard
          key={message.id}
          t={t}
          message={message}
          compute={compute}
          negativeActive={negativeActive}
          locked={locked}
          sending={sending}
          canLockSeed={canLockSeed}
          updateIntentField={updateIntentField}
          generateIntent={generateIntent}
          handoff={handoff}
          toggleIntentLockSeed={toggleIntentLockSeed}
        />
      )
    }

    if (message.kind === 'error' || message.stage === 'failed') {
      const canRetry = Boolean(!locked && !interpreting && !sending && lastUserPromptBefore(messages, index))
      return (
        <div className="ofs-msg-card is-error" key={message.id} role="alert">
          <div className="ofs-msg-error-head">
            <Icon name="alert" size={13} />
            <span>{t('studio.chat.errorTitle')}</span>
          </div>
          <p className="ofs-msg-error-text">{message.text}</p>
          {canRetry ? (
            <div className="ofs-msg-error-actions">
              <button type="button" className="ofs-chip ofs-chat-retry" onClick={() => retryAt(index)}>
                <Icon name="refresh" size={11} />
                <span>{t('studio.chat.retry')}</span>
              </button>
            </div>
          ) : null}
        </div>
      )
    }

    const working = isWorkingStage(message.stage)
    const hasText = Boolean(typeof message.text === 'string' && message.text.trim())
    const showCopy = Boolean(!working && hasText && message.kind !== 'job')

    return (
      <div className={working ? 'ofs-msg-card is-working' : 'ofs-msg-card'} key={message.id}>
        {working && message.kind === 'job' ? (
          <div className="ofs-chat-status-row">
            <span className="ofs-dot ofs-chat-dot is-warn is-live" aria-hidden="true" />
            <span className="ofs-chat-status-text">{message.text || t('studio.chat.running')}</span>
          </div>
        ) : null}

        <AgentStepTimeline t={t} message={message} />

        {message.exploreProgress ? (
          <ExploreProgress t={t} progress={message.exploreProgress} showDone={true} />
        ) : null}

        {!(working && message.kind === 'job') ? (
          hasText ? (
            <ChatMarkdown text={message.text} t={t} />
          ) : (
            working ? (
              <div className="ofs-chat-status-row">
                <span className="ofs-dot ofs-chat-dot is-warn is-live" aria-hidden="true" />
                <span className="ofs-chat-status-text">{t('studio.chat.agent.streaming')}</span>
              </div>
            ) : null
          )
        ) : null}

        {working ? <span className="ofs-chat-shimmer" aria-hidden="true" /> : null}

        <ChatResultGrid
          t={t}
          message={message}
          compare={Boolean(compareSets[message.id])}
          onToggleCompare={toggleCompareSet}
          focus={focus}
          focusEntry={focusEntry}
          locked={locked}
          interpreting={interpreting}
          onOpenImage={openGridImage}
          onMarkBroken={markBroken}
          onCompare={compareFocus}
          onContinue={continueFocus}
          onRegenerate={regenerateFocus}
          onVariant={variantFocus}
          onZoom={zoomFocus}
          onCloseFocus={focusClear}
        />

        {showCopy ? (
          <div className="ofs-msg-foot">
            <CopyMiniButton text={message.text} t={t} />
          </div>
        ) : null}
      </div>
    )
  }

  const startNewCreation = form && typeof form.newCreation === 'function'
    ? form.newCreation
    : (actions && typeof actions.newDraft === 'function' ? actions.newDraft : undefined)

  const stageImage = library && library.selected && library.selected.image ? library.selected.image : null

  const content = (
    <>
      {embedded ? null : (
        <PanelModeTabs t={t} mode={mode} setMode={setMode} onNewCreation={startNewCreation} />
      )}

      <div className="ofs-thread-stage">
        <div
          className={messages.length === 0 && !interpreting && !focus ? 'ofs-thread is-empty' : 'ofs-thread'}
          ref={threadRef}
          onScroll={handleThreadScroll}
          role="log"
          aria-live="polite"
        >
          {focus && !focusMountedInline ? (
            <div className="ofs-chat-focus-detached">
              <FocusActionBar
                t={t}
                focus={focus}
                entry={focusEntry}
                locked={locked}
                interpreting={interpreting}
                onCompare={compareFocus}
                onContinue={continueFocus}
                onRegenerate={regenerateFocus}
                onVariant={variantFocus}
                onZoom={zoomFocus}
                onClose={focusClear}
                backLabel={focusBackLabel}
                onBack={typeof focusBack === 'function' ? backFromFocus : undefined}
              />
            </div>
          ) : null}

          {messages.length === 0 && !interpreting && !focus ? (
            <ChatEmptyState t={t} locked={locked} onPickPrompt={pickStarterPrompt} />
          ) : (
            <>
              {messages.map((message, index) => {
                const isNew = isNewMessage(message.id)
                if (message.role === 'user') {
                  if (message.kind === 'form') return renderFormSync(message, isNew)
                  if (message.kind === 'tool') return renderToolSync(message, isNew)
                  return (
                    <div className={isNew ? 'ofs-msg ofs-msg--user is-new' : 'ofs-msg ofs-msg--user'} key={message.id}>
                      <p>{message.text}</p>
                    </div>
                  )
                }
                return (
                  <div className={isNew ? 'ofs-msg ofs-msg--assistant is-new' : 'ofs-msg ofs-msg--assistant'} key={message.id}>
                    {renderAssistant(message, index)}
                  </div>
                )
              })}

              {interpreting && !streamingAgent ? (
                <div className="ofs-msg ofs-msg--assistant is-new">
                  <div className="ofs-msg-card is-working">
                    <div className="ofs-chat-status-row">
                      <span className="ofs-dot ofs-chat-dot is-warn is-live" aria-hidden="true" />
                      <span className="ofs-chat-status-text">{t('studio.chat.parsing')}</span>
                    </div>
                    <span className="ofs-chat-shimmer" aria-hidden="true" />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        {showScrollBottom ? (
          <button
            type="button"
            className="ofs-chat-scroll-bottom"
            onClick={scrollToBottom}
            aria-label={t('studio.chat.scrollBottom')}
            title={t('studio.chat.scrollBottom')}
          >
            <Icon name="arrowDown" size={13} />
            <span>{t('studio.chat.scrollBottom')}</span>
          </button>
        ) : null}
      </div>

      <ChatComposer
        t={t}
        ui={ui}
        draft={draft}
        setDraft={setDraft}
        textareaRef={composerInputRef}
        locked={locked}
        sending={sending}
        interpreting={interpreting}
        streamingAgent={streamingAgent}
        stopAgent={stopAgent}
        hasMessages={messages.length > 0}
        onSend={send}
        onNewChat={startNewChat}
        onNewCreation={startNewCreation}
        references={references}
        referenceMax={referenceMax}
        referenceSupported={referenceSupported}
        referenceSwitchLabel={referenceSwitchLabel}
        referenceBusy={referenceBusy}
        works={library && Array.isArray(library.gallery) ? library.gallery : []}
        stageImage={stageImage}
        actions={actions}
      />
    </>
  )

  if (embedded) return content
  return <aside className="ofs-panel ofs-panel--chat">{content}</aside>
}
