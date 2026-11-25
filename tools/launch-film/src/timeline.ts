import music from './music.json';
import {
  TrailerBumperScene,
  MaskOpenScene,
  OrdinaryCreateScene,
  AssistantModelsScene,
  WorkshopGeneralScene,
  WorkshopGameScene,
  ComputeGeekScene,
  QuadWorkflowScene,
  AudienceBeatScene,
  OutroMorphScene,
  VersusSlamTransition,
  ThemeSweepTransition,
  BlindsSliceTransition,
  InvisibleCardWipe,
} from './scenes';

export const FPS = 30;
export const T = music.T;
export const SOURCE_START = music.sourceStart;
export const OUTPUT_AUDIO_OFFSET_SEC = 0;

export const beatF = (beat: number) => {
  const i = music.cutBeats.indexOf(beat);
  return Math.round(((i >= 0 ? music.cutTimes[i] : beat * T) + OUTPUT_AUDIO_OFFSET_SEC) * FPS);
};

const DEFINITIONS = [
  { id: 'bumper', label: '01 速剪钩子', beats: [0, 4], component: TrailerBumperScene, props: { title: '写中文就能画' } },
  { id: 'mask-open', label: '02 遮罩开场', beats: [4, 12], component: MaskOpenScene, props: { title: '开源桌面端 AI 创作工作台' } },
  { id: 'create', label: '03 普通生图', beats: [12, 22], component: OrdinaryCreateScene, props: { title: '打开就能画，写中文就可以' } },
  { id: 'assistant', label: '04 助手与模型', beats: [22, 32], component: AssistantModelsScene, props: { title: '描述不够具体，让助手拆成可改参数' } },
  { id: 'workshop-general', label: '05 通用工坊', beats: [32, 42], component: WorkshopGeneralScene, props: { title: '内置工坊，出图后直接处理' } },
  { id: 'workshop-game', label: '06 游戏资产与PBR', beats: [42, 54], component: WorkshopGameScene, props: { title: '游戏开发所需资产，直接导出成包' } },
  { id: 'compute-geek', label: '07 算力与MCP', beats: [54, 66], component: ComputeGeekScene, props: { title: '算力随时切换，控制面留在本地' } },
  { id: 'quad-workflow', label: '08 全功能并发', beats: [66, 76], component: QuadWorkflowScene, props: { title: '生图 · 工坊 · 视频 · 画廊 · MCP' } },
  { id: 'audience-beat', label: '09 适用人群', beats: [76, 84], component: AudienceBeatScene, props: { title: '为不同工作流而设' } },
  { id: 'outro', label: '10 品牌定版', beats: [84, 92], component: OutroMorphScene, props: { title: 'AIGC Studio' } },
];

export const SHOTS = DEFINITIONS.map((s) => ({
  ...s,
  from: beatF(s.beats[0]),
  duration: beatF(s.beats[1]) - beatF(s.beats[0]),
}));

export const TOTAL = beatF(92);

// Captions are integrated directly into kinetic scene typography (no bottom caption bar)
export const CAPTIONS: Array<{ id: string; from: number; duration: number; props: { text: string; dark: boolean; fontSize: number; duration: number } }> = [];

export const TRANSITIONS = [
  { id: 'slam-workshop', label: '斜切对撞', from: beatF(32) - 8, duration: 16, component: VersusSlamTransition },
  { id: 'blinds-game', label: '百叶翻页', from: beatF(42) - 8, duration: 16, component: BlindsSliceTransition },
  { id: 'sweep-dark', label: '斜边换肤', from: beatF(54) - 8, duration: 16, component: ThemeSweepTransition },
  { id: 'wipe-quad', label: '前景隐切', from: beatF(66) - 7, duration: 14, component: InvisibleCardWipe },
];

export const SFX = [
  { id: 'bumper-hit', shot: 'bumper', offset: 24, src: 'fs-579883.mp3', volume: 0.48, duration: 24, peak: 0.125, action: '速剪撞帧' },
  { id: 'mask-lock', shot: 'mask-open', offset: 18, src: 'fs-464302.mp3', volume: 0.55, duration: 42, peak: 1.135, action: '标题定格' },
  { id: 'create-snap', shot: 'create', offset: 16, src: 'fs-730078.mp3', volume: 1.6, duration: 24, peak: 0.115, action: '透视急停' },
  { id: 'create-type', shot: 'create', offset: 24, src: 'fs-786019.mp3', volume: 0.55, duration: 44, peak: 0, action: '中文输入' },
  { id: 'create-pop', shot: 'create', offset: 74, src: 'fs-579883.mp3', volume: 0.4, duration: 24, peak: 0.125, action: '出图显影' },
  { id: 'assistant-flip', shot: 'assistant', offset: 66, src: 'fs-730078.mp3', volume: 1.5, duration: 24, peak: 0.115, action: '模型卡翻面' },
  { id: 'workshop-scrub', shot: 'workshop-general', offset: 14, src: 'fs-464302.mp3', volume: 0.5, duration: 48, peak: 1.135, action: '去背对照' },
  { id: 'pbr-lock', shot: 'workshop-game', offset: 96, src: 'fs-579883.mp3', volume: 0.42, duration: 24, peak: 0.125, action: '扫描锁定' },
  { id: 'geek-merge', shot: 'compute-geek', offset: 64, src: 'fs-730078.mp3', volume: 1.6, duration: 24, peak: 0.115, action: '算力汇流' },
  { id: 'quad-zoom', shot: 'quad-workflow', offset: 116, src: 'fs-579883.mp3', volume: 0.5, duration: 24, peak: 0.125, action: '四宫格急推' },
  { id: 'brand-lock', shot: 'outro', offset: 58, src: 'fs-579883.mp3', volume: 0.42, duration: 27, peak: 0.125, action: '品牌定版' },
].map((s) => ({
  ...s,
  src: `audio/sfx/${s.src}`,
  from: Math.max(0, Math.round(SHOTS.find((v) => v.id === s.shot)!.from + s.offset - s.peak * FPS)),
}));
