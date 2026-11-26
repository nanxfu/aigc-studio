import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  LOCAL_GPU_ENGINE_MARKER,
  localGpuEngineOf,
} from '../../shared/local-gpu-assets.js'
import { fileBytes, prepareAsset } from './assets.js'

const exec = promisify(execFile)
const LICENSE_FILES = ['stable-diffusion.cpp.txt', 'ggml.txt', 'libwebm.txt']

function backendEngine(backend) {
  return localGpuEngineOf(backend)
}

async function filesUnder(root) {
  const out = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await filesUnder(absolute))
    else if (entry.isFile()) out.push(absolute)
  }
  return out
}

export async function localGpuEngineReady(destination, backend = 'vulkan') {
  const engine = backendEngine(backend)
  const [marker, server, diffusion, ggml, entries] = await Promise.all([
    readFile(join(destination, LOCAL_GPU_ENGINE_MARKER), 'utf8').catch(() => ''),
    fileBytes(join(destination, 'sd-server.exe')),
    fileBytes(join(destination, 'stable-diffusion.dll')),
    fileBytes(join(destination, 'ggml.dll')),
    readdir(destination).catch(() => []),
  ])
  const backendReady = backend === 'cuda'
    ? entries.some((name) => /^(ggml-cuda.*\.dll|cudart.*\.dll)$/i.test(name))
    : entries.some((name) => /^ggml-vulkan.*\.dll$/i.test(name))
  return marker.trim() === engine.sha256 && server > 0 && diffusion > 0 && ggml > 0 && backendReady
}

/**
 * 准备 Vulkan / CUDA 引擎。CUDA 需要同时拉取官方 cudart 运行库。
 * 所有归档先校验 SHA-256，再解压并只复制运行所需二进制到目标目录。
 */
export async function prepareLocalGpuEngine(destination, {
  signal,
  download,
  onProgress,
  backend = 'vulkan',
} = {}) {
  const engine = backendEngine(backend)
  if (await localGpuEngineReady(destination, backend)) return destination
  const totalBytes = engine.archives.reduce((sum, archive) => sum + archive.bytes, 0)
  const available = await statfs(dirname(destination)).catch(() => null)
  if (available && Number(available.bavail) * Number(available.bsize) < totalBytes * 2.5) {
    throw new Error(`系统盘可用空间不足以准备 ${engine.label} 引擎。请先释放约 ${Math.ceil(totalBytes / 1024 ** 3)} GB 空间后重试。`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const runtime = join(dirname(destination), `${basename(destination)}-runtime-${process.pid}-${Date.now()}`)
  await mkdir(runtime, { recursive: true })
  let downloadedBytes = 0
  try {
    for (const archive of engine.archives) {
      const archivePath = join(dirname(destination), archive.file)
      await prepareAsset(archive, archivePath, {
        signal,
        download,
        onProgress: (bytes) => onProgress?.(downloadedBytes + bytes, totalBytes),
      })
      const extracted = await mkdtemp(join(dirname(destination), `${basename(destination)}-extract-`))
      try {
        await exec('tar', ['-xf', archivePath, '-C', extracted], { windowsHide: true, timeout: 180_000 })
        const files = await filesUnder(extracted)
        for (const file of files) {
          if (!/\.(exe|dll|txt)$/i.test(file)) continue
          await copyFile(file, join(runtime, basename(file)))
        }
      } finally {
        await rm(extracted, { recursive: true, force: true }).catch(() => {})
      }
      downloadedBytes += archive.bytes
      onProgress?.(downloadedBytes, totalBytes)
    }
    signal?.throwIfAborted()
    if (!(await stat(join(runtime, 'sd-server.exe'))).isFile()) {
      throw new Error(`引擎文件不完整：缺少 sd-server.exe（${engine.label}）`)
    }
    for (const file of ['ggml.dll', 'stable-diffusion.dll']) {
      if (!(await stat(join(runtime, file))).isFile()) throw new Error(`引擎文件不完整：${file}`)
    }
    await writeFile(join(runtime, LOCAL_GPU_ENGINE_MARKER), `${engine.sha256}\n`, 'utf8')
    const licenseDir = join(dirname(destination), 'licenses', 'stable-diffusion.cpp')
    await mkdir(licenseDir, { recursive: true })
    await Promise.all(LICENSE_FILES.map(async (file) => {
      try {
        await copyFile(join(runtime, file), join(licenseDir, file))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }))
    const backup = `${destination}.previous`
    await rm(backup, { recursive: true, force: true })
    if (await fileBytes(join(destination, 'sd-server.exe'))) {
      await rm(destination, { recursive: true, force: true })
    }
    await rename(runtime, destination)
    onProgress?.(totalBytes, totalBytes)
    return destination
  } finally {
    await rm(runtime, { recursive: true, force: true }).catch(() => {})
  }
}
