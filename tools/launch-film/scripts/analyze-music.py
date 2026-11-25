import json
from pathlib import Path
import numpy as np
import librosa
from scipy.signal import butter, sosfilt, find_peaks

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'analysis'
OUT.mkdir(exist_ok=True)
y, sr = librosa.load(ROOT/'public/audio/house-vibez.mp3', sr=22050, duration=90)
hop = 128
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop, tightness=400, units='time')
T, t0 = np.polyfit(np.arange(len(beats)), beats, 1)
hits = []
envs = {}
for kind, low, high in [('kick',40,160),('snare',150,3000),('hihat',6000,10000)]:
    filtered = sosfilt(butter(4,[low,high],btype='band',fs=sr,output='sos'),y)
    env = librosa.onset.onset_strength(y=filtered,sr=sr,hop_length=hop)
    times = librosa.times_like(env,sr=sr,hop_length=hop)
    peaks, _ = find_peaks(env, distance=int(.16*sr/hop), prominence=max(.1,np.max(env)*.08))
    envs[kind] = (env,times)
    hits += [{'t':float(times[p]),'s':float(env[p]),'k':kind} for p in peaks]
# Refine period and phase against low-band attacks. Use local waveform envelope
# peaks, because onset_strength includes analysis latency.
band = sosfilt(butter(4,[40,160],btype='band',fs=sr,output='sos'),y)
win = int(sr*.005)
energy = np.sqrt(np.convolve(band**2,np.ones(win)/win,mode='same'))
indices, _ = find_peaks(energy,distance=int(sr*.30),prominence=np.max(energy)*.10)
attacks = indices/sr
candidates=[]
for multiplier in [.5,1,2]:
    period=T*multiplier
    for phase in [t0 % period]:
        grid=phase+np.arange(int((80-phase)/period))*period
        near=np.array([attacks[np.argmin(abs(attacks-v))] for v in grid])
        mask=abs(near-grid)<.12
        slope, intercept=np.polyfit(np.arange(len(grid))[mask],near[mask],1)
        refined=intercept+np.arange(len(grid))*slope
        error=near-refined
        candidates.append({'multiplier':multiplier,'T':float(slope),'t0':float(intercept),'match_50ms':float(np.mean(abs(error)<.05)),'mean_abs_ms':float(np.mean(abs(error[abs(error)<.05]))*1000),'drift_ms':float(np.polyfit(np.arange(len(error))[mask],error[mask],1)[0]*len(error)*1000),'residual_max_ms':float(np.max(abs(error[mask]))*1000)})
winner=next(c for c in candidates if c['multiplier']==1)
T=winner['T']; phase=winner['t0']
# Start at a stable full-bar area, not a thin intro. Four-bar boundary from source.
first=phase+16*T
grid=[first+n*T for n in range(121)]
# The track has offbeat/syncopated passages. Keep the actual onset evidence and
# pin section changes to measured attacks rather than pretending all beats are
# strictly quantized. Inspect within 100ms; otherwise retain the grid and flag it.
onsets=np.array(sorted(h['t'] for h in hits))
cut_beats=[0,12,28,44,60,76,92,108,120]
cut_times=[]
cut_errors=[]
for n in cut_beats:
    target=first+n*T
    nearest=float(onsets[np.argmin(abs(onsets-target))])
    delta=nearest-target
    cut_times.append(nearest-first if abs(delta)<.1 else n*T)
    cut_errors.append({'beat':n,'grid':target,'nearest_attack':nearest,'delta_ms':delta*1000})
cut_times[0]=0.0
data={'bpm':60/T,'T':T,'t0':phase,'sourceStart':first,'sourceBeat0':0.0,'beats':grid,'hits':sorted(hits,key=lambda h:h['t']),'rms':[float(v) for v in librosa.feature.rms(y=y,hop_length=2048)[0]],'sections':[{'outputBeats':[0,12],'role':'single hero'},{'outputBeats':[12,108],'role':'feature journey'},{'outputBeats':[108,120],'role':'brand hold'}],'notes':'Grid fitted against measured kick energy; output music is trimmed to sourceStart. Mean error is measured, not an audition statement.'}
(OUT/'beat-data.json').write_text(json.dumps(data,indent=2),encoding='utf8')
(OUT/'grid-drift.json').write_text(json.dumps({'candidates':candidates,'winner':winner,'threshold':'Report actual residuals; no fabricated pass.'},indent=2),encoding='utf8')
(ROOT/'src/music.json').write_text(json.dumps({'T':T,'sourceStart':first,'totalFrames':round(cut_times[-1]*30),'cutBeats':cut_beats,'cutTimes':cut_times},indent=2),encoding='utf8')
(OUT/'cut-attack-evidence.json').write_text(json.dumps(cut_errors,indent=2),encoding='utf8')
print(json.dumps({'bpm':60/T,'sourceStart':first,'duration':120*T,'winner':winner},indent=2))
