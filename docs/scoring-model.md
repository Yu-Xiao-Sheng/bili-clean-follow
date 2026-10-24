# 打分模型（Scoring Model）

bili-clean-follow 为每个关注给出 0–1 的分数，并附人类可读的原因。分数由三个加权信号组成。

> 口径变更（v0.1.2 / FOR-36）：**信号缺失 = 未知，不是最差**。v0.1.1 把未提供的信号置为 0、权重和固定 1.0，导致「不知道」在数学上等于「最坏」，真实导出（只有 identity + bio）会一边倒被判成 remove。

## 信号（Signals）

| 信号 | 权重 | 含义 | 来源字段 |
|------|------|------|------|
| recency | 0.45 | 最近多久看到 / 对方最近多久发布 | `last_seen_days` / `last_video_days` |
| authority | 0.30 | 粉丝/关注比（圈层质量代理） | `follower_count` + `following_count` |
| relevance | 0.25 | 简介质量 + 官方/认证标记 | `bio` / `sign` |

一个信号是否「已提供」取决于字段是否存在：recency 要求两个日期至少一个非空，authority 要求粉丝数与关注数**都**非空，relevance 要求简介非空。

## 计算（Computation）

```
已提供信号集合 P（缺失的不进 P）
score = Σ(w_k · p_k, k∈P) / Σ(w_k, k∈P)      # 分母只含已提供信号的权重
P 为空时 score = 0.0
```

各子分（recency/authority/relevance）均在 [0, 1] 区间：

- **recency**：线性衰减，0 天 = 1.0，越久越接近 0。
- **authority**：归一化的 follower/following 比值。
- **relevance**：简介完整度 + 官方/认证关键词。

举例：只给 `last_seen_days=0`、`follower_count=10000`、`following_count=1`（简介为空）
→ `score = (0.45·1 + 0.30·1) / (0.45 + 0.30) = 1.00`，而不是旧口径的 0.75。

## 阈值（Thresholds）

| 分数区间 | 分类 | 含义 |
|----------|------|------|
| [0.70, 1.00] | keep | 值得保留 |
| [0.40, 0.70)  | review | 值得再看 |
| [0.00, 0.40) | remove | 可清理候选 |

## 两道闸门（Hard gates，FOR-36 唯一实现口径）

- **闸门 A（取关方向）**：recency 未知 → **不得判 remove**，最多 review，
  原因行追加 `downgraded to review: no recency signal`。
  理由：取关的核心证据是「太久没动静」，而这个信号恰恰是真实导出里最容易缺的那个。
- **闸门 B（保留方向）**：`keep` 至少要提供 recency 或 authority **之一**；
  只有简介（relevance）时即写着「官方认证的媒体账号」也不得 keep，最多 review。

闸门不是调阈值：REVIEW_MIN / KEEP_MIN 保持 0.40 / 0.70 不变，也不允许靠改这两个常量把缺失糊过去。

## 可观测性（Observability）

- 每行结果带 `signals_used`（已提供信号数 0–3），CSV、Markdown 表格、Web 报告都能看到。
- 当本次运行 **≥50%** 的记录缺 recency 时，Markdown 与 Web 报告顶部打一行警告：
  `missing-signal warning: N/M (…%) 的记录没有 recency 信号。先补 last_seen_days / last_video_days /
  follower_count / following_count（bili-merge 会生成待填模板），否则结果不可作为取关依据。`
- CLI 同时把这行警告打到 stderr，终端录制也能看见。

## 可解释性（Explainability）

每个关注的输出都包含分数 + 分项原因，例如：

```
recency: seen 2 days ago · authority: 180000 followers vs 60 following
· relevance: 7-char bio (official=yes) · class=keep score=0.94 signals_used=3
```

触发闸门时多一行说明：

```
recency: unknown · authority: unknown · relevance: 14-char bio (official=yes)
· downgraded to review: keep needs recency or authority
· class=review score=1.00 signals_used=1
```
