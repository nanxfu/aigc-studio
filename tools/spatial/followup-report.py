import argparse
import html
import json
import statistics
from pathlib import Path

from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
out = args.out.resolve()
report = json.loads((out / 'report.json').read_text(encoding='utf-8'))
assert len(report['models']) == 16 and len(report['real']) == 16 and len(report['synthetic']) == 4
assert report['errors'] == []


def sheet(rows, name):
    width, height, title = 248, 220, 28
    canvas = Image.new('RGB', (len(rows[0]) * width, len(rows) * (height + title)), '#24272b')
    draw = ImageDraw.Draw(canvas)
    for y, row in enumerate(rows):
        for x, (label, file) in enumerate(row):
            image = Image.open(out / 'renders' / file).convert('RGB')
            image.thumbnail((width, height), Image.Resampling.LANCZOS)
            draw.text((x * width + 5, y * (height + title) + 5), label, fill='white')
            canvas.paste(image, (x * width + (width - image.width) // 2, y * (height + title) + title))
    canvas.save(out / name)


sheet([[(f'{scene["id"]}: {name}', f'synthetic-{scene["id"]}-{name}.png') for name in ['target', 'baseline', 'soft-old', 'adaptive-patch']]
       for scene in report['synthetic']], 'synthetic-comparison.png')
sheet([[(f'{id}: {name}', f'real-{id}-{name}.png') for name in ['source', 'da3-baseline', 'zip-baseline', 'adaptive']]
       for id in ['portrait-hair', 'anime-hair', 'diorama', 'street-text']], 'real-comparison.png')
summary = {
    'models': {key: statistics.median(row[key] for row in report['models'][1:]) for key in ['da3TotalMs', 'zipInputMs', 'zipInferMs', 'zipTotalMs']},
    'first': report['models'][0],
    'synthetic': [],
    'realPrepareMedianMs': statistics.median(row['timings'][0]['prepareMs'] for row in report['real']),
    'realRenderMedianMs': statistics.median(row['timings'][0]['renderMs'] for row in report['real']),
}
worker_path = out / 'worker-report.json'
if worker_path.exists():
    worker = json.loads(worker_path.read_text(encoding='utf-8'))
    assert len(worker['rows']) == 32
    assert all(row['finite'] and row['directVsWorkerNormalizedMae'] < 1e-6 for row in worker['rows'])
    summary['worker'] = {model: {
        'totalMedianMs': statistics.median(row['totalMs'] for row in worker['rows'] if row['modelId'] == model and row['id'] != 'portrait-hair'),
        'roundTripMedianMs': statistics.median(row['workerRoundTripMs'] for row in worker['rows'] if row['modelId'] == model and row['id'] != 'portrait-hair'),
    } for model in ['da3', 'zip']}
for scene in report['synthetic']:
    result = {'id': scene['id'], 'methods': []}
    for name in ['baseline', 'soft-old', 'adaptive-pull', 'adaptive-patch']:
        rows = [row for row in scene['rows'] if row['name'] == name]
        assert len(rows) == 8
        result['methods'].append({'name': name, **{metric: statistics.mean(row[metric] for row in rows) for metric in ['mae', 'edgeMae', 'exposedMae']}})
    summary['synthetic'].append(result)
(out / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>空间算法第二轮</title>',
         '<style>body{font:16px/1.7 system-ui;background:#17191b;color:#eee;margin:32px auto;max-width:1380px;padding:0 24px}img{max-width:100%;height:auto}table{border-collapse:collapse}th,td{border:1px solid #555;padding:8px 16px}a{color:#a5caff}summary{cursor:pointer}</style>',
         '<h1>空间算法第二轮 · 2026-11-28</h1>',
         '<p>16 张真实图调用实际 runLocalDepth 预处理与 WASM 推理；ZipDepth 复用同一缩放、补边、裁切与归一化函数。模型从本地注入，计时不含下载、图像解码，候选尚未注册为产品模型。</p>',
         '<p>第二版使用深度聚类、局部边缘归属、后层遮挡扩展与样例块补洞；尚未实现完整对象分割和全局几何一致性。存在失败场景，不替换默认视差。</p>',
         '<h2>实际客户端预处理</h2><pre>' + html.escape(json.dumps(summary['models'], indent=2)) + '</pre>',
         '<p>上表为首张后 15 图的中位数；第一张单列原始报告。DA3 在本轮实际客户端路径，ZipDepth 用主线程实验 Session；此结果不是最终 Worker 端到端性能。</p>',
         '<h2>现有推理 Worker 复测</h2><p>直接复用未改动的 localInference.worker.js；两模型 16 图与直接调用输出逐值一致。包含预处理、Worker 往返与归一化，不含下载、解码和渲染。</p><pre>' + html.escape(json.dumps(summary.get('worker', {}), indent=2)) + '</pre>',
         '<h2>解析场景同位移对照</h2><img src="synthetic-comparison.png" alt="目标视角、原管线、旧软分层、样例补洞新原型">',
         '<table><tr><th>场景</th><th>方案</th><th>全图 MAE</th><th>轮廓 MAE</th><th>露底 MAE</th></tr>']
for scene in summary['synthetic']:
    for method in scene['methods']:
        parts.append(f'<tr><td>{scene["id"]}</td><td>{method["name"]}</td><td>{method["mae"]:.3f}</td><td>{method["edgeMae"]:.3f}</td><td>{method["exposedMae"]:.3f}</td></tr>')
parts += ['</table><h2>真实样图</h2><p>原图 / 实际 DA3 + 原渲染器 / 同预处理 ZipDepth + 原渲染器 / DA3 + 新原型。真实图无新视角真值。</p><img src="real-comparison.png" alt="真实样图四列比较">']
for scene in report['real']:
    id = scene['id']
    parts.append(f'<details><summary>{html.escape(id)}</summary>')
    for name in ['source', 'da3-baseline', 'zip-baseline', 'adaptive']:
        parts.append(f'<p>{name}</p><img loading="lazy" src="renders/real-{id}-{name}.png" alt="{id} {name}">')
    parts.append('</details>')
parts += ['<p><a href="report.json">原始报告</a> · <a href="summary.json">统计摘要</a></p></html>']
(out / 'index.html').write_text('\n'.join(parts), encoding='utf-8')
print(json.dumps(summary, indent=2))
