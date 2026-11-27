#!/usr/bin/env node
/**
 * LLM 模型列表与 Provider 元数据测试（零网络：本地 mock HTTP）。
 *
 * 覆盖：
 *  1. `shared/llm-providers.js` 的模糊搜索（中英文别名）、分组与噪音过滤；
 *  2. `server/llm/models.js` 的在线探测：OpenAI 兼容 / Anthropic / Gemini / Ollama 四种端点，
 *     以及鉴权头、路径拼接、能力标签补全与噪音模型过滤；
 *  3. 无 Key / 探测失败时降级 `pi-ai` 内置目录（OpenCode 多协议、Gemini、DeepSeek 等）；
 *  4. `POST /api/llm/models` 路由：已保存 Key 的同 provider 复用、跨 provider 不复用、非法入参。
 *
 * 运行：node test/llm-models.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createCheckRunner } from './helpers/check.mjs'
import {
  LLM_PROVIDERS,
  groupLlmProviders,
  isNoiseModelId,
  searchLlmProviders,
} from '../shared/llm-providers.js'
import { filterModels, listModels, probeModels } from '../server/llm/models.js'
import { createLlmModelRoutes } from '../server/routes/llm-models.js'

const { check, summary } = createCheckRunner()

const JSON_HEADERS = { 'content-type': 'application/json' }

/**
 * 启动 mock 厂商服务：
 *  - `/v1/models`：OpenAI 兼容（返回 chat + embedding）；
 *  - `/v1/models?anthropic`：Anthropic 列表（检查 x-api-key / anthropic-version）；
 *  - `/v1beta/models`：Gemini 列表（检查 key 查询串）；
 *  - `/api/tags`：Ollama 本地模型。
 */
async function startMockVendor() {
  const requests = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw })
    const send = (status, payload) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    const url = new URL(String(req.url), 'http://127.0.0.1')
    if (url.pathname === '/v1/models') {
      // Anthropic 的分页接口也走 /v1/models，用请求头区分。
      if (req.headers['x-api-key']) {
        return send(200, {
          data: [
            { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
          ],
          has_more: false,
        })
      }
      return send(200, {
        data: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-reasoner' },
          { id: 'text-embedding-v1' },
          { id: 'dall-e-3' },
        ],
      })
    }
    if (url.pathname === '/v1beta/models') {
      return send(200, {
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            supportedGenerationMethods: ['generateContent'],
            inputTokenLimit: 1048576,
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Text Embedding 004',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      })
    }
    if (url.pathname === '/api/tags') {
      return send(200, { models: [{ name: 'llama3:latest' }, { name: 'qwen2.5:7b' }] })
    }
    return send(404, { error: { message: `unknown path ${req.url}` } })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolveClose) => {
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    }),
  }
}

/** 直接挂载一条路由到本地 HTTP 服务，返回 fetch 用的 origin。 */
async function mountRoute(route) {
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => {
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    }),
  }
}

