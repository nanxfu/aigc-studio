/**
 * 本机 GPU 算力来源（M3.4，Vulkan / stable-diffusion.cpp）。
 *
 * 与远程 Worker 的差异：
 *  - 没有用户填写地址：Host 自己拉起 `sd-server` + 协议桥，地址与 Token 都只在本进程内；
 *  - 断开时必须真正停进程（owned），否则 GUI 退出后 sd-server 会继续占显存；
 *  - 进程异常退出由 runtime 最多重启 2 次，`/health` 再把最终错误交给会话状态机。
 *
 * 配置读取（`<appConfig.root>/local-gpu.json` + 环境变量）见 `server/local-gpu/config.js`。
 *
 * @module server/providers/local-gpu
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { TIMEOUTS } from '../../shared/contract.js'
import { createLogger } from '../log.js'
import { requestLogs } from '../remote.js'
import { createLocalGpuBridge } from '../local-gpu/bridge.js'
import { localGpuSignatureOf, readLocalGpuConfig, resolveLocalGpuModel } from '../local-gpu/config.js'
import { ensureLocalLora } from '../local-gpu/loras.js'
import { getLocalGpuRuntime } from '../local-gpu/runtime.js'
import { ProviderError } from './provider.js'
import { fetchWorkerHealth, workerHandleOf } from './worker-connection.js'

const execFileAsync = promisify(execFile)
const defaultLog = createLogger({ scope: 'local-gpu' })

/** 当前进程内已启动的本机服务；配置变化时整体替换。 */
let service = null

function configErrorOf(result) {
  const detail = Array.isArray(result?.errors) && result.errors.length > 0
    ? result.errors.join('；')
    : '本机推理引擎尚未就绪，请先在设置中完成环境准备'
  const where = result?.configPath ? `（配置文件：${result.configPath}）` : ''
  return new ProviderError(
    'worker_unreachable',
    `本机 GPU 尚未就绪：${detail}${where}`,
  )
}

async function cleanupOrphan(statePath) {
  if (!statePath || !existsSync(statePath)) return false
  let state = null
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    await rm(statePath, { force: true }).catch(() => {})
    return false
  }
  const pid = Number(state?.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    await rm(statePath, { force: true }).catch(() => {})
    return false
  }
  try {
    process.kill(pid, 0)
  } catch {
    await rm(statePath, { force: true }).catch(() => {})
    return false
  }
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
    defaultLog.warn(`已清理上一次运行遗留的本机 GPU 进程 pid=${pid}`)
  } catch (error) {
    defaultLog.debug(`清理遗留本机 GPU 进程失败（忽略）：${error?.message ?? error}`)
  }
  await rm(statePath, { force: true }).catch(() => {})
  return true
}

async function stopService() {
  if (!service) return { ok: true }
  const current = service
  service = null
  await current.bridge.stop().catch(() => {})
  await current.runtime.stop().catch(() => {})
  return { ok: true }
}

/**
 * 创建本机 GPU provider。
 *
 * @param {{ ctx?: object, log?: object, manager?: object, options?: object }} [input]
 */
