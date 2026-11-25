import React from 'react';
import { Composition } from 'remotion';
import { LaunchFilm } from './Main';
import { FPS, TOTAL, SHOTS } from './timeline';
export const Root: React.FC = () => <>
  <Composition id="LaunchFilm" component={LaunchFilm} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} defaultProps={{ bgm: true }}/>
  {SHOTS.map(s => <Composition key={s.id} id={`Shot-${s.id}`} component={s.component} durationInFrames={s.duration} fps={FPS} width={1920} height={1080} defaultProps={{...s.props, duration:s.duration}}/>)}
</>;
