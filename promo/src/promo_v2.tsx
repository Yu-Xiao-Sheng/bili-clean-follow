// 产品介绍片 v2 —— BiliCleanV2Promo（1800 帧 / 60.0s @30fps，1920x1080）
// 段表出处：promo/v2-script.md 第 1 节。界面镜头来自 promo/tools/capture_ui.mjs 拍摄的
// 真实侧栏 DOM（promo/public/v2/*.png）；片内数量一律经 fmt() 从取证报告注入，不手写。
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Eyebrow, Fade, Stat } from "./theme";
import { CardGrid, Caption, Chip, Shot, TypedText, V2Stage } from "./v2-stage";
import { COMPLIANCE, PROMO } from "./v2-copy";
import { categoryName, fmt, values } from "./numbers";

export const PROMO_FRAMES_V2 = 1800;

const Seg: React.FC<{ from: number; dur: number; children: React.ReactNode }> = ({ from, dur, children }) => (
  <Sequence from={from} durationInFrames={dur}>
    <V2Stage>{children}</V2Stage>
  </Sequence>
);

const Compliance: React.FC<{ from: number }> = ({ from }) => {
  const f = useCurrentFrame();
  if (f < from) return null;
  return (
    <div style={{ position: "absolute", bottom: 40, left: 0, right: 0, textAlign: "center", color: "#6E7A8C", fontSize: 22, padding: "0 120px" }}>
      {COMPLIANCE}
    </div>
  );
};

const Hook: React.FC = () => {
  const n = values();
  return (
    <Seg from={0} dur={130}>
      <Eyebrow text={PROMO.eyebrow} />
      <Fade from={10}>
        <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1.16, textAlign: "center" }}>{fmt(PROMO.hook.line1)}</div>
      </Fade>
      <Fade from={70} dy={18}>
        <div style={{ fontSize: 44, color: "#9FB0C4" }}>{fmt(PROMO.hook.line2)}</div>
      </Fade>
      <div style={{ display: "flex", gap: 70, marginTop: 20 }}>
        <Stat value={String(n.followTotal)} label="关注数（真实会话）" from={30} />
        <Stat value={String(n.pages)} label="要翻的页数" from={48} />
      </div>
    </Seg>
  );
};

const Install: React.FC = () => (
  <Seg from={130} dur={200}>
    <Eyebrow text={PROMO.install.eyebrow} />
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {PROMO.install.steps.map((s, i) => (
        <Fade key={s} from={16 + i * 34} dy={16}>
          <div style={{ fontSize: 34, color: "#DCE4EF" }}>
            <span style={{ color: "#00A1D6", fontFamily: "monospace" }}>{i + 1}. </span>
            {s}
          </div>
        </Fade>
      ))}
    </div>
    <Fade from={150}>
      <div style={{ fontSize: 52, fontWeight: 800, color: "#3ECF8E" }}>{PROMO.install.big}</div>
    </Fade>
  </Seg>
);

const OpenPanel: React.FC = () => (
  <Seg from={330} dur={140}>
    <Eyebrow text={PROMO.openPanel.eyebrow} />
    <Shot src={staticFile("v2/scan-complete.png")} width={600} from={2} url="Bili Clean Follow · 侧栏" />
    <Caption text={fmt(PROMO.openPanel.progressCaption)} from={30} />
  </Seg>
);

const Gate: React.FC = () => (
  <Seg from={470} dur={130}>
    <Eyebrow text={PROMO.gate.eyebrow} color="#FFB020" />
    <Shot src={staticFile("v2/scan-partial.png")} width={620} from={2} url="读全门禁 · fetched == total" />
    <Caption text={fmt(PROMO.gate.lock)} from={16} color="#FFB020" size={34} />
    <Caption text={PROMO.gate.caption} from={55} />
  </Seg>
);

const Classify: React.FC = () => {
  const n = values();
  return (
    <Seg from={600} dur={230}>
      <Eyebrow text={PROMO.classify.eyebrow} />
      <CardGrid cards={n.categories.map((c) => ({ label: categoryName(c.id), count: String(c.n), pct: String(c.pct) }))} from={6} />
      <Caption text={fmt(PROMO.classify.topCaption)} from={160} />
    </Seg>
  );
};

