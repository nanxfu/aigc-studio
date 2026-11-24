"""Synthesize a crisp 120 BPM electronic beat + synced risers/clicks/drops (18.0s) for PromoZh."""
import os
import subprocess
import wave
import numpy as np

SR = 44100
BPM = 120.0
BEAT_SEC = 60.0 / BPM  # 0.5s exact = 15 frames @ 30fps
TOTAL_SEC = 18.0
N_SAMPLES = int(SR * TOTAL_SEC)

rng = np.random.default_rng(42)


def soft_clip(x: np.ndarray, drive: float = 1.6) -> np.ndarray:
    return np.tanh(x * drive) / np.tanh(drive)


def synth_kick(length_sec: float = 0.28) -> np.ndarray:
    n = int(SR * length_sec)
    t = np.arange(n) / SR
    # Pitch drop 160Hz -> 44Hz
    freq = 44.0 + 120.0 * np.exp(-t * 38.0)
    phase = 2.0 * np.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * np.exp(-t * 11.0)
    click = np.sin(2.0 * np.pi * 1600.0 * t) * np.exp(-t * 140.0) * 0.35
    return soft_clip(body + click, 1.8) * 0.92


def synth_snare_clap(length_sec: float = 0.22) -> np.ndarray:
    n = int(SR * length_sec)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    # Simple bandpass-ish shaping via difference + moving average
    hp = np.diff(noise, prepend=0)
    env = np.exp(-t * 22.0) + 0.45 * np.exp(-np.maximum(0, t - 0.012) * 30.0)
    tone = np.sin(2.0 * np.pi * 190.0 * t) * np.exp(-t * 28.0) * 0.35
    return soft_clip(hp * env * 0.55 + tone, 1.4) * 0.65


def synth_hihat(open_hat: bool = False) -> np.ndarray:
    length_sec = 0.22 if open_hat else 0.065
    n = int(SR * length_sec)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    # High-pass emphasize metallic sizzle
    hp = np.diff(np.diff(noise, prepend=0), prepend=0)
    hp = hp / (np.max(np.abs(hp)) + 1e-6)
    decay = 14.0 if open_hat else 68.0
    return hp * np.exp(-t * decay) * (0.24 if open_hat else 0.16)


def synth_bass_note(freq: float, dur_sec: float) -> np.ndarray:
    n = int(SR * dur_sec)
    t = np.arange(n) / SR
    # Warm sub + rich harmonics
    sub = np.sin(2.0 * np.pi * freq * t)
    h2 = np.sin(2.0 * np.pi * freq * 2.0 * t) * 0.42
    h3 = np.sin(2.0 * np.pi * freq * 3.0 * t) * 0.18
    env = np.minimum(1.0, t / 0.008) * np.exp(-t * 3.2)
    return soft_clip((sub + h2 + h3) * env, 1.3) * 0.42


def synth_pluck(freqs: list[float], dur_sec: float = 0.38) -> np.ndarray:
    n = int(SR * dur_sec)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for f in freqs:
        sig += np.sin(2.0 * np.pi * f * t) + 0.35 * np.sin(2.0 * np.pi * f * 2.0 * t)
    sig /= max(1, len(freqs))
    env = np.minimum(1.0, t / 0.006) * np.exp(-t * 6.5)
    return sig * env * 0.26


def synth_riser(dur_sec: float = 1.0) -> np.ndarray:
    n = int(SR * dur_sec)
    t = np.arange(n) / SR
    prog = t / dur_sec
    noise = np.diff(rng.normal(0, 1, n), prepend=0)
    noise = noise / (np.max(np.abs(noise)) + 1e-6)
    sweep_f = 180.0 + 1400.0 * (prog ** 2.2)
    tone = np.sin(2.0 * np.pi * np.cumsum(sweep_f) / SR) * 0.25
    env = (prog ** 2.0) * 0.55
    return (noise * 0.35 + tone) * env


def synth_click() -> np.ndarray:
    n = int(SR * 0.045)
    t = np.arange(n) / SR
    return np.sin(2.0 * np.pi * 1150.0 * t) * np.exp(-t * 140.0) * 0.28


def add_mono(buf: np.ndarray, sig: np.ndarray, start_sec: float, gain: float = 1.0, pan: float = 0.0):
    idx = int(start_sec * SR)
    if idx >= len(buf) or idx + len(sig) <= 0:
        return
    src_start = max(0, -idx)
    dst_start = max(0, idx)
    count = min(len(sig) - src_start, len(buf) - dst_start)
    if count <= 0:
        return
    l_gain = gain * np.cos((pan + 1.0) * np.pi / 4.0)
    r_gain = gain * np.sin((pan + 1.0) * np.pi / 4.0)
    chunk = sig[src_start:src_start + count]
    buf[dst_start:dst_start + count, 0] += chunk * l_gain
    buf[dst_start:dst_start + count, 1] += chunk * r_gain


