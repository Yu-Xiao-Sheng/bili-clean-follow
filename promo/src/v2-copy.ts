// 两支 v2 影片的文案表（FOR-69 分镜 -> FOR-70 实现）。
// 所有数量一律写成 {{占位符}}，由 promo/src/numbers.ts 的 fmt() 从取证报告注入；
// 这里出现裸数字会被 tests/promo/numbers_gate.test.mjs 判红（白名单只有护栏常量）。
// 分镜出处：promo/v2-script.md 第 1、2 节。

// 护栏常量白名单（插件里的真实默认值，不是会话数字）：50 / 200 / 800 / 12 / 0.55
export const POLICY_CONSTANTS: Record<string, true> = {
  "50": true,
  "200": true,
  "800": true,
  "12": true,
  "0.55": true,
};

export const COMPLIANCE =
  "凭据永不出本机 · 昵称与简介只发给你自己指定的模型端点 · 取关是账号操作，可能触发风控，工具不绕签名、可限速、可断点";

export const PROMO = {
  eyebrow: "Bili Clean Follow v2 · Chrome 插件",
  hook: {
    line1: "关注 {{follow_total}} 个，翻到第 {{pages}} 页才翻到底。",
    line2: "这里面，你有多久没打开过？",
  },
  install: {
    eyebrow: "装它只要四步",
    steps: [
      "下载 bili-clean-follow-v2.0.0-extension.zip",
      "解压到一个文件夹",
      "打开 chrome://extensions，开「开发者模式」",
      "点「加载已解压的扩展程序」，选那个文件夹",
    ],
    big: "不用 clone、不用 pip、不用 Python",
  },
  openPanel: {
    eyebrow: "打开侧栏就能分析",
    caption: "点图标 → 侧栏滑出 → 「读全我的关注列表」",
    progressCaption: "{{partial_fetched}} → {{follow_total}}",
  },
  gate: {
    eyebrow: "没读全，就不给结论",
    locked: "还没读全（已取 {{partial_fetched}}/{{follow_total}}）",
    unlocked: "已取 {{follow_total}}/{{follow_total}} · 分类解锁",
    caption: "fetched == total 是硬门禁：半截列表会让分类结果看起来像结论。",
  },
  classify: {
    eyebrow: "12 类语义分类（BYOK）",
    caption: "{{cls.counts}}",
    topCaption: "最大的一类是 {{cls.top.name}}：{{cls.top.n}} 条（{{cls.top.pct}}%）",
  },
  commandBar: {
    eyebrow: "说一句话就能整理",
    typed: "保留所有游戏区的，把搞笑段子和影视解说都清掉",
    intent: "keep[{{cls.name.game}}]  candidates[{{cls.name.funny}}, {{cls.name.film}}]",
  },
  diff: {
    eyebrow: "执行前先看 diff",
    line: "影响 {{diff.n}} 条 · 按类分组 · 样例带置信度",
    fixed: "这一步不会取关任何账号",
  },
  guardrails: {
    eyebrow: "七条护栏，一条都不能少",
    lines: [
      "取关默认关闭，要主动开开关",
      "没看过 diff 预览就执行不了",
      "要手输 UNFOLLOW（区分大小写）",
      "单次上限 50 条",
      "速率下限 800ms/条",
      "keep 类白名单永不进候选",
      "遇风控立刻熔断 + 审计 + 一键重新关注",
    ],
    typed: "UNFOLLOW",
    done: "已执行 {{unfollow.done}} 条",
  },
  audit: {
    eyebrow: "审计与补救",
    lines: ["审计日志逐条留痕", "导出 CSV / Markdown / 取关清单", "一键重新关注（回填）"],
  },
  honesty: {
    eyebrow: "把边界写清楚",
    lines: [
      "不填 Key：只用离线规则分类，零外发",
      "填了 Key：只发昵称与简介给你自己填的端点",
      COMPLIANCE,
    ],
  },
  cta: {
    line1: "先看清，再决定",
    line2: "Bili Clean Follow v2.0.0 · MIT · Issues 欢迎",
    line3: "README 顶部有图文安装教程",
  },
};

export const WALK = {
  title: "一分半，从装好到清完",
  eyebrow: "插件操作教程 · v2",
  steps: [
    {
      n: "STEP 1",
      title: "装插件",
      caption: "四步：下载 zip → 解压 → 开发者模式 → 加载已解压的扩展程序",
      pitfalls: ["坑 A：「开发者模式」开关没开，按钮不会出现", "坑 B：要选解压后的文件夹本身，不是上一层目录"],
    },
    {
      n: "STEP 2",
      title: "打开侧栏，读全关注列表",
      caption: "未登录会提示先登录 B站；登录后点「读全我的关注列表」",
      statLine: "第 {{pages}} 页 → 第 {{pages}}/{{pages}} 页 · 已取 {{follow_total}} 条",
      warn: "抓全才能分类，半截结果不可用",
    },
    {
      n: "STEP 3",
      title: "AI 分类（BYOK）",
      caption: "DeepSeek / 智谱 / Kimi / 通义 / 自定义 baseURL；告知弹窗写清发什么、不发什么",
      batchLine: "batch {{batch.cur}}/{{batch.total}}",
      note: "不填 Key 就走离线规则分类，零外发",
    },
    {
      n: "STEP 4",
      title: "在分类卡片上动手",
      caption: "整类保留 / 整类进候选 / 单个 UP 主换类 / 新建自定义类（例：AI绘图）",
    },
    {
      n: "STEP 5",
      title: "自然语言指令",
      commands: ["清掉搞笑段子", "把美食和生活日常合并", "只看游戏区，其它先别动"],
      note: "每条都先渲染意图条 + diff 预览，确认才生效",
    },
    {
      n: "STEP 6",
      title: "武装取关",
      caption: "开关 + 二次确认 + 手输 UNFOLLOW + 上限 50 + 速率 800ms/条",
      progressLine: "{{unfollow.done}}/{{diff.n}} 条已执行",
      note: "失败会停在断点，「从断点继续」接着跑",
    },
    {
      n: "STEP 7",
      title: "审计与补救",
      caption: "审计 CSV 导出 · 已取关清单落盘 · 一键重新关注",
    },
    {
      n: "STEP 8",
      title: "不愿装扩展的用户",
      caption: "油猴脚本 bili-clean.user.js：只读模式，分析 + 候选清单，不含取关",
    },
    {
      n: "STEP 9",
      title: "Python CLI 去哪了",
      caption: "CLI 已进维护模式，冻结在 v0.1.3，只做安全修复",
    },
  ],
  cta: {
    lines: ["README 顶部有图文安装教程", "常见问题在 Issues · MIT 开源", COMPLIANCE],
  },
};