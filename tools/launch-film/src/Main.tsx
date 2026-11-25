import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { SHOTS, SFX, TRANSITIONS } from './timeline';

export const LaunchFilm: React.FC<{ bgm?: boolean; vo?: boolean }> = ({ bgm = true, vo = true }) => (
  <AbsoluteFill style={{ background: '#141416' }}>
    {SHOTS.map((s) => (
      <Sequence key={s.id} from={s.from} durationInFrames={s.duration}>
        <s.component {...s.props} duration={s.duration} hideNarrativeCaption />
      </Sequence>
    ))}
    {TRANSITIONS.map((t) => (
      <Sequence key={t.id} from={t.from} durationInFrames={t.duration}>
        <t.component />
      </Sequence>
    ))}
    {bgm && <Audio src={staticFile('audio/music-bed-45s.wav')} volume={vo ? 0.18 : 0.36} />}
    {vo && <Audio src={staticFile('audio/vo-main.mp3')} volume={1.0} />}
    {SFX.map((s) => (
      <Sequence key={s.id} from={s.from} durationInFrames={s.duration}>
        <Audio src={staticFile(s.src)} volume={s.volume * (vo ? 0.5 : 1)} />
      </Sequence>
    ))}
  </AbsoluteFill>
);