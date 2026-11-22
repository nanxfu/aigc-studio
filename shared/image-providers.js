/**
 * 商业生图 API 的唯一来源清单（M3.5 Phase A）。
 *
 * 与 `shared/llm-providers.js` 的分工完全一致：这里只放**纯数据 + 纯函数**，
 * 不 import `node:*`、不发请求、不存 Key；Host 用它构造请求，Client 用它渲染
 * 服务商与模型卡片，两边不再各自维护一份模型清单。
 *
 * 设计约束：
 *  - 服务商只声明「协议类型」与少量请求字段差异（size 字段名 / 张数字段名），
 *    具体 HTTP 细节留在 `server/image-api.js`，避免这里变成半成品 SDK；
 *  - 模型能力位宁可保守：没有实测确认的能力（参考图 / 局部重绘 / 超分）一律 false，
 *    界面据此禁用入口并提示切换算力来源，绝不静默丢参数；
 *  - 云端模型以「预设」形式暴露给现有创作面板（`cloudPresetsFor()`），
 *    `presetById()` 能解析 `cloud:<vendor>:<model>`，复用模型卡、参数区与任务卡。
 */

/** 服务商标识：顺序即设置界面的展示顺序。 */
export const IMAGE_API_VENDOR_IDS = Object.freeze(['siliconflow', 'fal', 'openai', 'custom'])

/** 默认服务商（首次打开设置时的预选项）。 */
export const DEFAULT_IMAGE_API_VENDOR = 'siliconflow'

/** 云端预设 id 前缀：`cloud:<vendor>:<model>`，model 允许包含 `/` 与 `.`。 */
const CLOUD_PRESET_PREFIX = 'cloud:'

/**
 * 服务商清单。
 *
 * 字段说明：
 *  - `protocol`：`openai-images` 走 `POST {baseUrl}/images/generations`；
 *    `fal-queue` 走 fal 的提交 / 轮询 / 取结果三段式队列；
 *  - `sizeField` / `countField`：请求体里的尺寸与单次张数字段名（SiliconFlow 用
 *    `image_size` + `batch_size`，OpenAI 用 `size` + `n`）；
 *  - `responseFormat`：是否需要显式 `response_format: 'b64_json'`（OpenAI 需要，
 *    SiliconFlow 只回 URL）；
 *  - `models`：可用模型；`custom` 允许用户填写任意模型 id。
 */
