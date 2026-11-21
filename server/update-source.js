/**
 * 更新源解析：自定义镜像（generic provider）的 `latest.yml` 与下载地址。
 *
 * 只读检查器（server/update-check.js）与测试共用；electron-updater 自己也解析
 * 同一份清单，这里不重复下载/校验安装包，只回答三件事：
 *  - 清单是否可信可用（版本 / 文件名 / sha512 / 大小）；
 *  - 版本对应的安装包在镜像上的绝对地址；
 *  - 镜像根地址是否合法。
 *
 * 信任边界（规格 §3.5）：HTTPS + sha512 只能防传输损坏与中间人替换传输内容，
 * 不能防「镜像自身替换 exe 并同步改 sha512」。自定义镜像等同于用户信任该镜像。
 */

import yaml from 'js-yaml'

import { normalizeVersion } from '../shared/version.js'
import { normalizeMirrorUrl } from '../shared/update-state.js'

/** latest.yml 体积上限：正常只有几百字节，超过这个值视为异常内容。 */
export const LATEST_YML_MAX_BYTES = 64 * 1024

/** electron-builder 生成的 sha512 是 64 字节的 base64（86 字符 + `==`）。 */
const SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/
/** 产物文件名：不允许路径分隔符、绝对 URL、协议、`..` 与空白。 */
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/

export { normalizeMirrorUrl }

/** 产物名是否安全（相对文件名，不是 URL / 路径）。 */
export function isSafeArtifactName(value) {
  if (typeof value !== 'string') return false
  const name = value.trim()
  if (!name || name !== value) return false
  if (name.includes('..') || name.includes('/') || name.includes('\\') || /\s/.test(name)) return false
  return ARTIFACT_NAME_PATTERN.test(name)
}

/** sha512 是否是 electron-builder 的 base64 形态。 */
export function isSha512Base64(value) {
  return typeof value === 'string' && SHA512_PATTERN.test(value.trim())
}

function toPositiveInt(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null
}

/**
 * 解析并校验 `latest.yml`。
 *
 * @param {string} text
 * @returns {{ ok: true, value: {
 *   version: string,
 *   path: string,
 *   sha512: string,
 *   size: number,
 *   files: Array<{ url: string, sha512: string, size: number }>,
 *   releaseDate: string | null,
 *   releaseName: string | null,
 * } } | { ok: false, code: 'feed_invalid', message: string }}
 */
export function parseLatestYml(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, code: 'feed_invalid', message: 'latest.yml 为空' }
  }
  if (Buffer.byteLength(text, 'utf8') > LATEST_YML_MAX_BYTES) {
    return { ok: false, code: 'feed_invalid', message: 'latest.yml 体积异常' }
  }

  let doc
  try {
    doc = yaml.load(text)
  } catch (error) {
    return { ok: false, code: 'feed_invalid', message: `latest.yml 不是合法 YAML：${String(error?.message ?? error).slice(0, 120)}` }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, code: 'feed_invalid', message: 'latest.yml 顶层必须是对象' }
  }

  const version = normalizeVersion(typeof doc.version === 'string' ? doc.version : '')
  if (!version) return { ok: false, code: 'feed_invalid', message: 'latest.yml 缺少合法 version' }

  const files = []
  if (Array.isArray(doc.files)) {
    for (const item of doc.files) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const url = typeof item.url === 'string' ? item.url.trim() : ''
      const sha512 = typeof item.sha512 === 'string' ? item.sha512.trim() : ''
      const size = toPositiveInt(item.size)
      if (!isSafeArtifactName(url)) continue
      if (!isSha512Base64(sha512)) continue
      if (!size) continue
      files.push({ url, sha512, size })
    }
  }

  const path = typeof doc.path === 'string' ? doc.path.trim() : ''
  const sha512 = typeof doc.sha512 === 'string' ? doc.sha512.trim() : ''
  const size = toPositiveInt(doc.size)

  // 兼容两种写法：新版本把文件信息放 files[]，老版本用顶层 path/sha512。
  if (files.length === 0) {
    if (!isSafeArtifactName(path) || !isSha512Base64(sha512) || !size) {
      return { ok: false, code: 'feed_invalid', message: 'latest.yml 缺少可用的文件清单（url/sha512/size）' }
    }
    files.push({ url: path, sha512, size })
  }
  const primary = files[0]
  if (path && path !== primary.url) {
    return { ok: false, code: 'feed_invalid', message: 'latest.yml 的 path 与 files[0].url 不一致' }
  }
  if (sha512 && sha512 !== primary.sha512) {
    return { ok: false, code: 'feed_invalid', message: 'latest.yml 顶层 sha512 与 files[0] 不一致' }
  }
  if (size && size !== primary.size) {
    return { ok: false, code: 'feed_invalid', message: 'latest.yml 顶层 size 与 files[0] 不一致' }
  }

  return {
    ok: true,
    value: {
      version,
      path: primary.url,
      sha512: primary.sha512,
      size: primary.size,
      files,
      releaseDate: typeof doc.releaseDate === 'string' ? doc.releaseDate.trim().slice(0, 64) : null,
      releaseName: typeof doc.releaseName === 'string' ? doc.releaseName.trim().slice(0, 120) : null,
    },
  }
}

/**
 * 由镜像根 + 产物名拼出下载地址；非法输入返回 null。
 *
 * @param {string} mirrorUrl 已归一的镜像根
 * @param {string} artifactName latest.yml 里的相对文件名
 * @param {{ allowInsecure?: boolean }} [options] 仅开发联调允许回环 http
 */
export function resolveDownloadUrl(mirrorUrl, artifactName, options = {}) {
  const base = normalizeMirrorUrl(mirrorUrl, options)
  if (!base || !isSafeArtifactName(artifactName)) return null
  try {
    const url = new URL(`${base}/${encodeURIComponent(artifactName)}`)
    const allowed = url.protocol === 'https:' || (options.allowInsecure === true && url.protocol === 'http:')
    return allowed ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * 读取 latest.yml 的地址（镜像根 + `/latest.yml`）。
 *
 * @param {string} mirrorUrl
 * @param {{ allowInsecure?: boolean }} [options]
 * @returns {string | null}
 */
export function latestYmlUrl(mirrorUrl, options = {}) {
  const base = normalizeMirrorUrl(mirrorUrl, options)
  if (!base) return null
  return `${base}/latest.yml`
}
