/**
 * 助手输入区上方的共用参考图条（M2.7）。
 *
 * 与左栏表单共用 `form.form.references`（单轨面板双形态同源）：在这里挂的图，
 * 切回表单能看到；表单挂的图，助手也看得见并会随本轮请求以 `references` 上报给 Agent。
 * 角色标注「作为参考生新图」用于和右侧「舞台当前图」区分——两者可以同时存在。
 *
 * 入口：+ 本地选图（经 `POST /api/import` 落盘后入槽）、从作品选择（复用已加载画廊）、
 * 拖拽到本区域或输入区（由 ChatPanel 统一接住拖放）。槽位非空时缩略图带 × 可直接摘除。
 *
 * 锁定态（M2.6 导入图焦点隔离）由外层 `inert` 一并禁用，本组件不再重复判断。
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
const ACCEPT = 'image/png,image/jpeg'

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
  } = props
  const items = referenceListOf(references)
  const max = Number(referenceMax) > 0 ? Number(referenceMax) : referenceMaxCount()
  const canAdd = items.length < max
  const [picking, setPicking] = React.useState(false)
  const animateOpen = useAnimateOpen()
  const inputRef = React.useRef(null)
  const addedPaths = new Set(items.map((item) => item.path))
  const pickable = (Array.isArray(works) ? works : [])
    .filter((entry) => entry && entry.image && entry.image.path && !addedPaths.has(entry.image.path))
    .slice(0, PICK_LIMIT)
  const canSwitch = Boolean(referenceSwitchLabel && actions && typeof actions.switchToReferencePreset === 'function')

  function openPicker() {
    if (!canAdd) return
    const input = inputRef.current
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

  // 空槽且一个入口都不给时，仍保留一个轻量「+ 参考图」：助手页不因当前模型不支持参考就把入口藏掉，
  // 用户挂图后可以再按提示切换到支持参考的模型。
  return (
    <div className={items.length === 0 ? 'ofs-chat-refs is-empty' : 'ofs-chat-refs'}>
      <div className="ofs-chat-refs-head">
        <Icon name="images" size={12} />
        <span className="ofs-chat-refs-title">{t('studio.chat.ref.title')}</span>
        <Tooltip text={t('studio.chat.ref.tooltip')} />
        {items.length > 0 ? <span className="ofs-chat-refs-role">{t('studio.chat.ref.role')}</span> : null}
        <span className="ofs-grow" />
        {items.length > 0 ? <span className="ofs-chat-refs-count">{`${items.length} / ${max}`}</span> : null}
      </div>

      <div className="ofs-chat-refs-strip" role="group" aria-label={t('studio.chat.ref.title')}>
        {items.map((item) => (
          <div className="ofs-chat-ref" key={item.path}>
            <img
              className="ofs-chat-ref-thumb"
              src={item.url}
              alt={item.name || t('studio.chat.ref.title')}
              title={item.name || item.path}
              loading="lazy"
              draggable={false}
            />
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
        ))}

        {canAdd ? (
          <>
            <button
              type="button"
              className="ofs-chat-ref-entry"
              title={t('studio.chat.ref.addFile')}
              onClick={openPicker}
              disabled={busy}
            >
              <Icon name="plus" size={13} />
              <span>{t('studio.chat.ref.addFile')}</span>
            </button>
            <button
              type="button"
              className="ofs-chat-ref-entry"
              aria-expanded={picking}
              onClick={() => setPicking((open) => !open)}
            >
              <Icon name="images" size={13} />
              <span>{t('studio.chat.ref.pickWork')}</span>
            </button>
          </>
        ) : (
          <span className="ofs-chat-refs-full">{formatText(t('studio.reference.full'), { max })}</span>
        )}
      </div>

      {/* 当前模型接不了参考图：明确提示 + 一键切到支持参考的模型（参考图不丢）。 */}
      {referenceSupported === false && items.length > 0 ? (
        <div className="ofs-chat-refs-warn" role="status">
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

      <Drawer open={picking && canAdd} animate={animateOpen} className="ofs-chat-refs-drawer">
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
                  setPicking(false)
                }}
              >
                <img
                  src={entry.image.url}
                  alt={entry.item && entry.item.prompt ? entry.item.prompt : entry.image.path}
                  loading="lazy"
                  draggable={false}
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="ofs-hint is-left">{t('studio.reference.pickEmpty')}</p>
        )}
      </Drawer>

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
    </div>
  )
}
