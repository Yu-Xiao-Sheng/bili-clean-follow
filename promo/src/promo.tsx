import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import {
  ACCENT, BG, Bar, Counter, DIM, Eyebrow, Fade, FG, FONT_STACK, KEEP, LINE,
  MONO_STACK, PANEL, PANEL_2, Pop, REVIEW, Stage, Stat, TermLine, Window, WARN,
} from "./theme";
import { REPO_URL, RepoPanel, StarCta } from "./repo";

export const FPS = 30;
export const PROMO_FRAMES = 1730;

const termLines: Array<[string, "cmd" | "out" | "dim" | "ok" | "warn"]> = [
  ["pip install -e .", "cmd"],
  ["Successfully installed bili-clean-follow-0.1.2", "out"],
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

const mergeLines: Array<[string, "cmd" | "out" | "dim" | "ok" | "warn"]> = [
  ["bili-merge follows.json --template signals.csv", "cmd"],
  ["第 1 步 · 模板已生成：signals.csv（20 行 · utf-8 BOM · Excel 双击不乱码）", "out"],
  ["  mid 与昵称已预填，你只填 4 个数字列，拿不到的留空", "dim"],
  ["bili-merge follows.json --signals signals.csv --out follows.merged.json", "cmd"],
  ["第 2 步 · 合并信号：19 行给了信号，1 行留空", "out"],
  ["  新增信号字段 57 个 · 已写出 follows.merged.json", "dim"],
  ["bili-clean follows.merged.json --md report.md", "cmd"],
  ["缺信号警告: 0/20 —— recency 齐了，remove 才有依据", "ok"],
  ["Summary: keep=10 review=8 remove=2", "ok"],
];

const Pillar: React.FC<{
  n: string;
  title: string;
  lines: string[];
  color: string;
  from: number;
}> = ({ n, title, lines, color, from }) => (
  <Fade from={from} dur={20}>
    <div
      style={{
        width: 470,
        background: PANEL,
        border: `1px solid ${LINE}`,
        borderTop: `4px solid ${color}`,
        borderRadius: 16,
        padding: "34px 34px 30px",
        minHeight: 360,
      }}
    >
      <div style={{ fontSize: 26, color, fontFamily: MONO_STACK }}>{n}</div>
      <div style={{ fontSize: 42, fontWeight: 700, marginTop: 10 }}>{title}</div>
      <div style={{ marginTop: 22 }}>
        {lines.map((l) => (
          <div key={l} style={{ fontSize: 26, color: DIM, lineHeight: 1.72 }}>
            {l}
          </div>
        ))}
      </div>
    </div>
  </Fade>
);

const Hook: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Stage>
      <Fade>
        <div style={{ fontSize: 40, color: DIM, letterSpacing: 2 }}>打开你的 B站 关注列表</div>
      </Fade>
      <div style={{ marginTop: 26 }}>
        <Counter from={128} to={812} start={6} end={54} />
      </div>
      <Fade from={56} dur={16}>
        <div style={{ fontSize: 52, marginTop: 14 }}>个关注</div>
      </Fade>
      <Fade from={70} dur={20}>
        <div style={{ fontSize: 46, color: DIM, marginTop: 56 }}>
          有多少个，你已经一年没打开过了？
        </div>
      </Fade>
      <div
        style={{
          opacity: interpolate(f, [88, 106], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          marginTop: 46,
        }}
      >
        <Bar width={420} color={WARN} />
      </div>
    </Stage>
  );
};

const Positioning: React.FC = () => (
  <Stage>
    <Img src={staticFile("banner.png")} width={1120} style={{ borderRadius: 14 }} />
    <Fade from={16} dur={18}>
      <div style={{ fontSize: 82, fontWeight: 800, marginTop: 46 }}>
        bili-clean<span style={{ color: ACCENT }}>-follow</span>
      </div>
    </Fade>
    <Fade from={40} dur={20}>
      <div style={{ fontSize: 44, color: DIM, marginTop: 26, textAlign: "center", lineHeight: 1.6 }}>
        它不替你取关。<br />
        它把你 812 个关注摊开，逐条告诉你：留下、再看看、还是可以放走。
      </div>
    </Fade>
  </Stage>
);

