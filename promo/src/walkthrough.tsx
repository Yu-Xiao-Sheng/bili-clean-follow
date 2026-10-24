import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, staticFile, useCurrentFrame, Easing } from "remotion";
import {
  ACCENT, BG, Bar, DIM, Eyebrow, Fade, FG, KEEP, LINE, MONO_STACK, PANEL,
  PANEL_2, Stage, Stat, TermLine, Window, WARN, REVIEW,
} from "./theme";
import { REPO_URL } from "./repo";

export const WALK_FRAMES = 1850;

export const StepTitle: React.FC<{
  n: string;
  title: string;
  sub: string;
  color?: string;
}> = ({ n, title, sub, color = ACCENT }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginBottom: 28 }}>
    <div
      style={{
        fontFamily: MONO_STACK,
        fontSize: 30,
        color,
        border: `2px solid ${color}`,
        borderRadius: 999,
        padding: "8px 22px",
      }}
    >
      STEP {n}
    </div>
    <div style={{ fontSize: 56, fontWeight: 800 }}>{title}</div>
    <div style={{ fontSize: 28, color: DIM }}>{sub}</div>
  </div>
);

const RESP_LINES: Array<[string, string]> = [
  ['{', "p"],
  ['  "code": 0,', "k"],
  ['  "message": "0",', "k"],
  ['  "ttl": 1,', "k"],
  ['  "data": {', "k"],
  ['    "page": 1, "pagesize": 20, "total": 812,', "k"],
  ['    "follower": [', "k"],
  ['      { "mid": 22333, "uname": "极客湾Geekerwan",', "s"],
  ['        "sign": "科技美学评测",', "s"],
  ['        "official_verify": { "type": -1 } },', "s"],
  ['      ...', "d"],
  ['    ]', "k"],
  ['  }', "k"],
  ['}', "p"],
];

const ReqRow: React.FC<{ name: string; status: string; type: string; hit?: boolean }> = ({
  name,
  status,
  type,
  hit,
}) => (
  <div
    style={{
      display: "flex",
      gap: 26,
      padding: "11px 22px",
      fontSize: 22,
      fontFamily: MONO_STACK,
      background: hit ? "#12303F" : "transparent",
      color: hit ? "#9FE4FF" : "#B9C4D2",
      borderLeft: hit ? `3px solid ${ACCENT}` : "3px solid transparent",
    }}
  >
    <span style={{ width: 430, overflow: "hidden", whiteSpace: "nowrap" }}>{name}</span>
    <span style={{ color: status === "200" ? KEEP : WARN }}>{status}</span>
    <span style={{ color: DIM }}>{type}</span>
  </div>
);

