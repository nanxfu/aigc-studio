import { LaunchFilm } from './Main';
import { CAPTIONS, SHOTS, SFX, TOTAL, TRANSITIONS } from './timeline';
import { Caption } from './Caption';

export const WORKBENCH = {
  name: 'AIGC Studio · 开源桌面端 AI 创作工作台',
  revision: 'launch-v2-shotcraft',
  fps: 30,
  width: 1920,
  height: 1080,
  total: TOTAL,
  background: '#141416',
  shots: SHOTS.map((s) => ({
    id: s.id,
    label: s.label,
    from: s.from,
    duration: s.duration,
    component: s.component,
    props: { ...s.props, hideNarrativeCaption: true },
    durationProp: 'duration',
    schema: [{ type: 'textarea', key: 'title', label: '标题', default: s.props.title }],
  })),
  transitions: TRANSITIONS.map((t) => ({ ...t })),
  captions: CAPTIONS.map((c) => ({ ...c, label: '字幕', component: Caption, cardId: 'narrative-caption', schema: [] })),
  overlays: [],
  sfx: SFX.map((s) => ({ id: s.id, from: s.from, duration: s.duration, src: s.src, volume: s.volume })),
  bgm: [{ from: 0, duration: TOTAL, src: 'audio/music-bed-45s.wav', volume: 0.36 }],
  original: LaunchFilm,
};
