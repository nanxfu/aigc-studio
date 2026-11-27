/**
 * 通用工坊本机 CUDA 执行器（M4.2f-2）。
 *
 * 复用同一套隔离 `uv` Python 环境、HF 权重缓存与 JSON stdout 协议，把
 * PBR / 高质量深度 / IC-Light 统一收口到这里。上层的 `local-pbr.js` 只保留薄兼容层；
 * 队列仍由 `JobQueue` 串行调度，本文件不新增第二套任务状态。
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WORKSHOP } from '../shared/contract.js'
import {
  LOCAL_PBR,
  WORKSHOP_COMPUTE_PROFILES,
  evaluateWorkshopCompute,
  workshopComputeProfileOf,
} from '../shared/workshop-compute.js'
import { writeFileAtomic } from './fs-atomic.js'
import { prepareAsset } from './local-gpu/assets.js'
import { META_DIR, workspaceRoot } from './paths.js'

const RUNNER = fileURLToPath(new URL('../worker/local_workshop.py', import.meta.url))
const UV_ASSETS = {
  win32: {
    url: 'https://github.com/astral-sh/uv/releases/download/0.9.17/uv-x86_64-pc-windows-msvc.zip',
    bytes: 21_453_642,
    sha256: 'ebc76197bf3e1a58f9dac6f70f49b0ebd3e6907ab35289ce228bce5ba8a3f201',
    file: 'uv.zip',
    executable: 'uv.exe',
  },
  linux: {
    url: 'https://github.com/astral-sh/uv/releases/download/0.9.17/uv-x86_64-unknown-linux-gnu.tar.gz',
    bytes: 22_127_379,
    sha256: '0114d54f9aafd07516cf1cadfe72afa970f5fd293fbe82dd924b8a7b42c984d8',
    file: 'uv.tar.gz',
    executable: 'uv-x86_64-unknown-linux-gnu/uv',
  },
}
const RUNTIME_VERSION = 'torch-2.6.0-diffusers-0.35.2-v3'
const CHANNELS = Object.freeze({
  'remove-bg': ['cutout'],
  pbr: WORKSHOP.pbr.channels,
  depth: WORKSHOP.depth.channels,
  relight: ['relit'],
})

function profileFileOf(profileId) {
  return `${profileId.replace(/[^a-z0-9._-]+/gi, '-')}.json`
}

function workshopModelOf(op, modelId) {
  const catalog = op === WORKSHOP.cutout.op
    ? WORKSHOP.cutout
    : op === WORKSHOP.pbr.op
      ? WORKSHOP.pbr
      : op === WORKSHOP.depth.op
        ? WORKSHOP.depth
        : op === WORKSHOP.relight.op
          ? WORKSHOP.relight
          : null
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  return models.find((model) => model?.id === modelId) ?? null
}

function unavailableError(evaluation) {
  const reason = evaluation?.reason ? `：${evaluation.reason}` : ''
  return Object.assign(
    new Error(`本机暂不满足该工坊模型的运行条件${reason}。请释放显存后重试，或切换云端。`),
    { code: 'invalid_request', retryWith: 'cloud', evaluation },
  )
}

/**
 * 运行一个隐藏窗口的 CUDA 子进程，解析逐行 JSON 事件。
 *
 * 取消与超时都会终止整棵进程树：Windows 使用 `taskkill /T /F`，Linux/macOS 先发 SIGTERM，
 * 1.5 秒后仍存活再 SIGKILL。Promise 只在子进程真正 close 后结束，保证队列槽位不会在
 * Python / CUDA 尚未释放显存时提前放行下一个任务。
 */
