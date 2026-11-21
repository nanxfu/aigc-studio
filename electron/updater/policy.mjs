/**
 * 更新器运行形态判定与安装策略（纯函数，不依赖 Electron API）。
 *
 * 判定顺序固定（docs/M2_8_RELEASE_AND_UPDATER_SPEC.md §3.1），不允许用
 * `app.isPackaged` 一个条件打天下：
 *   便携版 → Linux AppImage → 开发态 → 解压版 → macOS 未签名 → NSIS 安装版 → 兜底
 *
 * 输入全部由主进程传入，测试可以在 Node 里直接跑，不需要启动 Electron：
 *   { isPackaged, platform, env, execPath, resourcesPath, hasUpdateConfig }
 *
 * `hasUpdateConfig` 缺省时用 `resourcesPath/app-update.yml` 是否存在判断；
 * 单测显式传布尔值，避免依赖磁盘。
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  canInstallNow,
  classifyUpdateError,
  normalizeMirrorUrl,
} from '../../shared/update-state.js'

/** 开发态联调开关：显式设置后才允许创建 updater（配合本地 generic feed）。 */
export const DEV_UPDATE_ENV = 'AIGC_STUDIO_UPDATE_DEV'
/** 开发态本地 feed 地址（仅允许 https 或回环 http）。 */
export const DEV_UPDATE_FEED_ENV = 'AIGC_STUDIO_UPDATE_FEED'

/** 打包后 resources 目录里的更新配置文件名（electron-builder 生成）。 */
export const APP_UPDATE_CONFIG = 'app-update.yml'

function envValue(env, name) {
  const value = env?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key)
}

/** 便携版判定：electron-builder portable target 注入的环境变量。 */
export function isPortableRun(env = {}) {
  return Boolean(envValue(env, 'PORTABLE_EXECUTABLE_FILE') || envValue(env, 'PORTABLE_EXECUTABLE_DIR'))
}

/** Linux AppImage 判定：AppImage runtime 注入 `APPIMAGE`。 */
export function isAppImageRun(env = {}) {
  return Boolean(envValue(env, 'APPIMAGE'))
}

/** 解压版判定：`app.isPackaged` 且可执行文件位于 `win-unpacked`。 */
export function isUnpackedRun({ isPackaged, execPath } = {}) {
  if (!isPackaged || typeof execPath !== 'string' || !execPath.trim()) return false
  return basename(dirname(execPath)).toLowerCase() === 'win-unpacked'
}

/**
 * 解析运行形态。
 *
 * @param {object} input
 * @param {boolean} input.isPackaged
 * @param {string} [input.platform]
 * @param {Record<string, string | undefined>} [input.env]
 * @param {string} [input.execPath]
 * @param {string} [input.resourcesPath]
 * @param {boolean} [input.hasUpdateConfig]
 * @returns {{
 *   form: string,
 *   mode: 'electron-updater' | 'readonly',
 *   canAutoUpdate: boolean,
 *   reason: string | null,
 *   forcedDev: boolean,
 *   feedUrl: string,
 *   updateConfigPath: string | null,
 * }}
 */
export function resolveInstallForm(input = {}) {
  const isPackaged = input.isPackaged === true
  const platform = typeof input.platform === 'string' && input.platform ? input.platform : process.platform
  const env = input.env ?? {}
  const execPath = typeof input.execPath === 'string' ? input.execPath : ''
  const resourcesPath = typeof input.resourcesPath === 'string' ? input.resourcesPath : ''
  const updateConfigPath = resourcesPath ? join(resourcesPath, APP_UPDATE_CONFIG) : null
  const hasUpdateConfig = hasOwn(input, 'hasUpdateConfig')
    ? input.hasUpdateConfig === true
    : Boolean(updateConfigPath && existsSync(updateConfigPath))

  const readonly = (form, reason = null) => ({
    form,
    mode: 'readonly',
    canAutoUpdate: false,
    reason,
    forcedDev: false,
    feedUrl: '',
    updateConfigPath,
  })

  // 1) 便携版：覆盖安装会毁掉便携目录，只给下载页。
  if (isPortableRun(env)) return readonly('portable', 'portable')

  // 2) Linux AppImage：本阶段只读（等有 Linux 构建与实测后再放开）。
  if (isAppImageRun(env)) return readonly('linux-appimage', 'appimage')

  // 3) 开发态：默认不初始化更新器；显式开关 + 合法本地 feed 才允许联调。
  if (!isPackaged) {
    const forced = envValue(env, DEV_UPDATE_ENV) === '1'
    if (!forced) return readonly('dev', 'dev')
    const feedUrl = normalizeMirrorUrl(envValue(env, DEV_UPDATE_FEED_ENV), { allowInsecure: true })
    if (!feedUrl) return readonly('dev', 'dev_feed_missing')
    return {
      form: 'dev',
      mode: 'electron-updater',
      canAutoUpdate: true,
      reason: null,
      forcedDev: true,
      feedUrl,
      updateConfigPath,
    }
  }

  // 4) 解压版：没有安装器接管，升级会覆盖失败。
  if (isUnpackedRun({ isPackaged, execPath })) return readonly('unpacked', 'unpacked')

  // 5) macOS 未签名：只读检查，等签名 / 公证后放开。
  if (platform === 'darwin') return readonly('mac-unsigned', 'mac_unsigned')

  // 6) NSIS 安装版：唯一允许自动更新的形态，且必须带 app-update.yml。
  if (platform === 'win32') {
    if (!hasUpdateConfig) return readonly('unsupported', 'missing_update_config')
    return {
      form: 'nsis',
      mode: 'electron-updater',
      canAutoUpdate: true,
      reason: null,
      forcedDev: false,
      feedUrl: '',
      updateConfigPath,
    }
  }

  // 7) 兜底：未知安装形态。
  return readonly('unsupported', 'unsupported_platform')
}

/** 镜像 URL 是否可用于当前运行态（生产只允许 https）。 */
export function isMirrorUrlAllowed(raw, { dev = false } = {}) {
  const normalized = normalizeMirrorUrl(raw, { allowInsecure: dev })
  return normalized === null ? null : normalized
}

export { canInstallNow, classifyUpdateError }
