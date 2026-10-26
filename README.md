# Bili Clean Follow（B站关注列表清理工具）
> **中文 / English** — 当前为中文，[查看英文版](README_en.md)。
> **凭据永不出本机**：Cookie 与 API Key 绝不上传到任何外部服务；昵称与简介只发给你自己填的模型端点（不填就零外发）。口径见 [PRIVACY.md](PRIVACY.md)。

一个开源工具：分析你的 B站关注列表，把每个关注按 **keep / review / remove** 分类，并给出可解释的原因——让你有把握地清理掉过期、不活跃或低价值关注。

> **主形态已换成浏览器插件（v2）**：4 步装好、不用装 Python，图文教程见 [docs/extension-install.md](docs/extension-install.md)；
> 不便装扩展的用户可用**只读**油猴脚本 [userscripts/bili-clean.user.js](userscripts/bili-clean.user.js)（读全 + 离线分类 + 候选清单，不含取关）。
> `bili-clean-follow-v2.0.0-extension.zip` 要等 FOR-67 的三轨取证报告判 Go 之后才随 Release 提供（`tools/package_release.mjs` 会拦住打包与打 tag）；
> 现在要用就取仓库里的 `extension/` 目录 Load unpacked。**Python CLI 已进维护模式：冻结在 v0.1.3，只做安全修复。**

## 演示 · 打开这一页就能看见（两支 60 秒的片子，1080p 带音轨）

![产品介绍片内联预览：58 秒讲清它是什么——打开本页就自动播，不用点、不用下载](assets/preview-promo.gif)

