import React from "react";
import { Composition } from "remotion";
import { PromoV2, PROMO_FRAMES } from "./promo";
import { Walkthrough, WALK_FRAMES } from "./walkthrough";
import { PromoV2Film, PROMO_FRAMES_V2 } from "./promo_v2";
import { WalkthroughV2Film, WALK_FRAMES_V2 } from "./walkthrough_v2";

export const RemotionRoot: React.FC = () => (
  <>
    {/* @deprecated v0.1.x 两支 CLI 形态的旧片：不再投放，仅作历史素材保留 */}
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
    {/* v2 插件形态两支（FOR-70）：数字未注入时 values() 会抛，渲染不出片 */}
    <Composition
      id="BiliCleanV2Promo"
      component={PromoV2Film}
      durationInFrames={PROMO_FRAMES_V2}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="WalkthroughV2"
      component={WalkthroughV2Film}
      durationInFrames={WALK_FRAMES_V2}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);