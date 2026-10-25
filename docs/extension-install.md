# 插件安装与使用（v2 预览版，进行中）

> 对应工单 FOR-63 + FOR-64。现在能做：抓全关注列表 → 分类（离线规则 / 你自带 Key 的模型端点）→ 只读报告。
> 还没有：自然语言指令、取关写操作（FOR-65）。
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
5. 导出：`report.md`（人看）、`report.csv`（带 UTF-8 BOM，Excel/WPS 双击不乱码）、`to-unfollow.txt`（`mid <TAB> 昵称` 的人工核对清单）。字段与 CLI 产物一致；分类之后 `class` / `reason` 列会带上类别与理由。
6. 读全之后点「开始分类」。没填模型 Key 时自动走**离线规则分类**（零外发）；想按自己的口径分类就点「只用离线规则分类」。
7. 想用 AI 分类：在「AI 分类（BYOK）」里选预设（DeepSeek / 智谱 / Kimi / 通义 / 本机 Ollama / 自定义）→ 填 baseURL、模型名、Key →「保存配置」。保存后旧的外发确认自动作废。
8. 点「开始分类」时会先弹**外发告知**：将发送 N 条昵称 + 简介到你填的端点，逐条列出不含什么；勾选「发送简介」可以关掉简介外发。确认后再申请访问该端点的权限（安装扩展时不预授）。
9. 分类结果按类别卡片显示：条数、占比、平均置信、来源（AI / 离线 / AI 失败降级）、「保留 / 进候选」。置信 < 0.55 的进「待确认」，卡片里能看到它本来像哪一类。
10. 分类体系可编辑：改名、改关键词、删除、「添加」新类。「其他」是兜底类不能删。改完立刻生效（离线路径直接吃这套关键词）。

## 3. 出问题时看这里

| 现象 | 含义 | 怎么办 |
|---|---|---|
| 「未登录（code -101）」 | 浏览器里没有效登录态 | 登录 bilibili.com 后点「检查登录态」，再重新抓取 |
| 「B站风控（code -352）」 | 请求被风控拦下 | 已保存断点，歇几分钟点「继续抓取」；插件自带 ≥450ms + jitter 的自我限速，不会突破 |
| 「需要 wbi 签名（HTTP 412）」 | 该接口需要签名 | 抓取主路径不依赖签名接口；插件会自动降级到页面内 fetch / 关注页 DOM 兜底 |
| total 显示 2000 | B站关注数展示有上限 | 用关注页显示的关注数核对；`fetched == total` 门禁在 2000+ 关注时可能不成立，侧栏会提示 |
| 已取条数比 total 多 | 翻页期间关注列表发生漂移 | 按 `fetched >= total` 判定读全，侧栏会给核对提示；建议重抓一次 |
| 兜底抓到 0 条 | B站关注页改版，DOM 选择器失配 | 侧栏不会宣布读全（记 `incomplete`），提 issue 附关注页 HTML 片段 |
| 「没填 API Key：只用离线规则分类」 | 没配 BYOK | 正常状态。想要更准的分类就填端点与 Key；不想外发就别填 |
| 「还没确认将发送哪些内容到哪个端点」 | 外发告知还没确认 | 点「开始分类」，读完弹窗再确认；换过端点必须重新确认 |
| 「端点必须是 https://（或本机 127.0.0.1 / localhost）」 | baseURL 填了明文 http | 换成 https 端点，或本机回环地址（数据不出这台机器） |
| 「没拿到访问 xxx 的权限」 | 浏览器拒绝了该 origin 的权限申请 | 这次会退回离线分类；需要 AI 就在扩展详情里允许该站点访问 |
| 类别卡片标「AI 失败降级」 | 该批 JSON 解析失败 / 端点 429 / 5xx | 已自动重试一次并降级为离线粗分类；歇一下重跑，或换个更听话的模型 |
| 「待确认」很多 | 简介为空或信号太弱（尤其离线粗分类） | 给模型填 Key 重跑；或在「分类体系」里补关键词；别指望空简介的 UP 主能被规则猜出来 |

## 4. 边界与安全口径

- 只读：只调 `x/web-interface/nav`、`x/relation/followings`（+ 匿名可用的 `x/relation/stat`、`x/web-interface/card`）。
  实测不可用的 `x/relation/followers`、`x/space/wbi/acc/info` 与需要签名的两个动态/投稿接口，
  以及写接口 `x/relation/delete` / `x/relation/add`，全部钉在 `extension/biliApi.js` 的 `FORBIDDEN_ENDPOINTS` 黑名单里，
  单测会在别的文件出现这些接口名时直接失败。
- 凭据：Cookie 与 Key 不进仓库、不进日志、不进导出文件；写 `chrome.storage.local` 前一律过
  `stripSecretFields` + `assertSecretFree`（命中凭据形态就拒写）。
- 外发只有一条路径，且由你决定：只有你填了端点 + Key、确认了告知弹窗、并在浏览器里授权该 origin 之后，
  才会发送「昵称（+简介）+ 一次性代号 r1、r2…」。mid、Cookie、UID、头像、关注关系永不出本机。
  完整口径见 [PRIVACY.md](../PRIVACY.md)；CI 会扫扩展源码，出现白名单（B站三个域 + BYOK 预设）之外的硬编码 URL 直接红。
- 写操作仍然全禁：本版不会取关、不会加关注（取关能力在 FOR-65 带七条护栏接入）。

## 5. 开发者：跑扩展的离线单测

不需要 Chrome，也不需要 B站账号：

```
node --version          # 需要 Node 20+
node --test "tests/extension/*.test.mjs"
```

覆盖（84 项）：分页合并与 mid 去重、`fetched == total` 读全门禁、`incomplete` 断点与续抓、
错误语义映射（0 / -101 / -352 / 412）、导出格式与 CLI 常量交叉比对、凭据不落盘不外泄、
manifest 权限最小集与「extension/ 无构建产物」；以及 FOR-64 的：12 类体系与增删改名、
离线分类在真实形状 fixture 上的结果与「零外发」断言、BYOK 每批 40 条 + JSON schema +
重试一次后降级 + 「没 Key/没确认就一条都不发」+ 载荷里没有 mid 与凭据、
低置信进「待确认」、Key 只待在独立存储键、类别卡片与外发告知弹窗的 UI 静态门禁。

目录结构见 `extension/`：`manifest.json`、`background.js`（抓取调度 + 三级降级）、
`biliApi.js`（唯一接口层）、`store.js`（storage 仓储 + 状态机）、`report.js`（导出）、
`privacy.js`（凭据边界）、`sidepanel.*`、`popup.*`、`content/followpage.js`（关注页内联按钮 + DOM 兜底）；
分类三件套：`taxonomy.js`（12 类 + 可编辑 + 稳定 id）、`classifyLocal.js`（离线规则，零网络）、
`classifyLlm.js`（BYOK，OpenAI 兼容）、`classify.js`（读全门禁 + 结果落库 + 保留/进候选决策）。
