# bili-clean-follow 视频工程（Remotion）

用 Remotion 以代码方式产出产品视频，所有文案与排版可 diff、可复用。

## 环境

- Node 20+（本轮实测 Node 24.21.0 / npm 11.19.0）
- 安装：`npm install`（会带 Chrome Headless Shell，首渲时自动下载，约 80 MB）

## 命令

> v2 两支新片（Chrome 插件形态）的段表与出片顺序在下面「v2 两支新片（FOR-70）」一节；本节命令是 v0.1.x 旧片的，保留作历史素材。


```
npm run studio                 # 浏览器里实时预览（默认 :3000）
npm run render                 # 产品介绍片 -> out/bili-clean-promo.mp4（1920x1080 @30fps）
npm run render:walk            # 使用教程片 -> out/bili-clean-walkthrough.mp4
npm run render:master          # 两支一起出
npm run bgm                    # 只重新生成音轨（render 已自动带上这一步）
npm run still:promo -- --frame=550 --out=out/x.png   # 单帧校对排版与中文字形
npx remotion still Walkthrough out/w.png --frame=1020
python tools/shot_webui.py     # 用当前 src/bili 的界面重截 webui.png
python qa.py out/v3/*.png      # 帧质检：空白帧 / 内容触边（需 pillow）
```

`--crf=20` 已写进 render 脚本：53–62 秒的 1080p30 成片压在 GitHub Release 附件 10 MB 上限内。
音轨由 `tools/gen_bgm.mjs` 本地合成（和弦垫 + 琶音 + 轻 kick + hat，master 归一化），
时长精确对齐成片帧数；`public/audio/*.wav` 不提交，`npm run render` 会先生成。

## 两支成片（口径对齐 v0.1.2）

### 1. 产品介绍片 `BiliCleanPromo` — 1730 帧 / 57.7 秒

| 段 | 帧区间 | 内容 |
|---|---|---|
| Hook | 0-110 | 关注数从 128 跳到 812，落在「有多少个你已经一年没打开过」 |
| Positioning | 110-230 | 一句话定位：它不替你取关，只把 812 个关注摊开 |
| RepoScene | 230-420 | GitHub 仓库实景：Releases v0.1.2（Latest）、230 个测试用例、MIT |
| Steps | 420-590 | 四步：导出 / 补信号 / 分析 / 审核 |
| Terminal | 590-800 | 真实运行记录（示例 24 条 -> keep=13 review=2 remove=9） |
| WebScene | 800-950 | 本地 Web 报告真实截图（127.0.0.1:8787） |
| Honesty | 950-1170 | 打分口径：未知即中立。v0.1.1 把「不知道」按最低分算是 bug，v0.1.2 同一份真实导出 -> keep=0 review=20 remove=0 |
| MergeSignal | 1170-1390 | `bili-merge` 补信号：+57 个信号字段 -> keep=10 review=8 remove=2 |
| Promises | 1390-1550 | 三个承诺：只报告 / 可解释（CSV 带 missing_signals）/ 本地零依赖 |
| Cta | 1550-1730 | 先看清，再决定 · MIT · 欢迎 Issues |

### 2. 使用教程片 `Walkthrough` — 1850 帧 / 61.7 秒

| 段 | 帧区间 | 内容 |
|---|---|---|
| W1 | 0-110 | 90 秒跑通一遍 |
| W2 | 110-370 | STEP 1 导出：浏览器 F12 Network；v0.1.2 直接认 `code` / `data.follower` 信封与 `uname`，不用手工解包 |
| W3 | 370-550 | STEP 2 安装：`pip install -e .` / Release zip |
| W4 | 550-790 | STEP 3 跑分析：内置示例 -> keep=13 review=2 remove=9，三份产物 |
| WSig | 790-1040 | STEP 4 补信号：真实导出 20 条先打缺信号警告（keep=0 review=20 remove=0），`bili-merge` 填完 -> keep=10 review=8 remove=2 |
| W5 | 1040-1270 | STEP 5 Web 报告：筛选 / 排序 / 勾选导出取关清单 |
| W6 | 1270-1470 | STEP 6 输入格式：字段名自动对上、缺的留空、认证看 `official_*` |
| W7 | 1470-1650 | STEP 7 决定权在你：清单只到人工核对为止 |
| W8 | 1650-1850 | CTA |

