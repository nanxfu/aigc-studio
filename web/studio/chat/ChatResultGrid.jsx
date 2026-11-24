/**
 * 创作助手结果图网格与内联单图快捷操作面板（A3：不替换整个聊天流）。
 *
 * - 点击结果网格中任意一张图：右侧大舞台立即切到该图，同时该网格项高亮，
 *   并在网格正下方展开紧凑快捷操作条（选这张做变体 / 继续涂抹 / 对比原图 / 重新生成 / 查看大图）；
 * - 聊天上下文全程保留，用户不必反复进出子页面；
 * - 若外部聚焦栈指向某张未出现在当前消息流里的图，仍通过顶部轻量聚焦条提供相同动作与返回。
 */

import React from 'react'

import { gridImagesOf, gridLabelOf, imageMetaOf } from '../../logic/chat.js'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'

/** 线程图片：加载失败时降级为安全占位，避免浏览器裂图图标。 */
export function ThreadImage(props) {
  const { src, alt, className, title, mediaType, controls = false, onReady, onDead } = props
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => {
    setBroken(false)
  }, [src])

  if (!src || broken) {
    return (
      <span className="ofs-chat-img-missing" role="img" aria-label={title || alt || ''}>
        <Icon name="image" size={18} />
      </span>
    )
  }
  if (mediaType === 'video') {
    return (
      <video
        src={controls ? src : `${src}#t=0.1`}
        className={className}
        muted={!controls}
        controls={controls}
        autoPlay={controls}
        loop={controls}
        playsInline
        preload="metadata"
        aria-label={title || alt || ''}
        onLoadedData={() => typeof onReady === 'function' && onReady(true)}
        onError={() => {
          setBroken(true)
          if (typeof onDead === 'function') onDead()
        }}
      />
    )
  }
  return (
    <img
      src={src}
      alt={alt || ''}
      title={title || undefined}
      className={className}
      loading="lazy"
      draggable={false}
      onLoad={() => typeof onReady === 'function' && onReady(true)}
      onError={() => {
        setBroken(true)
        if (typeof onDead === 'function') onDead()
      }}
    />
  )
}

