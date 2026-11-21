/**
 * 分段控件 / 视图标签的滑动高亮胶囊 Hook。
 *
 * 首帧直接落定在当前激活项上（不从 0px 飞过来），之后切换或容器尺寸变化时
 * 实时同步激活项坐标到 CSS 变量，由样式层用弹性过渡驱动滑块移动。
 * 在无真实 DOM 布局的测试渲染器里安全降级为静默空操作（保留 .is-on 兜底样式）。
 */

import React from 'react'

export function useSlidingThumb(containerRef, activeKey) {
  const readyRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const container = containerRef && containerRef.current
    if (!container || typeof container.querySelector !== 'function') return undefined

    let rafId = 0

    function measure() {
      const target = container.querySelector('[data-thumb-active="true"]')
      if (!target || !target.offsetWidth) return
      container.style.setProperty('--ofs-thumb-x', `${target.offsetLeft}px`)
      container.style.setProperty('--ofs-thumb-y', `${target.offsetTop}px`)
      container.style.setProperty('--ofs-thumb-w', `${target.offsetWidth}px`)
      container.style.setProperty('--ofs-thumb-h', `${target.offsetHeight}px`)
      container.dataset.thumbReady = '1'
      if (!readyRef.current) {
        readyRef.current = true
        if (typeof requestAnimationFrame === 'function') {
          rafId = requestAnimationFrame(() => {
            container.dataset.thumbAnimate = '1'
          })
        } else {
          container.dataset.thumbAnimate = '1'
        }
      }
    }

    measure()

    let observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(measure)
      observer.observe(container)
    }

    return () => {
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
      if (observer) observer.disconnect()
    }
  }, [containerRef, activeKey])
}
