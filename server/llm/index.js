/**
 * LLM 模块聚合出口。
 *
 * 装配层（server/standalone.js）用 `createLlmService`；设置路由用 config 里的纯函数；
 * 只有需要区分协议细节时才直接 import providers。
 */

export { createLlmService, default as defaultLlmServiceFactory } from './service.js'
export {
  PROVIDER_IDS,
  PROVIDER_PRESETS,
  isLlmConfigured,
  normalizeBaseUrl,
  normalizeLlmConfig,
  normalizeLlmPatch,
  publicLlmView,
  trimBaseUrl,
} from './config.js'
export { mapFinishReason } from './finish.js'