def main():
    mix = np.zeros((N_SAMPLES, 2), dtype=np.float64)
    kick = synth_kick()
    snare = synth_snare_clap()
    hat_c = synth_hihat(False)
    hat_o = synth_hihat(True)
    click = synth_click()

    # Bass progression (F minor: F1=43.65, Ab1=51.91, Bb1=58.27, C2=65.41, Eb2=77.78)
    bar_roots = [43.65, 43.65, 51.91, 58.27, 43.65, 51.91, 58.27, 65.41, 43.65]
    chords = [
        [174.61, 207.65, 261.63, 311.13],  # Fm7
        [174.61, 207.65, 261.63, 349.23],
        [207.65, 261.63, 311.13, 392.00],  # Abmaj7
        [233.08, 277.18, 349.23, 415.30],  # Bbm7
    ]

    total_beats = int(TOTAL_SEC / BEAT_SEC)  # 36 beats

    for b in range(total_beats):
        t_beat = b * BEAT_SEC
        bar = b // 4
        beat_in_bar = b % 4

        # Intro hook (0..2s = beats 0..3): minimal sub pulse + crisp ticks on text slams
        if b < 4:
            if b in (0, 1, 2):
                add_mono(mix, kick, t_beat, gain=0.72)
                add_mono(mix, hat_c, t_beat + 0.25, gain=0.6)
            if b == 3:
                add_mono(mix, synth_riser(0.48), t_beat, gain=0.65)
            continue

        # Outro fade-down (14..18s = beats 28..35)
        if b >= 28:
            if b in (28, 30, 32):
                add_mono(mix, kick, t_beat, gain=0.55)
            if b == 28:
                add_mono(mix, synth_pluck(chords[0], 1.8), t_beat, gain=0.8)
            continue

        # Main groove (2s..14s = beats 4..27)
        # Drop energy boosts from beat 12 (6.0s) onward!
        is_drop = b >= 12

        # Four-on-the-floor punchy kick (skip beat 11 for pre-drop tension!)
        if b != 11:
            add_mono(mix, kick, t_beat, gain=0.95 if is_drop else 0.78)

        # Snare/clap on beats 2 & 4
        if beat_in_bar in (1, 3) and b != 11:
            add_mono(mix, snare, t_beat, gain=0.85 if is_drop else 0.65, pan=0.05)

        # 16th/8th hi-hats
        for sub in range(4):
            sub_t = t_beat + sub * (BEAT_SEC / 4.0)
            if sub == 2:
                add_mono(mix, hat_o if (beat_in_bar == 3 and is_drop) else hat_c, sub_t, gain=0.85, pan=-0.15)
            elif is_drop and sub in (1, 3):
                add_mono(mix, hat_c, sub_t, gain=0.45, pan=0.18)

        # Syncopated bassline
        root = bar_roots[min(bar, len(bar_roots) - 1)]
        if is_drop:
            add_mono(mix, synth_bass_note(root, 0.22), t_beat + 0.125, gain=0.95)
            add_mono(mix, synth_bass_note(root * (1.5 if beat_in_bar == 3 else 1.0), 0.18), t_beat + 0.375, gain=0.75)
        else:
            add_mono(mix, synth_bass_note(root, 0.28), t_beat + 0.25, gain=0.65)

        # Pluck stabs on bar accents during drop
        if is_drop and beat_in_bar in (0, 2):
            chord = chords[bar % len(chords)]
            add_mono(mix, synth_pluck(chord, 0.34), t_beat + (0.0 if beat_in_bar == 0 else 0.25), gain=0.75, pan=-0.12 if beat_in_bar == 0 else 0.12)

    # Pre-drop riser (5.0s -> 6.0s)
    add_mono(mix, synth_riser(1.0), 5.0, gain=0.95)
    # UI click cues during 3-step demo (2.2s - 5.2s)
    for click_t in (2.35, 3.6, 4.85):
        add_mono(mix, click, click_t, gain=0.85, pan=0.1)
    # Drop impact + bonus wipe click
    add_mono(mix, synth_kick(), 6.0, gain=1.05)
    add_mono(mix, synth_riser(0.45), 11.55, gain=0.55)
    add_mono(mix, synth_riser(0.45), 13.55, gain=0.50)

    # Master gentle fade out at very end (17.2s..18.0s) & normalize
    fade_n = int(SR * 0.8)
    mix[-fade_n:, 0] *= np.linspace(1.0, 0.0, fade_n)
    mix[-fade_n:, 1] *= np.linspace(1.0, 0.0, fade_n)
    mix = soft_clip(mix, 1.15)
    peak = np.max(np.abs(mix))
    if peak > 0:
        mix = mix / peak * 0.88

    pcm = (mix * 32767.0).astype(np.int16)
    out_dir = os.path.join(os.path.dirname(__file__), "public", "audio")
    os.makedirs(out_dir, exist_ok=True)
    wav_path = os.path.join(out_dir, "bgm.wav")
    mp3_path = os.path.join(out_dir, "bgm.mp3")

    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())

    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-codec:a", "libmp3lame", "-b:a", "192k", mp3_path],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    os.remove(wav_path)
    print(f"已生成 120 BPM 卡点音频: {mp3_path} ({TOTAL_SEC:.1f}s)")


if __name__ == "__main__":
    main()
