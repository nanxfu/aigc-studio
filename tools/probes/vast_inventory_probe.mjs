#!/usr/bin/env node
/**
 * Vast.ai 只读库存探针（不创建实例、不产生流量费）。
 *
 * 过滤口径：
 *  - 单卡 RTX 3090 / RTX 4090；
 *  - 下载带宽 inet_down >= 1000 Mbps；
 *  - 下载流量单价 inet_down_cost <= $0.002/GB（同时统计 $0 档）；
 *  - 磁盘 >= 50 GB；
 *  - on-demand、rentable、小时价 <= $0.50。
 *
 * 只调用 POST /api/v0/bundles，不写账户状态。Key 从 VAST_API_KEY 或仓库根 .env 读取，
 * 永不打印。
 *
 * 用法：
 *   node tools/probes/vast_inventory_probe.mjs
 *   node tools/probes/vast_inventory_probe.mjs --json bench-results/vast-inventory/summary.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENDPOINT = 'https://console.vast.ai/api/v0/bundles/'
const GPU_NAMES = ['RTX 3090', 'RTX 4090']
const MAX_DPH = 0.5
const MIN_DOWN = 1000
const MAX_DOWN_COST = 0.002
const MIN_DISK_GB = 50

function apiKey() {
  const fromEnv = String(process.env.VAST_API_KEY || '').trim()
  if (fromEnv) return fromEnv
  const envPath = resolve(ROOT, '.env')
  let text = ''
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    throw new Error('缺少 VAST_API_KEY（环境变量或仓库根 .env 均可）')
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*VAST_API_KEY\s*=\s*(.*)\s*$/)
    if (!match) continue
    const value = match[1].replace(/^['"]|['"]$/g, '').trim()
    if (value) return value
  }
  throw new Error('缺少 VAST_API_KEY（环境变量或仓库根 .env 均可）')
}

function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function summarize(offers) {
  const priced = offers
    .map((offer) => ({
      id: offer.id,
      gpu_name: offer.gpu_name,
      num_gpus: finite(offer.num_gpus),
      dph_total: finite(offer.dph_total),
      inet_down: finite(offer.inet_down),
      inet_down_cost: finite(offer.inet_down_cost),
      disk_space: finite(offer.disk_space),
      geolocation: offer.geolocation ?? null,
      rentable: offer.rentable === true,
    }))
    .filter((offer) => offer.dph_total !== null)
    .sort((a, b) => a.dph_total - b.dph_total)

  const prices = priced.map((offer) => offer.dph_total)
  const median = prices.length === 0
    ? null
    : (() => {
        const sorted = [...prices].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
      })()

  return {
    count: priced.length,
    zeroDownloadCost: priced.filter((offer) => offer.inet_down_cost === 0).length,
    minDph: prices.length ? prices[0] : null,
    medianDph: median,
    maxDph: prices.length ? prices[prices.length - 1] : null,
    cheapest: priced.slice(0, 5),
  }
}

async function query(key, gpuName) {
  // /bundles/ 的请求体就是筛选器本身（不是 {q: ...}）；order / type / limit
  // 也放在同一层，与 vastai SDK 的 search_offers 保持同形。
  const body = {
    gpu_name: { eq: gpuName },
    num_gpus: { eq: 1 },
    inet_down: { gte: MIN_DOWN },
    inet_down_cost: { lte: MAX_DOWN_COST },
    disk_space: { gte: MIN_DISK_GB },
    dph_total: { lte: MAX_DPH },
    rentable: { eq: true },
    order: [['dph_total', 'asc']],
    type: 'on-demand',
    limit: 50,
    allocated_storage: 5,
  }
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Vast ${gpuName} 查询失败：HTTP ${response.status} ${text.slice(0, 300)}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`Vast ${gpuName} 返回非 JSON：${text.slice(0, 200)}`)
  }
  const offers = Array.isArray(payload?.offers) ? payload.offers : []
  return {
    gpuName,
    filters: body,
    ...summarize(offers),
  }
}

function parseArgs(argv) {
  let jsonPath = ''
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') {
      jsonPath = argv[index + 1] || ''
      index += 1
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('node tools/probes/vast_inventory_probe.mjs [--json <path>]')
      process.exit(0)
    } else {
      throw new Error(`未知参数：${argv[index]}`)
    }
  }
  return { jsonPath }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const key = apiKey()
  const rows = []
  for (const gpuName of GPU_NAMES) {
    rows.push(await query(key, gpuName))
  }
  const summary = {
    probe: 'vast-inventory',
    checkedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    filters: {
      numGpus: 1,
      inetDownGte: MIN_DOWN,
      inetDownCostLte: MAX_DOWN_COST,
      diskSpaceGte: MIN_DISK_GB,
      dphTotalLte: MAX_DPH,
      type: 'on-demand',
    },
    rows,
    totalCount: rows.reduce((sum, row) => sum + row.count, 0),
    zeroDownloadCostCount: rows.reduce((sum, row) => sum + row.zeroDownloadCost, 0),
  }
  console.log(JSON.stringify(summary, null, 2))
  if (options.jsonPath) {
    const target = resolve(ROOT, options.jsonPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    console.error(`[vast-inventory] summary: ${target}`)
  }
}

main().catch((error) => {
  console.error(error?.message ?? error)
  process.exitCode = 1
})
