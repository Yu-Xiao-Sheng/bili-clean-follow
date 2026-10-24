# bili-clean-follow 视频工程（Remotion）

用 Remotion 以代码方式产出产品视频，所有文案与排版可 diff、可复用。

## 环境

- Node 20+（本轮实测 Node 24.21.0 / npm 11.19.0）
- 安装：`npm install`（会带 Chrome Headless Shell，首渲时自动下载，约 80 MB）

## 命令

```
npm run studio                 # 浏览器里实时预览（默认 :3000）
npm run render                 # 产品介绍片 -> out/bili-clean-promo.mp4（1920x1080 @30fps）
npm run render:walk            # 使用教程片 -> out/bili-clean-walkthrough.mp4
npm run render:master          # 两支一起出
npm run still:promo -- --frame=550 --out=out/x.png   # 单帧校对排版与中文字形
npx remotion still Walkthrough out/w.png --frame=1020
python qa.py out/v3/*.png      # 帧质检：空白帧 / 内容触边（需 pillow）
```

`--crf=20` 已写进 render 脚本：53–62 秒的 1080p30 成片压在 GitHub Release 附件 10 MB 上限内。

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

## 待补

- 音轨 / 配音：仍未加 BGM（避免版权风险）；如需配乐，用 `promo/tools/gen_bgm.mjs` 那条路子生成合成音轨，不要抓现成歌曲。
- 品牌动效：当前色板取自 B站主色 `00A1D6` + 深色 `0B0D12`，logo 动效待 UX/UI 出稿。
- 可选：把 Web 报告截图换成录屏滚动，比静态 `webui.png` 更有说服力。
