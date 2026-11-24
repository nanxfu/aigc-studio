import React from 'react';
import { Composition } from 'remotion';
import { FPS, PromoZh, TOTAL_DURATION } from './PromoZh';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PromoZh"
        component={PromoZh}
        durationInFrames={TOTAL_DURATION}
        fps={FPS}
        width={1920}
        height={1080}
      />
    </>
  );
};
