/** 数据形态常量：会话态、任务态与阶段映射。 */

export const NS = 'our-imagen'

export const ACTIVE_STATUS = { queued: true, 'waiting-session': true, running: true }

export const TRANSIENT_SESSION = { provisioning: true, connecting: true, warming: true, stopping: true }

// 宿主会写入的会话阶段：push（推送内核 / 申请实例）→ queue（Kaggle 排队 / Colab 启动运行时）
// → tunnel（会合/握手）→ warm（装载模型）。阶段名的措辞按算力来源取，见 logic/status.js。
export const PHASE_STATE = {
  push: 'provisioning',
  queue: 'provisioning',
  tunnel: 'connecting',
  warm: 'warming',
}

/** 空白舞台与创作面板共用的灵感示例文案键。 */
export const INSPIRE_KEYS = [
  'studio.inspire.1',
  'studio.inspire.2',
  'studio.inspire.3',
  'studio.inspire.4',
  'studio.inspire.5',
]

/** 视频模式空白舞台的动态灵感示例键。 */
export const VIDEO_INSPIRE_KEYS = [
  'studio.inspire.video1',
  'studio.inspire.video2',
  'studio.inspire.video3',
]

/** 生成张数分段按钮选项（与契约 LIMITS.count 一致）。 */
export const COUNT_OPTIONS = [1, 2, 3, 4]
