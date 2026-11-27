/**
 * createApp 的静态 config 默认值（脱离 DSH 单例配置后的唯一来源）。
 *
 * app.js 内部仍保留 `?? 契约默认值` 与 `toInt(...)` 钳制，因此这里的值只表达
 * 「桌面客户端默认怎么跑」；用户在 app-config.json 的 `compute` 段保存的覆盖项由
 * standalone.js 浅合并到这些默认值之上（见 docs/MIGRATION_SPEC.md §3.4 / §4.2）。
 */

import { DEFAULT_PRESET, SETTINGS, TIMEOUTS } from '../shared/contract.js'

/** 分钟 / 秒换算：契约里的毫秒阈值转成 config 字段使用的单位。 */
const MS_PER_MINUTE = 60 * 1000
const MS_PER_SECOND = 1000

/** 冻结的默认 config：字段名与 app.js 读取的 config 键一一对应。 */
export const DEFAULT_CONFIG = Object.freeze({
  // 预设与开发直连（开发直连时跳过 Kaggle，用本地 Daemon）
  defaultPreset: DEFAULT_PRESET,
  devEndpoint: null,
  devToken: null,

  // 算力来源（契约 PROVIDERS 的已知来源），具体默认值由契约 SETTINGS 决定
  provider: SETTINGS.defaultProvider,
  accelerator: SETTINGS.defaultAccelerator,
  colabGpu: SETTINGS.defaultColabGpu,
  colabHighRam: false,

  // 会话与排队超时（config 单位：分钟；契约内是毫秒）
  idleTimeoutSec: TIMEOUTS.idleShutdownSec,
  provisionTimeoutMinutes: TIMEOUTS.provisionMs / MS_PER_MINUTE,
  queueSlowMinutes: TIMEOUTS.queueSlowMs / MS_PER_MINUTE,
  queueStalledMinutes: TIMEOUTS.queueStalledMs / MS_PER_MINUTE,
  sessionWaitMinutes: TIMEOUTS.sessionWaitMs / MS_PER_MINUTE,
  generateTimeoutSeconds: TIMEOUTS.remoteJobMs / MS_PER_SECOND,

  // 冷启动可靠性（可选）：HuggingFace Token、模型下载源、pip 约束、备用隧道、权重预挂载
  hfToken: null,
  modelSource: SETTINGS.defaultModelSource,
  pipConstraints: [],
  fallbackTunnelCommand: [],
  fallbackTunnelUrlRegex: null,
  datasetSources: [],
  localModels: null,
  trustedTunnelDomains: [],

  // 版本检查：Phase 1 未建立独立的发布通道（npm 包 / GitHub Release），默认关闭，
  // 避免把旧插件的 npm 版本误报成「客户端有新版本」；Phase 2 接入 GitHub Releases 后再默认开启。
  updateCheck: false,
})