async function main() {
  await check('Provider 元数据：中文 / 英文别名模糊搜索与分组', async () => {
    assert.equal(LLM_PROVIDERS.length, 12, '预设清单应有 12 家 Provider')
    assert.deepEqual(searchLlmProviders('kimi').map((item) => item.id), ['moonshot'])
    assert.deepEqual(searchLlmProviders('月之暗面').map((item) => item.id), ['moonshot'])
    assert.deepEqual(searchLlmProviders('千问').map((item) => item.id), ['qwen'])
    assert.deepEqual(searchLlmProviders('百炼').map((item) => item.id), ['qwen'])
    assert.deepEqual(searchLlmProviders('硅基').map((item) => item.id), ['siliconflow'])
    assert.deepEqual(searchLlmProviders('魔搭').map((item) => item.id), ['modelscope'])
    assert.deepEqual(searchLlmProviders('opencode').map((item) => item.id), ['opencode'])
    assert.deepEqual(searchLlmProviders('claude').map((item) => item.id), ['anthropic'])
    assert.deepEqual(searchLlmProviders('不存在的厂商'), [])
    assert.equal(searchLlmProviders('').length, LLM_PROVIDERS.length, '空查询返回全部')
    const groups = groupLlmProviders()
    assert.deepEqual(groups.map((group) => group.id), ['cn', 'gateway', 'global', 'local'])
    assert.equal(groups.find((group) => group.id === 'cn').providers.length, 5)
  })

  await check('噪音模型过滤：embedding / 图像 / 语音 / 深度研究不进入下拉', async () => {
    for (const id of ['text-embedding-v1', 'bge-reranker-v2', 'dall-e-3', 'gpt-image-1', 'whisper-1', 'deep-research-max-preview']) {
      assert.equal(isNoiseModelId(id), true, `${id} 应被过滤`)
    }
    for (const id of ['deepseek-chat', 'gpt-4o-mini', 'claude-sonnet-4-5', 'qwen-plus', 'gemini-2.5-flash']) {
      assert.equal(isNoiseModelId(id), false, `${id} 应保留`)
    }
    const filtered = filterModels([
      { id: 'deepseek-chat' },
      { id: 'text-embedding-v1' },
      { id: 'deepseek-chat' },
    ])
    assert.deepEqual(filtered.map((item) => item.id), ['deepseek-chat'], '去重 + 过滤')
    assert.equal(filterModels([{ id: 'text-embedding-v1' }], { showAll: true }).length, 1, 'showAll 时保留噪音模型')
  })

  const mock = await startMockVendor()
  try {
    await check('OpenAI 兼容探测：Bearer 鉴权、噪音过滤与能力标签补全', async () => {
      const result = await listModels({
        provider: 'deepseek',
        baseUrl: `${mock.origin}/v1`,
        apiKey: 'sk-test',
      })
      assert.equal(result.source, 'mixed', '在线 + 内置目录合并后应为 mixed')
      assert.deepEqual(result.models.map((item) => item.id).sort(), ['deepseek-chat', 'deepseek-reasoner'])
      const reasoner = result.models.find((item) => item.id === 'deepseek-reasoner')
      assert.equal(reasoner.reasoning, true, 'id 规则应识别推理模型')
      const request = mock.requests.filter((item) => item.url === '/v1/models' && !item.headers['x-api-key']).at(-1)
      assert.equal(request.headers.authorization, 'Bearer sk-test')
    })

    await check('OpenAI 兼容探测：优先消费上游 architecture.input_modalities 视觉元数据', async () => {
      const probed = await listModels({
        provider: 'custom',
        baseUrl: `${mock.origin}/v1`,
        fetchImpl: async () => new Response(JSON.stringify({
          data: [{ id: 'vendor/alpha-model', name: 'Alpha', architecture: { input_modalities: ['text', 'image'] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      })
      const alpha = probed.models.find((m) => m.id === 'vendor/alpha-model')
      assert.equal(alpha?.vision, true, '上游明确声明 image 输入模态时无需依赖 ID 猜测')
    })

    await check('Anthropic 探测：/v1/models + x-api-key + anthropic-version', async () => {
      const result = await listModels({
        provider: 'anthropic',
        baseUrl: mock.origin,
        apiKey: 'sk-ant-test',
      })
      assert.equal(result.source, 'mixed')
      assert.deepEqual(result.models.map((item) => item.id).sort(), ['claude-haiku-4-5', 'claude-sonnet-4-5'])
      const request = mock.requests.filter((item) => item.headers['x-api-key'] === 'sk-ant-test').at(-1)
      assert.equal(request.url, '/v1/models?limit=1000')
      assert.ok(request.headers['anthropic-version'], 'Anthropic 列表接口需要版本头')
    })

    await check('Gemini 探测：key 查询串 + generateContent 过滤 + 去 models/ 前缀', async () => {
      const result = await listModels({
        provider: 'gemini',
        baseUrl: `${mock.origin}/v1beta`,
        apiKey: 'gk-test',
      })
      assert.deepEqual(result.models.map((item) => item.id), ['gemini-2.5-flash'])
      const model = result.models[0]
      assert.equal(model.name, 'Gemini 2.5 Flash')
      assert.equal(model.contextWindow, 1048576)
      const request = mock.requests.filter((item) => item.url.startsWith('/v1beta/models?')).at(-1)
      assert.ok(request.url.includes('key=gk-test'), 'Gemini 用查询串传 Key')
    })

    await check('Ollama 探测：根地址 /api/tags、免 Key', async () => {
      const result = await listModels({
        provider: 'ollama',
        baseUrl: `${mock.origin}/v1`,
      })
      assert.equal(result.source, 'remote')
      assert.deepEqual(result.models.map((item) => item.id).sort(), ['llama3:latest', 'qwen2.5:7b'])
    })

    await check('探测失败 / 无 Key：降级内置目录并给出 warning', async () => {
      const failed = await listModels({ provider: 'deepseek', baseUrl: `${mock.origin}/v1`, apiKey: '' })
      assert.equal(failed.source, 'catalog')
      assert.ok(failed.models.length > 0, '应返回内置目录')
      assert.ok(typeof failed.warning === 'string' && failed.warning.length > 0, '应说明降级原因')

      const missing = await listModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', timeoutMs: 500 })
      assert.equal(missing.source, 'catalog')
      assert.ok(missing.models.length > 0)
    })

    await check('OpenCode：内置多协议目录（同一 Key 下不同模型走不同 api）', async () => {
      const result = await listModels({ provider: 'opencode' })
      assert.equal(result.source, 'catalog')
      const apis = new Set(result.models.map((item) => item.api))
      assert.ok(apis.has('anthropic-messages'), '目录应包含 Anthropic 协议模型')
      assert.ok(apis.has('openai-responses'), '目录应包含 Responses 协议模型')
      assert.ok(apis.has('google-generative-ai'), '目录应包含 Gemini 协议模型')
      const gpt = result.models.find((item) => item.id === 'gpt-5')
      assert.equal(gpt.api, 'openai-responses')
    })

    await check('千问 / 硅基流动：没有内置目录时返回推荐列表', async () => {
      const qwen = await listModels({ provider: 'qwen' })
      assert.ok(qwen.models.some((item) => item.id === 'qwen-plus'))
      assert.ok(qwen.models.some((item) => item.id === 'qwen-vl-max' && item.vision === true))
      const silicon = await listModels({ provider: 'siliconflow' })
      assert.ok(silicon.models.some((item) => item.id === 'deepseek-ai/DeepSeek-V3'))
    })
  } finally {
    await mock.close().catch(() => {})
  }

  await check('POST /api/llm/models：同 provider 复用已保存 Key，跨 provider 不复用', async () => {
    const mock = await startMockVendor()
    const saved = { provider: 'deepseek', apiKey: 'sk-saved' }
    const route = createLlmModelRoutes({
      appConfig: { whenReady: async () => {}, getLlmConfig: () => saved },
      log: { info: () => {}, warn: () => {} },
    }).find((item) => item.name === 'llm-models')
    assert.ok(route)
    const host = await mountRoute(route)
    try {
      // 同 provider：请求体不带 Key，Host 用已保存的 Key 拉在线列表。
      const same = await fetch(`${host.origin}/api/llm/models`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ provider: 'deepseek', baseUrl: `${mock.origin}/v1` }),
      })
      const sameBody = await same.json()
      assert.equal(same.status, 200)
      assert.equal(sameBody.ok, true)
      assert.equal(sameBody.source, 'mixed')
      assert.ok(sameBody.models.some((item) => item.id === 'deepseek-chat'))

      // 跨 provider：不复用已保存的 Key，在线探测失败降级目录。
      const cross = await fetch(`${host.origin}/api/llm/models`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ provider: 'openai', baseUrl: `${mock.origin}/v1` }),
      })
      const crossBody = await cross.json()
      assert.equal(crossBody.source, 'catalog', '跨 provider 不应把 deepseek 的 Key 发给 openai')
      assert.ok(crossBody.models.length > 0)

      // 非法 provider：400，不触发任何外部请求。
      const invalid = await fetch(`${host.origin}/api/llm/models`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ provider: 'not-a-provider' }),
      })
      assert.equal(invalid.status, 400)
    } finally {
      await host.close().catch(() => {})
      await mock.close().catch(() => {})
    }
  })

  await check('probeModels 拒绝缺少 Key 的必需鉴权 Provider', async () => {
    await assert.rejects(
      () => probeModels({ provider: 'deepseek', baseUrl: 'https://example.com/v1', apiKey: '' }),
      (error) => /API Key/.test(error.message),
    )
  })

  const result = summary()
  process.exitCode = result.failed > 0 ? 1 : process.exitCode
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
