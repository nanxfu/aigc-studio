import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateLocalPbr, LOCAL_PBR } from '../shared/workshop-compute.js'
import { writeFileAtomic } from './fs-atomic.js'
import { prepareAsset } from './local-gpu/assets.js'
import { META_DIR, workspaceRoot } from './paths.js'

const RUNNER = fileURLToPath(new URL('../worker/local_pbr.py', import.meta.url))
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
const RUNTIME_VERSION = 'torch-2.6.0-diffusers-0.35.2-v1'

/** 所有子进程直接传参数、隐藏窗口；取消与退出等待进程关闭后才释放队列。 */
export function runPbrProcess(command, args, { signal, env = process.env, input, onEvent, timeoutMs = 1_800_000 } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let pending = ''
    let stderr = ''
    let result = null
    let eventError = null
    let timedOut = false
    const abort = () => child.kill()
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    function consume(line) {
      try {
        const event = JSON.parse(line)
        if (event.event === 'result') result = event
        else if (event.event === 'error') eventError = Object.assign(new Error(event.message), { code: event.code })
        else onEvent?.(event)
      } catch { /* 库的普通 stdout 不是协议消息。 */ }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop().slice(-65_536)
      for (const line of lines) consume(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    child.on('error', (error) => { cleanup(); reject(error) })
    child.on('close', (code) => {
      cleanup()
      if (pending) consume(pending)
      if (signal?.aborted) return reject(signal.reason)
      if (timedOut) return reject(Object.assign(new Error('本地 PBR 准备或推理超时，请重试或切换云端。'), { code: 'generate_failed' }))
      if (eventError) return reject(eventError)
      if (code !== 0) return reject(Object.assign(new Error(`本地 PBR 运行失败：${stderr.trim() || `进程退出 ${code}`}`), { code: 'load_failed' }))
      resolvePromise(result)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ? JSON.stringify(input) : undefined)
  })
}

export function createLocalPbr({ ctx, appConfig, localModels, hardwareProbe, env = process.env,
  platform = process.platform, arch = process.arch, runProcess = runPbrProcess, download } = {}) {
  const root = appConfig?.root || join(workspaceRoot(ctx), META_DIR)
  const runtimeDir = join(root, 'runtime', 'local-pbr')
  const environmentDir = join(runtimeDir, 'python-env')
  const python = join(environmentDir, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const marker = join(runtimeDir, 'ready.json')
  const modelDir = () => join(localModels.effectiveDir(), 'marigold')
  let preparing = null
  let cachedInfo = { prepared: false }

  async function readInfo() {
    const [runtime, weights] = await Promise.all([
      readFile(marker, 'utf8').then(JSON.parse).catch(() => null),
      readFile(join(modelDir(), 'ready.json'), 'utf8').then(JSON.parse).catch(() => null),
    ])
    cachedInfo = { prepared: runtime?.version === RUNTIME_VERSION && weights?.revision === LOCAL_PBR.intrinsicsRevision }
    return cachedInfo
  }

  async function capability({ force = false } = {}) {
    await mkdir(modelDir(), { recursive: true })
    const hardware = await hardwareProbe.probe({ modelsDir: modelDir(), force })
    return evaluateLocalPbr({ ...hardware, localPbr: await readInfo() }, { arch })
  }

  async function prepare(signal, onEvent) {
    const saved = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null)
    const processEnv = {
      ...env,
      UV_CACHE_DIR: join(runtimeDir, 'cache'),
      UV_PYTHON_INSTALL_DIR: join(runtimeDir, 'python'),
      PYTHONUNBUFFERED: '1',
      PYTHONNOUSERSITE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
    }
    delete processEnv.PYTHONPATH
    delete processEnv.PYTHONHOME
    if (saved?.version === RUNTIME_VERSION) {
      try {
        const probe = await runProcess(python, [RUNNER, '--probe'], { signal, env: processEnv, timeoutMs: 30_000 })
        if (probe?.cuda) return processEnv
      } catch (error) { if (signal?.aborted) throw error }
    }
    onEvent?.({ event: 'stage', stage: 'preparing' })
    await mkdir(runtimeDir, { recursive: true })
    let uv = env.AIGC_STUDIO_UV_PATH || 'uv'
    try {
      await runProcess(uv, ['--version'], { signal, env: processEnv, timeoutMs: 10_000 })
    } catch (error) {
      if (signal?.aborted) throw error
      const asset = UV_ASSETS[platform]
      if (!asset || arch !== 'x64') throw Object.assign(new Error('此系统尚不支持本地 PBR，请使用云端。'), { code: 'invalid_request' })
      const archive = join(runtimeDir, asset.file)
      await prepareAsset(asset, archive, { signal, download })
      await runProcess('tar', ['-xf', archive, '-C', runtimeDir], { signal, timeoutMs: 120_000 })
      uv = join(runtimeDir, asset.executable)
      if (platform !== 'win32') await chmod(uv, 0o755)
    }
    await runProcess(uv, ['venv', '--python', '3.11', '--managed-python', '--allow-existing', environmentDir], { signal, env: processEnv })
    await runProcess(uv, ['pip', 'install', '--python', python, '--index-url', 'https://download.pytorch.org/whl/cu124',
      'torch==2.6.0'], { signal, env: processEnv })
    await runProcess(uv, ['pip', 'install', '--python', python, 'diffusers==0.35.2', 'transformers==4.57.3',
      'accelerate==1.12.0', 'safetensors==0.7.0', 'Pillow==12.0.0', 'hf-xet==1.2.0'], { signal, env: processEnv })
    const probe = await runProcess(python, [RUNNER, '--probe'], { signal, env: processEnv, timeoutMs: 60_000 })
    if (!probe?.cuda) throw Object.assign(new Error('本地 CUDA 推理环境不可用，请更新显卡驱动或切换云端。'), { code: 'gpu_unavailable' })
    await writeFileAtomic(marker, `${JSON.stringify({ version: RUNTIME_VERSION })}\n`, { ensureDir: true })
    return processEnv
  }

  async function run({ sourcePath, steps, signal, onEvent }) {
    const device = await capability({ force: true })
    if (!device.available) throw Object.assign(new Error(`本机暂不满足 PBR 运行条件（${device.reason}），请切换云端或释放资源后重试。`), { code: 'invalid_request' })
    if (!preparing) preparing = prepare(signal, onEvent).finally(() => { preparing = null })
    const processEnv = await preparing
    signal?.throwIfAborted()
    const outputDir = await mkdtemp(join(runtimeDir, 'result-'))
    try {
      const result = await runProcess(python, [RUNNER], {
        signal, env: processEnv, onEvent,
        input: { sourcePath, outputDir, modelDir: modelDir(), steps, gpuIndex: device.gpuIndex, ...LOCAL_PBR },
      })
      if (!Array.isArray(result?.results)) throw Object.assign(new Error('本地 PBR 没有返回贴图。'), { code: 'empty_result' })
      const results = await Promise.all(result.results.map(async (item) => {
        const absolute = resolve(item.path)
        if (!absolute.startsWith(resolve(outputDir) + sep) || dirname(absolute) !== resolve(outputDir)) {
          throw Object.assign(new Error('本地 PBR 返回了无效产物路径。'), { code: 'invalid_path' })
        }
        return { channel: item.channel, image_b64: (await readFile(absolute)).toString('base64'), width: item.width, height: item.height }
      }))
      await writeFileAtomic(join(modelDir(), 'ready.json'), `${JSON.stringify({ revision: LOCAL_PBR.intrinsicsRevision })}\n`, { ensureDir: true })
      cachedInfo = { prepared: true }
      return { results, modelId: LOCAL_PBR.intrinsicsRepo, device: device.device }
    } finally {
      // outputDir 由受控 runtimeDir 下的 mkdtemp 生成；删除前再校验绝对路径。
      if (resolve(outputDir).startsWith(resolve(runtimeDir) + sep)) await rm(outputDir, { recursive: true, force: true })
    }
  }
  return { capability, run, readInfo, getCachedInfo: () => cachedInfo }
}
