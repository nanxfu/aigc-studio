#!/usr/bin/env node
/**
 * 将 bench-results/9dim/ 下的实测 PNG 打包为：
 *   1. web/public/model-samples/<presetId>/<dimId>.webp（512×512 轻量化按需预览图）
 *   2. web/studio/modelSamples.generated.js（前端预览面板数据清单）
 *   3. web/studio/posters/<presetId>.webp（112×112 <4KB 真机实测卡片海报）
 *
 * 用法：
 *   node tools/build-model-samples.mjs
 *   node tools/build-model-samples.mjs --no-posters
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { BENCH_DIMS, POSTER_DIM_BY_MODEL } from './bench-9dim-prompts.mjs'

const REPO_ROOT = process.cwd()
const BENCH_DIR = resolve(REPO_ROOT, 'bench-results', '9dim')
const PUBLIC_SAMPLES_DIR = resolve(REPO_ROOT, 'web', 'public', 'model-samples')
const POSTERS_DIR = resolve(REPO_ROOT, 'web', 'studio', 'posters')
const GENERATED_JS = resolve(REPO_ROOT, 'web', 'studio', 'modelSamples.generated.js')
const skipPosters = process.argv.includes('--no-posters')

const ALL_MODEL_IDS = Object.keys(POSTER_DIM_BY_MODEL)

function convertImagesWithPython(jobs) {
  if (jobs.length === 0) return
  const py = `
import json, sys
from pathlib import Path
from PIL import Image

jobs = json.loads(sys.stdin.read())
for job in jobs:
    src = Path(job["src"])
    dst = Path(job["dst"])
    dst.parent.mkdir(parents=True, exist_ok=True)
    size = int(job["size"])
    quality = int(job["quality"])
    max_bytes = int(job.get("maxBytes", 0))
    with Image.open(src) as im:
        im = im.convert("RGB")
        w, h = im.size
        edge = min(w, h)
        left = (w - edge) // 2
        top = (h - edge) // 2
        im = im.crop((left, top, left + edge, top + edge))
        im = im.resize((size, size), Image.Resampling.LANCZOS)
        q = quality
        while True:
            im.save(dst, "WEBP", quality=q, method=6)
            if max_bytes <= 0 or dst.stat().st_size <= max_bytes or q <= 45:
                break
            q -= 5
`
  execFileSync('python', ['-c', py], {
    input: JSON.stringify(jobs),
    stdio: ['pipe', 'inherit', 'inherit'],
  })
}

async function main() {
  const convertJobs = []
  const samplesByModel = {}
  const updatedPosters = []

  for (const modelId of ALL_MODEL_IDS) {
    const modelDir = join(BENCH_DIR, modelId)
    if (!existsSync(modelDir)) continue

    for (const dim of BENCH_DIMS) {
      const pngPath = join(modelDir, `${dim.id}.png`)
      const jsonPath = join(modelDir, `${dim.id}.json`)
      if (!existsSync(pngPath) || !existsSync(jsonPath)) continue

      const meta = JSON.parse(await readFile(jsonPath, 'utf8'))
      const webpPath = join(PUBLIC_SAMPLES_DIR, modelId, `${dim.id}.webp`)
      convertJobs.push({ src: pngPath, dst: webpPath, size: 512, quality: 78 })

      if (!samplesByModel[modelId]) samplesByModel[modelId] = {}
      samplesByModel[modelId][dim.id] = {
        url: `/model-samples/${modelId}/${dim.id}.webp`,
        seconds: typeof meta.seconds === 'number' ? Number(meta.seconds.toFixed(1)) : null,
        width: meta.width ?? 1024,
        height: meta.height ?? 1024,
        provider: meta.provider ?? null,
        device: meta.device ?? null,
      }

      if (!skipPosters && POSTER_DIM_BY_MODEL[modelId] === dim.id) {
        const posterPath = join(POSTERS_DIR, `${modelId}.webp`)
        convertJobs.push({ src: pngPath, dst: posterPath, size: 112, quality: 70, maxBytes: 3900 })
        updatedPosters.push({ modelId, dimId: dim.id, posterPath })
      }
    }
  }

  await mkdir(PUBLIC_SAMPLES_DIR, { recursive: true })
  convertImagesWithPython(convertJobs)

  const dimsPayload = BENCH_DIMS.map((d) => ({
    id: d.id,
    index: d.index,
    shortZh: d.shortZh,
    shortEn: d.shortEn,
    titleZh: d.titleZh,
    titleEn: d.titleEn,
    focusZh: d.focusZh,
    focusEn: d.focusEn,
    featured: d.featured,
    seed: d.seed,
  }))

  const content = [
    '/**',
    ' * 自动生成文件，请勿手改：由 tools/build-model-samples.mjs 根据 bench-results/9dim/ 生成。',
    ' */',
    '',
    `export const SAMPLE_DIMS = ${JSON.stringify(dimsPayload, null, 2)}`,
    '',
    `export const MODEL_SAMPLES = ${JSON.stringify(samplesByModel, null, 2)}`,
    '',
  ].join('\n')

  await writeFile(GENERATED_JS, content, 'utf8')

  const totalModels = Object.keys(samplesByModel).length
  const totalSamples = Object.values(samplesByModel).reduce((n, m) => n + Object.keys(m).length, 0)
  console.log(`已生成 ${GENERATED_JS}：覆盖 ${totalModels} 款模型，共 ${totalSamples} 张实测样本。`)

  if (updatedPosters.length > 0) {
    let totalBytes = 0
    for (const p of updatedPosters) {
      const info = await stat(p.posterPath)
      totalBytes += info.size
      console.log(`  海报 ${p.modelId}.webp ← ${p.dimId}（${info.size} B）`)
    }
    console.log(`已更新 ${updatedPosters.length} 张 112×112 模型海报（合计 ${totalBytes} B）。`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
