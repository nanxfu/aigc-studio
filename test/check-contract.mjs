/**
 * 契约单一来源校验（A 阶段 P1 验收脚本，只读）。
 *
 * 校验目标：`shared/contract.js` 是唯一契约源，仓库里的宿主 / 客户端 / 远端 / 测试 / 文档
 * 是否都跟着它走。脚本只读文件，不改任何东西；失败时退出码 1，并把缺失/多余项原样列出。
 *
 * 检查项（对应 docs/refactor/REFACTOR_PROPOSAL.md P1）：
 *   a. package.json.version === contract.APP_VERSION（产品版本；VERSION 必须等于它）
 *   b. 路由注册（server/app.js + server/routes/**）去重后 === ROUTES；出现的 /api/ 字面量 ⊆ 路由表
 *   c. server/routes/**\/*.js 内的 /api/ 字面量 ⊆ 路由表（server/output.js 拼预览 URL 用得到）
 *   d. web/**\/*.js(x) 不出现 'api/' 字面量、不 import server/（必须走 routePath）
 *   e. server/** 内 emit 的错误码 ⊆ ERROR_CODES；hostErrorCodes() 在 zh/en 字典都有文案
 *   f. 协议版本单源：daemonContract().version / worker/daemon.py / worker/contract.json /
 *      test/mock-daemon.py / test/tunnel-probe.py === PROTOCOL_VERSION（与产品版本分离）
 *   g. daemon 协议：/health /logs /generate /shutdown 与 healthPhases 全部取值
 *   h. docs/SPEC.md 包含全部路由路径与全部 host+worker 错误码
 *   i. server/presets.js 不再定义预设数据
 *   j. worker/contract.json 与 shared/contract.js 的 daemonContract() 一致，且下发对象只含
 *      version + limits（Host/Client 专有的路由、health phase、ntfy 事件、错误码不再下发远端；P10 生成物）
 *   k. models/*.json 与 shared/models.generated.js 同步（模型资产的唯一来源是 models/）
 *   l. 局部重绘契约键（LIMITS.strength.inpaintMax / LIMITS.mask.minCoverage）存在并已下发远端
 *   m. 原生参考生图契约键（LIMITS.referenceImages）存在、已下发远端，且协议字段名与远端实现同源
 *   n. 模型能力位 supportsReference 与推理加速开关 pipeline.accel 的资产校验规则
 *
 * 运行：node test/check-contract.mjs
 */

import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  APP_VERSION,
  PROTOCOL_VERSION,
  VERSION,
  ROUTES,
  ERROR_CODES,
  PRESETS,
  PROTOCOL,
  LIMITS,
  PIPELINE_ACCEL_KEYS,
  PROVIDER_IDS,
  PROVIDERS,
  SETTINGS,
  daemonContract,
  hostErrorCodes,
} from '../shared/contract.js'
import { PUBLIC_PRESETS } from '../shared/models.generated.js'
import { loadModels, renderGenerated, readGenerated } from '../tools/build-assets.mjs'
import { createCheckRunner } from './helpers/check.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ROUTE_LIST = Object.values(ROUTES).map((route) => route.path)
// 同一 path 可以有多条 entry（如 settings 的 GET 读 / POST 存）：注册端按 path 去重比较，
// 因此「期望集合」也要先去重，否则永远差 1 条。
const ROUTE_PATH_LIST = [...new Set(ROUTE_LIST)]
const ROUTE_SET = new Set(ROUTE_LIST)
// hostErrorCodes() 已同时包含 host 与 remote 两层（远端码由 Host 透传）。
const HOST_CODES = hostErrorCodes()
const API_CODE_RE = /\/api\/[A-Za-z0-9_\-/]*/g

const runner = createCheckRunner()

function pass(id, title, note = '') {
  runner.record(true, id)
  console.log(`✓ ${id}. ${title}${note ? `（${note}）` : ''}`)
}

function fail(id, title, details = []) {
  runner.record(false, id)
  console.log(`✗ ${id}. ${title}`)
  for (const detail of details) console.log(`    - ${detail}`)
}

/** 只用于“不算失败”的补充信息。 */
function note(text) {
  console.log(`    · ${text}`)
}

async function readText(relPath) {
  return readFile(join(ROOT, relPath), 'utf8')
}

/** 递归列出相对路径（POSIX 风格），用于 web/ 与 server/ 的批量扫描。 */
async function listSourceFiles(relDir, extensions) {
  const found = []
  async function walk(absDir) {
    const entries = await readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        found.push(relative(ROOT, abs).replace(/\\/g, '/'))
      }
    }
  }
  await walk(join(ROOT, relDir))
  return found.sort()
}

