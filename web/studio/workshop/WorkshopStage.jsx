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
import { Icon } from '../icons.jsx'

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
    spriteFrames,
    frameMs,
    sourceUrl,
  } = props
  const canvasRef = React.useRef(null)
  // 动画需要反复从同一张源图裁帧：加载一次存进 ref，避免每帧 new Image。
  const sourceImageRef = React.useRef(null)
  const [jsonText, setJsonText] = React.useState('')

  // 静态预览：原图 / 工具结果 / 通道图 / SVG / 平铺。
  React.useEffect(() => {
    if (!canUseCanvas() || !preview || preview.type === 'empty') return undefined
    if (preview.type === 'svg' || preview.type === 'json') return undefined
    const canvas = canvasRef.current
    if (!canvas || playing) return undefined
    let alive = true
    loadImage(preview.url).then((image) => {
      if (!alive || !image) return
      const size = naturalSizeOf(image)
      if (!size.width || !size.height) return
      const ratio = Math.min(1, MAX_PREVIEW_EDGE / Math.max(size.width, size.height))
      drawImage(canvas, image, {
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
        repeat: Math.max(1, Math.floor(Number(repeat) || 1)),
      })
    })
    return () => {
      alive = false
    }
  }, [preview && preview.url, preview && preview.type, repeat, playing])

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

  const showGrid = (tool === 'pixel-snap' || tool === 'sprite-slice') && preview?.type !== 'json'
  const showChannels = Array.isArray(channelList) && channelList.length > 1
  const hideCanvas = preview && (preview.type === 'svg' || preview.type === 'json' || preview.type === 'empty')

  return (
    <div className="ofs-workshop-preview" data-tool={tool}>
      <div className="ofs-workshop-canvas" data-playing={playing ? 'true' : undefined}>
        <div className="ofs-workshop-canvas-stage">
          <div className="ofs-workshop-checker" aria-hidden="true" />
          <canvas
            ref={canvasRef}
            className="ofs-workshop-canvas-el"
            width={1}
            height={1}
            hidden={hideCanvas}
            aria-label={t('studio.workshop.previewAlt')}
          />
          {preview && preview.type === 'svg' ? (
            <img
              className="ofs-workshop-canvas-svg"
              src={preview.url}
              alt={t('studio.workshop.previewAlt')}
              draggable={false}
            />
          ) : null}
          {preview && preview.type === 'json' ? (
            <div className="ofs-workshop-json-wrap">
              <div className="ofs-workshop-json-head">{preview.label || 'JSON'}</div>
              <pre className="ofs-workshop-json">{jsonText || '…'}</pre>
            </div>
          ) : null}
          {!preview || preview.type === 'empty' ? (
            <p className="ofs-workshop-canvas-empty">{t('studio.workshop.statusNoSource')}</p>
          ) : null}
          {showGrid ? (
            <div
              className="ofs-workshop-grid"
              aria-hidden="true"
              style={{ '--ofs-workshop-cell': `${Math.max(1, Number(cell) || 1)}px` }}
            />
          ) : null}
          <div className="ofs-workshop-canvas-actions">
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
                  <img src={channel.thumb} alt="" draggable={false} />
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
