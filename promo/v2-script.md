# v2 影片脚本与分镜（按 Chrome 插件形态重制）

> FOR-69 产出。定稿依据：FOR-62 issue 文档 `v2-spec` 第 6 节。
> 本版取代 v0.1.x 的两支 CLI 片子：产品形态已改为浏览器插件，旧片的「装 Python / pip / 终端」叙事全部作废。

## 0. 口径总则（三支物料共用）

- **一句话定位**：不用装 Python。打开插件侧栏，它把你的关注列表读全、按语义分类；你说一句话，它把该留的留住、该清的列出来，你点一下确认。
- 三个钩子（顺序固定）：① 零安装负担（zip 解压 → 加载已解压的扩展程序）；② 必须先读全才给结论（进度条与门禁都上镜）；③ 自然语言清理（打字过程实拍，意图渲染 + diff 预览）。
- **数字纪律（硬约束）**：片中出现的所有数量（关注总数、页数、分类计数、diff 影响条数）必须由 FOR-67 的真实登录态抓取会话（B 轨）产出，写成占位符，渲染前用 `promo/tools/fill_numbers.mjs` 从 `docs/qa-report-v2.json` 注入。**禁止在源码里手写数字**。
  占位符：`{{follow_total}}` `{{pages}}` `{{cls.counts}}` `{{diff.n}}` `{{unfollow.done}}`。
- 界面一律用真实插件 UI 录屏或 Side Panel 真实 DOM 截图，不用手绘 mock；`promo/qa.py` 帧质检（空白帧 / 内容触边）必须跑通。
- 合规标注（每支片尾各出现一次，≥1.5s）：`凭据永不出本机 · 昵称与简介只发给你自己指定的模型端点 · 取关是账号操作，可能触发风控，工具不绕签名、可限速、可断点`。

## 1. 产品介绍片 `BiliCleanV2Promo` — 1800 帧 / 60.0 秒（1920x1080 @30fps）

| 段 | 帧区间 | 内容 | 取数/素材 |
|---|---|---|---|
| Hook | 0-130 | B站关注页一路滚到底，页码停在第 `{{pages}}` 页，关注数定格 `{{follow_total}}`；落句：「这里面，你有多久没打开过？」 | B 轨真实会话录屏 |
| Install | 130-330 | 四步：下载 `bili-clean-follow-v2.0.0-extension.zip` → 解压 → `chrome://extensions` 开开发者模式 → 「加载已解压的扩展程序」；图标出现在工具栏。屏上大字：**不用 clone、不用 pip、不用 Python** | 真实录屏 |
| OpenPanel | 330-470 | 点图标 → 侧栏滑出 → 一键「分析我的关注列表」；进度 `1/41 → 41/41`，文本「已取 {{follow_total}} / {{follow_total}}」 | 真实录屏 |
| Gate | 470-600 | 特写：抓取未完成时「开始分类」按钮是灰的，旁边写「还没读全（已取 431/{{follow_total}}）」；字幕：读不全就不给结论 | 真实 UI（可回放中断样本） |
| Classify | 600-830 | 12 张分类卡片，每类带数量与占比：游戏电竞 / 科技数码 / 影视综艺 / 知识教育 / 美食 / 生活日常 / 搞笑段子 / 音乐 / 动漫二次元 / 体育 / 时尚美妆 / 资讯时事；数字来自 `{{cls.counts}}` | 真实分类结果 |
| CommandBar | 830-1080 | 逐字打字：`保留所有游戏区的，把搞笑段子和影视解说都清掉`；下方渲染意图条：`keep[游戏电竞]` `candidates[搞笑段子, 影视综艺]` | 真实指令 |
| Diff | 1080-1280 | diff 预览：影响 `{{diff.n}}` 条 · 按类分组 · 10 条样例带置信度；底部一行固定：**这一步不会取关任何账号** | 真实预览 |
| Guardrails | 1280-1470 | 开启取关能力 → 二次确认卡（写清接口与速率）→ 手输 `UNFOLLOW` → 单次上限 50 · ≥800ms/条 · keep 类白名单 · 遇风控自动熔断 | 真实 UI |
| Audit | 1470-1600 | 审计日志逐条滚动；导出 CSV / Markdown / 取关清单；「一键重新关注」补救按钮高亮 | 真实 UI |
| Honesty | 1600-1720 | 隐私口径改写三行（见 0 节合规标注）；补一句：不填 Key 就走离线粗分类，零外发 | 排版 |
| Cta | 1720-1800 | 先看清，再决定 · v2.0.0 · MIT · Issues 欢迎 · README 顶部有图文安装 | 排版 |