/**
 * 把注释内容替换成空格（保留换行与列位置）。
 * 用途：区分“代码里真的用了字面量”与“注释里提到过”，后者不应算失败。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length))
}

/** 提取文本里所有 /api/... 字面量（去掉行尾斜杠）。 */
function apiLiterals(text) {
  return [...new Set((text.match(API_CODE_RE) ?? []).map((value) => value.replace(/\/+$/, '')))]
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── a. 产品版本（package.json ↔ APP_VERSION）────────────────────────────────
async function checkPackageVersion() {
  const pkg = JSON.parse(await readText('package.json'))
  const details = []
  if (pkg.version !== APP_VERSION) {
    details.push(`package.json: ${pkg.version}`, `contract.APP_VERSION: ${APP_VERSION}`)
  }
  // VERSION 只是产品版本的兼容别名：如果它被误改成协议版本，所有旧调用点都会静默漂移。
  if (VERSION !== APP_VERSION) details.push(`contract.VERSION=${VERSION} 必须等于 APP_VERSION=${APP_VERSION}`)
  if (details.length) return fail('a', '产品版本不一致（package.json ↔ APP_VERSION）', details)
  pass('a', '产品版本一致', `APP_VERSION=${APP_VERSION}`)
}

// ── b. 路由注册（server/app.js + server/routes/**）────────────────────────
// 路由注册点在 server/app.js 装配、具体定义在 server/routes/**；这里统一扫描
// server/app.js 与 server/routes 下所有 .js，支持「字面量」与「ROUTES 引用」两类写法，去重后比对契约。

/** camelCase → kebab-case，用于 effect 标签软检查（sessionStart → session-start）。 */
function kebabCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/** 本文件里代表 ROUTES 的标识符：默认 ROUTES，外加 `import { ROUTES as R }` 的别名。 */
function routeRoots(code) {
  const roots = ['ROUTES']
  for (const match of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*shared\/contract\.js['"]/g)) {
    for (const part of match[1].split(',')) {
      const alias = part.trim().match(/^ROUTES\s+as\s+([A-Za-z_$][\w$]*)$/)
      if (alias) roots.push(alias[1])
    }
  }
  return roots
}

/** 单文件内从 ROUTES 解构出的别名（`const { state, probe: p } = ROUTES` → p.path 可解析）。 */
function routeAliases(code, roots) {
  const rootPattern = roots.map(escapeRegExp).join('|')
  const pattern = new RegExp(`const\\s*\\{([^}]+)\\}\\s*=\\s*(?:${rootPattern})\\b`, 'g')
  const aliases = new Map()
  for (const match of code.matchAll(pattern)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const field = piece.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?$/)
      if (!field) continue
      aliases.set(field[2] ?? field[1], field[1])
    }
  }
  return aliases
}

/**
 * 解析一个 `path:` 表达式：
 *  - literal：字符串或无插值模板字符串（`'/api/x'`）；
 *  - route：`ROUTES.x.path`、`ROUTES['x'].path`（含 import 别名）或解构别名 `x.path`；
 *  - unresolved：引用了 ROUTES 但无法静态解析（必须报出来，不能静默放过）；
 *  - ignored：与路由无关的 path 属性（如 server/output.js 的图片记录 `path: relative`）。
 */
function resolvePathExpression(expr, aliases, roots) {
  // 去掉对象/调用收尾的噪音字符（`path: ROUTES.x.path }`、`path: relative })`），
  // 否则同一行没有逗号时会把合法的字面量/引用误判成 ignored。
  const text = expr.trim().replace(/[\s})\]]+$/, '')
  const literal = text.match(/^'([^']*)'$/) ?? text.match(/^"([^"]*)"$/) ?? text.match(/^`([^`$]*)`$/)
  if (literal) return { kind: 'literal', value: literal[1] }
  const rootPattern = roots.map(escapeRegExp).join('|')
  const routeRef = text.match(
    new RegExp(`^(?:${rootPattern})\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*['"]([A-Za-z_$][\\w$]*)['"]\\s*\\])\\s*\\.\\s*path$`),
  )
  if (routeRef) return { kind: 'route', name: routeRef[1] ?? routeRef[2] }
  const aliasRef = text.match(/^([A-Za-z_$][\w$]*)\s*\.\s*path$/)
  if (aliasRef && aliases.has(aliasRef[1])) return { kind: 'route', name: aliases.get(aliasRef[1]) }
  if (new RegExp(`\\b(?:${rootPattern})\\b`).test(text)) return { kind: 'unresolved', expr: text }
  return { kind: 'ignored', expr: text }
}

/**
 * 从 `[{ file, text }]` 收集路由注册；导出给 `%TEMP%` 模拟脚本复用。
 * @returns {{ paths: {file:string,path:string}[], unresolved: {file:string,expr:string}[],
 *             ignored: {file:string,expr:string}[], literals: {file:string,literal:string}[],
 *             effectLabels: Set<string> }}
 */
export function collectRouteRegistrations(entries) {
  const paths = []
  const unresolved = []
  const ignored = []
  const literals = []
  const effectLabels = new Set()
  const routeNames = new Set()
  for (const { file, text } of entries) {
    const code = stripComments(text)
    const roots = routeRoots(code)
    const aliases = routeAliases(code, roots)
    for (const match of code.matchAll(/\bpath\s*:\s*([^,\n]+)/g)) {
      const resolved = resolvePathExpression(match[1], aliases, roots)
      if (resolved.kind === 'literal') {
        if (resolved.value.startsWith('/')) paths.push({ file, path: resolved.value })
        else ignored.push({ file, expr: resolved.value })
      } else if (resolved.kind === 'route') {
        if (ROUTES[resolved.name]) paths.push({ file, path: ROUTES[resolved.name].path })
        else unresolved.push({ file, expr: `ROUTES.${resolved.name}.path（契约未登记）` })
      } else if (resolved.kind === 'unresolved') {
        unresolved.push({ file, expr: resolved.expr })
      } else {
        ignored.push({ file, expr: resolved.expr })
      }
    }
    for (const literal of apiLiterals(code)) literals.push({ file, literal })
    // effect 标签软检查素材：静态标签、路由描述对象的 name（server/route-kit.js 生成 `imagen:route-${route.name}`）。
    for (const match of code.matchAll(/imagen:route-([a-z0-9-]+)/g)) effectLabels.add(match[1])
    for (const match of code.matchAll(/\bname\s*:\s*'([a-z][a-z0-9-]*)'/g)) routeNames.add(match[1])
  }
  return { paths, unresolved, ignored, literals, effectLabels, routeNames }
}

