/**
 * 客户端版本检查（Standalone Host 侧，只读查询更新源）。
 *
 * 目标：让用户知道有没有比当前桌面端更新的版本。只读阶段**不下载、不安装、不重启**，
 * 也不参与出图链路；完整更新能力见 `electron/updater.mjs` 与
 * docs/M2_8_RELEASE_AND_UPDATER_SPEC.md。
 *
 * 双源口径（规格 §3.5）：
 *  - `github`：默认源，请求 GitHub Releases API `/repos/nanxfu/aigc-studio/releases/latest`，
 *    跳过 draft / prerelease；
 *  - `custom`：用户自建镜像，读取 `<mirror>/latest.yml`（generic provider 同一份清单），
 *    校验 version / 文件名 / sha512 / 大小，`releaseUrl` 指向同源的安装包下载地址。
 *
 * 边界：
 *  - 默认关闭（`update.updateCheck=false`），开启后才发起请求；运行中改配置通过
 *    `refresh()` 立即生效（源变更时旧缓存作废）；
 *  - 结果缓存在全局应用目录 `update-check.json`，24 小时有效；失败保留上一次成功结果；
 *  - 不在 NSIS 安装态运行：主进程通过 `AIGC_STUDIO_UPDATE_OWNER=electron` 独占更新，
 *    服务端只回 `{ mode: 'electron' }` 占位，避免双源互相覆盖；
 *  - 只把版本号、release 链接、检查时间与错误码交给客户端，不透传响应体。
 *
 * 测试替身：`fetchText` 与 `now` 均可注入，单测完全不联网（见 test/update-check.mjs）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isNewerVersion, normalizeVersion } from '../shared/version.js'
import { classifyUpdateError, normalizeMirrorUrl } from '../shared/update-state.js'
import { writeFileAtomic } from './fs-atomic.js'
import { createLogger } from './log.js'
import { httpText } from './net.js'
import { META_DIR, workspaceRoot } from './paths.js'
import { latestYmlUrl, parseLatestYml, resolveDownloadUrl } from './update-source.js'

/** GitHub Releases 最新正式版接口。 */
export const GITHUB_RELEASE_API = 'https://api.github.com/repos/nanxfu/aigc-studio/releases/latest'

/** 单次请求的超时；release 元数据很小，GitHub 4 秒 / 镜像 6 秒。 */
const GITHUB_TIMEOUT_MS = 4000
const MIRROR_TIMEOUT_MS = 6000
/** 成功结果的缓存时长：一天查一次，避免每次启动频繁请求远端。 */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000
/** 服务启动后第一次检查的延迟：先把出图主链路让出来，别和唤醒抢网络。 */
const UPDATE_CHECK_START_DELAY_MS = 5000

/** 缓存文件版本与文件名。 */
export const UPDATE_RECORD_VERSION = 3
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

/** 读取并校验缓存记录；版本 / 源 / feed 不符或字段缺失返回 null（按没有缓存处理）。 */
function normalizeRecord(value, { source, feed }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version !== UPDATE_RECORD_VERSION) return null
  if (value.source !== source || value.feed !== feed) return null
  const latest = normalizeVersion(value.latest)
  const checkedAt = Number(value.checkedAt)
  if (!latest || !Number.isFinite(checkedAt) || checkedAt <= 0) return null
  const releaseUrl = source === 'custom'
    ? (typeof value.releaseUrl === 'string' && value.releaseUrl.startsWith('https://') ? value.releaseUrl : null)
    : safeReleaseUrl(value.releaseUrl, latest)
  return {
    checkedAt,
    latest,
    releaseUrl,
    releaseName: typeof value.releaseName === 'string' ? value.releaseName.slice(0, 120) : null,
  }
}

async function readRecord(path, identity) {
  try {
    const text = await readFile(path, 'utf8')
    if (text.length > RECORD_MAX_BYTES) return null
    return normalizeRecord(JSON.parse(text), identity)
  } catch {
    // 不存在 / 损坏 / 权限问题都按「没有缓存」处理：版本检查不能影响服务启动。
    return null
  }
}