export function createLocalGpuProvider({ ctx = null, log = defaultLog, manager = null, options = {} } = {}) {
  let switchPromise = null

  function readConfig() {
    if (typeof options.getLocalGpuConfig === 'function') {
      const live = options.getLocalGpuConfig()
      if (live && typeof live === 'object') return live
    }
    return readLocalGpuConfig({ root: options.configRoot ?? '', env: process.env })
  }

  function applyResolvedModel(baseConfig, resolved) {
    if (!resolved) return baseConfig
    const next = { ...baseConfig }
    for (const key of ['vaePath', 'llmPath', 'clipLPath', 'clipGPath', 't5xxlPath', 'tokenizerPath']) {
      if (resolved[key]) next[key] = resolved[key]
      else delete next[key]
    }
    next.modelPath = resolved.modelPath
    next.vaePath = resolved.vaePath || ''
    next.loraDir = baseConfig.loraDir || (resolved.modelPath ? join(dirname(resolved.modelPath), 'loras') : '')
    next.splitDiffusion = Boolean(
      resolved.splitDiffusion
      || resolved.llmPath
      || resolved.clipLPath
      || resolved.clipGPath
      || resolved.t5xxlPath,
    )
    if (resolved.presetId) next.defaultPreset = resolved.presetId
    return next
  }

  async function switchRuntime(resolvedModel) {
    if (!service) return null
    if (switchPromise) return switchPromise
    switchPromise = (async () => {
      const nextConfig = applyResolvedModel(service.config, resolvedModel)
      if (
        service.runtime
        && localGpuSignatureOf(service.config) === localGpuSignatureOf(nextConfig)
        && service.runtime.alive
      ) {
        return { runtime: service.runtime, config: service.config }
      }
      // 单进程串行切换：先真正结束旧进程，再拉起新模型，避免两份权重叠加占显存。
      await service.runtime?.stop().catch(() => {})
      const nextRuntime = getLocalGpuRuntime(nextConfig, {
        log,
        statePath: service.statePath,
        env: process.env,
      })
      await nextRuntime.start()
      service.runtime = nextRuntime
      service.config = nextConfig
      service.signature = localGpuSignatureOf(nextConfig)
      log?.info?.(`local_gpu_model_switched model=${nextConfig.modelPath}`)
      return { runtime: nextRuntime, config: nextConfig }
    })().finally(() => { switchPromise = null })
    return switchPromise
  }

  async function ensureService(presetId = '') {
    const configResult = readConfig()
    if (!configResult?.ok) throw configErrorOf(configResult)
    const target = resolveLocalGpuModel(configResult.config, presetId)
    if (!target) {
      throw new ProviderError(
        'capability_missing',
        '当前模型尚未下载。请打开顶栏模型卡下载本机模型后再启动。',
      )
    }
    const effectiveConfig = applyResolvedModel(configResult.config, target)
    const signature = localGpuSignatureOf(effectiveConfig)
    if (service && service.signature === signature && service.runtime.alive) {
      return service
    }
    if (service) await stopService()
    await cleanupOrphan(configResult.statePath)
    const runtime = getLocalGpuRuntime(effectiveConfig, {
      log,
      statePath: configResult.statePath,
      env: process.env,
    })
    await runtime.start()
    const bridge = createLocalGpuBridge({
      runtime,
      config: effectiveConfig,
      log,
      resolveModel: (id) => resolveLocalGpuModel(readConfig().config, id),
      onEnsureModel: (_id, resolved) => switchRuntime(resolved),
      ensureLora: (lora, cfg) => ensureLocalLora(lora, {
        loraDir: cfg?.loraDir || (cfg?.modelPath ? join(dirname(cfg.modelPath), 'loras') : ''),
        log,
      }),
      onShutdown: () => {
        void stopService()
      },
    })
    const endpointUrl = await bridge.start()
    const health = await bridge.health()
    service = {
      signature,
      statePath: configResult.statePath,
      runtime,
      bridge,
      token: bridge.token,
      endpointUrl,
      config: effectiveConfig,
      health,
    }
    log?.info?.(
      `local_gpu_ready endpoint=${endpointUrl} pid=${runtime.pid} gpu=${runtime.gpu?.name ?? 'unknown'} ` +
        `model=${effectiveConfig.modelPath}`,
    )
    return service
  }

  return {
    id: 'local-gpu',
    kind: 'worker',
    label: '本机 GPU',
    owned: true,

    async provision(run, { onProgress = () => {}, presetId = '' } = {}) {
      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        throw new ProviderError('stale', '启动流程已作废')
      }
      onProgress({ phase: 'push', detail: '正在启动本机 sd-server' })
      let current
      try {
        current = await ensureService(presetId)
      } catch (error) {
        if (error instanceof ProviderError) throw error
        throw new ProviderError(
          'worker_unreachable',
          `本机 GPU 启动失败：${String(error?.message ?? error).slice(0, 900)}`,
          { cause: error },
        )
      }
      if (run && typeof run.isCurrent === 'function' && !run.isCurrent()) {
        await stopService()
        throw new ProviderError('stale', '启动流程已作废')
      }
      const health = await current.bridge.health()
      current.health = health
      if (health.phase === 'error') {
        throw new ProviderError('remote_error', `本机 GPU 处于错误状态：${String(health.last_error ?? '未知')}`)
      }
      manager?.applyHealthDetails?.(health)
      onProgress({ phase: 'push', detail: '本机 GPU 已就绪' })
      const handle = workerHandleOf(health, {
        endpointUrl: current.endpointUrl,
        provider: 'local-gpu',
        owned: true,
        workerId: `local-gpu-${current.runtime.pid ?? 'pending'}`,
      })
      return { handle, token: current.token }
    },

    async pollEndpoint() {
      const current = await ensureService()
      return { endpointUrl: current.endpointUrl }
    },

    async checkAlive(run, handle = {}) {
      const endpointUrl = handle.endpointUrl ?? service?.endpointUrl ?? ''
      const token = handle.token ?? run?.secret?.token ?? service?.token ?? ''
      if (!endpointUrl) return { alive: false, status: 'worker_unreachable', missing: false }
      try {
        const payload = await fetchWorkerHealth({ ctx, endpointUrl, token, timeoutMs: TIMEOUTS.remoteHealthMs })
        return { alive: true, status: payload?.phase ?? 'ready' }
      } catch (error) {
        return { alive: false, status: error?.code ?? 'worker_unreachable', missing: false }
      }
    },

    async keepAlive() {
      return { ok: true, detail: 'local-gpu: noop' }
    },

    /** 本机来源是 owned：断开即停进程；幂等。 */
    async teardown() {
      return stopService()
    },

    /** 应用重启后按状态文件清理上一次遗留的 sd-server，避免孤儿进程占显存。 */
    async cleanupPending() {
      const configResult = readConfig()
      if (!configResult?.statePath) return null
      return cleanupOrphan(configResult.statePath)
    },

    /**
     * 本机进程没有远端 Token / endpoint，补清理靠 runtime 自己写的 `local-gpu-runtime.json`：
     * 下一次 `ensureService()` 会先按 pid 回收孤儿进程，不把本机路径塞进远端补清理记录
     * （那个文件的 normalizeRecord 只认 kaggle / colab 形状）。
     */
    buildPendingCleanupRecord() {
      return null
    },

    async readLogs(run, handle = {}, { since = 0 } = {}) {
      const endpointUrl = handle.endpointUrl ?? service?.endpointUrl ?? ''
      const token = handle.token ?? run?.secret?.token ?? service?.token ?? ''
      if (!endpointUrl) return null
      try {
        const payload = await requestLogs(endpointUrl, token, since, TIMEOUTS.remoteLogsMs, ctx)
        const lines = Array.isArray(payload?.lines) ? payload.lines.filter((line) => typeof line === 'string') : []
        return lines.length > 0 ? lines.join('\n') : null
      } catch {
        return null
      }
    },

    async attach(record = {}) {
      if (!record.endpointUrl) throw new ProviderError('worker_unreachable', '本机 GPU 记录缺少地址')
      const payload = await fetchWorkerHealth({
        ctx,
        endpointUrl: record.endpointUrl,
        token: record.token,
        timeoutMs: TIMEOUTS.remoteHealthMs,
      })
      return workerHandleOf(payload, {
        endpointUrl: record.endpointUrl,
        provider: 'local-gpu',
        owned: true,
        workerId: 'local-gpu',
      })
    },
  }
}

export const __test = { cleanupOrphan, stopService }

export default createLocalGpuProvider
