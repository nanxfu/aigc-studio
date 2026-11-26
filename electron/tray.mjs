/**
 * 系统托盘（MIGRATION_SPEC §6.3 / Plan §三.3）。
 *
 * 作用：窗口被关闭但云端 GPU 会话/任务仍在运行时，应用驻留托盘继续保活，
 * 避免用户误关窗口导致 Kaggle/Colab 挂机空烧配额；托盘同时提供只读算力状态
 * 与「彻底退出」入口。
 *
 * 图标不依赖外部资源：内嵌 64×64 的 base64 PNG（墨黑圆角方块 + 裁切白「A」+ 安全灯红点），
 * 打包后（asar:false）与开发态都能直接创建 nativeImage；优先读 build/icon.png，
 * 缺失时退回下列与当前主图标同源的内置数据 URL。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Menu, Tray, nativeImage } from 'electron'

import { ACTIVE_SESSION_STATES, isSessionActive, normalizeSessionState } from '../shared/session-activity.js'
import { resolveShellLang, shellText } from './i18n.mjs'
import { createLogger } from './logger.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICON_PNG_PATH = join(dirname(__dirname), 'build', 'icon.png')

/** 64×64 RGBA PNG：墨黑渐变圆角方块 + 裁切白 A 字 + #E6613E 安全灯点（与 build/icon.png 同源）。 */
const APP_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAPBklEQVR42t1bW2wUV5r+zjlVXV3VDb5BEmEyvcaAnWSBILK5wIROhjAZbpkl+AIENKsoLxONtC+jyUp52nmdedinSKNZrRQFYsBAYJMsGyCZMCSzmWALLZssONgEmxARMGC7u6q6us5lH6q63W63cbdpsoSSym511+V8/3/O/3//d84ByjsI0M6SyaQWfL5rDxK2kZXbzmkvam9vZ93d3aLwu0QiGa2tHYlKKe8KY1BK1cjISGZwcDBT1HoGTGx7JQbI/aYAaC0tj6xRSm6QUj4mhHoQkLHS96vgryrH9hMvknK6eyY/VCmAEChCYFNKLxFCewgh7w8M9H0IgBfhKNsAFIAEgMWLH9kppfg153ypEAJCCMgpW1ou+MntqcY9lFIwxnLnGcbo7wcGvnqrGNN0BmAARFPT396v6+JffZ9vzGQyEEJIQogkhJDwPjJz8BPBVMlgCoAKD8oYpdFoFLquvyel/8rXX3/9XQ7brQxAAcjm5ocXUiqPZDLeQs/zOKWUhr9VwfN3BHyp66WUUhqGoRlGtJ9SuW5gYKC/uCeQIvBq4cJH5wCZz1zXXeD7vk8p1ctp3F0GviCuSF/TdN00zQuahif7+/uHQ9wShV5tb28nABQhmTc9z7snwIdxQfd93/c8b4EQ5M3gonZS6PV8qmttfXgb52Jd2O1/8OBz91FKdc/zOOd83YIFrduC1NjOUBjMVqxYoY2MpM84jtOilFI/wDFfEnzhaCCEkFjM6mtoqF3a29vLwx7QTgEo2/aekVK0CiHuRfAAQIUQinPROjo6+kx4I6XJ5FUCAEKIn3MuFCFE3oPgg4hPIIXginP8HACSyWQ+p6vm5pa/uq77uJRShPnyjoAnhIAxVvJaKWWeZFUbfHi9oJQy0zQ/Hxy88AQAogFQiUQiKqVqDF9O7yR43/dx48aNkvdEIhHE43FIWfpFNIzdQimw8HPhpdOABwAqpYRSsjGRSEQHBwczGgDMnj3bTKdd6052e0IIPM9DIpHASy9tg1IKAalUkFKBUorz589j795umKY5iW5TAthcQiqFuEaR8iUoAWIahZCV9RQpYVE62wQQGGBqWly9Mc8Yg23beOWVl/GrX71a8u7f/Oaf4LoZxGKxCQagBEj7Ek/MNfHq4jmYZ2n41vHxxlfX8dk1B3GNonSnUdMWgdr3EfBy3m9snIe2thfBOQfnHJQSSKmgaQzffHMZb721G7Nnz4IQYpLnn5hjYs+PE7A0goxQWFobxer74th6chB/HXYQm2SEqRte2D76fUR7xhhSqTQ2btyIBx54AFIK6LoGxhgIATRNx/79BzE8PIxIJAJVnMCVwqstc2BpFMOegCcVhj0BS6N4taWhhPfLAz9FD6h+qhNCwDSj2LlzOwAFpcZPTdPgug727NkLy7JKgo9rFI2mBldIaISAANAIgSskGk29aAiUD75ED6g+eMYo0uk0Vq58Co89tgLZbBaUUiilwLkAYxqOHj2GL7/8X1iWBdfN5IMjoILxzyUuuz5MRsGVggLAlYLJKC67PtJchhmiMvBFBrgzJIcQCs45duzYDkoZOOd57xMCKKXw5pu78kOltXUxOPdDI4zHgTf6rsPhEnMMBoMSzDEYHC7xRt/1GYOf1AOqD57AdR0sWrQQ69f/DL4/7n0hBAzDwJkzZ3Dy5CfQdR2JxI/whz+8AV3X81lAqiDVfTbsoPPkIP7z2xS+Snk48m0KnScH8dk1BzGNTJEFSrVPTRCGtDsFPtf9bdvGli2bUVtbh3Q6BU3T8gYghGLXrrdh2zaUUli//mdYtmwZnn32GbzzzmHU1dVCCAEhgbhG8fmwk097uW4f1ysBP20MqC63930f9fV16OzsgBAchBAopSClhGFE8N13V3D48LswDAMNDfVob98CpSRefvkfoGlsQkDM9YRZOoUEMEunFXp+Cr3gToHPBb81a9bgoYda4bpO3gCcc+i6gUOH/h2XLn2DbDaLtWufw+LFLbDtNJLJ1Xj88b9DOp0GIXSCEaQK5Rylbht8BQaovKpTKqC3OdorZS71STBGkck46Orai0gk4AMvvbQVSkn4vo9IxMDOnTuQzfqglFTC8CoCX6YBKgdPKYXjOHj00WVYvfppOI4NSgmUkhBCwLJiOHnyU5w+fRpKKSxfvgyrVq2CbaehaTpc18amTeuxaNGigrRYffBlGGBm9TylFJlMBp2d7YjF4vB9v1CkBADs3t0FzjmEkNi+fStM0wLnHIQAnudhzpz70NGxBbZtF5TP1QWPcpSfSsGP8/75eOGFTXBdG4QQSClDRmiir+8cjh07DtM0UVMzC8nkaniem78ueIaLzs52zJ07F76fBSHVBz9tLTATJYdSilQqjQ0b1iGR+BFc1wUJiUqQ+6Po7j6Aa9euwTRN3Lgxgj/96WMYhhEWQQFBsm0bLS2LsX798xgbS4FSVnXwRQYYp5+3I2MJIWFZFrZubUc2m82zvaDq0zA8fBUHDrwDy7IgRFAU7drVhVQqBUppPlgCAOc+duzYjmjUKDkdNxPwSk1ZDd7+XB2lQepbteoprFixPExj46kvHo/hgw+O49y5r2CaJjjniMViOH36v3HixJ8Rj8cghAgzCEEqlcaTTz6OVaueQjqdBmP0tsGXNQRmLmASCCGxdWt7SGfFBN6fzWaxZ8/eCUCAYNzv3r1nUqUYlM06duzYDiFkXseoFviSBpgp+ID3u2hpWYTnnluDVCoFQsZ5fywWQ09PLz755C+IxWLgXEDKoFSOx2M4fvwjnDnzBSzLLOgFFGNjY/jpT5/DI488BMdxilLiTMBPHOa0WlPUjFE4jovNm1/A3LkN8Lxs3qNSSlBK0dW1D67rgrFgoUmO5Oi6jtHRMXR17YOmaQiEy+DebDag0x0dbXCcDIJ52tv3/ARtbMmSJXWjo86FTMatDZ9IKgFPCCClgq7rOHLkMJqa/gae503y1qVLl+D7vKQXpZQwzSgSiUQYPHPdPVCLr1z5DmvXbkAqNV5QVQ5eKQAkGo2OaFrtgqGh/7mpzaQWmKSrUYaxsRG0tW1GS8sijIyMgjE2Sd1pbm4uEDsKn6Vgmha++OJLvPvue9iy5UWMjY3lve26LpqaEti4cR3++Md/Q319PYTglYKvTi1Q6uE5aaujoy1MVxODWe50XRe2bcNxnAlnKpWGUgr79u3H7373L+Dczz83Z0TP87BtWwfi8RikrA74imuBqZal2HbA+1eufCIMfqSkAXJMcXxOdjwGXL8+jKNHP8TZs2fDQGlBCJ6fP0inbSxfvgyrV/8YqVS6xOxS5eArqgWmCiiEEGSzWbS1bYZlWeBc5L2XY385GbzU6XlZmGYUH330Mfr6+qBpOt5+e29eOcpFbaUCirx9e2fJYTQT8GXNC0wH3vOyePDBRqxbtxbpdDqv9RMCCKEQi1mIRPT8d5OfqRCJGOjq6oaUCvF4DMeOfYSzZ/vQ1JRAJpMBIRSEEIyNpfDMM6uxdOmSvIg69VxieXRYu51Z2qD7p7FjRyfmz2/EjRs3w66pIIRELBbD3r378emn/zWhscW1g+O4OHWqB5ZlglKG4eHrOHjwEF5//TXYtg1NI3lq3NBQj87OLXjttdOIxWK3BX6KNKgmpMHp8qgQHAcOdGHp0iVwHCes+wNe4LoZrF27EQMDF2AYUSglSxqXUoJZs2blCVU2m8X8+Y14//2DiEYNCCHDmgLQNA0jIyPYsGEzhoevQ9P0omyjphvTE9IgnYohTSsnh95fufJJLF26BLZt5xspRMDxP/jgGC5f/hbz5s1DbW0N6upqUVdXN+Gsr69DbW1t/l1KKUSjUZw/34+jR4/DsnL1QfB7JpNBY+M8bNq0Aem0XUSMpvf8LYqhShjUuKbf1rYZjNGQvSEfrFw3g+7uQ/m5ACE4cgsti89c4JyYVhn27TsAz8uE38mCZ7toa9uM2tragnnE8rt9cIzOvBiiNMf7FyOZfLog9eUkLws9Pb3o6elFLGYhWHNRvqGlDGqHzz/vwalTvWFKFPmiyrYdPPxwK559djVSqVRRcTUdP7hFLVDuyoyc5rdx4zrU1MyG53mh4iPBuQClFPv3H0Imk5lC1Jy+pA1kNQ/d3QdBKQXnAkIE75AySK0dHS8WpEvcfjVYDvhc6mtsbMTWrW0gBIjH47AsE6YZRUNDHYaGLuHYsQ9D1iZnpORIKRGPx3D06HFcvDiIOXPqYZpRWJaJeDwOpSTWrv0Jnn56ZYlYMNW71NRpsNI1OZQSvP76P4dCJikYuzquXr2KdDoNXddLeqecel4pFS6qcPDLX/4j7r//voJCSoVFko6rV69N+Z7pwBelQXvAdd260tWgmkSAOBcl6/NcXWCa0RmDnzy/mIHvF06Y5hZVKRiGAcOITPMuVZwGb+o6bR4aGgqqwbGxMZcQ5gCoK2+NTRAHampmlxBGFJRC1TQ8KRVM04RlWSVSNclrB5V4nhDqEELcXAwgg4ODGULI5XAcyXIblwtKhcEp+F89ATMXD8bTZuE7RaXgJaUUhJDL4e4SQpPJJAuj7inGmAqWyaqZrsOrmnQ9U3p7K88rpRSlTGkaOQUAyWSS0RMn7lOhqHGYMUaUUjMgR3c/+PB7qmmMUKodBoATJ04oCnRLAKSmJvYxY/QcY5SU2lrywwcPSSkjjGnn6utrPs7tGaDh+nna29vrU6r/NhqNElk0iO8B8JBSymg0Shijv+3t7fVzG0RI8RazpqZF/+F5mXWe5/mUUv0eAe9HIoZumtEjQ0Nfry/cO1Qw3rsVAMKY+oVhGBc0TdeFkP69AF7Xdd00jQvZLPtF8X69woAnAZD+/v5rlKrnTdPqNwxDl4ECKX+IY15KySMRQ7css19K9vyVK/3XCvcLocSyeAWA3bx583pdXc0+XTdaGWOtQogwLihBppinvgvAq2DljJLhrBK1LItGo8Z7jOHvh4YuXArxyoo2TjY3L94phPw15/6UGydnAkSp6nudUgpKGTSNQdO0M4yx31+8OFDxxsmSW2ebm1vWSCk2KCUfk1I+KCViAEhpz8vv1QCEQAHUppReYoz0EELfv3hx4La2zuJWG5ATiUQUqI0q9f+xeXoUQE1e0QkLJgWgxObpyTtFZ3oQAPfk9vn/A13p7Al6kbzHAAAAAElFTkSuQmCC'