export const IMAGE_API_VENDORS = Object.freeze({
  siliconflow: Object.freeze({
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    short: 'SiliconFlow',
    protocol: 'openai-images',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyHint: 'sk-...（在硅基流动控制台创建）',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/docs/api/images-generations-post',
    sizeField: 'image_size',
    countField: 'batch_size',
    responseFormat: false,
    // 硅基流动的轮询式异步不适用：同步返回 images[].url，URL 一小时过期，必须立即下载。
    syncResponse: true,
    models: Object.freeze([
      Object.freeze({
        id: 'Qwen/Qwen-Image',
        label: 'Qwen-Image',
        family: 'Qwen',
        params: '20B',
        description: { zh: '通义千问 20B 图像模型，中文语义与文字排版强', en: 'Qwen 20B image model, strong Chinese semantics and typography' },
        size: 1328,
        steps: 20,
        cfg: 3.5,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: true,
        supportsSteps: true,
        supportsGuidance: true,
        supportsSeed: true,
        maxCount: 4,
        steadySeconds: 12,
        estCostPerImage: 0.3,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'Kwai-Kolors/Kolors',
        label: 'Kolors',
        family: 'Kolors',
        params: '可图',
        description: { zh: '快手可图文生图，中英文与写实人像稳定', en: 'Kuaishou Kolors, stable CN/EN prompts and portraits' },
        size: 1024,
        steps: 20,
        cfg: 7.5,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: true,
        supportsSteps: true,
        supportsGuidance: true,
        supportsSeed: true,
        maxCount: 4,
        steadySeconds: 10,
        estCostPerImage: 0.04,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'black-forest-labs/FLUX.1-schnell',
        label: 'FLUX.1 schnell',
        family: 'FLUX',
        params: '12B',
        description: { zh: '4 步极速 FLUX，适合快速构思与批量抽卡', en: '4-step FLUX for fast ideation and batch drafts' },
        size: 1024,
        steps: 4,
        cfg: 0,
        supportsChinese: false,
        promptStyle: 'concise',
        supportsNegative: false,
        supportsSteps: false,
        supportsGuidance: false,
        supportsSeed: true,
        maxCount: 4,
        steadySeconds: 4,
        estCostPerImage: 0.02,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'black-forest-labs/FLUX.1-dev',
        label: 'FLUX.1 dev',
        family: 'FLUX',
        params: '12B',
        description: { zh: '多步 FLUX，光影细节与英文构图更完整', en: 'Multi-step FLUX with richer detail and lighting' },
        size: 1024,
        steps: 28,
        cfg: 3.5,
        supportsChinese: false,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: true,
        supportsGuidance: true,
        supportsSeed: true,
        maxCount: 4,
        steadySeconds: 14,
        estCostPerImage: 0.1,
        license: '商业 API',
      }),
    ]),
  }),
  fal: Object.freeze({
    id: 'fal',
    label: 'fal.ai',
    short: 'fal',
    protocol: 'fal-queue',
    baseUrl: 'https://queue.fal.run',
    keyHint: 'fal key（形如 xxxxxxxx-xxxx-...）',
    apiKeyUrl: 'https://fal.ai/dashboard/keys',
    docsUrl: 'https://fal.ai/docs/model-endpoints/queue',
    sizeField: 'image_size',
    countField: 'num_images',
    responseFormat: false,
    syncResponse: false,
    models: Object.freeze([
      Object.freeze({
        id: 'fal-ai/flux/schnell',
        label: 'FLUX.1 schnell',
        family: 'FLUX',
        params: '12B',
        description: { zh: 'fal 托管的 4 步极速 FLUX', en: 'fal-hosted 4-step FLUX schnell' },
        size: 1024,
        steps: 4,
        cfg: 0,
        supportsChinese: false,
        promptStyle: 'concise',
        supportsNegative: false,
        supportsSteps: false,
        supportsGuidance: false,
        supportsSeed: true,
        maxCount: 4,
        steadySeconds: 4,
        estCostPerImage: 0.02,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'fal-ai/flux/dev',
        label: 'FLUX.1 dev',
        family: 'FLUX',
        params: '12B',
        description: { zh: 'fal 托管的多步 FLUX，细节更完整', en: 'fal-hosted multi-step FLUX with richer detail' },
        size: 1024,
        steps: 28,
        cfg: 3.5,
        supportsChinese: false,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: true,
        supportsGuidance: true,
        supportsSeed: true,
        maxCount: 4,
        steadySeconds: 14,
        estCostPerImage: 0.08,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'fal-ai/flux-pro/v1.1',
        label: 'FLUX 1.1 Pro',
        family: 'FLUX',
        params: 'Pro',
        description: { zh: '旗舰 FLUX Pro，构图与质感更稳', en: 'Flagship FLUX Pro for composition and fidelity' },
        size: 1024,
        steps: 0,
        cfg: 0,
        supportsChinese: false,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: false,
        supportsGuidance: false,
        supportsSeed: true,
        maxCount: 4,
        steadySeconds: 12,
        estCostPerImage: 0.3,
        license: '商业 API',
      }),
    ]),
  }),
  openai: Object.freeze({
    id: 'openai',
    label: 'OpenAI Images',
    short: 'OpenAI',
    protocol: 'openai-images',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-...',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference/images',
    sizeField: 'size',
    countField: 'n',
    responseFormat: true,
    syncResponse: true,
    models: Object.freeze([
      Object.freeze({
        id: 'gpt-image-1',
        label: 'GPT Image 1',
        family: 'OpenAI',
        params: 'GPT 图像',
        description: { zh: 'OpenAI 原生图像模型，指令跟随与多语文字强', en: 'OpenAI native image model with strong instruction following' },
        size: 1024,
        steps: 0,
        cfg: 0,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: false,
        supportsGuidance: false,
        supportsSeed: false,
        maxCount: 4,
        steadySeconds: 20,
        estCostPerImage: 0.28,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'dall-e-3',
        label: 'DALL·E 3',
        family: 'OpenAI',
        params: 'DALL·E',
        description: { zh: 'DALL·E 3，单张 1024/1792 画幅', en: 'DALL·E 3, single image at 1024/1792 sizes' },
        size: 1024,
        steps: 0,
        cfg: 0,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: false,
        supportsGuidance: false,
        supportsSeed: false,
        maxCount: 1,
        steadySeconds: 15,
        estCostPerImage: 0.28,
        license: '商业 API',
      }),
    ]),
  }),
  custom: Object.freeze({
    id: 'custom',
    label: 'OpenAI 兼容端点',
    short: 'Custom',
    protocol: 'openai-images',
    // 自定义端点必须由用户填写 Base URL（http://127.0.0.1 仅开发态允许）。
    baseUrl: '',
    keyHint: '聚合平台或自建网关的 Key',
    docsUrl: '',
    sizeField: 'size',
    countField: 'n',
    responseFormat: true,
    syncResponse: true,
    dynamicModel: true,
    models: Object.freeze([]),
  }),
})

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 服务商元数据；未登记返回 null（调用方自行给出可执行错误）。 */
export function imageApiVendorOf(id) {
  const key = textOf(id)
  return Object.prototype.hasOwnProperty.call(IMAGE_API_VENDORS, key) ? IMAGE_API_VENDORS[key] : null
}

