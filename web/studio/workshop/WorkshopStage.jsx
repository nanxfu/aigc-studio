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
    svgStats,
    canCompareSvg,
    compareSvg,
    onToggleCompareSvg,
    onCopySvg,
    previewRatio,
    // 画面下方操作区左侧的接力节点（`Workshop` 决定是否出现、出现哪一个）。
    handoff,
    // 画面上方的轻提示（例如「完整画作可回创作台精修」），由宿主决定是否渲染。
    notice,
  } = props
  const canvasRef = React.useRef(null)
  // 动画需要反复从同一张源图裁帧：加载一次存进 ref，避免每帧 new Image。
  const sourceImageRef = React.useRef(null)
  const [jsonText, setJsonText] = React.useState('')
  const [canvasDims, setCanvasDims] = React.useState(null)
  const animateSwap = useSwapMotion()
  // 调参重绘保持即时；只在换作品、通道或平铺视图时确认画面已经切换。
  const previewContext = `${sourceUrl || ''}:${activeChannel || ''}:${Number(repeat) || 1}`
  const paintedContextRef = React.useRef(null)

  // 静态预览：原图 / 工具结果 / 通道图 / 平铺。
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
    loadImage(preview.url).then((image) => {
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
      if (drawImage(canvas, image, { width: tileW, height: tileH, repeat: tileRepeat })) {
        setCanvasDims((prev) => (
          prev && prev.context === previewContext && prev.width === nextW && prev.height === nextH
            ? prev
            : { context: previewContext, width: nextW, height: nextH }
        ))
        if (changed) animateSwap(canvas.parentElement, previousFrame)
        paintedContextRef.current = previewContext
      }
    })
    return () => {
      alive = false
    }
  }, [preview && preview.url, preview && preview.type, repeat, playing, previewContext, previewRatio, animateSwap])

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
      if (image && (!last || timestamp - last >= interval)) {
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
