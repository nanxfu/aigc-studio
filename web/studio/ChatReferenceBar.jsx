/**
 * 助手输入卡内的共用参考图托盘（M2.7 · 一体化输入坞版）。
 *
 * 与左栏表单共用 `form.form.references`（单轨面板双形态同源）：
 *  - 未挂图且未展开选择器 / 未拖拽时，托盘自身折叠为 0 高度，入口收纳在输入卡底栏工具区
 *    （`onOpenFile` / `picking` 由父级或本组件联动），为消息流省出近 100px 视口空间；
 *  - 挂图、拖拽悬停、上传中或展开「从作品选择」时，平滑展开紧凑缩略图托盘与作品网格；
 *  - 仍保留角色标注「作为参考生新图」、单张移除、一键清空、视频过滤与切模型引导。
 */

import React from 'react'

import { Tooltip } from '../components/Tooltip.jsx'
import { formatText } from '../logic/format.js'
import { referenceListOf, referenceMaxCount } from '../logic/reference.js'
import { Icon } from './icons.jsx'
import { Drawer, useAnimateOpen } from './rail/Drawer.jsx'

/** 从作品选择一次最多列几张：复用已加载的历史分页，不新造页面。 */
const PICK_LIMIT = 8

/** 与契约 `IMPORT.mimeTypes` 对应的 accept 串（真正的格式校验在逻辑层）。 */
export const CHAT_REF_ACCEPT = 'image/png,image/jpeg'

