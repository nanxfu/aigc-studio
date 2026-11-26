/**
 * 本机 GPU 设置表单纯逻辑。
 *
 * 与 `web/logic/appSettings.js` 同构：VIEW 归一、FORM 装载、脏检查与 PATCH 构造。
 * 底层调优参数仍保留在 VIEW 中供排障与兼容读取，但不进入界面表单。
 */

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeLocalGpuView(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    ok: source.ok === true,
    configured: source.configured === true,
    errors: Array.isArray(source.errors) ? source.errors.filter((s) => typeof s === 'string') : [],
    source: textOf(source.source) || 'none',
    overrideByEnv: source.overrideByEnv === true,
    configPath: textOf(source.configPath),
    serverPath: textOf(source.serverPath),
    useBundledEngine: source.useBundledEngine === true,
    modelPath: textOf(source.modelPath),
    vaePath: textOf(source.vaePath),
    modelName: textOf(source.modelName),
    models: source.models && typeof source.models === 'object' && !Array.isArray(source.models) ? source.models : {},
    configuredPresets: Array.isArray(source.configuredPresets)
      ? source.configuredPresets.filter((id) => typeof id === 'string')
      : [],
    paramsBackend: source.paramsBackend === 'cpu' ? 'cpu' : 'disk',
    threads: clampInt(source.threads, 0, 0, 128),
    idleTimeoutSec: clampInt(source.idleTimeoutSec, 300, 60, 3600),
    vaeTiling: source.vaeTiling !== false,
  }
}

export function localGpuFormOf(view) {
  const v = normalizeLocalGpuView(view)
  return {
    serverPath: v.serverPath,
    modelPath: v.modelPath,
    vaePath: v.vaePath,
  }
}

export function buildLocalGpuPatch(form, view) {
  if (!form || !view) return null
  const v = normalizeLocalGpuView(view)
  const patch = {}
  if (textOf(form.serverPath) !== v.serverPath) patch.serverPath = textOf(form.serverPath)
  if (textOf(form.modelPath) !== v.modelPath) patch.modelPath = textOf(form.modelPath)
  if (textOf(form.vaePath) !== v.vaePath) patch.vaePath = textOf(form.vaePath)
  return Object.keys(patch).length > 0 ? patch : null
}

export function hasLocalGpuChanges(form, view) {
  return buildLocalGpuPatch(form, view) !== null
}
