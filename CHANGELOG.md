# 变更记录（Changelog）

All notable changes to this project will be documented in this file.

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [0.1.3] - 2026-10-25

### Fixed
- **Web 报告渲染层两个 P0（FOR-57）**：`fmtNum()` 把参数本身改写成 `Number(v)`，非数字原值走到「转不动」分支时打印的已经是那个数字 ⇒ 昵称 / 信号 / 粉丝比三列在真实浏览器里全是字面量 `NaN`；`badge()` 的 span `class` 属性缺闭合引号 ⇒ 浏览器把 `>` 之后一路吞进 class 值，后面所有单元格塌成一坨转义文本（`&lt;/td&gt;&lt;td&gt;...`）。文本列（`COLS` 里标 `text:1` 的三列）改走新的 `fmtText`，原值转义；`fmtNum` 保留原值、只把转换结果放进局部变量（数字列最多两位小数，`3.14` 不再被截成 `3.1`）；徽章 span 的属性值与文本同样过 `esc()`，属性不可能被引号撬开。这两种坏法在 HTTP 响应体里都看不见，所以 `tests/test_web.py` 全绿与「页面不可读」同时成立（与 FOR-41 同构）
- Markdown 报告的 Name 列没过任何转义（FOR-58）：昵称里的竖线把 7 列的表格撑成 8/9/10 列，换行还会把一行截断。新增 `_md_cell`（HTML 转义 + 反斜杠/竖线转义——先翻倍反斜杠再转义竖线，否则昵称自带的反斜杠会把补上的转义顶掉——外加折行压平），Name 与 Reason 两列走它；CSV 仍是数据层，不做转义（有测试钉住）
- 昵称里的 `<script>` / `<img onerror>` 原样写进 report.md，用户用浏览器或 Typora 预览报告就会执行（FOR-58）：转义实现复用 Web 端已有的 `_html_escape`，把它的唯一一份实现从 `web.py` 搬到 `export.py`，`web.py` 改成 import，不留第二份（测试断言 `web._html_escape is export._html_escape`）
- 内嵌进 JSON `<script>` 元素的昵称只把 `</script>` 写成 `<\/script>`，但 HTML 解析器认标签不认大小写：昵称里的 `</SCRIPT>` 会提前关掉 script 元素、整页表格塌掉（实测连内嵌 JSON 都解析不出来）（FOR-58）。现在把 `<` 统一写成反斜杠-u003c
- `tools/probe_web_render.py` 在 Windows 中文控制台假红（FOR-59）：`PYTHONIOENCODING=gbk` + `PYTHONUTF8=0` 下跑这条门禁，渲染层断言其实全部通过，但 `print_report` 打含 emoji 的昵称时炸出 `UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f600'`、进程 exit=1；本地复核会被误导，而 CI 只跑 ubuntu 抓不到这个环境。入口与 `print_report` 现在都走 `bili.streams.harden_stdio()`（与 CLI / Web / demo 同一份兜底，沿用 FOR-38 已定型的口径，不留第二份实现）

- README.md / README_en.md 首屏那两支宣传片链接挂的是 `releases/download/v0.1.2/bili-clean-promo.mp4` 与 `.../bili-clean-walkthrough.mp4`，但 FOR-34 的 swap 已把这两支 mp4 从 v0.1.2 摘走、改挂到 v0.1.3（v0.1.2 名下现在只剩 zip 附件），读者从仓库第一屏点进去必 404，登录状态下也不会变成可读提示（FOR-61）。两条链接改指 v0.1.3 名下通过验收的那一版：`bili-clean-promo.mp4` 7,349,505 B、`bili-clean-walkthrough.mp4` 6,794,692 B
### Changed
- Web 表头排序修掉死字段（FOR-58）：比较器读的是从来没赋值的 `sort`（`state` 只有 `{cls,key,dir}`），所以「得分」「最近活跃(天)」「最新视频(天)」永远按字典序——100 排在 20 前面，`COLS` 里的 `sort:'num'` 是死字段。排序类型现在只从 `COLS` 查（`sortKind`），数值列按数值排、非数字脏数据退回字典序；表头加 ↑/↓ 与 `aria-sort` 指示，并新增 `/?sort=<key>&dir=<asc|desc>` 预置排序（既是深链，也让 `--dump-dom` 的渲染层取证能钉住排序：headless 不会点表头）
- README.md / README_en.md 测试条数口径 230 → 233 → 244 → 247 → 249，由 `tests/test_release_hygiene.py` 钉死：README 写的条数与 `pytest --collect-only` 实际收集数不一致时 CI 直接红

