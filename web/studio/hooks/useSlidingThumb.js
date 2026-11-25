/**
 * 分段控件 / 视图标签的滑动高亮胶囊 Hook。
 *
 * 首帧直接落定在当前激活项上（不从 0px 飞过来），之后切换或容器尺寸变化时
 * 实时同步激活项坐标到 CSS 变量，由样式层用弹性过渡驱动滑块移动。
 * 容器里没有激活项时（例如工具条按领域拆成多个胶囊）会收起滑块而不是停在旧坐标，
 * 同时清掉「可动画」开关：焦点回到这个容器时直接落在当前项上，不再从上次的旧位置
 * 滑进来（那是别处的选择留下的坐标，不是这个容器自己的移动）。
 * 在无真实 DOM 布局的测试渲染器里安全降级为静默空操作（保留 .is-on 兜底样式）。
 */

import React from 'react'

export function useSlidingThumb(containerRef, activeKey) {
  React.useLayoutEffect(() => {
    const container = containerRef && containerRef.current
    if (!container || typeof container.querySelector !== 'function') return undefined

    let rafId = 0

    function cancelAnimationSchedule() {
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
      }
      rafId = 0
    }

    /** 跨过下一帧绘制后再打开弹性过渡：确保浏览器先提交无过渡的落点坐标，避免从旧坐标或 0px 飞入。 */
    function enableAnimation() {
      cancelAnimationSchedule()
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(() => {
          rafId = requestAnimationFrame(() => {
            rafId = 0
            container.dataset.thumbAnimate = '1'
          })
        })
      } else {
        container.dataset.thumbAnimate = '1'
      }
    }

    function measure(options = {}) {
      const snap = options && options.snap === true
      const target = container.querySelector(`[data-thumb-key="${activeKey}"]`) || container.querySelector('[data-thumb-active="true"]')
      if (!target || !target.offsetWidth) {
        // 当前项不在这个容器里（例如工具条按领域拆成多个胶囊，焦点落在另一个胶囊上）：
        // 收起滑块并停用过渡，避免它停在上一次的坐标上、也避免焦点回来时从旧位置滑入。
        cancelAnimationSchedule()
        if (container.dataset.thumbReady === '1') container.dataset.thumbReady = '0'
        container.dataset.thumbAnimate = '0'
        return
      }
      const wasReady = container.dataset.thumbReady === '1'
      const needsSnap = snap || !wasReady
      if (needsSnap) {
        cancelAnimationSchedule()
        container.dataset.thumbAnimate = '0'
      }
      container.style.setProperty('--ofs-thumb-x', `${target.offsetLeft}px`)
      container.style.setProperty('--ofs-thumb-y', `${target.offsetTop}px`)
      container.style.setProperty('--ofs-thumb-w', `${target.offsetWidth}px`)
      container.style.setProperty('--ofs-thumb-h', `${target.offsetHeight}px`)
      container.dataset.thumbReady = '1'
      if (needsSnap) {
        // 强制刷新当前无过渡坐标，再于绘制后恢复弹簧过渡。
        void container.offsetWidth
        enableAnimation()
      } else if (container.dataset.thumbAnimate !== '1') {
        enableAnimation()
      }
    }

    measure()

    let observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => measure({ snap: true }))
      observer.observe(container)
    }

    return () => {
      cancelAnimationSchedule()
      if (observer) observer.disconnect()
    }
  }, [containerRef, activeKey])
}