const CommandBar: React.FC = () => {
  const [keepChip, candChip] = fmt(PROMO.commandBar.intent).split("  ");
  return (
    <Seg from={830} dur={250}>
      <Eyebrow text={PROMO.commandBar.eyebrow} />
      <Shot src={staticFile("v2/command-bar.png")} width={540} from={4} url="指令栏 · 说一句话就能整理" />
      <div style={{ width: 1300, textAlign: "center" }}>
        <TypedText text={PROMO.commandBar.typed} from={10} frames={140} size={38} />
      </div>
      <div style={{ display: "flex" }}>
        <Chip text={keepChip} kind="keep" from={165} />
        <Chip text={candChip} kind="candidate" from={185} />
      </div>
    </Seg>
  );
};

const Diff: React.FC = () => (
  <Seg from={1080} dur={200}>
    <Eyebrow text={PROMO.diff.eyebrow} />
    <Shot src={staticFile("v2/diff-preview.png")} width={620} from={4} url="diff 预览 · 只读" />
    <Caption text={fmt(PROMO.diff.line)} from={30} size={34} />
    <div style={{ fontSize: 40, fontWeight: 800, color: "#3ECF8E" }}>{PROMO.diff.fixed}</div>
  </Seg>
);

const Guardrails: React.FC = () => (
  <Seg from={1280} dur={190}>
    <Eyebrow text={PROMO.guardrails.eyebrow} color="#FF6B6B" />
    <div style={{ display: "flex", gap: 30, alignItems: "flex-start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 760 }}>
        {PROMO.guardrails.lines.map((l, i) => (
          <Fade key={l} from={6 + i * 20} dy={12}>
            <div style={{ fontSize: 30, color: "#DCE4EF" }}>
              <span style={{ color: "#FF6B6B" }}>{i + 1}. </span>
              {l}
            </div>
          </Fade>
        ))}
      </div>
      <Shot src={staticFile("v2/unfollow-token.png")} width={420} from={20} url="手输 UNFOLLOW" />
    </div>
    <Caption text={fmt(PROMO.guardrails.done)} from={150} />
  </Seg>
);

const Audit: React.FC = () => (
  <Seg from={1470} dur={130}>
    <Eyebrow text={PROMO.audit.eyebrow} />
    <Shot src={staticFile("v2/audit-list.png")} width={580} from={4} url="审计（最近事件）" />
    <div style={{ display: "flex" }}>
      {PROMO.audit.lines.map((l, i) => (
        <Chip key={l} text={l} from={20 + i * 22} />
      ))}
    </div>
  </Seg>
);

const Honesty: React.FC = () => (
  <Seg from={1600} dur={120}>
    <Eyebrow text={PROMO.honesty.eyebrow} />
    {PROMO.honesty.lines.map((l, i) => (
      <Fade key={l} from={6 + i * 32} dy={16}>
        <div style={{ fontSize: 34, color: "#C8D2E0", maxWidth: 1500, textAlign: "center" }}>{l}</div>
      </Fade>
    ))}
  </Seg>
);

const Cta: React.FC = () => (
  <Seg from={1720} dur={80}>
    <div style={{ fontSize: 92, fontWeight: 800 }}>{PROMO.cta.line1}</div>
    <div style={{ fontSize: 36, color: "#9FB0C4" }}>{PROMO.cta.line2}</div>
    <div style={{ fontSize: 28, color: "#6E7A8C" }}>{PROMO.cta.line3}</div>
  </Seg>
);

export const PromoV2Film: React.FC = () => {
  values(); // 取数门禁：未注入直接抛，不出片
  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0D12" }}>
      <Hook />
      <Install />
      <OpenPanel />
      <Gate />
      <Classify />
      <CommandBar />
      <Diff />
      <Guardrails />
      <Audit />
      <Honesty />
      <Cta />
      <Compliance from={1720} />
      <Audio src={staticFile("audio/bgm-v2-promo.wav")} volume={0.5} />
    </AbsoluteFill>
  );
};