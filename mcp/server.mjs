#!/usr/bin/env node
/**
 * AIGC Studio MCP Server（stdio）。
 *
 * 定位（M3.3）：只做「MCP 协议 ↔ 本地 HTTP API」的适配，不持有队列 / 会话 / GPU 状态：
 *  - 启动时**不**连本地服务，`tools/list` 不依赖应用是否在运行；
 *  - 每次工具调用前读取 `runtime.json` 发现端口与 Bearer Token（`--runtime` → 环境变量 → 默认数据目录）；
 *  - 只允许回环 `origin`，Token 只放请求头，不写日志、不进返回值；
 *  - stdout 只能有 JSON-RPC：所有日志写 stderr，禁止 console.log。
 *
 * 用法：
 *   node mcp/server.mjs                 # stdio 服务（Claude Desktop / Cursor 拉起）
 *   node mcp/server.mjs --print-config  # 打印可粘贴的客户端配置
 *   node mcp/server.mjs --runtime <path>
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { APP_VERSION, presetById } from '../shared/contract.js'
import { categoryLabelOf, searchRecipes, templateFor } from '../shared/recipes.js'
import { TOOL_SPECS, toolSpecOf } from '../shared/tool-specs.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_NAME = 'aigc-studio'
const RUNTIME_SCHEMA = 1
const DEFAULT_WAIT_SECONDS = 60
const MAX_WAIT_SECONDS = 300
const POLL_INTERVAL_MS = 1000
const MAX_INLINE_IMAGES = 4
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024

function log(message) {
  try {
    process.stderr.write(`[aigc-studio-mcp] ${message}\n`)
  } catch {}
}

// ---- 参数与发现 ---------------------------------------------------------

function parseArgs(argv) {
  const options = { runtime: null, printConfig: false, dataDir: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--print-config') options.printConfig = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--runtime') options.runtime = argv[++index] ?? null
    else if (arg.startsWith('--runtime=')) options.runtime = arg.slice('--runtime='.length)
    else if (arg === '--data-dir') options.dataDir = argv[++index] ?? null
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length)
  }
  return options
}

/** 与 server/app-config.js 的 defaultDataDir 保持同一口径（MCP 不 import 服务端装配）。 */
function defaultDataDir(env = process.env) {
  if (typeof env.AIGC_STUDIO_DATA_DIR === 'string' && env.AIGC_STUDIO_DATA_DIR.trim()) {
    return resolve(env.AIGC_STUDIO_DATA_DIR.trim())
  }
  if (process.platform === 'win32') {
    const base = typeof env.APPDATA === 'string' && env.APPDATA ? env.APPDATA : join(homedir(), 'AppData', 'Roaming')
    return join(base, 'aigc-studio')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'aigc-studio')
  const base = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(homedir(), '.config')
  return join(base, 'aigc-studio')
}

function runtimePathOf(options) {
  if (options.runtime) return resolve(options.runtime)
  if (typeof process.env.AIGC_STUDIO_RUNTIME === 'string' && process.env.AIGC_STUDIO_RUNTIME.trim()) {
    return resolve(process.env.AIGC_STUDIO_RUNTIME.trim())
  }
  return join(options.dataDir ? resolve(options.dataDir) : defaultDataDir(), 'runtime.json')
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname
    return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host)
  } catch {
    return false
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM：进程存在但无权限（本机同一用户通常不会遇到）；ESRCH：确实不存在。
    return error?.code === 'EPERM'
  }
}