### Added
- 真实 chromium 渲染层断言进 CI（FOR-57）：`tools/probe_web_render.py` 起 `python -m bili.web` + headless chromium `--dump-dom`，对渲染后的 `<tbody>` 断言（真实导出夹具 + 「昵称像数字 / 含 HTML / 为空」的对抗夹具），命令行可直接跑、也供测试复用；`tests/test_web_render.py` 把这套断言收进 pytest（本机无 chromium 时跳过）；`.github/workflows/ci.yml` 新增 web-render job（playwright chromium + `BILI_REQUIRE_BROWSER=1`），浏览器装不上就红，门禁不会悄悄空跑
- 排序取证（FOR-58）：`tools/probe_web_render.py` 的数值跨度夹具 + `check_sort` 单调性断言（`3.14 < 20 < 100`、换一列排行序必须跟着那一列走、空值永远垫底）——字典序的坏法在单调性上立刻露馅，不必复刻 JS 比较器
- `tests/test_probe_console.py`（FOR-59）：不需要浏览器的输出编码钉——在 `PYTHONIOENCODING=gbk`（换 `cp936` 再钉一次）+ `PYTHONUTF8=0` 下调用 `print_report` 不得抛 `UnicodeEncodeError`、退出码必须 0，并 pin 住入口与 `print_report` 两处 `harden_stdio()`

- `tests/test_release_hygiene.py` 把 Release 附件链接纳入发布自检口径（FOR-61）：`test_readmes_link_both_release_films_of_the_current_version()` 钉两版 README 必须各自挂满两支片子（`bili-clean-promo.mp4` + `bili-clean-walkthrough.mp4`，少一条、多一条都算红）且 asset 挂在当前版本名下；`test_no_doc_links_a_release_asset_from_another_version()` 把 zip 与 mp4 收成同一条口径 —— README.md / README_en.md / docs/getting-started.md 里任何 `releases/download/<tag>/<asset>`，只要 tag 不等于当前版本就红。本轮阴性对照：README 改之前这两条各自红（`still links v0.1.2 release assets`），改完全绿
## [0.1.2] - 2026-10-24

### Changed
- **打分口径：信号缺失按「未知」处理，不再按「最差」处理（FOR-36，v0.1.1 的行为是 bug）**：v0.1.1 把未提供的信号置为 0、权重和固定 1.0，「不知道」在数学上等于「最坏」，真实导出（只有 identity + bio）会一边倒跑成 `keep=0 review=0 remove=13`。现在只对已提供信号求加权平均（`score = Σ(w_k·p_k) / Σ(w_k)`，分母只含已提供信号的权重），并加两道硬闸门：闸门 A 缺 `recency` 不得判 remove（原因行 `downgraded to review: no recency signal`），闸门 B 只有简介不得判 keep。REVIEW_MIN / KEEP_MIN 保持 0.40 / 0.70 不变；仓库自带样例与 demo 的可复现输出不变（24 条样例每条都给满三个信号）
- 报告与 CSV 的可观测性字段定型（FOR-36）：CSV 新增 `signals_used` 与 `missing_signals` 两列，存分号连接的信号名（`recency;authority`，顺序固定，两者互补，全缺时为空串），数据层不存 0–3 整数；Markdown 与 Web 报告共用同一份显示串，一个信号都没有时显示「未知」，CSV 不翻译。取关清单与报告同一条记录三处显示完全相等
- 本次运行 ≥50% 记录缺 recency 时，Markdown / Web 报告顶部与 CLI stderr 打一行显式警告：先补 last_seen_days / last_video_days / follower_count / following_count（bili-merge 会生成待填模板），否则结果不可作为取关依据（FOR-36）

