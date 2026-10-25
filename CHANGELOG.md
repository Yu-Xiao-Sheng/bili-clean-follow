# 变更记录（Changelog）

All notable changes to this project will be documented in this file.

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [2.0.0-alpha.2] - 2026-10-26 （插件预览版，未发 Release）

插件（`extension/`，Manifest V3，零构建步骤）是 v2 的主实现；Python CLI 冻结在 0.1.3 进维护模式。
本节与下一节的代码在 `eng/for-63-extension-skeleton` → `eng/for-64-ai-classify` 上，尚未合 main，不发 tag。

### Added
- **AI 分类（BYOK，FOR-64）**：`extension/classifyLlm.js` 走 OpenAI 兼容端点（DeepSeek / 智谱 / Kimi / 通义 / 自定义 https baseURL，`PROVIDER_PRESETS`）。每批 40 条，强制 JSON schema 输出（`{ref, category, confidence, reason}`，`ref` 是批次内代号）；解析失败重试一次（重试时带 hint 并放宽成 `json_object`），再失败则**该批**降级为离线分类并标 `local_degraded`；429 / 401 不重试打爆额度，直接降级并给中文原因。外发载荷只有昵称（+ 简介与认证文案，可勾掉），mid / 头像 / cookie / 关注关系一律不发。
- **首次启用 AI 的先告知（FOR-64 验收 3）**：`consentNotice` + `makeConsent` + 侧栏 `<dialog>`，逐条写清发几条、发哪些字段、发到哪个 origin；端点换过或改「只发昵称」都要重新确认；端点 origin 走 `optional_host_permissions` 在用户手势里运行时申请，安装时不预授。API Key 存独立键 `llm_api_key.v1`，配置对象 / meta / 审计 / 导出都不带它（`privacy.js` 会拦）。
- **离线粗分类（FOR-64 验收 4）**：`extension/classifyLocal.js` 按关键词分档打分（简介 > 昵称，认证文案另计），零网络；UI 标「离线粗分类」。
- **12 类可编辑体系（FOR-64 验收 1）**：`extension/taxonomy.js` 预置 12 类 +「其他」兜底 +「待确认」低置信桶（阈值 0.55）；类有稳定 id，改名不产生孤儿结果；自定义类可加关键词，「其他」「待确认」删不掉。
- **分类编排、落库与 UI（FOR-64 验收 5/6）**：`extension/classify.js` 的 `runClassification` 先过 `classificationGate`（没读全直接抛 `ClassificationLockedError`，文案就是「还没读全（已取 431/812）」），结果按 100 条分块落 `chrome.storage.local`，meta 记门禁快照 / 来源 / 批次数 / 降级批数；侧栏类别卡片显示数量、占比、平均置信与来源，并有「保留 / 进候选」；低置信一律进「待确认」且保留 `rawCategory` 可追溯。
- `PRIVACY.md`：把 v1 的「数据完全不出本机」正面改写成「凭据永不出本机；昵称与简介只发给你自己指定的模型端点」，逐条列出永远不出本机的数据与唯一的出网路径。
- 测试：扩展离线单测 36 → 84 项（`classify_gate` / `classify_llm` / `classify_local` / `classify_ui` / `taxonomy_edit` / `import_graph`），另加 4 项「真形状夹具 × 可控 mock LLM」的端到端断言（`classify_llm_fixture`，共 88 项）；`tests/test_release_hygiene.py` 新增 PRIVACY.md 口径门禁（pytest 247 → 248）。

### Changed
- README / README_en.md 顶部口径从「数据全程留在本机」改成「凭据永不出本机 + 只有你指定的端点收得到昵称与简介」，并指向 PRIVACY.md。

## [2.0.0-alpha.1] - 2026-10-25 （插件预览版，未发 Release）

### Added
- **扩展骨架（FOR-63）**：`extension/`（MV3 + Side Panel + service worker），登录态分页抓全关注列表；`fetched == total` 是硬门禁（没读全时「开始分类」disabled），三级降级（SW fetch → B站页面内 fetch → 关注页 DOM 翻页），中断保留数据标 `incomplete` 并可续抓；`report.md` / `report.csv`（BOM）/ `to-unfollow.txt` 与 CLI 常量交叉比对；`extension/privacy.js` 在写盘、导出、打日志前剥凭据字段并对凭据形态拒写。
## [0.1.3] - 2026-10-25

