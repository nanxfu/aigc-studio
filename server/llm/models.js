/**
 * 模型列表解析（POST /api/llm/models 的实现核心）。
 *
 * 双引擎策略：
 *  1. **在线探测**：按 Provider 的元数据请求对应厂商的模型接口（浏览器直连会撞 CORS，
 *     且已保存的 Key 不会回传前端，所以必须由 Host 代理）；
 *  2. **静态目录兜底**：无 Key、探测失败或中转站禁用了 `/models` 时，退回
 *     `@earendil-works/pi-ai` 的内置目录（OpenAI / Anthropic / DeepSeek / Kimi /
 *     Gemini / OpenRouter / OpenCode），再用本地推荐列表补齐千问、硅基流动等没有内置目录的厂商。
 *
 * 结果统一成 `{ id, name, api, reasoning, vision, contextWindow }`，并做噪音过滤与去重；
 * 在线结果缺少的能力标签用静态目录 / id 规则补全，让设置界面能显示「推理 / 视觉」提示。
 */

import { createLogger } from '../log.js'
import {
  isNoiseModelId,
  llmProviderMeta,
  llmProviderOf,
  modelCapabilitiesOf,
} from '../../shared/llm-providers.js'

const log = createLogger({ scope: 'llm-models' })

/** 在线探测的总预算：设置界面是交互式操作，宁可快速降级也不要长时间转圈。 */
export const MODEL_PROBE_TIMEOUT_MS = 8000
/** 单次返回的模型上限：OpenRouter 这类聚合网关有数百个模型，全量下发会拖慢界面。 */
export const MODEL_LIST_LIMIT = 400

/**
 * `pi-ai` 内置目录加载器：dynamic import 失败（旧 Node 不支持 JSON import attributes）
 * 时静默退回本地推荐列表，不影响设置流程。
 */
const CATALOG_LOADERS = {
  deepseek: () => import('@earendil-works/pi-ai/providers/deepseek.models').then((mod) => mod.DEEPSEEK_MODELS),
  'moonshotai-cn': () => import('@earendil-works/pi-ai/providers/moonshotai-cn.models').then((mod) => mod.MOONSHOTAI_CN_MODELS),
  google: () => import('@earendil-works/pi-ai/providers/google.models').then((mod) => mod.GOOGLE_MODELS),
  anthropic: () => import('@earendil-works/pi-ai/providers/anthropic.models').then((mod) => mod.ANTHROPIC_MODELS),
  openai: () => import('@earendil-works/pi-ai/providers/openai.models').then((mod) => mod.OPENAI_MODELS),
  opencode: () => import('@earendil-works/pi-ai/providers/opencode.models').then((mod) => mod.OPENCODE_MODELS),
  openrouter: () => import('@earendil-works/pi-ai/providers/openrouter.models').then((mod) => mod.OPENROUTER_MODELS),
}

/** 没有内置目录的 Provider 的常用推荐列表（模型 id 以厂商控制台为准，可自由输入覆盖）。 */
export const RECOMMENDED_MODELS = Object.freeze({
  qwen: [
    { id: 'qwen-plus', name: 'Qwen Plus' },
    { id: 'qwen-max', name: 'Qwen Max' },
    { id: 'qwen-turbo', name: 'Qwen Turbo' },
    { id: 'qwen3-max', name: 'Qwen3 Max', reasoning: true },
    { id: 'qwen-vl-max', name: 'Qwen VL Max', vision: true },
    { id: 'qwen-vl-plus', name: 'Qwen VL Plus', vision: true },
  ],
  siliconflow: [
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3（硅基流动）' },
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1（硅基流动）', reasoning: true },
    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B Instruct' },
    { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', name: 'Qwen3 235B A22B', reasoning: true },
    { id: 'THUDM/GLM-4.1V-9B-Thinking', name: 'GLM-4.1V 9B Thinking', reasoning: true, vision: true },
  ],
  custom: [],
})

/** 静态目录缓存：目录是构建期生成的常量，一次加载即可（失败不缓存，下次还会重试）。 */
const catalogCache = new Map()

/**
 * 读取 Provider 的内置静态目录（已归一）；没有目录或加载失败返回空数组。
 *
 * @param {string} providerId
 * @returns {Promise<Array<object>>}
 */
export async function staticModelsOf(providerId) {
  const meta = llmProviderOf(providerId)
  if (!meta) return []
  const key = meta.catalog || `recommended:${providerId}`
  if (catalogCache.has(key)) return catalogCache.get(key)
  let models = []
  if (meta.catalog && CATALOG_LOADERS[meta.catalog]) {
    try {
      const catalog = await CATALOG_LOADERS[meta.catalog]()
      models = Object.values(catalog).map((model) => normalizeCatalogModel(model, providerId))
    } catch (error) {
      log.warn(`catalog_load_failed provider=${providerId} detail=${String(error?.message ?? error).slice(0, 200)}`)
      models = []
    }
  }
  if (models.length === 0) models = recommendedModelsOf(providerId)
  catalogCache.set(key, models)
  return models
}

function recommendedModelsOf(providerId) {
  const list = RECOMMENDED_MODELS[providerId]
  if (!Array.isArray(list)) return []
  return list.map((item) => normalizeModelEntry({ ...item, api: llmProviderMeta(providerId).api, provider: providerId }))
}

function normalizeCatalogModel(model, providerId) {
  return normalizeModelEntry({
    id: model.id,
    name: model.name,
    api: model.api,
    provider: providerId,
    reasoning: model.reasoning === true,
    vision: Array.isArray(model.input) && model.input.includes('image'),
    contextWindow: model.contextWindow,
  })
}

/** 统一模型条目形状：缺省能力标签用 id 规则补全，非法项丢弃。 */
function normalizeModelEntry(raw) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  const guessed = modelCapabilitiesOf(id)
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    api: typeof raw.api === 'string' && raw.api ? raw.api : 'openai-completions',
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    reasoning: raw.reasoning === true || (raw.reasoning === undefined && guessed.reasoning),
    vision: raw.vision === true || (raw.vision === undefined && guessed.vision),
    contextWindow: Number.isFinite(raw.contextWindow) && raw.contextWindow > 0 ? Math.trunc(raw.contextWindow) : null,
  }
}

