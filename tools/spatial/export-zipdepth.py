"""Export the unmodified fused forward graph, retaining learned global attention."""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
out = args.out.resolve()
source = out / 'zipdepth-source'
checkpoint = source / 'checkpoints/zipdepth_base_npu.pth'
expected_checkpoint = '627c04fda584133ead4310074884a4a037061b4c01ba86e73e492ea30fab570d'
if hashlib.sha256(checkpoint.read_bytes()).hexdigest() != expected_checkpoint:
    raise RuntimeError('Checkpoint SHA-256 does not match the frozen experiment')
sys.path.insert(0, str(source))
spec = importlib.util.spec_from_file_location('zip_export', source / 'scripts/export.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
torch.set_num_threads(8)
torch.manual_seed(20261127)
model = module.load_model(str(checkpoint), 'base', 'balanced', 'cpu', upsample_unfold=False)
tensor = torch.rand(1, 3, 384, 384)
target = out / 'zipdepth-384-fp32.onnx'
# The upstream export helper replaces learned context weighting with global average pooling.
# Bypass that helper; static input sizes let the legacy exporter lower pooling unchanged.
with torch.no_grad():
    expected = model(tensor).numpy()
    torch.onnx.export(model, tensor, str(target), input_names=['image'], output_names=['depth'],
                      opset_version=17, do_constant_folding=True, dynamo=False)
onnx.checker.check_model(onnx.load(target))
session = ort.InferenceSession(str(target), providers=['CPUExecutionProvider'])
actual = session.run(None, {'image': tensor.numpy()})[0]
error = np.abs(actual - expected)
report = {
    'sourceRevision': '91f3fd21e131641f51e8d35736d1958350180e3a',
    'checkpointSha256': hashlib.sha256((source / 'checkpoints/zipdepth_base_npu.pth').read_bytes()).hexdigest(),
    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size,
    'randomInputMae': float(error.mean()), 'randomInputMaxError': float(error.max()),
    'randomInputRelativeMae': float(error.mean() / max(1e-8, expected.std())),
    'forwardGraph': 'Unmodified fused PyTorch forward; not upstream export helper approximations',
}
if report['randomInputRelativeMae'] >= 0.001:
    raise RuntimeError(f'Export mismatch: {report}')
(out / 'zipdepth-export-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)