async function checkHostRoutes() {
  const files = ['server/app.js', ...(await listSourceFiles('server/routes', ['.js']))]
  const entries = []
  for (const file of files) entries.push({ file, text: await readFile(join(ROOT, file), 'utf8') })
  const { paths, unresolved, ignored, literals, effectLabels, routeNames } = collectRouteRegistrations(entries)

  const details = []
  const unique = [...new Set(paths.map((item) => item.path))]
  // 契约里同一 path 可能对应多条位（GET/POST），注册端只能按 path 表达，故按唯一路径比较。
  if (unique.length !== ROUTE_PATH_LIST.length) {
    details.push(`注册路由数 ${unique.length}，契约唯一路径 ${ROUTE_PATH_LIST.length}（共 ${ROUTE_LIST.length} 条 entry）`)
  }
  const missing = ROUTE_PATH_LIST.filter((route) => !unique.includes(route))
  const extra = unique.filter((route) => !ROUTE_SET.has(route))
  if (missing.length) details.push(`缺：${missing.join(', ')}`)
  if (extra.length) details.push(`多：${extra.join(', ')}`)
  if (unresolved.length) {
    details.push(
      `无法静态解析的 path 表达式：${unresolved.map((item) => `${item.file}: ${item.expr}`).join(' | ')}`,
    )
  }

  const uniqueLiterals = [...new Set(literals.map((item) => item.literal))]
  const unknownLiterals = uniqueLiterals.filter((literal) => !ROUTE_SET.has(literal))
  if (unknownLiterals.length) {
    details.push(
      `未登记路由字面量：${unknownLiterals
        .map((literal) => {
          const where = [...new Set(literals.filter((item) => item.literal === literal).map((item) => item.file))]
          return `${literal}（${where.join('/')}）`
        })
        .join(', ')}`,
    )
  }

  if (ignored.length) {
    const samples = [...new Set(ignored.map((item) => `${item.file}: path: ${item.expr}`))].slice(0, 3)
    note(`忽略 ${ignored.length} 处非路由 path 表达式（如 ${samples.join('；')}）`)
  }
  // effect 标签软检查：拆分前每条路由注册的标签是 `imagen:route-<kebab(name)>`；
  // 拆分后由 server/route-kit.js 用 `imagen:route-${route.name}` 生成，因此同时接受
  // “静态标签”和“路由描述对象的 name 字段”两种证据。只 note、不计失败。
  const expectedNames = Object.keys(ROUTES).map((name) => kebabCase(name))
  const covered = expectedNames.filter((name) => effectLabels.has(name) || routeNames.has(name))
  const missingNames = expectedNames.filter((name) => !covered.includes(name))
  if (covered.length > 0 && missingNames.length) {
    note(
      `effect 标签覆盖 ${covered.length}/${expectedNames.length}（不计失败）：缺 ${missingNames
        .map((name) => `imagen:route-${name}`)
        .join(', ')}`,
    )
  }

  if (details.length) return fail('b', '路由注册（index.js + server/**）与契约不一致', details)
  const filesWithRoutes = [...new Set(paths.map((item) => item.file))]
  pass(
    'b',
    `路由注册与契约一致（去重 ${unique.length} 条路径）`,
    `契约 ${ROUTE_LIST.length} 条 entry、扫描 ${files.length} 个文件，命中 ${filesWithRoutes.length} 个`,
  )
}

// ── c. lib 层路由字面量 ────────────────────────────────────────────────────
async function checkLibRoutes() {
  const files = await listSourceFiles('server/routes', ['.js'])
  const details = []
  let count = 0
  for (const file of files) {
    const code = stripComments(await readFile(join(ROOT, file), 'utf8'))
    const literals = apiLiterals(code)
    count += literals.length
    const unknown = literals.filter((route) => !ROUTE_SET.has(route))
    if (unknown.length) details.push(`${file}: ${unknown.join(', ')}`)
  }
  if (details.length) return fail('c', 'server/routes 内存在未登记路由字面量', details)
  pass('c', 'server/routes 内路由字面量均来自契约', `${files.length} 个文件、${count} 处`)
}

/**
 * 去掉模块说明符字符串（`from '../api/resources.js'`、`import('../api/x.js')`），
 * 只保留真正的运行时代码文本。否则 `/api/...` 形态的模块路径会被误判成 API 字面量
 * （DSH 时代的前缀是 `/imagen-api/`，与模块路径不会撞形；standalone 的 `/api/` 会）。
 */
