/**
 * 商业生图 API 算力来源（M3.5 Phase A）。
 *
 * 与 notebook / worker 型的差异全部收在这里：
 *  - 没有远端会话、没有 Kernel / Worker 进程，也没有 /health 可探活：连接 = 校验凭据与端点，
 *    随后直接进入 ready（0 秒冷启动）；
 *  - teardown 只是断开本地引用，既不关远端（没有可关的东西），也不落待清理记录；
 *  - 实际的出图请求由 `server/image-api.js` 在 JobQueue 里发起，provider 只负责
 *    「当前配置是否可用」与「把厂商 / 模型 / Key 交给队列」。
 *
 * 配置来源：`options.getImageApiConfig()`（装配层注入 getter，保存设置后下一次调用即生效）。
 * Key 只在会话 secret 里短暂停留，**不进入 handle / 会话记录 / 快照 / 日志**。
 *
 * @module server/providers/cloud-api
 */

import { IMAGE_API } from '../../shared/contract.js'
import {
  IMAGE_API_VENDOR_IDS,
  imageApiVendorOf,
  normalizeImageApiBaseUrl,
  normalizeImageApiConfig,
} from '../../shared/image-providers.js'
import { ProviderError } from './provider.js'

/** 未配置服务商 / Key 时的可执行错误（客户端按 auth_required 给指引卡）。 */
function configError(message) {
  return new ProviderError('auth_required', message)
}

/**
 * 创建 cloud-api provider。
 *
 * @param {{ ctx?: object, log?: object, manager?: object, options?: object }} [input]
 */
export function createCloudApiProvider({ ctx = null, log = null, manager = null, options = {} } = {}) {
  /**
   * 读取当前生效配置并校验：
   *  - 服务商必须在共享清单里；
   *  - 自定义端点必须填写合法 Base URL；
   *  - Key 必填（商业 API 没有匿名调用）。
   */
  function connectionConfig() {
    const live = typeof options.getImageApiConfig === 'function' ? options.getImageApiConfig() : null
    if (!live || typeof live !== 'object') {
      throw configError('尚未配置商业生图 API：请到 设置 → 云端算力 → 商业生图 API 选择服务商并填写 API Key')
    }
    const keys = live.keys && typeof live.keys === 'object' ? live.keys : null
    const preferredVendor = imageApiVendorOf(live.vendor)
    if (!preferredVendor) {
      throw configError(`未知的生图 API 服务商：${String(live.vendor ?? '')}`)
    }
    // 方式 B：当前设置页选中的服务商若有 Key 优先用它，否则回退任意已配置 Key 的服务商。
    let activeVendor = preferredVendor
    let apiKey = typeof live.apiKey === 'string' ? live.apiKey.trim() : ''
    if (!apiKey && keys) {
      for (const id of IMAGE_API_VENDOR_IDS) {
        const candidateKey = typeof keys[id] === 'string' ? keys[id].trim() : ''
        if (candidateKey) {
          activeVendor = imageApiVendorOf(id) ?? preferredVendor
          apiKey = candidateKey
          break
        }
      }
    }
    const rawBase = activeVendor.id === 'custom'
      ? (live.customBaseUrl || (live.vendor === 'custom' ? live.baseUrl : ''))
      : (activeVendor.id === live.vendor ? live.baseUrl : '')
    const rawModel = activeVendor.id === 'custom'
      ? (live.customModel || (live.vendor === 'custom' ? live.model : ''))
      : (activeVendor.id === live.vendor ? live.model : '')
    const normalized = normalizeImageApiConfig(
      { vendor: activeVendor.id, model: rawModel, baseUrl: rawBase },
      { allowInsecure: options.allowInsecureEndpoint === true },
    )
    const baseUrl = normalized.baseUrl || activeVendor.baseUrl
    if (!baseUrl || normalizeImageApiBaseUrl(baseUrl, { allowInsecure: options.allowInsecureEndpoint === true }) === null) {
      throw configError('生图 API 的 Base URL 非法：必须是 https:// 地址（开发态允许回环 http）')
    }
    if (!apiKey) {
      throw configError(
        `尚未填写 ${activeVendor.label} 的 API Key：请到 设置 → 云端算力 → 商业生图 API 填写后重试`,
      )
    }
    if (apiKey.length > IMAGE_API.apiKeyMaxChars) {
      throw configError(`API Key 超过 ${IMAGE_API.apiKeyMaxChars} 字符上限，请检查是否粘贴了多余内容`)
    }
    return { vendor: activeVendor, model: normalized.model, baseUrl, apiKey }
  }

  return {
    id: 'cloud-api',
    kind: 'cloud-api',
    label: '商业生图 API',

    /**
     * 校验配置并返回句柄 + Key。
     *
     * 不做网络请求：商业 API 没有可探活的会话端点，真正的鉴权错误会在第一次出图时
     * 由厂商返回并被 `server/image-api.js` 归一成 `image_api_unauthorized`。
     * 这样「填 Key 即可用」不需要额外付费的探测请求。
     */
    async provision(run) {
      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        throw new ProviderError('stale', '启动流程已作废')
      }
      const { vendor, model, baseUrl, apiKey } = connectionConfig()
      log?.info?.(`cloud_api_provision ok vendor=${vendor.id} model=${model} endpoint=${baseUrl}`)
      return {
        handle: {
          kind: 'cloud-api',
          vendor: vendor.id,
          label: vendor.short,
          model,
          protocol: vendor.protocol,
          baseUrl,
        },
        token: apiKey,
      }
    },

    /** 云端 API 没有可轮询的地址：状态机在 provision 后直接进入 ready。 */
    async pollEndpoint() {
      return null
    },

    /** 无会话可探活；凭据有效性由每次出图请求自然验证。 */
    async checkAlive() {
      return { alive: true, status: 'ready' }
    },

    async keepAlive() {
      return { ok: true, detail: 'cloud-api: noop' }
    },

    /** 断开只是本地引用；商业 API 没有远端进程需要关闭。幂等。 */
    async teardown() {
      return { ok: true, detail: 'cloud-api disconnected' }
    },

    async cleanupPending() {
      return null
    },

    buildPendingCleanupRecord() {
      return null
    },

    /** 没有远端日志环：客户端按「无日志」处理。 */
    async readLogs() {
      return null
    },
  }
}

export default createCloudApiProvider
