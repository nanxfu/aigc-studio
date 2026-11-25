"""Measure the rendered audio, rather than infer alignment from source files."""
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy.signal import correlate

ROOT = Path(__file__).resolve().parents[1]
RATE = 48000
FPS = 30


def decode(file):
    data = subprocess.check_output([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(file),
        '-vn', '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'
    ])
    return np.frombuffer(data, dtype='<f4').astype(np.float64)


def locate(output, sample, expected):
    start = max(0, round((expected - .12) * RATE))
    end = min(len(output), round((expected + .12) * RATE) + len(sample))
    region = output[start:end]
    values = correlate(region, sample, mode='valid', method='fft')
    index = int(np.argmax(values))
    found = (start + index) / RATE
    segment = region[index:index + len(sample)]
    coefficient = float(np.dot(segment, sample) / max(1e-12, np.linalg.norm(segment) * np.linalg.norm(sample)))
    return found, coefficient


music = json.loads((ROOT / 'src/music.json').read_text())
chapter_beats = music['cutBeats']
chapter_cuts = dict(zip(chapter_beats, [round(t * FPS) for t in music['cutTimes']]))
with_music = decode(ROOT / 'out/aigc-studio-launch.mp4')
without_music = decode(ROOT / 'out/aigc-studio-launch-nobgm.mp4')
assert len(with_music) == len(without_music)

probes = []
for name, beat, offset, peak, file, duration in [
    ('create-pop', 12, 74, .125, 'fs-579883.mp3', 24),
    ('assistant-flip', 22, 66, .115, 'fs-730078.mp3', 24),
    ('pbr-lock', 42, 96, .125, 'fs-579883.mp3', 24),
    ('brand-lock', 84, 58, .125, 'fs-579883.mp3', 27),
]:
    frame = round(chapter_cuts[beat] + offset - peak * FPS)
    sample = decode(ROOT / 'public/audio/sfx' / file)[:round(duration / FPS * RATE)]
    found, coefficient = locate(without_music, sample, frame / FPS)
    probes.append({
        'id': name, 'file': file, 'sequenceFrame': frame,
        'foundStartSeconds': found, 'delaySamples': round((found - frame / FPS) * RATE),
        'delayFrames': (found - frame / FPS) * FPS, 'correlation': coefficient,
        'peakTargetFrame': chapter_cuts[beat] + offset,
        'peakResidualFrames': (found + peak) * FPS - (chapter_cuts[beat] + offset),
    })

bed = decode(ROOT / 'public/audio/music-bed-45s.wav')
music_only = with_music - without_music
found, coefficient = locate(music_only, bed[5 * RATE:10 * RATE], 5)
delay = found - 5
cut_checks = [{'beat': beat, 'cutFrame': frame, 'source': 'current 92-beat timeline'} for beat, frame in chapter_cuts.items()]

report = {
    'measuredOn': '2026-11-25',
    'pipeline': {'remotion': '4.0.546', 'codec': 'aac', 'sampleRate': RATE, 'container': 'mp4', 'fps': FPS},
    'method': 'FFT cross-correlation of decoded mono audio against fixed source files; SFX probes in no-BGM render; BGM isolated by subtracting two decoded tracks.',
    'probes': probes,
    'outputDelayFramesMedian': float(np.median([p['delayFrames'] for p in probes])),
    'bgm': {'file': 'music-bed-45s.wav', 'delaySamples': round(delay * RATE), 'delayFrames': delay * FPS, 'correlation': coefficient},
    'cutChecks': cut_checks,
    'rmsDbfs': {
        'withBgm': float(20 * np.log10(np.sqrt(np.mean(with_music ** 2)))),
        'withoutBgm': float(20 * np.log10(np.sqrt(np.mean(without_music ** 2)))),
    },
    'monoSamplePeakDbfs': float(20 * np.log10(np.max(np.abs(with_music)))),
    'audioTracksDiffer': bool(np.max(np.abs(music_only)) > .001),
    'limits': 'Signal measurements do not verify subjective timbre, masking, or musical suitability.',
}
(ROOT / 'out/qa/audio-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(report, ensure_ascii=False, indent=2))
assert all(abs(p['delayFrames']) < .5 for p in probes), 'Output pipeline offset exceeds 0.5 frame'
assert abs(delay * FPS) <= 3, 'BGM output delay exceeds 3 frames'
