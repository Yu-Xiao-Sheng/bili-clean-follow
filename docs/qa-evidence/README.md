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

取证脚本已在 `integration/for-67-v2-tree = 67ca310` 落地：`tests/e2e/track_b_real_readonly.mjs`。
真实会话必须带人的授权（对应 FOR-67 人工卡里的选项 id），否则脚本自己退 4，不碰真实账号：

```
# 卡片选 give_profile：给一个已登录 B站的画像目录
node tests/e2e/track_b_real_readonly.mjs --consent=give_profile --profile=<画像目录>

# 卡片选 grant_current_login：只把登录相关文件复制到临时目录再跑，不动日常 Chrome 画像
node tests/e2e/track_b_real_readonly.mjs --consent=grant_current_login --copy-profile-from=<User Data 根目录>
```

只读是浏览器层 CDP `Fetch` 拦的（只读端点白名单 + 写端点永拒），不是靠产品代码自觉；
`R1` 证明护栏看得见 service worker 的抓取路径、`R2` 用一次被拦的 `POST /x/relation/delete`
做负向对照。退出码与三个 CDP 坑的口径在 `tests/e2e/README.md`。CI 上跑的是替身自检
（`--mock`）：产物只进 `tmp/`，**永不**写这份文件——把替身当真实会话是 No-Go 硬条件④。
抓取走扩展自身的只读路径（FOR-63 的分页抓全，`fetched >= total` 才算读全），
把内存里的条目按上面四列导出；分类结果来自 FOR-64 的分类落库结果。导出前后各打一次
条数，两个数不一致就别落盘——报告里那三个数（B5）会被同一条门禁抓住。
