# 变更记录（Changelog）

All notable changes to this project will be documented in this file.

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [Unreleased]

### Changed
- **打分口径：信号缺失按「未知」处理，不再按「最差」处理（FOR-36，v0.1.1 的行为是 bug）**：v0.1.1 把未提供的信号置为 0、权重和固定 1.0，「不知道」在数学上等于「最坏」，真实导出（只有 identity + bio）会一边倒跑成 `keep=0 review=0 remove=13`。现在只对已提供信号求加权平均（`score = Σ(w_k·p_k) / Σ(w_k)`，分母只含已提供信号的权重），并加两道硬闸门：闸门 A 缺 `recency` 不得判 remove（原因行 `downgraded to review: no recency signal`），闸门 B 只有简介不得判 keep。REVIEW_MIN / KEEP_MIN 保持 0.40 / 0.70 不变；仓库自带样例与 demo 的可复现输出不变（24 条样例每条都给满三个信号）
- 报告与 CSV 的可观测性字段定型（FOR-36）：CSV 新增 `signals_used` 与 `missing_signals` 两列，存分号连接的信号名（`recency;authority`，顺序固定，两者互补，全缺时为空串），数据层不存 0–3 整数；Markdown 与 Web 报告共用同一份显示串，一个信号都没有时显示「未知」，CSV 不翻译。取关清单与报告同一条记录三处显示完全相等
- 本次运行 ≥50% 记录缺 recency 时，Markdown / Web 报告顶部与 CLI stderr 打一行显式警告：先补 last_seen_days / last_video_days / follower_count / following_count（bili-merge 会生成待填模板），否则结果不可作为取关依据（FOR-36）

### Fixed
- 真实导出识别（FOR-37）：`{"code":0,"data":{"follower":[…]}}` 与 `data.list` 信封会自动解包，浏览器里直接复制的关注列表响应不用再手工提到顶层；昵称认 `name` / `uname`，取关清单不再是一串空名字；官方认证改认 `official.role/title/department` 与 `official_verify.type > 0`（落到 `extra.official_*` 并进 relevance），不再只靠简介里有没有「官方」两个字——换个 bio 就不会掉认证。`official_verify.type` 为 0 / -1 视为无认证占位，不算认证证据
- Windows 中文控制台 P0（FOR-38）- Windows 中文控制台 P0（FOR-38）：昵称含 emoji 时 CLI / Web / demo 不再 UnicodeEncodeError 崩栈——入口统一 `bili.streams.harden_stdio()`，写 stdout 再兜一层，报告不会整份丢失
- CSV 与取关清单统一 utf-8-sig（带 BOM），Windows Excel / WPS / 记事本双击打开中文不再乱码；Markdown 仍为不带 BOM 的 utf-8（FOR-38）
- 取关候选清单从「只有 mid 数字」改为 `mid <TAB> 昵称` + 说明抬头，CLI 与 Web `/unfollow` 共用同一份，并写明只用于人工核对、工具不会自动取关（FOR-38）
- 凭据拦截改为内容优先：内容里真的出现 SESSDATA / bili_jct 等 cookie 键才拒绝并点名键名；只是文件名带 cookie 的正常导出改为放行 + 提示改名，拒绝信息附带改名建议（FOR-38）
- 输入 JSON 以 utf-8-sig 读取，记事本 / Excel 另存带 BOM 的导出不再报解码错（FOR-38 顺带修掉 FOR-35 记录的 BOM 断层）
- README 快速开始补安装步骤（首行就是 pip install，Release zip 或 pip install -e .），修掉「全新克隆直接跑 python -m bili.demo 就 ModuleNotFoundError」的落地页断层（FOR-32）；README.md / README_en.md / docs/getting-started.md 同步
- Python 版本口径统一到 3.9+：pyproject、README、仓库描述一致；CI 矩阵扩到 3.9–3.13，并改用 pip install -e .[dev] 走用户真实安装路径
- docs/getting-started.md 修复被转义吃掉的命令与文件名（report.md、to-unfollow.txt 等），并去掉「不用安装直接跑源码」的错误指引

### Added
- `bili-merge` 补信号伴生工具（FOR-40）：`--template` 生成已预填 mid + 昵称的 signals.csv（utf-8-sig，Excel/WPS 直接编辑），`--signals` 把手工抄的 last_seen_days / last_video_days / follower_count / following_count 合并成 follows.merged.json；纯本地不联网，默认只填空缺不覆盖已有值，终端按「第 1/2/3 步」输出并给最终 Summary（录屏友好）；留空=未知，未知不作为取关依据（与 FOR-36 口径一致）。pyproject 注册 console script，避免「文档里有命令但装不出来」
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
