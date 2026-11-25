/**
 * 本机 GPU（Vulkan / stable-diffusion.cpp）配置与探测路由：
 *  - GET  /api/local-gpu/config  读取 `<userData>/local-gpu.json` + 环境变量合并后的脱敏视图；
 *  - POST /api/local-gpu/config  保存 `local-gpu.json` 覆盖项（路径 / 参数后端 / 空闲卸载时间 / 多模型映射）；
 *  - POST /api/local-gpu/probe   触发一次只读本机环境探测（校验文件存在性 + `sd-server --list-devices` / `vulkaninfo`）。
 *
 * 路径与方法唯一来源是 `shared/contract.js` 的 ROUTES。
 *
 * @module server/routes/local-gpu
 */

import { ROUTES, TIMEOUTS } from '../../shared/contract.js'
import { readJsonBody, sendError, sendJson } from '../http.js'
import {
  normalizeLocalGpuConfig,
  publicLocalGpuView,
  readLocalGpuConfig,
  saveLocalGpuConfig,
} from '../local-gpu/config.js'
import { probeLocalGpu } from '../local-gpu/probe.js'

/**
 * @param {{ appConfig?: object, log?: object, probeImpl?: Function }} [deps]
 */
export function createLocalGpuRoutes({ appConfig = null, log = null, setup = null, probeImpl = probeLocalGpu } = {}) {
  const rootOf = () => appConfig?.root ?? ''

  async function readConfig(_req, res) {
    if (appConfig) await appConfig.whenReady()
    const result = readLocalGpuConfig({ root: rootOf(), env: process.env })
    sendJson(res, 200, { ok: true, config: publicLocalGpuView(result) })
  }

  async function saveConfig(req, res) {
    let body
    try {
      body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: true })
    } catch (error) {
      return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
    }
    if (appConfig) await appConfig.whenReady()
    if (setup?.busy()) return sendError(res, 409, 'invalid_request', '本机 GPU 正在准备，暂不能保存手动配置')
    const saved = await saveLocalGpuConfig({ root: rootOf(), patch: body, env: process.env })
    if (!saved.ok) {
      const code = saved.code === 'internal_error' ? 'internal_error' : 'invalid_request'
      return sendError(res, code === 'internal_error' ? 500 : 400, code, saved.message)
    }
    log?.info?.(`local_gpu_config_saved ok=${saved.result.ok}`)
    sendJson(res, 200, { ok: true, config: publicLocalGpuView(saved.result) })
  }

  async function runSetup(req, res) {
    if (!setup) return sendError(res, 404, 'invalid_request', '当前运行模式不支持自动准备本机 GPU')
    if (appConfig) await appConfig.whenReady()
    if (req.method === ROUTES.localGpuSetup.method) {
      return sendJson(res, 200, { ok: true, setup: await setup.snapshot() })
    }
    let body
    try {
      body = await readJsonBody(req, { maxBytes: 1024, strictObject: true })
    } catch (error) {
      return sendError(res, 400, 'invalid_body', error.message)
    }
    if (!['start', 'cancel'].includes(body.action)) return sendError(res, 400, 'invalid_request', '无效的准备操作')
    const result = body.action === 'start' ? await setup.start() : await setup.cancel()
    if (!result) return sendError(res, 400, 'invalid_request', '此安装包未包含 Windows x64 Vulkan 引擎')
    sendJson(res, 200, { ok: true, setup: result })
  }

  async function runProbe(req, res) {
    let body = {}
    try {
      body = await readJsonBody(req, { maxBytes: TIMEOUTS.bodyMaxBytes, strictObject: false })
    } catch (error) {
      return sendError(res, 400, 'invalid_body', String(error?.message ?? error))
    }
    if (appConfig) await appConfig.whenReady()
    const stored = readLocalGpuConfig({ root: rootOf(), env: process.env })
    const rawDraft = body && typeof body === 'object' && !Array.isArray(body)
      ? {
          serverPath: typeof body.serverPath === 'string' ? body.serverPath : stored.config.serverPath,
          modelPath: typeof body.modelPath === 'string' ? body.modelPath : stored.config.modelPath,
          vaePath: typeof body.vaePath === 'string' ? body.vaePath : stored.config.vaePath,
          paramsBackend: typeof body.paramsBackend === 'string' ? body.paramsBackend : stored.config.paramsBackend,
          threads: body.threads ?? stored.config.threads,
        }
      : stored.config
    const normalized = normalizeLocalGpuConfig(rawDraft, { baseDir: rootOf() || process.cwd() })
    const probe = await probeImpl(normalized.config, { env: process.env })
    log?.info?.(`local_gpu_probe ok=${probe.ok} source=${probe.source ?? 'none'}`)
    sendJson(res, 200, { ok: true, probe })
  }

  return [
    {
      name: 'local-gpu-config',
      path: ROUTES.localGpuConfig.path,
      method: [ROUTES.localGpuConfig.method, ROUTES.localGpuConfigSave.method],
      handler(req, res) {
        if (req.method === ROUTES.localGpuConfigSave.method) return saveConfig(req, res)
        return readConfig(req, res)
      },
    },
    {
      name: 'local-gpu-probe',
      path: ROUTES.localGpuProbe.path,
      method: ROUTES.localGpuProbe.method,
      handler: runProbe,
    },
    {
      name: 'local-gpu-setup',
      path: ROUTES.localGpuSetup.path,
      method: [ROUTES.localGpuSetup.method, ROUTES.localGpuSetupAction.method],
      handler: runSetup,
    },
  ]
}
