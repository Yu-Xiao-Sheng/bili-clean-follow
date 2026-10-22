# 打分模型（Scoring Model）

bili-clean-follow 为每个关注给出 0–1 的分数，并附人类可读的原因。分数由三个加权信号组成。

## 信号（Signals）

| 信号 | 权重 | 含义 |
|------|------|------|
| recency | 0.45 | 最近多久看到 / 对方最近多久发布 |
| authority | 0.30 | 粉丝/关注比（圈层质量代理） |
| relevance | 0.25 | 简介质量 + 官方/认证标记 |

## 计算（Computation）

```
score = 0.45 * recency + 0.30 * authority + 0.25 * relevance
```

各子分（recency/authority/relevance）均在 [0, 1] 区间：

- **recency**：线性衰减。近期活跃得高分，长期无活动衰减至 0。
- **authority**：归一化的 follower/following 比。比值高 = 在该圈层较强势。
- **relevance**：结合简介完整度、官方/认证标记。无信号 = 0（中立）。

## 阈值（Thresholds）

| 分数区间 | 分类 | 含义 |
|----------|------|------|
| [0.70, 1.00] | keep | 值得保留 |
| [0.40, 0.70)  | review | 值得再看 |
| [0.00, 0.40) | remove | 可清理候选 |

## 中性（Neutral）

当没有可用信号（如无 recent data、无 bio）时，该信号记为 0，且该关注不会被自动归入 keep。工具坚持"不替你删"的原则。

## 可解释性（Explainability）

每个关注的输出都包含分数 + 分项原因，例如：

```
recency=0.92, authority=0.30, relevance=0.60  =>  score=0.70  [keep]
```