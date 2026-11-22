#!/usr/bin/env node
/**
 * 工具规格单源回归（M3.3）：`shared/tool-specs.js` 与 `server/tools.js` 注册面完全一致。
 *
 * 防的是「两套真相」：MCP Server 直接读 shared 规格，本地 Agent 走 server/tools.js；
 * 名称、描述或 JSON Schema 一旦漂移，外部模型会调用一个本地服务不认识的参数。
 *
 * 运行：node test/tool-specs.mjs
 */

import assert from 'node:assert/strict'

import { registerTools } from '../server/tools.js'
import { OUTPUT_DIR } from '../server/paths.js'
import { TOOL_OUTPUT_DIR, TOOL_SPECS, toolNames, toolSpecOf } from '../shared/tool-specs.js'
import { createCheckRunner } from './helpers/check.mjs'

const { check, results } = createCheckRunner()

function collectRegistered() {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
  }
  registerTools(ctx, {
    queue: { submit: () => ({ ok: false }), waitFor: async () => null, get: () => null, cancel: () => ({ ok: false }) },
    session: { start: async () => ({}), stop: async () => ({}), snapshot: () => ({}) },
    defaultPreset: 'sdxl-lightning',
  })
  return registered
}

async function main() {
  await check('工具数量为 7，名称与顺序一致', () => {
    const registered = collectRegistered()
    assert.equal(registered.length, 7)
    assert.deepEqual(registered.map((item) => item.name), toolNames())
  })

  await check('名称 / 描述 / JSON Schema 与共享规格逐字一致', () => {
    const registered = collectRegistered()
    for (const definition of registered) {
      const spec = toolSpecOf(definition.name)
      assert.ok(spec, `共享规格缺少 ${definition.name}`)
      assert.equal(definition.description, spec.description, `${definition.name} 描述漂移`)
      assert.deepEqual(definition.parameters, spec.parameters, `${definition.name} 参数 schema 漂移`)
    }
  })

  await check('共享规格无重复名称且全部可反查', () => {
    const names = toolNames()
    assert.equal(new Set(names).size, names.length)
    for (const spec of TOOL_SPECS) {
      assert.equal(toolSpecOf(spec.name), spec)
    }
    assert.equal(toolSpecOf('imagen_unknown'), null)
  })

  await check('产物目录常量与 server/paths.js 一致', () => {
    assert.equal(TOOL_OUTPUT_DIR, OUTPUT_DIR)
  })

  await check('参数 schema 都是可 JSON 序列化的纯数据（MCP 可直接下发）', () => {
    for (const spec of TOOL_SPECS) {
      const cloned = JSON.parse(JSON.stringify(spec.parameters))
      assert.deepEqual(cloned, spec.parameters)
      assert.equal(spec.parameters.type, 'object')
    }
  })

  const failed = results.filter((item) => !item.ok)
  if (failed.length > 0) {
    console.error(`\n${failed.length} 项失败`)
    process.exitCode = 1
    return
  }
  console.log(`\n全部通过（${results.length} 项）`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