/** 单图快捷动作面板：内联展开在结果网格下方，或挂在独立聚焦顶部条。 */
export function FocusActionBar(props) {
  const {
    t,
    focus,
    entry,
    locked,
    interpreting,
    onCompare,
    onContinue,
    onRegenerate,
    onVariant,
    onZoom,
    onClose,
    backLabel,
    onBack,
  } = props

  if (!focus) return null
  const image = entry && entry.image ? entry.image : focus
  const mediaType = image.mediaType === 'video' || focus.mediaType === 'video' ? 'video' : 'image'
  const meta = imageMetaOf(t, { seconds: focus.seconds, seed: focus.seed, duration: focus.duration, mediaType })
  const canCompare = Boolean(entry && entry.item && entry.item.sourceImage)
  const indexLabel = focus.count > 1 ? `#${(focus.index ?? 0) + 1}` : ''

  return (
    <div className="ofs-chat-focus-inline" role="region" aria-label={t('studio.chat.focus.title')}>
      <div className="ofs-chat-focus-inline-head">
        {typeof onBack === 'function' ? (
          <button type="button" className="ofs-chat-back-inline" onClick={onBack}>
            {`← ${backLabel ? formatText(t('studio.chat.focus.back'), { label: backLabel }) : t('studio.chat.focus.empty')}`}
          </button>
        ) : (
          <span className="ofs-chat-focus-title">
            {indexLabel ? `${t('studio.chat.focus.selected')} ${indexLabel}` : t('studio.chat.focus.selected')}
          </span>
        )}
        {meta ? <span className="ofs-chat-focus-meta-text">{meta}</span> : null}
        <span className="ofs-grow" />
        {typeof onClose === 'function' ? (
          <button
            type="button"
            className="ofs-chat-focus-close"
            onClick={onClose}
            aria-label={t('studio.chat.focus.close')}
            title={t('studio.chat.focus.close')}
          >
            <Icon name="close" size={11} />
          </button>
        ) : null}
      </div>

      <div className="ofs-chat-focus-actions">
        <button
          type="button"
          className="ofs-chip ofs-chat-focus-action is-variant"
          onClick={onVariant}
          disabled={locked || interpreting}
          title={t('studio.chat.explore.variantHint')}
        >
          <Icon name="sparkles" size={11} />
          <span>{t('studio.chat.explore.variant')}</span>
        </button>
        {mediaType === 'video' ? null : (
          <button type="button" className="ofs-chip ofs-chat-focus-action" onClick={() => onContinue(entry)}>
            <Icon name="brush" size={11} />
            <span>{t('studio.chat.actions.continueInpaint')}</span>
          </button>
        )}
        {canCompare ? (
          <button type="button" className="ofs-chip ofs-chat-focus-action" onClick={() => onCompare(entry)}>
            <Icon name="compare" size={11} />
            <span>{t('studio.chat.actions.compare')}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="ofs-chip ofs-chat-focus-action"
          onClick={() => onRegenerate(entry)}
          disabled={locked}
        >
          <Icon name="reroll" size={11} />
          <span>{t('studio.chat.actions.regenerate')}</span>
        </button>
        <button type="button" className="ofs-chip ofs-chat-focus-action" onClick={onZoom}>
          <Icon name="expand" size={11} />
          <span>{t('studio.chat.actions.zoom')}</span>
        </button>
      </div>
    </div>
  )
}

/** 完成气泡的 1~4 格缩略图网格 + 对应的内联单图快捷操作面板。 */
export function ChatResultGrid(props) {
  const {
    t,
    message,
    compare,
    onToggleCompare,
    focus,
    focusEntry,
    locked,
    interpreting,
    onOpenImage,
    onMarkBroken,
    onCompare,
    onContinue,
    onRegenerate,
    onVariant,
    onZoom,
    onCloseFocus,
  } = props

  const images = gridImagesOf(message)
  if (images.length === 0) return null
  const single = images.length === 1
  const focusedHere = Boolean(
    focus
    && ((focus.messageId !== null && focus.messageId !== undefined && focus.messageId === message.id)
      || images.some((item) => item.path && focus.path && item.path === focus.path)),
  )

  return (
    <div className="ofs-msg-grid-wrap">
      <div
        className={`ofs-msg-grid${single ? ' is-single' : ''}${!single && compare ? ' is-compare' : ''}`}
        role="group"
        aria-label={gridLabelOf(t, images.length)}
      >
        {images.map((image, index) => {
          const active = Boolean(focus && image.path && focus.path === image.path)
          return (
            <button
              type="button"
              key={image.path || image.url || index}
              className={active ? 'ofs-msg-grid-item is-active' : 'ofs-msg-grid-item'}
              aria-pressed={active}
              onClick={() => onOpenImage(message, image, index)}
              title={imageMetaOf(t, image) || undefined}
            >
              <ThreadImage
                src={image.url}
                className=""
                alt=""
                mediaType={image.mediaType}
                onDead={() => onMarkBroken(image.path)}
              />
              {single ? null : <span className="ofs-msg-grid-index" aria-hidden="true">{index + 1}</span>}
            </button>
          )
        })}
        {single ? null : (
          <div className="ofs-msg-grid-tools">
            <span className="ofs-msg-grid-label">{gridLabelOf(t, images.length)}</span>
            <button
              type="button"
              className={`ofs-chip ofs-msg-grid-compare${compare ? ' is-on' : ''}`}
              onClick={() => onToggleCompare(message.id)}
            >
              {compare ? t('studio.chat.explore.grid') : t('studio.chat.explore.compare')}
            </button>
          </div>
        )}
      </div>

      {focusedHere ? (
        <FocusActionBar
          t={t}
          focus={focus}
          entry={focusEntry}
          locked={locked}
          interpreting={interpreting}
          onCompare={onCompare}
          onContinue={onContinue}
          onRegenerate={onRegenerate}
          onVariant={onVariant}
          onZoom={onZoom}
          onClose={onCloseFocus}
        />
      ) : null}
    </div>
  )
}
