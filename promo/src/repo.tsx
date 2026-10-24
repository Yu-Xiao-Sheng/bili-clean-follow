import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame, Easing } from "remotion";
import { ACCENT, BG, DIM, FG, FONT_STACK, LINE, MONO_STACK, PANEL, PANEL_2, KEEP, REVIEW, WARN } from "./theme";

export const REPO_OWNER = "Yu-Xiao-Sheng";
export const REPO_NAME = "bili-clean-follow";
export const REPO_URL = "github.com/Yu-Xiao-Sheng/bili-clean-follow";
export const REPO_DESC =
  "分析你的 B站 关注列表，按 keep / review / remove 分类，导出人工审核清单";

const TOPICS = ["bilibili", "python", "cli", "web-ui", "organize", "report-only"];

const FILES: Array<[string, string, string]> = [
  ["src/bili", "分析引擎 + bili-clean + bili-merge", "今天"],
  ["docs", "getting-started · scoring-model · spec", "今天"],
  ["tests", "pytest 套件（230 个用例，CI 每次跑）", "今天"],
  ["assets", "logo · banner", "3 天前"],
  ["README.md", "中文优先，可切换英文", "今天"],
  ["pyproject.toml", "pip install -e . 即可使用", "今天"],
  ["LICENSE", "MIT", "4 天前"],
];

const TopicPill: React.FC<{ t: string }> = ({ t }) => (
  <span
    style={{
      background: "#12303F",
      color: "#66CFEE",
      borderRadius: 999,
      padding: "7px 18px",
      fontSize: 21,
      marginRight: 12,
    }}
  >
    {t}
  </span>
);

export const RepoPanel: React.FC<{ width?: number; from?: number }> = ({
  width = 1620,
  from = 0,
}) => {
  const f = useCurrentFrame();
  const rows = Math.min(
    FILES.length,
    Math.floor(interpolate(f, [from + 12, from + 70], [0, FILES.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }))
  );
  return (
    <div
      style={{
        width,
        background: "#0D1117",
        border: `1px solid ${LINE}`,
        borderRadius: 16,
        overflow: "hidden",
        fontFamily: FONT_STACK,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "16px 28px",
          background: PANEL_2,
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <div key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />
        ))}
        <div
          style={{
            marginLeft: 10,
            background: "#0B0F14",
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            padding: "8px 20px",
            fontSize: 22,
            color: "#B9C4D2",
            fontFamily: MONO_STACK,
          }}
        >
          https://{REPO_URL}
        </div>
      </div>

      <div style={{ padding: "30px 40px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Img src={staticFile("logo.png")} width={64} height={64} style={{ borderRadius: 12 }} />
          <div style={{ fontSize: 34 }}>
            <span style={{ color: DIM }}>{REPO_OWNER} / </span>
            <span style={{ color: "#58A6FF", fontWeight: 700 }}>{REPO_NAME}</span>
          </div>
          <span
            style={{
              border: `1px solid ${LINE}`,
              borderRadius: 999,
              padding: "6px 16px",
              fontSize: 20,
              color: DIM,
            }}
          >
            Public
          </span>
        </div>
        <div style={{ fontSize: 25, color: "#C7D0DD", marginTop: 18 }}>{REPO_DESC}</div>
        <div style={{ marginTop: 18 }}>
          {TOPICS.map((t) => (
            <TopicPill key={t} t={t} />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 40, padding: "10px 40px 34px" }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 21,
              color: DIM,
              padding: "14px 4px",
              borderBottom: `1px solid ${LINE}`,
            }}
          >
            <span>名称</span>
            <span>说明</span>
            <span>更新</span>
          </div>
          {FILES.slice(0, rows).map(([name, note, when]) => (
            <div
              key={name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "13px 4px",
                borderBottom: `1px solid #18202B`,
                fontSize: 23,
              }}
            >
              <span style={{ color: "#8FD8F5", fontFamily: MONO_STACK }}>{name}</span>
              <span style={{ color: DIM, flex: 1, marginLeft: 30 }}>{note}</span>
              <span style={{ color: "#5A6573", fontSize: 20 }}>{when}</span>
            </div>
          ))}
        </div>

        <div style={{ width: 420 }}>
          <div
            style={{
              background: PANEL,
              border: `1px solid ${LINE}`,
              borderRadius: 12,
              padding: "20px 24px",
            }}
          >
            <div style={{ fontSize: 22, color: FG, fontWeight: 700 }}>Releases</div>
            <div style={{ fontSize: 22, color: "#C7D0DD", marginTop: 12 }}>
              <span style={{ color: "#58A6FF" }}>v0.1.2</span> · Latest
              <span
                style={{
                  marginLeft: 10,
                  border: `1px solid ${LINE}`,
                  borderRadius: 999,
                  padding: "3px 12px",
                  fontSize: 18,
                  color: KEEP,
                }}
              >
                未知即中立
              </span>
            </div>
            <div style={{ fontSize: 20, color: DIM, marginTop: 6 }}>含 zip 安装包 · v0.1.1 / v0.1.0 也在</div>
          </div>
          <div
            style={{
              background: PANEL,
              border: `1px solid ${LINE}`,
              borderRadius: 12,
              padding: "20px 24px",
              marginTop: 18,
            }}
          >
            <div style={{ fontSize: 22, color: FG, fontWeight: 700 }}>About</div>
            <div style={{ fontSize: 21, color: DIM, marginTop: 12, lineHeight: 1.7 }}>
              License: <span style={{ color: "#C7D0DD" }}>MIT</span>
              <br />
              Python: <span style={{ color: "#C7D0DD" }}>3.9+</span>
              <br />
              CI: <span style={{ color: KEEP }}>ci.yml 通过</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const StarCta: React.FC<{ from?: number }> = ({ from = 0 }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [from, from + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ opacity: o, display: "flex", gap: 20, alignItems: "center" }}>
      <div
        style={{
          border: `1px solid ${LINE}`,
          borderRadius: 10,
          padding: "12px 24px",
          fontSize: 24,
          color: "#C7D0DD",
          background: PANEL,
        }}
      >
        ☆ Star <span style={{ color: DIM }}>0</span>
      </div>
      <div style={{ fontSize: 26, color: DIM }}>
        仓库还是 0 star —— 如果这个工具帮到你，第一个 star 由你来点
      </div>
    </div>
  );
};