/** 去掉末尾斜杠。 */
function trimUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

/** 拼接端点：避免 `.../v1` + `/v1/models` 这类重复路径。 */
function endpointOf(baseUrl, path) {
  const base = trimUrl(baseUrl)
  if (!base) return ''
  if (path.startsWith('/v1/') && /\/v1$/i.test(base)) return `${base}${path.slice(4)}`
  return `${base}${path}`
}

async function readJson(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function httpError(status, message) {
  const error = new Error(message || `HTTP ${status}`)
  error.status = status
  return error
}

/**
 * 错误详情脱敏：厂商 SDK / fetch 的报错里可能带回完整 URL（Gemini 把 Key 放在查询串），
 * 无论是写日志还是回给设置界面，都必须先把 Key 擦掉。
 */
export function redactModelError(text, apiKey = '') {
  let out = String(text ?? '')
  if (apiKey) out = out.split(apiKey).join('***')
  return out.replace(/([?&](?:key|api_key|apiKey)=)[^&\s]+/gi, '$1***').slice(0, 200)
}

/**
 * 在线探测某个 Provider 的模型列表。
 *
 * `source` 表示探测方式，调用方写入响应的 `source` 字段便于界面区分「真实在线列表」
 * 与「内置目录」。任何非 2xx 或结构不符都抛错，由上层降级。
 *
 * @param {{ provider: string, baseUrl: string, apiKey: string, fetchImpl?: typeof fetch, timeoutMs?: number }} input
 * @returns {Promise<{ source: string, models: Array<object> }>}
 */
export async function probeModels(input = {}) {
  const meta = llmProviderMeta(input.provider)
  const baseUrl = trimUrl(input.baseUrl || meta.baseUrl)
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey : ''
  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : MODEL_PROBE_TIMEOUT_MS

  if (!baseUrl) throw httpError(0, '缺少 Base URL')
  if (typeof fetchImpl !== 'function') throw httpError(0, '当前环境不支持 fetch')

  if (meta.modelSource === 'catalog') throw httpError(0, '该服务商使用内置模型目录')
  if (meta.requiresKey && !apiKey) throw httpError(0, '缺少 API Key')

  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  const request = async (url, headers = {}) => {
    const response = await fetchImpl(url, { method: 'GET', headers, signal })
    if (!response.ok) throw httpError(response.status || 0, `HTTP ${response.status}`)
    return readJson(response)
  }

  if (meta.modelSource === 'ollama') {
    const root = baseUrl.replace(/\/v1$/i, '')
    const payload = await request(`${root}/api/tags`)
    const models = Array.isArray(payload?.models) ? payload.models : []
    return {
      source: 'remote',
      models: models.map((item) => normalizeModelEntry({
        id: item?.name || item?.model,
        name: item?.name || item?.model,
        api: meta.api,
        provider: meta.id,
      })).filter(Boolean),
    }
  }

  if (meta.modelSource === 'anthropic') {
    const payload = await request(endpointOf(baseUrl, '/v1/models?limit=1000'), {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    })
    const models = Array.isArray(payload?.data) ? payload.data : []
    return {
      source: 'remote',
      models: models.map((item) => normalizeModelEntry({
        id: item?.id,
        name: item?.display_name || item?.id,
        api: meta.api,
        provider: meta.id,
      })).filter(Boolean),
    }
  }

  if (meta.modelSource === 'google') {
    const payload = await request(endpointOf(baseUrl, `/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`))
    const models = Array.isArray(payload?.models) ? payload.models : []
    return {
      source: 'remote',
      models: models
        // Gemini 的 content 生成模型才可用；embedding / AQA 等没有 generateContent。
        .filter((item) => {
          const methods = Array.isArray(item?.supportedGenerationMethods) ? item.supportedGenerationMethods : []
          return methods.includes('generateContent')
        })
        .map((item) => normalizeModelEntry({
          id: String(item?.name || '').replace(/^models\//, ''),
          name: item?.displayName || String(item?.name || '').replace(/^models\//, ''),
          api: meta.api,
          provider: meta.id,
          reasoning: /thinking/i.test(String(item?.displayName || '')),
          vision: true,
          contextWindow: item?.inputTokenLimit,
        })).filter(Boolean),
    }
  }

  // OpenAI 兼容：GET {baseUrl}/models（部分聚合网关如 OpenRouter 会附带输入模态元数据）
  const payload = await request(endpointOf(baseUrl, '/models'), apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  const models = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  return {
    source: 'remote',
    models: models.map((item) => {
      const inputModalities = item?.architecture?.input_modalities
      const vision = Array.isArray(inputModalities)
        ? inputModalities.includes('image')
        : (typeof item?.capabilities?.vision === 'boolean' ? item.capabilities.vision : undefined)
      return normalizeModelEntry({
        id: item?.id || item?.name || item?.model,
        name: item?.name || item?.id,
        api: meta.api,
        provider: meta.id,
        ...(vision !== undefined ? { vision } : {}),
      })
    }).filter(Boolean),
  }
}

/** 去重（同 id 保留首个）并按噪音规则过滤；`showAll` 为 true 时只去重不过滤。 */
export function filterModels(models, options = {}) {
  const seen = new Set()
  const out = []
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || !model.id) continue
    const key = model.id.toLowerCase()
    if (seen.has(key)) continue
    if (options.showAll !== true && isNoiseModelId(model.id)) continue
    seen.add(key)
    out.push(model)
  }
  return out
}

/** 用静态目录补全在线结果缺失的 name / reasoning / vision / contextWindow / api。 */
export function mergeCatalog(models, catalog) {
  const index = new Map((Array.isArray(catalog) ? catalog : []).map((item) => [item.id.toLowerCase(), item]))
  return (Array.isArray(models) ? models : []).map((model) => {
    const known = index.get(model.id.toLowerCase())
    if (!known) return model
    return {
      ...model,
      name: model.name && model.name !== model.id ? model.name : known.name,
      // 协议以内置目录为准（OpenCode 同一 Key 下不同模型走不同协议）。
      api: known.api || model.api,
      reasoning: known.reasoning === true || model.reasoning === true,
      vision: known.vision === true || model.vision === true,
      contextWindow: model.contextWindow ?? known.contextWindow ?? null,
    }
  })
}

/** 稳定排序：非噪音模型在前，同组按 id 字典序（在线原顺序对用户没有意义）。 */
export function sortModels(models) {
  return [...(Array.isArray(models) ? models : [])].sort((left, right) => {
    const leftNoise = isNoiseModelId(left.id) ? 1 : 0
    const rightNoise = isNoiseModelId(right.id) ? 1 : 0
    if (leftNoise !== rightNoise) return leftNoise - rightNoise
    return left.id.localeCompare(right.id, 'en')
  })
}

/**
 * 列出某个 Provider 的可用模型：先在线、失败降级静态目录。
 *
 * @param {{ provider: string, baseUrl?: string, apiKey?: string, showAll?: boolean,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} input
 * @returns {Promise<{ source: 'remote'|'catalog'|'mixed', models: Array<object>, warning: string|null }>}
 */
export async function listModels(input = {}) {
  const meta = llmProviderMeta(input.provider)
  const catalog = await staticModelsOf(meta.id)
  let remote = []
  let warning = null

  if (meta.modelSource !== 'catalog') {
    try {
      const probed = await probeModels({
        provider: meta.id,
        baseUrl: input.baseUrl || meta.baseUrl,
        apiKey: input.apiKey,
        fetchImpl: input.fetchImpl,
        timeoutMs: input.timeoutMs,
      })
      remote = probed.models
    } catch (error) {
      const detail = redactModelError(error?.message ?? error, input.apiKey)
      warning = /API Key/.test(detail)
        ? '未填写 API Key，已列出内置模型目录；填 Key 后可获取该账号的在线列表'
        : (detail || '在线获取模型失败，已使用内置目录')
      log.info(`models_probe_failed provider=${meta.id} detail=${detail}`)
    }
  }

  const merged = remote.length > 0 ? mergeCatalog(remote, catalog) : catalog
  const filtered = filterModels(merged, { showAll: input.showAll === true })
  const models = sortModels(filtered).slice(0, MODEL_LIST_LIMIT)

  return {
    source: remote.length > 0 ? (catalog.length > 0 ? 'mixed' : 'remote') : 'catalog',
    models,
    warning: models.length > 0 ? warning : (warning || '没有可用的模型列表，请手动输入模型 ID'),
  }
}
