# tests/e2e —— FOR-67 三轨取证的夹具与替身

这里放的是**取证脚手架**，不是产品代码：`extension/` 依旧零构建、零依赖（A1 门禁在
`tests/extension/no_build_artifacts.test.mjs`），本目录的依赖只服务于测试。

## 文件

| 文件 | 作用 | 今天能跑吗 |
|---|---|---|
| `mock_bilibili.mjs` | B站接口替身（真 TLS，自签证书）+ 分页夹具：3 页 / 原始 63 行 / 去重后 62 条，含 emoji 昵称、官方认证、空简介与整字段缺失简介，可按页注入 `-352` | 是 |
| `track_a_fixture_selftest.test.mjs` | 夹具与替身的自证（B1 去重口径、真实形状三件套、pn 序列、越界空页、风控注入） | 是，4 条全绿 |
| `track_a_extension_e2e.mjs` | A 轨真机取证：真 Chrome + 未打包扩展 + 网络层替身，断言 B1/B2/B5/C2/B3，产出 `tmp/qa-e2e/track-a.json` | 装不上扩展时以退出码 2 明确失败（见下） |

跑法：

```
npm --prefix tests/e2e ci
node --test tests/e2e/*.test.mjs          # 夹具自证，不需要浏览器
node tests/e2e/track_a_extension_e2e.mjs  # A 轨真机（HEADLESS=1 走 new headless）
```

## 为什么替身走网络层而不是 Playwright route

抓关注列表的主路径是 MV3 **service worker** 里的 `fetch`（`extension/background.js`），
Playwright 的 `page.route` / `context.route` 覆盖不到 service worker 的请求。所以
`--host-resolver-rules` 把 `api/www/space.bilibili.com` 三个域解析到本机端口，
配自签证书 + `--ignore-certificate-errors`。实测这条通路是通的：A 轨脚本里
`nav` 与三页 `followings` 都由替身应答，且每次请求的 `pn` 与时间戳都落进日志。

## 环境门禁（实测 2026-10-26，A 轨真机取证的前置）

`--load-extension` 在本机所有可用浏览器形态下都**不注册**未打包扩展，已逐一排除：

| 浏览器 | 启动方式 | 结果 |
|---|---|---|
| Playwright chromium-1248（Chrome 156 内核） | Playwright `launchPersistentContext`（含 `ignoreDefaultArgs: ["--disable-extensions"]`） | 未注册 |
| 同上 | 直接 spawn + `connectOverCDP` | 只有内置组件扩展，没有本仓库扩展 |
| Chrome for Testing 156.0.8078.47 | Playwright（headed 与 `--headless=new`） | 未注册 |
| Chrome for Testing 134.0.6998.88 / 126.0.6478.127 | 直接 spawn + CDP `/json/list` | 无任何扩展 target |
| CDP `Extensions.loadUnpacked` | CfT 156 浏览器级 session | `Invalid parameters` |
| 最小 hello world（只有 `manifest.json` + `sw.js`） | 以上任一方式 | 同样不注册（排除本仓库 manifest 的问题） |

所以 A 轨真机取证必须换一种「扩展能装载」的形态，三条候选：

1. **Linux CI**：`ubuntu-latest` + Playwright 官方 Chromium（headful + xvfb）跑 `track_a_extension_e2e.mjs`，这是最接近真实用户的路径，CI 里跑通即算上线取证；
2. 钉一个仍支持 `--load-extension` 的 **Chromium（非 branded）** 构建；
3. 降级形态：把 `extension/*.js` 在页面上下文里加载跑同一批断言——能拿逻辑证据，但**必须在报告里标 `offline`**，不得算 `--load-extension` 真机取证。

在这三条之一落实前，`track_a_extension_e2e.mjs` 一律以退出码 2 失败，绝不静默绿；
报告里 A 轨状态写「未取证」，不写「通过」。