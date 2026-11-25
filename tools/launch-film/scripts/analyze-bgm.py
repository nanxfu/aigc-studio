import librosa, numpy as np, json

results = {}
for f in ['house-vibez.mp3', 'bgm-tech-house.mp3', 'cat-walk.mp3']:
    path = f'public/audio/{f}'
    y, sr = librosa.load(path, sr=22050, mono=True, duration=80)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, onset_envelope=onset_env)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    peak_energy = float(np.percentile(onset_env, 95))
    avg_energy = float(np.mean(onset_env))
    ratio = peak_energy / avg_energy if avg_energy > 0 else 0
    results[f] = dict(
        tempo=float(tempo), duration=len(y)/sr, beat_count=len(beats),
        onset_count=len(onset_frames), peak_energy=peak_energy, avg_energy=avg_energy,
        energy_ratio=ratio, first_10_onsets=onset_times[:10].tolist()
    )
    print(f"{f}: BPM={float(tempo):.1f}, onsets={len(onset_frames)}, peak/avg={ratio:.2f}")

print(json.dumps(results, indent=2))
