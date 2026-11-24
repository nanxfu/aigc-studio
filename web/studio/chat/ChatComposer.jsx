/**
 * 创作助手一体化紧凑输入坞（A2）。
 *
 * 把原先三层堆叠的「工具条 + 常驻 75px 参考图大盒 + 输入框」整合为一张内聚圆角卡片：
 *  - 未挂图且未拖拽时，顶部参考图托盘 0 高度折叠，为对话流释放近 100px 视口；
 *  - 底栏左侧放紧凑参考图入口（本地选图 / 从作品选择）+ 舞台图上下文感知微标；
 *  - 底栏右侧放新建对话 + 原位合一的「发送 / 停止」主圆钮；
 *  - 支持拖放外部文件/站内作品，以及 `Ctrl+V` 直接粘贴剪贴板图片进参考图槽。
 */

import React from 'react'

import { LIMITS } from '../../../shared/contract.js'
import { referenceListOf, referenceMaxCount } from '../../logic/reference.js'
import { filesOf, hasFilePayload, hasWorkDragPayload, workDragPathOf } from '../drag.js'
import { CHAT_REF_ACCEPT, ChatReferenceBar } from '../ChatReferenceBar.jsx'
import { Icon } from '../icons.jsx'

function entryMatchesPath(entry, path) {
  if (!path) return Boolean(entry)
  const target = entry && entry.image && typeof entry.image.path === 'string' ? entry.image.path.trim() : ''
  return target === path
}

/** 从剪贴板事件提取图片文件（忽略纯文本粘贴）。 */
function clipboardImageFiles(event) {
  const data = event && event.clipboardData
  if (!data) return []
  const fromFiles = data.files ? Array.from(data.files).filter((file) => file && typeof file.type === 'string' && file.type.startsWith('image/')) : []
  if (fromFiles.length > 0) return fromFiles
  const items = data.items ? Array.from(data.items) : []
  const out = []
  for (const item of items) {
    if (item && item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/')) {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
      if (file) out.push(file)
    }
  }
  return out
}