### Fixed
- 真实导出识别（FOR-37）：`{"code":0,"data":{"follower":[…]}}` 与 `data.list` 信封会自动解包，浏览器里直接复制的关注列表响应不用再手工提到顶层；昵称认 `name` / `uname`，取关清单不再是一串空名字；官方认证改认 `official.role/title/department` 与 `official_verify.type > 0`（落到 `extra.official_*` 并进 relevance），不再只靠简介里有没有「官方」两个字——换个 bio 就不会掉认证。`official_verify.type` 为 0 / -1 视为无认证占位，不算认证证据；头像 `face` 落到 `extra.face`，人工核对时能用
- Windows 中文控制台 P0（FOR-38）：昵称含 emoji 时 CLI / Web / demo 不再 UnicodeEncodeError 崩栈——入口统一 `bili.streams.harden_stdio()`，写 stdout 再兜一层，报告不会整份丢失
- CSV 与取关清单统一 utf-8-sig（带 BOM），Windows Excel / WPS / 记事本双击打开中文不再乱码；Markdown 仍为不带 BOM 的 utf-8（FOR-38）
- 取关候选清单从「只有 mid 数字」改为 `mid <TAB> 昵称` + 说明抬头，CLI 与 Web `/unfollow` 共用同一份，并写明只用于人工核对、工具不会自动取关（FOR-38）
- 凭据拦截改为内容优先：内容里真的出现 SESSDATA / bili_jct 等 cookie 键才拒绝并点名键名；只是文件名带 cookie 的正常导出改为放行 + 提示改名，拒绝信息附带改名建议（FOR-38）
- 输入 JSON 以 utf-8-sig 读取，记事本 / Excel 另存带 BOM 的导出不再报解码错（FOR-38 顺带修掉 FOR-35 记录的 BOM 断层）
- README.md / README_en.md 的测试条数口径修掉：旧值 63（后来漂到 149）与 main 上实际条数不符，现与 `python -m pytest -q` 的实际输出一致，Release 说明用同一个数（FOR-35）
- 三处 Release zip 下载链接（README.md / README_en.md / docs/getting-started.md）与 `bili-clean --version` / Web 页面顶部版本串统一切到 v0.1.2，README 第一条命令不再把人装成旧版（FOR-35）
- README.md / README_en.md 特性列表补「带 BOM 的导出直接能读」一条：v0.1.1 已有 utf-8-sig 读取但文档没写，Windows 用户看不到这个保证（FOR-35）
- README 快速开始补安装步骤（首行就是 pip install，Release zip 或 pip install -e .），修掉「全新克隆直接跑 python -m bili.demo 就 ModuleNotFoundError」的落地页断层（FOR-32）；README.md / README_en.md / docs/getting-started.md 同步
- Python 版本口径统一到 3.9+：pyproject、README、仓库描述一致；CI 矩阵扩到 3.9–3.13，并改用 pip install -e .[dev] 走用户真实安装路径
- docs/getting-started.md 修复被转义吃掉的命令与文件名（report.md、to-unfollow.txt 等），并去掉「不用安装直接跑源码」的错误指引

### Added
- `bili-merge` 补信号伴生工具（FOR-40）：`--template` 生成已预填 mid + 昵称的 signals.csv（utf-8-sig，Excel/WPS 直接编辑），`--signals` 把手工抄的 last_seen_days / last_video_days / follower_count / following_count 合并成 follows.merged.json；纯本地不联网，默认只填空缺不覆盖已有值，终端按「第 1/2/3 步」输出并给最终 Summary（录屏友好）；留空=未知，未知不作为取关依据（与 FOR-36 口径一致）。pyproject 注册 console script，避免「文档里有命令但装不出来」
- 发布口径自检 `tests/test_release_hygiene.py`（FOR-35）：pyproject 版本必须等于 `bili.__version__`；CHANGELOG 必须有当前版本小节且不留 [Unreleased]；README.md / README_en.md / docs/getting-started.md 只允许出现当前版本的 Release zip 链接与 `bili-clean <ver>` 版本串；README 里写的 pytest 条数必须等于 `pytest --collect-only` 实际收集到的条数——「README 63 / Release 62」这类多口径从此跑不过测试
- docs/getting-started.md 新增 §6「本地 Web 报告」：`python -m bili.web --input follows.json` + http://127.0.0.1:8787 + `--port`，英文上手文档不再只讲 CLI（FOR-35，周度复盘 2026-W43 §3）
- .mailmap：把早期提交邮箱映射到 GitHub 账号，修复贡献者显示 0 的问题
- v0.2.x 开发中：每周节奏、社区渠道（QQ/Discord）计划

### Security
- 凭据文件拦截下沉到 bili.loaders.load_from_file，CLI 与 Web 报告共用同一套校验（v0.1.1 发布说明里的「CLI 与 Web 都拒绝」当时仅 Web 生效，此处补齐 CLI 侧，见 tests/test_cli.py）

## [0.1.1] - 2026-10-23

### Added
- 本地 Web 报告界面：`python -m bili.web --input <清洗后的导出 JSON>`，默认仅监听 127.0.0.1:8787，只读、无上传、不落盘

### Changed
- README 中文优先：README.md 为中文，README_en.md 为英文；首屏明确「不替你删，只帮你看清。」与「仅本地运行」声明
- 中文文案修正：去掉中英夹杂与「默认报告-only」这类别扭表述

### Security
- cookie/key 防上传加固：CLI 与 Web 报告拒绝直接加载凭据类文件（cookie / session / key / .env 等），凭据不进入报告数据与访问日志

## [0.1.0] - 2026-10-22

### Added
- 初始发布（beta）
- CLI：分析 B站关注列表，输出 keep / review / remove 分类
- 透明打分：recency (0.45) / authority (0.30) / relevance (0.25)
- 导出：Markdown、CSV、unfollow 候选列表
- 零第三方依赖、report-only、纯本地运行
