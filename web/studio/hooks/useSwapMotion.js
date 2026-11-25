/**
 * 已就绪内容的短过渡：重复操作取消上一段，减弱动态时只保留淡入。
 * 调用方在图片完成解码 / canvas 完成绘制后触发，避免先播动画再等内容。
 */
import React from 'react'

export function useSwapMotion() {
  const animationRef = React.useRef(null)

  const cancel = React.useCallback(() => {
    animationRef.current?.cancel()
    animationRef.current = null
  }, [])

  React.useEffect(() => cancel, [cancel])

  return React.useCallback((element, previousFrame = null) => {
    cancel()
    if (!element || typeof element.animate !== 'function') return
    const reduced = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (previousFrame) element.append(previousFrame)
    const animation = (previousFrame || element).animate(
      previousFrame
        ? [{ opacity: 1 }, { opacity: 0 }]
        : reduced
        ? [{ opacity: 0.8 }, { opacity: 1 }]
        : [{ opacity: 0.65, transform: 'scale(0.992)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: reduced ? 100 : 210, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
    animationRef.current = animation
    const finish = () => {
      previousFrame?.remove()
      if (animationRef.current === animation) animationRef.current = null
    }
    animation.onfinish = finish
    animation.oncancel = finish
  }, [cancel])
}
