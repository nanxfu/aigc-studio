/**
 * 创作助手模型 Provider 的唯一元数据源（Host 与 Web 共用）。
 *
 * 这里只描述「怎么连」与「怎么展示」，不含任何密钥、请求实现或 React 依赖：
 *  - `server/llm/config.js` 用它在运行期归一配置、构造 `pi-ai` Model；
 *  - `server/llm/models.js` 用它决定在线探测方式与静态目录来源；
 *  - `web/logic/appSettings.js` 与设置抽屉用它渲染分组、模糊搜索与默认端点；
 *  - `GET /api/app-settings` 的 `llm.providers` 也由它生成，前端不再维护第二份白名单。
 *
 * 新增一家 Provider 只需在 `LLM_PROVIDERS` 追加一行：
 *  - `api` 必须是 `pi-ai` 支持的协议 id（见 `LLM_APIS`）；
 *  - `baseUrl` 是该协议的默认端点（`custom` 为空，由用户填写）；
 *  - `catalog` 指向 `pi-ai` 内置静态模型目录的 provider 名（没有则留空，退回推荐列表）；
 *  - `aliases` 只用于搜索，不参与协议判断。
 */

/** `pi-ai` 的 4 条原生协议通道（与 `server/llm/service.js` 的分发一一对应）。 */
export const LLM_APIS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
])

/** 设置界面的分组顺序（中文展示名）。 */
export const LLM_PROVIDER_GROUPS = Object.freeze([
  { id: 'cn', label: '国产直连' },
  { id: 'gateway', label: '聚合网关' },
  { id: 'global', label: '国际原生' },
  { id: 'local', label: '本地与自定义' },
])

/**
 * 在线探测模型列表的方式：
 *  - `openai`：GET {baseUrl}/models（Bearer）；
 *  - `anthropic`：GET {baseUrl}/v1/models（x-api-key + anthropic-version）；
 *  - `google`：GET {baseUrl}/models?key=（过滤 generateContent）；
 *  - `ollama`：GET {rootUrl}/api/tags；
 *  - `catalog`：只读 `pi-ai` 内置目录，不发网络请求。
 */
export const LLM_MODEL_SOURCES = Object.freeze(['openai', 'anthropic', 'google', 'ollama', 'catalog'])

/**
 * Provider 元数据（顺序即设置界面的展示顺序，分组内按这里的先后排列）。
 *
 * @typedef {object} LlmProviderMeta
 * @property {string} id            稳定 id（保存进 app-config，不可随意改名）
 * @property {string} label         展示名
 * @property {string} group         LLM_PROVIDER_GROUPS 的 id
 * @property {string} api           默认协议（OpenCode 等聚合网关按模型覆盖）
 * @property {string} baseUrl       默认端点（custom 为空）
 * @property {boolean} requiresKey  是否必须填 API Key（custom / ollama 可不填）
 * @property {string} defaultModel  切换 Provider 时的推荐模型（可为空）
 * @property {string[]} aliases     模糊搜索别名
 * @property {string} catalog       pi-ai 内置静态目录的 provider 名（可空）
 * @property {string} modelSource   在线探测方式（LLM_MODEL_SOURCES）
 */
export const LLM_PROVIDERS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek',
    group: 'cn',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    defaultModel: 'deepseek-chat',
    aliases: ['ds', '深度求索', '深度探索'],
    catalog: 'deepseek',
    modelSource: 'openai',
  },
  {
    id: 'moonshot',
    label: 'Kimi（Moonshot）',
    group: 'cn',
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    requiresKey: true,
    defaultModel: 'kimi-k2-turbo-preview',
    aliases: ['kimi', '月之暗面', 'moonshotai', 'moonshot'],
    catalog: 'moonshotai-cn',
    modelSource: 'openai',
  },
  {
    id: 'qwen',
    label: '通义千问（DashScope）',
    group: 'cn',
    api: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresKey: true,
    defaultModel: 'qwen-plus',
    aliases: ['qwen', '千问', '阿里', '百炼', 'dashscope', 'aliyun'],
    catalog: '',
    modelSource: 'openai',
  },
  {
    id: 'siliconflow',
    label: '硅基流动（SiliconFlow）',
    group: 'cn',
    api: 'openai-completions',
    baseUrl: 'https://api.siliconflow.cn/v1',
    requiresKey: true,
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    aliases: ['硅基', '硅基流动', 'sf', 'silicon', 'siliconflow'],
    catalog: '',
    modelSource: 'openai',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    group: 'gateway',
    api: 'openai-completions',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    requiresKey: true,
    defaultModel: '',
    aliases: ['opencode', 'zen', 'opencode zen'],
    catalog: 'opencode',
    modelSource: 'catalog',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'gateway',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    defaultModel: '',
    aliases: ['or', '聚合', 'router'],
    catalog: 'openrouter',
    modelSource: 'openai',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    group: 'global',
    api: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    defaultModel: 'gemini-2.5-flash',
    aliases: ['google', 'gemini', '谷歌', 'bard'],
    catalog: 'google',
    modelSource: 'google',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'global',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    defaultModel: 'gpt-4o-mini',
    aliases: ['gpt', 'chatgpt', 'oa'],
    catalog: 'openai',
    modelSource: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic（Claude）',
    group: 'global',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    requiresKey: true,
    defaultModel: 'claude-sonnet-4-5',
    aliases: ['claude', 'anthropic'],
    catalog: 'anthropic',
    modelSource: 'anthropic',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    group: 'local',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    defaultModel: '',
    aliases: ['local', '本地', 'llama'],
    catalog: '',
    modelSource: 'ollama',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    group: 'local',
    api: 'openai-completions',
    baseUrl: '',
    requiresKey: false,
    defaultModel: '',
    aliases: ['custom', 'proxy', '中转', 'vllm', 'lmstudio', '兼容'],
    catalog: '',
    modelSource: 'openai',
  },
])

