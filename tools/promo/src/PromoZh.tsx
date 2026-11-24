import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { BonusWorkshop, MinimalOutro } from './components/MinimalOutro';
import { DropMontage } from './components/DropMontage';
import { KineticHook } from './components/KineticHook';
import { ThreeStepFlow } from './components/ThreeStepFlow';
import recordedManifest from './recorded-manifest.json';

export const FPS = 30;

const modelFrames = recordedManifest.model ?? 45;
const generateFrames = recordedManifest.generate ?? 45;
const pendingFrames = recordedManifest.pending ?? 30;
const resultFrames = recordedManifest.result ?? 45;
const workshopFrames = recordedManifest.workshop ?? 60;

const FLOW_DURATION = modelFrames + generateFrames + pendingFrames; // 120f (4.0s)
const DROP_DURATION = resultFrames + 90 + 45; // 180f (6.0s)
const HOOK_DURATION = 60; // 2.0s
const OUTRO_DURATION = 120; // 4.0s

export const TOTAL_DURATION =
  HOOK_DURATION + FLOW_DURATION + DROP_DURATION + workshopFrames + OUTRO_DURATION; // 540f (18.0s)

export const PromoZh: React.FC = () => {
  const flowStart = HOOK_DURATION;
  const dropStart = flowStart + FLOW_DURATION;
  const workshopStart = dropStart + DROP_DURATION;
  const outroStart = workshopStart + workshopFrames;

  return (
    <AbsoluteFill style={{ backgroundColor: '#090a0d' }}>
      <Audio src={staticFile('audio/bgm.mp3')} />

      <Sequence from={0} durationInFrames={HOOK_DURATION}>
        <KineticHook />
      </Sequence>

      <Sequence from={flowStart} durationInFrames={FLOW_DURATION}>
        <ThreeStepFlow
          modelFrames={modelFrames}
          generateFrames={generateFrames}
          pendingFrames={pendingFrames}
        />
      </Sequence>

      <Sequence from={dropStart} durationInFrames={DROP_DURATION}>
        <DropMontage resultFrames={resultFrames} />
      </Sequence>

      <Sequence from={workshopStart} durationInFrames={workshopFrames}>
        <BonusWorkshop workshopFrames={workshopFrames} />
      </Sequence>

      <Sequence from={outroStart} durationInFrames={OUTRO_DURATION}>
        <MinimalOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
