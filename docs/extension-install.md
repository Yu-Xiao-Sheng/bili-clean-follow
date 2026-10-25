# 插件安装与使用（v2 预览版，进行中）

> 对应工单 FOR-63。这一步只做「抓全关注列表 + 只读报告」：没有分类、没有自然语言指令、没有取关写操作。
> 状态口径以 FOR-62 的 v2-spec 为准；插件是 v2 的主实现，Python CLI 进维护模式。

## 1. 装（4 步，零依赖）

`extension/` 里全是原生 ES Module JavaScript，没有打包步骤、没有 `node_modules`、没有 `package.json` 依赖。

1. 取到 `extension/` 目录：正式发布后下载 `bili-clean-follow-v2.0.0-extension.zip` 解压；预览阶段克隆仓库取 `extension/`。
2. 放到固定目录（Chrome 记录的是路径，删目录 = 插件失效）。
3. `chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选 `extension/` 目录本身（不是它的上级目录）。
4. 浏览器里先登录 bilibili.com（必需：`x/relation/followings` 在未登录时返回 `code=-101 账号未登录`，这是本轮实测结论）。

Edge 同理：`edge://extensions` → 开发者模式 → 加载未打包的扩展。

## 2. 用

1. 点工具栏图标 →「分析我的关注列表」，Side Panel 自动打开。
2. 侧栏显示 **已取 / total / 页数**，抓取过程分块写进 `chrome.storage.local`，中途关掉页面也不丢。
3. 读全（`fetched == total`）之前「开始分类」是灰的，旁边写「还没读全（已取 431/812）」——这是验收项，不是提示文案。
4. 中断（风控、手动停止、翻页耗尽）：状态变 `incomplete`，已取数据保留，点「继续抓取」从断点页继续；靠 mid 去重，重复页不会重复计数。
5. 导出：`report.md`（人看）、`report.csv`（带 UTF-8 BOM，Excel/WPS 双击不乱码）、`to-unfollow.txt`（`mid <TAB> 昵称` 的人工核对清单）。字段与 CLI 产物一致。

## 3. 出问题时看这里

| 现象 | 含义 | 怎么办 |
|---|---|---|
| 「未登录（code -101）」 | 浏览器里没有效登录态 | 登录 bilibili.com 后点「检查登录态」，再重新抓取 |
| 「B站风控（code -352）」 | 请求被风控拦下 | 已保存断点，歇几分钟点「继续抓取」；插件自带 ≥450ms + jitter 的自我限速，不会突破 |
| 「需要 wbi 签名（HTTP 412）」 | 该接口需要签名 | 抓取主路径不依赖签名接口；插件会自动降级到页面内 fetch / 关注页 DOM 兜底 |
| total 显示 2000 | B站关注数展示有上限 | 用关注页显示的关注数核对；`fetched == total` 门禁在 2000+ 关注时可能不成立，侧栏会提示 |
| 已取条数比 total 多 | 翻页期间关注列表发生漂移 | 按 `fetched >= total` 判定读全，侧栏会给核对提示；建议重抓一次 |
| 兜底抓到 0 条 | B站关注页改版，DOM 选择器失配 | 侧栏不会宣布读全（记 `incomplete`），提 issue 附关注页 HTML 片段 |

## 4. 边界与安全口径

- 只读：只调 `x/web-interface/nav`、`x/relation/followings`（+ 匿名可用的 `x/relation/stat`、`x/web-interface/card`）。
  实测不可用的 `x/relation/followers`、`x/space/wbi/acc/info` 与需要签名的两个动态/投稿接口，
  以及写接口 `x/relation/delete` / `x/relation/add`，全部钉在 `extension/biliApi.js` 的 `FORBIDDEN_ENDPOINTS` 黑名单里，
  单测会在别的文件出现这些接口名时直接失败。
- 凭据：Cookie 与 Key 不进仓库、不进日志、不进导出文件；写 `chrome.storage.local` 前一律过
  `stripSecretFields` + `assertSecretFree`（命中凭据形态就拒写）。
- 不联网到任何第三方服务。AI 分类（BYOK）是后续工单，启用前会先告知发送哪些字段、发到哪个端点。

## 5. 开发者：跑扩展的离线单测

不需要 Chrome，也不需要 B站账号：

```
node --version          # 需要 Node 20+
node --test "tests/extension/*.test.mjs"
```

覆盖：分页合并与 mid 去重、`fetched == total` 读全门禁、`incomplete` 断点与续抓、
错误语义映射（0 / -101 / -352 / 412）、导出格式与 CLI 常量交叉比对、
凭据不落盘不外泄、manifest 权限最小集与「extension/ 无构建产物」。

目录结构见 `extension/`：`manifest.json`、`background.js`（抓取调度 + 三级降级）、
`biliApi.js`（唯一接口层）、`store.js`（storage 仓储 + 状态机）、`report.js`（导出）、
`privacy.js`（凭据边界）、`sidepanel.*`、`popup.*`、`content/followpage.js`（关注页内联按钮 + DOM 兜底）。