/**
 * 会话状态中文只读文案（与 server/session/state.js 的状态机取值对齐）。
 * 说明：服务端字段名是 session.state；这里同时兼容 session.status（规范文档用词），
 * 且把「stopping」计入活跃——关机过程中仍需防误退。
 */
export const SESSION_STATE_LABELS = Object.freeze({
  absent: '未启动',
  idle: '空闲',
  provisioning: '环境准备中',
  connecting: '隧道连接中',
  warming: '模型预热中',
  ready: '就绪',
  stopping: '正在关机',
  error: '启动失败',
  unknown: '未知',
})

/** 视为「云端仍有算力在消耗」的会话状态（单源：shared/session-activity.js）。 */
export { ACTIVE_SESSION_STATES, isSessionActive, normalizeSessionState }

/**
 * 生成托盘展示用的算力状态文案（只读，支持中/英）。
 *
 * @param {any} snapshot GET /api/state 的响应（可能为 null）
 * @param {{ ok?: boolean } | null} [probe] 最近一次健康探活结果
 * @param {string} [lang='zh'] 当前壳层语言
 */
export function describeComputeStatus(snapshot, probe, lang = 'zh') {
  const resolvedLang = resolveShellLang(lang)
  const state = normalizeSessionState(snapshot)
  const stateKey = `tray.state.${state}`
  const hasKnown = Object.prototype.hasOwnProperty.call(SESSION_STATE_LABELS, state)
  const label = hasKnown ? shellText(resolvedLang, stateKey) : shellText(resolvedLang, 'tray.state.unknownWithRaw', { state })
  const queue = snapshot?.queue ?? {}
  const running = queue.running ? 1 : 0
  const pendingNumber = Number(queue.pending)
  const pending = Number.isFinite(pendingNumber) && pendingNumber > 0 ? pendingNumber : 0
  let text = `${shellText(resolvedLang, 'tray.computePrefix')}${label}`
  if (running > 0 || pending > 0) {
    const parts = []
    if (running > 0) parts.push(shellText(resolvedLang, 'tray.running', { count: running }))
    if (pending > 0) parts.push(shellText(resolvedLang, 'tray.queued', { count: pending }))
    text += resolvedLang === 'en' ? ` (${parts.join(' · ')})` : `（${parts.join(' · ')}）`
  }
  const healthy = probe ? probe.ok !== false : true
  if (!healthy) text += shellText(resolvedLang, 'tray.disconnected')
  return {
    state,
    label,
    text,
    running,
    pending,
    healthy,
    active: isSessionActive(snapshot),
  }
}

