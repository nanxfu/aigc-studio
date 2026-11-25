import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareLocalGpuEngine } from '../server/local-gpu/engine.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const cache = join(root, '.tmp', 'local-gpu')

export async function prepareEngine(destination) {
  await prepareLocalGpuEngine(destination)
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const { Arch } = await import('builder-util')
  if (context.arch !== Arch.x64) return
  await prepareEngine(join(context.packager.projectDir, '.tmp', 'local-gpu', 'engine'))
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const destination = join(cache, 'engine')
  await prepareEngine(destination)
  console.log(`Vulkan engine ready: ${destination}`)
}
