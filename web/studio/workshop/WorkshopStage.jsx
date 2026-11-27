/**
 * 工坊预览画布：静态预览（原图 / 工具结果 / 通道 / SVG / 2×2 平铺）与序列帧动画播放。
 *
 * 所有 canvas / Image / requestAnimationFrame 操作都在 useEffect 内，并对环境做判空：
 * Node 渲染测试里没有真实 canvas 时组件照常挂载、结构照常渲染，只是不绘制。
 */

import React from 'react'

import {
  canUseCanvas,
  context2d,
  drawImage,
  loadImage,
} from './pixels.js'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'
import { CompareSlider } from '../stage/CompareSlider.jsx'
import { useSwapMotion } from '../hooks/useSwapMotion.js'
import { animateWorkArrival, takeWorkMotion } from '../workMotion.js'

/** 预览画布的长边上限：大图按比例缩到可交互尺寸，避免上屏几千万像素。 */
const MAX_PREVIEW_EDGE = 1600

/** 取图片自然尺寸；加载失败 / 环境不支持时为 0。 */
function naturalSizeOf(image) {
  return {
    width: Number(image && (image.naturalWidth || image.width)) || 0,
    height: Number(image && (image.naturalHeight || image.height)) || 0,
  }
}

export function WorkshopStage(props) {
  const {
    t,
    tool,
    preview,
    repeat,
    playing,
    canPlay,
    onTogglePlay,
    channelList,
    activeChannel,
    onChannel,
    tilePreview,
    canTile,
    onToggleTilePreview,
    cell,
    rows,
    cols,
    spriteFrames,
    frameMs,
    sourceWidth,
    sourceHeight,
    sourceUrl,
    sourcePath,
    svgStats,
    canCompareSvg,
    compareSvg,
    onToggleCompareSvg,
    onCopySvg,
    previewRatio,
    spatialInteraction,
    canCompareSpatial,
    compareSpatial,
    onToggleCompareSpatial,
    canShowDepth,
    showDepthPreview,
    onToggleDepthPreview,
    // 画面下方操作区左侧的接力节点（`Workshop` 决定是否出现、出现哪一个）。
    handoff,
    // 画面上方的轻提示（例如「完整画作可回创作台精修」），由宿主决定是否渲染。
    notice,
  } = props
  const canvasRef = React.useRef(null)
  // 动画需要反复从同一张源图裁帧：加载一次存进 ref，避免每帧 new Image。
  const sourceImageRef = React.useRef(null)
  const spatialPointerRef = React.useRef(false)
  const spatialLayerRef = React.useRef(null)
  const pointerFrameRef = React.useRef(null)
  const pendingPointRef = React.useRef(null)
  const pointerCallbackRef = React.useRef(null)
  pointerCallbackRef.current = spatialInteraction?.onPointer
  const [jsonText, setJsonText] = React.useState('')
  const [canvasDims, setCanvasDims] = React.useState(null)
  const animateSwap = useSwapMotion()
  // 调参重绘保持即时；只在换作品、通道或平铺视图时确认画面已经切换。
  const previewContext = `${sourceUrl || ''}:${activeChannel || ''}:${Number(repeat) || 1}:${showDepthPreview ? 'depth' : 'main'}`
  const paintedContextRef = React.useRef(null)
  React.useEffect(() => () => {
    if (pointerFrameRef.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pointerFrameRef.current)
  }, [])
  React.useEffect(() => {
    spatialPointerRef.current = false
    pendingPointRef.current = null
    spatialLayerRef.current?.removeAttribute('data-interacting')
    if (pointerFrameRef.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pointerFrameRef.current)
    pointerFrameRef.current = null
  }, [sourceUrl, tool, spatialInteraction?.mode])

  // 静态预览：原图 / 工具结果 / 通道图 / 平铺 / GPU 离屏画布直绘。
  React.useEffect(() => {
    if (!canUseCanvas() || !preview || preview.type === 'empty') return undefined
    if (preview.type === 'svg' || preview.type === 'json') return undefined
    const canvas = canvasRef.current
    if (!canvas || playing) return undefined
    let alive = true
    const changed = paintedContextRef.current !== previewContext
    let cleared = false
    // 切换不同画幅的作品时先清掉旧画布位图，避免新画幅容器框套着旧图像素短暂拉伸。
    if (changed && paintedContextRef.current && canvas.width > 1 && canvas.height > 1) {
      const targetRatio = Number(previewRatio) > 0 ? Number(previewRatio) : 1
      const currentRatio = canvas.width / canvas.height
      if (Math.abs(currentRatio - targetRatio) > 0.01) {
        context2d(canvas)?.clearRect(0, 0, canvas.width, canvas.height)
        cleared = true
      }
    }
    const paintSource = (image) => {
      if (!alive || !image) return
      const size = naturalSizeOf(image)
      if (!size.width || !size.height) return
      const tileRepeat = Math.max(1, Math.floor(Number(repeat) || 1))
      const ratio = Math.min(1, (MAX_PREVIEW_EDGE / tileRepeat) / Math.max(size.width, size.height))
      const tileW = Math.max(1, Math.round(size.width * ratio))
      const tileH = Math.max(1, Math.round(size.height * ratio))
      const nextW = tileW * tileRepeat
      const nextH = tileH * tileRepeat
      let previousFrame = null
      // 同画幅通道切换保留旧像素叠化；调参不复制画布，也不延迟绘制。
      if (changed && !cleared && paintedContextRef.current && canvas.width === nextW && canvas.height === nextH) {
        previousFrame = canvas.cloneNode(false)
        previousFrame.className = 'ofs-workshop-canvas-previous'
        previousFrame.setAttribute('aria-hidden', 'true')
        previousFrame.removeAttribute('aria-label')
        context2d(previousFrame)?.drawImage(canvas, 0, 0)
      }
      const smoothing = !['pixel-snap', 'sprite-slice'].includes(tool)
      if (drawImage(canvas, image, { width: tileW, height: tileH, repeat: tileRepeat, smoothing })) {
        setCanvasDims((prev) => (
          prev && prev.context === previewContext && prev.width === nextW && prev.height === nextH
            ? prev
            : { context: previewContext, width: nextW, height: nextH }
        ))
        if (changed) {
          const from = takeWorkMotion(sourcePath)
          if (from) animateWorkArrival(canvas.parentElement, from)
          else animateSwap(canvas.parentElement, previousFrame)
        }
        paintedContextRef.current = previewContext
      }
    }
    if (preview.type === 'canvas' && preview.canvas) {
      paintSource(preview.canvas)
    } else if (preview.url) {
      loadImage(preview.url).then(paintSource)
    }
    return () => {
      alive = false
    }
  }, [preview && preview.url, preview && preview.canvas, preview && preview.frame, preview && preview.type, repeat, playing, previewContext, previewRatio, sourcePath, tool, animateSwap])

  // JSON 通道预览（如 atlas.json）：按 URL 拉取格式化展示，不进 <canvas>。
  React.useEffect(() => {
    if (!preview || preview.type !== 'json' || !preview.url || typeof fetch !== 'function') {
      setJsonText('')
      return undefined
    }
    let alive = true
    fetch(preview.url)
      .then((res) => (res.ok ? res.text() : ''))
      .then((raw) => {
        if (!alive) return
        try {
          setJsonText(JSON.stringify(JSON.parse(raw), null, 2))
        } catch {
          setJsonText(raw || '')
        }
      })
      .catch(() => {
        if (alive) setJsonText('')
      })
    return () => {
      alive = false
    }
  }, [preview && preview.type, preview && preview.url])

  // 源图预加载：动画播放从这张图按 atlas frames 裁帧。
  React.useEffect(() => {
    if (!canUseCanvas() || !sourceUrl) return undefined
    let alive = true
    loadImage(sourceUrl).then((image) => {
      if (alive) sourceImageRef.current = image
    })
    return () => {
      alive = false
    }
  }, [sourceUrl])

  // 序列帧动画：requestAnimationFrame 轮播切片帧；离开播放态 / 卸载时取消。
  React.useEffect(() => {
    if (!playing || tool !== 'sprite-slice' || !canUseCanvas()) return undefined
    const frames = spriteFrames && Array.isArray(spriteFrames.frames) ? spriteFrames.frames : []
    if (frames.length === 0) return undefined
    const canvas = canvasRef.current
    const context = context2d(canvas)
    if (!context || typeof requestAnimationFrame !== 'function') return undefined

    let rafId = 0
    let alive = true
    let index = 0
    let last = 0
    const interval = Math.max(20, Math.floor(Number(frameMs) || 120))
    const first = frames[0]
    canvas.width = Math.max(1, first.w)
    canvas.height = Math.max(1, first.h)

    function tick(timestamp) {
      if (!alive) return
      const image = sourceImageRef.current
      if (!document.hidden && image && (!last || timestamp - last >= interval)) {
        last = timestamp
        const frame = frames[index % frames.length]
        index += 1
        try {
          context.clearRect(0, 0, canvas.width, canvas.height)
          context.imageSmoothingEnabled = false
          context.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h)
        } catch {
          // 单帧绘制失败不打断动画循环（例如源图尚未解码完成）。
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      alive = false
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
    }
  }, [playing, tool, spriteFrames, frameMs])

  const showGrid = (tool === 'pixel-snap' || (tool === 'sprite-slice' && !playing)) && preview?.type !== 'json'
  const showChannels = Array.isArray(channelList) && channelList.length > 1
  const showCompare = Boolean(compareSvg && canCompareSvg && sourceUrl && preview && preview.type === 'svg')
  const hideCanvas = Boolean(showCompare || (preview && (preview.type === 'svg' || preview.type === 'json' || preview.type === 'empty')))
  const showTileCrosshair = tool === 'tile' && Number(repeat) > 1 && !hideCanvas
  const activeDims = canvasDims && canvasDims.context === previewContext ? canvasDims : null
  const boxRatio = activeDims && activeDims.height > 0
    ? activeDims.width / activeDims.height
    : (Number(previewRatio) > 0 ? Number(previewRatio) : 1)
  const cellPx = Math.max(1, Number(cell) || 1)
  const pixelCols = Number(sourceWidth) > 0 ? Number(sourceWidth) / cellPx : 0
  const pixelRows = Number(sourceHeight) > 0 ? Number(sourceHeight) / cellPx : 0
  const gridMode = tool === 'sprite-slice'
    ? 'sprite'
    : (pixelCols > 0 && pixelRows > 0 ? 'pixel-ratio' : 'pixel')
  const gridStyle = tool === 'sprite-slice'
    ? {
        '--ofs-sprite-rows': String(Math.max(1, Number(rows) || 1)),
        '--ofs-sprite-cols': String(Math.max(1, Number(cols) || 1)),
      }
    : (gridMode === 'pixel-ratio'
      ? {
          '--ofs-pixel-cols': String(pixelCols),
          '--ofs-pixel-rows': String(pixelRows),
        }
      : { '--ofs-workshop-cell': `${cellPx}px` })

  function spatialPointOf(event) {
    const target = event?.currentTarget
    if (!target || typeof target.getBoundingClientRect !== 'function') return null
    const rect = target.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    }
  }

  function positionSpatialMarker(point) {
    const marker = spatialLayerRef.current?.querySelector('.ofs-workshop-spatial-light, .ofs-workshop-spatial-focus')
    if (!marker) return
    marker.style.left = `${point.x * 100}%`
    marker.style.top = `${point.y * 100}%`
  }

  function flushSpatialMove() {
    pointerFrameRef.current = null
    const point = pendingPointRef.current
    pendingPointRef.current = null
    if (point) pointerCallbackRef.current?.(point, 'move')
  }

  function handleSpatialDown(event) {
    if (!spatialInteraction?.onPointer || (event.button !== undefined && event.button !== 0) || spatialPointerRef.current) return
    const point = spatialPointOf(event)
    if (!point) return
    event.preventDefault()
    spatialPointerRef.current = { id: event.pointerId, target: event.currentTarget }
    event.currentTarget?.setAttribute?.('data-interacting', 'true')
    positionSpatialMarker(point)
    if (typeof event.currentTarget?.setPointerCapture === 'function') {
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
    }
    spatialInteraction.onPointer(point, 'down')
  }

  function handleSpatialMove(event) {
    if (!spatialPointerRef.current || !spatialInteraction?.onPointer) return
    if (event.pointerId !== spatialPointerRef.current.id) return
    const point = spatialPointOf(event)
    if (!point) return
    event.preventDefault()
    positionSpatialMarker(point)
    pendingPointRef.current = point
    if (pointerFrameRef.current !== null) return
    if (typeof requestAnimationFrame === 'function') pointerFrameRef.current = requestAnimationFrame(flushSpatialMove)
    else flushSpatialMove()
  }

  function handleSpatialUp(event) {
    if (!spatialPointerRef.current) return
    if (event.pointerId !== spatialPointerRef.current.id) return
    if (pointerFrameRef.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pointerFrameRef.current)
    flushSpatialMove()
    const target = spatialPointerRef.current.target
    spatialPointerRef.current = false
    target?.removeAttribute?.('data-interacting')
    const point = spatialPointOf(event)
    if (point && spatialInteraction?.onPointer) spatialInteraction.onPointer(point, 'up')
    if (typeof target?.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
      try { target.releasePointerCapture(event.pointerId) } catch {}
    }
  }

  const keyboardSpatial = ['relight', 'dof'].includes(spatialInteraction?.mode)
  function handleSpatialKey(event) {
    if (!keyboardSpatial || !spatialInteraction?.onPointer) return
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
    if (!delta && event.key !== 'Home') return
    event.preventDefault()
    const light = spatialInteraction.mode === 'relight'
    const x = (light ? spatialInteraction.lightX : spatialInteraction.focusX) ?? 0.5
    const y = (light ? spatialInteraction.lightY : spatialInteraction.focusY) ?? 0.5
    const step = event.shiftKey ? 0.1 : 0.02
    spatialInteraction.onPointer(event.key === 'Home' ? { x: 0.5, y: 0.5 } : {
      x: Math.max(0, Math.min(1, x + delta[0] * step)),
      y: Math.max(0, Math.min(1, y + delta[1] * step)),
    }, 'down')
  }

  const anchors = Array.isArray(spatialInteraction?.anchors) ? spatialInteraction.anchors : []

  return (
    <div className="ofs-workshop-preview" data-tool={tool} data-repeat={String(repeat)}>
      <div className="ofs-workshop-canvas" data-playing={playing ? 'true' : undefined}>
        {notice || null}
        <div className="ofs-workshop-canvas-stage">
          <div className="ofs-workshop-checker" aria-hidden="true" />
          <div
            className="ofs-workshop-canvas-box"
            style={{ '--ofs-canvas-r': String(boxRatio) }}
            hidden={hideCanvas}
          >
            <canvas
              ref={canvasRef}
              className="ofs-workshop-canvas-el"
              width={1}
              height={1}
              hidden={hideCanvas}
              aria-label={t('studio.workshop.previewAlt')}
            />
            {spatialInteraction && !hideCanvas ? (
              <div
                ref={spatialLayerRef}
                className="ofs-workshop-spatial-layer"
                data-mode={spatialInteraction.mode}
                data-brush={spatialInteraction.brushMode ? 'true' : undefined}
                role="group"
                tabIndex={keyboardSpatial ? 0 : undefined}
                aria-description={keyboardSpatial ? t('studio.workshop.spatial.keyboardHint') : undefined}
                onKeyDown={handleSpatialKey}
                aria-label={t(spatialInteraction.mode === 'relight'
                  ? 'studio.workshop.tool.relight'
                  : `studio.workshop.depthFx.mode.${spatialInteraction.mode || 'fog'}`)}
                onPointerDown={handleSpatialDown}
                onPointerMove={handleSpatialMove}
                onPointerUp={handleSpatialUp}
                onPointerCancel={handleSpatialUp}
                onLostPointerCapture={handleSpatialUp}
              >
                {spatialInteraction.mode === 'fog' ? anchors.map((anchor, index) => (
                  <span
                    key={`${index}-${anchor.mode}`}
                    className="ofs-workshop-spatial-anchor"
                    data-kind={anchor.mode === 'subtract' ? 'subtract' : 'add'}
                    style={{
                      left: `${(Number(anchor.x) || 0) * 100}%`,
                      top: `${(Number(anchor.y) || 0) * 100}%`,
                      '--ofs-anchor-radius': `${Math.max(8, (Number(anchor.radius) || 0.22) * 100)}%`,
                    }}
                    aria-hidden="true"
                  />
                )) : null}
                {spatialInteraction.mode === 'dof' ? (
                  <span
                    className="ofs-workshop-spatial-focus"
                    style={{
                      left: `${(spatialInteraction.focusX ?? 0.5) * 100}%`,
                      top: `${(spatialInteraction.focusY ?? 0.5) * 100}%`,
                    }}
                    aria-hidden="true"
                  />
                ) : null}
                {spatialInteraction.mode === 'relight' ? (
                  <span
                    className="ofs-workshop-spatial-light"
                    style={{
                      left: `${(spatialInteraction.lightX ?? 0.5) * 100}%`,
                      top: `${(spatialInteraction.lightY ?? 0.5) * 100}%`,
                    }}
                    aria-hidden="true"
                  >
                    <span />
                  </span>
                ) : null}
              </div>
            ) : null}
            {showGrid ? (
              <div
                className="ofs-workshop-grid"
                data-mode={gridMode}
                aria-hidden="true"
                style={gridStyle}
              />
            ) : null}
            {showTileCrosshair ? <div className="ofs-workshop-tile-crosshair" aria-hidden="true" /> : null}
          </div>
          {showCompare ? (
            <CompareSlider
              key={preview.url}
              t={t}
              beforeUrl={sourceUrl}
              afterUrl={preview.url}
              beforeLabel={t('studio.workshop.vector.compareBefore')}
              afterLabel={t('studio.workshop.vector.compareAfter')}
              ratio={previewRatio || 1}
            />
          ) : null}
          {preview && preview.type === 'svg' && !showCompare ? (
            <img
              key={preview.url}
              className="ofs-workshop-canvas-svg"
              style={{ '--ofs-canvas-r': String(previewRatio || 1) }}
              src={preview.url}
              alt={t('studio.workshop.previewAlt')}
              draggable={false}
              onLoad={(event) => animateSwap(event.currentTarget)}
            />
          ) : null}
          {preview && preview.type === 'json' ? (
            <div className="ofs-workshop-json-wrap" key={preview.url}>
              <div className="ofs-workshop-json-head">{preview.label || 'JSON'}</div>
              <pre className="ofs-workshop-json">{jsonText || '…'}</pre>
            </div>
          ) : null}
          {!preview || preview.type === 'empty' ? (
            <p className="ofs-workshop-canvas-empty">{t('studio.workshop.statusNoSource')}</p>
          ) : null}
        </div>
        <div className="ofs-workshop-canvas-actions">
          {keyboardSpatial && !hideCanvas ? (
            <span className="ofs-workshop-spatial-cue">
              <Icon name={spatialInteraction.mode === 'relight' ? 'sun' : 'focus'} size={13} />
              {t(spatialInteraction.mode === 'relight' ? 'studio.workshop.spatial.dragLight' : 'studio.workshop.spatial.pickFocus')}
            </span>
          ) : null}
          {handoff || null}
          {svgStats && preview && preview.type === 'svg' ? (
            <span className="ofs-workshop-svg-pill">
              {formatText(t('studio.workshop.vector.stats'), svgStats)}
            </span>
          ) : null}
          {preview && preview.type === 'svg' && typeof onCopySvg === 'function' ? (
            <button
              type="button"
              className="ofs-workshop-action-pill ofs-workshop-copy-svg"
              onClick={onCopySvg}
            >
              <Icon name="copy" size={12} />
              {t('studio.workshop.vector.copy')}
            </button>
          ) : null}
          {canCompareSvg && preview && preview.type === 'svg' ? (
            <button
              type="button"
              className={compareSvg ? 'ofs-workshop-action-pill ofs-workshop-compare-toggle is-on' : 'ofs-workshop-action-pill ofs-workshop-compare-toggle'}
              aria-pressed={compareSvg ? 'true' : 'false'}
              onClick={onToggleCompareSvg}
            >
              <Icon name="compare" size={12} />
              {t('studio.workshop.vector.compareToggle')}
            </button>
          ) : null}
          {canShowDepth && typeof onToggleDepthPreview === 'function' ? (
            <button
              type="button"
              className={showDepthPreview ? 'ofs-workshop-action-pill ofs-workshop-depth-preview is-on' : 'ofs-workshop-action-pill ofs-workshop-depth-preview'}
              aria-pressed={showDepthPreview ? 'true' : 'false'}
              onClick={onToggleDepthPreview}
            >
              <Icon name="mountains" size={12} />
              {t('studio.workshop.spatial.viewDepth')}
            </button>
          ) : null}
          {canCompareSpatial && typeof onToggleCompareSpatial === 'function' ? (
            <button
              type="button"
              className={compareSpatial ? 'ofs-workshop-action-pill ofs-workshop-spatial-compare is-on' : 'ofs-workshop-action-pill ofs-workshop-spatial-compare'}
              aria-pressed={compareSpatial ? 'true' : 'false'}
              onClick={onToggleCompareSpatial}
            >
              <Icon name="compare" size={12} />
              {t('studio.workshop.spatial.compare')}
            </button>
          ) : null}
          <button
            type="button"
            className={playing ? 'ofs-workshop-play is-on' : 'ofs-workshop-play'}
            disabled={!canPlay}
            aria-pressed={playing ? 'true' : 'false'}
            onClick={onTogglePlay}
          >
            <Icon name={playing ? 'minimize' : 'film'} size={13} />
            {playing ? t('studio.workshop.pause') : t('studio.workshop.play')}
          </button>
          <button
            type="button"
            className={tilePreview ? 'ofs-workshop-tile-toggle is-on' : 'ofs-workshop-tile-toggle'}
            disabled={!canTile}
            aria-pressed={tilePreview ? 'true' : 'false'}
            onClick={onToggleTilePreview}
          >
            <Icon name="images" size={13} />
            {t('studio.workshop.tileToggle')}
          </button>
        </div>

        {showChannels ? (
          <div className="ofs-workshop-channels" role="group" aria-label={t('studio.workshop.channels')}>
            {channelList.map((channel) => (
              <button
                key={channel.role}
                type="button"
                className={channel.role === activeChannel ? 'ofs-workshop-channel is-on' : 'ofs-workshop-channel'}
                data-role={channel.role}
                aria-pressed={channel.role === activeChannel ? 'true' : 'false'}
                onClick={() => onChannel(channel.role)}
              >
                {channel.thumb ? (
                  channel.role === 'tile' ? (
                    <span
                      className="ofs-workshop-channel-tile"
                      style={{ backgroundImage: `url("${channel.thumb}")` }}
                    >
                      <img src={channel.thumb} alt="" draggable={false} />
                    </span>
                  ) : (
                    <img src={channel.thumb} alt="" draggable={false} />
                  )
                ) : (
                  <span className="ofs-workshop-channel-badge">
                    {String(channel.format || 'file').toUpperCase()}
                  </span>
                )}
                <span>{channel.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
