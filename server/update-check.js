/**
 * 客户端版本检查（Standalone Host 侧，只读查询 GitHub Releases）。
 *
 * 目标：让用户知道有没有比当前桌面端更新的版本。当前阶段检查**只读**：
 * 不下载、不安装、不重启，也不参与出图链路；未来全量/热更新能力规划见 `docs/AUTO_UPDATE_PLAN.md`。
 *
 * 口径与边界：
 *  - 默认关闭（见 server/defaults.js：`updateCheck: false`），开启后请求 GitHub Releases API
 *    `/repos/nanxfu/aigc-studio/releases/latest`（单次 4 秒超时，跳过 draft/prerelease）；
 *  - 结果缓存在全局应用目录 `update-check.json`（无 appConfig 时回退 `<workspace>/.aigc-studio/update-check.json`），
 *    24 小时有效；启动后延迟 5 秒查一次，之后按 TTL 复查，检查失败静默保留上一次成功结果；
 *  - 只在「远端版本确实比当前版本新」时对外提示；同版本 / 更旧 / 不可解析都不提示；
 *  - 不把网络响应体透传给客户端，只保留版本号、release 链接与检查时间；
 *  - `enabled=false`（默认值、测试、开发模式或用户显式关闭）时不发起任何请求、不写缓存。
 *
 * 测试替身：`fetchText` 与 `now` 均可注入，单测完全不联网（见 test/update-check.mjs）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isNewerVersion, normalizeVersion } from '../shared/version.js'
import { writeFileAtomic } from './fs-atomic.js'
import { createLogger } from './log.js'
import { httpText } from './net.js'
import { META_DIR, workspaceRoot } from './paths.js'

/** GitHub Releases 最新正式版接口。 */
export const GITHUB_RELEASE_API = 'https://api.github.com/repos/nanxfu/aigc-studio/releases/latest'

/** 单次请求的超时；release 元数据很小，4 秒足够。 */
const UPDATE_CHECK_TIMEOUT_MS = 4000
/** 成功结果的缓存时长：一天查一次，避免每次启动频繁请求远端。 */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000
/** 服务启动后第一次检查的延迟：先把出图主链路让出来，别和唤醒抢网络。 */
const UPDATE_CHECK_START_DELAY_MS = 5000

/** 缓存文件版本与文件名。 */
export const UPDATE_RECORD_VERSION = 2
const RECORD_FILE = 'update-check.json'
const RECORD_MAX_BYTES = 64 * 1024

const RELEASE_BASE = 'https://github.com/nanxfu/aigc-studio/releases/tag/v'
const RELEASE_URL_PREFIX = 'https://github.com/nanxfu/aigc-studio/'
const log = createLogger({ scope: 'update' })

/** 版本对应的 GitHub Release 页面；版本不可解析时返回 null。 */
export function releaseUrlOf(version) {
  const normalized = normalizeVersion(version)
  return normalized ? `${RELEASE_BASE}${normalized}` : null
}

/** 校验并裁剪 Release 页面链接：只接受本仓库的 https://github.com 地址。 */
function safeReleaseUrl(value, version) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith(RELEASE_URL_PREFIX) && trimmed.length <= 256) return trimmed
  }
  return releaseUrlOf(version)
}

/** 从 GitHub Release 响应提取语义化版本号（允许 `v0.15.0` 或 `0.15.0`）。 */
function versionOfRelease(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  if (manifest.draft === true || manifest.prerelease === true) return null
  const raw = typeof manifest.tag_name === 'string'
    ? manifest.tag_name
    : (typeof manifest.version === 'string' ? manifest.version : '')
  const trimmed = raw.trim().replace(/^[vV](?=[0-9])/, '')
  return normalizeVersion(trimmed)
}

/** 读取并校验缓存记录；版本不符 / 缺字段返回 null（按没有缓存处理）。 */
function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version !== UPDATE_RECORD_VERSION) return null
  const latest = normalizeVersion(value.latest)
  const checkedAt = Number(value.checkedAt)
  if (!latest || !Number.isFinite(checkedAt) || checkedAt <= 0) return null
  const releaseUrl = safeReleaseUrl(value.releaseUrl, latest)
  return { checkedAt, latest, releaseUrl }
}

async function readRecord(path) {
  try {
    const text = await readFile(path, 'utf8')
    if (text.length > RECORD_MAX_BYTES) return null
    return normalizeRecord(JSON.parse(text))
  } catch {
    // 不存在 / 损坏 / 权限问题都按「没有缓存」处理：版本检查不能影响服务启动。
    return null
  }
}

async function writeRecord(path, state) {
  const record = {
    version: UPDATE_RECORD_VERSION,
    checkedAt: state.checkedAt,
    latest: state.latest,
    releaseUrl: state.releaseUrl,
  }
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, {
    dirMode: 0o700,
    fileMode: 0o600,
    cleanStale: true,
    tempPrefix: `${RECORD_FILE}.tmp-`,
    encoding: 'utf8',
  })
}

