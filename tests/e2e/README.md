# tests/e2e —— FOR-67 三轨取证的夹具与替身

这里放的是**取证脚手架**，不是产品代码：`extension/` 依旧零构建、零依赖（A1 门禁在
`tests/extension/no_build_artifacts.test.mjs`），本目录的依赖只服务于测试。

## 文件

| 文件 | 作用 | 今天能跑吗 |
|---|---|---|
| `mock_bilibili.mjs` | B站接口替身（真 TLS，自签证书）+ 分页夹具：3 页 / 原始 63 行 / 去重后 62 条，含 emoji 昵称、官方认证、空简介与整字段缺失简介，可按页注入 `-352` | 是，4 条自证全绿 |
| `track_a_fixture_selftest.test.mjs` | 夹具与替身的自证（B1 去重口径、真实形状三件套、pn 序列、越界空页、风控注入） | 是，不需要浏览器 |
| `track_a_extension_e2e.mjs` | A 轨真机取证：真 Chromium + 未打包扩展 + 网络层替身，断言 B1/B2/B5/C2/D7-scan/B3，产出 `tmp/qa-e2e/track-a.json`；`--doctor` 只报「这台机器哪些构建能装扩展」 | **是**，本机 2026-10-26 实测 6/6（默认跑法，不指定 `E2E_CHROME`） |
| `chrome_choice.mjs` | 选 Chromium 构建：按版本号数值降序 + 真探一次 `Extensions.loadUnpacked`，被拒构建连原始 CDP 报错一起记进 `env.rejectedBuilds` | 是 |
| `chrome_choice.test.mjs` | 上面这条选择的门禁（7 条）：多构建并存不许按目录序挑、数值排序、linux64 路径、探针回落、拒因留全 | 是，不需要浏览器 |

跑法：

```
npm --prefix tests/e2e ci
node --test tests/e2e/*.test.mjs          # 夹具自证，不需要浏览器
node tests/e2e/track_a_extension_e2e.mjs --doctor   # 先看这台机器哪些构建能装扩展
node tests/e2e/track_a_extension_e2e.mjs  # A 轨真机（默认 --headless=new；HEADLESS=0 走有头）
```

退出码口径：`0` = 每条断言都过；`1` = 有断言判红（报告不能拿「部分红」当通过）；
`2` = 扩展根本没装进浏览器（A 轨「未取证」，不许写「通过」）。

## 为什么替身走网络层而不是 Playwright route

抓关注列表的主路径是 MV3 **service worker** 里的 `fetch`（`extension/background.js`），
Playwright 的 `page.route` / `context.route` 覆盖不到 service worker 的请求。所以
`--host-resolver-rules` 把 `api/www/space.bilibili.com` 三个域解析到本机端口，
配自签证书 + `--ignore-certificate-errors`。实测这条通路是通的：A 轨脚本里
`nav` 与三页 `followings` 都由替身应答，且每次请求的 `pn` 与时间戳都落进日志。

替身的 CORS 必须**回显请求的 Origin**：扩展的 fetch 是 `credentials:"include"`，
`Access-Control-Allow-Origin: *` 会被浏览器整条挡掉，症状是「一条请求都没到替身」。

## 扩展怎么装进浏览器（实测 2026-10-26，别再走回头路）

| 形态 | 结果 |
|---|---|
| `--load-extension` + Playwright chromium-1248（`Browser.getVersion` 回 `Chrome/156.0.8078.4`，即 branded Chrome for Testing） | **被忽略**，不注册（Chrome 127+ 在 branded 构建里停了这个开关，`--disable-features=DisableLoadExtensionCommandLineSwitch` 也救不回来） |
| Playwright `launchPersistentContext` 有头 / `--headless=new` | 同上，`Secure Preferences` 里只有两个内置组件扩展 |
| 浏览器级 CDP `Extensions.loadUnpacked` | **成功**，返回扩展 id；`--headless=new` 下可用，A 轨就走这条 |
| `chrome-headless-shell` | 不能用：没有扩展子系统（`chromiumExecutable()` 会主动避开 headless_shell） |

**之前「本机所有 chromium 形态都装不上未打包扩展」的真因不在浏览器**：
`extension/manifest.json` 的 `version` 写成 `2.0.0-alpha.3`，而 Chrome 要求 version 是
1-4 段点分整数、每段 <= 65536。同一个构建换成合法版本号，`Extensions.loadUnpacked` 当场成功。
这条现在钉在 `tools/package_release.mjs` 的 `chromeVersionOk()`（发布门禁会拒非法版本号），
A 轨装载失败时也会把 CDP 的原始报错带出来。