### Fixed
- **Web 报告渲染层两个 P0（FOR-57）**：`fmtNum()` 把参数本身改写成 `Number(v)`，非数字原值走到「转不动」分支时打印的已经是那个数字 ⇒ 昵称 / 信号 / 粉丝比三列在真实浏览器里全是字面量 `NaN`；`badge()` 的 span `class` 属性缺闭合引号 ⇒ 浏览器把 `>` 之后一路吞进 class 值，后面所有单元格塌成一坨转义文本（`&lt;/td&gt;&lt;td&gt;...`）。文本列（`COLS` 里标 `text:1` 的三列）改走新的 `fmtText`，原值转义；`fmtNum` 保留原值、只把转换结果放进局部变量（数字列最多两位小数，`3.14` 不再被截成 `3.1`）；徽章 span 的属性值与文本同样过 `esc()`，属性不可能被引号撬开。这两种坏法在 HTTP 响应体里都看不见，所以 `tests/test_web.py` 全绿与「页面不可读」同时成立（与 FOR-41 同构）
- Markdown 报告的 Name 列没过任何转义（FOR-58）：昵称里的竖线把 7 列的表格撑成 8/9/10 列，换行还会把一行截断。新增 `_md_cell`（HTML 转义 + 反斜杠/竖线转义——先翻倍反斜杠再转义竖线，否则昵称自带的反斜杠会把补上的转义顶掉——外加折行压平），Name 与 Reason 两列走它；CSV 仍是数据层，不做转义（有测试钉住）
- 昵称里的 `<script>` / `<img onerror>` 原样写进 report.md，用户用浏览器或 Typora 预览报告就会执行（FOR-58）：转义实现复用 Web 端已有的 `_html_escape`，把它的唯一一份实现从 `web.py` 搬到 `export.py`，`web.py` 改成 import，不留第二份（测试断言 `web._html_escape is export._html_escape`）
- 内嵌进 JSON `<script>` 元素的昵称只把 `</script>` 写成 `<\/script>`，但 HTML 解析器认标签不认大小写：昵称里的 `</SCRIPT>` 会提前关掉 script 元素、整页表格塌掉（实测连内嵌 JSON 都解析不出来）（FOR-58）。现在把 `<` 统一写成反斜杠-u003c
- `tools/probe_web_render.py` 在 Windows 中文控制台假红（FOR-59）：`PYTHONIOENCODING=gbk` + `PYTHONUTF8=0` 下跑这条门禁，渲染层断言其实全部通过，但 `print_report` 打含 emoji 的昵称时炸出 `UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f600'`、进程 exit=1；本地复核会被误导，而 CI 只跑 ubuntu 抓不到这个环境。入口与 `print_report` 现在都走 `bili.streams.harden_stdio()`（与 CLI / Web / demo 同一份兜底，沿用 FOR-38 已定型的口径，不留第二份实现）

### Changed
- Web 表头排序修掉死字段（FOR-58）：比较器读的是从来没赋值的 `sort`（`state` 只有 `{cls,key,dir}`），所以「得分」「最近活跃(天)」「最新视频(天)」永远按字典序——100 排在 20 前面，`COLS` 里的 `sort:'num'` 是死字段。排序类型现在只从 `COLS` 查（`sortKind`），数值列按数值排、非数字脏数据退回字典序；表头加 ↑/↓ 与 `aria-sort` 指示，并新增 `/?sort=<key>&dir=<asc|desc>` 预置排序（既是深链，也让 `--dump-dom` 的渲染层取证能钉住排序：headless 不会点表头）
- README.md / README_en.md 测试条数口径 230 → 233 → 244 → 247，由 `tests/test_release_hygiene.py` 钉死：README 写的条数与 `pytest --collect-only` 实际收集数不一致时 CI 直接红

### Added
- 真实 chromium 渲染层断言进 CI（FOR-57）：`tools/probe_web_render.py` 起 `python -m bili.web` + headless chromium `--dump-dom`，对渲染后的 `<tbody>` 断言（真实导出夹具 + 「昵称像数字 / 含 HTML / 为空」的对抗夹具），命令行可直接跑、也供测试复用；`tests/test_web_render.py` 把这套断言收进 pytest（本机无 chromium 时跳过）；`.github/workflows/ci.yml` 新增 web-render job（playwright chromium + `BILI_REQUIRE_BROWSER=1`），浏览器装不上就红，门禁不会悄悄空跑
- 排序取证（FOR-58）：`tools/probe_web_render.py` 的数值跨度夹具 + `check_sort` 单调性断言（`3.14 < 20 < 100`、换一列排行序必须跟着那一列走、空值永远垫底）——字典序的坏法在单调性上立刻露馅，不必复刻 JS 比较器
- `tests/test_probe_console.py`（FOR-59）：不需要浏览器的输出编码钉——在 `PYTHONIOENCODING=gbk`（换 `cp936` 再钉一次）+ `PYTHONUTF8=0` 下调用 `print_report` 不得抛 `UnicodeEncodeError`、退出码必须 0，并 pin 住入口与 `print_report` 两处 `harden_stdio()`

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
