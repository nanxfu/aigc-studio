"""Check whether CPU graph optimization explains observed DA3 INT8 cross-EP deviation."""
import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
results = []
for name, level in [('disabled', ort.GraphOptimizationLevel.ORT_DISABLE_ALL), ('all', ort.GraphOptimizationLevel.ORT_ENABLE_ALL)]:
    opts = ort.SessionOptions()
    opts.graph_optimization_level = level
    opts.intra_op_num_threads = 8
    session = ort.InferenceSession(str(args.root / '.tmp/m4e-da3-small.onnx'), opts, providers=['CPUExecutionProvider'])
    for id in ['portrait-hair', 'anime-hair', 'diorama', 'street-text']:
        base = args.out / f'references/{id}-da3'
        tensor = np.fromfile(str(base) + '-input.f32', np.float32).reshape(1, 3, 378, 504)
        python = np.fromfile(str(base) + '-raw.f32', np.float32)
        wasm = np.fromfile(str(base) + '-wasm.f32', np.float32)
        actual = session.run(None, {'image': tensor})[0].reshape(-1)
        row = {'id': id, 'optimization': name, 'cpuVersion': ort.__version__, 'cpuVsWasmRelativeMae': float(np.abs(actual - wasm).mean() / wasm.std()),
               'cpuVsOriginalCpuRelativeMae': float(np.abs(actual - python).mean() / python.std())}
        results.append(row)
(args.out / f'da3-audit-{ort.__version__}.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results, indent=2), flush=True)
