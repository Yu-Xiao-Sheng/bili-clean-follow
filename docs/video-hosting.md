# 宣传影片：三条入口与它们的分工（FOR-66）

> 口径来源：FOR-62 v2-spec §1.1。这一页存在的理由很简单——**GitHub README 里放 mp4 链接，
> 用户拿到的是"下载"，不是"播放"**。所以下面三条入口缺一条都会退回坏体验。

## 1. 已实测：README 为什么放不下播放器

取证方法：`GET /repos/{owner}/{repo}/readme` + `Accept: application/vnd.github.html`
（拿 GitHub 服务端渲染后的 README HTML），实测结果：

| README 里怎么写 | GitHub 渲染结果 | 用户能直接看到画面吗 |
|---|---|---|
| `[产品介绍片](https://github.com/.../bili-clean-promo.mp4)` | `<a href=…>` 纯链接 | 否，必须先下载（这就是 FOR-66 要修的） |
| `![](.../bili-clean-promo.mp4)` | `<a><img src=…mp4></a>` | 否，渲染成破图 |
| `<video src=…mp4 controls>` | 被 sanitizer 清成空 `<p></p>` | 否 |
| `![embed](https://www.youtube.com/watch?v=…)` | 仍是 `<a><img>` | 否（README 不享受 issue 评论区的自动播放升级） |
| `![预览](assets/preview-promo.gif)` | `<img src=…gif>` | **是，打开页面就自动循环播** |

结论：README 页面上唯一能"自动播起来"的是动画图像（GIF / animated WebP）。

## 2. 三条入口的分工

| 层 | 放什么 | 在哪 | 谁负责生成 |
|---|---|---|---|
| ① 首屏内联 | `assets/preview-promo.gif`、`assets/preview-walkthrough.gif`（≤ 8 MB/张） | README.md / README_en.md 第一屏 | `tools/build_readme_preview.py` |
| ② 点开即播的完整版 | Pages 落地页 `<video controls poster preload="metadata">`，浏览器里边下边播 | `pages/index.html` → Pages 站点 | `tools/publish_pages.py` |
| ③ 站内托管 | 完整 1080p 影片传 B站官方号 + YouTube，README 换成站内链接 | B站 / YouTube | 人工上传（见 §5） |

**影片文件绝不进 main 的 git 历史**：mp4 只作为 Release 资源与 Pages 产物存在，
`dist/`、`promo/out/` 已在 `.gitignore` 里，`tests/test_release_hygiene.py` 有一条
"仓库里不许出现视频二进制"的门禁钉住这件事。

## 3. 换影片时怎么重跑（T8 出新片后走这条）

```
# 1) 先渲染影片（Remotion 工程在 promo/），产物落在 promo/out/
# 2) 生成 README 内联 GIF + Pages 封面（超 8 MB 会自动逐级降质）
python tools/build_readme_preview.py
# 3) 组装 Pages 产物并本地自检（Range / 206 / Content-Range 都断言）
python tools/publish_pages.py --self-check
```

T8 的新影片替换时**文件名不用改**：README 与落地页引用的是
`assets/preview-promo.gif` / `assets/preview-walkthrough.gif`，重跑脚本即可；
门禁会在 README 引用与资产不一致时直接把 CI 打红。

ffmpeg 查找顺序：`--ffmpeg` 参数 → `BILI_FFMPEG` 环境变量 → `PATH` 上的 ffmpeg →
`promo/node_modules/@remotion/compositor-*/ffmpeg.exe`（Remotion 自带，不用额外装）。

## 4. Pages 上线（只差一个开关，需要 repo 管理员）

落地页源文件在 `pages/index.html`。两种部署方式，任选一种：

- **A · GitHub Actions（推荐）**：`.github/workflows/pages.yml` 已写好——从 Release 资源下载
  两支 mp4，组装 `dist/pages`，用 `actions/upload-pages-artifact` + `actions/deploy-pages` 部署。
  需要管理员在 Settings → Pages 里把 Source 设为 **GitHub Actions**。mp4 完全不进 git。
- **B · 分支部署（兜底）**：`python tools/publish_pages.py --push-branch gh-pages --remote <远端>`
  把产物做成一个孤立提交推到 `gh-pages`；Settings → Pages 选 **Deploy from a branch: gh-pages / (root)**。
  影片只活在 `gh-pages` 分支，不污染 main。

上线后取证（CI 的 `pages` job 也跑同一条）：

```
python tools/publish_pages.py --check-url https://yu-xiao-sheng.github.io/bili-clean-follow/
```

断言三件事：落地页 200 且含 `<video controls poster …>`；两支 mp4 返回
`Accept-Ranges: bytes`；分段请求返回 206 + 正确的 `Content-Range`。这三条就是
"浏览器里能直接播、能拖进度条"的机器证据。

## 5. B站 / YouTube 上传清单（需要官方号登录，agent 无权限）

| 字段 | 产品介绍片 | 操作教程片 |
|---|---|---|
| B站分区 | 科技 → 数码 / 软件神器 | 科技 → 软件神器 |
| 标题 | 几百个 B站关注不知道该取哪个？我写了个开源工具，只给你清单不动你的账号 | 三步跑完 B站关注清理：导出 → 分析 → 核对候选清单 |
| 简介要点 | 开源 / 纯本地 / cookie 不出本机 / 只报告不取关（v1 口径）/ 仓库链接 | 命令与导出格式逐条演示；强调默认只读、候选清单要人工核对 |
| 标签 | B站, 关注清理, 开源工具, Python, Chrome插件 | B站, 教程, 命令行, 数据导出 |
| 封面 | `assets/poster-promo.jpg` | `assets/poster-walkthrough.jpg` |
| 影片 | `bili-clean-promo.mp4`（58s，1080p，带音轨） | `bili-clean-walkthrough.mp4`（62s，1080p，带音轨） |

上传完成后要做三件事（同一 PR 内改完）：
1. README.md / README_en.md 的影片行加 B站与 YouTube 站内链接（放"在线观看"旁边）。
2. `pages/index.html` 的 `links` 段落补站内链接。
3. 传完再确认 Release 里的 mp4 仍在（下载入口保留，但**不能是 README 里唯一的视频入口**——门禁会红）。

## 6. 门禁清单（`tests/test_release_hygiene.py`）

- README 第一屏必须有内联动画资产引用（`assets/preview-*.gif`），且出现在第二个 `##` 标题之前
- 引用的动画资产必须存在、非空、单文件 ≤ 8 MB（GitHub 单图上限 10 MB，留 2 MB 余量）
- 两支影片各有一张 GIF 预览（不许只挂一支）
- README 里出现 `.mp4` 链接时，必须同时存在"点开即播"入口（Pages / B站 / YouTube），
  否则就是退回下载链接的老问题，CI 直接红
- `pages/index.html` 必须是 `<video controls preload="metadata" poster=… src=….mp4>`，两支影片都在
- 仓库里不许提交视频二进制（`*.mp4`/`*.webm`/`*.mov`），mp4 只能活在 Release / Pages 产物里