## 2. 插件操作教程片 `WalkthroughV2` — 2700 帧 / 90.0 秒（1920x1080 @30fps）

| 段 | 帧区间 | 内容 |
|---|---|---|
| W1 | 0-120 | 标题：90 秒，从装好到清完 |
| W2 | 120-430 | STEP1 装插件（四步实拍）+ 两个常见坑：开发者模式开关没开；选到了上一层目录（要选解压后的文件夹本身） |
| W3 | 430-700 | STEP2 打开侧栏：未登录时的提示文案与修法；一键抓取，进度与页数；强调「抓全才能分类，半截结果不可用」 |
| W4 | 700-1000 | STEP3 AI 分类：填 Key（DeepSeek / 智谱 / Kimi / 通义 / 自定义 baseURL）；告知弹窗特写（发什么、不发什么、可只发昵称）；批次进度 `batch 15/21` |
| W5 | 1000-1250 | STEP4 分类结果操作：整类保留 / 整类进候选 / 单个 UP 主移动到别的类 / 新建自定义类（例：`AI绘图`） |
| W6 | 1250-1600 | STEP5 自然语言：三条指令依次演示——`清掉搞笑段子`、`把美食和生活日常合并`、`只看游戏区，其它先别动`；每条都渲染意图条 + diff |
| W7 | 1600-1950 | STEP6 武装取关：开关 + 二次确认 + 手输 `UNFOLLOW` + 上限 50 + 速率 800ms/条；执行进度与失败断点续跑 |
| W8 | 1950-2200 | STEP7 审计与补救：审计 CSV 导出、已取关清单落盘、一键重新关注 |
| W9 | 2200-2400 | STEP8 不便装扩展的用户：油猴脚本 `bili-clean.user.js` 只读模式（分析 + 候选清单，不含取关） |
| W10 | 2400-2560 | STEP9 一行说明：Python CLI 已进维护模式，冻结在 v0.1.3，只做安全修复 |
| W11 | 2560-2700 | CTA：README 顶部图文安装 · 常见问题在 Issues · MIT |

## 3. README 内联预览（问题 2 的永久解）

已实测 GitHub README 无法内嵌 mp4 播放器（`<video>` 被 sanitize，mp4 链接只渲染成下载链接），所以每支片必须同时产出 README 内联动画资产：

| 资产 | 规格 | 取材 |
|---|---|---|
| `assets/preview-v2-promo.gif` | 12-16s 精选段 · 480x270 · 8fps · 循环 · **<=8MB** | Install → OpenPanel → Classify → CommandBar → Diff |
| `assets/preview-v2-walkthrough.gif` | 12-16s 精选段 · 480x270 · 8fps · 循环 · **<=8MB** | OpenPanel → Gate → Classify → CommandBar → Guardrails |

- 首选 GIF（GitHub 一定内联自动播）；animated WebP 只作体积优化，且必须先实测该 README 渲染后仍是动画再切换。
- 完整 1080p 影片上传 B站官方号 + YouTube，README 用封面 + 点开即播链接；GitHub Pages 落地页用 `<video controls poster>` 直接播 mp4（mp4 只放 Pages 分支，不进 main 历史）。
- CI 门禁（FOR-66 落）：README 必须引用内联动画资产、资产存在且 <=8MB；mp4 不得是 README 唯一视频入口。

## 4. 渲染命令（沿用现有 Remotion 工程）

```
npm run render:v2          # -> out/bili-clean-v2-promo.mp4（1800 帧）
npm run render:v2:walk     # -> out/bili-clean-v2-walkthrough.mp4（2700 帧）
npm run preview:gif        # -> assets/preview-v2-*.gif（<=8MB 自检）
npm run fill -- --from=docs/qa-report-v2.json   # 注入真实数字，未注入则渲染报错
```

- 新增 comp：`promo/src/promo_v2.tsx`（`BiliCleanV2Promo`）与 `promo/src/walkthrough_v2.tsx`（`WalkthroughV2`）；旧 comp 保留但标注 `@deprecated v0.1.x`。
- 音轨沿用 `tools/gen_bgm.mjs` 自合成，新增一个「确认」短音点缀 Diff→Guardrails 交界处；BPM 与段落切换对齐。
- 配色沿用 `promo/src/theme.tsx`，插件 UI 段落的取景框统一用浏览器窗框（不是终端窗框）——这是 v1/v2 视觉上的最大区别。

> 注：上面四条 npm 脚本目前**还不存在**，由 FOR-70 新增；`promo/README.md` 里现有命令是 v0.1.x 两支旧片的。旧片不再投放，仅作历史素材保留。
