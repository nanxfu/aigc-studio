/**
 * 提交生图 → 顶栏任务队列按钮的抛物线飞入动效浮层。
 *
 * 仅在提交成功入队后触发：从提交按钮位置飞出一枚轻量缩略标记，
 * 沿平滑抛物线收拢并落入顶栏 `[data-queue-target="true"]` 按钮。
 * 减弱动态或无 DOM 环境（Node 测试）下立即回调收尾，不阻塞交互。
 */

import React from 'react'

import { canAnimatePresence } from './hooks/usePresence.js'
import { Icon } from './icons.jsx'

const FLY_DURATION_MS = 520
const FLY_FALLBACK_MS = 620
const FLIGHT_END_OFFSET = 0.78
const FLIGHT_STEPS = 8

function findQueueTarget() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
  return document.querySelector('[data-queue-target="true"]')
}

function lerp(start, end, t) {
  return start + (end - start) * t
}

function quadBezier(p0, p1, p2, t) {
  const inv = 1 - t
  return inv * inv * p0 + 2 * inv * t * p1 + t * t * p2
}

function buildFlyKeyframes(fromRect, toRect) {
  const fromCx = fromRect.left + fromRect.width / 2
  const fromCy = fromRect.top + fromRect.height / 2
  const toCx = toRect.left + toRect.width / 2
  const toCy = toRect.top + toRect.height / 2

  const startW = Math.min(46, Math.max(32, fromRect.height || 36))
  const startH = Math.min(46, Math.max(32, fromRect.height || 36))
  const endW = 24
  const endH = 24
  const distance = Math.hypot(toCx - fromCx, toCy - fromCy)
  const lift = Math.min(110, Math.max(48, distance * 0.16))
  const controlY = Math.max(18, Math.min(fromCy, toCy) - lift)
  const frames = []

  for (let i = 0; i <= FLIGHT_STEPS; i += 1) {
    const p = i / FLIGHT_STEPS
    const offset = p * FLIGHT_END_OFFSET
    const easeX = 1 - Math.pow(1 - p, 2.1)
    const cx = lerp(fromCx, toCx, easeX)
    const cy = quadBezier(fromCy, controlY, toCy, p)
    const w = lerp(startW, endW, p)
    const h = lerp(startH, endH, p)
    const scale = p === 0 ? 0.92 : lerp(1.06, 0.85, Math.pow(p, 1.3))
    frames.push({
      offset,
      left: `${cx - w / 2}px`,
      top: `${cy - h / 2}px`,
      width: `${w}px`,
      height: `${h}px`,
      transform: `scale(${scale.toFixed(3)})`,
      opacity: p === 0 ? 0.95 : 1,
    })
  }

  frames.push(
    {
      offset: 0.9,
      left: `${toCx - endW / 2}px`,
      top: `${toCy - endH / 2}px`,
      width: `${endW}px`,
      height: `${endH}px`,
      transform: 'scale(1.16)',
      opacity: 1,
    },
    {
      offset: 1,
      left: `${toCx - endW / 2}px`,
      top: `${toCy - endH / 2}px`,
      width: `${endW}px`,
      height: `${endH}px`,
      transform: 'scale(0.6)',
      opacity: 0,
    },
  )
  return frames
}

export function JobFlyOverlay({ fly, onDone }) {
  const ghostRef = React.useRef(null)

  React.useLayoutEffect(() => {
    if (!fly || !fly.fromRect) return undefined
    const finish = typeof onDone === 'function' ? onDone : () => {}
    if (!canAnimatePresence() || typeof document === 'undefined') {
      finish()
      return undefined
    }
    const target = findQueueTarget()
    const ghost = ghostRef.current
    if (!target || !ghost || typeof target.getBoundingClientRect !== 'function') {
      finish()
      return undefined
    }
    const toRect = target.getBoundingClientRect()
    if (!toRect || toRect.width <= 0 || toRect.height <= 0 || typeof ghost.animate !== 'function') {
      finish()
      return undefined
    }

    let settled = false
    const complete = () => {
      if (settled) return
      settled = true
      finish()
    }
    const animation = ghost.animate(buildFlyKeyframes(fly.fromRect, toRect), {
      duration: FLY_DURATION_MS,
      easing: 'linear',
      fill: 'forwards',
    })
    animation.onfinish = complete
    animation.oncancel = complete
    const fallbackTimer = setTimeout(complete, FLY_FALLBACK_MS)
    return () => {
      clearTimeout(fallbackTimer)
      animation.cancel()
    }
  }, [fly && fly.id])

  if (!fly || !fly.fromRect || !canAnimatePresence()) return null
  const size = Math.min(46, Math.max(32, fly.fromRect.height || 36))
  const left = fly.fromRect.left + (fly.fromRect.width - size) / 2
  const top = fly.fromRect.top + (fly.fromRect.height - size) / 2

  return (
    <div
      ref={ghostRef}
      key={fly.id}
      className="ofs-job-fly"
      aria-hidden="true"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${size}px`,
        height: `${size}px`,
      }}
    >
      {fly.url ? (
        <img src={fly.url} alt="" draggable={false} />
      ) : (
        <Icon name="sparkles" size={16} />
      )}
    </div>
  )
}