export const Devtools: React.FC<{ from?: number }> = ({ from = 0 }) => {
  const f = useCurrentFrame();
  const shown = Math.ceil(
    interpolate(f, [from + 24, from + 96], [0, RESP_LINES.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  return (
    <Window width={1620} title="DevTools · Network · api.bilibili.com" mono from={from}>
      <div style={{ display: "flex" }}>
        <div style={{ width: 700, borderRight: `1px solid ${LINE}`, padding: "16px 0" }}>
          <div style={{ display: "flex", gap: 24, padding: "0 22px 14px", fontSize: 22, color: DIM }}>
            {["Elements", "Console", "Network", "Application"].map((t, i) => (
              <span key={t} style={{ color: i === 2 ? FG : DIM, borderBottom: i === 2 ? `2px solid ${ACCENT}` : "none", paddingBottom: 6 }}>
                {t}
              </span>
            ))}
          </div>
          <ReqRow name="tag?" status="200" type="xhr" />
          <ReqRow name="favorites?" status="200" type="xhr" />
          <ReqRow name="relation/followers?vmid=…&pn=1&ps=20" status="200" type="xhr" hit />
          <ReqRow name="wbi/…?webp=1" status="200" type="image" />
          <div style={{ padding: "18px 22px 0", fontSize: 21, color: DIM, lineHeight: 1.7 }}>
            关注列表是分页接口：pn=1..41 才能拉完 812 个
          </div>
        </div>
        <div style={{ flex: 1, padding: "18px 30px 24px" }}>
          <div style={{ fontSize: 21, color: DIM, marginBottom: 12 }}>Response · application/json</div>
          {RESP_LINES.map(([txt, kind], i) => (
            <div
              key={i}
              style={{
                opacity: i < shown ? 1 : 0,
                fontFamily: MONO_STACK,
                fontSize: 24,
                lineHeight: 1.62,
                whiteSpace: "pre",
                color: kind === "k" ? "#7EE2FF" : kind === "s" ? "#E5C07B" : kind === "d" ? DIM : FG,
              }}
            >
              {txt}
            </div>
          ))}
        </div>
      </div>
    </Window>
  );
};

const T1: Array<[string, "cmd" | "out" | "dim" | "ok" | "warn"]> = [
  ["git clone https://github.com/Yu-Xiao-Sheng/bili-clean-follow.git", "cmd"],
  ["cd bili-clean-follow", "cmd"],
  ["pip install -e .", "cmd"],
  ["Successfully installed bili-clean-follow-0.1.2", "ok"],
  ["bili-clean --version", "cmd"],
  ["bili-clean 0.1.2", "out"],
];

const T2: Array<[string, "cmd" | "out" | "dim" | "ok" | "warn"]> = [
  ["python -m bili.demo", "cmd"],
  ["Sample follows written to sample-follows.json", "out"],
  ["bili-clean sample-follows.json \\", "cmd"],
  ["    --md report.md --csv report.csv \\", "cmd"],
  ["    --unfollow-list to-unfollow.txt", "cmd"],
  ["Markdown report written to report.md", "dim"],
  ["CSV written to report.csv", "dim"],
  ["Summary: keep=13 review=2 remove=9", "ok"],
  ["Unfollow list written to to-unfollow.txt (9 ids, mid + nickname)", "dim"],
  ["Done. This tool reports only; it never unfollows by itself.", "dim"],
];

const T3: Array<[string, "cmd" | "out" | "dim" | "ok" | "warn"]> = [
  ["python -m bili.web --input sample-follows.json --port 8787", "cmd"],
  ["Serving local report on http://127.0.0.1:8787", "out"],
  ["(浏览器打开即可，Ctrl+C 结束)", "dim"],
];

const T4: Array<[string, "cmd" | "out" | "dim" | "ok" | "warn"]> = [
  ["bili-clean follows.json --md report.md", "cmd"],
  ["缺信号警告: 20/20 的记录没有 recency 信号", "warn"],
  ["Summary: keep=0 review=20 remove=0", "ok"],
  ["bili-merge follows.json --template signals.csv", "cmd"],
  ["第 1 步 · 模板已生成（20 行，mid + 昵称已预填，Excel 直接填）", "out"],
  ["  要填 4 列：last_seen_days / last_video_days / follower / following", "dim"],
  ["bili-merge follows.json --signals signals.csv --out follows.merged.json", "cmd"],
  ["第 2 步 · 合并：新增 57 个信号字段，1 行留空", "out"],
  ["bili-clean follows.merged.json --md report.md", "cmd"],
  ["Summary: keep=10 review=8 remove=2", "ok"],
];

const TermScene: React.FC<{
  lines: Array<[string, "cmd" | "out" | "dim" | "ok" | "warn"]>;
  step: string;
  title: string;
  sub: string;
  color?: string;
  typeStart?: number;
  typeEnd?: number;
}> = ({ lines, step, title, sub, color, typeStart = 26, typeEnd = 150 }) => {
  const f = useCurrentFrame();
  const shown = Math.ceil(
    interpolate(f, [typeStart, typeEnd], [0, lines.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    })
  );
  return (
    <Stage pad={70}>
      <StepTitle n={step} title={title} sub={sub} color={color} />
      <Window width={1620} title="bash — bili-clean-follow" mono from={8}>
        <div style={{ padding: "28px 40px 32px" }}>
          {lines.map(([t, k], i) => (
            <TermLine key={i} text={t} kind={k} show={i < shown} />
          ))}
        </div>
      </Window>
    </Stage>
  );
};

const JsonCard: React.FC<{ from?: number }> = ({ from = 0 }) => {
  const lines = [
    '{',
    '  "follower_id": "22333",',
    '  "nickname": "极客湾Geekerwan",',
    '  "bio": "科技美学评测",',
    '  "last_seen_days": 6,      // 你上次看到他',
    '  "last_video_days": 3,     // 他最近一次更新',
    '  "follower_count": 1804220,',
    '  "following_count": 41',
    '}',
  ];
  return (
    <Fade from={from}>
      <Window width={760} title="follows.json · 一行记录" mono>
        <div style={{ padding: "26px 34px 30px" }}>
          {lines.map((l, i) => (
            <div
              key={i}
              style={{
                fontFamily: MONO_STACK,
                fontSize: 25,
                lineHeight: 1.7,
                whiteSpace: "pre",
                color: l.includes("//") ? DIM : i === 0 ? FG : "#C7D0DD",
              }}
            >
              {l}
            </div>
          ))}
        </div>
      </Window>
    </Fade>
  );
};

const W1: React.FC = () => (
  <Stage>
    <Fade>
      <Eyebrow text="使用教程" />
    </Fade>
    <Fade from={18} dur={20}>
      <div style={{ fontSize: 84, fontWeight: 800, marginTop: 40 }}>90 秒跑通一遍</div>
    </Fade>
    <Fade from={46} dur={20}>
      <div style={{ fontSize: 36, color: DIM, marginTop: 30, lineHeight: 1.8, textAlign: "center" }}>
        导出 → 安装 → 分析 → 补信号 → Web 报告 → 取关清单
      </div>
    </Fade>
    <Fade from={74} dur={20}>
      <div style={{ fontSize: 26, color: "#5A6573", marginTop: 34 }}>
        第 3 步用仓库自带的示例数据，第 4 步换成你自己的导出
      </div>
    </Fade>
  </Stage>
);

const W2: React.FC = () => (
  <Stage pad={70}>
    <StepTitle n="1" title="导出关注列表" sub="浏览器 F12 · 只读，不用交 cookie 给第三方" />
    <Devtools from={10} />
    <Fade from={110} dur={20}>
      <div style={{ fontSize: 27, color: DIM, marginTop: 24, lineHeight: 1.7, width: 1620, textAlign: "center" }}>
        把响应整个另存为 <span style={{ fontFamily: MONO_STACK, color: FG }}>follows.json</span>
        ：v0.1.2 直接认 <span style={{ fontFamily: MONO_STACK, color: FG }}>code / data.follower</span> 这层信封，昵称也认{" "}
        <span style={{ fontFamily: MONO_STACK, color: FG }}>uname</span> —— 不用手工解包、不用改字段名
      </div>
    </Fade>
  </Stage>
);

const W3: React.FC = () => <TermScene lines={T1} step="2" title="安装" sub="pip install -e . · 或下载 Release 里的 zip" typeEnd={90} />;

const W4: React.FC = () => {
  const f = useCurrentFrame();
  const shown = Math.ceil(
    interpolate(f, [30, 130], [0, T2.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    })
  );
  return (
    <Stage pad={70}>
      <StepTitle n="3" title="跑分析" sub="默认 dry-run，不碰账号" color={KEEP} />
      <Window width={1500} title="bash — bili-clean-follow" mono from={8}>
        <div style={{ padding: "24px 36px 28px" }}>
          {T2.map(([t, k], i) => (
            <TermLine key={i} text={t} kind={k} show={i < shown} />
          ))}
        </div>
      </Window>
      <div style={{ display: "flex", gap: 40, marginTop: 30 }}>
      <Stat value="report.md" label="给人读的清单" color={FG} from={150} />
      <Stat value="report.csv" label="给 Excel / 表格用" color={FG} from={160} />
      <Stat value="清单 3 份" label="report.md / report.csv / to-unfollow.txt" color={FG} from={170} />
    </div>
    </Stage>
  );
};

const WSig: React.FC = () => {
  const f = useCurrentFrame();
  const shown = Math.ceil(
    interpolate(f, [26, 160], [0, T4.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    })
  );
  return (
    <Stage pad={64}>
      <StepTitle n="4" title="补上信号" sub="你自己的导出只有昵称和签名 · bili-merge 帮你填" color={WARN} />
      <Window width={1620} title="bash — 你的 follows.json（20 个关注）" mono from={8}>
        <div style={{ padding: "22px 34px 26px" }}>
          {T4.map(([t, k], i) => (
            <TermLine key={i} text={t} kind={k} show={i < shown} />
          ))}
        </div>
      </Window>
      <Fade from={186} dur={18}>
        <div style={{ fontSize: 26, color: DIM, marginTop: 24, lineHeight: 1.7 }}>
          补信号前 <span style={{ fontFamily: MONO_STACK, color: WARN }}>remove=0</span> 不是「一个都不用取」，是没有依据；
          留空 = 未知，未知只会进 review。
        </div>
      </Fade>
    </Stage>
  );
};

const W5: React.FC = () => (
  <Stage pad={70}>
    <StepTitle n="5" title="打开 Web 报告" sub="本机 http://127.0.0.1:8787" color={REVIEW} />
    <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
      <Window width={620} title="bash" mono from={8}>
        <div style={{ padding: "24px 30px 28px" }}>
          {T3.map(([t, k], i) => (
            <TermLine key={i} text={t} kind={k} show />
          ))}
        </div>
      </Window>
      <Window width={980} title="bili-clean-follow · 本地报告" from={20}>
        <Img
          src={staticFile("webui.png")}
          style={{ width: 980, height: 560, objectFit: "cover", objectPosition: "0% 0%" }}
        />
      </Window>
    </div>
    <Fade from={90} dur={18}>
      <div style={{ fontSize: 27, color: DIM, marginTop: 26 }}>
        点分类筛选、按得分排序、勾确认后再导出取关清单
      </div>
    </Fade>
  </Stage>
);

const W6: React.FC = () => (
  <Stage pad={70}>
    <StepTitle n="6" title="输入格式长什么样" sub="一行一个关注，字段可以缺省" color={ACCENT} />
    <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
      <div style={{ width: 780 }}>
        {[
          ["字段名自动对上", "B站 返回的 uname / name 就是昵称，code + data.follower 信封自动解包，不用手工改"],
          ["缺的字段留空就行", "公开接口没有「最近活跃」——缺信号的账号只进 review，不会被建议取关"],
          ["认证看 official 字段", "official.role / title / department 与 official_verify.type 都会进相关性判断"],
        ].map(([t, d], i) => (
          <Fade key={t} from={20 + i * 24} dur={20}>
            <div
              style={{
                background: PANEL,
                border: `1px solid ${LINE}`,
                borderLeft: `4px solid ${ACCENT}`,
                borderRadius: 14,
                padding: "22px 30px",
                marginBottom: 22,
              }}
            >
              <div style={{ fontSize: 34, fontWeight: 700 }}>{t}</div>
              <div style={{ fontSize: 25, color: DIM, marginTop: 10, lineHeight: 1.7 }}>{d}</div>
            </div>
          </Fade>
        ))}
        <Fade from={100}>
          <div style={{ fontSize: 25, color: "#5A6573", lineHeight: 1.7 }}>
            跑坏了？把 report 和脱敏后的 follows.json 结构发到 Issues，我们照着修。
          </div>
        </Fade>
      </div>
      <JsonCard from={40} />
    </div>
  </Stage>
);

const W7: React.FC = () => (
  <Stage>
    <Fade>
      <div style={{ fontSize: 30, color: DIM }}>第 7 步 · 决定权在你</div>
    </Fade>
    <Fade from={22} dur={20}>
      <div style={{ fontSize: 72, fontWeight: 800, marginTop: 34 }}>
        工具只到 <span style={{ color: WARN }}>清单</span> 为止
      </div>
    </Fade>
    <Fade from={56} dur={22}>
      <div style={{ fontSize: 32, color: DIM, marginTop: 34, lineHeight: 1.9, maxWidth: 1360, textAlign: "center" }}>
        拿着 to-unfollow.txt 在 B站 手动取关；<br />
        这个工具从不调用取关接口，也不会把你的 cookie 传到任何地方。
      </div>
    </Fade>
    <Fade from={110} dur={20}>
      <div style={{ marginTop: 40 }}>
        <Bar width={480} />
      </div>
    </Fade>
  </Stage>
);

const W8: React.FC = () => (
  <Stage>
    <Img src={staticFile("logo.png")} width={120} style={{ borderRadius: 22 }} />
    <Fade from={12} dur={18}>
      <div style={{ fontSize: 64, fontWeight: 800, marginTop: 30 }}>先看清，再决定</div>
    </Fade>
    <Fade from={40} dur={20}>
      <div
        style={{
          marginTop: 34,
          fontFamily: MONO_STACK,
          fontSize: 32,
          background: PANEL,
          border: `1px solid ${LINE}`,
          borderRadius: 12,
          padding: "20px 36px",
        }}
      >
        git clone https://{REPO_URL}.git
      </div>
    </Fade>
    <Fade from={70} dur={18}>
      <div style={{ fontSize: 26, color: DIM, marginTop: 32 }}>MIT · Python 3.9+ · 欢迎提 Issue</div>
    </Fade>
  </Stage>
);

export const Walkthrough: React.FC = () => {
  const frames = [0, 110, 370, 550, 790, 1040, 1270, 1470, 1650];
  const comps = [W1, W2, W3, W4, WSig, W5, W6, W7, W8];
  const widths = frames.map((s, i) => (i + 1 < frames.length ? frames[i + 1] - s : WALK_FRAMES - s));
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {comps.map((C, i) => {
        const from = frames[i];
        const dur = widths[i];
        return (
          <WalkSeg key={i} from={from} dur={dur}>
            <C />
          </WalkSeg>
        );
      })}
      {/* 本地合成音轨（tools/gen_bgm.mjs），教程片里压得更低 */}
      <Audio src={staticFile("audio/bgm-walk.wav")} volume={0.42} />
      <AbsoluteFill style={{ pointerEvents: "none", justifyContent: "flex-end", padding: 40 }}>
        <div style={{ fontFamily: MONO_STACK, fontSize: 22, color: "#455063" }}>
          bili-clean-follow · 使用教程 · v0.1.2
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const WalkSeg: React.FC<{ from: number; dur: number; children: React.ReactNode }> = ({
  from,
  dur,
  children,
}) => {
  const f = useCurrentFrame();
  const local = f - from;
  const o = interpolate(local, [0, 10, dur - 12, dur], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dy = interpolate(local, [0, 16], [36, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <AbsoluteFill style={{ opacity: o, transform: `translateY(${dy}px)` }}>
      <AbsoluteFill style={{ backgroundColor: BG }} />
      {children}
    </AbsoluteFill>
  );
};
