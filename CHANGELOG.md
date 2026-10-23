# 变更记录（Changelog）

All notable changes to this project will be documented in this file.

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [Unreleased]

### Fixed
- README 快速开始补安装步骤（首行就是 pip install，Release zip 或 pip install -e .），修掉「全新克隆直接跑 python -m bili.demo 就 ModuleNotFoundError」的落地页断层（FOR-32）；README.md / README_en.md / docs/getting-started.md 同步
- Python 版本口径统一到 3.9+：pyproject、README、仓库描述一致；CI 矩阵扩到 3.9–3.13，并改用 pip install -e .[dev] 走用户真实安装路径
- docs/getting-started.md 修复被转义吃掉的命令与文件名（report.md、to-unfollow.txt 等），并去掉「不用安装直接跑源码」的错误指引

### Added
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
