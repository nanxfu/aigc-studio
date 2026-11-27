/**
 * SaladCloud 按秒容器算力（M3.6）。
 *
 * 与私有 Worker 的差异：
 *  - 容器组由 Host 创建 / 删除，不能假设地址长期存在；
 *  - 镜像里不含权重，模型在首个任务命中后由 hf-xet 拉到容器临时盘；
 *  - Container Gateway 在冷启动期可能长时间 `downloading`，本 Provider 在
 *    downloading/creating 超过阈值时自动 reallocate，逃离慢节点；
 *  - 应用退出 / 崩溃后必须删除容器组，避免按秒计费持续燃烧。
 *
 * 设计约束：
 *  - API Key 只在进程内使用，不进入 handle / 日志 / 快照；
 *  - 所有网络请求走 `httpText`（fetch 失败时自动降级系统 curl）；
 *  - 单拍轮询不建定时器，节奏由 SessionManager 控制；
 *  - 创建前先同步写待清理记录，异常退出后由启动补清理删除容器组。
 *
 * @module server/providers/salad
 */

import { randomBytes } from 'node:crypto'

import { PRESETS, SALAD, TIMEOUTS } from '../../shared/contract.js'
import { httpText } from '../net.js'
import { requestLogs } from '../remote.js'
import { logText } from '../redact.js'
import { clearPendingCleanup, readPendingCleanup, writePendingCleanup } from '../session/pending-cleanup.js'
import { ProviderError } from './provider.js'

export const SALAD_GROUP_PREFIX = 'aigc-studio-'

/**
 * 隐藏显卡池。主设置面只暴露档位；这里按档位维护「先质量、再性价比」的顺序，
 * 真正落单前还会按模型显存与实时价格过滤。环境变量 AIGC_STUDIO_SALAD_GPU
 * 只用于排障，不进入 UI。
 */
export const SALAD_GPU_POOLS = Object.freeze({
  high: Object.freeze([
    'RTX 4090 (24 GB)',
    'RTX 3090 (24 GB)',
    'RTX A5000 (24 GB)',
    'RTX A6000 (48 GB)',
  ]),
  medium: Object.freeze([
    'RTX 3090 (24 GB)',
    'RTX 4090 (24 GB)',
    'RTX 4060 Ti (16 GB)',
    'RTX 3060 (12 GB)',
    'RTX A5000 (24 GB)',
  ]),
  low: Object.freeze([
    'RTX 4060 Ti (16 GB)',
    'RTX 3060 (12 GB)',
    'RTX A2000 (12 GB)',
    'RTX 3090 (24 GB)',
  ]),
  batch: Object.freeze([
    'RTX 3060 (12 GB)',
    'RTX 4060 Ti (16 GB)',
    'RTX A5000 (24 GB)',
  ]),
})

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

function stringOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteOf(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/** 组织 / 项目 id：与 Settings 保存共用同一口径。 */
export function saladIdOf(value, kind = 'org') {
  const text = stringOf(value).toLowerCase()
  const pattern = kind === 'project' ? SALAD.projectPattern : SALAD.orgPattern
  return text && pattern.test(text) ? text : ''
}

/** 档位归一：非法值回到默认 medium。 */
export function saladTierOf(value) {
  return SALAD.tierIds.includes(value) ? value : SALAD.defaultTier
}

/** 从模型资产估算单卡 Salad 需要的显存（双卡资产需乘以 gpus；峰值 + 2GB 余量，最低 12GB）。 */
export function requiredVramGbOf(presetId, variantId = '') {
  const preset = PRESETS.find((item) => item.id === presetId)
  const variant = variantId
    ? (Array.isArray(preset?.variants) ? preset.variants.find((item) => item.id === variantId) : null)
    : null
  const peakMb = finiteOf(variant?.peakVramMb ?? preset?.peakVramMb ?? preset?.measured?.peakVramMb, 0)
  if (peakMb <= 0) return 16
  const gpus = Math.max(1, finiteOf(preset?.gpus, 1))
  return Math.max(12, Math.min(48, Math.ceil((peakMb * gpus) / 1024) + 2))
}

/**
 * 按模型权重体量决定容器内存与临时盘：
 * 社区 3090 节点常见 32GB 物理内存（扣系统占用后容器可分 < 32GB），轻量模型只申 16GB
 * 可显著扩大可用节点池；15GB 以上或开启 cpuOffload 的大模型再抬升到 24GB + 80GB 盘。
 */
export function saladResourcesFor(presetId, variantId = '') {
  const preset = PRESETS.find((item) => item.id === presetId)
  const variant = variantId
    ? (Array.isArray(preset?.variants) ? preset.variants.find((item) => item.id === variantId) : null)
    : null
  const pipeline = variant?.pipeline && typeof variant.pipeline === 'object'
    ? variant.pipeline
    : preset?.pipeline
  const downloadGb = finiteOf(variant?.downloadGb ?? pipeline?.downloadGb ?? preset?.downloadGb, 0)
  const cpuOffload = pipeline?.cpuOffload === true
  const heavy = downloadGb >= 15 || cpuOffload
  return {
    cpu: SALAD.cpu,
    memoryMb: heavy ? SALAD.heavyMemoryMb : SALAD.memoryMb,
    storageGb: heavy ? SALAD.storageGb : SALAD.lightStorageGb,
  }
}

function vramGbOf(name) {
  const match = /\((\d+)\s*GB\)/i.exec(String(name ?? ''))
  return match ? Number(match[1]) : 0
}

function priceMapOf(prices) {
  const out = {}
  if (!Array.isArray(prices)) return out
  for (const item of prices) {
    if (!item?.priority) continue
    out[item.priority] = finiteOf(item.price, Number.POSITIVE_INFINITY)
  }
  return out
}

function normalizedGpuClasses(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
    .map((item) => ({
      id: item.id,
      name: item.name,
      vramGb: vramGbOf(item.name),
      highDemand: item.is_high_demand === true,
      prices: priceMapOf(item.prices),
    }))
    .filter((item) => item.vramGb > 0 && !/\b(?:amd|gtx)\b/i.test(item.name))
}

/**
 * 按档位 + 模型显存选卡。
 *
 * 顺序：隐藏覆盖 > 档位白名单 > 同档位其余满足显存的卡（按单价）。
 * 高需求卡不直接排除，但排在同档位其它卡之后。
 *
 * @param {Array<object>} items /gpu-classes 的 items
 * @param {{ tier?: string, requiredVramGb?: number, override?: string }} input
 * @returns {object}
 */
export function pickSaladGpu(items, { tier = SALAD.defaultTier, requiredVramGb = 12, override = '' } = {}) {
  const classes = normalizedGpuClasses(items)
  const required = Math.max(1, finiteOf(requiredVramGb, 12))
  const usable = classes.filter((item) => item.vramGb >= required)
  if (usable.length === 0) {
    throw new ProviderError(
      'gpu_unavailable',
      `Salad 当前没有满足 ${required}GB 显存的可用显卡；可换低显存模型、提高档位或稍后重试`,
    )
  }

  const wanted = stringOf(override).toLowerCase()
  if (wanted) {
    const exact = usable.find((item) => item.name.toLowerCase() === wanted)
      ?? usable.find((item) => item.name.toLowerCase().startsWith(`${wanted} (`))
      ?? usable.find((item) => item.name.toLowerCase().includes(wanted))
    if (exact) return { ...exact, tier, requiredVramGb: required }
  }

  const pool = SALAD_GPU_POOLS[saladTierOf(tier)] ?? SALAD_GPU_POOLS[SALAD.defaultTier]
  for (const name of pool) {
    const item = usable.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    if (item) return { ...item, tier, requiredVramGb: required }
  }

  const ranked = [...usable].sort((left, right) => {
    if (left.highDemand !== right.highDemand) return left.highDemand ? 1 : -1
    const leftPrice = finiteOf(left.prices[tier], Number.POSITIVE_INFINITY)
    const rightPrice = finiteOf(right.prices[tier], Number.POSITIVE_INFINITY)
    if (leftPrice !== rightPrice) return leftPrice - rightPrice
    return left.vramGb - right.vramGb
  })
  return { ...ranked[0], tier, requiredVramGb: required }
}

/**
 * 组装创建容器组请求。保持 cell-free：测试可直接断言请求体。
 */
export function buildSaladContainerSpec({
  hfToken = '',
  groupName,
  gpu,
  tier = SALAD.defaultTier,
  workerToken,
  image = SALAD.workerImage,
  countryCodes = SALAD.countryCodes,
  presetId = '',
  variantId = '',
}) {
  const port = SALAD.workerPort
  const res = saladResourcesFor(presetId, variantId)
  return {
    name: groupName,
    // Salad display_name 只允许字母、数字、空格、逗号、点和短横线；不能用 `/`。
    display_name: `AIGC Studio - ${String(presetId || 'worker').slice(0, 40)}${variantId ? ` - ${variantId}` : ''}`.slice(0, 64),
    autostart_policy: true,
    restart_policy: 'always',
    replicas: 1,
    priority: saladTierOf(tier),
    ...(countryCodes.length > 0 ? { country_codes: [...countryCodes] } : {}),
    container: {
      image,
      image_caching: true,
      environment_variables: {
        ...(hfToken ? { HF_TOKEN: hfToken } : {}),
        AIGC_WORKER_TOKEN: workerToken,
        AIGC_WORKER_HOST: 'auto',
        AIGC_WORKER_PORT: String(port),
        AIGC_WORKER_CPU_OFFLOAD: Number(gpu?.vramGb) >= 48 ? 'off' : 'auto',
        HF_HOME: '/tmp/hf',
        HF_HUB_CACHE: '/tmp/hf/hub',
        HF_XET_HIGH_PERFORMANCE: '1',
      },
      resources: {
        cpu: res.cpu,
        memory: res.memoryMb,
        gpu_classes: [gpu.id],
        // Salad 的 storage_amount 单位是 byte；轻量 50GB / 大模型 80GB。
        storage_amount: res.storageGb * 1024 * 1024 * 1024,
      },
    },
    networking: {
      protocol: 'http',
      port,
      auth: false,
    },
    startup_probe: {
      http: { path: '/healthz', port, scheme: 'http', headers: [] },
      initial_delay_seconds: 2,
      period_seconds: 5,
      timeout_seconds: 5,
      success_threshold: 1,
      failure_threshold: 20,
    },
  }
}

/** Salad API 错误体 → 可执行错误；不把 API Key / 完整响应写入日志。 */
function saladErrorOf(status, text, method, pathname) {
  let detail = ''
  try {
    const parsed = JSON.parse(text)
    if (parsed?.errors && typeof parsed.errors === 'object') {
      detail = Object.entries(parsed.errors)
        .map(([field, messages]) => {
          const values = Array.isArray(messages) ? messages.map(stringOf).filter(Boolean) : [stringOf(messages)]
          return `${field}: ${values.filter(Boolean).join('; ')}`
        })
        .filter(Boolean)
        .join(' | ')
    }
    detail = detail || stringOf(parsed?.detail) || stringOf(parsed?.title) || stringOf(parsed?.message)
  } catch {
    detail = stringOf(text).slice(0, 300)
  }
  const suffix = detail ? `：${detail.slice(0, 500)}` : ''
  let code = 'push_failed'
  if (!status) code = 'worker_unreachable'
  else if (status === 401 || status === 403) code = 'auth_required'
  else if (status === 404 || status >= 500) code = 'remote_error'
  else if (status === 429) code = 'gpu_unavailable'

  let message = `Salad API ${method} ${pathname} 失败（HTTP ${status}）${suffix}`
  if (code === 'auth_required') {
    message = 'Salad API Key 无效或无权限：请在 设置 → 云端算力 → SaladCloud 重新填写后测试'
  } else if (code === 'worker_unreachable') {
    message = `Salad API 不可达${suffix || '：请检查网络或系统代理后重试'}`
  } else if (code === 'gpu_unavailable') {
    message = `Salad 当前限制创建请求（HTTP ${status}），请稍后重试${suffix}`
  }
  const error = new ProviderError(code, message)
  error.status = status
  try {
    error.body = JSON.parse(text)
  } catch {}
  return error
}

/**
 * Salad REST 客户端。默认走 httpText；测试可替换 `fetchText`。
 */
export function createSaladApi({
  ctx = null,
  fetchText = httpText,
  baseUrl = SALAD.apiBaseUrl,
  timeoutMs = SALAD.requestTimeoutMs,
  log = null,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '')

  async function request({
    method = 'GET',
    pathname,
    apiKey,
    body = null,
    signal = null,
    allow404 = false,
    retries = method === 'GET' || method === 'DELETE' ? 2 : 0,
  }) {
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
      let result
      try {
        result = await fetchText(ctx, `${root}${pathname}`, {
          method,
          headers: {
            'Salad-Api-Key': apiKey,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : null,
          timeoutMs,
          maxBytes: 2 * 1024 * 1024,
          signal: signal ?? undefined,
        })
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw error
        if (attempt >= retries) {
          throw new ProviderError('worker_unreachable', `无法连接 Salad API：${error?.message ?? error}`, { cause: error })
        }
        await delay(600 * (attempt + 1), signal)
        continue
      }

      if (allow404 && result.status === 404) return null
      if (result.ok) {
        if (!result.text) return null
        try {
          return JSON.parse(result.text)
        } catch {
          throw new ProviderError('remote_error', `Salad API ${method} ${pathname} 返回了非 JSON 响应`)
        }
      }

      if ((result.status === 429 || result.status >= 500) && attempt < retries) {
        lastError = saladErrorOf(result.status, result.text, method, pathname)
        await delay(800 * (attempt + 1), signal)
        continue
      }
      throw saladErrorOf(result.status, result.text, method, pathname)
    }
    throw lastError ?? new ProviderError('remote_error', `Salad API ${method} ${pathname} 多次重试仍失败`)
  }

  function projectPath(org, project, suffix = '') {
    return `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}${suffix}`
  }

  return {
    listGpuClasses({ org, apiKey, signal }) {
      return request({ pathname: `/organizations/${encodeURIComponent(org)}/gpu-classes`, apiKey, signal })
    },

    getQuotas({ org, apiKey, signal }) {
      return request({ pathname: `/organizations/${encodeURIComponent(org)}/quotas`, apiKey, signal })
    },

    listContainers({ org, project, apiKey, signal }) {
      return request({ pathname: projectPath(org, project, '/containers'), apiKey, signal })
    },

    getContainer({ org, project, name, apiKey, signal, allow404 = false }) {
      return request({
        pathname: projectPath(org, project, `/containers/${encodeURIComponent(name)}`),
        apiKey,
        signal,
        allow404,
      })
    },

    listInstances({ org, project, name, apiKey, signal, allow404 = true }) {
      return request({
        pathname: projectPath(org, project, `/containers/${encodeURIComponent(name)}/instances`),
        apiKey,
        signal,
        allow404,
      })
    },

    createContainer({ org, project, body, apiKey, signal }) {
      return request({
        method: 'POST',
        pathname: projectPath(org, project, '/containers'),
        apiKey,
        body,
        signal,
        retries: 0,
      })
    },

    deleteContainer({ org, project, name, apiKey, signal, allow404 = true }) {
      return request({
        method: 'DELETE',
        pathname: projectPath(org, project, `/containers/${encodeURIComponent(name)}`),
        apiKey,
        signal,
        allow404,
      })
    },

    reallocateInstance({ org, project, groupName, instanceId, apiKey, signal }) {
      return request({
        method: 'POST',
        pathname: projectPath(
          org,
          project,
          `/containers/${encodeURIComponent(groupName)}/instances/${encodeURIComponent(instanceId)}/reallocate`,
        ),
        apiKey,
        signal,
        retries: 0,
      })
    },
  }
}

/**
 * 只读连接测试：组织配额 / 现有容器组 / 可用显卡目录。不创建任何资源。
 */
export async function probeSaladAccount({
  config,
  api = null,
  ctx = null,
  signal = null,
} = {}) {
  const apiKey = stringOf(config?.apiKey)
  const org = saladIdOf(config?.org)
  const project = saladIdOf(config?.project, 'project') || SALAD.defaultProject
  if (!apiKey) {
    return {
      ok: false,
      org,
      project,
      error: { code: 'auth_required', message: '尚未填写 Salad API Key' },
    }
  }
  if (apiKey.length > SALAD.apiKeyMaxChars) {
    return {
      ok: false,
      org,
      project,
      error: {
        code: 'invalid_request',
        message: `Salad API Key 超过 ${SALAD.apiKeyMaxChars} 字符，请检查是否粘贴了多余内容`,
      },
    }
  }
  if (!org) {
    return {
      ok: false,
      org,
      project,
      error: { code: 'invalid_request', message: 'Salad 组织（org）不能为空，且只能包含小写字母、数字和连字符' },
    }
  }

  const client = api ?? createSaladApi({ ctx })
  try {
    const [quotas, containers, gpus] = await Promise.all([
      client.getQuotas({ org, apiKey, signal }),
      client.listContainers({ org, project, apiKey, signal }),
      client.listGpuClasses({ org, apiKey, signal }),
    ])
    const quota = quotas?.container_groups_quotas ?? {}
    return {
      ok: true,
      org,
      project,
      quota: {
        replicasUsed: finiteOf(quota.container_replicas_used, 0),
        replicasQuota: finiteOf(quota.container_replicas_quota, 0),
      },
      existingContainers: Array.isArray(containers?.items) ? containers.items.length : 0,
      gpuClasses: Array.isArray(gpus?.items) ? gpus.items.length : 0,
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      org,
      project,
      error: {
        code: error?.code ?? 'remote_error',
        message: String(error?.message ?? error).slice(0, 600),
      },
    }
  }
}

function groupNameOf(handle, tracking) {
  return stringOf(handle?.groupName) || stringOf(handle?.workerId) || tracking?.groupName || ''
}

function endpointOfState(state) {
  const dns = stringOf(state?.networking?.dns)
  return dns ? `https://${dns}` : ''
}

/**
 * 创建 Salad Provider。
 *
 * @param {{ ctx?: object, log?: object, manager?: object, options?: object, api?: object }} [input]
 */
export function createSaladProvider({
  ctx = null,
  log = null,
  manager = null,
  options = {},
  api: injectedApi = null,
} = {}) {
  const api = injectedApi ?? createSaladApi({
    ctx,
    baseUrl: options.saladApiBaseUrl ?? SALAD.apiBaseUrl,
    log,
  })
  const reallocateAfterMs = Math.max(1, finiteOf(options.reallocateAfterMs, SALAD.reallocateAfterMs))
  const maxReallocations = Math.max(0, finiteOf(options.maxReallocations, SALAD.maxReallocations))
  const provisionDeadlineMs = Math.max(
    reallocateAfterMs,
    finiteOf(options.provisionDeadlineMs, SALAD.provisionDeadlineMs),
  )
  const image = stringOf(options.image) || SALAD.workerImage
  const countryCodes = Array.isArray(options.countryCodes)
    ? options.countryCodes.map((item) => stringOf(item).toLowerCase()).filter(Boolean)
    : [...SALAD.countryCodes]
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const tracking = new Map()
  let currentGroupName = ''

  function saladConfig() {
    const live = typeof options.getSaladConfig === 'function' ? options.getSaladConfig() : options.saladConfig
    const config = live && typeof live === 'object' ? live : {}
    const apiKey = stringOf(config.apiKey)
    const org = saladIdOf(config.org)
    const project = saladIdOf(config.project, 'project') || SALAD.defaultProject
    const tier = saladTierOf(config.tier)
    if (!apiKey) {
      throw new ProviderError(
        'auth_required',
        '尚未配置 SaladCloud：请到 设置 → 云端算力 → SaladCloud 填写 API Key / 组织后重试',
      )
    }
    if (apiKey.length > SALAD.apiKeyMaxChars) {
      throw new ProviderError(
        'auth_required',
        `Salad API Key 超过 ${SALAD.apiKeyMaxChars} 字符，请检查是否粘贴了多余内容`,
      )
    }
    if (!org) {
      throw new ProviderError(
        'auth_required',
        'SaladCloud 组织（org）未配置或格式不合法：请填写仅含小写字母、数字和连字符的组织 id',
      )
    }
    return { apiKey, org, project, tier }
  }

  function trackingFor(handle = {}) {
    const groupName = groupNameOf(handle)
    if (!groupName) return null
    let item = tracking.get(groupName)
    if (!item) {
      item = {
        groupName,
        endpointUrl: stringOf(handle.endpointUrl),
        machineId: '',
        machineAssignedAt: 0,
        creatingAt: 0,
        pullProgress: null,
        lastProgressAt: 0,
        pollFailures: 0,
        createdAt: now(),
        reallocations: 0,
        lastState: '',
        tier: saladTierOf(handle.tier),
        gpuName: stringOf(handle.gpuName),
      }
      tracking.set(groupName, item)
    }
    return item
  }

  async function clearOwnedPending(groupName) {
    if (!ctx || !groupName) return
    try {
      const record = await readPendingCleanup(ctx)
      if (record?.provider === 'salad' && record.groupName === groupName) {
        await clearPendingCleanup(ctx)
      }
    } catch {}
  }

  async function deleteGroup(config, groupName) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await api.deleteContainer({
          org: config.org,
          project: config.project,
          name: groupName,
          apiKey: config.apiKey,
          allow404: true,
        })
        return true
      } catch (error) {
        lastError = error
        if (attempt < 2) await delay(700 * (attempt + 1)).catch(() => {})
      }
    }
    log?.warn?.(
      `salad_delete_failed group=${groupName} code=${lastError?.code ?? 'none'} ` +
        `detail=${logText(lastError?.message, 240)}`,
    )
    return false
  }

  return {
    id: 'salad',
    kind: 'worker',
    label: 'SaladCloud',

    async provision(run, { presetId = '', variantId = '', onProgress = () => {} } = {}) {
      const config = saladConfig()
      const requiredVramGb = requiredVramGbOf(presetId, variantId)
      onProgress({ phase: 'push', detail: '正在查询 Salad 实时显卡与账户配额' })

      const [gpuDoc, quotaDoc] = await Promise.all([
        api.listGpuClasses({ org: config.org, apiKey: config.apiKey, signal: run?.signal }),
        api.getQuotas({ org: config.org, apiKey: config.apiKey, signal: run?.signal }).catch(() => null),
      ])
      const quota = quotaDoc?.container_groups_quotas ?? {}
      const used = finiteOf(quota.container_replicas_used, 0)
      const limit = finiteOf(quota.container_replicas_quota, 0)
      if (limit > 0 && used >= limit) {
        throw new ProviderError(
          'gpu_unavailable',
          `Salad 容器副本配额已用尽（${used}/${limit}）：请先停止不再使用的容器组或提高组织配额`,
        )
      }

      const gpu = pickSaladGpu(gpuDoc?.items, {
        tier: config.tier,
        requiredVramGb,
        override: stringOf(options.gpuOverride ?? process.env.AIGC_STUDIO_SALAD_GPU),
      })
      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        throw new ProviderError('stale', '启动流程已作废')
      }

      const groupName = `${SALAD_GROUP_PREFIX}${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
      const workerToken = randomBytes(32).toString('hex')
      const record = {
        version: 2,
        provider: 'salad',
        savedAt: new Date(now()).toISOString(),
        groupName,
        endpointUrl: null,
        attempts: 0,
      }
      const markerOk = ctx
        ? await writePendingCleanup(ctx, record)
          .then((value) => Boolean(value))
          .catch(() => false)
        : false
      if (!markerOk) {
        throw new ProviderError(
          'push_failed',
          '无法写入 Salad 待清理记录，已取消创建容器（避免应用异常退出后持续计费）',
        )
      }

      const spec = buildSaladContainerSpec({
        hfToken: options.getHfToken?.() || '',
        groupName,
        gpu,
        tier: config.tier,
        workerToken,
        image,
        countryCodes,
        presetId,
        variantId,
      })
      onProgress({
        phase: 'queue',
        detail: `正在创建 Salad ${gpu.name} 容器（${config.tier} 档）`,
        persist: true,
      })

      let created
      try {
        created = await api.createContainer({
          org: config.org,
          project: config.project,
          body: spec,
          apiKey: config.apiKey,
          signal: run?.signal,
        })
      } catch (error) {
        if (error?.code === 'stale' || error?.name === 'AbortError') throw error
        const existing = await api.getContainer({
          org: config.org,
          project: config.project,
          name: groupName,
          apiKey: config.apiKey,
          signal: run?.signal,
          allow404: true,
        }).catch(() => null)
        if (!existing) {
          await clearOwnedPending(groupName)
          throw error
        }
        created = existing
      }

      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        await deleteGroup(config, groupName)
        await clearOwnedPending(groupName)
        throw new ProviderError('stale', '启动流程已作废')
      }

      currentGroupName = groupName
      const endpointUrl = endpointOfState(created)
      const handle = {
        kind: 'worker',
        provider: 'salad',
        workerId: groupName,
        groupName,
        endpointUrl: endpointUrl || null,
        protocolVersion: null,
        owned: true,
        awaitEndpoint: true,
        tier: config.tier,
        gpuName: gpu.name,
      }
      tracking.set(groupName, {
        groupName,
        endpointUrl,
        machineId: '',
        machineAssignedAt: 0,
        creatingAt: 0,
        pullProgress: null,
        lastProgressAt: 0,
        pollFailures: 0,
        createdAt: now(),
        reallocations: 0,
        lastState: '',
        tier: config.tier,
        gpuName: gpu.name,
      })
      if (endpointUrl) {
        await writePendingCleanup(ctx, { ...record, endpointUrl }).catch(() => null)
      }
      onProgress({
        phase: 'queue',
        detail: `Salad 容器已提交（${gpu.name} · ${config.tier}），等待镜像与节点就绪`,
        persist: true,
      })
      log?.info?.(
        `salad_provision created group=${groupName} gpu=${gpu.name} tier=${config.tier} ` +
          `requiredVram=${requiredVramGb}GB endpoint=${endpointUrl ? 'assigned' : 'pending'}`,
      )
      return { handle, token: workerToken }
    },

    /**
     * 单拍检查容器状态；downloading/creating 卡在同一个机器超过阈值时免费 reallocate。
     * 地址只在容器组进入 running 后返回，避免状态机过早按 /health 失败收敛。
     */
    async pollEndpoint(run, handle = {}) {
      const config = saladConfig()
      const groupName = groupNameOf(handle, trackingFor(handle))
      if (!groupName) throw new ProviderError('gpu_unavailable', 'Salad 容器句柄缺少容器组名称')
      const item = trackingFor(handle)
      let state
      let instancesDoc
      try {
        ;[state, instancesDoc] = await Promise.all([
          api.getContainer({
            org: config.org,
            project: config.project,
            name: groupName,
            apiKey: config.apiKey,
            signal: run?.signal,
            allow404: true,
          }),
          api.listInstances({
            org: config.org,
            project: config.project,
            name: groupName,
            apiKey: config.apiKey,
            signal: run?.signal,
            allow404: true,
          }).catch(() => null),
        ])
        item.pollFailures = 0
      } catch (error) {
        const transient = error?.code === 'worker_unreachable' || error?.code === 'remote_error'
        if (!transient) throw error
        item.pollFailures = (item.pollFailures ?? 0) + 1
        log?.warn?.(
          `salad_poll_transient group=${groupName} failures=${item.pollFailures}/5 code=${error.code} ` +
            `detail=${logText(error?.message, 200)}`,
        )
        if (item.pollFailures < 5) return null
        throw error
      }
      if (!state) {
        throw new ProviderError('gpu_unavailable', 'Salad 容器组已不存在（可能被删除或配额回收），请重新连接')
      }

      const status = stringOf(state.current_state?.status) || 'unknown'
      const instance = Array.isArray(instancesDoc?.instances) ? instancesDoc.instances[0] : null
      const instanceId = stringOf(instance?.id)
      const machineId = stringOf(instance?.machine_id)
      const instanceState = stringOf(instance?.state) || status
      const timestamp = now()
      const pullProgress = Number.isFinite(Number(instance?.pulling_progress))
        ? Math.max(0, Math.min(1, Number(instance.pulling_progress)))
        : null

      if (machineId && machineId !== item.machineId) {
        item.machineId = machineId
        item.machineAssignedAt = timestamp
        item.creatingAt = 0
        item.pullProgress = null
        item.lastProgressAt = timestamp
      }
      if (instanceState === 'creating' && !item.creatingAt) {
        item.creatingAt = timestamp
      }
      if (pullProgress !== null) {
        const moved = item.pullProgress === null || pullProgress - item.pullProgress >= 0.01
        if (moved) {
          item.pullProgress = pullProgress
          item.lastProgressAt = timestamp
          log?.info?.(`salad_pull group=${groupName} progress=${(pullProgress * 100).toFixed(1)}%`)
        }
      }
      const stateLine = `${status}/${instanceState}/${machineId}`
      if (stateLine !== item.lastState) {
        item.lastState = stateLine
        log?.info?.(
          `salad_poll group=${groupName} status=${status} instance=${instanceState || 'none'} ` +
            `machine=${machineId ? machineId.slice(0, 8) : 'none'}` +
            `${pullProgress !== null ? ` pull=${(pullProgress * 100).toFixed(1)}%` : ''}`,
        )
      }

      if (status === 'failed' || status === 'stopped' || status === 'deleted') {
        throw new ProviderError(
          'gpu_unavailable',
          `Salad 容器组已${status === 'failed' ? '失败' : '停止'}（${status}），请重新连接`,
        )
      }

      if (status !== 'running' && timestamp - item.createdAt >= provisionDeadlineMs) {
        const minutes = Math.round(provisionDeadlineMs / 60000)
        throw new ProviderError(
          'queue_timeout',
          `Salad 容器在 ${minutes} 分钟内未进入 running（最后状态 ${status}/${instanceState}）；` +
            '本次启动已停止并删除容器，避免继续计费',
        )
      }

      // 两段式慢节点逃逸：
      //  - 同机满 1 轮（默认 180s）连 25% 都未到（预计 >12 分钟）：立刻换机；
      //  - 同机满 2 轮（默认 360s）仍未到 65%：换机；
      //  - 已到 65% 或正在 creating 时，只在停滞无进度超过 1 轮时换机，避免把 45%/3min 的稳健节点踢回 0%。
      const onMachineMs = item.machineAssignedAt > 0 ? timestamp - item.machineAssignedAt : 0
      const downloadTooSlow = instanceState === 'downloading'
        && (
          (onMachineMs >= reallocateAfterMs && (pullProgress === null || pullProgress < 0.25))
          || (onMachineMs >= reallocateAfterMs * 2 && (pullProgress === null || pullProgress < 0.65))
        )
      const stalledNearEnd = instanceState === 'downloading'
        && pullProgress !== null
        && pullProgress >= 0.65
        && timestamp - Math.max(item.machineAssignedAt, item.lastProgressAt) >= reallocateAfterMs
      const creatingStalled = instanceState === 'creating'
        && item.creatingAt > 0
        && timestamp - item.creatingAt >= reallocateAfterMs
      const stuck = Boolean(instanceId && machineId && item.machineAssignedAt > 0)
        && (downloadTooSlow || stalledNearEnd || creatingStalled)
      if (stuck && item.reallocations < maxReallocations) {
        const stuckMs = timestamp - item.machineAssignedAt
        item.reallocations += 1
        item.machineAssignedAt = timestamp
        log?.warn?.(
          `salad_reallocate group=${groupName} attempt=${item.reallocations}/${maxReallocations} ` +
            `state=${instanceState} machine=${machineId.slice(0, 8)} stuckMs=${stuckMs}`,
        )
        try {
          await api.reallocateInstance({
            org: config.org,
            project: config.project,
            groupName,
            instanceId,
            apiKey: config.apiKey,
            signal: run?.signal,
          })
          item.machineId = ''
          item.creatingAt = 0
          item.pullProgress = null
          item.lastState = ''
        } catch (error) {
          log?.warn?.(
            `salad_reallocate_failed group=${groupName} code=${error?.code ?? 'none'} ` +
              `detail=${logText(error?.message, 240)}`,
          )
        }
      }

      if (status === 'running') {
        const endpointUrl = endpointOfState(state) || item.endpointUrl
        if (endpointUrl) {
          item.endpointUrl = endpointUrl
          return { endpointUrl }
        }
      }
      return null
    },

    /** ready 后心跳丢失时查容器组；容器仍 running 就留给健康轮询继续重试。 */
    async checkAlive(run, handle = {}) {
      let config
      try {
        config = saladConfig()
      } catch (error) {
        return { alive: false, status: error?.code ?? 'auth_required', missing: false }
      }
      const groupName = groupNameOf(handle, trackingFor(handle))
      if (!groupName) return { alive: false, status: 'gpu_unavailable', missing: true }
      try {
        const state = await api.getContainer({
          org: config.org,
          project: config.project,
          name: groupName,
          apiKey: config.apiKey,
          signal: run?.signal,
          allow404: true,
        })
        if (!state) return { alive: false, status: 'gpu_unavailable', missing: true }
        const status = stringOf(state.current_state?.status) || 'unknown'
        if (status === 'failed' || status === 'stopped' || status === 'deleted') {
          return { alive: false, status, missing: false }
        }
        return { alive: true, status }
      } catch (error) {
        return { alive: false, status: error?.code ?? 'worker_unreachable', missing: false }
      }
    },

    async keepAlive() {
      return { ok: true, detail: 'salad: group managed by host' }
    },

    /** 删除容器组；404 视为已释放。重复调用幂等。 */
    async teardown(run, handle = {}) {
      let config
      try {
        config = saladConfig()
      } catch (error) {
        return { ok: false, detail: error?.message ?? 'salad config missing' }
      }
      const groupName = groupNameOf(handle)
      if (!groupName) return { ok: true, detail: 'salad: no group' }
      const ok = await deleteGroup(config, groupName)
      if (ok) {
        tracking.delete(groupName)
        if (currentGroupName === groupName) currentGroupName = ''
        await clearOwnedPending(groupName)
      }
      return { ok, detail: ok ? 'salad container deleted' : 'salad delete failed' }
    },

    /**
     * 启动补清理：删除上次退出留下的容器组。
     * 与 Kaggle 不同，Salad 不设 24h TTL——过期记录仍可能对应持续计费的容器；
     * 只有 API 明确返回 404（已释放）才清记录。
     */
    async cleanupPending(record) {
      if (!record || record.provider !== 'salad') return null
      const groupName = stringOf(record.groupName)
      if (!groupName.startsWith(SALAD_GROUP_PREFIX)) {
        manager?.log?.warn?.(`pending_cleanup_discard reason=invalid_group provider=salad`)
        await clearPendingCleanup(ctx)
        return false
      }
      let config
      try {
        config = saladConfig()
      } catch (error) {
        manager?.log?.warn?.(`pending_cleanup_retry provider=salad reason=${error?.code ?? 'config'}`)
        return false
      }
      const attempts = Math.max(0, finiteOf(record.attempts, 0))
      try {
        await api.deleteContainer({
          org: config.org,
          project: config.project,
          name: groupName,
          apiKey: config.apiKey,
          allow404: true,
        })
      } catch (error) {
        const nextAttempts = attempts + 1
        manager?.log?.warn?.(
          `pending_cleanup_retry provider=salad attempt=${nextAttempts} group=${groupName} ` +
            `code=${error?.code ?? 'none'}`,
        )
        await writePendingCleanup(ctx, { ...record, attempts: nextAttempts }).catch(() => null)
        return false
      }
      manager?.log?.info?.(`pending_cleanup_done provider=salad group=${groupName}`)
      if (currentGroupName === groupName) currentGroupName = ''
      tracking.delete(groupName)
      await clearPendingCleanup(ctx)
      await manager?.clearPersistedSession?.()
      return true
    },

    /** 卸载时同步落盘的补清理记录（容器组名是删除所需的最小信息）。 */
    buildPendingCleanupRecord() {
      const groupName = currentGroupName || [...tracking.keys()].at(-1) || ''
      if (!groupName) return null
      return {
        version: 2,
        provider: 'salad',
        savedAt: new Date(now()).toISOString(),
        groupName,
        endpointUrl: tracking.get(groupName)?.endpointUrl || null,
        attempts: 0,
      }
    },

    /** 日志尾：复用 Worker /logs 协议；容器地址尚未分配时返回 null。 */
    async readLogs(run, handle = {}) {
      const endpointUrl = stringOf(handle.endpointUrl) || trackingFor(handle)?.endpointUrl || ''
      const token = stringOf(run?.secret?.token) || stringOf(handle.token)
      if (!endpointUrl || !token) return null
      try {
        const payload = await requestLogs(endpointUrl, token, 0, TIMEOUTS.remoteLogsMs, ctx)
        const lines = Array.isArray(payload?.lines) ? payload.lines.filter((line) => typeof line === 'string') : []
        return lines.length > 0 ? lines.join('\n') : null
      } catch (error) {
        log?.debug?.('读取 Salad Worker 日志失败（忽略）', logText(error?.message, 200))
        return null
      }
    },
  }
}

export default createSaladProvider