## 文案的事实来源

片子里每一条终端输出都不是手写剧本，而是 v0.1.2 在 Windows / Python 3.13.15 上真实跑出来的：

- 示例数据：`python -m bili.demo` + `bili-clean sample-follows.json` -> `Summary: keep=13 review=2 remove=9`
- 真实形状夹具（`tests/fixture-bili-real-list.json`，20 条，只有昵称和签名）：
  补信号前 `缺信号警告: 20/20 (100%) 的记录没有 recency 信号` + `Summary: keep=0 review=20 remove=0`
- 同一份夹具经 `bili-merge --template` / `--signals` 补齐后：`新增信号字段 57 个`、`Summary: keep=10 review=8 remove=2`
- 仓库面板里的 `230 个用例` = `python -m pytest -q` 的实际结果（v0.1.2，230 passed）

改代码前后请重跑上面三条命令，别让片子讲一个已经过时的版本。

## v2 两支新片（FOR-70 · Chrome 插件形态）

分镜与口径见 [v2-script.md](v2-script.md)（FOR-69 定稿）。旧的两支 CLI 片不再投放，只作历史素材保留。

### 1. 产品介绍片 `BiliCleanV2Promo` — 1800 帧 / 60.0 秒（1920x1080 @30fps）

| 段 | 帧区间 | 内容 | 素材 |
|---|---|---|---|
| Hook | 0-130 | 关注 `{{follow_total}}` 个 / 第 `{{pages}}` 页；「这里面，你有多久没打开过？」 | 数字注入 + 排版 |
| Install | 130-330 | 四步装插件（zip → 解压 → 开发者模式 → 加载已解压的扩展程序）；大字「不用 clone、不用 pip、不用 Python」 | 排版 |
| OpenPanel | 330-470 | 侧栏滑出，一键读全 | `public/v2/scan-complete.png` |
| Gate | 470-600 | 读全门禁：没读全时「开始分类」是灰的，旁边写「还没读全（已取 `{{partial_fetched}}`/`{{follow_total}}`）」 | `public/v2/scan-partial.png` |
| Classify | 600-830 | 12 张分类卡片，数量与占比来自 `{{cls.counts}}` | 注入数字 + `public/v2/classify-cards.png` |
| CommandBar | 830-1080 | 逐字打字「保留所有游戏区的，把搞笑段子和影视解说都清掉」+ 意图条 | `public/v2/command-bar.png` |
| Diff | 1080-1280 | diff 预览 `{{diff.n}}` 条 · 按类分组 · 「这一步不会取关任何账号」 | `public/v2/diff-preview.png` |
| Guardrails | 1280-1470 | 七条护栏 + 二次确认卡 + 手输 UNFOLLOW + 已执行 `{{unfollow.done}}` 条 | `public/v2/unfollow-token.png` |
| Audit | 1470-1600 | 审计逐条 + 导出 + 一键重新关注 | `public/v2/audit-list.png` |
| Honesty | 1600-1720 | 隐私口径三行（不填 Key 零外发） | 排版 |
| Cta | 1720-1800 | 先看清，再决定 · v2.0.0 · MIT | 排版 |

### 2. 插件操作教程片 `WalkthroughV2` — 2700 帧 / 90.0 秒（1920x1080 @30fps）

| 段 | 帧区间 | 内容 | 素材 |
|---|---|---|---|
| W1 | 0-120 | 标题 | 排版 |
| W2 | 120-430 | STEP1 装插件 + 两个常见坑 | 排版 |
| W3 | 430-700 | STEP2 读全：进度与页数、抓全才能分类 | `scan-partial.png` + `scan-complete.png` |
| W4 | 700-1000 | STEP3 AI 分类（BYOK、告知弹窗、`batch {{batch.cur}}/{{batch.total}}`） | `classify-cards.png` |
| W5 | 1000-1250 | STEP4 分类卡片上的操作 | `classify-cards.png` |
| W6 | 1250-1600 | STEP5 自然语言三条指令（逐字打字 + 意图条） | `command-bar.png` |
| W7 | 1600-1950 | STEP6 武装取关：开关 / 二次确认 / UNFOLLOW / 上限 / 速率 | `guardrail-risk.png` + `unfollow-token.png` |
| W8 | 1950-2200 | STEP7 审计与补救 | `audit-list.png` |
| W9 | 2200-2400 | STEP8 油猴脚本只读模式 | 排版 |
| W10 | 2400-2560 | STEP9 Python CLI 已进维护模式（冻结 v0.1.3） | 排版 |
| W11 | 2560-2700 | CTA | 排版 |