const RepoScene: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Stage pad={70}>
      <Fade from={0} dur={14}>
        <div style={{ fontSize: 34, color: DIM, marginBottom: 26 }}>
          项目已开源 · 代码、打分口径、报告格式全部可读
        </div>
      </Fade>
      <RepoPanel from={6} />
      <div style={{ marginTop: 30 }}>
        <StarCta from={120} />
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 40,
          right: 70,
          fontSize: 24,
          color: "#5A6573",
          fontFamily: MONO_STACK,
          opacity: interpolate(f, [140, 160], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}
      >
        MIT License
      </div>
    </Stage>
  );
};

const Steps: React.FC = () => (
  <Stage>
    <Fade>
      <Eyebrow text="四步跑通" />
    </Fade>
    <div style={{ display: "flex", gap: 30, marginTop: 50, alignItems: "stretch" }}>
      {[
        ["01", "导出", "浏览器 F12 → Network\n关注列表响应直接存盘\n（v0.1.2 认 B站 原始信封）", ACCENT],
        ["02", "补信号", "bili-merge 生成待填模板\nExcel 里填 4 个数字列\n拿不到的留空", WARN],
        ["03", "分析", "bili-clean follows.json\n按最近活跃 / 影响力 / 内容相关度\n逐项打分并给理由", KEEP],
        ["04", "审核", "report.md · report.csv · Web 报告\n取关清单你自己导出、自己动手", REVIEW],
      ].map(([n, t, d, c], i) => (
        <Fade key={n} from={16 + i * 20} dur={22}>
          <div
            style={{
              width: 400,
              background: PANEL,
              border: `1px solid ${LINE}`,
              borderRadius: 16,
              padding: "32px 28px",
              minHeight: 340,
            }}
          >
            <div style={{ fontSize: 30, color: c as string, fontFamily: MONO_STACK }}>{n}</div>
            <div style={{ fontSize: 44, fontWeight: 700, marginTop: 8 }}>{t}</div>
            <div style={{ marginTop: 18 }}>
              {(d as string).split("\n").map((line) => (
                <div key={line} style={{ fontSize: 24, color: DIM, lineHeight: 1.7 }}>
                  {line}
                </div>
              ))}
            </div>
          </div>
        </Fade>
      ))}
    </div>
    <Fade from={112} dur={20}>
      <div style={{ fontSize: 30, color: DIM, marginTop: 40 }}>
        全程只读：不调用 unfollow API，不上传 cookie
      </div>
    </Fade>
  </Stage>
);

const Terminal: React.FC = () => {
  const f = useCurrentFrame();
  const shown = Math.ceil(interpolate(f, [14, 150], [0, termLines.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  }));
  return (
    <Stage pad={64}>
      <Fade>
        <div style={{ fontSize: 32, color: DIM, marginBottom: 18 }}>
          真实运行记录 · 示例数据 24 个关注
        </div>
      </Fade>
      <Window width={1600} title="bash — bili-clean-follow" mono from={4}>
        <div style={{ padding: "22px 38px 26px" }}>
          {termLines.map(([text, kind], i) => (
            <TermLine key={i} text={text} kind={kind} show={i < shown} />
          ))}
        </div>
      </Window>
      <div style={{ display: "flex", gap: 70, marginTop: 26 }}>
        <Stat value="13" label="留下（keep）" color={KEEP} from={120} />
        <Stat value="2" label="再看看（review）" color={REVIEW} from={132} />
        <Stat value="9" label="可以放走（remove）" color={WARN} from={144} />
      </div>
    </Stage>
  );
};

