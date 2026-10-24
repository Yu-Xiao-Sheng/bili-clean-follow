# QA 验收报告 — bili-clean-follow（v0.1.0）

- **分支**：feat/tests（基于 open-source/v1，该分支是 feat/core 的超集，含完整核心实现 + 文档 + CI + 示例 fixture）
- **基础**：docs/spec.md 产品规格
- **测试环境**：Python 3.13.15 / pytest 9.1.1；`pip install -e .`（editable）已验证成功；CI 等价路径 `PYTHONPATH=src pytest tests -q` 已验证
- **结论**：✅ 核心功能可运行、测试套件全部通过（53/53）。发现并修复 1 个 CLI 缺陷（--version 乱码/字面量），无其他阻断性缺陷。

## 一、测试覆盖
| 模块 | 文件 | 测试数 | 覆盖内容 |
|------|------|--------|----------|
| 数据模型 | tests/test_model.py | 10 | FollowRecord.from_dict 字段映射、follower_id 优先级 / mid 回退、nickname/bio 回退、默认值 None、extra 独立实例、Class 枚举 |
| 加载器 | tests/test_loaders.py | 15 | 裸 list / 单个对象 / 各 wrapper（follower/follow/data/list/items）/ 空 list / 空 dict / 非法 JSON / 非 list wrapper 均抛 ValueError；文件读取（含 UTF-8 中文）；_to_list |
| 评分 | tests/test_score.py | 7 | 新创作者→keep、陈旧失活→remove、混合信号→review、无信号永非 keep、wrapper 加载、reason 含用户名 |
| 导出 | tests/test_export.py | 15 | run() 返回结构、分类阈值、Markdown 三节（KEEP/REVIEW/REMOVE）及空组 (0)、空输入不崩溃、pipe 转义、score 两位小数；CSV 表头/行数、None 字段留空、class 字段回读、_clean_pipe |
| CLI 安装/运行 | tests/test_cli.py | 6 | --md 生成、--csv 生成、stderr 汇总、--unfollow-list 仅 REMOVE、--version、缺文件退出码 2 |
| **合计** | | **53** | **53 passed** |

> 原仓库已含 test_score.py(7) + test_cli.py(4)=11 个测试。本次新增 test_model.py、test_loaders.py、test_export.py（40 个），并补强 test_cli.py 的 2 个新用例（--version 回归、缺文件退出码）及 1 处断言。

## 二、通过项（验收通过）
1. **核心实现可运行**：`python -m bili.demo` 生成样本；`bili-clean INPUT [--md/--csv/--unfollow-list]` 正常出报告；`--version` 正常。
2. **id 优先级符合规格**：follower_id 为主、mid 仅回退（docs/spec.md 明确要求）；测试 test_follower_id_primary_mid_fallback 覆盖。
3. **评分与分类符合规格**：三信号权重 0.45/0.30/0.25，阈值 keep≥0.70 / review≥0.40，缺失信号不计权、最终 clamp 0..1。fixture 结果 keep=1 review=1 remove=2，与手工计算一致。
4. **安全设计**：仅报告、不自动取关；--unfollow-list 显式才写 REMOVE 列表；CLI 打印 “never unfollows by itself”。
5. **导出正确**：Markdown 每类成表、管道转义；CSV RFC4180（\r\n 行尾）、None 留空、reason 字段被 extrasaction 忽略（CSV 用途为表格导入，符合规格）。
6. **安装/运行**：`pip install -e .` 成功；console script `bili-clean`、`python -m bili.cli` 均可用；无依赖网络/账号。

## 三、失败项（已发现并修复）
| # | 缺陷 | 根因 | 修复 | 回归测试 | 状态 |
|---|------|------|------|----------|------|
| 1 | `bili-clean --version` 输出字面量 `%(prog)s 0.1.0`，而非 `bili-clean 0.1.0` | cli.py 中 `f"%%(prog)s {__version__}"`：f-string 仅解释 `{...}`，`%%` 不会坍缩为 `%`，故版本串变为 `%%(prog)s 0.1.0`；argparse 的 %-格式把 `%%` 还原为字面 `%`，`%(prog)s` 未被替换 | 改为 `f"%(prog)s {__version__}"`（src/bili/cli.py 第 22 行） | tests/test_cli.py::test_cli_version | ✅ 已修复并验证 |