/** 优先从 build/icon.png 创建高分辨率应用图标，缺失时退回内嵌数据 URL。 */
export function createAppIcon(size = 64) {
  let image = null
  try {
    if (existsSync(ICON_PNG_PATH)) {
      const loaded = nativeImage.createFromPath(ICON_PNG_PATH)
      if (!loaded.isEmpty()) image = loaded
    }
  } catch {}
  if (!image) image = nativeImage.createFromDataURL(APP_ICON_DATA_URL)
  if (!size || (image.getSize().width === size && image.getSize().height === size)) return image
  return image.resize({ width: size, height: size, quality: 'best' })
}

/**
 * 创建托盘并返回控制器。
 *
 * @param {object} options
 * @param {() => any} [options.getSnapshot] 取最近一次 /api/state 快照
 * @param {() => any} [options.getProbe] 取最近一次健康探活结果
 * @param {() => void} [options.onShow] 显示主窗口
 * @param {() => void} [options.onQuit] 彻底退出（走主进程优雅关停）
 * @param {object} [options.logger]
 * @returns {{ refresh: (snapshot?: any, probe?: any) => void, getStatusText: () => string, destroy: () => void } | null}
 */
export function createTray(options = {}) {
  const { getSnapshot, getProbe, getLang, onShow, onQuit } = options
  const log = options.logger ?? createLogger('tray')

  let tray
  try {
    // Windows 托盘按 16×16 逻辑尺寸显示；给 16 再让系统按 DPI 缩放，避免图标过大。
    tray = new Tray(createAppIcon(16))
  } catch (error) {
    log.error('创建系统托盘失败（窗口功能不受影响）', error)
    return null
  }

  let lastTooltip = ''
  let lastMenuKey = ''
  let lastStatusText = ''

  const buildMenu = (status, lang) => {
    const template = [
      {
        label: shellText(lang, 'tray.show'),
        click: () => {
          try {
            onShow?.()
          } catch (error) {
            log.warn(`托盘「显示主窗口」失败：${error?.message ?? error}`)
          }
        },
      },
      { type: 'separator' },
      { label: status.text, enabled: false },
      { type: 'separator' },
      {
        label: shellText(lang, 'tray.quit'),
        click: () => {
          try {
            log.info('托盘菜单请求彻底退出')
            onQuit?.()
          } catch (error) {
            log.warn(`托盘「彻底退出」失败：${error?.message ?? error}`)
          }
        },
      },
    ]
    return Menu.buildFromTemplate(template)
  }

  const refresh = (snapshot = getSnapshot?.(), probe = getProbe?.()) => {
    const lang = resolveShellLang(typeof getLang === 'function' ? getLang() : 'zh')
    const status = describeComputeStatus(snapshot, probe, lang)
    lastStatusText = status.text
    const tooltip = `AIGC Studio — ${status.text}`
    if (tooltip !== lastTooltip) {
      tray.setToolTip(tooltip)
      lastTooltip = tooltip
    }
    // 只有文案或语言变化时才重建菜单，避免每 5 秒无意义的原生对象重建。
    const menuKey = `${lang}|${status.text}|${status.healthy}`
    if (menuKey !== lastMenuKey) {
      tray.setContextMenu(buildMenu(status, lang))
      lastMenuKey = menuKey
    }
  }

  tray.on('click', () => {
    try {
      onShow?.()
    } catch (error) {
      log.warn(`托盘点击处理失败：${error?.message ?? error}`)
    }
  })
  tray.on('double-click', () => {
    try {
      onShow?.()
    } catch (error) {
      log.warn(`托盘双击处理失败：${error?.message ?? error}`)
    }
  })

  refresh()

  return {
    refresh,
    getStatusText: () => lastStatusText,
    destroy() {
      try {
        if (!tray.isDestroyed()) tray.destroy()
      } catch {
        // ignore
      }
    },
  }
}