async function writeRecord(path, state, identity) {
  const record = {
    version: UPDATE_RECORD_VERSION,
    checkedAt: state.checkedAt,
    latest: state.latest,
    releaseUrl: state.releaseUrl,
    releaseName: state.releaseName,
    source: identity.source,
    feed: identity.feed,
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
 * @param {'github' | 'custom'} [options.source='github'] 更新源
 * @param {string} [options.mirrorUrl=''] 自定义镜像根（source=custom 时必填）
 * @param {boolean} [options.allowInsecure=false] 开发联调：允许 http://127.0.0.1
 * @param {() => { enabled?: boolean, source?: string, mirrorUrl?: string, allowInsecure?: boolean }} [options.getOptions]
 *   运行期读取最新配置（设置抽屉保存后无需重启即可生效）
 * @param {(url: string, options: object) => Promise<{ ok: boolean, status?: number, text: string }>} [options.fetchText]
 * @param {() => number} [options.now] 时钟注入（单测用）
 */
export function createUpdateChecker({
  ctx = null,
  currentVersion,
  cacheFile = null,
  dir,
  enabled = true,
  source = 'github',
  mirrorUrl = '',
  allowInsecure = false,
  getOptions = null,
  fetchText,
  now = () => Date.now(),
} = {}) {
  const current = normalizeVersion(currentVersion)
  const baseDir = dir ?? (ctx ? workspaceRoot(ctx) : null)
  const recordPath = cacheFile || (baseDir ? join(baseDir, META_DIR, RECORD_FILE) : null)
  const fetchOnce = typeof fetchText === 'function' ? fetchText : (url, options) => httpText(ctx, url, options)

  /** 当前生效配置：优先运行期 getOptions()，失败回退构造参数。 */
  function currentOptions() {
    let dynamic = null
    if (typeof getOptions === 'function') {
      try {
        dynamic = getOptions()
      } catch {
        dynamic = null
      }
    }
    const picked = dynamic && typeof dynamic === 'object' ? dynamic : {}
    const pickedSource = picked.source === 'custom' ? 'custom' : picked.source === 'github' ? 'github' : source
    const pickedMirrorRaw = typeof picked.mirrorUrl === 'string' ? picked.mirrorUrl : mirrorUrl
    const insecure = picked.allowInsecure === true || allowInsecure
    const normalizedMirror = normalizeMirrorUrl(pickedMirrorRaw, { allowInsecure: insecure })
    return {
      enabled: typeof picked.enabled === 'boolean' ? picked.enabled : enabled,
      source: pickedSource,
      mirrorUrl: normalizedMirror ?? '',
      allowInsecure: insecure,
    }
  }

  /** 源身份：缓存按 `source + feed` 失效（规格 §3.5）。 */
  function identityOf(opts) {
    if (opts.source === 'custom') return { source: 'custom', feed: opts.mirrorUrl || '' }
    return { source: 'github', feed: GITHUB_RELEASE_API }
  }

  /** 最近一次检查结果；检查失败时保留旧值，只更新 error。 */
  let state = { checkedAt: 0, latest: null, releaseUrl: null, releaseName: null }
  let activeIdentity = identityOf(currentOptions())
  let lastError = null
  let inFlight = null
  let disposed = false
  let generation = 0
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
    const opts = currentOptions()
    const checkedAt = state.checkedAt > 0 ? new Date(state.checkedAt).toISOString() : null
    const hasUpdate = Boolean(state.latest && current && isNewerVersion(state.latest, current))
    return {
      current,
      latest: state.latest,
      hasUpdate,
      source: opts.source,
      releaseUrl: hasUpdate ? (state.releaseUrl || (opts.source === 'github' ? releaseUrlOf(state.latest) : null)) : null,
      releaseName: state.releaseName,
      checkedAt,
      stale: state.checkedAt === 0 || now() - state.checkedAt >= UPDATE_CHECK_TTL_MS,
      error: lastError,
    }
  }

  async function load() {
    if (!recordPath) return snapshot()
    const identity = identityOf(currentOptions())
    const record = await readRecord(recordPath, identity)
    if (record && !disposed) {
      activeIdentity = identity
      state = {
        checkedAt: record.checkedAt,
        latest: record.latest,
        releaseUrl: record.releaseUrl,
        releaseName: record.releaseName,
      }
    }
    return snapshot()
  }

  /** GitHub Releases（默认源）。 */
  async function fetchGithub() {
    const result = await fetchOnce(GITHUB_RELEASE_API, {
      timeoutMs: GITHUB_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `aigc-studio/${current}`,
      },
    })
    if (!result?.ok) return { ok: false, code: classifyUpdateError({ status: result?.status }, 'offline') }
    let manifest
    try {
      manifest = JSON.parse(result.text)
    } catch {
      return { ok: false, code: 'feed_invalid' }
    }
    const latest = versionOfRelease(manifest)
    if (!latest) return { ok: false, code: 'feed_invalid' }
    return {
      ok: true,
      value: {
        latest,
        releaseUrl: safeReleaseUrl(manifest?.html_url, latest),
        releaseName: typeof manifest?.name === 'string' ? manifest.name.trim().slice(0, 120) : null,
      },
    }
  }

  /** 自定义镜像（generic provider）：读 `<mirror>/latest.yml`。 */
  async function fetchMirror(opts) {
    const ymlUrl = latestYmlUrl(opts.mirrorUrl, { allowInsecure: opts.allowInsecure })
    if (!ymlUrl) return { ok: false, code: 'feed_invalid' }
    const result = await fetchOnce(ymlUrl, {
      timeoutMs: MIRROR_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      headers: { accept: 'text/yaml, text/plain, */*', 'user-agent': `aigc-studio/${current}` },
    })
    if (!result?.ok) return { ok: false, code: classifyUpdateError({ status: result?.status }, 'offline') }
    const parsed = parseLatestYml(result.text)
    if (!parsed.ok) return { ok: false, code: 'feed_invalid' }
    const downloadUrl = resolveDownloadUrl(opts.mirrorUrl, parsed.value.path, { allowInsecure: opts.allowInsecure })
    return {
      ok: true,
      value: {
        latest: parsed.value.version,
        releaseUrl: downloadUrl || (opts.allowInsecure ? null : `${opts.mirrorUrl}/`),
        releaseName: parsed.value.releaseName,
      },
    }
  }

  /**
   * 查询更新源最新版本；失败时保留旧结果。
   *
   * @param {{ force?: boolean }} [options] force=true 时忽略「自动检查」开关（设置里的「立即检查」）
   */
  async function check(options = {}) {
    const opts = currentOptions()
    const force = options.force === true
    if ((!opts.enabled && !force) || disposed || !current) return snapshot()
    if (opts.source === 'custom' && !opts.mirrorUrl) {
      lastError = 'feed_invalid'
      return snapshot()
    }
    if (inFlight) return inFlight
    inFlight = (async () => {
      // 源变更时先作废旧结果，避免把上一源的版本当成这一源的结果。
      const identity = identityOf(opts)
      if (identity.source !== activeIdentity.source || identity.feed !== activeIdentity.feed) {
        state = { checkedAt: 0, latest: null, releaseUrl: null, releaseName: null }
        lastError = null
        activeIdentity = identity
        generation += 1
      }
      const gen = generation
      try {
        const fetched = opts.source === 'custom' ? await fetchMirror(opts) : await fetchGithub()
        // 请求期间来源被切换：这次结果属于旧源，直接丢弃。
        if (gen !== generation) return snapshot()
        if (!fetched.ok) {
          lastError = fetched.code
          log.debug(`update_check_failed source=${opts.source} current=${current} error=${lastError}`)
          return snapshot()
        }
        state = {
          checkedAt: now(),
          latest: fetched.value.latest,
          releaseUrl: fetched.value.releaseUrl,
          releaseName: fetched.value.releaseName ?? null,
        }
        lastError = null
        log.info(`update_check_ok source=${opts.source} latest=${state.latest} current=${current}`)
        if (recordPath) {
          await writeRecord(recordPath, state, identity).catch((error) => {
            log.warn('写入版本检查缓存失败（忽略）', String(error?.message ?? error).slice(0, 200))
          })
        }
        return snapshot()
      } catch (error) {
        lastError = classifyUpdateError(error, 'offline')
        log.debug(`update_check_failed source=${opts.source} current=${current} error=${lastError}`, String(error?.message ?? error).slice(0, 200))
        return snapshot()
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function schedule() {
    const opts = currentOptions()
    if (!opts.enabled || disposed) return
    const elapsed = state.checkedAt > 0 ? now() - state.checkedAt : Infinity
    const delay = elapsed >= UPDATE_CHECK_TTL_MS
      ? UPDATE_CHECK_START_DELAY_MS
      : Math.max(UPDATE_CHECK_START_DELAY_MS, UPDATE_CHECK_TTL_MS - elapsed)
    if (!startTimer) {
      startTimer = setTimeout(() => {
        startTimer = null
        void check()
      }, delay)
      startTimer.unref?.()
    }
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        void check()
      }, UPDATE_CHECK_TTL_MS)
      refreshTimer.unref?.()
    }
  }

  /** 启动后台检查：先读缓存，再在启动延迟 / 剩余 TTL 后查一次，之后每 TTL 复查。 */
  function start() {
    if (disposed) return
    const opts = currentOptions()
    if (!opts.enabled) {
      clearTimers()
      return
    }
    void load().then(() => {
      if (disposed) return
      schedule()
    })
  }

  /**
   * 配置变更后立即生效：
   *  - 关闭 → 清定时器；
   *  - 开启 → 读缓存并按 TTL 重新排期；
   *  - 源变更 → 立即按新源检查一次（旧结果已作废）。
   */
  function refresh() {
    if (disposed) return snapshot()
    const opts = currentOptions()
    if (!opts.enabled) {
      clearTimers()
      // 关闭自动检查不清空上一次结果：UI 仍可显示「上次检查到的版本」，只是不再自动刷新。
      return snapshot()
    }
    if (!startTimer && !refreshTimer) {
      start()
      return snapshot()
    }
    const identity = identityOf(opts)
    const sourceChanged = identity.source !== activeIdentity.source || identity.feed !== activeIdentity.feed
    if (sourceChanged) {
      state = { checkedAt: 0, latest: null, releaseUrl: null, releaseName: null }
      lastError = null
      activeIdentity = identity
      generation += 1
      if (inFlight) {
        // 旧源的请求还没回来：等它结束（结果会被 generation 丢弃）再查新源。
        void inFlight.finally(() => {
          if (!disposed) void check()
        })
      } else {
        void check()
      }
    }
    return snapshot()
  }

  function dispose() {
    disposed = true
    clearTimers()
  }

  return { snapshot, load, check, start, refresh, dispose }
}
