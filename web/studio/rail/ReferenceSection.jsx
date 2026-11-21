/**
 * 左栏「参考图」小节（阶段十五 Phase C2，模型原生参考生图）。
 *
 * 位置：提示词之后、画面设置之前。整节只服务一件事——把 1~N 张已落盘作品挂成
 * 本次生成的 `references`（Host 协议见 SPEC §2.2「模型原生参考图」）。
 *
 * 布局：一行 96px 方格。已挂的缩略图与两个入口（选择图片 / 从作品选择）同尺寸、同圆角，
 * 所以「挂了几张、还能加、从哪加」在一条线上就说完；满额后入口收起、只留图与一句满额说明
 * （SPEC §5.21 §3）。缩略图右上角是移除按钮，视觉 22px、热区 44px。
 *
 * 交互边界（SPEC §5.21）：
 *  - 当前预设 `supportsReference=false` 且槽位为空：整节隐藏，不占左栏空间；
 *  - 整节自身是 drop target：拖入 PNG / JPEG → 交给组合层走 `/import` 落盘后入槽；
 *  - 当前预设不支持但槽位非空：明确提示 + 两个动作（切到支持参考的模型 / 改用整图重绘），
 *    点生成由组合层前置拦下，不静默丢图。
 *
 * 组件只负责渲染与拖放 / 选择事件，槽位状态与能力判定都在 useStudioForm / logic/reference.js。
 */

import React from 'react'

import { formatText } from '../../logic/format.js'
import { referenceListOf, referenceMaxCount } from '../../logic/reference.js'
import {
  filesOf,
  hasFilePayload,
  hasWorkDragPayload,
  workDragPathOf,
} from '../drag.js'
import { Icon } from '../icons.jsx'
import { Drawer, useAnimateOpen } from './Drawer.jsx'
import { Fieldset } from './Fieldset.jsx'

/** 从作品选择一次最多列几张：复用已加载的历史分页，不新造页面。 */
const PICK_LIMIT = 8

/** 与契约 `IMPORT.mimeTypes` 对应的 accept 串（真正的格式校验在逻辑层）。 */
const ACCEPT = 'image/png,image/jpeg'

