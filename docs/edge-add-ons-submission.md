# Edge Add-ons 上架材料登记（FOR-68 交付物 6）

状态：**待提交**（材料已备齐的部分列在下面，缺的都是人工开关，不是代码）。
Chrome Web Store 与 Edge Add-ons 用同一份材料与同一份代码：`extension/` 零构建，Load unpacked 的目录
直接改成打包目录上传（v2.0.0 用 `tools/package_release.mjs` 产出的 `dist/bili-clean-follow-<version>-extension.zip`）。

## 1. 上架前置（缺这些就提交不了）

| # | 前置 | 状态 | 备注 |
|---|---|---|---|
| 1 | `docs/qa-report-v2.md` 判 Go | ❌ 等 FOR-67 | 硬门禁：报告缺失或 No-Go 时不得打包 / 打 tag（`tools/package_release.mjs` 退出码 1） |
| 2 | `extension/manifest.json` 版本号改成 `2.0.0`（现在是预览构建号 `2.0.0.3`） | ❌ 等发布动作 | 门禁会拒正式版号以外的版本，见 `checkManifest` |
| 3 | Edge 开发者后台账号（微软账号 + 开发者协议） | ❌ 需人工 | 一次性，约 $10 注册费 |
| 4 | 隐私政策公开 URL | ✅ 仓库里已有 | `https://github.com/Yu-Xiao-Sheng/bili-clean-follow/blob/main/PRIVACY.md` |
| 5 | 商店图标 3 档（48 / 128 / 高解析 1024 或 3000x400 横幅） | ⚠️ 素材在仓库，需按商店尺寸裁一版 | `assets/bili-clean-logo.png`、`assets/bili-clean-banner.png`（`.svg` 是母版） |
| 6 | 商店截图 2-3 张（1280x720 起） | ❌ 等取证截图 | 与 `docs/extension-install.md` 的 `assets/install/step4-progress.png`、`step5-categories.png` 同一批（`promo/tools/capture_ui.mjs`，依赖报告） |
| 7 | 扩展说明正文（下面第 3 节，已写好） | ✅ | 直接粘 |
| 8 | 权限用途逐条说明（下面第 4 节，已写好） | ✅ | 直接粘 |
| 9 | 是否收集数据 / 使用条款 URL | ✅ 已在 PRIVACY.md 写清：不收集 | 商店表单填「不收集数据」 |
| 10 | Edge 版是否需要单独 manifest 改动 | ✅ 不需要 | MV3 通用；`edge://extensions` 与 Chrome 同一份代码 |

## 2. 名称与分类

- 名称（≤ 71 字符）：`Bili Clean Follow（B站关注列表清理 · 只读分析）`
- 简短介绍（≤ 132 字符）见第 3 节中文版第一行。
- 分类：Productivity（生产力）
- 语言：zh-CN（英文简介同节末尾）

## 3. 简介正文（商店描述，直接粘）

抓全你的 B站关注列表，看清每个人是谁、为什么关注，然后**由你决定**留谁。凭据永不出本机，昵称与简介只发给你自己指定的模型端点（不填就零外发）。

4 步装好，不用装 Python：`extension/` 解压 → `edge://extensions` 开开发者模式 → 「加载未打包的扩展」→ 浏览器里登录 B站。

能做什么：
- 分块抓全关注列表，`已取 == B站给出的关注数` 才宣布读全（没读全时分类按钮是灰的，这是验收项不是提示文案）
- 12 类可编辑分类：离线规则（零网络）或你自带 Key 的 OpenAI 兼容端点（DeepSeek / 智谱 / Kimi / 通义 / 本机 Ollama / 自定义）
- 一句中文整理：「清掉搞笑段子」→ 先看 diff 预览（影响 N 人、按类分组、10 条样例）→ 手输 `UNFOLLOW` 才执行
- 导出：Markdown 报告、带 UTF-8 BOM 的 CSV、`mid <TAB> 昵称` 的人工核对清单、取关审计 CSV

安全口径（重要）：**取关是真实写操作，默认关闭**，需要开关 + 二次确认 + 看过 diff 预览 + 手输 `UNFOLLOW` 四步都满足；
单次批量默认 50（硬上限 200）、速率下限 800ms/条、遇 B站风控码 `-352` / HTTP 412 立刻熔断并保存断点；
`keep` 类别与「待确认」（置信 < 0.55）永不进候选；执行前落盘「本次将取关清单」，并提供一键重新关注作补救。
B站没有撤销 API：取错了只能靠补救清单，且不保证补得回来。自动化取关属于账号操作，可能触发风控，风险由使用者自担。

隐私：没有我们的服务器，无遥测、无统计、无第三方目的地白名单（CI 会扫扩展源码）。
Cookie 与 API Key 绝不离开本机；外发载荷里没有 mid、头像、关注关系与任何凭据，只有昵称（可只发昵称）与一次性代号。
完整政策：https://github.com/Yu-Xiao-Sheng/bili-clean-follow/blob/main/PRIVACY.md

English (short): Open-source Bilibili following-list cleaner. Reads your whole following list (stops claiming "complete"
until fetched == total), classifies it offline or with your own API key, and only unfollows after you arm it:
switch + confirmation + diff preview + typing `UNFOLLOW`. Credentials never leave the machine; there is no server of ours.

## 4. 权限用途（商店表单的逐条答复）

| 权限 / host | 为什么需要 |
|---|---|
| `https://api.bilibili.com/*` | 读关注列表（`x/relation/followings`、`x/web-interface/nav`、`x/relation/stat`）与取关写操作（`x/relation/delete`，默认关闭） |
| `https://www.bilibili.com/*`, `https://space.bilibili.com/*` | 关注页内联按钮与接口被风控时的 DOM 兜底抓取 |
| `cookies` | 读取你在浏览器里已有的 B站登录态，判断 `-101 未登录`；Cookie 不写盘、不进日志、不发第三方 |
| `storage` | 抓取进度、分类结果、审计日志、API Key（独立键）都存在你本机的扩展存储 |
| `scripting` | content script 未生效时在关注页补注入兜底抓取函数 |
| `sidePanel` | 侧栏 UI（v2 主界面） |
| `optional_host_permissions`（`https://*/*`、localhost） | 只在「AI 分类（BYOK）」里选了自己端点之后、且确认外发告知之后，才申请那**一个** origin；安装时不预授 |

## 5. 提交步骤（报告 Go 之后）

1. `node tools/package_release.mjs`（过门禁 → 产出 `dist/bili-clean-follow-2.0.0-extension.zip`，记下 sha256）
2. 建 tag `v2.0.0` + GitHub Release，附件就是那个 zip（Release 说明含「取关不可撤销 / 可能触发风控」两条）
3. Edge Add-ons 后台 → 新扩展 → 上传 zip → 填第 2/3/4 节材料 + 图标 + 截图 → 隐私政策 URL → 提交审核
4. Chrome Web Store 同一份材料另开一份（若不做 Chrome，就写明只做 Edge + 手动 Load unpacked）
5. 回到 FOR-68 把本表的 ❌ 改成 ✅，并登记商店 listing URL 与版本号
