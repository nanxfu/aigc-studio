/**
 * 本机 GPU 设置表单纯逻辑。
 *
 * 正式版 UI 不再暴露模型 / VAE / 引擎路径；路径与调优继续由 local-gpu.json
 * 和环境变量完全保留。因此 FORM 只承载引擎/模型状态的只读视图，不产生配置 PATCH。
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
    engineReady: source.engineReady === true || source.ok === true,
    engineBackend: source.engineBackend === 'cuda' ? 'cuda' : 'vulkan',
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
    modelStates: source.modelStates && typeof source.modelStates === 'object' && !Array.isArray(source.modelStates)
      ? source.modelStates
      : {},
    configuredPresets: Array.isArray(source.configuredPresets)
      ? source.configuredPresets.filter((id) => typeof id === 'string')
      : [],
    availableAssets: Array.isArray(source.availableAssets)
      ? source.availableAssets.filter((item) => item && typeof item.id === 'string')
      : [],
    paramsBackend: ['auto', 'disk', 'cpu'].includes(source.paramsBackend) ? source.paramsBackend : 'auto',
    threads: clampInt(source.threads, 0, 0, 128),
    idleTimeoutSec: clampInt(source.idleTimeoutSec, 300, 60, 3600),
    vaeTiling: typeof source.vaeTiling === 'boolean' ? source.vaeTiling : null,
  }
}

export function localGpuFormOf() {
  return {}
}

export function buildLocalGpuPatch() {
  return null
}

export function hasLocalGpuChanges() {
  return false
}