export function runCudaProcess(command, args, {
  signal,
  env = process.env,
  input,
  onEvent,
  timeoutMs = 1_800_000,
} = {}) {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env,
      // POSIX 下建立独立进程组，取消时可连同 Python 再派生的编译器/下载进程一起回收。
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let pending = ''
    let stderr = ''
    let result = null
    let eventError = null
    let timedOut = false
    let settled = false
    let forceKillTimer = null

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => child.kill())
        return
      }
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      forceKillTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, 1500)
      forceKillTimer.unref?.()
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const abort = () => terminate()
    signal?.addEventListener('abort', abort, { once: true })

    function consume(line) {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line)
        if (event.event === 'result') result = event
        else if (event.event === 'error') {
          eventError = Object.assign(new Error(event.message), { code: event.code })
        } else onEvent?.(event)
      } catch {
        // 模型库的普通 stdout 不是协议消息，忽略即可；stderr 会保留在错误摘要里。
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop().slice(-65_536)
      for (const line of lines) consume(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000)
    })

    const cleanup = () => {
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      signal?.removeEventListener('abort', abort)
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (pending) consume(pending)
      if (signal?.aborted) return reject(signal.reason ?? Object.assign(new Error('已取消'), { name: 'AbortError' }))
      if (timedOut) {
        return reject(Object.assign(
          new Error('本机 CUDA 准备或推理超时，请重试或切换云端。'),
          { code: 'generate_failed' },
        ))
      }
      if (eventError) return reject(eventError)
      if (code !== 0) {
        return reject(Object.assign(
          new Error(`本机 CUDA 运行失败：${stderr.trim() || `进程退出 ${code}`}`),
          { code: 'load_failed' },
        ))
      }
      resolvePromise(result)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ? JSON.stringify(input) : undefined)
  })
}

/**
 * @param {{
 *   ctx?: object,
 *   appConfig?: object,
 *   localModels: { effectiveDir: () => string },
 *   hardwareProbe: { probe: (options: object) => Promise<object> },
 *   env?: object,
 *   platform?: NodeJS.Platform,
 *   arch?: string,
 *   runProcess?: typeof runCudaProcess,
 *   download?: Function,
 * }} options
 */