function stripModuleSpecifiers(code) {
  return code
    .replace(/\bfrom\s*(['"])[^'"]*\1/g, 'from ""')
    .replace(/\bimport\s*\(\s*(['"])[^'"]*\1\s*\)/g, 'import("")')
    .replace(/\bimport\s*(['"])(?:\.\.?\/)[^'"]*\1/g, 'import ""')
}

// ── d. 客户端不得自带前缀、不得越层 import ─────────────────────────────────
async function checkClientLayer() {
  const files = await listSourceFiles('web', ['.js', '.jsx'])
  const details = []
  const commentMentions = []
  let routePathFiles = 0
  for (const file of files) {
    const raw = await readFile(join(ROOT, file), 'utf8')
    const code = stripModuleSpecifiers(stripComments(raw))
    const codeHits = apiLiterals(code)
    if (codeHits.length) details.push(`${file}: 代码字面量 ${codeHits.join(', ')}`)
    if (raw.includes('/api/') && codeHits.length === 0) commentMentions.push(file)
    if (code.includes('routePath')) routePathFiles += 1
    for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec.split('/').includes('server')) details.push(`${file}: 越层 import ${spec}`)
    }
  }
  if (commentMentions.length) note(`注释中仍提及 /api/：${commentMentions.join('、')}（不计失败）`)
  if (details.length) return fail('d', '客户端未完全走 routePath 或存在越层 import', details)
  pass('d', '客户端无 /api/ 字面量、无 server/ import', `${files.length} 个文件，${routePathFiles} 个使用 routePath`)
}

// ── e. 错误码 ──────────────────────────────────────────────────────────────
const HOST_CODE_PATTERNS = [
  /sendError\(\s*[^,]+,\s*\d+\s*,\s*'([^']+)'/g,
  /\bfail\(\s*'([^']+)'/g,
  /\bcode:\s*'([^']+)'/g,
  /\berrorCode:\s*'([^']+)'/g,
  /\bcode\s*=\s*'([^']+)'/g,
]

async function checkErrorCodes() {
  // 错误码发射点遍布 server/**（路由、会话、队列、输出等），这里全量扫描。
  const files = ['server/app.js', ...(await listSourceFiles('server', ['.js']))]
  const emitted = new Map()
  for (const file of files) {
    const code = stripComments(await readFile(join(ROOT, file), 'utf8'))
    for (const [patternIndex, pattern] of HOST_CODE_PATTERNS.entries()) {
      // server/providers/** 的阶段函数 `fail('provision'/'teardown'/'capability')` 是
      // provider 生命周期步骤名，不是错误码；只对这一类新骨架跳过 fail() 模式。
      if (patternIndex === 1 && file.startsWith('server/providers/')) continue
      for (const match of code.matchAll(pattern)) {
        const name = match[1]
        // 只接受 snake_case 错误码：`code:` / `errorCode:` 也可能出现在普通报文与文案里，
        // 带空格、换行或括号的捕获一定是误报（错误码词表全是 snake_case）。
        if (!/^[a-z][a-z0-9_]*$/.test(name)) continue
        if (!emitted.has(name)) emitted.set(name, new Set())
        emitted.get(name).add(file)
      }
    }
  }

  const details = []
  const unknown = [...emitted.keys()].filter((name) => !(name in ERROR_CODES))
  if (unknown.length) {
    details.push(`未登记错误码：${unknown.map((name) => `${name}（${[...emitted.get(name)].join('/')}）`).join('、')}`)
  }

  const zh = await readText('web/dict/zh.js')
  const en = await readText('web/dict/en.js')
  const missingZh = HOST_CODES.filter((name) => !zh.includes(`'error.code.${name}'`))
  const missingEn = HOST_CODES.filter((name) => !en.includes(`'error.code.${name}'`))
  if (missingZh.length) details.push(`zh 字典缺文案：${missingZh.join(', ')}`)
  if (missingEn.length) details.push(`en 字典缺文案：${missingEn.join(', ')}`)

  if (details.length) return fail('e', '错误码未闭环', details)
  pass('e', `宿主 emit 的 ${emitted.size} 个错误码均登记且有中英文案`, `契约 host+remote ${HOST_CODES.length} 个`)
}

// ── f. 协议版本单源（与产品版本分离）──────────────────────────────────────
async function checkVersions() {
  const details = []
  const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/
  if (!SEMVER.test(PROTOCOL_VERSION)) details.push(`contract.PROTOCOL_VERSION=${PROTOCOL_VERSION} 不是三段语义化版本`)

  const sent = daemonContract().version
  if (sent !== PROTOCOL_VERSION) {
    details.push(`daemonContract().version=${sent}，契约 PROTOCOL_VERSION=${PROTOCOL_VERSION}`)
  }

  const daemon = await readText('worker/daemon.py')
  const daemonVersion = daemon.match(/^VERSION\s*=\s*"([^"]+)"/m)
  if (!daemonVersion) details.push('worker/daemon.py 缺少 VERSION 常量')
  else if (daemonVersion[1] !== PROTOCOL_VERSION) {
    details.push(`worker/daemon.py VERSION=${daemonVersion[1]}，协议版本=${PROTOCOL_VERSION}`)
  }

  // worker/contract.json 是 daemonContract() 的生成物：这里单独比较 version，
  // 让「协议版本没跟上」与「limits 漂移」在失败信息里能区分开（全量比较见检查项 j）。
  try {
    const contract = JSON.parse(await readText('worker/contract.json'))
    if (contract?.version !== PROTOCOL_VERSION) {
      details.push(`worker/contract.json version=${contract?.version ?? '缺失'}，协议版本=${PROTOCOL_VERSION}`)
    }
  } catch {
    details.push('worker/contract.json 不可读（先运行 npm run contract:gen）')
  }

  for (const file of ['test/mock-daemon.py', 'test/tunnel-probe.py']) {
    const text = await readText(file)
    const match = text.match(/^VERSION\s*=\s*"([^"]+)"/m)
    if (!match) {
      details.push(`${file} 缺少 VERSION 常量`)
      continue
    }
    const base = match[1].split('-')[0]
    if (base !== PROTOCOL_VERSION) details.push(`${file} VERSION=${match[1]}，前缀不是 ${PROTOCOL_VERSION}`)
  }

  // server/app.js 允许保留常量，但值必须是**产品版本**（对外展示用），不能写成协议版本。
  const index = stripComments(await readText('server/app.js'))
  const indexVersion = index.match(/const\s+VERSION\s*=\s*'([^']+)'/)
  if (indexVersion && indexVersion[1] !== APP_VERSION) {
    details.push(`server/app.js const VERSION=${indexVersion[1]}，产品版本=${APP_VERSION}`)
  }

  if (details.length) return fail('f', '协议版本不一致（Host↔Worker）', details)
  pass('f', '协议版本单源一致', `PROTOCOL_VERSION=${PROTOCOL_VERSION}（产品版本 APP_VERSION=${APP_VERSION} 独立校验）`)
}

