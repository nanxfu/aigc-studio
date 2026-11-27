"""Make reviewable image comparisons and a standalone local HTML experiment report."""
import argparse
import html
import json
import statistics
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--root', type=Path, required=True)
args = parser.parse_args()
out, root = args.out.resolve(), args.root.resolve()
report = json.loads((out / 'browser-report.json').read_text(encoding='utf-8'))
cpu = json.loads((out / 'model-cpu-report.json').read_text(encoding='utf-8'))
renders = out / 'renders'
thumb_w, thumb_h, label_h = 260, 220, 28


def sheet(rows, target):
    canvas = Image.new('RGB', (thumb_w * len(rows[0]), (thumb_h + label_h) * len(rows)), '#24272b')
    draw = ImageDraw.Draw(canvas)
    for y, row in enumerate(rows):
        for x, (label, file) in enumerate(row):
            image = Image.open(file).convert('RGB')
            image.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            draw.text((x * thumb_w + 8, y * (thumb_h + label_h) + 6), label, fill='white')
            canvas.paste(image, (x * thumb_w + (thumb_w - image.width) // 2, y * (thumb_h + label_h) + label_h))
    canvas.save(out / target)


sheet([[(f'{id}: {method}', renders / f'synthetic-{id}-{method}.png') for method in ['source', 'expected', 'webgpu', 'soft-full']]
       for id in report['manifest']['syntheticScenes']], 'synthetic-comparison.png')
sheet([[(f'{id}: {method}', renders / f'real-{id}-{method}.png') for method in ['source', 'webgpu', 'soft-full', 'alpha']]
       for id in ['portrait-hair', 'anime-hair', 'diorama', 'street-text']], 'real-comparison.png')
depth_rows = []
for id in ['portrait-hair', 'anime-hair', 'diorama', 'street-text']:
    fixture = next(f for f in report['manifest']['realScenes'] if f['id'] == id)
    depth_rows.append([(id, root / fixture['file']), ('DA3', out / f'references/{id}-da3-depth.png'),
                       ('ZipDepth FP32', out / f'references/{id}-zip-fp32-depth.png'), ('ZipDepth FP16', out / f'references/{id}-zip-fp16-depth.png')])
sheet(depth_rows, 'depth-comparison.png')
if report.get('depthRendererComparison'):
    sheet([[(f'{id}: {label}', file) for label, file in [
        ('source', renders / f'real-{id}-source.png'),
        ('DA3 / current renderer', renders / f'model-parallax-{id}-da3.png'),
        ('ZipDepth / current renderer', renders / f'model-parallax-{id}-zip-fp32.png'),
        ('DA3 / soft LDI', renders / f'real-{id}-soft-full.png'),
    ]] for id in ['portrait-hair', 'anime-hair', 'diorama', 'street-text']], 'model-renderer-comparison.png')
summary = {'models': [], 'synthetic': [], 'realCount': len(report['real']), 'errors': report['errors']}
for model in report['modelChecks']:
    samples = model.get('samples', [])
    summary['models'].append({
        'model': model['id'], 'ep': model['ep'], 'pass': model['pass'],
        'warmMedianMs': statistics.median([t for s in samples for t in s['times'][1:]]) if samples else None,
        'maxRelativeMae': max([s['relativeMae'] for s in samples], default=None), 'error': model.get('error'),
    })
for scene in report['synthetic']:
    methods = []
    for name in ['webgpu', 'webgl', 'soft-only', 'soft-recover', 'soft-fill-only', 'soft-full', 'oracle-alpha']:
        rows = [row for row in scene['rows'] if row['name'] == name]
        if not rows:
            continue
        methods.append({'name': name, 'mae': statistics.mean(row['mae'] for row in rows),
                        'edgeMae': statistics.mean(row['edgeMae'] for row in rows if row['edgeMae'] is not None),
                        'exposedMae': statistics.mean(row['exposedMae'] for row in rows if row['exposedMae'] is not None)})
    summary['synthetic'].append({'id': scene['id'], 'methods': methods, 'alphaMae': scene['alphaMae']})
fp16_deltas = []
for fixture in report['manifest']['realScenes']:
    fp32 = np.fromfile(out / f'references/{fixture["id"]}-zip-fp32-raw.f32', np.float32)
    fp16 = np.fromfile(out / f'references/{fixture["id"]}-zip-fp16-raw.f32', np.float32)
    error = np.abs(fp32 - fp16)
    fp16_deltas.append({'id': fixture['id'], 'mae': float(error.mean()), 'relativeMae': float(error.mean() / fp32.std())})
summary['cpuFp16VsFp32'] = fp16_deltas
(out / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')

parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>工坊空间算法实验</title>',
         '<style>body{font:16px/1.7 system-ui;margin:36px auto;max-width:1440px;padding:0 24px;background:#151719;color:#eee}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{padding:8px 16px;border:1px solid #555;text-align:left}a{color:#b2d5ff}details{margin:24px 0}summary{cursor:pointer}code{word-break:break-all}</style>',
         '<h1>空间算法实验 · E0 / E1 / E2</h1>',
         '<p>16 张固定真实图、4 类解析场景 × 8 方向。实验保留失败样例；尚未替换客户端默认算法。真实图无目标视角真值，不能据此计算画质排名。基线副本与输入 SHA-256 见 manifest.json。</p>',
         '<p>本轮真实图渲染使用固定 Python CPU 深度参考，图片经等比补边处理；与客户端原有预处理和 WASM 输出并不完全相同。DA3 INT8 发现跨运行时数值差异，尚未定位原因。以下为受控算法对照，不代表客户端完整体验基准。</p>',
         '<h2>端侧模型数值检查</h2><p>门槛：相对 CPU 原始输出的 MAE / CPU 标准差 &lt; 1%。FP16 与自己的 CPU 输出比较，另记 CPU FP16 对 FP32 差异。速度为固定四图的前向暖机，包含输出回读，不含下载和预处理。</p>',
         '<table><tr><th>模型</th><th>EP</th><th>数值检查</th><th>暖机中位数 ms</th><th>最大相对 MAE</th></tr>']
for model in summary['models']:
    parts.append(f'<tr><td>{model["model"]}</td><td>{model["ep"]}</td><td>{model["pass"]}</td><td>{model["warmMedianMs"]}</td><td>{model["maxRelativeMae"]}</td></tr>')
parts += ['</table><h2>深度对照</h2><img src="depth-comparison.png" alt="原图与深度模型对照">',
          '<h2>固定渲染器、替换深度模型</h2><img src="model-renderer-comparison.png" alt="同渲染器模型对照">',
          '<h2>解析场景</h2><p>列：原图 / 独立解析目标视角 / 现行 WebGPU / 软分层原型。二维补洞无法恢复未知的棋盘纹理；双层聚类也不等于完整多层几何。</p><img src="synthetic-comparison.png" alt="合成真值对照">',
          '<table><tr><th>场景</th><th>方案</th><th>全图 MAE</th><th>轮廓 MAE</th><th>露底 MAE</th></tr>']
for scene in summary['synthetic']:
    for method in scene['methods']:
        parts.append(f'<tr><td>{scene["id"]}</td><td>{method["name"]}</td><td>{method["mae"]:.3f}</td><td>{method["edgeMae"]:.3f}</td><td>{method["exposedMae"]:.3f}</td></tr>')
parts += ['</table><h2>真实图典型样例</h2><p>列：原图 / 现行 WebGPU / 软分层 / 估计 Alpha。两层假设与低频补全对复杂场景可能失效。</p><img src="real-comparison.png" alt="真实样例对照">']
for fixture in report['manifest']['realScenes']:
    id = fixture['id']
    parts.append(f'<details><summary>{html.escape(id)}</summary>')
    for method in ['source', 'webgpu', 'webgl', 'soft-full', 'alpha']:
        parts.append(f'<p>{method}</p><img loading="lazy" src="renders/real-{id}-{method}.png" alt="{id} {method}">')
    parts.append('</details>')
parts.append('<p><a href="manifest.json">固定基线</a> · <a href="browser-report.json">浏览器原始报告</a> · <a href="model-cpu-report.json">CPU 原始报告</a> · <a href="summary.json">统计摘要</a></p></html>')
(out / 'index.html').write_text('\n'.join(parts), encoding='utf-8')
print(json.dumps(summary, indent=2), flush=True)
