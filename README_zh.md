# Bili Clean Follow（B站关注列表清理工具）

一个开源工具：分析你的 B站关注列表，把每个关注按 **keep / review / remove** 分类，并给出可解释的原因——让你有把握地清理掉过期、不活跃或低价值关注。

## 为什么需要

你可能已经关注了几百（甚至上千）个 B站账号，其中很多你已经不记得自己何时关注过。逐条翻看太痛苦。这个工具会给每个关注一个"值得保留"的分数，并 handing 给你一份取关候选清单。

## 核心定位

**不替你删，只帮你看清。**

bili-clean-follow 是「本地、透明、只报告」的 B站关注清理工具，三支柱：
- **安全（Safety）**：report-only。从不调用 unfollow API；`--dry-run` 是默认且唯一行为。数据（cookie、关注列表）不出本机。
- **透明（Transparency）**：每个关注都有 0–1 分数和人类可读的打分原因（最近看到 X 天 / 粉丝比 / 简介质量）。
- **轻量（Lightweight）**：纯本地、零第三方依赖的 Python CLI。无云端、无遥测。

## 特性

- **默认报告-only，安全**：它从不调用 unfollow API，不触碰你的账号。
- **可解释**：每个决策都附带一个数值分数和一个原因字符串。
- **导出** Markdown（给人看）和 CSV（给表格），以及可选的"取关候选清单"（候选 id）。
- **数据缺失时中立**——没有信号的账号永远不会被自动保留。
- **不提交凭据**；基于用户提供的 JSON 导出工作。

## 快速开始

```python
python -m bili.demo          # 生成 sample-follows.json
bili-clean sample-follows.json --md report.md
```

或带你自己的导出：

```
bili-clean follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

然后打开 report.md，手动处理 to-unfollow.txt。

## 如何得分

三个加权信号（见 [docs/scoring-model.md](docs/scoring-model.md)）：

- **recency（0.45）** —— 你最近多久看到 / 对方最近多久发布。
- **authority（0.30）** —— 粉丝/关注比（圈层质量代理）。
- **relevance（0.25）** —— 简介质量 + 官方/认证标记。

阈值：score >= 0.70 为 keep，>= 0.40 为 review，其余为 remove。

## 项目结构

```
src/bili/        # 包：model, loaders, score, export, cli, demo
tests/           # pytest 测试套件
docs/            # spec.md, getting-started.md, scoring-model.md
.github/         # CI 工作流 + Issue/Discussion 模板
pyproject.toml
```

## 安全说明

这个工具只报告。它**不会** unfollow，**不会**上传你的数据，也**不会**保存任何东西。对任何关注采取行动之前，先审阅报告。

## 许可证

MIT。