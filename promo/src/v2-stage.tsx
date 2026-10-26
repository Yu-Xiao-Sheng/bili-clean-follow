// v2 两支片的取景与动效原语（FOR-70）。
// 与 v0.1.x 的最大视觉差别：界面段落一律用「浏览器窗框」，不再用终端窗框。
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
import { ACCENT, BG, DIM, FG, FONT_STACK, KEEP, LINE, MONO_STACK, PANEL, PANEL_2, WARN } from "./theme";

export const Shot: React.FC<{
  src: string;
  width?: number;
  url?: string;
  from?: number;
  zoom?: number;
}> = ({ src, width = 620, url = "chrome://extensions · Bili Clean Follow", from = 0, zoom = 1.06 }) => {
  const f = useCurrentFrame();
  const s = spring({ frame: f - from, fps: 30, config: { damping: 17 } });
  const scale = interpolate(f, [from, from + 260], [1, zoom], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        width,
        opacity: Math.min(1, s * 1.3),
        transform: `translateY(${(1 - s) * 46}px) scale(${0.97 + 0.03 * s})`,
        background: PANEL,
        border: `1px solid ${LINE}`,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 40px 100px rgba(0,0,0,0.6)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "14px 20px",
          background: PANEL_2,
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <div style={{ display: "flex", gap: 9 }}>
          {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
            <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
          ))}
        </div>
        <div
          style={{
            flex: 1,
            fontFamily: MONO_STACK,
            fontSize: 17,
            color: DIM,
            background: "#0E131B",
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            padding: "6px 12px",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {url}
        </div>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: ACCENT,
            color: "#04121A",
            fontSize: 15,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          B
        </div>
      </div>
      <div style={{ height: 700, overflow: "hidden", background: "#0E131B" }}>
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
      </div>
    </div>
  );
};

export const TypedText: React.FC<{
  text: string;
  from: number;
  frames: number;
  size?: number;
  color?: string;
  mono?: boolean;
}> = ({ text, from, frames, size = 40, color = FG, mono = false }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [from, from + frames], [0, text.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shown = text.slice(0, Math.max(0, Math.round(t)));
  const caret = f >= from && f < from + frames + 20 ? "|" : "";
  return (
    <div
      style={{
        fontFamily: mono ? MONO_STACK : FONT_STACK,
        fontSize: size,
        color,
        lineHeight: 1.4,
        whiteSpace: "pre-wrap",
      }}
    >
      {shown}
      <span style={{ color: ACCENT }}>{caret}</span>
    </div>
  );
};

export const Caption: React.FC<{ text: string; from?: number; color?: string; size?: number }> = ({
  text,
  from = 0,
  color = DIM,
  size = 30,
}) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [from, from + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        opacity: o,
        maxWidth: 1500,
        textAlign: "center",
        color,
        fontSize: size,
        lineHeight: 1.5,
        fontFamily: FONT_STACK,
      }}
    >
      {text}
    </div>
  );
};

export const Chip: React.FC<{ text: string; kind?: "keep" | "candidate" | "plain"; from?: number }> = ({
  text,
  kind = "plain",
  from = 0,
}) => {
  const f = useCurrentFrame();
  const s = spring({ frame: f - from, fps: 30, config: { damping: 15 } });
  const color = kind === "keep" ? KEEP : kind === "candidate" ? WARN : ACCENT;
  return (
    <div
      style={{
        opacity: Math.min(1, s * 1.4),
        transform: `scale(${0.9 + 0.1 * s})`,
        border: `2px solid ${color}`,
        color,
        borderRadius: 999,
        padding: "10px 22px",
        fontSize: 26,
        fontFamily: MONO_STACK,
        marginRight: 14,
      }}
    >
      {text}
    </div>
  );
};

export const CardGrid: React.FC<{ cards: { label: string; count: string; pct: string }[]; from: number }> = ({
  cards,
  from,
}) => {
  const f = useCurrentFrame();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, width: 1420, justifyContent: "center" }}>
      {cards.map((c, i) => {
        const s = spring({ frame: f - from - i * 4, fps: 30, config: { damping: 14 } });
        return (
          <div
            key={c.label}
            style={{
              width: 330,
              opacity: Math.min(1, s * 1.4),
              transform: `translateY(${(1 - s) * 26}px)`,
              background: PANEL,
              border: `1px solid ${LINE}`,
              borderRadius: 14,
              padding: "18px 22px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 28, color: FG }}>{c.label}</span>
              <span style={{ fontSize: 30, color: ACCENT, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                {c.count}
              </span>
            </div>
            <div style={{ height: 6, background: "#0E131B", borderRadius: 3, marginTop: 12, overflow: "hidden" }}>
              <div style={{ width: c.pct + "%", height: "100%", background: ACCENT }} />
            </div>
            <div style={{ fontSize: 20, color: DIM, marginTop: 8 }}>{c.pct}%</div>
          </div>
        );
      })}
    </div>
  );
};

export const StepHeader: React.FC<{ step: string; title: string; from?: number }> = ({ step, title, from = 0 }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [from, from + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ opacity: o, display: "flex", alignItems: "baseline", gap: 22 }}>
      <span style={{ fontFamily: MONO_STACK, fontSize: 30, color: ACCENT, letterSpacing: 2 }}>{step}</span>
      <span style={{ fontSize: 54, fontWeight: 800, color: FG }}>{title}</span>
    </div>
  );
};

export const V2Stage: React.FC<{ children: React.ReactNode; gap?: number; bg?: string }> = ({
  children,
  gap = 34,
  bg = BG,
}) => (
  <AbsoluteFill
    style={{
      backgroundColor: bg,
      backgroundImage: "radial-gradient(1200px 700px at 20% 10%, rgba(0,161,214,0.045), transparent 70%)",
      color: FG,
      fontFamily: FONT_STACK,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap,
      padding: 70,
      boxSizing: "border-box",
    }}
  >
    {children}
  </AbsoluteFill>
);