export function createLocalWorkshop({
  ctx,
  appConfig,
  localModels,
  hardwareProbe,
  getModelSource,
  getHfToken,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  runProcess = runCudaProcess,
  download,
} = {}) {
  const root = appConfig?.root || join(workspaceRoot(ctx), META_DIR)
  // 保留旧目录名，直接复用用户已经下载的 2.5–3 GB PyTorch CUDA 环境。
  const runtimeDir = join(root, 'runtime', 'local-pbr')
  const environmentDir = join(runtimeDir, 'python-env')
  const python = join(environmentDir, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const marker = join(runtimeDir, 'ready.json')
  const modelRoot = () => join(localModels.effectiveDir(), 'workshop-cuda')
  const markerRoot = () => join(modelRoot(), 'ready')
  const hfHome = () => join(modelRoot(), 'hf')
  const pbrLegacyDir = () => join(localModels.effectiveDir(), 'marigold')
  let preparing = null
  let cachedInfo = { prepared: false, envCached: false, cachedModels: {} }

  async function readInfo() {
    const runtime = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null)
    const envCached = runtime?.version === RUNTIME_VERSION
    const cachedModels = {}
    await Promise.all(Object.values(WORKSHOP_COMPUTE_PROFILES)
      .filter((profileInfo) => profileInfo.tier === 'hybrid-cuda')
      .map(async (profileInfo) => {
        if (profileInfo.id === 'pbr:marigold') {
          const legacy = await readFile(join(pbrLegacyDir(), 'ready.json'), 'utf8')
            .then(JSON.parse)
            .catch(() => null)
          if (legacy?.revision === LOCAL_PBR.intrinsicsRevision) {
            cachedModels[profileInfo.id] = true
            return
          }
        }
        const ready = await readFile(join(markerRoot(), profileFileOf(profileInfo.id)), 'utf8')
          .then(JSON.parse)
          .catch(() => null)
        if (ready?.model === profileInfo.model) cachedModels[profileInfo.id] = true
      }))
    cachedInfo = {
      prepared: envCached,
      envCached,
      cachedModels,
      runtimeVersion: RUNTIME_VERSION,
    }
    return cachedInfo
  }

  async function capability({ op, model, force = false } = {}) {
    await mkdir(modelRoot(), { recursive: true })
    const hardware = await hardwareProbe.probe({ modelsDir: localModels.effectiveDir(), force })
    const info = await readInfo()
    const evaluation = evaluateWorkshopCompute(
      { ...hardware, localWorkshop: info },
      { op, model, arch },
    )
    return { ...evaluation, available: evaluation.localEligible }
  }

  async function prepare(signal, onEvent) {
    const saved = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null)
    const modelSource = typeof getModelSource === 'function' ? getModelSource() : ''
    const hfToken = typeof getHfToken === 'function' ? String(getHfToken() || '').trim() : ''
    const processEnv = {
      ...env,
      UV_CACHE_DIR: join(runtimeDir, 'cache'),
      UV_PYTHON_INSTALL_DIR: join(runtimeDir, 'python'),
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONNOUSERSITE: '1',
      HF_HOME: hfHome(),
      HF_HUB_DISABLE_TELEMETRY: '1',
    }
    if (hfToken && !processEnv.HF_TOKEN) {
      processEnv.HF_TOKEN = hfToken
    }
    if (modelSource && !processEnv.AIGC_MODEL_SOURCE) {
      processEnv.AIGC_MODEL_SOURCE = modelSource
    }
    if (modelSource === 'hf-mirror' && !processEnv.HF_ENDPOINT) {
      processEnv.HF_ENDPOINT = 'https://hf-mirror.com'
    }
    delete processEnv.PYTHONPATH
    delete processEnv.PYTHONHOME
    await mkdir(hfHome(), { recursive: true })
    if (saved?.version === RUNTIME_VERSION) {
      try {
        const probe = await runProcess(python, [RUNNER, '--probe'], {
          signal,
          env: processEnv,
          timeoutMs: 30_000,
        })
        if (probe?.cuda) return processEnv
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    onEvent?.({ event: 'stage', stage: 'preparing' })
    await mkdir(runtimeDir, { recursive: true })
    let uv = env.AIGC_STUDIO_UV_PATH || 'uv'
    try {
      await runProcess(uv, ['--version'], { signal, env: processEnv, timeoutMs: 10_000 })
    } catch (error) {
      if (signal?.aborted) throw error
      const asset = UV_ASSETS[platform]
      if (!asset || arch !== 'x64') {
        throw Object.assign(
          new Error('此系统尚不支持本机 CUDA 工坊，请使用云端。'),
          { code: 'invalid_request' },
        )
      }
      const archive = join(runtimeDir, asset.file)
      await prepareAsset(asset, archive, { signal, download })
      const tarBin = platform === 'win32'
        ? join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
      await runProcess(tarBin, ['-xf', archive, '-C', runtimeDir], { signal, timeoutMs: 120_000 })
      uv = join(runtimeDir, asset.executable)
      if (platform !== 'win32') await chmod(uv, 0o755)
    }
    processEnv.AIGC_STUDIO_UV_PATH = uv
    await runProcess(uv, ['venv', '--python', '3.11', '--managed-python', '--allow-existing', '--seed', environmentDir], {
      signal,
      env: processEnv,
    })
    await runProcess(uv, [
      'pip', 'install', '--python', python,
      '--index-url', 'https://download.pytorch.org/whl/cu124',
      'torch==2.6.0', 'torchvision==0.21.0',
    ], { signal, env: processEnv })
    await runProcess(uv, [
      'pip', 'install', '--python', python,
      'torch==2.6.0', 'torchvision==0.21.0', 'diffusers==0.35.2', 'transformers==4.57.3',
      'accelerate==1.12.0', 'safetensors==0.7.0', 'Pillow==12.0.0', 'hf-xet==1.2.0',
      'huggingface_hub', 'einops', 'omegaconf', 'addict', 'opencv-python-headless', 'scipy', 'timm', 'kornia',
    ], { signal, env: processEnv })
    const probe = await runProcess(python, [RUNNER, '--probe'], {
      signal,
      env: processEnv,
      timeoutMs: 60_000,
    })
    if (!probe?.cuda) {
      throw Object.assign(
        new Error('本机 CUDA 推理环境不可用，请更新显卡驱动或切换云端。'),
        { code: 'gpu_unavailable' },
      )
    }
    await writeFileAtomic(marker, `${JSON.stringify({ version: RUNTIME_VERSION })}\n`, { ensureDir: true })
    await readInfo()
    return processEnv
  }

  async function markModelReady(op, model, modelId) {
    const profileInfo = workshopComputeProfileOf(op, model)
    if (!profileInfo) return
    const payload = {
      model: profileInfo.model,
      repo: modelId,
      readyAt: new Date().toISOString(),
    }
    await writeFileAtomic(
      join(markerRoot(), profileFileOf(profileInfo.id)),
      `${JSON.stringify(payload)}\n`,
      { ensureDir: true },
    )
    if (profileInfo.id === 'pbr:marigold') {
      await writeFileAtomic(
        join(pbrLegacyDir(), 'ready.json'),
        `${JSON.stringify({ revision: LOCAL_PBR.intrinsicsRevision })}\n`,
        { ensureDir: true },
      )
    }
    cachedInfo = {
      ...cachedInfo,
      cachedModels: { ...cachedInfo.cachedModels, [profileInfo.id]: true },
    }
  }

  async function run({ op, model, sourcePath, steps = 0, options = null, signal, onEvent } = {}) {
    const profileInfo = workshopComputeProfileOf(op, model)
    if (!profileInfo || profileInfo.tier !== 'hybrid-cuda') {
      throw Object.assign(
        new Error(`工坊模型 ${op || '?'}/${model || '?'} 不支持本机 CUDA 执行，请切换云端。`),
        { code: 'invalid_request' },
      )
    }
    const modelInfo = workshopModelOf(op, model)
    if (!modelInfo) {
      throw Object.assign(
        new Error(`契约目录里找不到工坊模型 ${op}/${model}`),
        { code: 'invalid_request' },
      )
    }
    const evaluation = await capability({ op, model, force: true })
    if (!evaluation.localEligible) throw unavailableError(evaluation)
    if (!preparing) preparing = prepare(signal, onEvent).finally(() => { preparing = null })
    const processEnv = await preparing
    signal?.throwIfAborted()
    const outputDir = await mkdtemp(join(runtimeDir, 'result-'))
    try {
      const input = {
        tool: op,
        model,
        modelRepo: modelInfo.repo,
        sourcePath,
        outputDir,
        modelDir: profileInfo.id === 'pbr:marigold' ? pbrLegacyDir() : hfHome(),
        modelRoot: modelRoot(),
        hfHome: hfHome(),
        gpuIndex: evaluation.gpuIndex,
        steps,
        options: options && typeof options === 'object' ? options : {},
        outputEdge: WORKSHOP.relight.outputEdge,
        ...(op === WORKSHOP.pbr.op ? {
          intrinsicsRepo: LOCAL_PBR.intrinsicsRepo,
          intrinsicsRevision: LOCAL_PBR.intrinsicsRevision,
          normalsRepo: LOCAL_PBR.normalsRepo,
          normalsRevision: LOCAL_PBR.normalsRevision,
        } : {}),
      }
      const result = await runProcess(python, [RUNNER], {
        signal,
        env: processEnv,
        onEvent,
        input,
      })
      const expected = CHANNELS[op] ?? []
      const received = Array.isArray(result?.results) ? result.results : []
      if (received.length !== expected.length) {
        throw Object.assign(
          new Error(`本机 ${op} 返回 ${received.length} 个通道，契约要求 ${expected.length} 个。`),
          { code: 'empty_result' },
        )
      }
      const byChannel = new Map()
      for (const item of received) {
        if (!item || typeof item.channel !== 'string' || !expected.includes(item.channel)) continue
        const absolute = resolve(item.path)
        if (!absolute.startsWith(resolve(outputDir) + sep) || dirname(absolute) !== resolve(outputDir)) {
          throw Object.assign(new Error('本机 CUDA 返回了无效产物路径。'), { code: 'invalid_path' })
        }
        byChannel.set(item.channel, {
          channel: item.channel,
          image_b64: (await readFile(absolute)).toString('base64'),
          width: item.width,
          height: item.height,
        })
      }
      const results = expected.map((channel) => byChannel.get(channel)).filter(Boolean)
      if (results.length !== expected.length) {
        throw Object.assign(
          new Error(`本机 ${op} 缺少通道：${expected.filter((channel) => !byChannel.has(channel)).join(' / ')}`),
          { code: 'generation_failed' },
        )
      }
      await markModelReady(op, model, modelInfo.repo)
      return {
        results,
        modelId: modelInfo.repo,
        device: evaluation.gpuName || null,
        evaluation,
      }
    } finally {
      // outputDir 由受控 runtimeDir 下的 mkdtemp 生成；删除前再校验绝对路径。
      if (resolve(outputDir).startsWith(resolve(runtimeDir) + sep)) {
        await rm(outputDir, { recursive: true, force: true })
      }
    }
  }

  return { capability, prepare, readInfo, run, getCachedInfo: () => cachedInfo }
}
