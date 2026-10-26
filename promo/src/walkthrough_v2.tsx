// 插件操作教程片 v2 —— WalkthroughV2（2700 帧 / 90.0s @30fps，1920x1080）
// 段表出处：promo/v2-script.md 第 2 节。界面同样来自真实侧栏 DOM 截图。
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Eyebrow, Fade } from "./theme";
import { Caption, Chip, Shot, StepHeader, TypedText, V2Stage } from "./v2-stage";
import { WALK } from "./v2-copy";
import { fmt, values } from "./numbers";

export const WALK_FRAMES_V2 = 2700;

const Seg: React.FC<{ from: number; dur: number; children: React.ReactNode }> = ({ from, dur, children }) => (
  <Sequence from={from} durationInFrames={dur}>
    <V2Stage>{children}</V2Stage>
  </Sequence>
);

const Title: React.FC = () => (
  <Seg from={0} dur={120}>
    <Eyebrow text={WALK.eyebrow} />
    <Fade from={12}>
      <div style={{ fontSize: 96, fontWeight: 800 }}>{WALK.title}</div>
    </Fade>
  </Seg>
);

const s1 = WALK.steps[0];
const s2 = WALK.steps[1];
const s3 = WALK.steps[2];
const s4 = WALK.steps[3];
const s5 = WALK.steps[4];
const s6 = WALK.steps[5];
const s7 = WALK.steps[6];
const s8 = WALK.steps[7];
const s9 = WALK.steps[8];

const Step1: React.FC = () => (
  <Seg from={120} dur={310}>
    <StepHeader step={s1.n} title={s1.title} />
    <Caption text={s1.caption} from={20} size={34} />
    <div style={{ display: "flex", gap: 22 }}>
      {s1.pitfalls.map((p, i) => (
        <Fade key={p} from={110 + i * 60} dy={14}>
          <div style={{ width: 620, background: "#161C26", border: "1px solid #232B38", borderRadius: 14, padding: "22px 26px", fontSize: 28, color: "#FFB020" }}>
            {p}
          </div>
        </Fade>
      ))}
    </div>
  </Seg>
);

const Step2: React.FC = () => (
  <Seg from={430} dur={270}>
    <StepHeader step={s2.n} title={s2.title} />
    <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
      <Shot src={staticFile("v2/scan-partial.png")} width={430} from={4} url="抓取进度（中断样本）" />
      <Shot src={staticFile("v2/scan-complete.png")} width={430} from={90} url="抓全之后" />
      <div style={{ width: 560, display: "flex", flexDirection: "column", gap: 18 }}>
        <Caption text={fmt(s2.caption)} from={16} size={30} />
        <div style={{ fontSize: 40, fontWeight: 800, color: "#00A1D6" }}>{fmt(s2.statLine)}</div>
        <div style={{ fontSize: 30, color: "#FFB020" }}>{s2.warn}</div>
      </div>
    </div>
  </Seg>
);

const Step3: React.FC = () => (
  <Seg from={700} dur={300}>
    <StepHeader step={s3.n} title={s3.title} />
    <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
      <Shot src={staticFile("v2/classify-cards.png")} width={460} from={4} url="AI 分类（BYOK）" />
      <div style={{ width: 700, display: "flex", flexDirection: "column", gap: 18 }}>
        <Caption text={s3.caption} from={14} size={30} />
        <div style={{ fontSize: 36, color: "#3ECF8E" }}>{fmt(s3.batchLine)}</div>
        <div style={{ fontSize: 28, color: "#9FB0C4" }}>{s3.note}</div>
      </div>
    </div>
  </Seg>
);

const Step4: React.FC = () => (
  <Seg from={1000} dur={250}>
    <StepHeader step={s4.n} title={s4.title} />
    <Shot src={staticFile("v2/classify-cards.png")} width={520} from={4} url="分类卡片上的操作" />
    <Caption text={s4.caption} from={30} size={32} />
  </Seg>
);

const Step5: React.FC = () => (
  <Seg from={1250} dur={350}>
    <StepHeader step={s5.n} title={s5.title} />
    <Shot src={staticFile("v2/command-bar.png")} width={440} from={4} url="指令栏" />
    <div style={{ width: 900 }}>
      {s5.commands.map((c, i) => (
        <div key={c} style={{ marginBottom: 14 }}>
          <TypedText text={c} from={20 + i * 80} frames={55} size={34} />
        </div>
      ))}
    </div>
    <div style={{ fontSize: 28, color: "#9FB0C4" }}>{s5.note}</div>
  </Seg>
);

const Step6: React.FC = () => (
  <Seg from={1600} dur={350}>
    <StepHeader step={s6.n} title={s6.title} />
    <div style={{ display: "flex", gap: 26, alignItems: "flex-start" }}>
      <Shot src={staticFile("v2/guardrail-risk.png")} width={420} from={4} url="二次确认" />
      <Shot src={staticFile("v2/unfollow-token.png")} width={420} from={80} url="手输 UNFOLLOW" />
      <div style={{ width: 560, display: "flex", flexDirection: "column", gap: 18 }}>
        <Caption text={s6.caption} from={16} size={30} />
        <div style={{ fontSize: 40, fontWeight: 800, color: "#FF6B6B" }}>{fmt(s6.progressLine)}</div>
        <div style={{ fontSize: 28, color: "#9FB0C4" }}>{s6.note}</div>
      </div>
    </div>
  </Seg>
);

const Step7: React.FC = () => (
  <Seg from={1950} dur={250}>
    <StepHeader step={s7.n} title={s7.title} />
    <Shot src={staticFile("v2/audit-list.png")} width={480} from={4} url="审计与补救" />
    <Caption text={s7.caption} from={30} size={32} />
  </Seg>
);

const Step8: React.FC = () => (
  <Seg from={2200} dur={200}>
    <StepHeader step={s8.n} title={s8.title} />
    <Caption text={s8.caption} from={16} size={34} />
  </Seg>
);

const Step9: React.FC = () => (
  <Seg from={2400} dur={160}>
    <StepHeader step={s9.n} title={s9.title} />
    <Caption text={s9.caption} from={16} size={34} />
  </Seg>
);

const Cta: React.FC = () => (
  <Seg from={2560} dur={140}>
    {WALK.cta.lines.map((l, i) => (
      <Fade key={l} from={8 + i * 30} dy={14}>
        <div style={{ fontSize: i === 0 ? 60 : 30, fontWeight: i === 0 ? 800 : 400, color: i === 0 ? "#F2F5FA" : "#8A94A6", maxWidth: 1500, textAlign: "center" }}>
          {l}
        </div>
      </Fade>
    ))}
  </Seg>
);

export const WalkthroughV2Film: React.FC = () => {
  values(); // 取数门禁
  return (
    <AbsoluteFill style={{ backgroundColor: "#0B0D12" }}>
      <Title />
      <Step1 />
      <Step2 />
      <Step3 />
      <Step4 />
      <Step5 />
      <Step6 />
      <Step7 />
      <Step8 />
      <Step9 />
      <Cta />
      <Audio src={staticFile("audio/bgm-v2-walk.wav")} volume={0.5} />
    </AbsoluteFill>
  );
};