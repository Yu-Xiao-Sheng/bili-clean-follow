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
| `track_b_policy.mjs` | B 轨（真实登录态只读）的策略：只读端点白名单、写端点永拒、快照四列白名单、对账自证——纯函数，不需要浏览器也不碰账号 | 是，18 条全绿 |
| `track_b_policy.test.mjs` | 上面那份策略的门禁：写操作一律拒（含只靠查询串带参数的 POST）、多带一个字段就判红、凭据形态键名递归检出、fail-closed | 是，不需要浏览器 |
| `track_b_real_readonly.mjs` | B 轨取证：真实登录态 + 浏览器层只读护栏 + 全量读全 + 离线分类 + 逐条快照落 `docs/qa-evidence/scan-items.json`；`--mock` 是替身自检（只写 tmp/） | 是（`--mock`；真实会话要人先授权） |

跑法：

```
npm --prefix tests/e2e ci
node --test tests/e2e/*.test.mjs          # 夹具自证，不需要浏览器
node tests/e2e/track_a_extension_e2e.mjs --doctor   # 先看这台机器哪些构建能装扩展
node tests/e2e/track_a_extension_e2e.mjs  # A 轨真机（默认 --headless=new；HEADLESS=0 走有头）
node tests/e2e/track_b_policy.test.mjs          # B 轨策略门禁（不需要浏览器、不碰账号)
node tests/e2e/track_b_real_readonly.mjs --mock # B 轨替身自检：只读护栏 + 快照白名单，产物只进 tmp/
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

## B 轨（真实登录态只读）为什么不能复用 A 轨脚手架

A 轨是 mock 登录态：假令牌 + 本机替身，报告里只能写 `kind=mock`。B 轨跑在**真实账号**上，
它要保证的第一件事不是「抓到数据」，而是**不越界、不冒充**。四条闸门都在
`track_b_real_readonly.mjs` 里，退出码就是它们的口径：

| 退出码 | 含义 |
| --- | --- |
| 0 | 取证完成（读全 + 分类对账 + 护栏覆盖 + 快照自证全过） |
| 1 | 有断言判红（半份证据比没证据更坏，所以不落 `docs/qa-evidence/`） |
| 2 | 扩展装不进浏览器（同 A 轨，先跑 `--doctor`） |
| 4 | **没有人的授权**：真实会话必须带 `--consent=grant_current_login\|give_profile`，对应 FOR-67 那张人工卡的选项 id |
| 5 | 画像里没有 B站登录态（`GET /x/web-interface/nav` 回 `isLogin=false`）→ B 轨按未取证 |
| 6 | 产品自发请求里出现写操作（取关 / 加关 / 分组 / 拉黑）——这是 P0，报告必须写 |
| 7 | 看门狗超时（默认 180s，`E2E_WATCHDOG_MS` 可调）：卡在哪个 stage 写进 `tmp/qa-e2e/track-b.json`，绝不无界挂下去 |

### 只读护栏必须有正反两面证据

「跑完一遍零写请求」本身**不是证据**：看不见所以没记录，和看见了但拦住了，落盘上长得一模一样。
所以 B 轨钉两条：

- `R1 覆盖`：护栏确实看得见 MV3 **service worker** 的分页 `followings` 请求，条数 == 侧栏页数；
- `R2 负向对照`：从扩展页面里主动 `POST /x/relation/delete`，必须被 `Fetch.failRequest` 拦下（fetch 直接失败）
  并记成 `write` 拒因。探针记为 `phase:"probe"`，与产品自发写请求（`phase:"product"`）分开算，
  只有后者触发退出码 6。

突变验证（2026-10-27，本机）：把护栏改成全放行 → `R2` 当场判红（exit 1）；把写越界判定改成恒过 →
`R3` 变摆设但 `R1` 仍绿，所以 `R1`/`R2`/`R3` 三条各有分工，缺一条就有盲区。

### 三个 CDP 坑（每一个都把「只读」变成过空话，别再走回头路）

| 坑 | 症状 | 现在怎么做 |
| --- | --- | --- |
| `Target.getTargets` 回的是 CDP 信封 | 直接读 `result.targetInfos` 之外的字段永远是 `undefined` → 「补挂已有 target」的循环一次都没跑过；装载时就已启动的 service worker 不进护栏，`R1` 六次里红四次 | 读 `got.result.targetInfos`；补挂后按 target 开 `Fetch.enable` |
| `Fetch.failRequest` 的 `errorReason` 必须是 `Network.ErrorReason` 枚举值 | 用 `"Refused"` 会被 CDP 拒，报错被 `catch` 吞掉 → 请求永远停在 paused → **整个取证挂死**（实测 90s+ 无输出，只能看门狗兜） | 用 `"BlockedByClient"`；并加看门狗（退 7，写清卡在哪一步） |
| 同一个 target 上开两条 `Fetch` 会话 | 同一条请求要两条会话都应答，漏一条同样永久挂起；反过来，只守着先 attach 的那条又会漏掉 Chrome 实际投递请求的那条 | 一个 target 只留一条会话，**后到的会话接管**：先 `Fetch.disable` 旧会话再在新会话上 enable |

### 落盘红线

- `--mock` 只写 `tmp/qa-e2e/track-b-mock-scan-items.json`，**永不**写 `docs/qa-evidence/scan-items.json`：
  把替身当真实会话是 CEO 的 No-Go 硬条件④。
- 真实会话也只有在全部门禁绿、且产品自发请求里没有写操作时才落盘；断言没过就不落半份。
- 快照字段是白名单（`mid` / `name` / `category` / `confidence`），请求日志字段也是白名单
  （`method` / `host` / `path` / `allowed` / `kind`）：cookie、csrf、响应体都不落。
- 画像处理：`--copy-profile-from` 只复制登录相关文件到临时目录，不动日常 Chrome 画像
  （一是独占锁，二是取证脚本不该能改动日常画像）；复制不完整由退出码 5 兜住，不会假装跑通。

### B 轨替身自检实测矩阵（2026-10-27，本机 `integration/for-67-v2-tree`）

```
node tests/e2e/track_b_real_readonly.mjs --mock   exit=0，连续 6 次无判红
B4 登录态来自替身画像（假令牌，标 mock）            通过
B1 fetched == total == 62（3 页）                   通过
B5 分类落库 62 条 == 条目数                          通过
B6 侧栏卡片条数之和 == 条目数（界面与存储一套数）      通过
R1 护栏看得见 service worker 的 3 条 followings      通过
R2 主动 POST /x/relation/delete 被拦（负向对照）      通过
R3 产品自发请求零写操作                              通过
B7 快照四列白名单 + mid 唯一 + 分布对账              通过
readOnly: allowed=5 denied=1(favicon) writeAttempts=[probe:/x/relation/delete]
clsCounts: unsure 23 / game 14 / tech 7 / food 7 / film 6 / knowledge 5
```