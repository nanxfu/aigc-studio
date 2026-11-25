import librosa, numpy as np, json

y, sr = librosa.load("public/audio/bgm-tech-house.mp3", sr=22050, mono=True)
total_dur = len(y) / sr
print(f"Total duration: {total_dur:.1f}s")

# Beat tracking
tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
beat_times = librosa.frames_to_time(beats, sr=sr)
T = 60.0 / float(tempo)
print(f"BPM: {float(tempo):.2f}, T={T:.6f}s, beats={len(beats)}")

# Find best 59s segment - look for high energy region starting around 8-15s
hop = 512
n_frames = len(y) // hop
energy = np.array([np.sum(y[i*hop:(i+1)*hop]**2) for i in range(n_frames-1)])
energy_times = np.arange(len(energy)) * hop / sr

# Sliding window energy for 59s segments
window = int(59 * sr / hop)
best_start = 0
best_energy = 0
for start_frame in range(int(5*sr/hop), int((total_dur-60)*sr/hop), int(0.5*sr/hop)):
    end_frame = start_frame + window
    if end_frame >= len(energy): break
    e = np.mean(energy[start_frame:end_frame])
    if e > best_energy:
        best_energy = e
        best_start = start_frame

best_start_sec = best_start * hop / sr
print(f"Best 59s segment starts at {best_start_sec:.3f}s (energy={best_energy:.4f})")

# Get beat times relative to best start
cut_beats = [0, 12, 28, 44, 60, 76, 92, 108, 120]
beat_indices = []
for cb in cut_beats:
    target_time = best_start_sec + cb * T
    # Find closest actual beat
    idx = np.argmin(np.abs(beat_times - target_time))
    beat_indices.append(float(beat_times[idx]))

cut_times = [t - best_start_sec for t in beat_indices]
# Adjust to make first cut at 0
cut_times = [t - cut_times[0] for t in cut_times]

# Also get onset peaks for SFX alignment
onset_env = librosa.onset.onset_strength(y=y, sr=sr)
onset_frames = librosa.onset.onset_detect(y=y, sr=sr, onset_envelope=onset_env)
onset_times = librosa.frames_to_time(onset_frames, sr=sr)

# Find strong onsets in our segment for cut points
seg_onsets = []
for ot in onset_times:
    if best_start_sec <= ot <= best_start_sec + 60:
        seg_onsets.append(float(ot - best_start_sec))

print(f"Onsets in segment: {len(seg_onsets)}")
print(f"Cut times: {cut_times}")

result = {
    "T": float(T),
    "sourceStart": float(best_start_sec),
    "totalFrames": int(59 * 30),
    "cutBeats": cut_beats,
    "cutTimes": [float(t) for t in cut_times],
    "bpm": float(tempo),
    "onsetsInSegment": len(seg_onsets),
    "first_20_seg_onsets": seg_onsets[:20]
}
print(json.dumps(result, indent=2))

with open("src/music-new.json", "w") as f:
    json.dump(result, f, indent=2)
