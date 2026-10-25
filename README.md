# Bili Clean Follow（B站关注列表清理工具）
> **中文 / English** — 当前为中文，[查看英文版](README_en.md)。
> **仅本地运行**：你的 cookie 与密钥绝不上传到任何外部服务；数据全程留在本机。

一个开源工具：分析你的 B站关注列表，把每个关注按 **keep / review / remove** 分类，并给出可解释的原因——让你有把握地清理掉过期、不活跃或低价值关注。

> 🎬 **两支 60 秒的片子**（1080p，带音轨）：[产品介绍片](https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.3/bili-clean-promo.mp4) · [使用教程片](https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.3/bili-clean-walkthrough.mp4)

## 为什么需要

你可能已经关注了几百（甚至上千）个 B站账号，其中很多你已经不记得自己何时关注过。逐条翻看太痛苦。这个工具会给每个关注一个"值得保留"的分数，并把一份取关候选清单交到你手上。

## 核心定位

**不替你删，只帮你看清。**

bili-clean-follow 是「本地、透明、只报告」的 B站关注清理工具，三支柱：
- **安全（Safety）**：report-only。从不调用 unfollow API；`--dry-run` 是默认且唯一行为。数据（cookie、关注列表）不出本机。
- **透明（Transparency）**：每个关注都有 0–1 分数和人类可读的打分原因（最近看到 X 天 / 粉丝比 / 简介质量）。
- **轻量（Lightweight）**：纯本地、零第三方依赖的 Python CLI。无云端、无遥测。

## 特性

- **默认只出报告，安全**：它从不调用 unfollow API，不触碰你的账号。
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

前置：Python 3.9+（CI 覆盖 3.9–3.13，另有一个 Windows GBK 冒烟 job 与一个「真实 chromium 渲染 Web 报告」的 DOM 门禁 job；本轮实测 Python 3.13.15，249 项 pytest 全绿）。
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
src/bili/        # 包：model, loaders, score, export, cli, demo
tests/           # pytest 测试套件
docs/            # spec.md, getting-started.md, scoring-model.md
.github/         # CI 工作流 + Issue/Discussion 模板
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

数据全程留在本机：本工具不连接任何外部服务，从不调用 unfollow API。

## 安全说明

这个工具只报告。它**不会** unfollow，**不会**上传你的数据，也**不会**保存任何东西。对任何关注采取行动之前，先审阅报告。

## 许可证

MIT。
