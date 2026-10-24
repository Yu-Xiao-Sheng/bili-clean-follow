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
npm run bgm                    # 只重新生成音轨（render 已自动带上这一步）
npm run still:promo -- --frame=550 --out=out/x.png   # 不要用：见下方「帧级质检」
# npx remotion still Walkthrough out/w.png --frame=1020   # 同上，别用
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

## 已完成 / 待补

- 音轨：`tools/gen_bgm.mjs` 本地合成（和弦垫 + 琶音 + 轻 kick + hat），两支各一条、时长精确对齐帧数，零版权风险；真人配音仍未录。
- 界面截图：`tools/shot_webui.py` 从当前 `src/bili` 起服务 + 本机 Chrome headless 截图，版本一换就能重截，不会再出现「片子讲 v0.1.1 界面」。
- 待补：品牌 logo 动效（当前色板取自 B站主色 `00A1D6` + 深色 `0B0D12`）；Web 报告从静态截图换成录屏滚动会更有说服力。
- 成片挂载：发版时把两支 mp4 传到 Release 附件（crf 20 下约 7–9 MB，在 GitHub 10 MB 附件上限内）。

## Web 镜头的门禁（先看这条，再决定片子能不能发）

`public/webui.png` 是唯一一张「本地 Web 报告」实拍，出现在产品介绍片的 WebScene 和使用教程片的 STEP 5。
它必须来自**当前真的能看的界面**，否则片子就是在替产品演示一个坏掉的界面。

实测（2026-10-25，Windows / Chrome headless，`--dump-dom` 读渲染后的 DOM，不是响应体）：

| 构建 | tbody 里的真实输出 | 结论 |
|---|---|---|
| `main = 10ca868`（= tag v0.1.2） | `<td>NaN</td>`，`<span class="b-review&gt;review&lt;/span&gt;&lt;/td&gt;...` | 昵称 / 信号 / 粉丝比三列全是字面量 `NaN`，徽章 span 缺属性闭合引号 → 后面所有列塌成转义文本。不可入镜 |
| `54e1b8a`（FOR-57 + FOR-58 堆叠分支） | `<td>人民日报</td><td><span class="b-review">review</span></td>...` | 20 行、20 个徽章、无 `NaN`、无转义标签。可入镜 |

所以 `tools/shot_webui.py` 现在在截图前先跑一次真实浏览器 DOM 断言（行数 = 数据行数、tbody 不得出现
`NaN` 或被转义的标签、徽章数量 = 行数、每个分类的行数 = Summary 计数）。断言不过就不出图、退出码 3。
在 `main = 10ca868` 上跑它是红的（退出码 3，两条问题），这正是 v0.1.2 界面真实的渲染状态。

**发布前置**：本分支的 `webui.png` 来自 `54e1b8a`（含 FOR-57 的渲染层 P0 修复与 FOR-58 的数值列排序）。
FOR-57 → FOR-58 合入 main 并切 v0.1.3 之前，两支片子的 Web 镜头与 STEP 5 都不适用于已发布的 v0.1.2，
发帖物料只能先用不含 Web 镜头的版本。

### 重截与重渲（改完 web.py 必须重跑）

```
python promo/tools/shot_webui.py            # DOM 断言通过才写 public/webui.png
cd promo && npm run render && npm run render:walk
python promo/qa.py promo/out/promo/*.png    # 帧级：空白帧 / 触边
```

## 帧级质检（出片后必跑）

`remotion still` 在这个工程里不可靠：实测（Remotion 4.0.246）对 BiliCleanPromo 用
`--frame=800`、`--frame=230`、不带 `--frame` 三种方式抽出来的 PNG **字节完全相同**，画面只剩页脚一条
（ink=174，qa.py 判 BLANK）——它在画面挂载前就抓帧了。所以「单帧校对」不能再用它，改成从成片里抽帧：

```
node tools/frames.mjs out/bili-clean-promo.mp4       out/frames/promo   # 每秒 1 帧
node tools/frames.mjs out/bili-clean-walkthrough.mp4 out/frames/walk    # 每秒 1 帧
python qa.py out/frames/promo out/frames/walk                           # qa.py 直接收目录
```

qa.py 报 BLANK（ink < 200）或 TOUCHES_EDGE（内容贴到 1080 画布边缘）就退回排版重做。
本轮实测：58 + 62 = 120 个抽样帧，0 BLANK、0 TOUCHES_EDGE，最小 ink=915。