// ── g. daemon 协议 ────────────────────────────────────────────────────────
async function checkDaemonProtocol() {
  // 协议出口在 Batch 2 切片⑥ 之后分两处：路由与鉴权在传输层，phase 取值在生命周期
  // （app.py 的 bootstrapping 列表）。三份合并扫描，避免"实现搬家 → 校验静默失去意义"。
  const files = ['worker/daemon.py', 'worker/transport/http_server.py', 'worker/app.py']
  const sources = await Promise.all(files.map((file) => readText(file)))
  const daemon = sources.join('\n')
  const details = []
  for (const [name, route] of Object.entries(PROTOCOL.daemon.routes)) {
    const quoted = daemon.includes(`"${route.path}"`) || daemon.includes(`'${route.path}'`)
    if (!quoted) details.push(`缺少 daemon 路由 ${name} ${route.path}`)
  }
  for (const phase of PROTOCOL.daemon.healthPhases) {
    const quoted = daemon.includes(`"${phase}"`) || daemon.includes(`'${phase}'`)
    if (!quoted) details.push(`缺少 health phase 取值 ${phase}`)
  }
  if (details.length) return fail('g', 'daemon 协议与契约不一致', details)
  pass(
    'g',
    'daemon 协议端点与 health 阶段齐全',
    `${Object.keys(PROTOCOL.daemon.routes).length} 路由、${PROTOCOL.daemon.healthPhases.length} 个 phase（扫描 ${files.length} 个文件）`,
  )
}

// ── h. SPEC 文档跟随契约 ──────────────────────────────────────────────────
async function checkSpecDoc() {
  const spec = await readText('docs/SPEC.md')
  const details = []
  for (const route of ROUTE_LIST) {
    const pattern = new RegExp(`${escapeRegExp(route)}(?![A-Za-z0-9_\\-/])`)
    if (!pattern.test(spec)) details.push(`缺少路由：${route}`)
  }
  for (const code of HOST_CODES) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(code)}(?![A-Za-z0-9_])`)
    if (!pattern.test(spec)) details.push(`缺少错误码：${code}`)
  }
  if (details.length) return fail('h', 'docs/SPEC.md 未跟随契约', details)
  pass('h', 'docs/SPEC.md 覆盖全部路由与 host+remote 错误码', `${ROUTE_LIST.length} 路由、${HOST_CODES.length} 错误码`)
}

// ── i. 预设数据已上移 ─────────────────────────────────────────────────────
async function checkPresetsMoved() {
  const code = stripComments(await readText('server/presets.js'))
  const hits = ['sdxl-lightning', 'sdxl-turbo', 'sdxl-base', 'flux2-klein-4b'].filter((id) => code.includes(id))
  if (hits.length) return fail('i', 'server/presets.js 仍在定义预设数据', [`出现预设 id 字面量：${hits.join(', ')}`])
  pass('i', 'server/presets.js 只引用契约，不再定义预设数据')
}

// ── j. worker/contract.json 与 daemonContract() 一致 ──────────────────────

/** 深比较两个 JSON 值，把差异路径收集到 `out`（键顺序不计）。 */
function collectContractDiff(expected, actual, out = [], path = '') {
  const kind = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)
  const expectedKind = kind(expected)
  const actualKind = kind(actual)
  if (expectedKind !== actualKind) {
    out.push(`${path || '（根）'}: 期望 ${expectedKind}，实际 ${actualKind}`)
    return out
  }
  if (expectedKind === 'object') {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const child = path ? `${path}.${key}` : key
      if (!(key in expected)) out.push(`${child}: 实际多出 ${JSON.stringify(actual[key])}`)
      else if (!(key in actual)) out.push(`${child}: 实际缺失（期望 ${JSON.stringify(expected[key])}）`)
      else collectContractDiff(expected[key], actual[key], out, child)
    }
    return out
  }
  if (expectedKind === 'array') {
    if (expected.length !== actual.length) {
      out.push(`${path}: 数组长度 期望 ${expected.length}，实际 ${actual.length}`)
      return out
    }
    expected.forEach((item, index) => collectContractDiff(item, actual[index], out, `${path}[${index}]`))
    return out
  }
  if (!Object.is(expected, actual)) {
    out.push(`${path || '（根）'}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
  return out
}

async function checkRemoteContract() {
  const rel = 'worker/contract.json'
  let text
  try {
    text = await readText(rel)
  } catch {
    return fail('j', `${rel} 不存在或不可读`, [
      '契约导出物缺失：先运行 `node tools/gen-contract-json.mjs` 生成（P10-a）',
    ])
  }
  let actual
  try {
    actual = JSON.parse(text)
  } catch (error) {
    return fail('j', `${rel} 不是合法 JSON`, [String(error?.message ?? error)])
  }
  const expected = daemonContract()
  // 形状锁定：daemon 只消费 contract.version 与 contract.limits。routes / healthPhases /
  // ntfyEvents / errorCodes 属于 Host/Client，若被重新塞回下发对象，这里必须失败。
  const topKeys = Object.keys(expected).sort()
  if (topKeys.join(',') !== 'limits,version') {
    return fail('j', 'daemonContract() 顶层字段不符合远端契约（应只含 version + limits）', [
      `实际顶层键：${topKeys.join(', ') || '（空）'}`,
    ])
  }
  const diffs = collectContractDiff(expected, actual)
  if (diffs.length) {
    const shown = diffs.slice(0, 20)
    if (diffs.length > shown.length) shown.push(`…共 ${diffs.length} 处差异`)
    return fail('j', `${rel} 与 daemonContract() 不一致`, shown)
  }
  pass('j', `${rel} 与 daemonContract() 一致`, `${Object.keys(expected).length} 个顶层键：${topKeys.join(' + ')}`)
}

