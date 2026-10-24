import React from "react";
import { Composition } from "remotion";
import { PromoV2, PROMO_FRAMES } from "./promo";
import { Walkthrough, WALK_FRAMES } from "./walkthrough";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="BiliCleanPromo"
      component={PromoV2}
      durationInFrames={PROMO_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="Walkthrough"
      component={Walkthrough}
      durationInFrames={WALK_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);
