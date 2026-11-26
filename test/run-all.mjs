#!/usr/bin/env node
/**
 * 统一测试入口：按分组顺序执行全部离线回归。
 *
 * 用法：
 *   node test/run-all.mjs                  # 等价 --group all（contract + client + host）
 *   node test/run-all.mjs --group client   # 只跑客户端组
 *   node test/run-all.mjs --group worker   # 只跑 Python 端（python test/worker/run.py）
 *   node test/run-all.mjs --list           # 只打印将要执行的命令
 *
 * 分组（docs/MIGRATION_SPEC.md §9.3）：
 *   contract  契约 + 资产一致性（shared/contract.js 单源、worker/contract.json、模型资产）
 *   client    web 纯逻辑 / 渲染（需要先构建 test/.build/web.test.js，测试内部会自动构建）
 *   host      server 端到端（含新增 standalone-server / llm-client 两个真进程 / 真 HTTP 用例）
 *   worker    Python 执行端（python test/worker/run.py，与原 test/remote/run.py 等价）
 *
 * 约定：
 *  - 顺序执行（child_process.spawn + stdio inherit），不并行，避免临时目录 / 端口互相干扰；
 *  - 任一步失败不中断，跑完整组后以非零退出码收尾，并列出失败的步骤；
 *  - client 组的 check-client-*.mjs 自动发现，新增拆分文件无需改本文件；
 *  - live 用例（kaggle-live.mjs / gpu-live.mjs）需要真实 Kaggle/Colab 凭据，不在默认分组内。
 */

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(TEST_DIR)

const NODE = 'node'
const PYTHON = 'python'

/**
 * host 组固定条目（server 端到端）。
 *
 * 前两条是新增的真实进程 / 真实 HTTP 测试：
 *  - standalone-server.mjs：spawn server/standalone.js，验证 ready / 401 / Token / 工作区切换 / 静态资源；
 *  - llm-client.mjs：本地 mock SSE 服务验证 server/llm 流式客户端与 invokeLlm 汇总。
 * 最后一条 smoke-image.mjs 是「带真实图片」的 Electron 冒烟：临时工作区放真实 PNG 后
 * 走 SMOKE_CAPTURE，校验 `/api/file` 的图 complete 且 naturalWidth>0（堵住空工作区测试盲区）；
 * 无 Electron 二进制时用例内部 SKIP 并返回 0。
 */
const hostGroup = [
  'standalone-server.mjs',
  'llm-client.mjs',
  'llm-models.mjs',
  'agent-runtime.mjs',
  'agent-batch.mjs',
  'net-fallback.mjs',
  'host-e2e.mjs',
  'remote-v2.mjs',
  'mcp-server.mjs',
  'import-host.mjs',
  'settings-host.mjs',
  'ui-state-host.mjs',
  'kaggle-direct.mjs',
  'kaggle-oauth.mjs',
  'colab-oauth.mjs',
  'host-log.mjs',
  'host-log-events.mjs',
  'kernel-package.mjs',
  'check-verify-model.mjs',
  'session-pure.mjs',
  'library-atomic.mjs',
  'jobs-wait.mjs',
  'smoke-image.mjs',
  'session-reliability.mjs',
  'session-pending-cleanup.mjs',
  'session-race.mjs',
  'session-restore.mjs',
  'session-worker.mjs',
  'worker-host.mjs',
  // M3.4 本机 GPU：配置 / sd-server 参数 / 协议映射 / 本机桥鉴权与幂等（不启真实 GPU）。
  'local-gpu-runtime.mjs',
  'cloud-api.mjs',
  'salad-provider.mjs',
  'cloud-video.mjs',
  // 资产工坊（M4.2a/b）：复合资产包落盘 / ZIP 导出 / SVG 矢量，与抹除背景 / PBR 的队列链路。
  'host-workshop.mjs',
  'host-workshop-gpu.mjs',
  'host-local-pbr.mjs',
  'game-styles.mjs',
  // 工坊 L2 端侧视觉（M4.2c Phase 2）：下载校验 / 缓存 / 冷却 / 串行推理 / 路由。
  'host-workshop-vision.mjs',
  // 本机端侧模型统一管理：清单、全局目录、旧工作区兼容、下载校验、清理与流式读取。
  'host-local-models.mjs',
  'update-check.mjs',
  'update-policy.mjs',
  'updater-main.mjs',
  'app-settings-update.mjs',
  'telemetry.mjs',
  'onboarding-host.mjs',
  'locale-detection.mjs',
]