/** Provider id 枚举（顺序与展示一致）。 */
export const LLM_PROVIDER_IDS = Object.freeze(LLM_PROVIDERS.map((item) => item.id))

const PROVIDER_MAP = new Map(LLM_PROVIDERS.map((item) => [item.id, item]))

/** 默认 Provider（配置缺失 / 非法时的兜底）。 */
export const DEFAULT_LLM_PROVIDER = 'openai'

/** 按 id 取元数据；未知 id 返回 null（调用方决定是否回退默认）。 */
export function llmProviderOf(id) {
  return typeof id === 'string' ? PROVIDER_MAP.get(id) ?? null : null
}

/** 按 id 取元数据；未知 id 回退默认 Provider，保证运行期永远拿到可用对象。 */
export function llmProviderMeta(id) {
  return llmProviderOf(id) ?? PROVIDER_MAP.get(DEFAULT_LLM_PROVIDER)
}

/** 对外脱敏的 Provider 列表（GET /api/app-settings 与前端共用）。 */
export function publicLlmProviders() {
  return LLM_PROVIDERS.map((item) => ({
    id: item.id,
    label: item.label,
    group: item.group,
    api: item.api,
    requiresKey: item.requiresKey,
    defaultModel: item.defaultModel,
    defaultBaseUrl: item.baseUrl,
    aliases: [...item.aliases],
    modelSource: item.modelSource,
  }))
}

function normalized(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * 模糊匹配：命中的维度是 id、展示名与别名。
 *
 * 规则刻意保持宽松（包含匹配 + 大小写不敏感），中文输入 `千问` / `月之暗面`、
 * 英文输入 `kimi` / `claude` 都能直接命中；空查询返回全部（保持分组顺序）。
 * `extra` 允许调用方补充「运行时才知道的展示名」（例如旧配置里存了未知 id）。
 *
 * @param {string} query
 * @param {Array<object>} [providers] 默认取 `LLM_PROVIDERS`
 * @returns {Array<object>} 命中项（原顺序）
 */
export function searchLlmProviders(query, providers = LLM_PROVIDERS) {
  const needle = normalized(query)
  const list = Array.isArray(providers) ? providers : LLM_PROVIDERS
  if (!needle) return [...list]
  return list.filter((item) => {
    if (!item) return false
    const haystack = [item.id, item.label, ...(Array.isArray(item.aliases) ? item.aliases : [])]
    return haystack.some((value) => normalized(value).includes(needle))
  })
}

/** 按分组切分 Provider（设置界面分组渲染用；空组不返回）。 */
export function groupLlmProviders(providers = LLM_PROVIDERS) {
  const list = Array.isArray(providers) ? providers : LLM_PROVIDERS
  return LLM_PROVIDER_GROUPS
    .map((group) => ({
      ...group,
      providers: list.filter((item) => item && item.group === group.id),
    }))
    .filter((group) => group.providers.length > 0)
}

/**
 * 模型 id 是不是「非对话模型」——用于在线/静态目录的噪音过滤。
 *
 * 只按关键字做粗筛，宁可放过也不误杀：Embedding / 重排 / 语音 / 图像生成 /
 * 内容审核这类模型既不能对话也不能调用工具，出现在下拉里只会制造选择困难。
 * 用户在「显示全部」或手动输入时仍可使用任意 id。
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isNoiseModelId(id) {
  const value = normalized(id)
  if (!value) return true
  return /(?:^|[-_/.])(?:embed|embedding|embed-|bge|gte|rerank|tts|whisper|asr|transcri|moderation|dall-e|flux|stable-diffusion|sdxl|sd3|midjourney|imagen|kling|veo|sora|audio|realtime|image|deep-research|computer-use)(?:$|[-_/.])/i
    .test(value)
}

/** 从模型 id 猜测能力标签（在线返回通常缺少 reasoning / vision / contextWindow）。 */
export function modelCapabilitiesOf(id) {
  const value = normalized(id)
  const reasoning = /(?:^|[-_/])(?:o[134](?:$|[-_.])|gpt-5|gpt-6|claude-(?:3-7|sonnet-4|opus-4|haiku-4)|gemini-(?:2\.5|3)|deepseek-(?:reasoner|v4-pro)|qwen3|qwq|kimi-k\d(?:\.\d)?-thinking|glm-(?:4\.[5-9]|5)|grok-[3-9]|magistral|minimax-m2)/i
    .test(value)
  const vision = /(?:vision|vl|multimodal|omni|gpt-4o|gpt-4\.1|gpt-5|gemini|claude-(?:3|4|sonnet|opus|haiku)|qwen-vl|glm-4v|pixtral|llava|internvl)/i
    .test(value)
  return { reasoning, vision }
}
