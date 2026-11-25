import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { LOCAL_GPU_ENGINE, LOCAL_GPU_ENGINE_MARKER } from '../../shared/local-gpu-assets.js'
import { fileBytes, prepareAsset } from './assets.js'

const exec = promisify(execFile)
const LICENSE_FILES = ['stable-diffusion.cpp.txt', 'ggml.txt', 'libwebm.txt']

export async function localGpuEngineReady(destination) {
  const [marker, ...entries] = await Promise.all([
    readFile(join(destination, LOCAL_GPU_ENGINE_MARKER), 'utf8').catch(() => ''),
    ...['sd-server.exe', 'ggml-base.dll', 'ggml-vulkan.dll', 'ggml.dll', 'stable-diffusion.dll', 'stable-diffusion.cpp.txt'].map((file) => fileBytes(join(destination, file))),
  ])
  return marker.trim() === LOCAL_GPU_ENGINE.sha256 && entries.every((bytes) => bytes > 0)
}

export async function prepareLocalGpuEngine(destination, { signal, download, onProgress } = {}) {
  if (await localGpuEngineReady(destination)) return destination
  const archive = join(dirname(destination), LOCAL_GPU_ENGINE.file)
  await prepareAsset(LOCAL_GPU_ENGINE, archive, {
    signal,
    download,
    onProgress,
  })
  const extracted = await mkdtemp(join(dirname(destination), `${basename(destination)}-extract-`))
  try {
    await exec('tar', ['-xf', archive, '-C', extracted], { windowsHide: true, timeout: 120_000 })
    for (const file of ['sd-server.exe', 'ggml-vulkan.dll', 'stable-diffusion.dll', 'stable-diffusion.cpp.txt']) {
      if (!(await stat(join(extracted, file))).isFile()) throw new Error(`引擎文件不完整：${file}`)
    }
    signal?.throwIfAborted()
    const available = await statfs(dirname(destination))
    if (Number(available.bavail) * Number(available.bsize) < LOCAL_GPU_ENGINE.bytes * 5) {
      throw new Error('系统盘可用空间不足以解压 Vulkan 引擎。请先释放约 150 MB 空间后重试。')
    }
    await mkdir(dirname(destination), { recursive: true })
    const runtime = join(dirname(destination), `${basename(destination)}-runtime`)
    await rm(runtime, { recursive: true, force: true })
    await mkdir(runtime, { recursive: true })
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(extracted, { withFileTypes: true }))
    const files = entries
      .filter((entry) => entry.isFile() && (/^sd-server\.exe$/i.test(entry.name) || /^ggml.*\.dll$/i.test(entry.name) || /^stable-diffusion\.dll$/i.test(entry.name) || /^lib.*\.dll$/i.test(entry.name) || /^webm\.dll$/i.test(entry.name) || /^.*\.txt$/i.test(entry.name)))
    if (!files.some((entry) => /^sd-server\.exe$/i.test(entry.name))) throw new Error('引擎文件不完整：sd-server.exe')
    const { copyFile } = await import('node:fs/promises')
    await Promise.all(files.map((entry) => copyFile(join(extracted, entry.name), join(runtime, entry.name))))
    await writeFile(join(runtime, LOCAL_GPU_ENGINE_MARKER), `${LOCAL_GPU_ENGINE.sha256}\n`, 'utf8')
    const licenseDir = join(dirname(destination), 'licenses', 'stable-diffusion.cpp')
    await mkdir(licenseDir, { recursive: true })
    await Promise.all(LICENSE_FILES.map(async (file) => {
      try {
        await copyFile(join(extracted, file), join(licenseDir, file))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }))
    const backup = `${destination}.previous`
    await rm(backup, { recursive: true, force: true })
    const existingServer = await fileBytes(join(destination, 'sd-server.exe'))
    if (existingServer) {
      await cp(destination, backup, { recursive: true })
      await cp(runtime, destination, { recursive: true, force: true })
      await rm(backup, { recursive: true, force: true })
    } else {
      await rename(runtime, destination)
    }
    onProgress?.(LOCAL_GPU_ENGINE.bytes)
    return destination
  } finally {
    await rm(join(dirname(destination), `${basename(destination)}-runtime`), { recursive: true, force: true }).catch(() => {})
    await rm(extracted, { recursive: true, force: true }).catch(() => {})
  }
}
