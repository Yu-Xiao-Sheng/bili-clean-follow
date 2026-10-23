# 变更记录（Changelog）

All notable changes to this project will be documented in this file.

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

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

## [Unreleased]

### Added
- v0.2.x 开发中：每周节奏、社区渠道（QQ/Discord）计划