// ── k. 模型资产生成文件同步 ───────────────────────────────────────────────
// models/*.json 是模型定义的唯一来源；shared/models.generated.js 是构建产物。
// 这里直接复用 build-assets 的读取/渲染函数，避免两套校验口径。
async function checkModelAssets() {
  try {
    const models = await loadModels()
    const expected = renderGenerated(models)
    const actual = await readGenerated()
    if (actual === expected) {
      const ids = models.map((model) => model.id).join(', ')
      return pass('k', '模型资产生成文件与 models/ 同步', `${models.length} 个：${ids}`)
    }
    return fail('k', 'shared/models.generated.js 与 models/ 不同步', [
      actual === null ? '生成文件缺失' : '生成文件内容与 models/ 不一致',
      '修改模型后运行 npm run models:build（node tools/build-assets.mjs）',
    ])
  } catch (error) {
    return fail('k', '模型资产校验未通过', [String(error?.message ?? error)])
  }
}

// ── l. 局部重绘契约键（inpaintMax / minCoverage）──────────────────────────
// 这两个键是 Host / Client / Daemon 三端共同消费的接口约定（客户端直接读 LIMITS 决定滑块
// 上限与空蒙版文案），键名或取值漂移会让「带蒙版 1.0、纯 img2img 0.9」的放宽静默失效。
async function checkInpaintContract() {
  const strength = LIMITS.strength
  const mask = LIMITS.mask
  const details = []
  if (strength.max !== 0.9) {
    details.push(`LIMITS.strength.max=${strength.max}（img2img 保守上限应保持 0.9）`)
  }
  if (strength.inpaintMax !== 1.0) {
    details.push(`LIMITS.strength.inpaintMax=${strength.inpaintMax}（蒙版场景上限应为 1.0）`)
  }
  if (!(strength.inpaintMax > strength.max)) details.push('inpaintMax 必须大于 max（只放宽蒙版场景）')
  if (mask.minCoverage !== 0.0005) {
    details.push(`LIMITS.mask.minCoverage=${mask.minCoverage}（空蒙版阈值应为 0.0005）`)
  }
  if (!(mask.minCoverage > 0 && mask.minCoverage < 1)) details.push('minCoverage 必须在 (0, 1) 之间')

  const sent = daemonContract().limits
  if (sent.strength?.inpaintMax !== strength.inpaintMax) details.push('daemonContract() 未下发 strength.inpaintMax')
  if (sent.mask?.minCoverage !== mask.minCoverage) details.push('daemonContract() 未下发 mask.minCoverage')

  let remote = null
  try {
    remote = JSON.parse(await readText('worker/contract.json'))
  } catch {
    details.push('worker/contract.json 不可读（先运行 npm run contract:gen）')
  }
  if (remote) {
    if (remote?.limits?.strength?.inpaintMax !== strength.inpaintMax) {
      details.push('worker/contract.json 缺 limits.strength.inpaintMax')
    }
    if (remote?.limits?.mask?.minCoverage !== mask.minCoverage) {
      details.push('worker/contract.json 缺 limits.mask.minCoverage')
    }
  }

  if (details.length) return fail('l', '局部重绘契约键未闭环', details)
  pass(
    'l',
    '局部重绘契约键齐备并已下发远端',
    `inpaintMax=${strength.inpaintMax} / minCoverage=${mask.minCoverage}`,
  )
}

