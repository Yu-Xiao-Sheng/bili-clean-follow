import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

export const BG = "#0B0D12";
export const PANEL = "#11151D";
export const PANEL_2 = "#161C26";
export const LINE = "#232B38";
export const FG = "#F2F5FA";
export const DIM = "#8A94A6";
export const ACCENT = "#00A1D6";
export const WARN = "#FF6B6B";
export const KEEP = "#3ECF8E";
export const REVIEW = "#FFB020";

export const FONT_STACK =
  '"PingFang SC","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif';
export const MONO_STACK =
  '"JetBrains Mono","Cascadia Mono","Consolas","Noto Sans Mono",monospace';

export const Stage: React.FC<{
  children: React.ReactNode;
  pad?: number;
  bg?: string;
}> = ({ children, pad = 90, bg = BG }) => (
  <AbsoluteFill
    style={{
      backgroundColor: bg,
      fontFamily: FONT_STACK,
      color: FG,
      padding: pad,
      boxSizing: "border-box",
      justifyContent: "center",
      alignItems: "center",
    }}
  >
    {children}
  </AbsoluteFill>
);

export const Fade: React.FC<{
  from?: number;
  dur?: number;
  dy?: number;
  children: React.ReactNode;
}> = ({ from = 0, dur = 18, dy = 26, children }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [from, from + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const y = interpolate(f, [from, from + dur], [dy, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return <div style={{ opacity: o, transform: `translateY(${y}px)` }}>{children}</div>;
};

export const Pop: React.FC<{
  from?: number;
  children: React.ReactNode;
  cfg?: { damping?: number; mass?: number };
}> = ({ from = 0, children, cfg }) => {
  const f = useCurrentFrame();
  const s = spring({
    frame: f - from,
    fps: 30,
    config: { damping: cfg?.damping ?? 14, mass: cfg?.mass ?? 1 },
  });
  return (
    <div style={{ opacity: Math.min(1, s * 1.4), transform: `scale(${0.86 + 0.14 * s})` }}>
      {children}
    </div>
  );
};

export const Eyebrow: React.FC<{ text: string; color?: string }> = ({
  text,
  color = ACCENT,
}) => (
  <div
    style={{
      display: "inline-block",
      border: `2px solid ${color}`,
      borderRadius: 999,
      padding: "10px 26px",
      fontSize: 26,
      letterSpacing: 3,
      color,
    }}
  >
    {text}
  </div>
);

export const Counter: React.FC<{
  from: number;
  to: number;
  start: number;
  end: number;
  size?: number;
  color?: string;
}> = ({ from, to, start, end, size = 190, color = ACCENT }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });
  const n = Math.round(from + (to - from) * t);
  return (
    <div
      style={{
        fontSize: size,
        fontWeight: 800,
        color,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1.05,
      }}
    >
      {n.toLocaleString("en-US")}
    </div>
  );
};

export const Bar: React.FC<{ width: number; color?: string }> = ({
  width,
  color = ACCENT,
}) => (
  <div
    style={{
      width,
      height: 6,
      borderRadius: 3,
      background: `linear-gradient(90deg, ${color}, ${color}22)`,
    }}
  />
);

export const Dots: React.FC = () => (
  <div style={{ display: "flex", gap: 12 }}>
    {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
      <div key={c} style={{ width: 18, height: 18, borderRadius: 9, background: c }} />
    ))}
  </div>
);

export const Window: React.FC<{
  width: number;
  title?: string;
  mono?: boolean;
  children: React.ReactNode;
  from?: number;
}> = ({ width, title = "", mono = false, children, from = 0 }) => {
  const f = useCurrentFrame();
  const s = spring({ frame: f - from, fps: 30, config: { damping: 16 } });
  return (
    <div
      style={{
        width,
        opacity: Math.min(1, s * 1.3),
        transform: `translateY(${(1 - s) * 40}px) scale(${0.97 + 0.03 * s})`,
        background: PANEL,
        border: `1px solid ${LINE}`,
        borderRadius: 18,
        boxShadow: "0 40px 90px rgba(0,0,0,0.55)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "18px 24px",
          background: PANEL_2,
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <Dots />
        <div
          style={{
            flex: 1,
            fontFamily: mono ? MONO_STACK : FONT_STACK,
            fontSize: 22,
            color: DIM,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
      </div>
      {children}
    </div>
  );
};

export const TermLine: React.FC<{
  text: string;
  kind?: "cmd" | "out" | "dim" | "ok" | "warn";
  show: boolean;
}> = ({ text, kind = "out", show }) => {
  const color =
    kind === "cmd" ? FG : kind === "ok" ? KEEP : kind === "warn" ? WARN : kind === "dim" ? DIM : "#C7D0DD";
  const prefix = kind === "cmd" ? "$ " : "  ";
  return (
    <div
      style={{
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 120ms linear, transform 120ms linear",
        fontFamily: MONO_STACK,
        fontSize: 30,
        lineHeight: 1.62,
        color,
        whiteSpace: "pre",
      }}
    >
      <span style={{ color: kind === "cmd" ? ACCENT : DIM }}>{prefix}</span>
      {text}
    </div>
  );
};

export const Stat: React.FC<{
  value: string;
  label: string;
  color?: string;
  from?: number;
}> = ({ value, label, color = FG, from = 0 }) => (
  <Pop from={from}>
    <div style={{ width: 330 }}>
      <div style={{ fontSize: 78, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 26, color: DIM, marginTop: 8 }}>{label}</div>
    </div>
  </Pop>
);