const WebScene: React.FC = () => (
  <Stage pad={70}>
    <Fade>
      <div style={{ fontSize: 32, color: DIM, marginBottom: 24 }}>
        本地 Web 报告 · http://127.0.0.1:8787（真实界面截图）
      </div>
    </Fade>
    <Window width={1620} title="bili-clean-follow · 本地报告" from={4}>
      <Img
        src={staticFile("webui.png")}
        style={{ width: 1620, height: 700, objectFit: "cover", objectPosition: "0% 0%" }}
      />
    </Window>
    <Fade from={80} dur={18}>
      <div style={{ fontSize: 28, color: DIM, marginTop: 26 }}>
        分类徽标、得分、原因、导出按钮 —— 都在你自己的机器上渲染
      </div>
    </Fade>
  </Stage>
);

const Promises: React.FC = () => (
  <Stage>
    <Fade>
      <Eyebrow text="三个承诺" />
    </Fade>
    <div style={{ display: "flex", gap: 36, marginTop: 54 }}>
      <Pillar
        n="/ safe"
        title="只报告，不动手"
        lines={["默认 dry-run", "不调用取关接口", "取关清单要人工勾选确认"]}
        color={KEEP}
        from={16}
      />
      <Pillar
        n="/ transparent"
        title="每一条都有理由"
        lines={["三项信号加权", "score 与 reason 一起导出", "缺哪些信号也写进 CSV（missing_signals）"]}
        color={ACCENT}
        from={34}
      />
      <Pillar
        n="/ local"
        title="本地跑，零依赖"
        lines={["Python 3.9+ 标准库", "不联网上传你的列表", "内容里出现 cookie 键才拒读，点名键名"]}
        color={REVIEW}
        from={52}
      />
    </div>
  </Stage>
);

const Honesty: React.FC = () => (
  <Stage>
    <Fade>
      <Eyebrow text="打分口径：未知即中立" color={WARN} />
    </Fade>
    <Fade from={20} dur={22}>
      <div style={{ fontSize: 56, fontWeight: 800, marginTop: 44, maxWidth: 1460, lineHeight: 1.45 }}>
        B站 公开接口只给昵称和签名。<br />
        <span style={{ color: WARN }}>没有「最近活跃」，就不该建议你把人取关。</span>
      </div>
    </Fade>
    <Fade from={64} dur={22}>
      <div style={{ fontSize: 32, color: DIM, marginTop: 40, lineHeight: 1.85, maxWidth: 1400 }}>
        v0.1.1 把「不知道」按最低分算，真实导出会一边倒建议取关 —— 那是 bug，我们公开承认了。<br />
        v0.1.2 改成中立：缺 recency 一律不进 remove，报告顶部还会打一行缺信号警告。
      </div>
    </Fade>
    <div style={{ display: "flex", gap: 34, marginTop: 44, alignItems: "center" }}>
      <Fade from={112} dur={18}>
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderLeft: `4px solid ${WARN}`, borderRadius: 12, padding: "22px 30px" }}>
          <div style={{ fontSize: 24, color: DIM }}>v0.1.1 · 真实导出 20 条</div>
          <div style={{ fontSize: 30, fontWeight: 700, marginTop: 10, fontFamily: MONO_STACK, color: WARN }}>
            remove 一堆 · 全无依据
          </div>
        </div>
      </Fade>
      <Fade from={126} dur={14}>
        <div style={{ fontSize: 40, color: DIM }}>→</div>
      </Fade>
      <Fade from={136} dur={18}>
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderLeft: `4px solid ${KEEP}`, borderRadius: 12, padding: "22px 30px" }}>
          <div style={{ fontSize: 24, color: DIM }}>v0.1.2 · 同一份数据</div>
          <div style={{ fontSize: 30, fontWeight: 700, marginTop: 10, fontFamily: MONO_STACK, color: KEEP }}>
            keep=0 review=20 remove=0
          </div>
        </div>
      </Fade>
    </div>
    <Fade from={168} dur={18}>
      <div style={{ fontSize: 26, color: "#5A6573", marginTop: 32 }}>
        这条写在 CHANGELOG 里，而不是藏起来。
      </div>
    </Fade>
  </Stage>
);