// ── m. 原生参考生图契约键（referenceImages）──────────────────────────────
// Phase C1：参考图列表与单图垫图是两条互斥路径，边界、字段名与远端实现必须同源，
// 否则「Host 放的 / daemon 拒的」会静默漂移（旧 Host 兼容时也按同一份内置 contract.json）。
async function checkReferenceImagesContract() {
  const limits = LIMITS.referenceImages
  const details = []
  const required = ['maxCount', 'maxBytes', 'maxEdge', 'minEdge']
  for (const key of required) {
    if (!limits || typeof limits[key] !== 'number') details.push(`LIMITS.referenceImages.${key} 必须是数字`)
  }
  if (limits) {
    if (!(limits.maxCount >= 1 && limits.maxCount <= 8)) {
      details.push(`maxCount=${limits.maxCount} 应在 1~8（真机数据回来后只改契约）`)
    }
    if (!(limits.maxBytes > 0)) details.push('maxBytes 必须为正数')
    if (!(limits.maxEdge > limits.minEdge && limits.minEdge > 0)) {
      details.push(`长边边界非法：maxEdge=${limits.maxEdge} minEdge=${limits.minEdge}`)
    }
    // 与单图垫图的独立口径：不能把两个 maxEdge / maxBytes 混为一份（混了就分不清语义）。
    if (limits.maxBytes === LIMITS.reference.maxBytes && limits.maxEdge === LIMITS.reference.maxEdge) {
      details.push('referenceImages 与 reference 的边界完全相同：请确认两条路径确实共用同一口径')
    }
  }

  // 下发远端：daemonContract() 与生成物 worker/contract.json 都必须带 referenceImages。
  const sent = daemonContract().limits
  if (!sent.referenceImages) {
    details.push('daemonContract().limits 缺 referenceImages')
  } else if (JSON.stringify(sent.referenceImages) !== JSON.stringify(limits)) {
    details.push('daemonContract().limits.referenceImages 与 LIMITS.referenceImages 不一致')
  }
  try {
    const remote = JSON.parse(await readText('worker/contract.json'))
    if (!remote?.limits?.referenceImages) details.push('worker/contract.json 缺 limits.referenceImages')
  } catch {
    details.push('worker/contract.json 不可读（先运行 npm run contract:gen）')
  }

  // 协议字段名与远端实现同源：PROTOCOL.daemon.referenceImages 声明的 job 级字段与逐项字段
  // 必须真的出现在远端代码里，不能只写在契约注释中。
  const protocol = PROTOCOL.daemon.referenceImages
  if (!protocol || protocol.field !== 'referenceImages') {
    details.push('PROTOCOL.daemon.referenceImages.field 必须是 referenceImages')
  }
  const remoteCodec = await readText('worker/inference/reference_codec.py')
  for (const field of protocol?.itemFields ?? []) {
    if (!remoteCodec.includes(`"${field}"`)) details.push(`reference_codec.py 未消费逐项字段 ${field}`)
  }
  const transport = `${await readText('worker/transport/http_server.py')}\n${await readText('worker/daemon.py')}`
  if (!transport.includes('"referenceImages"') && !transport.includes("'referenceImages'") && !transport.includes('referenceImages=')) {
    details.push('远端 HTTP / daemon 未出现 referenceImages 字段')
  }
  if (!transport.includes('SUPPORTED_REFERENCE_LOADERS')) {
    details.push('daemon 未导出 SUPPORTED_REFERENCE_LOADERS（缺少 loader 白名单兜底）')
  }

  if (details.length) return fail('m', '原生参考生图（referenceImages）契约未闭环', details)
  pass(
    'm',
    '原生参考生图契约键齐备并已下发远端',
    `maxCount=${limits.maxCount} / maxBytes=${limits.maxBytes} / maxEdge=${limits.maxEdge} / minEdge=${limits.minEdge}`,
  )
}

// ── n. 模型能力位 supportsReference 与推理加速开关 accel 的资产规则 ────────
async function checkModelCapabilityAssets() {
  const details = []
  let models = []
  try {
    models = await loadModels()
  } catch (error) {
    return fail('n', '模型资产读取失败', [String(error?.message ?? error)])
  }
  const flux = models.find((model) => model.id === 'flux2-klein-4b')
  if (!flux) details.push('缺少 flux2-klein-4b 模型资产')
  else if (flux.supportsReference !== true) details.push('flux2-klein-4b 的 supportsReference 必须为 true')
  for (const model of models) {
    if (typeof model.supportsReference !== 'boolean') {
      details.push(`${model.id} 的 supportsReference 必须是布尔值（必填）`)
    }
    if (model.supportsReference === true && !['flux2', 'qwen-image-2.1'].includes(model.pipeline?.loader)) {
      details.push(`${model.id} 标了 supportsReference=true：当前只有 flux2 / qwen-image-2.1 系列支持参考生图`)
    }
    if (model.supportsReference === true && model.supportsImg2Img === true) {
      details.push(`${model.id} 同时标了 supportsReference 与 supportsImg2Img（互斥的请求形状）`)
    }
  }
  // 公开视图（Client / /state）必须带能力位；pipeline 细节不下发客户端。
  for (const preset of PUBLIC_PRESETS) {
    if (typeof preset.supportsReference !== 'boolean') {
      details.push(`PUBLIC_PRESETS.${preset.id} 缺布尔 supportsReference`)
    }
    if ('pipeline' in preset) details.push(`PUBLIC_PRESETS.${preset.id} 不应包含 pipeline`)
  }

  // 资产校验规则：用临时目录构造非法资产，确认 build-assets 真的会拒绝（防止「文档写了、代码没查」）。
  let dir = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'imagen-model-assets-'))
    const base = JSON.parse(await readText('models/flux2-klein-4b.json'))
    const cases = [
      [
        '缺少 supportsReference',
        (() => {
          const copy = structuredClone(base)
          delete copy.supportsReference
          return copy
        })(),
        'supportsReference',
      ],
      [
        'supportsReference 非布尔',
        { ...structuredClone(base), supportsReference: 'yes' },
        'supportsReference',
      ],
      [
        '同时声明两种参考能力',
        { ...structuredClone(base), supportsImg2Img: true },
        '互斥',
      ],
      [
        'accel 未知键',
        (() => {
          const copy = structuredClone(base)
          copy.pipeline = { ...copy.pipeline, accel: { unknownFlag: true } }
          return copy
        })(),
        'accel 含未知键',
      ],
      [
        'accel 非布尔值',
        (() => {
          const copy = structuredClone(base)
          copy.pipeline = { ...copy.pipeline, accel: { vaeTiling: 1 } }
          return copy
        })(),
        '必须是布尔值',
      ],
    ]
    for (const [label, model, needle] of cases) {
      const file = join(dir, `${base.id}.json`)
      await writeFile(file, `${JSON.stringify(model, null, 2)}\n`, 'utf8')
      let message = null
      try {
        await loadModels(dir)
      } catch (error) {
        message = String(error?.message ?? error)
      }
      if (!message) details.push(`${label}：应被 build-assets 拒绝却通过了`)
      else if (!message.includes(needle)) details.push(`${label}：报错信息缺少「${needle}」（${message}）`)
      await rm(file, { force: true })
    }
  } catch (error) {
    details.push(`资产校验用例本身失败：${String(error?.message ?? error)}`)
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  // accel 键名镜像：daemon 无法 import JS，远端 loader 的 ACCEL_FLAGS 必须与契约同名。
  const loader = await readText('worker/inference/loaders/diffusers.py')
  for (const key of PIPELINE_ACCEL_KEYS) {
    if (!loader.includes(`"${key}"`)) details.push(`worker/inference/loaders/diffusers.py 缺加速开关 ${key}`)
  }

  if (details.length) return fail('n', '模型能力位 / 加速开关的资产规则未闭环', details)
  pass(
    'n',
    '模型能力位与加速开关资产规则齐备',
    `supportsReference 必填布尔、accel 键 ${PIPELINE_ACCEL_KEYS.join('/')} 已镜像远端`,
  )
}