export function ChatComposer(props) {
  const {
    t,
    ui,
    draft,
    setDraft,
    textareaRef,
    locked,
    sending,
    interpreting,
    streamingAgent,
    stopAgent,
    hasMessages,
    onSend,
    onNewChat,
    onNewCreation,
    references,
    referenceMax,
    referenceSupported,
    referenceSwitchLabel,
    referenceBusy,
    works,
    stageImage,
    actions,
  } = props

  const [picking, setPicking] = React.useState(false)
  const [refDragKind, setRefDragKind] = React.useState('')
  const refDragDepthRef = React.useRef(0)
  const fileInputRef = React.useRef(null)

  const items = referenceListOf(references)
  const max = Number(referenceMax) > 0 ? Number(referenceMax) : referenceMaxCount()
  const canAddRef = items.length < max

  function openFilePicker() {
    if (locked || !canAddRef || referenceBusy) return
    const input = fileInputRef.current
    if (input && typeof input.click === 'function') input.click()
  }

  function onFileChange(event) {
    const input = event && event.target
    const files = input && input.files ? Array.from(input.files).filter(Boolean) : []
    if (input) input.value = ''
    if (files.length > 0 && actions && typeof actions.uploadReferenceFiles === 'function') {
      actions.uploadReferenceFiles(files)
    }
  }

  function dragKindOf(event) {
    if (locked) return ''
    if (hasWorkDragPayload(event)) return 'work'
    if (hasFilePayload(event)) return 'file'
    return ''
  }

  function onDockDragEnter(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    refDragDepthRef.current += 1
    if (refDragKind !== kind) setRefDragKind(kind)
  }

  function onDockDragOver(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  function onDockDragLeave(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    refDragDepthRef.current = Math.max(0, refDragDepthRef.current - 1)
    if (refDragDepthRef.current === 0 && refDragKind) setRefDragKind('')
  }

  function onDockDrop(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    refDragDepthRef.current = 0
    if (refDragKind) setRefDragKind('')
    if (kind === 'work') {
      const dragged = ui && ui.draggingWork ? ui.draggingWork : null
      const path = workDragPathOf(event.dataTransfer) || (dragged && dragged.path) || ''
      if (ui && typeof ui.setDraggingWork === 'function') ui.setDraggingWork(null)
      const entry = dragged && entryMatchesPath(dragged.entry, path) ? dragged.entry : null
      if ((entry || path) && actions && typeof actions.addReference === 'function') {
        actions.addReference(entry || path)
      }
      return
    }
    const files = filesOf(event.dataTransfer)
    if (files.length > 0 && actions && typeof actions.uploadReferenceFiles === 'function') {
      actions.uploadReferenceFiles(files)
    }
  }

  function onPaste(event) {
    if (locked || !canAddRef || referenceBusy) return
    const images = clipboardImageFiles(event)
    if (images.length === 0) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    if (actions && typeof actions.uploadReferenceFiles === 'function') {
      actions.uploadReferenceFiles(images)
    }
  }

  const canStop = Boolean(streamingAgent && typeof stopAgent === 'function')

  return (
    <div
      className={refDragKind ? 'ofs-chat-dock is-ref-drop' : 'ofs-chat-dock'}
      onDragEnter={onDockDragEnter}
      onDragOver={onDockDragOver}
      onDragLeave={onDockDragLeave}
      onDrop={onDockDrop}
    >
      {/* 导入图锁定态：提示与「新建创作」出口放在禁用区之外，保证随时可逃逸。 */}
      {locked ? (
        <div className="ofs-lock-hint is-chat" role="note">
          <div className="ofs-lock-head">
            <Icon name="image" size={12} />
            <span className="ofs-lock-title">{t('studio.lock.title')}</span>
            <button
              type="button"
              className="ofs-lock-action"
              onClick={() => typeof onNewCreation === 'function' && onNewCreation()}
            >
              <Icon name="plus" size={11} />
              {t('studio.rail.newCreation')}
            </button>
          </div>
          <p className="ofs-lock-body">{t('studio.lock.chatHint')}</p>
        </div>
      ) : null}

      <div
        className={locked ? 'ofs-chat-composer is-locked' : 'ofs-chat-composer'}
        inert={locked && !canStop ? true : undefined}
        aria-disabled={locked ? 'true' : undefined}
      >
        <div className="ofs-chat-refs-wrap" inert={locked ? true : undefined}>
          <ChatReferenceBar
            t={t}
            references={references}
            referenceMax={referenceMax}
            works={works}
            busy={referenceBusy}
            referenceSupported={referenceSupported}
            referenceSwitchLabel={referenceSwitchLabel}
            actions={actions}
            picking={picking}
            setPicking={setPicking}
            dragKind={refDragKind}
            onOpenFile={openFilePicker}
          />
        </div>

        <textarea
          ref={textareaRef}
          rows={2}
          value={draft}
          maxLength={LIMITS.prompt.maxChars}
          placeholder={t('studio.chat.placeholder')}
          aria-label={t('studio.chat.placeholder')}
          spellCheck={false}
          disabled={locked}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            if (event.nativeEvent && event.nativeEvent.isComposing) return
            event.preventDefault()
            onSend()
          }}
        />

        <div className="ofs-chat-composer-bar">
          <div className="ofs-chat-composer-left" inert={locked ? true : undefined}>
            <button
              type="button"
              className={items.length > 0 ? 'ofs-chat-tool-btn ofs-chat-ref-entry is-active' : 'ofs-chat-tool-btn ofs-chat-ref-entry'}
              onClick={openFilePicker}
              disabled={locked || referenceBusy || !canAddRef}
              title={t('studio.chat.ref.addFileHint')}
              aria-label={t('studio.chat.ref.addFile')}
            >
              <Icon name="paperclip" size={13} />
              <span>{t('studio.chat.ref.addFileShort')}</span>
              {items.length > 0 ? <span className="ofs-chat-tool-badge">{items.length}</span> : null}
            </button>
            <button
              type="button"
              className={picking ? 'ofs-chat-tool-btn ofs-chat-ref-entry is-active' : 'ofs-chat-tool-btn ofs-chat-ref-entry'}
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
              disabled={locked || !canAddRef}
              title={t('studio.chat.ref.pickWork')}
              aria-label={t('studio.chat.ref.pickWork')}
            >
              <Icon name="images" size={13} />
              <span>{t('studio.chat.ref.pickWorkShort')}</span>
            </button>
          </div>

          <div className="ofs-chat-composer-right">
            <button
              type="button"
              className="ofs-chat-tool-btn ofs-chat-new"
              onClick={onNewChat}
              disabled={!hasMessages || locked}
              title={t('studio.chat.newChat')}
              aria-label={t('studio.chat.newChat')}
            >
              <Icon name="newChat" size={13} />
              <span>{t('studio.chat.newChat')}</span>
            </button>

            {/* 发送与停止原位合一：流式中不跳位置，且不被锁定态禁掉。 */}
            {canStop ? (
              <button
                type="button"
                className="ofs-chat-send ofs-chat-stop"
                onClick={stopAgent}
                aria-label={t('studio.chat.agent.stop')}
                title={t('studio.chat.agent.stop')}
              >
                <Icon name="stop" size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="ofs-chat-send"
                onClick={onSend}
                disabled={sending || interpreting || draft.trim().length === 0 || locked}
                aria-label={t('studio.chat.send')}
                title={t('studio.chat.send')}
              >
                <Icon name="arrowUp" size={15} />
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          className="ofs-ref-input"
          type="file"
          accept={CHAT_REF_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          hidden
          onChange={onFileChange}
        />
      </div>
    </div>
  )
}
