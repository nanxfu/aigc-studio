/**
 * 自绘窗口按钮：最小化 / 最大化（还原）/ 关闭。
 *
 * 主进程用无边框窗口（frame:false）创建主窗口，系统标题栏不再存在：
 * 顶栏本身就是标题栏（空白处可拖动、双击最大化，见 shell.css 的 -webkit-app-region），
 * 这里只补右端三枚按钮。按钮尺寸、圆角与配色都取顶栏现有的图标按钮语言，
 * 关闭按钮悬停时用语义红，和「危险操作」的颜色约定一致。
 *
 * 渲染条件：
 *  - 浏览器直连开发态（没有 Electron preload）不渲染；
 *  - macOS 保留系统交通灯（titleBarStyle: hiddenInset），不重复画一套按钮，
 *    左侧留白由 CSS 按 data-platform 让出。
 */

import React from 'react'

import { desktop } from '../runtime.js'
import { Icon } from './icons.jsx'

/**
 * 订阅窗口状态：最大化后按钮换成「还原」图标，标题与 aria-label 同步更新。
 *
 * @param {object | null} controls preload 暴露的 windowControls
 * @returns {[boolean, React.Dispatch<React.SetStateAction<boolean>>]}
 */
function useMaximized(controls) {
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    if (!controls) return undefined
    let alive = true
    const apply = (state) => {
      if (alive && state && typeof state.maximized === 'boolean') setMaximized(state.maximized)
    }
    // 首帧先问一次当前状态：事件只在变化时推送，挂载时可能是已最大化的窗口（窗口重建）。
    try {
      Promise.resolve(controls.getState()).then(apply).catch(() => {})
    } catch {
      // 旧 preload 没有 getState：保持默认图标，等状态广播纠正。
    }
    const off = typeof controls.onStateChange === 'function' ? controls.onStateChange(apply) : null
    return () => {
      alive = false
      if (typeof off === 'function') off()
    }
  }, [controls])

  return [maximized, setMaximized]
}

export function WindowControls(props) {
  // 组件可以脱离 TopBar 单独挂载（预览 / 测试），缺 t 时退回 key 本身而不是抛错。
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const bridge = desktop()
  const controls = bridge && bridge.windowControls ? bridge.windowControls : null
  const [maximized, setMaximized] = useMaximized(controls)

  // macOS 用系统交通灯；浏览器预览 / 测试环境没有窗口能力。
  if (!controls || bridge.platform === 'darwin') return null

  const toggleMaximize = async () => {
    try {
      const state = await controls.toggleMaximize()
      if (state && typeof state.maximized === 'boolean') setMaximized(state.maximized)
    } catch {
      // 窗口销毁中 / 主进程拒绝等边界情况：保持现有图标，等下一次状态广播纠正。
    }
  }

  return (
    <div className="ofs-window-controls" role="group" aria-label={t('window.controls')}>
      <button
        type="button"
        className="ofs-window-btn"
        onClick={() => controls.minimize?.()}
        title={t('window.minimize')}
        aria-label={t('window.minimize')}
      >
        <Icon name="minimize" size={12} />
      </button>
      <button
        type="button"
        className="ofs-window-btn"
        onClick={toggleMaximize}
        title={maximized ? t('window.restore') : t('window.maximize')}
        aria-label={maximized ? t('window.restore') : t('window.maximize')}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={12} />
      </button>
      <button
        type="button"
        className="ofs-window-btn is-close"
        onClick={() => controls.close?.()}
        title={t('window.close')}
        aria-label={t('window.close')}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