const MergeSignal: React.FC = () => {
  const f = useCurrentFrame();
  const shown = Math.ceil(interpolate(f, [16, 150], [0, mergeLines.length], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  }));
  return (
    <Stage pad={64}>
      <Fade>
        <div style={{ fontSize: 32, color: DIM, marginBottom: 22 }}>
          缺的信号怎么补 · <span style={{ color: FG, fontFamily: MONO_STACK }}>bili-merge</span>（v0.1.2 新增，纯本地不联网）
        </div>
      </Fade>
      <Window width={1600} title="bash — bili-merge" mono from={4}>
        <div style={{ padding: "26px 38px 30px" }}>
          {mergeLines.map(([text, kind], i) => (
            <TermLine key={i} text={text} kind={kind} show={i < shown} />
          ))}
        </div>
      </Window>
      <div style={{ display: "flex", gap: 60, marginTop: 34 }}>
        <Stat value="+57" label="补上的信号字段（Excel 里填 4 列）" color={ACCENT} from={120} />
        <Stat value="1 条" label="仍然留空 —— 只进 review，不建议取关" color={REVIEW} from={134} />
        <Stat value="10/8/2" label="keep / review / remove，补完信号之后" color={KEEP} from={148} />
      </div>
    </Stage>
  );
};

const Cta: React.FC = () => (
  <Stage>
    <Img src={staticFile("logo.png")} width={130} style={{ borderRadius: 24 }} />
    <Fade from={12} dur={18}>
      <div style={{ fontSize: 72, fontWeight: 800, marginTop: 34 }}>
        先看清，再决定
      </div>
    </Fade>
    <Fade from={40} dur={20}>
      <div
        style={{
          marginTop: 40,
          fontFamily: MONO_STACK,
          fontSize: 34,
          color: FG,
          background: PANEL,
          border: `1px solid ${LINE}`,
          borderRadius: 12,
          padding: "22px 40px",
        }}
      >
        git clone https://{REPO_URL}.git
      </div>
    </Fade>
    <Fade from={70} dur={20}>
      <div style={{ display: "flex", gap: 44, marginTop: 40, fontSize: 28, color: DIM }}>
        <span>MIT 许可</span>
        <span>Python 3.9+</span>
        <span>Issues 欢迎 —— 尤其是「真实数据跑坏了」的报告</span>
      </div>
    </Fade>
    <Fade from={110} dur={20}>
      <div style={{ marginTop: 46 }}>
        <Bar width={520} />
      </div>
    </Fade>
  </Stage>
);

const Seg: React.FC<{
  name: string;
  from: number;
  dur: number;
  children: React.ReactNode;
  dir?: "up" | "down" | "none";
}> = ({ from, dur, children, dir = "up" }) => {
  const f = useCurrentFrame();
  const local = f - from;
  const outDur = 14;
  const inY = dir === "none" ? 0 : dir === "up" ? -60 : 60;
  const dy = interpolate(local, [0, Math.min(dur, 20)], [inY, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const dyOut = interpolate(local, [dur - outDur, dur], [0, dir === "none" ? 0 : (dir === "up" ? 40 : -40)], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const o = interpolate(local, [0, 10, dur - outDur, dur], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ opacity: o, transform: `translateY(${dy + dyOut}px)` }}>
      <AbsoluteFill style={{ backgroundColor: BG }} />
      {children}
    </AbsoluteFill>
  );
};

export const PromoV2: React.FC = () => {
  const frames = [0, 110, 230, 420, 590, 800, 950, 1170, 1390, 1550];
  const comps = [Hook, Positioning, RepoScene, Steps, Terminal, WebScene, Honesty, MergeSignal, Promises, Cta];
  const widths = frames.map((s, i) => (i + 1 < frames.length ? frames[i + 1] - s : PROMO_FRAMES - s));
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      {comps.map((C, i) => (
        <Seg key={i} name={C.name} from={frames[i]} dur={widths[i]} dir="up">
          <C />
        </Seg>
      ))}
      <AbsoluteFill
        style={{
          pointerEvents: "none",
          justifyContent: "flex-end",
          alignItems: "flex-start",
          padding: 40,
        }}
      >
        <div style={{ fontFamily: MONO_STACK, fontSize: 22, color: "#455063" }}>
          bili-clean-follow · v0.1.2 · MIT
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