export function ChatReferenceBar(props) {
  const {
    t,
    references,
    referenceMax,
    works,
    busy,
    referenceSupported,
    referenceSwitchLabel,
    actions,
    picking = false,
    setPicking,
    dragKind = '',
    onOpenFile,
  } = props
  const items = referenceListOf(references)
  const max = Number(referenceMax) > 0 ? Number(referenceMax) : referenceMaxCount()
  const canAdd = items.length < max
  const animateOpen = useAnimateOpen()
  const addedPaths = new Set(items.map((item) => item.path))
  const pickable = (Array.isArray(works) ? works : [])
    .filter((entry) => entry && entry.image && entry.image.path && entry.image.mediaType !== 'video' && !addedPaths.has(entry.image.path))
    .slice(0, PICK_LIMIT)
  const canSwitch = Boolean(referenceSwitchLabel && actions && typeof actions.switchToReferencePreset === 'function')

  React.useEffect(() => {
    if (!canAdd && picking && typeof setPicking === 'function') setPicking(false)
  }, [canAdd, picking, setPicking])

  function clearAll() {
    if (!actions || typeof actions.removeReference !== 'function') return
    for (const item of items) actions.removeReference(item.path)
  }

  const showTray = items.length > 0 || busy || Boolean(dragKind)
  const showPicker = Boolean(picking && canAdd)

  if (!showTray && !showPicker) return null

  return (
    <div className={items.length === 0 ? 'ofs-chat-refs is-empty' : 'ofs-chat-refs'}>
      <Drawer open={showPicker} animate={animateOpen} className="ofs-chat-refs-drawer">
        <div className="ofs-chat-refs-picker">
          <div className="ofs-chat-refs-picker-head">
            <span>{t('studio.chat.ref.pickHint')}</span>
            <button
              type="button"
              className="ofs-chat-refs-picker-close"
              onClick={() => typeof setPicking === 'function' && setPicking(false)}
            >
              {t('studio.chat.ref.closePicker')}
            </button>
          </div>
          {pickable.length > 0 ? (
            <div className="ofs-chat-refs-works" aria-label={t('studio.chat.ref.pickWork')}>
              {pickable.map((entry) => (
                <button
                  type="button"
                  key={entry.image.path}
                  className="ofs-chat-refs-work"
                  title={entry.item && entry.item.prompt ? entry.item.prompt : entry.image.path}
                  onClick={() => {
                    if (actions && typeof actions.addReference === 'function') actions.addReference(entry)
                    if (items.length + 1 >= max && typeof setPicking === 'function') setPicking(false)
                  }}
                >
                  <img
                    src={entry.image.url}
                    alt={entry.item && entry.item.prompt ? entry.item.prompt : entry.image.path}
                    loading="lazy"
                    draggable={false}
                  />
                  <span className="ofs-chat-refs-work-add" aria-hidden="true">
                    <Icon name="plus" size={12} />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="ofs-hint is-left">{t('studio.reference.pickEmpty')}</p>
          )}
        </div>
      </Drawer>

      {showTray ? (
        <div className="ofs-chat-refs-tray">
          <div className="ofs-chat-refs-head">
            <Icon name="images" size={12} />
            <span className="ofs-chat-refs-title">{t('studio.chat.ref.title')}</span>
            <Tooltip text={t('studio.chat.ref.tooltip')} />
            {items.length > 0 ? <span className="ofs-chat-refs-role">{t('studio.chat.ref.role')}</span> : null}
            <span className="ofs-grow" />
            {items.length >= 2 && actions && typeof actions.removeReference === 'function' ? (
              <button type="button" className="ofs-chat-refs-clear" onClick={clearAll}>
                {t('studio.chat.ref.clear')}
              </button>
            ) : null}
            {items.length > 0 ? <span className="ofs-chat-refs-count">{`${items.length} / ${max}`}</span> : null}
          </div>

          {items.length > 0 ? (
            <div
              className="ofs-chat-refs-strip"
              role="group"
              aria-label={t('studio.chat.ref.title')}
              data-reference-count={String(items.length)}
            >
              {items.map((item, index) => {
                const flyingPath = actions && actions.referenceFly ? actions.referenceFly.path : ''
                return (
                  <div
                    className="ofs-chat-ref"
                    key={item.path}
                    data-ref-path={item.path}
                    data-ref-flying={flyingPath === item.path ? 'true' : undefined}
                  >
                    <img
                      className="ofs-chat-ref-thumb"
                      src={item.url}
                      alt={item.name || t('studio.chat.ref.title')}
                      title={item.name || item.path}
                      loading="lazy"
                      draggable={false}
                    />
                    <span className="ofs-chat-ref-index" aria-hidden="true">{index + 1}</span>
                    <button
                      type="button"
                      className="ofs-chat-ref-remove"
                      title={t('studio.reference.remove')}
                      aria-label={t('studio.reference.remove')}
                      onClick={() => actions && typeof actions.removeReference === 'function' && actions.removeReference(item.path)}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </div>
                )
              })}

              {canAdd && typeof onOpenFile === 'function' ? (
                <button
                  type="button"
                  className="ofs-chat-ref-add-tile"
                  title={t('studio.chat.ref.addFile')}
                  aria-label={t('studio.chat.ref.addFile')}
                  onClick={onOpenFile}
                  disabled={busy}
                >
                  <Icon name="plus" size={14} />
                </button>
              ) : null}
              {!canAdd ? (
                <span className="ofs-chat-refs-full">{formatText(t('studio.reference.full'), { max })}</span>
              ) : null}
            </div>
          ) : null}

          {dragKind ? (
            <p className="ofs-chat-refs-drop" role="status">
              <Icon name={dragKind === 'work' ? 'images' : 'plus'} size={12} />
              <span>{dragKind === 'work' ? t('studio.drag.dropReferenceWork') : t('studio.drag.dropReferenceFile')}</span>
            </p>
          ) : null}

          {/* 当前模型接不了参考图：中性浅灰底 + 琥珀状态圆点 + 一键切模型，契合黑白灰工作室。 */}
          {referenceSupported === false && items.length > 0 ? (
            <div className="ofs-chat-refs-warn" role="status">
              <span className="ofs-dot is-warn ofs-chat-refs-warn-dot" aria-hidden="true" />
              <span className="ofs-grow">{t('studio.chat.ref.unsupported')}</span>
              {canSwitch ? (
                <button
                  type="button"
                  className="ofs-chat-refs-switch"
                  onClick={() => actions.switchToReferencePreset()}
                >
                  {formatText(t('studio.reference.switchPreset'), { preset: referenceSwitchLabel })}
                </button>
              ) : null}
            </div>
          ) : null}

          {busy ? (
            <p className="ofs-chat-refs-busy" role="status">
              <span className="ofs-shimmer" aria-hidden="true" />
              {t('studio.reference.uploading')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
