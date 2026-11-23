/**
 * 舞台原图 → 左侧参考图槽的非线性抛物线飞入动效浮层。
 *
 * 仅在明确要把当前舞台作品加入参考图时触发（动作坞「设为参考图」或
 * 作品上切换至支持原生参考的模型）：从右侧相纸位置缩小出一份副本，
 * 向上抛起成抛物线后加速落入左侧 `[data-ref-path]` 槽位，再回弹放大填满。
 * 减弱动态或无 DOM 环境（Node 测试）下立即回调收尾，不阻塞交互。
 */

import React from 'react'

import { canAnimatePresence } from './hooks/usePresence.js'

const FLY_DURATION_MS = 580
const FLY_FALLBACK_MS = 680
const FLIGHT_END_OFFSET = 0.74
const FLIGHT_STEPS = 8

function findReferenceCell(path) {
  if (!path || typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
  const nodes = document.querySelectorAll('[data-ref-path]')
  for (const node of nodes) {
    if (node && typeof node.getAttribute === 'function' && node.getAttribute('data-ref-path') === path) {
      return node
    }
  }
  return null
}

function lerp(start, end, t) {
  return start + (end - start) * t
}

function quadBezier(p0, p1, p2, t) {
  const inv = 1 - t
  return inv * inv * p0 + 2 * inv * t * p1 + t * t * p2
}

/**
 * 采样抛物线抛落 + 落位放大填充的关键帧序列。
 * 总动画使用 linear 时间轴，把全部非线性物理节奏显式编码到每一帧，
 * 让水平减速、垂直抛物线重力感与末段回弹放大各自独立、互不打架。
 */
function buildParabolicKeyframes(fromRect, toRect) {
  const fromCx = fromRect.left + fromRect.width / 2
  const fromCy = fromRect.top + fromRect.height / 2
  const toCx = toRect.left + toRect.width / 2
  const toCy = toRect.top + toRect.height / 2

  const distance = Math.hypot(toCx - fromCx, toCy - fromCy)
  const lift = Math.min(135, Math.max(68, distance * 0.25))
  const apexControlY = Math.max(24, Math.min(fromCy, toCy) - lift * 1.65)
  const frames = []

  for (let i = 0; i <= FLIGHT_STEPS; i += 1) {
    const p = i / FLIGHT_STEPS
    const offset = p * FLIGHT_END_OFFSET
    // X 轴起手快、入槽前渐缓；尺寸在前半段迅速收拢成紧凑卡片，接近槽位时压到略小于目标框。
    const easeX = 1 - Math.pow(1 - p, 2.15)
    const easeSize = 1 - Math.pow(1 - p, 2.5)
    const cx = lerp(fromCx, toCx, easeX)
    const cy = quadBezier(fromCy, apexControlY, toCy, p)
    const width = lerp(fromRect.width, toRect.width, easeSize)
    const height = lerp(fromRect.height, toRect.height, easeSize)
    const scale = p === 0 ? 1 : lerp(0.96, 0.72, Math.pow(p, 1.35))
    const rotate = -6.5 * Math.sin(Math.PI * p)
    const radius = lerp(4, 10, Math.min(1, p * 1.8))

    frames.push({
      offset,
      left: `${cx - width / 2}px`,
      top: `${cy - height / 2}px`,
      width: `${width}px`,
      height: `${height}px`,
      borderRadius: `${radius}px`,
      transform: `rotate(${rotate.toFixed(2)}deg) scale(${scale.toFixed(3)})`,
      opacity: p === 0 ? 0.96 : 1,
    })
  }

  // 落入槽位后由缩小态迅速「填充放大」至略过冲，再回落贴合 96×96 槽位。
  frames.push(
    {
      offset: 0.87,
      left: `${toRect.left}px`,
      top: `${toRect.top}px`,
      width: `${toRect.width}px`,
      height: `${toRect.height}px`,
      borderRadius: '10px',
      transform: 'rotate(0deg) scale(1.075)',
      opacity: 1,
    },
    {
      offset: 1,
      left: `${toRect.left}px`,
      top: `${toRect.top}px`,
      width: `${toRect.width}px`,
      height: `${toRect.height}px`,
      borderRadius: '10px',
      transform: 'rotate(0deg) scale(1)',
      opacity: 0.98,
    },
  )

  return frames
}

export function ReferenceFlyOverlay({ fly, onDone }) {
  const ghostRef = React.useRef(null)

  React.useLayoutEffect(() => {
    if (!fly || !fly.path || !fly.fromRect) return undefined
    const finish = typeof onDone === 'function' ? onDone : () => {}
    if (!canAnimatePresence() || typeof document === 'undefined') {
      finish()
      return undefined
    }
    const target = findReferenceCell(fly.path)
    const ghost = ghostRef.current
    if (!target || !ghost || typeof target.getBoundingClientRect !== 'function') {
      finish()
      return undefined
    }
    if (typeof target.scrollIntoView === 'function') {
      try {
        target.scrollIntoView({ block: 'nearest' })
      } catch {}
    }
    const toRect = target.getBoundingClientRect()
    const fromRect = fly.fromRect
    if (!toRect || toRect.width <= 0 || toRect.height <= 0 || fromRect.width <= 0 || fromRect.height <= 0) {
      finish()
      return undefined
    }

    let settled = false
    const complete = () => {
      if (settled) return
      settled = true
      finish()
    }
    const fallbackTimer = setTimeout(complete, FLY_FALLBACK_MS)

    if (typeof ghost.animate !== 'function') {
      clearTimeout(fallbackTimer)
      finish()
      return undefined
    }

    const anim = ghost.animate(buildParabolicKeyframes(fromRect, toRect), {
      duration: FLY_DURATION_MS,
      easing: 'linear',
      fill: 'forwards',
    })
    anim.onfinish = () => {
      clearTimeout(fallbackTimer)
      complete()
    }
    anim.oncancel = () => {
      clearTimeout(fallbackTimer)
      complete()
    }

    return () => {
      clearTimeout(fallbackTimer)
      try {
        anim.cancel()
      } catch {}
    }
  }, [fly && fly.id])

  if (!fly || !fly.url || !fly.fromRect || !canAnimatePresence()) return null

  return (
    <div
      ref={ghostRef}
      className="ofs-ref-fly"
      aria-hidden="true"
      style={{
        left: `${fly.fromRect.left}px`,
        top: `${fly.fromRect.top}px`,
        width: `${fly.fromRect.width}px`,
        height: `${fly.fromRect.height}px`,
      }}
    >
      <img className="ofs-ref-fly-img" src={fly.url} alt="" draggable={false} />
    </div>
  )
}