// ── o. 算力来源能力域（PROVIDERS ↔ SETTINGS ↔ Provider 注册表）──────────────
// M3.0 起算力来源不再是散落在 session / settings / models-guide 里的字符串：
// 契约登记能力位，服务端注册表按 id 构造实现，`SETTINGS.providers` 只表示「当前可选」。
async function checkProviderDomain() {
  const details = []
  const meta = Object.entries(PROVIDERS)
  if (meta.length !== PROVIDER_IDS.length) details.push('PROVIDER_IDS 与 PROVIDERS 键集合不一致')
  for (const id of PROVIDER_IDS) {
    const item = PROVIDERS[id]
    if (!item || typeof item !== 'object') {
      details.push(`${id} 缺少能力位`)
      continue
    }
    if (!['notebook', 'worker'].includes(item.kind)) details.push(`${id}.kind 必须是 notebook / worker`)
    for (const key of ['enabled', 'reattach', 'pendingCleanup', 'remoteShutdown', 'idleTimeout', 'logs', 'binary', 'events']) {
      if (typeof item[key] !== 'boolean') details.push(`${id}.${key} 必须是布尔值`)
    }
  }
  const enabled = PROVIDER_IDS.filter((id) => PROVIDERS[id]?.enabled === true)
  if (SETTINGS.providers.join(',') !== enabled.join(',')) {
    details.push(`SETTINGS.providers=[${SETTINGS.providers.join(', ')}] 必须等于已启用的来源 [${enabled.join(', ')}]`)
  }
  if (!enabled.includes(SETTINGS.defaultProvider)) {
    details.push(`SETTINGS.defaultProvider=${SETTINGS.defaultProvider} 不在已启用来源内`)
  }

  // 注册表必须覆盖全部已知 id（静态扫描构造分支的字面量）。
  let registry = ''
  try {
    registry = await readText('server/providers/index.js')
  } catch {
    details.push('server/providers/index.js 不存在')
  }
  if (registry) {
    for (const id of PROVIDER_IDS) {
      if (!registry.includes(`'${id}'`) && !registry.includes(`"${id}"`)) {
        details.push(`server/providers/index.js 未登记来源 ${id}`)
      }
    }
  }

  // 模型资产只能声明已知来源（能力位来自同一张表，不能出现第三种拼写）。
  try {
    const models = await loadModels()
    for (const model of models) {
      for (const id of model.providers ?? []) {
        if (!PROVIDER_IDS.includes(id)) details.push(`${model.id}.providers 含未知来源 ${id}`)
      }
    }
  } catch {
    // 资产读取失败由检查项 k 报出，这里不重复。
  }

  if (details.length) return fail('o', '算力来源能力域未闭环', details)
  pass(
    'o',
    '算力来源能力域齐备',
    `${PROVIDER_IDS.length} 个来源（可选 ${enabled.join(' / ')}）、注册表与契约同源`,
  )
}

// ── main ──────────────────────────────────────────────────────────────────
const CHECKS = [
  checkPackageVersion,
  checkHostRoutes,
  checkLibRoutes,
  checkClientLayer,
  checkErrorCodes,
  checkVersions,
  checkDaemonProtocol,
  checkSpecDoc,
  checkPresetsMoved,
  checkRemoteContract,
  checkModelAssets,
  checkInpaintContract,
  checkReferenceImagesContract,
  checkModelCapabilityAssets,
  checkProviderDomain,
]

async function main() {
  console.log('契约校验（shared/contract.js 为唯一来源）')
  console.log(`APP_VERSION=${APP_VERSION}  PROTOCOL_VERSION=${PROTOCOL_VERSION}  路由=${ROUTE_LIST.length}  错误码=${Object.keys(ERROR_CODES).length}（host+remote ${HOST_CODES.length}）  预设=${PRESETS.length}`)
  console.log('')

  for (const check of CHECKS) await check()

  console.log('')
  const failed = runner.results.filter((item) => !item.ok)
  const total = CHECKS.length
  const passedCount = total - failed.length
  if (failed.length === 0) {
    console.log(`契约校验通过：${passedCount}/${total} 项`)
    return
  }
  console.log(`契约校验失败：${failed.length}/${total} 项未通过（${failed.map((item) => item.name).join(', ')}）`)
  process.exitCode = 1
}

// 仅当本文件被直接执行时跑校验；被 `%TEMP%` 模拟脚本 import 时只复用 collectRouteRegistrations。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error('契约校验脚本自身出错：', error)
    process.exitCode = 1
  })
}
