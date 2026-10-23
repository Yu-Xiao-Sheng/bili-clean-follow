# 变更记录（Changelog）

All notable changes to this project will be documented in this file.

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [Unreleased]

### Fixed
- Windows 中文控制台 P0（FOR-38）：昵称含 emoji 时 CLI / Web / demo 不再 UnicodeEncodeError 崩栈——入口统一 `bili.streams.harden_stdio()`，写 stdout 再兜一层，报告不会整份丢失
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
