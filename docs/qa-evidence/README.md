# 取证快照 scan-items.json（FOR-67 产出 · FOR-70 消费）

FOR-70 的两支 v2 影片里，「12 张分类卡片 / 指令预览影响 N 人 / 审计列表」这些**逐条列表镜头**
需要可回放的真实抓取条目；只有聚合数字（follow_total / cls.counts / diff.n）拍不出逐条行。
FOR-70 在 2026-10-26 明确提了这个前置，FOR-67 在此把契约定死（字段与对账口径都由
`tests/test_release_hygiene.py::test_qa_evidence_scan_items_snapshot_matches_the_report` 钉住）。

## 位置与形状

- 路径：`docs/qa-evidence/scan-items.json`（与 `docs/qa-report-v2.md` / `docs/qa-report-v2.json` 同批产出）
- 顶层是**非空数组**，每个元素**有且只有**四个字段：

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `mid` | B 站用户 mid | 不得重复（与 B1 去重口径一致）；报告里 `follow_total` 应等于数组长度 |
| `name` | 昵称（可含 emoji） | 非空。允许做别名化/截断，但不许留空，否则逐条镜头拍成空白 |
| `category` | 分类稳定 id | 必须落在报告 `cls.counts` 的类目集合里；全体分布要与 `cls.counts` 逐类目相等 |
| `confidence` | 分类置信度 | 0..1 的数值 |

## 脱敏红线（这份文件会进 git）

字段是**白名单制**：多一个键就判红。禁止把 `cookie` / `SESSDATA` / `bili_jct` / API key /
设备指纹 / 原始响应体任何一部分写进来。B 轨取证时只导出上面四列——需要看原始形状去
`tests/e2e/` 的 mock 夹具，那里才是原始响应。

## 与报告的对应关系（CI 会逐条核对）

- `len(items) == report.follow_total`
- 每个 `mid` 唯一
- 按 `category` 统计的条数 == `report.cls.counts`（忽略 0 条的类目）
- 缺这份文件时：`promo/tools/capture_ui.mjs` 只拍聚合层，并把 `manifest.json` 里的
  `syntheticNames` 写成 `true`，`preview:gif` 环节据此拒绝出片（FOR-70 自加的防呆）

## 取证时怎么生成（B 轨真实登录态只读会话）

抓取走扩展自身的只读路径（FOR-63 的分页抓全，`fetched >= total` 才算读全），
把内存里的条目按上面四列导出；分类结果来自 FOR-64 的分类落库结果。导出前后各打一次
条数，两个数不一致就别落盘——报告里那三个数（B5）会被同一条门禁抓住。