class ToolError extends Error {
  constructor(code, message, status = null) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * 读取并校验 runtime.json。每次调用都重新读：应用可能重启换了端口/Token，
 * 缓存只会让用户看到「Token 已失效」却无法自愈。
 */
async function loadRuntime(options) {
  const file = runtimePathOf(options)
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new ToolError('runtime_missing', `未找到 ${file}。请先启动 AIGC Studio（应用启动后会写入发现文件）`)
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    throw new ToolError('runtime_invalid', `发现文件不是合法 JSON：${file}（可删除后重启应用）`)
  }
  if (Number(data?.schema) !== RUNTIME_SCHEMA) {
    throw new ToolError('runtime_invalid', `发现文件 schema=${data?.schema}，本 MCP 需要 schema=${RUNTIME_SCHEMA}`)
  }
  if (typeof data?.origin !== 'string' || !isLoopbackOrigin(data.origin)) {
    throw new ToolError('runtime_invalid', '发现文件里的 origin 不是回环地址，已拒绝连接')
  }
  if (typeof data?.token !== 'string' || !data.token) {
    throw new ToolError('runtime_invalid', '发现文件缺少 token，请重启 AIGC Studio')
  }
  if (!pidAlive(Number(data?.pid))) {
    throw new ToolError('runtime_stale', `发现文件已过期（pid=${data?.pid} 未运行）。请重新启动 AIGC Studio`)
  }
  return { ...data, file }
}

// ---- HTTP ---------------------------------------------------------------

function apiUrl(runtime, pathname, query = null) {
  const url = new URL(pathname, runtime.origin)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function apiFetch(runtime, pathname, { method = 'GET', body = null, query = null, timeoutMs = 30000 } = {}) {
  const headers = {
    authorization: `Bearer ${runtime.token}`,
    accept: 'application/json',
  }
  if (body !== null) headers['content-type'] = 'application/json'
  let res
  try {
    res = await fetch(apiUrl(runtime, pathname, query), {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new ToolError('timeout', `请求超时：${pathname}`)
    throw new ToolError('unreachable', `无法连接本地服务（${runtime.origin}）：${error?.message ?? error}`)
  }
  const text = await res.text().catch(() => '')
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new ToolError('unauthorized', '本地服务鉴权失败：Token 已失效，请重启 MCP 进程（应用可能已重启）', 401)
    }
    if (res.status === 404) {
      throw new ToolError('not_found', payload?.message ?? payload?.error?.message ?? '接口不存在', 404)
    }
    const message =
      payload?.message ?? payload?.error?.message ?? payload?.error ?? `HTTP ${res.status}`
    throw new ToolError(payload?.code ?? payload?.error?.code ?? 'http_error', String(message), res.status)
  }
  return payload
}

// ---- 格式化 -------------------------------------------------------------

function formatJob(job) {
  if (!job) return '任务不存在'
  const lines = []
  lines.push(`任务 ${job.id}：${job.status}${job.seconds != null ? `（${job.seconds}s）` : ''}`)
  if (job.tool === 'upscale') {
    lines.push(`高清放大 · 源图 ${job.params?.width ?? '?'}×${job.params?.height ?? '?'}`)
  } else if (job.params) {
    lines.push(
      `预设：${job.presetId ?? '未知'} · 尺寸 ${job.params.width}×${job.params.height} · ${job.params.steps} 步 · cfg ${job.params.cfg} · seed ${job.params.seed}`,
    )
  }
  if (job.error) lines.push(`错误：${job.error.code} ${job.error.message}`)
  if (job.output?.images?.length) {
    lines.push('产物：')
    for (const image of job.output.images) {
      lines.push(`- ${image.path}（${image.width}×${image.height}，seed ${image.seed}）`)
    }
    for (const path of job.output.deliveredPaths ?? []) lines.push(`已交付至：${path}`)
  } else if (job.status === 'cancelled') {
    lines.push('任务已取消，没有可展示的图片。')
  } else if (job.status !== 'done') {
    lines.push('任务仍在进行中，可用 imagen_history 查看结果，或再次调用查询 jobId。')
  }
  if (job.progress && Number.isFinite(Number(job.progress.step))) {
    lines.push(`进度：${job.progress.step}/${job.progress.steps} 步`)
  }
  return lines.join('\n')
}

function formatSession(state) {
  const session = state?.session ?? {}
  const lines = [
    `会话状态：${session.state ?? 'unknown'}${session.phase ? `（${session.phase}）` : ''}`,
    session.detail ? `说明：${session.detail}` : null,
    session.device ? `设备：${session.device}${session.deviceCount ? ` ×${session.deviceCount}` : ''}` : null,
    state?.version ? `应用版本：${state.version}（协议 ${state.protocol ?? '?'}）` : null,
    session.error ? `错误：${session.error.code} ${session.error.message}` : null,
  ]
  return lines.filter(Boolean).join('\n')
}

function formatHistory(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : []
  if (items.length === 0) return '还没有生成记录。'
  const lines = []
  for (const item of items) {
    lines.push(`${item.createdAt ?? item.dir} · ${item.presetId ?? '未知预设'}`)
    lines.push(`  ${String(item.prompt ?? '').slice(0, 120)}`)
    for (const image of item.images ?? []) lines.push(`  ${image.path}`)
  }
  return lines.join('\n')
}

function formatRecipes(args) {
  const result = searchRecipes({
    keyword: typeof args.keyword === 'string' ? args.keyword : '',
    category: typeof args.category === 'string' ? args.category : '',
    presetId: typeof args.presetId === 'string' ? args.presetId : '',
    tags: Array.isArray(args.tags) ? args.tags : [],
    limit: args.limit,
  })
  if (result.items.length === 0) return result.hint || '没有匹配的配方，请换关键词或去掉过滤条件。'
  const preferred = typeof args.presetId === 'string' ? args.presetId : ''
  const lines = [`配方库共 ${result.total} 条匹配（返回 ${result.items.length} 条）：`]
  for (const recipe of result.items) {
    lines.push(`【${recipe.title}】（${recipe.id}）· 分类：${categoryLabelOf(recipe.category)} · 建议比例：${recipe.ratioId}`)
    lines.push(`  标签：${(recipe.tags ?? []).join('、')}`)
    const presetIds = preferred && recipe.recommendedPresets.includes(preferred)
      ? [preferred, ...recipe.recommendedPresets.filter((id) => id !== preferred)]
      : recipe.recommendedPresets
    for (const presetId of presetIds) {
      const resolved = templateFor(recipe, presetById(presetId))
      if (!resolved) continue
      lines.push(`  - ${presetId}（${resolved.style}）：${resolved.template}`)
    }
    lines.push(`  负向提示词：${recipe.negativePrompt?.trim() ? recipe.negativePrompt : '留空'}`)
  }
  return lines.join('\n')
}

// ---- 工具执行 -----------------------------------------------------------

function clampWaitSeconds(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_WAIT_SECONDS
  return Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.round(number)))
}