/**
 * 创建版本检查器。
 *
 * @param {object} options
 * @param {object} [options.ctx] 宿主上下文（用于回退推导缓存目录、`httpText` 发请求）
 * @param {string} options.currentVersion 当前客户端版本
 * @param {string} [options.cacheFile] 缓存文件绝对路径（优先用于全局 appData）
 * @param {string} [options.dir] 工作区根目录（未传 cacheFile 时写 `<dir>/.aigc-studio/update-check.json`）
 * @param {boolean} [options.enabled=true] false 时不发请求、不写缓存（测试 / 开发模式 / 配置关闭）
 * @param {(url: string, options: object) => Promise<{ ok: boolean, status?: number, text: string }>} [options.fetchText]
 * @param {() => number} [options.now] 时钟注入（单测用）
 */
export function createUpdateChecker({
  ctx = null,
  currentVersion,
  cacheFile = null,
  dir,
  enabled = true,
  fetchText,
  now = () => Date.now(),
} = {}) {
  const current = normalizeVersion(currentVersion)
  const baseDir = dir ?? (ctx ? workspaceRoot(ctx) : null)
  const recordPath = cacheFile || (baseDir ? join(baseDir, META_DIR, RECORD_FILE) : null)
  const fetchOnce = typeof fetchText === 'function' ? fetchText : (url, options) => httpText(ctx, url, options)

  /** 最近一次检查结果；检查失败时保留旧值，只更新 error。 */
  let state = { checkedAt: 0, latest: null, releaseUrl: null }
  let lastError = null
  let inFlight = null
  let disposed = false
  let startTimer = null
  let refreshTimer = null

  function clearTimers() {
    if (startTimer) clearTimeout(startTimer)
    if (refreshTimer) clearInterval(refreshTimer)
    startTimer = null
    refreshTimer = null
  }

  /** 对外快照：纯数据、无异常，客户端只看 `hasUpdate`。 */
  function snapshot() {
    const checkedAt = state.checkedAt > 0 ? new Date(state.checkedAt).toISOString() : null
    const hasUpdate = Boolean(state.latest && current && isNewerVersion(state.latest, current))
    return {
      current,
      latest: state.latest,
      hasUpdate,
      releaseUrl: hasUpdate ? (state.releaseUrl || releaseUrlOf(state.latest)) : null,
      checkedAt,
      stale: state.checkedAt === 0 || now() - state.checkedAt >= UPDATE_CHECK_TTL_MS,
      error: lastError,
    }
  }

  async function load() {
    if (!recordPath) return snapshot()
    const record = await readRecord(recordPath)
    if (record && !disposed) {
      state = { checkedAt: record.checkedAt, latest: record.latest, releaseUrl: record.releaseUrl }
    }
    return snapshot()
  }

  /** 查询 GitHub Releases 最新版本；失败时保留旧结果。 */
  async function check() {
    if (!enabled || disposed || !current) return snapshot()
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const result = await fetchOnce(GITHUB_RELEASE_API, {
          timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
          maxBytes: 64 * 1024,
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': `aigc-studio/${current}`,
          },
        })
        if (!result?.ok) {
          lastError = `release_http_${result?.status ?? 'failed'}`
          log.debug(`update_check_failed current=${current} error=${lastError}`)
          return snapshot()
        }
        let manifest
        try {
          manifest = JSON.parse(result.text)
        } catch {
          lastError = 'invalid_manifest'
          log.debug(`update_check_failed current=${current} error=${lastError}`)
          return snapshot()
        }
        const latest = versionOfRelease(manifest)
        if (!latest) {
          lastError = 'invalid_version'
          log.debug(`update_check_failed current=${current} error=${lastError}`)
          return snapshot()
        }
        state = {
          checkedAt: now(),
          latest,
          releaseUrl: safeReleaseUrl(manifest?.html_url, latest),
        }
        lastError = null
        log.info(`update_check_ok latest=${latest} current=${current}`)
        if (recordPath) {
          await writeRecord(recordPath, state).catch((error) => {
            log.warn('写入版本检查缓存失败（忽略）', String(error?.message ?? error).slice(0, 200))
          })
        }
        return snapshot()
      } catch (error) {
        lastError = 'network'
        log.debug(`update_check_failed current=${current} error=${lastError}`, String(error?.message ?? error).slice(0, 200))
        return snapshot()
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** 启动后台检查：先读缓存，再在启动延迟 / 剩余 TTL 后查一次，之后每 TTL 复查。 */
  function start() {
    if (!enabled || disposed) return
    void load().then(() => {
      if (disposed) return
      const elapsed = state.checkedAt > 0 ? now() - state.checkedAt : Infinity
      const delay = elapsed >= UPDATE_CHECK_TTL_MS
        ? UPDATE_CHECK_START_DELAY_MS
        : Math.max(UPDATE_CHECK_START_DELAY_MS, UPDATE_CHECK_TTL_MS - elapsed)
      startTimer = setTimeout(() => {
        startTimer = null
        void check()
      }, delay)
      startTimer.unref?.()
      refreshTimer = setInterval(() => {
        void check()
      }, UPDATE_CHECK_TTL_MS)
      refreshTimer.unref?.()
    })
  }

  function dispose() {
    disposed = true
    clearTimers()
  }

  return { snapshot, load, check, start, dispose }
}
