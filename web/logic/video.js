/**
 * 视频产物的纯逻辑（M4.2 起使用）。
 *
 * 只服务一件事：从已生成的视频里取出一帧，落成一张普通作品——此后它就能当参考图、
 * 当首帧继续做 I2V、做局部重绘，沿用现成的版本树与图片工具，不需要为视频再造一套加工链。
 *
 * 取帧本身发生在渲染进程（`<video>` → `<canvas>` → dataURL），这里只提供与 DOM 无关的
 * 判定：取哪一刻、产物叫什么名字、帧要不要缩放。便于离线断言。
 */

import { IMPORT } from '../../shared/contract.js'

/** 抽帧阶段：首帧 / 尾帧。 */
export const FRAME_PHASES = Object.freeze(['first', 'last'])

/** 尾帧留一点余量：精确停在 duration 时浏览器可能读到最后一帧之后的黑场。 */
const LAST_FRAME_EPSILON = 0.06

/**
 * 抽帧目标时刻（秒）。
 *
 * 片长未知（元数据还没加载 / 时长字段缺失）时一律取 0：宁可给首帧，也不要在
 * 未知时长上 seek 到越界位置导致读到黑屏。
 *
 * @param {'first'|'last'} phase
 * @param {number} duration 视频时长（秒）
 * @returns {number}
 */
export function frameSeekOf(phase, duration) {
  const total = Number(duration)
  if (phase !== 'last') return 0
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.round((total - LAST_FRAME_EPSILON) * 1000) / 1000)
}

/**
 * 抽帧产物的展示名：`clip.mp4` + 首帧 → `clip-首帧.png`。
 *
 * 名字只用于列表标题与导入记录（落盘目录由 Host 生成），因此带中文可读性是安全的；
 * 去掉原扩展名，避免出现 `clip.mp4.png`。
 *
 * @param {string} sourceName 视频文件名或路径
 * @param {'first'|'last'} phase
 * @param {{ zh?: boolean }} [options] 是否中文（默认中文）
 * @returns {string}
 */
export function frameNameOf(sourceName, phase, options = {}) {
  const raw = typeof sourceName === 'string' ? sourceName.trim() : ''
  const base = raw.split(/[\\/]/).pop() || 'clip'
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '') || 'clip'
  const zh = options.zh !== false
  const suffix = phase === 'last' ? (zh ? '尾帧' : 'last-frame') : (zh ? '首帧' : 'first-frame')
  return `${stem}-${suffix}.png`
}

/**
 * 抽帧画布尺寸：保持原始像素，超过导入长边上限时等比缩小。
 *
 * 抽出来的帧要交给 `/api/import`，因此必须落在 `IMPORT.maxEdge` 以内，
 * 否则会在提交时被 Host 拒绝（用户看到的是「导入失败」，不知道是自己片幅太大）。
 *
 * @param {number} width 视频原始宽
 * @param {number} height 视频原始高
 * @param {{ maxEdge?: number }} [options]
 * @returns {{ width: number, height: number }}
 */
export function frameCanvasSize(width, height, options = {}) {
  const maxEdge = Number(options.maxEdge) > 0 ? Number(options.maxEdge) : IMPORT.maxEdge
  const w = Math.max(0, Math.round(Number(width) || 0))
  const h = Math.max(0, Math.round(Number(height) || 0))
  if (w <= 0 || h <= 0) return { width: 0, height: 0 }
  const longEdge = Math.max(w, h)
  if (longEdge <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longEdge
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/** 该产物是否支持抽帧（只有视频作品有帧可取）。 */
export function canCaptureFrameOf(image) {
  return Boolean(image && typeof image === 'object' && image.mediaType === 'video' && image.url)
}