function stripMcpArgs(args) {
  const { includeImage, ...rest } = args ?? {}
  return { rest, includeImage: includeImage === true }
}

async function waitJob(runtime, jobId, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000
  let last = null
  while (Date.now() < deadline) {
    last = await apiFetch(runtime, '/api/job', { query: { id: jobId } })
    if (['done', 'failed', 'cancelled'].includes(last?.status)) return last
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return last
}

async function inlineImages(runtime, job) {
  const workspace = typeof runtime.workspace === 'string' ? runtime.workspace : ''
  if (!workspace) return []
  const blocks = []
  for (const image of (job?.output?.images ?? []).slice(0, MAX_INLINE_IMAGES)) {
    try {
      const absolute = isAbsolute(image.path) ? image.path : join(workspace, image.path)
      const buffer = await readFile(absolute)
      if (buffer.length > MAX_INLINE_IMAGE_BYTES) continue
      blocks.push({ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' })
    } catch {
      // 读不到就只返回文本路径，不让图片块拖垮整次调用。
    }
  }
  return blocks
}

async function readImageSize(absolutePath) {
  const buffer = await readFile(absolutePath)
  if (buffer.length >= 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG：扫描 SOF0/SOF2 段读宽高（与 Host 的 parseImageHeader 同口径，只支持常见基线/渐进）。
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return null
}

async function callTool(name, args, options) {
  const spec = toolSpecOf(name)
  if (!spec) throw new ToolError('unknown_tool', `未知工具：${name}`)
  const runtime = await loadRuntime(options)

  if (name === 'imagen_generate') {
    const { rest, includeImage } = stripMcpArgs(args)
    const job = await apiFetch(runtime, '/api/generate', {
      method: 'POST',
      body: { ...rest, waitSeconds: 0 },
      timeoutMs: 60000,
    })
    const final = await waitJob(runtime, job.id, clampWaitSeconds(rest.waitSeconds))
    const content = [{ type: 'text', text: formatJob(final ?? job) }]
    if (includeImage && final?.status === 'done') content.push(...(await inlineImages(runtime, final)))
    return { content }
  }

  if (name === 'imagen_batch') {
    const { rest, includeImage } = stripMcpArgs(args)
    const items = Array.isArray(rest.items) ? rest.items : []
    if (items.length === 0) throw new ToolError('invalid_request', 'items 必须是非空数组')
    const budget = clampWaitSeconds(rest.waitSeconds)
    const shared = {}
    for (const key of ['presetId', 'width', 'height', 'steps', 'cfg']) {
      if (rest[key] !== undefined && rest[key] !== null) shared[key] = rest[key]
    }
    const submitted = []
    for (const item of items) {
      const request = { ...shared, prompt: item?.prompt }
      if (item?.negativePrompt !== undefined) request.negativePrompt = item.negativePrompt
      if (item?.seed !== undefined) request.seed = item.seed
      if (item?.saveTo !== undefined) request.saveTo = item.saveTo
      if (Array.isArray(rest.references)) request.references = rest.references
      try {
        const job = await apiFetch(runtime, '/api/generate', {
          method: 'POST',
          body: { ...request, waitSeconds: 0 },
          timeoutMs: 60000,
        })
        submitted.push({ item, jobId: job.id, job: null, error: null })
      } catch (error) {
        submitted.push({ item, jobId: null, job: null, error })
      }
    }
    const deadline = Date.now() + budget * 1000
    for (const record of submitted) {
      if (!record.jobId) continue
      const remaining = Math.max(0, deadline - Date.now())
      if (remaining <= 0) break
      record.job = await waitJob(runtime, record.jobId, Math.ceil(remaining / 1000))
    }
    const lines = [`批量任务 ${submitted.length} 条（预算 ${budget}s）：`]
    submitted.forEach((record, index) => {
      const label = `#${index + 1}`
      if (record.error) {
        lines.push(`${label} 提交失败：${record.error.code} ${record.error.message}`)
        return
      }
      const job = record.job
      lines.push(
        `${label} ${job?.status ?? '进行中'} · jobId=${record.jobId}` +
          (job?.output?.images?.length ? ` · ${job.output.images.map((image) => image.path).join('、')}` : '') +
          (job?.error ? ` · 失败：${job.error.code} ${job.error.message}` : ''),
      )
    })
    const content = [{ type: 'text', text: lines.join('\n') }]
    if (includeImage) {
      for (const record of submitted) {
        if (record.job?.status === 'done') content.push(...(await inlineImages(runtime, record.job)))
      }
    }
    return { content }
  }

  if (name === 'imagen_upscale') {
    const { rest, includeImage } = stripMcpArgs(args)
    const requested = typeof rest.path === 'string' ? rest.path.trim() : ''
    if (!requested) throw new ToolError('invalid_request', 'path 不能为空')
    const workspace = typeof runtime.workspace === 'string' ? runtime.workspace : ''
    let width = rest.width
    let height = rest.height
    if ((!width || !height) && workspace && !isAbsolute(requested)) {
      const size = await readImageSize(join(workspace, requested)).catch(() => null)
      if (size) {
        width = width ?? size.width
        height = height ?? size.height
      }
    }
    const body = {
      tool: 'upscale',
      prompt: '',
      reference: { path: requested },
      autoStart: true,
      waitSeconds: 0,
    }
    if (width) body.width = width
    if (height) body.height = height
    if (rest.saveTo) body.saveTo = rest.saveTo
    const job = await apiFetch(runtime, '/api/generate', { method: 'POST', body, timeoutMs: 60000 })
    const final = await waitJob(runtime, job.id, clampWaitSeconds(rest.waitSeconds))
    const content = [{ type: 'text', text: formatJob(final ?? job) }]
    if (includeImage && final?.status === 'done') content.push(...(await inlineImages(runtime, final)))
    return { content }
  }

  if (name === 'imagen_history') {
    const limit = Number(args?.limit)
    const payload = await apiFetch(runtime, '/api/history', {
      query: { limit: Number.isFinite(limit) ? Math.max(1, Math.round(limit)) : undefined },
    })
    return { content: [{ type: 'text', text: formatHistory(payload) }] }
  }

  if (name === 'imagen_cancel') {
    const jobId = String(args?.jobId ?? '').trim()
    if (!jobId) throw new ToolError('invalid_request', 'jobId 不能为空')
    const result = await apiFetch(runtime, '/api/job/cancel', { method: 'POST', body: { id: jobId } })
    return {
      content: [
        {
          type: 'text',
          text: `已取消 ${jobId}（${result?.disposition ?? 'unknown'}）`,
        },
      ],
    }
  }

  if (name === 'imagen_session') {
    const action = String(args?.action ?? 'status')
    if (action === 'start') {
      const body = {}
      if (args?.presetId) body.presetId = args.presetId
      const result = await apiFetch(runtime, '/api/session/start', { method: 'POST', body, timeoutMs: 15 * 60000 })
      return { content: [{ type: 'text', text: formatSession({ session: result?.session }) }] }
    }
    if (action === 'stop') {
      const result = await apiFetch(runtime, '/api/session/stop', { method: 'POST', body: {} })
      return { content: [{ type: 'text', text: formatSession({ session: result?.session }) }] }
    }
    const state = await apiFetch(runtime, '/api/state')
    return { content: [{ type: 'text', text: formatSession(state) }] }
  }

  if (name === 'imagen_recipes') {
    return { content: [{ type: 'text', text: formatRecipes(args ?? {}) }] }
  }

  throw new ToolError('unknown_tool', `未知工具：${name}`)
}

// ---- MCP 装配 -----------------------------------------------------------

/** 工具列表：在共享规格上追加 MCP 专属的 `includeImage`（不进入本地 API 参数）。 */
function listTools() {
  return TOOL_SPECS.map((spec) => {
    if (!['imagen_generate', 'imagen_batch', 'imagen_upscale'].includes(spec.name)) {
      return { name: spec.name, description: spec.description, inputSchema: spec.parameters }
    }
    const parameters = {
      ...spec.parameters,
      properties: {
        ...spec.parameters.properties,
        includeImage: {
          type: 'boolean',
          description: '可选：返回图片内容块（base64），默认关闭以避免几 MB 的图片卡住客户端',
        },
      },
    }
    return { name: spec.name, description: spec.description, inputSchema: parameters }
  })
}

async function runStdio(options) {
  const server = new Server(
    { name: SERVER_NAME, version: APP_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params?.name ?? '')
    const args = request.params?.arguments ?? {}
    try {
      return await callTool(name, args, options)
    } catch (error) {
      const code = error?.code ?? 'tool_failed'
      const message = error?.message ?? String(error)
      log(`${name} failed: ${code} ${message}`)
      return {
        content: [{ type: 'text', text: `${code}: ${message}` }],
        isError: true,
      }
    }
  })

  await server.connect(new StdioServerTransport())
  log(`ready（runtime=${runtimePathOf(options)}）`)
}

function printConfig(options) {
  const config = {
    mcpServers: {
      [SERVER_NAME]: {
        command: 'node',
        args: [join(HERE, 'server.mjs')],
        env: { AIGC_STUDIO_DATA_DIR: options.dataDir ? resolve(options.dataDir) : defaultDataDir() },
      },
    },
  }
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stderr.write(
      'AIGC Studio MCP Server\n' +
        '  node mcp/server.mjs                 stdio 服务\n' +
        '  node mcp/server.mjs --print-config  打印 Claude Desktop / Cursor 配置\n' +
        '  --runtime <path>                   指定 runtime.json\n' +
        '  --data-dir <path>                  指定应用数据目录\n',
    )
    return
  }
  if (options.printConfig) {
    printConfig(options)
    return
  }
  await runStdio(options)
}

main().catch((error) => {
  log(`fatal: ${error?.stack ?? error}`)
  process.exit(1)
})