export function ReferenceSection(props) {
  const {
    t,
    references,
    referenceSupported,
    referenceSwitchLabel,
    referenceMax,
    works,
    busy,
    draggingWork,
    onEndWorkDrag,
    actions,
  } = props
  const items = referenceListOf(references)
  const [picking, setPicking] = React.useState(false)
  const animateOpen = useAnimateOpen()
  const [dragging, setDragging] = React.useState(false)
  const [dragKind, setDragKind] = React.useState('')
  const inputRef = React.useRef(null)
  // 拖拽进出是按子元素逐层触发的，用深度计数避免内部的 dragleave 提前关掉高亮。
  const dragDepthRef = React.useRef(0)

  // 上限来自契约；父组件没传时（预览 / 旧装配）回落到同一份 `referenceLimits()`。
  const max = Number(referenceMax) > 0 ? Number(referenceMax) : referenceMaxCount()
  const canAdd = items.length < max
  const addedPaths = new Set(items.map((item) => item.path))
  const pickable = (Array.isArray(works) ? works : [])
    .filter((entry) => entry && entry.image && entry.image.path && !addedPaths.has(entry.image.path))
    .slice(0, PICK_LIMIT)

  // 当前预设不支持且还没挂图：整节隐藏（Phase C2 交互边界）。
  if (!referenceSupported && items.length === 0) return null

  function openPicker() {
    // 满额时不再给文件框：界面上「添加」入口已被满额提示替代，这里只做防御。
    if (!canAdd) return
    const input = inputRef.current
    if (input && typeof input.click === 'function') input.click()
  }

  function onFileChange(event) {
    const input = event && event.target
    const files = input && input.files ? Array.from(input.files).filter(Boolean) : []
    // 清空 value：同一张图连续选两次也要能触发 change。
    if (input) input.value = ''
    if (files.length > 0 && actions && typeof actions.uploadReferenceFiles === 'function') {
      actions.uploadReferenceFiles(files)
    }
  }

  const isFull = !canAdd
  const draggedPath = draggingWork && typeof draggingWork.path === 'string' ? draggingWork.path : ''
  const isDuplicate = Boolean(draggedPath && addedPaths.has(draggedPath))
  const workBlocked = isFull || isDuplicate
  const readyWork = Boolean(draggingWork && !dragging && !busy)

  function dragKindOf(event) {
    if (hasWorkDragPayload(event)) return 'work'
    if (hasFilePayload(event)) return 'file'
    return ''
  }

  function onDragEnter(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
    dragDepthRef.current += 1
    if (dragKind !== kind) setDragKind(kind)
    if (!dragging) setDragging(true)
  }

  function onDragOver(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    const blocked = kind === 'work' ? workBlocked : isFull
    if (event.dataTransfer) event.dataTransfer.dropEffect = blocked ? 'none' : 'copy'
  }

  function onDragLeave(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      if (dragging) setDragging(false)
      if (dragKind) setDragKind('')
    }
  }

  function onDrop(event) {
    const kind = dragKindOf(event)
    if (!kind) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    if (typeof event.stopPropagation === 'function') event.stopPropagation()
    dragDepthRef.current = 0
    if (dragging) setDragging(false)
    if (dragKind) setDragKind('')
    if (kind === 'work') {
      if (typeof onEndWorkDrag === 'function') onEndWorkDrag()
      const path = workDragPathOf(event.dataTransfer) || draggedPath
      const entry = draggingWork && (!path || draggingWork.path === path) ? draggingWork.entry : null
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

  const hoverBlocked = dragging && ((dragKind === 'work' && workBlocked) || (dragKind === 'file' && isFull))
  const readyBlocked = readyWork && workBlocked
  const dropBlocked = hoverBlocked || readyBlocked
  const zoneClass = `ofs-ref-zone${dragging ? ' is-dragging' : ''}${readyWork ? ' is-drop-ready' : ''}${dropBlocked ? ' is-drop-blocked' : ''}${busy ? ' is-busy' : ''}`
  const dropHintText = dragging
    ? (dragKind === 'work'
      ? (isDuplicate
        ? t('studio.reference.duplicate')
        : (isFull ? formatText(t('studio.reference.full'), { max }) : t('studio.drag.dropReferenceWork')))
      : (isFull ? formatText(t('studio.reference.full'), { max }) : t('studio.drag.dropReferenceFile')))
    : (readyWork
      ? (isDuplicate
        ? t('studio.reference.duplicate')
        : (isFull ? formatText(t('studio.reference.full'), { max }) : t('studio.drag.readyReference')))
      : '')

  return (
    <div
      className={zoneClass}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Fieldset
        title={t('studio.reference.title')}
        hint={t('studio.reference.optional')}
        action={<span className="ofs-fieldset-readout">{`${items.length} / ${max}`}</span>}
      >
        {/* 空槽时两个入口铺满整行（这就是这一节的全部内容）；挂了图之后收回 96px，与缩略图对齐成一条槽位带。 */}
        <div
          className={items.length === 0 ? 'ofs-ref-strip is-empty' : 'ofs-ref-strip'}
          role="group"
          aria-label={t('studio.reference.title')}
        >
          {items.map((item) => (
            <div className="ofs-ref-cell" key={item.path}>
              <img
                className="ofs-ref-thumb"
                src={item.url}
                alt={item.name || t('studio.reference.title')}
                title={item.name || item.path}
                loading="lazy"
                draggable={false}
              />
              {/* 移除是这一格唯一的破坏性动作：视觉 22px，热区向四周扩到 44px（SPEC §5.21）。 */}
              <button
                type="button"
                className="ofs-ref-remove"
                title={t('studio.reference.remove')}
                aria-label={t('studio.reference.remove')}
                onClick={() => actions && typeof actions.removeReference === 'function' && actions.removeReference(item.path)}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}

          {/* 两个入口与缩略图同尺寸：横排一格，比两行文字更直接说明「从哪加」。 */}
          {canAdd ? (
            <>
              <button
                type="button"
                className="ofs-ref-entry"
                title={items.length === 0
                  ? formatText(t('studio.reference.empty'), { count: max })
                  : formatText(t('studio.reference.addMore'), { count: items.length, max })}
                onClick={openPicker}
                disabled={busy}
              >
                <Icon name="plus" size={18} />
                <span>{t('studio.import.choose')}</span>
              </button>
              <button
                type="button"
                className="ofs-ref-entry"
                aria-expanded={picking}
                onClick={() => setPicking((open) => !open)}
              >
                <Icon name="images" size={18} />
                <span>{picking ? t('studio.reference.pickClose') : t('studio.reference.pickWork')}</span>
              </button>
            </>
          ) : null}
        </div>

        {/* 满额：入口收起，用一句话说明为什么加不了（SPEC §5.21 §3）。 */}
        {canAdd ? null : (
          <p className="ofs-hint is-left ofs-ref-full">{formatText(t('studio.reference.full'), { max })}</p>
        )}

        {dropHintText ? (
          <p className={`ofs-ref-drop-hint${dragging ? ' is-active' : ''}${dropBlocked ? ' is-blocked' : ''}`} role="status">
            <Icon name={dropBlocked ? 'alert' : 'images'} size={13} />
            <span>{dropHintText}</span>
          </p>
        ) : null}

        {/* 从作品选择：复用已加载的历史分页（最多列 8 张），点一张即入槽，不新造页面。 */}
        {picking && canAdd ? (
          <Drawer animate={animateOpen}>
            {pickable.length > 0 ? (
              <div className="ofs-ref-works" aria-label={t('studio.reference.pickWork')}>
                {pickable.map((entry) => (
                  <button
                    type="button"
                    key={entry.image.path}
                    className="ofs-ref-work"
                    title={entry.item && entry.item.prompt ? entry.item.prompt : entry.image.path}
                    onClick={() => {
                      if (actions && typeof actions.addReference === 'function') actions.addReference(entry)
                      setPicking(false)
                    }}
                  >
                    <img src={entry.image.url} alt={entry.item && entry.item.prompt ? entry.item.prompt : entry.image.path} loading="lazy" draggable={false} />
                  </button>
                ))}
              </div>
            ) : (
              <p className="ofs-hint is-left">{t('studio.reference.pickEmpty')}</p>
            )}
          </Drawer>
        ) : null}

        {/* 支持参考的模型不再常驻解释「弱条件」：槽位本身就是说明，多一段灰字只是噪音。
            能力不匹配时才给降级引导（SPEC §5.21 §5）。 */}
        {referenceSupported ? null : (
          <div className="ofs-ref-warn" role="status">
            <p className="ofs-ref-warn-title">{t('studio.reference.unsupported')}</p>
            <p className="ofs-hint is-left">{t('studio.reference.unsupportedHint')}</p>
            <div className="ofs-ref-warn-actions">
              {referenceSwitchLabel && actions && typeof actions.switchToReferencePreset === 'function' ? (
                <button type="button" className="ofs-ref-switch" onClick={() => actions.switchToReferencePreset()}>
                  {formatText(t('studio.reference.switchPreset'), { preset: referenceSwitchLabel })}
                </button>
              ) : null}
              {actions && typeof actions.referenceToImg2img === 'function' ? (
                <button type="button" className="ofs-ref-fallback" onClick={() => actions.referenceToImg2img()}>
                  {t('studio.reference.useImg2img')}
                </button>
              ) : null}
            </div>
          </div>
        )}

        {busy ? (
          <p className="ofs-hint is-left ofs-ref-busy" role="status">
            <span className="ofs-shimmer" aria-hidden="true" />
            {t('studio.reference.uploading')}
          </p>
        ) : null}

        <input
          ref={inputRef}
          className="ofs-ref-input"
          type="file"
          accept={ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          hidden
          onChange={onFileChange}
        />
      </Fieldset>
    </div>
  )
}