## 多构建并存时挑哪个（FOR-71 复核出的夹具缺陷，2026-10-26）

`tests/e2e/browser/chrome/` 下常常并存多个 Chrome for Testing 构建，本机并存 126.0.6478.127 /
134.0.6998.88 / 156.0.8078.47。旧实现是 `readdirSync` 之后取第一个 —— 字典序最小的 126 被选中，
而 126 没有浏览器级 CDP 的 `Extensions.loadUnpacked`，于是**默认跑法**直接 fatal 退 2、报「A 轨未
取证」，只有显式 `E2E_CHROME` 指到 156 才 6/6。坏的是夹具选择，不是产品。同一份 `extension/`、
只换构建的原始拒因：

| 构建 | `Extensions.loadUnpacked` 回什么 |
|---|---|
| win64-126.0.6478.127 | CDP `-32601 'Extensions.loadUnpacked' wasn't found`（这个 domain 在 126 里不存在） |
| win64-134.0.6998.88 | CDP `-32000 Method not available.`（domain 在，命令不给用） |
| win64-156.0.8078.47 | 成功，回扩展 id |

现在 `chrome_choice.mjs` 做三件事：① 候选按版本号**数值**降序（字典序会把 99 排在 100 前，也不会
去 `chrome-linux64/chrome`，Linux 上永远选不到）；② 对候选真探一次 `Extensions.loadUnpacked`，
第一个装得进扩展的才用，探到能用就停；③ 被拒的构建把 `build / version / product / error` 写进
`env.rejectedBuilds`，报告和 CI 直接看得见「是哪个构建不支持」，不会又当成产品回归。

先探环境再跑用例（FOR-71 亲自验装、FOR-68 解压即用建议先跑这条）：

```
node tests/e2e/track_a_extension_e2e.mjs --doctor
```

退出码：`0` 有能装扩展的构建；`3` 一个都没有（先装或钉一个 Chrome for Testing 127+）。
`E2E_CHROME=<chrome 路径>` 钉死构建（不探针）；`E2E_CHROME_PROBE=0` 只按版本排序不探针。
这条选择钉在 `tests/e2e/chrome_choice.test.mjs`（CI 的 `e2e-fixture` job 会跑到）：突变验证——
排序退回字典序，7 条里 5 条判红；恢复后 7/7 全绿。

对照取证（本机，同一条命令，只改 `E2E_CHROME`）：钉 126 → `fatal: Extensions.loadUnpacked 被拒：
'Extensions.loadUnpacked' wasn't found`，退出码 2；不指定 → 选到 `win64-156.0.8078.47`，6/6，退出码 0。

## 登录态替身（A 轨是 mock，不是真实会话）

`background.js` 读不到 `bili_jct` 就走 `not_logged_in` 分支、一条请求都不发。所以 A 轨在每个
一次性画像里用 CDP `Network.setCookie` 种 `bili_jct` / `SESSDATA` / `DedeUserID`，值是假令牌。
**这是 mock 登录态**：真实登录态那条是 B 轨（B4），报告里两者不能混标。

## 实测矩阵（2026-10-26，`integration/for-67-v2-tree`）

```
env: win32 10.0.26200 / Chrome 156.0.0.0 / node v24.21.0 / playwright 1.64.1
     loadMethod = cdp:Extensions.loadUnpacked
     chromeBuild = win64-156.0.8078.47  chromeSource = cft:win64-156.0.8078.47  rejectedBuilds = []
B1 抓全 62 条（fetched==total，pn 1..3，跨页重复吃掉）      通过
B2 抓全前分类按钮 disabled + 「还没读全（已取 20/62）」      通过
B5 抓全后分类解锁                                          通过
C2 离线规则分类 62 条 == 关注条目数，且全程零外发            通过
D7-scan 审计含 scan_start / scan_complete（transport=sw_fetch）通过
B3 第 2 页注入 -352：incomplete + 分类仍锁 + 可续抓          通过
```

顺带：A 轨第一次真机跑就炸出一个 P0 —— `background.js` 的 `resolveSelf()` 还在调改名前的
`fetchJsonSw()`，`ReferenceError` 让「读全我的关注列表」点了毫无反应，182 项 node:test 全绿也照样
带着这个坏点。修完之后加了 `tests/extension/dangling_call.test.mjs` 把这类「只出现一次的裸调用」
钉成静态门禁（突变验证：把旧名塞回去当场判红）。
