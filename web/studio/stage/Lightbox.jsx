import React from 'react'

import { Icon } from '../icons.jsx'
import { useFocusTrap } from '../hooks/useFocusTrap.js'
import { imageRect, motionAllowed } from '../workMotion.js'

const MAX_SCALE = 8
const ZOOM_STEP = 1.25
const FIT = { scale: 1, x: 0, y: 0 }

/** 全窗口预览：以适应窗口为缩放基准，放大后在图像边界内平移。 */
export function Lightbox({ t, image, alt, exiting, onClose, onReference, returnFocusRef, originRef }) {
  const panelRef = React.useRef(null)
  const closeRef = React.useRef(null)
  const viewportRef = React.useRef(null)
  const imageRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const motionRef = React.useRef(null)
  const openedImageRef = React.useRef('')
  const [view, setView] = React.useState(FIT)
  const viewRef = React.useRef(view)
  const [dragging, setDragging] = React.useState(false)
  const isVideo = image.mediaType === 'video'

  function constrain(next) {
    const viewport = viewportRef.current
    const img = imageRef.current
    if (!viewport || !img) return next
    const maxX = Math.max(0, (img.offsetWidth * next.scale - viewport.clientWidth) / 2)
    const maxY = Math.max(0, (img.offsetHeight * next.scale - viewport.clientHeight) / 2)
    return { scale: next.scale, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) }
  }

  function update(next) {
    viewRef.current = next
    setView(next)
  }

  function zoomTo(scale, point) {
    motionRef.current?.cancel()
    panelRef.current?.removeAttribute('data-morphing')
    const prev = viewRef.current
    const nextScale = Math.max(1, Math.min(MAX_SCALE, scale))
    if (nextScale === 1) { update(FIT); return }
    const ratio = nextScale / prev.scale
    const anchor = point || { x: 0, y: 0 }
    update(constrain({ scale: nextScale, x: anchor.x - (anchor.x - prev.x) * ratio, y: anchor.y - (anchor.y - prev.y) * ratio }))
  }

  function pointOf(event) {
    const rect = viewportRef.current.getBoundingClientRect()
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
  }

  // Native dialog 的顶层不受舞台裁切、变换或外壳层叠影响。
  React.useEffect(() => {
    const panel = panelRef.current
    if (panel && typeof panel.showModal === 'function' && !panel.open) panel.showModal()
  }, [])

  function morphImage(closing = false) {
    const node = imageRef.current
    const panel = panelRef.current
    if (!node || !panel || !node.complete || !motionAllowed() || typeof node.animate !== 'function') return
    if (!closing && openedImageRef.current) return
    const from = closing ? imageRect(node) : originRef?.current?.rect
    motionRef.current?.cancel()
    const viewport = imageRect(viewportRef.current)
    const fitted = viewport && node.offsetWidth && node.offsetHeight ? {
      left: viewport.left + (viewport.width - node.offsetWidth) / 2,
      top: viewport.top + (viewport.height - node.offsetHeight) / 2,
      width: node.offsetWidth, height: node.offsetHeight,
    } : null
    const to = closing ? (imageRect(originRef?.current?.element) || originRef?.current?.rect) : fitted
    if (!from || !to || !fitted) return
    const transformOf = (rect) => `translate3d(${rect.left + rect.width / 2 - fitted.left - fitted.width / 2}px, ${rect.top + rect.height / 2 - fitted.top - fitted.height / 2}px, 0) scale(${rect.width / fitted.width}, ${rect.height / fitted.height})`
    panel.setAttribute('data-morphing', 'true')
    openedImageRef.current = image.url
    const animation = node.animate([
      { transform: transformOf(from), borderRadius: closing ? '12px' : '3px' },
      { transform: closing ? transformOf(to) : 'translate3d(0, 0, 0) scale(1)', borderRadius: closing ? '3px' : '12px' },
    ], { duration: closing ? 210 : 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: closing ? 'forwards' : 'none' })
    motionRef.current = animation
    animation.onfinish = animation.oncancel = () => {
      if (motionRef.current !== animation) return
      panel.removeAttribute('data-morphing')
      motionRef.current = null
    }
  }

  React.useEffect(() => {
    morphImage(exiting)
  }, [exiting, image.url])
  React.useEffect(() => () => motionRef.current?.cancel(), [])
  // 退场结束、dialog 移除后再归还焦点；退场中背景仍处于 inert 状态。
  useFocusTrap({ panelRef, initialFocusRef: closeRef, returnFocusRef, onClose: () => { if (!exiting) onClose() } })

  React.useEffect(() => {
    update(FIT)
    dragRef.current = null
    setDragging(false)
  }, [image.url])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || isVideo || exiting) return undefined
    function onWheel(event) {
      if (!event.deltaY) return
      event.preventDefault()
      zoomTo(viewRef.current.scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), pointOf(event))
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => update(constrain(viewRef.current)))
      : null
    if (observer) observer.observe(viewport)
    return () => {
      viewport.removeEventListener('wheel', onWheel)
      if (observer) observer.disconnect()
    }
  }, [isVideo, exiting, image.url])

  function endDrag(event) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <dialog
      ref={panelRef}
      className="ofs-lightbox"
      data-exiting={exiting ? 'true' : undefined}
      data-zoomed={view.scale > 1 ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={t('studio.stage.zoom')}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (!exiting && event.target === event.currentTarget) onClose() }}
    >
      <div
        ref={viewportRef}
        className="ofs-lightbox-viewport"
        onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      >
        {isVideo ? (
          <video className="ofs-lightbox-video" src={image.url} controls autoPlay loop playsInline />
        ) : (
          <img
            ref={imageRef}
            src={image.url}
            alt={alt}
            draggable={false}
            style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
            onLoad={() => { update(constrain(viewRef.current)); morphImage() }}
            onDoubleClick={(event) => zoomTo(viewRef.current.scale > 1 ? 1 : 2, pointOf(event))}
            onPointerDown={(event) => {
              if (viewRef.current.scale <= 1 || event.button !== 0 || dragRef.current) return
              event.preventDefault()
              motionRef.current?.cancel()
              dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view: viewRef.current }
              event.currentTarget.setPointerCapture(event.pointerId)
              setDragging(true)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.pointerId !== event.pointerId) return
              update(constrain({ scale: drag.view.scale, x: drag.view.x + event.clientX - drag.x, y: drag.view.y + event.clientY - drag.y }))
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={() => { dragRef.current = null; setDragging(false) }}
          />
        )}
      </div>
      {isVideo ? null : (
        <div className="ofs-lightbox-controls" role="group" aria-label={t('studio.stage.previewControls')}>
          <button type="button" onClick={() => zoomTo(viewRef.current.scale / ZOOM_STEP)} disabled={view.scale <= 1} aria-label={t('studio.stage.zoomOut')} title={t('studio.stage.zoomOut')}>−</button>
          <span className="ofs-lightbox-scale">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={() => zoomTo(viewRef.current.scale * ZOOM_STEP)} disabled={view.scale >= MAX_SCALE} aria-label={t('studio.stage.zoomIn')} title={t('studio.stage.zoomIn')}><Icon name="plus" size={15} /></button>
          <button type="button" className="ofs-lightbox-fit" onClick={() => update(FIT)} title={t('studio.stage.fit')}>{t('studio.stage.fit')}</button>
        </div>
      )}
      <button ref={closeRef} type="button" className="ofs-lightbox-close" onClick={onClose} aria-label={t('studio.stage.close')}><Icon name="close" size={16} /></button>
      {isVideo ? null : (
        <>
          <span className="ofs-lightbox-hint">{t('studio.stage.previewHint')}</span>
          <button type="button" className="ofs-lightbox-action" onClick={onReference}><Icon name="image" size={15} />{t('studio.action.reference')}</button>
        </>
      )}
    </dialog>
  )
}