const contractGroup = ['check-contract.mjs', 'check-variants.mjs', 'tool-specs.mjs', 'agent-batch.mjs']

/** client 组里非 check-client-* 的固定条目（顺序与旧 test:client 一致）。 */
const clientTail = ['image-tool.mjs', 'reference.mjs', 'image-tool-render.mjs', 'outpaint.mjs', 'chat-timeline.mjs', 'import-client.mjs', 'render-harness.mjs', 'lineage.mjs', 'logs-diagnostics.mjs']

/** worker 组：Python 执行端测试（原 test/remote/run.py，改名后为 test/worker/run.py）。 */
const workerGroup = [{ command: PYTHON, args: [join('test', 'worker', 'run.py')], name: 'test/worker/run.py' }]

/**
 * 自动发现 client 组的 check-client-*.mjs（含已拆分的 shell / chat / tools / kaggle）。
 */
function discoverClientChecks() {
  return readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^check-client-.*\.mjs$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

function toStep(entry) {
  if (typeof entry === 'string') {
    return { name: `test/${entry}`, command: NODE, args: [join('test', entry)] }
  }
  return entry
}

function buildGroups() {
  return {
    contract: contractGroup.map(toStep),
    client: [...discoverClientChecks(), ...clientTail].map(toStep),
    host: hostGroup.map(toStep),
    worker: workerGroup,
  }
}

const GROUP_NAMES = ['contract', 'client', 'host', 'worker']
/** 默认 npm test 只跑离线三组（worker 需要 Python，单独 --group worker / npm run test:worker）。 */
const DEFAULT_GROUPS = ['contract', 'client', 'host']

function parseArgs(argv) {
  const options = { group: 'all', list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') {
      options.list = true
      continue
    }
    if (arg === '--group') {
      const value = argv[index + 1]
      if (!value) throw new Error(`--group 需要一个值：${['all', ...GROUP_NAMES].join(' | ')}`)
      options.group = value
      index += 1
      continue
    }
    if (arg.startsWith('--group=')) {
      options.group = arg.slice('--group='.length)
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }
  if (options.group !== 'all' && !GROUP_NAMES.includes(options.group)) {
    throw new Error(`--group 只支持 ${['all', ...GROUP_NAMES].join(' | ')}，收到：${options.group}`)
  }
  return options
}

function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { cwd: ROOT, stdio: 'inherit', shell: false })
    child.once('error', (error) => resolve({ ok: false, error }))
    child.once('close', (code, signal) => {
      resolve({ ok: code === 0, code, signal })
    })
  })
}

function describe(step) {
  return `${step.command} ${step.args.join(' ')}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const groups = buildGroups()
  const selected = options.group === 'all' ? DEFAULT_GROUPS : [options.group]

  // `agent-batch.mjs` 同时属于 contract 与 host 组：分组单跑时各跑一次，
  // `all` 里只保留第一次，避免同一条命令重复执行。
  const steps = []
  const seen = new Set()
  for (const name of selected) {
    for (const step of groups[name]) {
      const key = describe(step)
      if (selected.length > 1 && seen.has(key)) continue
      seen.add(key)
      steps.push({ group: name, ...step })
    }
  }

  if (options.list) {
    for (const step of steps) console.log(`[${step.group}] ${describe(step)}`)
    console.log(`\n共 ${steps.length} 条命令，分组：${selected.join(', ')}`)
    return
  }

  const failures = []
  let currentGroup = null
  for (const [index, step] of steps.entries()) {
    if (step.group !== currentGroup) {
      currentGroup = step.group
      console.log(`\n════════ ${currentGroup} (${steps.filter((item) => item.group === currentGroup).length} 步) ════════\n`)
    }
    console.log(`\n──── [${index + 1}/${steps.length}] ${describe(step)}\n`)
    const result = await runStep(step)
    if (!result.ok) {
      const reason = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : `exit ${result.code}`
      failures.push({ step, reason })
      console.log(`\n✗ 失败（${reason}）：${describe(step)}`)
    }
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`失败 ${failures.length}/${steps.length} 步：`)
    for (const { step, reason } of failures) console.log(`  - [${step.group}] ${describe(step)}（${reason}）`)
    process.exitCode = 1
    return
  }
  console.log(`全部通过：${steps.length}/${steps.length} 步`)
}

main().catch((error) => {
  console.error(error?.message ?? error)
  process.exitCode = 1
})