### 出片顺序（每一步都可能把你挡下，这是设计如此）

```
npm run fill          # docs/qa-report-v2.json -> src/numbers.generated.ts；报告不在就退出码 1
npm run capture:v2    # 把 extension/sidepanel.* 当页面加载，拍 8 张真实侧栏 DOM 截图 -> public/v2/
npm run render:v2     # -> out/bili-clean-v2-promo.mp4（1800 帧）
npm run render:v2:walk# -> out/bili-clean-v2-walkthrough.mp4（2700 帧）
npm run preview:gif   # -> ../assets/preview-v2-promo.gif / preview-v2-walkthrough.gif（480x270 · 8fps · <=8MB）
npm run film:v2       # 上面全部串起来
```

- **数字门禁**：`src/numbers.generated.ts` 是 stub 时，两支片渲染会在第一帧之前抛错。占位符集合见 `src/numbersCore.mjs`
  （`{{follow_total}}` `{{pages}}` `{{partial_fetched}}` `{{cls.counts}}` `{{cls.count.<类目 id>}}` `{{diff.n}}` `{{unfollow.done}}` `{{batch.cur}}/{{batch.total}}`）。
  文案集中在 `src/v2-copy.ts`，出现裸数字会被 `tests/promo/numbers_gate.test.mjs` 判红。
- **界面门禁**：`tools/capture_ui.mjs` 用 FOR-67 的取证报告给真实侧栏 DOM 喂状态，再逐张核对「像素里的数字 == 报告里的数字」
  （已取/total/页数/卡片张数/diff 人数）。对不上的镜头在 `public/v2/manifest.json` 里标 `usable: false`，`make_gifs.mjs` 直接拒。
  本机所有 chromium 形态都不注册未打包扩展（FOR-67 实测），所以走「页面上下文加载真实 UI」，不是手绘 mock，也不是旧 Web 报告界面。
- **帧质检**：`python promo/qa.py promo/out/*.png`（空白帧 BLANK / 内容触边 TOUCHES_EDGE）。v2 两支的静帧已跑通。
- **README 门禁**：GIF 落在 `../assets/preview-v2-*.gif`，由 `tools/build_readme_preview.py`（FOR-66）校验存在且 <=8MB。

### 现在还缺什么才出片

1. `docs/qa-report-v2.json`（FOR-67）：片内全部数量的唯一来源。缺它 `npm run fill` 就红，两支片渲不出来。
2. 抓取快照（建议 `docs/qa-evidence/scan-items.json`，FOR-67 追加）：逐条列表的像素要有真实昵称/mid。
   没有它 `capture_ui` 只拍聚合层，且会把 `syntheticNames: true` 写进 manifest，GIF 环节直接拒。
3. B 轨真实登录态会话（FOR-67 B4）：需要已登录 B站的浏览器环境或明确授权。
## 已完成 / 待补

- 音轨：`tools/gen_bgm.mjs` 本地合成（和弦垫 + 琶音 + 轻 kick + hat），两支各一条、时长精确对齐帧数，零版权风险；真人配音仍未录。
- 界面截图：`tools/shot_webui.py` 从当前 `src/bili` 起服务 + 本机 Chrome headless 截图，版本一换就能重截，不会再出现「片子讲 v0.1.1 界面」。
- 待补：品牌 logo 动效（当前色板取自 B站主色 `00A1D6` + 深色 `0B0D12`）；Web 报告从静态截图换成录屏滚动会更有说服力。
- 成片挂载：发版时把两支 mp4 传到 Release 附件（crf 20 下约 7–9 MB，在 GitHub 10 MB 附件上限内）。