**① 产品介绍片（58 秒）** — [▶ 在线观看（Pages 落地页，浏览器直接播）](https://yu-xiao-sheng.github.io/bili-clean-follow/#promo) · [下载 1080p mp4](https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.2/bili-clean-promo.mp4)

![操作教程片内联预览：从导出数据到看报告的完整流程，会自动循环播](assets/preview-walkthrough.gif)

**② 操作教程片（62 秒）** — [▶ 在线观看（Pages 落地页，浏览器直接播）](https://yu-xiao-sheng.github.io/bili-clean-follow/#walkthrough) · [下载 1080p mp4](https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.2/bili-clean-walkthrough.mp4)

> 上面两张是 **GIF 内联预览**：打开本页就会动。GitHub README 里放不下播放器（mp4 只渲染成下载链接，`<video>` 会被 sanitizer 清掉，YouTube 链接也不会内嵌播放器），所以完整 1080p 影片走 Pages 落地页直接播；B站 / YouTube 站内链接等官方号上传后补上。三条入口的分工、重跑脚本与上线步骤见 [docs/video-hosting.md](docs/video-hosting.md)。

> ⚠️ **取关是真实写操作（v2 插件）· 默认关闭**：本工具默认只出报告。要真的取关，必须显式武装：
> 侧栏「开启取关能力」开关 + 二次确认（写清调 `POST x/relation/delete`、速率、不可撤销）→
> **先看到 diff 预览**（影响 N 人、按类分组、10 条样例）→ **手输 `UNFOLLOW`** 才会执行。
> 单次批量默认 50 条、**硬上限 200**；**速率下限 800ms/条** + 随机 jitter；遇 B站风控码（`-352` / HTTP 412）
> 立刻**熔断并保存断点**。`keep` 类别、以及「待确认」/ 置信 < 0.55 的 UP 主**永不进入候选**。
> 执行前自动落盘「本次将取关清单（mid + 昵称 + 时间）」，并提供**一键重新关注**（`x/relation/add`）作补救；
> 每条成功 / 失败都进审计日志，可导出 CSV。
> **B站没有撤销 API**：取错了只能靠补救清单，且不保证补得回来。自动化取关属于账号操作，可能触发风控；
> 工具不绕签名、不绕过限速，风险由使用者自担。完整护栏见下文 [取关的七条安全护栏](#取关的七条安全护栏v2-插件)。


## 为什么需要

你可能已经关注了几百（甚至上千）个 B站账号，其中很多你已经不记得自己何时关注过。逐条翻看太痛苦。这个工具会给每个关注一个"值得保留"的分数，并把一份取关候选清单交到你手上。

## 核心定位

**不替你删，只帮你看清。**

bili-clean-follow 是「本地、透明、只报告」的 B站关注清理工具，三支柱：
- **安全（Safety）**：默认只报告。Python CLI 从不调用 unfollow API（`--dry-run` 是默认且唯一行为）；v2 插件的取关是真实写操作，**默认关闭**，七条护栏全过才执行（见 [取关的七条安全护栏](#取关的七条安全护栏v2-插件)）。数据（cookie、关注列表）不出本机。
- **透明（Transparency）**：每个关注都有 0–1 分数和人类可读的打分原因（最近看到 X 天 / 粉丝比 / 简介质量）。
- **轻量（Lightweight）**：纯本地、零第三方依赖的 Python CLI。无云端、无遥测。

## 取关的七条安全护栏（v2 插件）

> 口径是「**默认只报告，写操作要显式武装**」。Python CLI 仍然 report-only（`--dry-run` 是默认且唯一行为）；
> 下面七条只作用于 v2 插件的取关执行器（`extension/unfollow.js`）。

| # | 护栏 | 实现与验证 |
|---|---|---|
| a | **写操作默认关闭**：要「开启取关能力」开关 + 二次确认（说明接口 `POST x/relation/delete`、表单 `fid + csrf`、速率、不可撤销） | `setWriteSwitch` 必须带 `riskNotice` 版本的确认；文案改版旧确认作废 |
| b | **执行前必须看到 diff 预览，且手输 `UNFOLLOW`** | 预览内容算指纹落 `chrome.storage.local`（带 10 分钟 TTL），执行时按指纹比对：没渲染过 / 清单变了 / 过期 → 直接拒 |
| c | **单次批量上限默认 50、硬上限 200** | 超上限是整批拒（不「先发一半」）；要得比 200 多直接拒 |
| d | **速率下限 800ms/条 + jitter；遇 `-352` / `412` 熔断并保存断点** | `resolveIntervalMs` 只夹不降（传 0 也只到 800ms）；断点存剩余 mid 列表，「从断点继续」要重新看预览 |
| e | **`keep` 分类永不进候选**（白名单硬约束），**没勾「进候选」的类也不进** | 执行时按当前 `results`/`decisions` 重算候选，不只信预览；单测覆盖 |
| f | **执行前落盘「本次将取关清单」（mid + 昵称 + 时间）+ 一键重新关注补救** | 清单在第一条写请求发出之前就已落库；补救只补「这批里真的取关成功的人」，不会凭空加关注 |
| g | **审计日志每条成功 / 失败，可导出 CSV** | `unfollow_audit.v1` + 带 BOM 的 CSV 导出；昵称先遮凭据形态再落盘，日志与清单里不含 csrf / cookie |

外加两条：**「待确认」（置信 < 0.55）永不进候选**（证据不足不清洗，这是 FOR-64 交接里钉住的硬约束）；
**自己的 mid 永不进候选**。护栏过不了时执行器直接抛 `UnfollowGuardError`，**transport 调用次数为 0**——
「未确认即写」这条路径在代码里不存在，单测逐条钉死（`tests/extension/unfollow_guardrails.test.mjs`，见 `unfollow_guardrails`）。

自然语言指令（「保留所有游戏区的，把搞笑段子和影视解说都清掉」）走 `extension/intent.js`：
LLM function-calling 与本地语法双轨（没 Key 也能用），任何意图先渲染 diff 预览，确认后才改本地决策，
且支持「回滚最近一步」（操作栈落 `chrome.storage.local`，侧栏可见）。keep 与清掉撞车时 **keep 赢**。

## 特性

- **默认只出报告，安全**：CLI 与 Web 报告器从不调用 unfollow API，不触碰你的账号；插件的取关是可选的真实写操作，默认关闭、要显式武装。
- **可解释**：每个决策都附带一个数值分数和一个原因字符串。
- **导出** Markdown（给人看）和 CSV（带 UTF-8 BOM，Excel / WPS 双击打开不乱码），以及可选的"取关候选清单"（每行 mid + Tab + 昵称，能直接在 B站 关注页核对）。
- **中文控制台安全**：Windows 中文环境（GBK）下昵称含 emoji 也不会崩，报告照常产出。
- **补信号伴生工具 `bili-merge`**：生成已预填 mid + 昵称的 signals.csv 模板，你只填 4 个数字，合并后重跑；纯本地，不联网、不调 B站 API。
- **数据缺失按「未知」处理，不按「最差」处理**：分数只对已提供的信号归一化，再叠两道闸门——缺 recency 的记录不得判 remove（闸门 A），只有简介（哪怕写着「官方认证」）的记录不得判 keep（闸门 B），它们统统落到 review 等你确认。
- **缺信号会被明确告知**：报告每行带 `signals_used` 与 `missing_signals`（已提供 / 未提供的信号名，分号连接，两者互补；CSV 存信号名，Markdown 与 Web 在没有任何信号时显示「未知」）；当本次运行超过一半记录缺 recency 时，Markdown 与 Web 报告顶部打一行警告，提示先用 `bili-merge` 补信号，否则结果不可作为取关依据。
- **真实导出直接能跑**：浏览器复制的 `{"code":0,"data":{"follower":[…]}}` 或 `data.list` 响应会自动解包，昵称认 `name` / `uname`，官方认证认 `official.role/title/department` 与 `official_verify.type`，不用手改 JSON。
- **带 BOM 的导出直接能读**：Windows 记事本 / Excel 另存的 JSON 带 UTF-8 BOM，输入按 utf-8-sig 解码，不会再看到 Unexpected UTF-8 BOM。
- **不提交凭据**；基于用户提供的 JSON 导出工作。

## 快速开始

前置：Python 3.9+（CI 覆盖 3.9–3.13，另有一个 Windows GBK 冒烟 job 与一个「真实 chromium 渲染 Web 报告」的 DOM 门禁 job；本轮实测 Python 3.13.15，260 项 pytest 全绿）。
以下命令 Windows / macOS / Linux 通用，建议在一个干净的虚拟环境里跑。

**第 1 步 · 先安装（必须，二选一）**

本包是 src/ 布局，未安装直接跑会报 ModuleNotFoundError: No module named 'bili'。

方式 A · 直接装 Release 包（不用克隆）：

```
pip install https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.3/bili-clean-follow-0.1.3.zip
```

方式 B · 克隆后本地安装：

```
git clone https://github.com/Yu-Xiao-Sheng/bili-clean-follow.git
cd bili-clean-follow
pip install -e .
```

装好后可以确认一下：`bili-clean --version` 输出 `bili-clean 0.1.3`。

**第 2 步 · 跑内置示例**

```
python -m bili.demo
bili-clean sample-follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

示例数据固定，预期输出：`Summary: keep=13 review=2 remove=9`（24 个关注，9 个进入取关候选）。
打开 report.md 看逐条理由，再自己决定怎么处理 to-unfollow.txt。
to-unfollow.txt 每行是 `mid <TAB> 昵称`，抬头写明这是人工核对清单——工具不会自动取关。

**第 3 步 · 换成你自己的导出**

```
bili-clean follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

怎么拿到 follows.json 见 [docs/getting-started.md](docs/getting-started.md)。

**第 4 步 · 补信号（可选，但决定 remove 是否可信）**

真实导出只有昵称与简介，缺「最近活跃」和「粉丝 / 关注数」这两类信号，这时报告只能排序。用随包附带的 bili-merge 补：

```
bili-merge follows.json --template signals.csv     # 生成模板：mid + 昵称已预填
# 在 Excel / WPS 里填 4 个数字列（last_seen_days / last_video_days / follower_count / following_count，拿不到的留空）
bili-merge follows.json --signals signals.csv      # 合并出 follows.merged.json
bili-clean follows.merged.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

留空 = 未知：未知不会被当成取关理由，这类记录只会进 review 用于排序。没装包直接跑源码时用 `PYTHONPATH=src python -m bili.merge_cli`。

**第 5 步 · 本地 Web 报告（可选）**

```
python -m bili.web --input sample-follows.json
```

打开 http://127.0.0.1:8787 （只监听 127.0.0.1，只读；页面顶部显示 `bili-clean-follow v0.1.3 · 本地只读 · 数据不出本机`）。

## 插件预览版怎么装（v2 进行中）

> ⚠️ v2 还在开发：插件已经能做「读全关注列表 + 分类（离线规则 / 你自带 Key 的模型）+ 本地只读报告 + 一句中文整理（自然语言指令 → diff 预览 → 回滚）」；取关是**真实写操作，默认关闭**，要开关 + 二次确认 + 看过预览 + 手输 `UNFOLLOW` 才会执行（护栏见上一节）。想现在就用打分式分析，走上面的 CLI「快速开始」——按 v2 方案 **CLI 已进维护模式：冻结在 v0.1.3，只做安全修复，不再加功能**（v2 的主实现是上面的插件）。

四步装好，全程不用 clone、不用 pip、不用 npm：

1. 拿到 `extension/` 目录：正式发布后从 Releases 下载 `bili-clean-follow-v2.0.0-extension.zip` 解压；预览阶段直接克隆仓库取其中的 `extension/`。
2. 把它放在一个固定目录（Chrome 只记路径，目录被删插件就失效）。
3. 打开 `chrome://extensions` → 右上角开「开发者模式」→「加载已解压的扩展程序」→ 选中 `extension/` 目录本身。
4. 先在浏览器里登录 bilibili.com，再点工具栏图标 →「分析我的关注列表」，Side Panel 里看进度（已取 / total / 页数）。读全之后点「开始分类」：没填模型 Key 就自动走离线规则，零外发。读全之后点「开始分类」（没填模型 Key 就自动走离线规则，零外发）。

它会做什么、不会做什么：

- **抓取与报告是只读的**：只调 `x/web-interface/nav`（取自己的 mid）与 `x/relation/followings`（抓关注列表）。`x/relation/delete` / `x/relation/add` 这两个写接口**只在护栏全过之后**才会被调用（默认关闭），拉黑 / 黑名单 / 关注分组接口永久禁用。
- **读全才解锁下一步**：抓取循环一直翻到 `fetched == total`；没读全时「开始分类」是灰的，旁边写着「还没读全（已取 431/812）」。中断不丢数据（状态标 incomplete），点「继续抓取」从断点页继续。
- **接口不可用会降级**：service worker fetch → B站页面内 fetch → 关注页 DOM 翻页兜底，三条路都必须翻到最后一页。
- **导出与 CLI 同一口径**：`report.md`、`report.csv`（带 UTF-8 BOM，Excel/WPS 双击不乱码）、`to-unfollow.txt`（每行 `mid <TAB> 昵称` 的人工核对清单）。
- **分类：12 类预置，可增删改名**：科技数码 / 游戏电竞 / 影视综艺 / 知识教育 / 美食 / 生活日常 / 搞笑段子 / 音乐 / 动漫二次元 / 体育 / 时尚美妆 / 资讯时事，外加「其他」兜底。类别卡片显示条数、占比、平均置信，并有「保留 / 进候选」；选了「保留」的类永不进入取关候选。
- **两条分类路径**：默认**离线规则**（昵称 + 简介 + 官方认证 + 关注时间，零网络请求，置信度封顶 0.68）；填了自己的端点与 Key 才走 **AI 分类**（OpenAI 兼容：DeepSeek / 智谱 / Kimi / 通义 / 本机 Ollama / 自定义 baseURL），每批 40 条、强制 JSON schema、解析失败重试一次后该批降级为离线。
- **低置信不硬塞**：置信 < 0.55 一律进「待确认」，并保留「本来像哪一类」的留痕。
- **外发先告知**：首次启用 AI 会逐条列出「将发送 N 条昵称 + 简介到 <你填的端点>」，可改成只发昵称；载荷里没有 Cookie / UID / mid / 头像 / 关注关系，只带一次性代号 r1、r2…；换端点必须重新确认，随时可「撤回外发确认」。安装时不预授第三方权限，确认端点时才申请那一个 origin。
- **凭据不出本机**：Cookie 与 Key 不进仓库、不进日志、不进导出文件（Key 只待在 `chrome.storage.local` 的独立键里）；没有我们的服务器，也没有遥测中转。完整口径见 [PRIVACY.md](PRIVACY.md)。

图文步骤与常见问题见 [docs/extension-install.md](docs/extension-install.md)。扩展侧的离线单测不需要浏览器也不需要登录：`node --test "tests/extension/*.test.mjs"`（175 项 node:test 用例，CI 已钉成门禁；其中 62 项是 FOR-65 的：意图 DSL、diff 预览、七条护栏逐条拒、操作栈回滚、写操作边界，以及「一句话指令 → 预览 → 武装 → 取关 → 回滚」的端到端 mock 串跑；另有 FOR-68 的 25 项：油猴脚本只读护栏 14 项 + v2.0.0 发布门禁 9 项 + 交付物清单核对（含「报告 Go 之前不许挂 v2.0.0 下载链接」）2 项——报告没 Go 就打包不出 zip，也打不出 tag）。


## 如何得分

三个加权信号（见 [docs/scoring-model.md](docs/scoring-model.md)）：

- **recency（0.45）** —— 你最近多久看到 / 对方最近多久发布。
- **authority（0.30）** —— 粉丝/关注比（圈层质量代理）。
- **relevance（0.25）** —— 简介质量 + 官方/认证标记。

阈值：score >= 0.70 为 keep，>= 0.40 为 review，其余为 remove。

分数只对**已提供**的信号归一化：`score = Σ(w_k·p_k) / Σ(w_k)`，分母只含已提供信号的权重（v0.1.2 起，FOR-36）。
两道闸门：**缺 recency 不得判 remove**（未知不是取关证据）；**keep 至少要提供 recency 或 authority 之一**。细则见 [docs/scoring-model.md](docs/scoring-model.md)。

## 项目结构

```
src/bili/        # 包：model, loaders, score, export, cli, demo（v2 起进维护模式）
extension/       # v2 Chrome 插件：Manifest V3 + 原生 ESM，零构建步骤（Load unpacked 直接用）
                 #   biliApi / store / report + taxonomy(12类) + classifyLocal(离线) + classifyLlm(BYOK) + classify(门禁与落库)
                 #   + intent(自然语言→意图 DSL) + preview(diff 预览与安全候选) + intentStack(回滚) + unfollow(七条护栏)
tests/extension/ # 扩展离线单测（node:test，无需浏览器）
tests/           # pytest 测试套件
assets/          # README 内联 GIF 预览 + 影片封面（tools/build_readme_preview.py 产出）
pages/           # GitHub Pages 落地页源文件（<video controls poster> 播完整 1080p）
docs/            # spec.md, getting-started.md, scoring-model.md, video-hosting.md, extension-install.md
PRIVACY.md       # v2 隐私口径：凭据永不出本机；昵称与简介只发给你自己指定的模型端点
tools/           # build_readme_preview.py, publish_pages.py, probe_web_render.py
.github/         # CI 工作流（ci.yml, pages.yml）+ Issue/Discussion 模板
pyproject.toml
```

## 本地 Web 报告（可选）

不想只读终端/文件输出，可以起一个本地报表界面（默认仅监听 127.0.0.1，只读）：

```
python -m bili.demo                            # 生成示例 sample-follows.json
python -m bili.web --input sample-follows.json
```

打开 http://127.0.0.1:8787 即可看到：
- 摘要卡：总关注数与 keep / review / remove 三类各自的数量与占比；
- 可筛选（分类 tab）、可排序的完整分类表（昵称/分类/得分/最近活跃/最新视频/粉丝比/原因）：
  点表头切换排序列，再点一次换方向，当前列标 ↑ / ↓；「得分」「最近活跃(天)」「最新视频(天)」按数值排
  （20 排在 100 前），也可以直接用链接预置，例如 `http://127.0.0.1:8787/?sort=last_seen_days&dir=asc`；
- 删除候选预览：逐一确认后一键导出取关清单 (.txt)；
- 一键导出 Markdown / CSV 报告。

数据全程留在本机：CLI 与 Web 报告器不连接任何外部服务，也不调用 unfollow API。（v2 插件的取关能力默认关闭，口径见上文护栏一节。）

## 安全说明

这一节说的是 Python CLI 与本地 Web 报告器：它们只报告，**不会** unfollow，**不会**上传你的数据，也**不会**保存任何东西。对任何关注采取行动之前，先审阅报告。v2 插件的取关走另一条路：默认关闭，必须开关 + 二次确认 + diff 预览 + 手输 `UNFOLLOW`，见 [取关的七条安全护栏](#取关的七条安全护栏v2-插件)。

## 许可证

MIT。