/**
 * Base URL 归一：必须是 http(s)，禁止 URL 凭据 / query / fragment；末尾斜杠去掉。
 *
 * 商业 API 默认只允许 https；开发联调由调用方显式放开 `allowInsecure`（回环地址
 * 仍可访问本机 mock 服务，测试与自建网关都用得上）。
 */
export function normalizeImageApiBaseUrl(value, { allowInsecure = false } = {}) {
  const raw = textOf(value)
  if (!raw) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  if (url.protocol === 'https:') {
    // 继续
  } else if (url.protocol === 'http:') {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (!(allowInsecure || loopback)) return null
  } else {
    return null
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** 拆分自定义端点的逗号/换行分隔模型 id 列表。 */
export function parseCustomModelIds(raw) {
  const text = textOf(raw)
  if (!text) return []
  const seen = new Set()
  const out = []
  for (const part of text.split(/[,，\r\n]+/)) {
    const id = part.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 归一当前生效的生图 API 配置（空值回落到服务商默认端点）。 */
export function normalizeImageApiConfig(raw, { allowInsecure = false } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const vendor = imageApiVendorOf(source.vendor) ?? imageApiVendorOf(DEFAULT_IMAGE_API_VENDOR)
  const fallbackModel = vendor.models[0]?.id ?? ''
  const model = textOf(source.model) || fallbackModel
  const requestedBase = textOf(source.baseUrl)
  const normalizedBase = requestedBase ? normalizeImageApiBaseUrl(requestedBase, { allowInsecure }) : ''
  return {
    vendor: vendor.id,
    model,
    baseUrl: normalizedBase === null ? vendor.baseUrl : normalizedBase || vendor.baseUrl,
  }
}

/** 云端预设 id：`cloud:<vendor>:<model>`。 */
export function cloudPresetIdOf(vendorId, modelId) {
  const vendor = textOf(vendorId)
  const model = textOf(modelId)
  return vendor && model ? `${CLOUD_PRESET_PREFIX}${vendor}:${model}` : ''
}

/** 拆分云端预设 id；不是云端预设或格式非法返回 null。 */
export function parseCloudPresetId(id) {
  const text = textOf(id)
  if (!text.startsWith(CLOUD_PRESET_PREFIX)) return null
  const rest = text.slice(CLOUD_PRESET_PREFIX.length)
  const index = rest.indexOf(':')
  if (index <= 0) return null
  const vendor = rest.slice(0, index)
  const model = rest.slice(index + 1)
  if (!vendor || !model) return null
  return { vendor, model }
}

/** 服务商下的模型元数据；未知返回 null。 */
export function imageApiModelOf(vendorId, modelId) {
  const vendor = imageApiVendorOf(vendorId)
  if (!vendor) return null
  const id = textOf(modelId)
  if (!id) return null
  const found = vendor.models.find((item) => item.id === id)
  if (found) return found
  // 自定义端点：模型由用户填写，按通用 OpenAI Images 能力构造（保守：无负向 / 步数 / 种子）。
  if (vendor.dynamicModel) {
    return {
      id,
      label: id,
      family: vendor.short,
      description: { zh: '自定义 OpenAI 兼容模型', en: 'Custom OpenAI-compatible model' },
      size: 1024,
      steps: 0,
      cfg: 0,
      supportsNegative: false,
      supportsSteps: false,
      supportsGuidance: false,
      supportsSeed: false,
      maxCount: 4,
      steadySeconds: null,
      estCostPerImage: null,
      license: '第三方服务条款',
    }
  }
  return null
}

/**
 * 云端模型 → 预设对象（与 models/*.json 的公开视图同形，额外带 `cloud` 元数据）。
 *
 * 能力位刻意保守：`supportsImg2Img` / `supportsInpaint` / `supportsReference` 一律 false，
 * 因为这些商业端点需要单独的上传协议；阶段 A 只打通文生图，扩图 / 超分由 Host 明确拒绝。
 */
export function cloudPresetOf(vendorId, modelId) {
  const vendor = imageApiVendorOf(vendorId)
  if (!vendor) return null
  const model = imageApiModelOf(vendor.id, modelId)
  if (!model) return null
  return {
    id: cloudPresetIdOf(vendor.id, model.id),
    label: model.label,
    family: model.family || vendor.short,
    short: model.label,
    description: model.description,
    repo: `${vendor.id}/${model.id}`,
    params: model.params || vendor.short,
    license: model.license ?? '商业 API',
    licenseKind: 'commercial',
    gated: false,
    gpus: 0,
    size: model.size ?? 1024,
    steps: model.supportsSteps ? (model.steps ?? 0) : 0,
    stepRange: model.supportsSteps ? { min: 1, max: 50, step: 1, fast: 8, balanced: model.steps ?? 20, fine: 36 } : null,
    cfg: model.supportsGuidance ? (model.cfg ?? 0) : 0,
    steadySeconds: model.steadySeconds ?? null,
    tier: model.supportsSteps ? 'usable' : 'fast',
    mediaType: model.mediaType || 'image',
    category: model.category || 'image',
    negativeHint: '',
    promptStyle: model.promptStyle || 'natural',
    qualityPrefix: '',
    supportsChinese: model.supportsChinese !== false,
    supportsImg2Img: false,
    supportsInpaint: false,
    supportsReference: false,
    inpaintOnly: false,
    supportsNegative: model.supportsNegative === true,
    // 云端模型不用本地 sizeOptions（API 按宽高映射画幅），缺省让界面走比例档。
    sizeOptions: null,
    providers: ['cloud-api'],
    cloud: {
      vendor: vendor.id,
      model: model.id,
      protocol: vendor.protocol,
      supportsNegative: model.supportsNegative === true,
      supportsSteps: model.supportsSteps === true,
      supportsGuidance: model.supportsGuidance === true,
      supportsSeed: model.supportsSeed === true,
      maxCount: model.maxCount ?? 4,
      estCostPerImage: model.estCostPerImage ?? null,
      steadySeconds: model.steadySeconds ?? null,
    },
  }
}

/**
 * 某个服务商的全部云端预设（设置界面切换服务商后，顶栏模型卡随之更新）。
 *
 * 自定义端点（`dynamicModel`）没有固定模型清单：传 `modelId` 时按该 id 生成一个预设，
 * 不传则返回空数组（尚未填写模型，界面不应出现空模型卡）。
 */
export function cloudPresetsFor(vendorId, modelId = '') {
  const vendor = imageApiVendorOf(vendorId)
  if (!vendor) return []
  if (vendor.dynamicModel) {
    return parseCustomModelIds(modelId)
      .map((id) => cloudPresetOf(vendor.id, id))
      .filter(Boolean)
  }
  return vendor.models
    .map((model) => cloudPresetOf(vendor.id, model.id))
    .filter(Boolean)
}

/**
 * 方式 B：汇总所有已配置凭据的服务商模型预设（供创作页顶栏模型胶囊展示）。
 *
 * - 已填 Key 的内置服务商（硅基流动 / fal / OpenAI）全部列出；
 * - 自定义端点若已配置 Key（或当前就停在 custom 且填了 baseUrl + model），按逗号拆出模型列表；
 * - 若尚未配置任何 Key，兜底展示当前/默认服务商的模型目录（避免顶栏变空，点击生成再引导填 Key）。
 */
export function allCloudPresetsFor(imageApiView, { includeAllBuiltins = false } = {}) {
  const view = imageApiView && typeof imageApiView === 'object' ? imageApiView : {}
  const configured = Array.isArray(view.apiKeysConfigured)
    ? IMAGE_API_VENDOR_IDS.filter((id) => view.apiKeysConfigured.includes(id))
    : []
  const customBase = textOf(view.customBaseUrl) || (view.vendor === 'custom' ? textOf(view.baseUrl) : '')
  const customModel = textOf(view.customModel) || (view.vendor === 'custom' ? textOf(view.model) : '')

  const targetVendors = includeAllBuiltins
    ? IMAGE_API_VENDOR_IDS
    : configured

  const list = []
  for (const id of targetVendors) {
    if (id === 'custom') {
      if (customBase && customModel) list.push(...cloudPresetsFor('custom', customModel))
    } else {
      list.push(...cloudPresetsFor(id))
    }
  }
  if (list.length > 0) return list

  const fallbackVendor = imageApiVendorOf(view.vendor)?.id ?? DEFAULT_IMAGE_API_VENDOR
  const fallbackModel = fallbackVendor === 'custom' ? customModel : textOf(view.model)
  return cloudPresetsFor(fallbackVendor, fallbackModel)
}

/**
 * 按配置解析云端预设：
 *  - 优先解析请求里的 `cloud:<vendor>:<model>`（方式 B 下只要该服务商已配 Key 或等于当前服务商即可解析）；
 *  - 否则回落到当前设置服务商的默认/首个模型。
 */
export function cloudPresetOfConfig(config, requestedPresetId = '') {
  const normalized = normalizeImageApiConfig(config)
  const requested = parseCloudPresetId(requestedPresetId)
  const keys = config && typeof config === 'object' && config.keys && typeof config.keys === 'object'
    ? config.keys
    : null
  if (requested) {
    const allowedVendor = requested.vendor === normalized.vendor || Boolean(keys && keys[requested.vendor])
    if (allowedVendor) {
      const preset = cloudPresetOf(requested.vendor, requested.model)
      if (preset) return preset
    }
  }
  const fallbackModel = normalized.vendor === 'custom'
    ? parseCustomModelIds(normalized.model)[0] ?? ''
    : normalized.model
  return cloudPresetOf(normalized.vendor, fallbackModel)
}

/** 按预设 id 解析云端预设：`cloud:<vendor>:<model>`；非云端 / 未知模型返回 null。 */
export function cloudPresetById(id) {
  const parsed = parseCloudPresetId(id)
  return parsed ? cloudPresetOf(parsed.vendor, parsed.model) : null
}

/** 预设 id 是否为云端预设。 */
export function isCloudPresetId(id) {
  return parseCloudPresetId(id) !== null
}

/** 预设 → 云端配置（Host 构造请求时使用）；非云端预设返回 null。 */
export function cloudConfigOfPreset(preset) {
  if (!preset || typeof preset !== 'object' || !preset.cloud) return null
  const vendor = imageApiVendorOf(preset.cloud.vendor)
  if (!vendor) return null
  return { vendor: vendor.id, model: preset.cloud.model, protocol: vendor.protocol }
}
