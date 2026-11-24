/**
 * 测试 bundle 构建脚本。
 *
 * 用途：把 `web/` 下的 ESM 源码（含 JSX）打成一个自包含单文件，供
 * `test/load-client.mjs` 在 Node 里求值加载，做无浏览器渲染测试。
 *
 * 产物：`test/.build/web.test.js`（测试专用，含 `__test` 内部出口）。
 *
 * 与 DSH 版 build.mjs 的差异（见 docs/MIGRATION_SPEC.md §7.2）：
 *  - 入口从 `src/test-entry.js` 改为 `web/test-entry.js`；
 *  - 产物名从 `test/.build/client.test.js` 改为 `test/.build/web.test.js`；
 *  - 平台共享模块只保留 `react` / `react/jsx-runtime`（不再有 `@deepseek-ai/*`）；
 *  - 发布产物不再由本脚本生成（Web 站点由 Vite 构建到 dist/web），因此默认行为也写测试产物。
 *
 * 兼容保留：`bundle({ test })` 导出（test/helpers/render.mjs 与 test/image-tool-render.mjs
 * 直接调用）、`TEST_ARTIFACT` 导出、`--test` / `--check` 模式。
 *
 * 用法：
 *   node tools/build-web-test-bundle.mjs --test   产出测试 bundle
 *   node tools/build-web-test-bundle.mjs --check  只构建不写盘，校对产物是否最新
 *   node tools/build-web-test-bundle.mjs          等价 --test
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(TOOLS_DIR)

const PACKAGE_ID = 'aigc-studio'
export const TEST_ARTIFACT = join(ROOT, 'test/.build/web.test.js')

/** 测试求值环境（test/load-client.mjs）提供的平台模块：必须保持 external。 */
const PLATFORM_MODULES = ['react', 'react/jsx-runtime']

/**
 * 测试模块加载器信封。
 *
 * standalone 版不再有宿主 `__ModuleLoader__`，但测试加载器沿用了「求值 → 从 factory 取模块」
 * 的加载方式：信封只负责把 ESM 产物包成一次同步 require 调用，测试端注入假
 * `window.__ModuleLoader__` 即可拿到 `registration.factory(require)`。
 * 这是测试基础设施，不参与产品运行（浏览器侧由 Vite 直接打包 ES 模块）。
 */
const ENVELOPE_HEAD = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PACKAGE_ID)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`

const ENVELOPE_TAIL = `\t\treturn module.exports;\n\t}\n});\n`

/**
 * 打包 web/test-entry.js 并返回 bundle 文本。
 * @param {{ test?: boolean }} [options] 保留旧签名；standalone 版始终打测试入口。
 */
export async function bundle(_options = {}) {
  const result = await build({
    entryPoints: [join(ROOT, 'web/test-entry.js')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome120'],
    external: PLATFORM_MODULES,
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'warning',
    absWorkingDir: ROOT,
    // JSX 交给 esbuild 转换，运行时走 react/jsx-runtime。
    jsx: 'automatic',
    // Node 测试替身不渲染样式；模型海报在构建期内联为 data URL。
    loader: { '.css': 'empty', '.webp': 'dataurl', '.svg': 'dataurl' },
    resolveExtensions: ['.jsx', '.js', '.json'],
  })

  const body = result.outputFiles[0].text.replace(/^\s*"use strict";\s*\n/, '')
  return `${ENVELOPE_HEAD}${body}\n${ENVELOPE_TAIL}`
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function writeTestArtifact(text) {
  await mkdir(dirname(TEST_ARTIFACT), { recursive: true })
  await writeFile(TEST_ARTIFACT, text, 'utf8')
}

async function main() {
  const flags = new Set(process.argv.slice(2))

  if (flags.has('--check')) {
    const text = await bundle()
    const current = await readIfExists(TEST_ARTIFACT)
    if (current !== text) {
      console.error('test/.build/web.test.js 与 web/ 源码不一致，请运行 node tools/build-web-test-bundle.mjs --test 重新构建')
      process.exitCode = 1
      return
    }
    console.log('test/.build/web.test.js 是最新的')
    return
  }

  // `--test` 与无参数都写测试产物：standalone 版不再有 DSH 发布产物 client.js，
  // 线上站点由 Vite 构建（npx vite build）。
  const text = await bundle({ test: true })
  await writeTestArtifact(text)
  console.log(`已产出测试 bundle：${TEST_ARTIFACT}（${text.length} 字节）`)
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
