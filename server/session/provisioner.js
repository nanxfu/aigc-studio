/**
 * 下发给远端 daemon 的注入配置；键名与 daemon 的 _KNOWN_CONFIG_KEYS 一一对应。
 *
 * 纯函数：启动编排在 SessionManager 里，这里只负责把会话参数展开成 daemon 配置，
 * 便于离线断言版本 / 契约 / 预设展开是否正确。
 *
 * P1.2 / P2.1 / P2.2 的可选项（HF Token、依赖约束、备用隧道命令、预挂载权重）只在
 * 非空时输出：旧 Host 不下发时 daemon 配置键集合保持不变。
 */

import { PRESETS, PROTOCOL_VERSION, SETTINGS, TIMEOUTS, daemonContract } from '../../shared/contract.js'
import { cleanLocalModels, normalizeModelSource } from '../../shared/validation.js'

/** 只保留非空字符串并去重；空数组表示「不下发」。 */
function cleanStrings(value) {
  if (!Array.isArray(value)) return []
  const items = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed && !items.includes(trimmed)) items.push(trimmed)
  }
  return items
}

/**
 * @param {object} input
 * @param {string} input.presetId 预设 id
 * @param {string} input.token 远端 Bearer Token
 * @param {string} input.topic ntfy 会合 topic
 * @param {number} input.idleTimeoutSec 空闲退出秒数
 * @param {string | null} [input.hfToken] HuggingFace Token（写入 daemon 的 hf_token）
 * @param {'huggingface' | 'hf-mirror' | 'modelscope'} [input.modelSource] 模型下载源（非默认时写入 daemon 的 model_source）
 * @param {string[]} [input.pipConstraints] pip 依赖约束（包名覆盖内置默认上限）
 * @param {string[]} [input.fallbackTunnelCommand] 备用隧道 argv 模板（支持 {port} 占位）
 * @param {string | null} [input.fallbackTunnelUrlRegex] 备用通道输出里提取地址的正则
 * @param {Record<string, string> | null} [input.localModels] 预挂载权重：repo → 容器内目录
 * @returns {object} daemon 注入配置
 */
export function buildKernelConfig({
  presetId,
  token,
  topic,
  idleTimeoutSec,
  hfToken = null,
  modelSource = SETTINGS.defaultModelSource,
  pipConstraints = [],
  fallbackTunnelCommand = [],
  fallbackTunnelUrlRegex = null,
  localModels = null,
}) {
  const knownPreset = PRESETS.find((item) => item.id === presetId) ?? null
  const config = {
    auth_token: token,
    ntfy_topic: topic,
    idle_timeout_sec: idleTimeoutSec,
    // 启动后等待 Host 接管的时限（秒）：超过仍没有带 Token 的请求，daemon 自行退出，
    // 回收「放弃排队后仍被调度到」的孤儿 Kernel。旧 Host 不下发时 daemon 用同值默认。
    claim_timeout_sec: TIMEOUTS.kernelClaimSec,
    // daemon 只认完整 pipeline 描述；非扩散预设（如工坊算子 birefnet / rmbg-2.0 / marigold
    // 或 upscale）不回落到默认 SDXL，避免只为抠图却在启动期白下载 ~7.8 GB 扩散底模。
    preload: knownPreset ? knownPreset.pipeline : null,
    preset_id: presetId,
    log_level: 'info',
    // 版本与协议契约同源（shared/contract.js）：daemon 侧按 config.contract 校验参数边界。
    // `version` 从 M3.0 起表示**协议版本**（不再是产品版本）；私有 Worker 可以独立升级。
    version: PROTOCOL_VERSION,
    contract: daemonContract(),
  }

  // 可选注入：空值/默认值不输出，保持与旧 Host 相同的配置键集合。
  if (typeof hfToken === 'string' && hfToken.trim()) config.hf_token = hfToken.trim()
  const source = normalizeModelSource(modelSource)
  if (source !== SETTINGS.defaultModelSource) config.model_source = source

  const constraints = cleanStrings(pipConstraints)
  if (constraints.length) config.pip_constraints = constraints

  const tunnelCommand = cleanStrings(fallbackTunnelCommand)
  if (tunnelCommand.length) config.fallback_tunnel_command = tunnelCommand
  if (typeof fallbackTunnelUrlRegex === 'string' && fallbackTunnelUrlRegex.trim()) {
    config.fallback_tunnel_url_regex = fallbackTunnelUrlRegex.trim()
  }

  const mounted = cleanLocalModels(localModels)
  if (Object.keys(mounted).length) config.local_models = mounted

  return config
}