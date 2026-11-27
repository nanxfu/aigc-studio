"""Reproduce CPU references for the fixed corpus. Keeps optional Python dependencies isolated."""
import argparse
import hashlib
import importlib.util
import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image, ImageOps


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(image, width, height, normalize):
    iw, ih = image.size
    scale = min(width / iw, height / ih)
    nw, nh = max(1, round(iw * scale)), max(1, round(ih * scale))
    left, top = (width - nw) // 2, (height - nh) // 2
    rgb = np.asarray(image.resize((nw, nh), Image.Resampling.BILINEAR))
    rgb = np.pad(rgb, ((top, height - nh - top), (left, width - nw - left), (0, 0)), mode='edge')
    tensor = rgb.astype(np.float32) / 255
    if normalize:
        tensor = (tensor - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    return np.ascontiguousarray(tensor.transpose(2, 0, 1)[None]), (left, top, nw, nh)


def normalized_depth(raw, box, near_large):
    left, top, width, height = box
    cropped = raw.squeeze()[top:top + height, left:left + width]
    values = np.sort(cropped[np.isfinite(cropped)])
    low = values[int((len(values) - 1) * 0.02)]
    high = values[int((len(values) - 1) * 0.98)]
    normalized = np.clip((cropped - low) / max(1e-8, high - low), 0, 1)
    if near_large:
        normalized = 1 - normalized
    return normalized.astype(np.float32)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    out, root = args.out.resolve(), args.root.resolve()
    manifest = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    if sha256(root / '.tmp/m4e-da3-small.onnx') != '9194a0d5602d71e6407aabeb50ebe5bde9fb25d0c35514b7ef868219034e14d7':
        raise RuntimeError('DA3 SHA-256 mismatch')
    export_report = json.loads((out / 'zipdepth-export-report.json').read_text(encoding='utf-8'))
    if sha256(out / 'zipdepth-384-fp32.onnx') != export_report['sha256']:
        raise RuntimeError('ZipDepth differs from validated export')
    for fixture in manifest['realScenes']:
        if sha256(root / fixture['file']) != fixture['sha256']:
            raise RuntimeError(f'Fixture changed: {fixture["id"]}')
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 8
    opts.inter_op_num_threads = 1
    specs = [
        ('da3', root / '.tmp/m4e-da3-small.onnx', 504, 378, True, False),
        ('zip-fp32', out / 'zipdepth-384-fp32.onnx', 384, 384, False, True),
    ]
    # Export an additional fp16 variant without changing application dependencies.
    from onnxruntime.transformers.float16 import convert_float_to_float16
    import onnx
    fp16_path = out / 'zipdepth-384-fp16.onnx'
    fp16 = convert_float_to_float16(onnx.load(out / 'zipdepth-384-fp32.onnx'), keep_io_types=True)
    onnx.save(fp16, fp16_path)
    specs.append(('zip-fp16', fp16_path, 384, 384, False, True))
    references = out / 'references'
    references.mkdir(exist_ok=True)
    report = {'runtime': ort.__version__, 'torch': torch.__version__, 'cpuThreads': 8, 'models': [], 'samples': []}
    for model_id, path, width, height, normalize, near_large in specs:
        started = time.perf_counter()
        session = ort.InferenceSession(str(path), opts, providers=['CPUExecutionProvider'])
        metadata = {
            'id': model_id, 'file': str(path.relative_to(root)), 'bytes': path.stat().st_size,
            'sha256': sha256(path), 'sessionMs': (time.perf_counter() - started) * 1000,
            'inputName': session.get_inputs()[0].name, 'outputName': session.get_outputs()[0].name,
            'inputShape': session.get_inputs()[0].shape, 'outputShape': session.get_outputs()[0].shape,
        }
        report['models'].append(metadata)
        for fixture in manifest['realScenes']:
            image = ImageOps.exif_transpose(Image.open(root / fixture['file'])).convert('RGB')
            tensor, box = prepare(image, width, height, normalize)
            times = []
            for _ in range(3):
                started = time.perf_counter()
                raw = session.run(None, {session.get_inputs()[0].name: tensor})[0]
                times.append((time.perf_counter() - started) * 1000)
            if not np.isfinite(raw).all():
                raise RuntimeError(f'{model_id}/{fixture["id"]}: nonfinite output')
            name = f'{fixture["id"]}-{model_id}'
            tensor.tofile(references / f'{name}-input.f32')
            raw.astype(np.float32).tofile(references / f'{name}-raw.f32')
            depth = normalized_depth(raw, box, near_large)
            scale = min(1, 512 / max(image.size))
            preview_size = (round(image.width * scale), round(image.height * scale))
            depth_image = Image.fromarray(depth).resize(preview_size, Image.Resampling.BILINEAR)
            resized = np.asarray(depth_image, dtype=np.float32)
            resized.tofile(references / f'{name}-depth.f32')
            Image.fromarray(np.round((1 - resized) * 255).astype(np.uint8)).save(references / f'{name}-depth.png')
            entry = {
                'id': fixture['id'], 'model': model_id, 'firstMs': times[0], 'warmMs': times[1:],
                'warmMedianMs': statistics.median(times[1:]), 'rawShape': list(raw.shape),
                'rawMin': float(raw.min()), 'rawMax': float(raw.max()), 'rawStd': float(raw.std()),
                'depthWidth': preview_size[0], 'depthHeight': preview_size[1], 'contentBox': box,
            }
            report['samples'].append(entry)
        print(json.dumps({'model': model_id, 'warmMedianMs': statistics.median(row['warmMedianMs'] for row in report['samples'] if row['model'] == model_id), 'bytes': path.stat().st_size}), flush=True)
        (out / 'model-cpu-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    # Compare exported ONNX with the fused PyTorch model on the same real input.
    source = out / 'zipdepth-source'
    sys.path.insert(0, str(source))
    loader_spec = importlib.util.spec_from_file_location('zip_export', source / 'scripts/export.py')
    module = importlib.util.module_from_spec(loader_spec)
    loader_spec.loader.exec_module(module)
    model = module.load_model(str(source / 'checkpoints/zipdepth_base_npu.pth'), 'base', 'balanced', 'cpu', upsample_unfold=False)
    torch.set_num_threads(8)
    deltas = []
    for fixture in manifest['realScenes'][:4]:
        name = f'{fixture["id"]}-zip-fp32'
        tensor = np.fromfile(references / f'{name}-input.f32', dtype=np.float32).reshape(1, 3, 384, 384)
        reference = np.fromfile(references / f'{name}-raw.f32', dtype=np.float32).reshape(1, 1, 384, 384)
        with torch.no_grad():
            result = model(torch.from_numpy(tensor)).numpy()
        error = np.abs(result - reference)
        deltas.append({'id': fixture['id'], 'mae': float(error.mean()), 'max': float(error.max()), 'relativeMae': float(error.mean() / max(1e-8, np.std(reference)))})
    report['pytorchVsOnnx'] = deltas
    (out / 'model-cpu-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    if any(row['relativeMae'] >= 0.001 for row in deltas):
        raise RuntimeError(f'PyTorch/ONNX mismatch on real samples: {deltas}')
    print(json.dumps({'pytorchVsOnnx': deltas}), flush=True)


if __name__ == '__main__':
    main()