> 说明：该缺陷在修复前使 `--version` 不可用（输出无意义字面量），属阻断级 CLI 缺陷；现 100% 回归通过。

## 四、风险 / 遗留（非阻断）
1. **无 origin 远端**：当前仓库未配置 `origin` 远端，因此 `git push origin feat/tests` 无法完成；提交已落在本地 feat/tests 分支。需任务负责人提供远端/GitHub 仓库后推回。
2. **score.py 死代码**：`top = " - ".join(r for r in reasons[:3])` 计算后未使用。Markdown 表的 Reason 列实际显示完整 list 的 str repr，而非设计预期的 top-3 拼接单行。属输出质量/可读性问题，不影响分类正确性；修改会改变报告文本格式，建议与产品/工程确认后再调整。
3. **CI 矩阵**：ci.yml 覆盖 Python 3.10–3.12 且只在 main/PR 触发。本地在 3.13 已跑通，测试无版本特有语法，预期可移植；建议将 3.13 加入矩阵、并把触发分支扩展至 feat/* 以便 CI 覆盖本次测试。
4. **CSV 不含 reason**：to_csv 的字段列表不含 reason（规格 CSV 定位为表格导入/程序化使用，合理）。若需 CSV 携带 reason，需补充字段。
5. **空输入边界**：`to_markdown([])` 返回有效空报告（各类 (0)），已覆盖；`run([])` 返回 []。无崩溃。

## 五、验收结论
- 测试套件完整（功能 / 边缘 / 安装运行三类均覆盖），**53/53 通过**。
- 核心功能、导出、CLI、安全属性**全部验收通过**。
- 发现并修复 1 个阻断级 CLI 缺陷（--version），已加回归测试。
- 遗留风险均为非阻断（无 origin 远端、1 处死代码/格式问题、CI 矩阵建议），已逐项列明。
- **判定：核心功能接受（Accept）；CI 与远端推送待提供仓库地址后跟进。**

## 六、复现步骤
```
cd <repo>
python -m pip install -e .            # editable 安装（或: export PYTHONPATH=src）
python -m pytest tests -q            # 53 passed
python -m bili.demo                    # 生成 sample-follows.json
bili-clean sample-follows.json --md report.md --csv report.csv --unfollow-list uf.txt
bili-clean --version                   # bili-clean 0.1.0
```

---

## 七、v0.1.2 轮验收补充（FOR-41 · 2026-10-24 · 全栈开发）

上面一~六节是 v0.1.0 的记录，验收口径以本节为准。当时那 53 项（现 230 项）测试全部用自定义形状 fixture（`follower_id / nickname / bio`，且三个信号齐全）——所以「测试全绿」从来不覆盖真实用户的第一条命令。这就是本轮的主结论。

### 7.1 失败项：真实数据首跑不可用

复现条件：`main=1d2629a`、干净 venv、Python 3.13.15，只造数据、未碰真实账号（FOR-34 实测，CTO 与运营各自独立复跑过同一组数字）。

| # | 用户看到什么 | 根因 | 状态 |
|---|---|---|---|
| F1 | 按 docs/getting-started.md §3 把 Network 响应原样存盘再跑 CLI → `exit=2`，`Could not find a list of follows in the JSON`（`data.follower` 与 `data.list` 两种包装都不认） | `loaders._to_list` 只在已知 key 里取一层，不下探 `code/message/data` | ✅ FOR-37 已修；回归 `tests/test_loaders.py` + `tests/test_acceptance_real_shapes.py::test_real_api_response_runs_and_every_row_has_a_name` |
| F2 | 把数组手工提到顶层绕过 F1 → 报告 20 行 Name 列全空、CSV nickname 全空 | `model.from_dict` 只认 `nickname/follower_name`，不认 B 站真实字段 `name` / `uname`；`official.*` 整块丢弃 | ✅ FOR-37 已修（`name`/`uname`→nickname、`sign`→bio、`face`/`official_*`→extra 并喂 relevance）；回归同上：CSV 20 行昵称全非空 |
| F3 | 13 条只有 identity+bio 的最小导出 → `Summary: keep=0 review=0 remove=13` | `score.py` 把「未提供的信号」按 0.0 计入固定权重，未知＝最差，天花板 0.25 < REVIEW_MIN | ✅ FOR-36 已修（按已提供信号归一化 + 闸门 A 缺 recency 不得 remove、闸门 B 只有 bio 不得 keep）；回归 `tests/test_unknown_signals.py` + 本文件 (b) |
| F4 | 昵称含 emoji 时，中文（GBK）控制台跑 CLI 直接 `UnicodeEncodeError` 崩栈，整份报告丢失 | 入口没有 reconfigure stdio；CI 只有 ubuntu + UTF-8，这条路径永远抓不到 | ✅ FOR-38 已修（`bili.streams.harden_stdio()` + 写入兜底）；回归 `tests/test_streams.py` + 端到端 GBK 冒烟 + `ci.yml` 的 `smoke-gbk` job |
| F5 | CSV 无 BOM，Excel / WPS 双击打开中文乱码；取关清单只有 mid 没有名字 | 写文件用 utf-8 而非 utf-8-sig；清单未带昵称 | ✅ FOR-38 已修；回归断言 CSV 首三字节 = `EF BB BF`，取关清单每行 `mid <TAB> 昵称` |

### 7.2 修完后的期望 Summary（本轮实测原文：`main=4a229ce`，Python 3.13.15）

```
python -m bili tests/fixture-bili-real.json --csv out.csv --unfollow-list out.txt
Summary: keep=0 review=20 remove=0     # 真实接口原始响应（data.follower，含 emoji 昵称）

python -m bili tests/fixture-minimal.json --csv out.csv
Summary: keep=0 review=13 remove=0     # 只有 identity+bio：一律 review，stderr 打缺信号警告

python -m bili tests/fixture-full-signals.json --csv out.csv
Summary: keep=1 review=1 remove=4      # 补齐信号后取关判定仍然成立
```

这三行已钉成端到端断言（`tests/test_acceptance_real_shapes.py`，12 项，跑 CLI 子进程而不是单元测试）。要改期望，先改这个文件。

### 7.3 验收口径收紧（防再次「测试全绿但产品不可用」）

1. **fixture 必须分层**：(a) 真实接口原始响应（`code/message/data.follower`、中文与 emoji 昵称、`official`）；(b) 只有 identity+bio 的最小导出；(c) 补全信号的导出。另有两条防呆测试（`test_real_shape_fixtures_keep_bilibili_envelope_and_fields`、`test_minimal_fixture_really_lacks_every_signal`）：谁把夹具改回「方便但假」的自定义形状，测试直接红。
2. **跨单不变量进 CI**：任一行 `missing_signals` 含 `recency` 则该行 `class` 不得为 `remove`（ADR r2 闸门 A 的导出层镜像），四份 fixture 全部纳入参数化断言。
3. **平台维度**：`ci.yml` 新增 `smoke-gbk` job（`windows-latest`，`PYTHONIOENCODING=gbk` + `PYTHONUTF8=0`，跑 CLI 冒烟 + CSV 昵称非空 + Windows 上全量 pytest）。⇒ 口径变化：CI 由 1 个 job（5 个 python 版本）变成 2 个 job，「五个 CI job 全绿」的说法作废，以后统一写「test 矩阵 3.9–3.13 + windows GBK smoke」。
4. **测试数量口径**：README / README_en / Release 说明一律写当次 `python -m pytest -q` 的实际条数，本轮 = **230 passed**（218 + 12）。这条已由 `tests/test_release_hygiene.py::test_stated_test_count_matches_the_real_suite` 钉死，README 里的数字与真实收集数不一致时 CI 直接红。
5. **仍开放（不在本轮）**：FOR-39 的三处报告可读性问题（reason 打成 Python list repr、全英文、remove 未按分数升序）在 `4a229ce` 上仍然存在，排 v0.1.3 第一批；FOR-34 使用与产品视频按 board 指令继续挂起。
