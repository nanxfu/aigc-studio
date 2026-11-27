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
export const IMAGE_API_VENDOR_IDS = Object.freeze(['siliconflow', 'modelscope', 'fal', 'openai', 'custom'])

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
 *  - `models`：可用生图模型；`videos`：可用视频模型（M4.1，同一套服务商与预设 id）；
 *    `custom` 允许用户填写任意模型 id。
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
    // 视频模型（M4.1）：与生图模型共用服务商与 `cloud:<vendor>:<model>` 预设 id，
    // 通过 `mediaType: 'video'` 区分；`bodyStyle` 决定提交体的字段形状：
    //  - `minimax`：duration / resolution / ratio + `images[{ url, role }]`（首帧 / 尾帧）；
    //  - `wan`：image_size + `image`（首帧 data URL），无时长参数（平台固定档位）。
    videos: Object.freeze([
      Object.freeze({
        id: 'MiniMaxAI/MiniMax-H3',
        label: 'MiniMax H3',
        family: 'MiniMax',
        params: '视频',
        description: {
          zh: '文生视频与首帧 / 尾帧衔接，5–15 秒，480p / 768p',
          en: 'Text-to-video with first/last frame anchoring, 5–15s at 480p/768p',
        },
        bodyStyle: 'minimax',
        duration: Object.freeze({ min: 5, max: 15, step: 1, default: 5 }),
        resolutions: Object.freeze(['480p', '768p']),
        defaultResolution: '768p',
        ratios: Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
        defaultRatio: '16:9',
        supportsFirstFrame: true,
        supportsLastFrame: true,
        supportsNegative: false,
        supportsSeed: true,
        maxCount: 1,
        // 均值取真机实测（2026-11-23，480p / 5s：首帧图生视频 76s，文生视频含排队 389s）；
        // 只用于界面预估，不参与超时判定（轮询总预算见契约 VIDEO.pollTimeoutMs）。
        steadySeconds: 180,
        estCostPerVideo: 1.5,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'Wan-AI/Wan2.2-T2V-A14B',
        // 兼容保留：部分账号 / 区域已下线 Wan 视频权重（硅基流动现役主力为 MiniMax-H3），
        // 默认模型卡不展示；旧客户端按 id 显式请求时仍可解析并给出上游原始错误。
        legacy: true,
        label: 'Wan 2.2 T2V',
        family: 'Wan',
        params: '视频',
        description: {
          zh: '文生视频，固定 5 秒，720p 横 / 竖 / 方形三档',
          en: 'Text-to-video, fixed 5s, 720p landscape/portrait/square',
        },
        bodyStyle: 'wan',
        duration: null,
        imageSizes: Object.freeze(['1280x720', '720x1280', '960x960']),
        ratios: Object.freeze(['16:9', '9:16', '1:1']),
        defaultRatio: '16:9',
        supportsFirstFrame: false,
        supportsLastFrame: false,
        supportsNegative: true,
        supportsSeed: true,
        maxCount: 1,
        steadySeconds: 240,
        estCostPerVideo: 2.0,
        license: '商业 API',
      }),
      Object.freeze({
        id: 'Wan-AI/Wan2.2-I2V-A14B',
        legacy: true,
        label: 'Wan 2.2 I2V',
        family: 'Wan',
        params: '视频',
        description: {
          zh: '首帧生视频，固定 5 秒，保留参考图构图与主体',
          en: 'First-frame image-to-video, fixed 5s, keeps reference composition',
        },
        bodyStyle: 'wan',
        duration: null,
        imageSizes: Object.freeze(['1280x720', '720x1280', '960x960']),
        ratios: Object.freeze(['16:9', '9:16', '1:1']),
        defaultRatio: '16:9',
        supportsFirstFrame: true,
        supportsLastFrame: false,
        supportsNegative: true,
        supportsSeed: true,
        maxCount: 1,
        steadySeconds: 240,
        estCostPerVideo: 2.0,
        license: '商业 API',
      }),
    ]),
  }),
  modelscope: Object.freeze({
    id: 'modelscope',
    label: '魔搭 ModelScope',
    short: 'ModelScope',
    protocol: 'modelscope-async',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    keyHint: 'ms-...（在魔搭个人中心 → 访问令牌创建，需绑定阿里云实名）',
    apiKeyUrl: 'https://modelscope.cn/my/myaccesstoken',
    docsUrl: 'https://modelscope.cn/docs/model-service/API-Inference/intro',
    sizeField: 'size',
    countField: 'n',
    responseFormat: false,
    syncResponse: false,
    freeQuota: true,
    models: Object.freeze([
      Object.freeze({
        id: 'Tongyi-MAI/Z-Image-Turbo',
        label: 'Z-Image Turbo',
        family: 'Z-Image',
        params: '6B · 魔粒额度',
        description: {
          zh: '魔搭托管 6B S3-DiT，8 步写实摄影与中英双语排版（仅文生图）',
          en: 'ModelScope-hosted 6B S3-DiT, 8-step photorealism & bilingual text (txt2img only)',
        },
        size: 1024,
        maxEdge: 2048,
        steps: 8,
        cfg: 0,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: true,
        supportsGuidance: false,
        supportsSeed: true,
        supportsReference: false,
        maxCount: 4,
        steadySeconds: 10,
        estCostPerImage: 0,
        license: '魔搭魔粒额度',
      }),
      Object.freeze({
        id: 'Qwen/Qwen-Image-2.1-Turbo',
        label: 'Qwen-Image 2.1 Turbo',
        family: 'Qwen',
        params: '7B DiT · 魔粒额度',
        description: {
          zh: '魔搭托管 Qwen 2.1 Turbo，支持中文排版与 Base64 参考图编辑',
          en: 'ModelScope-hosted Qwen 2.1 Turbo with CN typography & Base64 reference editing',
        },
        size: 1024,
        maxEdge: 1664,
        steps: 8,
        cfg: 1,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: true,
        supportsSteps: true,
        supportsGuidance: false,
        supportsSeed: true,
        supportsReference: true,
        maxCount: 4,
        steadySeconds: 12,
        estCostPerImage: 0,
        license: '魔搭魔粒额度',
      }),
      Object.freeze({
        id: 'Qwen/Qwen-Image-2.1',
        label: 'Qwen-Image 2.1',
        family: 'Qwen',
        params: '7B DiT · 魔粒额度',
        description: {
          zh: '魔搭托管 Qwen 2.1 基础版，复杂中文海报排版与自然光影（仅文生图）',
          en: 'ModelScope-hosted Qwen 2.1 base for complex CN typography & lighting (txt2img only)',
        },
        size: 1024,
        maxEdge: 1664,
        steps: 20,
        cfg: 3.5,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: true,
        supportsSteps: true,
        supportsGuidance: true,
        supportsSeed: true,
        supportsReference: false,
        maxCount: 4,
        steadySeconds: 16,
        estCostPerImage: 0,
        license: '魔搭魔粒额度',
      }),
      Object.freeze({
        id: 'black-forest-labs/FLUX.2-klein-4B',
        label: 'FLUX.2 Klein 4B',
        family: 'FLUX',
        params: '4B · 魔粒额度',
        description: {
          zh: '魔搭托管 FLUX.2 Klein 4B，支持文生图与 Base64 参考图编辑（上限 1024px）',
          en: 'ModelScope-hosted FLUX.2 Klein 4B with txt2img & Base64 reference editing (max 1024px)',
        },
        size: 1024,
        maxEdge: 1024,
        steps: 4,
        cfg: 0,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: false,
        supportsGuidance: false,
        supportsSeed: true,
        supportsReference: true,
        maxCount: 4,
        steadySeconds: 10,
        estCostPerImage: 0,
        license: '魔搭魔粒额度',
      }),
      Object.freeze({
        id: 'black-forest-labs/FLUX.2-klein-9B',
        label: 'FLUX.2 Klein 9B',
        family: 'FLUX',
        params: '9B · 魔粒额度',
        description: {
          zh: '魔搭托管 9B 蒸馏编辑模型，免门控免 18G 显存，支持参考图（上限 1024px）',
          en: 'ModelScope-hosted 9B distilled editing model, no gated/VRAM barrier, supports refs (max 1024px)',
        },
        size: 1024,
        maxEdge: 1024,
        steps: 4,
        cfg: 0,
        supportsChinese: true,
        promptStyle: 'natural',
        supportsNegative: false,
        supportsSteps: false,
        supportsGuidance: false,
        supportsSeed: true,
        supportsReference: true,
        maxCount: 4,
        steadySeconds: 16,
        estCostPerImage: 0,
        license: '魔搭魔粒额度',
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

/** 服务商下的视频模型元数据；未登记返回 null（自定义端点不提供视频目录）。 */
export function videoApiModelOf(vendorId, modelId) {
  const vendor = imageApiVendorOf(vendorId)
  if (!vendor) return null
  const id = textOf(modelId)
  if (!id) return null
  const list = Array.isArray(vendor.videos) ? vendor.videos : []
  return list.find((item) => item.id === id) ?? null
}

/**
 * 云端生图模型 → 预设对象（与 models/*.json 的公开视图同形，额外带 `cloud` 元数据）。
 *
 * 能力位刻意保守：`supportsImg2Img` / `supportsInpaint` / `supportsReference` 一律 false，
 * 因为这些商业端点需要单独的上传协议；生图只打通文生图，扩图 / 超分由 Host 明确拒绝。
 */
export function cloudPresetOf(vendorId, modelId) {
  const vendor = imageApiVendorOf(vendorId)
  if (!vendor) return null
  // 视频模型与生图模型共用 `cloud:<vendor>:<model>` 命名空间：先按视频目录解析，
  // 命中就返回视频预设（`mediaType: 'video'`），否则走生图目录。
  if (videoApiModelOf(vendor.id, modelId)) return cloudVideoPresetOf(vendor.id, modelId)
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
    supportsReference: model.supportsReference === true,
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
      supportsReference: model.supportsReference === true,
      maxEdge: Number.isFinite(Number(model.maxEdge)) ? Number(model.maxEdge) : null,
      maxCount: model.maxCount ?? 4,
      estCostPerImage: model.estCostPerImage ?? null,
      freeQuota: vendor.freeQuota === true,
      steadySeconds: model.steadySeconds ?? null,
    },
  }
}

/**
 * 云端视频模型 → 预设对象（M4.1）。
 *
 * 与生图预设同形，额外带 `video` 能力块（时长 / 分辨率 / 画幅 / 首尾帧），
 * 供参数区渲染、JobQueue 校验与适配层构造提交体；`supportsReference` 只在模型
 * 支持首帧时打开，参考图槽因此可以复用到图生视频。
 */
export function cloudVideoPresetOf(vendorId, modelId) {
  const vendor = imageApiVendorOf(vendorId)
  if (!vendor) return null
  const model = videoApiModelOf(vendor.id, modelId)
  if (!model) return null
  const duration = model.duration
    ? { min: model.duration.min, max: model.duration.max, step: model.duration.step ?? 1, default: model.duration.default }
    : null
  const maxReferences = model.supportsLastFrame ? 2 : model.supportsFirstFrame ? 1 : 0
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
    size: 1024,
    steps: 0,
    stepRange: null,
    cfg: 0,
    steadySeconds: model.steadySeconds ?? null,
    tier: 'usable',
    mediaType: 'video',
    category: 'video',
    negativeHint: '',
    promptStyle: 'natural',
    qualityPrefix: '',
    supportsChinese: true,
    supportsImg2Img: false,
    supportsInpaint: false,
    supportsReference: model.supportsFirstFrame === true,
    inpaintOnly: false,
    supportsNegative: model.supportsNegative === true,
    sizeOptions: null,
    providers: ['cloud-api'],
    cloud: {
      vendor: vendor.id,
      model: model.id,
      protocol: 'siliconflow-video',
      mediaType: 'video',
      supportsNegative: model.supportsNegative === true,
      supportsSteps: false,
      supportsGuidance: false,
      supportsSeed: model.supportsSeed === true,
      maxCount: 1,
      estCostPerImage: null,
      estCostPerVideo: model.estCostPerVideo ?? null,
      steadySeconds: model.steadySeconds ?? null,
    },
    video: {
      bodyStyle: model.bodyStyle,
      supportsDuration: Boolean(duration),
      duration,
      resolutions: model.resolutions ? [...model.resolutions] : null,
      defaultResolution: model.defaultResolution ?? null,
      ratios: [...model.ratios],
      defaultRatio: model.defaultRatio,
      supportsFirstFrame: model.supportsFirstFrame === true,
      supportsLastFrame: model.supportsLastFrame === true,
      maxReferences,
    },
  }
}

/**
 * 某个服务商的全部云端预设（设置界面切换服务商后，顶栏模型卡随之更新）。
 *
 * 自定义端点（`dynamicModel`）没有固定模型清单：传 `modelId` 时按该 id 生成一个预设，
 * 不传则返回空数组（尚未填写模型，界面不应出现空模型卡）。
 * 内置服务商按「生图模型 → 视频模型」顺序返回，模型卡按 `mediaType` 分 Tab。
 */
export function cloudPresetsFor(vendorId, modelId = '') {
  const vendor = imageApiVendorOf(vendorId)
  if (!vendor) return []
  if (vendor.dynamicModel) {
    return parseCustomModelIds(modelId)
      .map((id) => cloudPresetOf(vendor.id, id))
      .filter(Boolean)
  }
  const images = vendor.models
    .map((model) => cloudPresetOf(vendor.id, model.id))
    .filter(Boolean)
  const videos = (Array.isArray(vendor.videos) ? vendor.videos : [])
    .filter((model) => model.legacy !== true)
    .map((model) => cloudVideoPresetOf(vendor.id, model.id))
    .filter(Boolean)
  return [...images, ...videos]
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
