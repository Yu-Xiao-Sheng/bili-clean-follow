"""发布口径自检（FOR-35 + FOR-66）。

v0.1.2 这轮真正反复出问题的不是功能，是口径：README 写 63、Release 说明写 62、
文档里还挂着上一版的 zip。这类断层靠人肉复验太贵，所以钉成测试：
版本号只有一个来源，Release 链接只有一个版本，README 的测试条数必须是真的。

FOR-66 把同一套办法用在视频口径上。实测（GET /repos/{owner}/{repo}/readme +
Accept: application/vnd.github.html，取证见 docs/video-hosting.md）证明 GitHub README
里 mp4 只会渲染成下载链接、`<video>` 会被 sanitizer 清成空 `<p>`、YouTube 链接也不会
内嵌播放器——README 首屏唯一能自动播的是动画图像。于是"打开就能看见"变成三条硬约束：
README 第一屏内联 GIF（<= 8 MB）、存在点开即播的入口（Pages / B站 / YouTube）、
mp4 绝不进 main 的 git 历史。少任何一条都会退回"用户只能下载"的老问题，所以全部钉成门禁。
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from bili import __version__ as BILI_VERSION  # noqa: E402

REPO_ROOT = SRC.parent
DOCS = ("README.md", "README_en.md", "docs/getting-started.md")
ZIP_LINK = re.compile(r"releases/download/v([^/]+)/bili-clean-follow-([^/]+)\.zip")


def _read(rel):
    return (REPO_ROOT / rel).read_text(encoding="utf-8")


def _pyproject_version():
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'(?m)^version = "([^"]+)"', text)
    assert match, "pyproject.toml has no top-level version"
    return match.group(1)


def test_package_version_matches_pyproject():
    assert BILI_VERSION == _pyproject_version()


def test_changelog_is_cut_for_the_current_version():
    text = _read("CHANGELOG.md")
    assert re.search(r"(?m)^## \[%s\]" % re.escape(BILI_VERSION), text), (
        "CHANGELOG.md has no [{}] section".format(BILI_VERSION))
    assert "## [Unreleased]" not in text, "release cut must fold [Unreleased] away"


def test_every_doc_links_only_the_current_release_zip():
    for rel in DOCS:
        found = ZIP_LINK.findall(_read(rel))
        assert found, "%s has no release zip link at all" % rel
        stale = sorted({tag for tag, pkg in found if tag != BILI_VERSION or pkg != BILI_VERSION})
        assert not stale, "%s still links v%s while the package is %s" % (
            rel, ",".join(stale), BILI_VERSION)


def test_every_doc_states_the_current_cli_version():
    needle = "`bili-clean %s`" % BILI_VERSION
    for rel in DOCS:
        assert needle in _read(rel), "%s does not tell the user what --version prints" % rel


def test_readmes_advertise_the_current_web_report_version():
    needle = "bili-clean-follow v%s" % BILI_VERSION
    for rel in ("README.md", "README_en.md"):
        assert needle in _read(rel), "%s web report header shows a stale version" % rel


def test_stated_test_count_matches_the_real_suite():
    collected = _collected_count()
    for rel in ("README.md", "README_en.md"):
        match = re.search(r"(\d+) (?:项 pytest 全绿|tests green)", _read(rel))
        assert match, "%s does not state how many tests are green" % rel
        assert int(match.group(1)) == collected, (
            "%s claims %s green tests but the suite collects %d"
            % (rel, match.group(1), collected))


def test_privacy_md_states_the_v2_data_flow():
    """FOR-64：v2 引入 BYOK 之后，"数据不出本机"必须被改写成可核对的口径，
    而且要钉在测试里——口号漂移过一次就已经出过事故了。"""
    text = _read("PRIVACY.md")
    assert "凭据永不出本机" in text, "PRIVACY.md 没有写住凭据边界"
    assert "只发给你自己指定的模型端点" in text, "PRIVACY.md 没有说清外发目的地是用户自己的端点"
    for never_sent in ["Cookie", "mid", "头像", "关注关系"]:
        assert never_sent in text, "PRIVACY.md 要逐条列出外发不含 " + never_sent
    assert "chrome.storage.local" in text, "Key 的存放位置要写清"


def _collected_count():
    env = dict(os.environ, PYTHONPATH=str(SRC))
    out = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "tests"],
        cwd=str(REPO_ROOT), env=env, capture_output=True, text=True, check=False,
    )
    assert out.returncode == 0, out.stdout + out.stderr
    match = re.search(r"(\d+) tests? collected", out.stdout)
    assert match, out.stdout[-1500:]
    return int(match.group(1))


# --- FOR-66：README 的"打开就能看见"口径 -------------------------------------
# 三条约束各自对应一种已经实测过的坏法：GIF 缺失 => 首屏只有下载链接；
# 只有 mp4 链接 => 用户必须下载 7 MB 才知道片子讲什么；mp4 进 main => repo size 爆炸。
INLINE_ANIMATED = re.compile(r"!\[[^\]]*\]\((assets/preview-[^)\s#]+\.(?:gif|webp))\)")
MP4_LINK = re.compile(r"\]\((https?://[^)\s]+\.mp4)\)")
STREAM_LINK = re.compile(r"\]\((https?://[^)\s]*(?:github\.io|bilibili\.com/video"
                         r"|youtube\.com/(?:watch|shorts|embed))[^)\s]*)\)")
FILM_SLUGS = ("promo", "walkthrough")
VIDEO_SUFFIXES = (".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv")
# GitHub 单张图上限 10 MB，README 内联留 2 MB 余量（首屏加载也吃这个大小）。
GIF_BUDGET = 8 * 1024 * 1024
READMES = ("README.md", "README_en.md")


def _first_screen_limit(text):
    """第二个小节标题的位置：内联预览必须落在它之前，否则要滚动才看得见画面。"""
    heads = [m.start() for m in re.finditer(r"(?m)^## ", text)]
    return heads[1] if len(heads) > 1 else len(text)


def test_readmes_lead_with_an_inline_animated_preview():
    for rel in READMES:
        text = _read(rel)
        match = INLINE_ANIMATED.search(text)
        assert match, ("%s 引用不到内联动画资产（assets/preview-*.gif|webp）；"
                       "GitHub README 里 mp4 不会自动播，首屏必须有 GIF" % rel)
        limit = _first_screen_limit(text)
        assert match.start() < limit, (
            "%s 的内联预览在第 %d 字符，第二小节从第 %d 字符才开始——用户要滚动才看见画面"
            % (rel, match.start(), limit))


def test_inline_preview_assets_exist_and_fit_the_github_budget():
    refs = set()
    for rel in READMES:
        refs.update(INLINE_ANIMATED.findall(_read(rel)))
    assert refs, "没有任何 README 引用内联动画资产"
    for rel in sorted(refs):
        path = REPO_ROOT / rel
        assert path.exists(), "%s 被 README 引用但文件不存在（跑 tools/build_readme_preview.py）" % rel
        size = path.stat().st_size
        assert size > 100 * 1024, "%s 只有 %d 字节，像是空壳" % (rel, size)
        assert size <= GIF_BUDGET, (
            "%s 是 %.2f MB，超过 README 内联预算 %.0f MB（重跑 tools/build_readme_preview.py 会自动降质）"
            % (rel, size / 1048576.0, GIF_BUDGET / 1048576.0))


def test_every_film_with_a_download_link_also_has_a_click_to_play_entry():
    """mp4 下载链接不许是某支影片的唯一入口——那正是 FOR-66 要修的坏法。"""
    for rel in READMES:
        text = _read(rel)
        previews = INLINE_ANIMATED.findall(text)
        downloads = MP4_LINK.findall(text)
        streams = STREAM_LINK.findall(text)
        for slug in FILM_SLUGS:
            assert any(slug in ref for ref in previews), (
                "%s 里没有 %s 这支影片的内联预览 GIF" % (rel, slug))
            if any(slug in url for url in downloads):
                assert any(slug in url for url in streams), (
                    "%s 里 %s 只有 mp4 下载链接，没有点开即播入口（Pages / B站 / YouTube）"
                    % (rel, slug))


def test_pages_landing_page_streams_both_films():
    html = _read("pages/index.html")
    assert "<video" in html, "pages/index.html 没有 <video>，README 的在线观看会 404"
    assert "<script" not in html, "落地页不需要 JS；少一分依赖，也少一分注入面"
    for slug in FILM_SLUGS:
        assert 'src="bili-clean-%s.mp4"' % slug in html, (
            "落地页里没有 %s 这支影片的 <video src>" % slug)
        assert 'poster="poster-%s.jpg"' % slug in html, (
            "落地页缺 poster-%s.jpg：首帧没画面，用户不知道要不要点播放" % slug)
        assert 'controls' in html and 'preload="metadata"' in html, (
            "<video> 必须 controls + preload=metadata（边下边播，不整片预载）")


def test_pages_deploy_path_is_still_wired_up():
    """README 指向 Pages；部署通道被删了就得同时改掉 README，否则链接集体 404。"""
    text = _read(".github/workflows/pages.yml")
    for needle in ("actions/upload-pages-artifact", "actions/deploy-pages",
                   "gh release download"):
        assert needle in text, "pages.yml 里的 %s 没了（README 的在线观看入口随之失效）" % needle


def _tracked_files():
    git = shutil.which("git")
    if git is None:
        import pytest
        pytest.skip("git unavailable; cannot enumerate tracked files")
    proc = subprocess.run([git, "ls-files"], cwd=str(REPO_ROOT),
                          capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def test_no_video_binaries_are_committed():
    """mp4 只活在 Release 资源与 Pages 产物里；main 的 git 历史必须保持几百 KB 量级。"""
    bad = sorted(p for p in _tracked_files() if p.lower().endswith(VIDEO_SUFFIXES))
    assert not bad, (
        "仓库里提交了视频二进制：%s —— 会永久留在 main 历史里。"
        "影片走 Release（Pages 由 tools/publish_pages.py 组装，产物在 dist/）" % ", ".join(bad))

# --- FOR-67：交付树卫生 + 测试报告的机器可读契约 ------------------------------
# 「解压即用 / 零构建」是 v2 的卖点：node_modules 一旦进 git，zip 体积与
# 「无 npm install」的口径同时失控。FOR-63 只在 extension/ 里禁依赖，
# FOR-67 把它扩到整棵树（Pages 与后续影片工程的依赖目录同样不许提交）。
DEP_DIR_SEGMENTS = ("node_modules/", ".pnpm-store/", "site-packages/")


def test_no_dependency_directories_are_committed():
    """FOR-67 CI 门禁：整棵树不得提交依赖目录（无 node_modules 提交检查）。"""
    offenders = sorted(
        p for p in _tracked_files()
        if any(seg in "/" + p.replace("\\", "/") for seg in DEP_DIR_SEGMENTS)
    )
    assert not offenders, (
        "仓库里提交了依赖目录：%s —— 「Load unpacked 直接可用」随之失效，"
        "zip 体积也会失控。依赖只能装在仓库外，或写进 .gitignore。" % ", ".join(offenders))


QA_REPORT_MD = "docs/qa-report-v2.md"
QA_REPORT_JSON = "docs/qa-report-v2.json"
# FOR-70 的两支片子从这份 JSON 注入片内数字：字段名一改，渲染静默拿到假数。
QA_JSON_FIELDS = ("follow_total", "pages", "cls", "diff", "unfollow")
QA_TRACK_LABELS = ("mock", "real", "offline")


def test_qa_report_v2_ships_a_machine_readable_sibling():
    """三轨报告落地时，机器可读版必须同时在位且字段齐（FOR-67 产出 3）。"""
    md = REPO_ROOT / QA_REPORT_MD
    if not md.exists():
        import pytest
        pytest.skip("%s 尚未产出：FOR-67 三轨取证跑完才落盘" % QA_REPORT_MD)
    js = REPO_ROOT / QA_REPORT_JSON
    assert js.exists(), (
        "%s 已存在但 %s 缺失：FOR-70 拿不到片内数字，两支片子渲不出来"
        % (QA_REPORT_MD, QA_REPORT_JSON))
    data = json.loads(js.read_text(encoding="utf-8"))
    for field in QA_JSON_FIELDS:
        assert field in data, "%s 缺字段 %s" % (QA_REPORT_JSON, field)
    counts = data["cls"]["counts"]
    assert isinstance(counts, dict) and counts, "cls.counts 必须是 类目 -> 条数 的映射"
    assert sum(counts.values()) == data["follow_total"], (
        "分类条目数 %d 与关注条目数 %s 不等（验收清单 B5）"
        % (sum(counts.values()), data["follow_total"]))
    assert data["diff"]["n"] >= data["unfollow"]["done"] >= 0, (
        "实际执行数不能超过 diff 预览条数（验收清单 D2）")
    assert data["unfollow"]["done"] <= 50, (
        "单次执行上限 50（验收清单 D3），报告里写的是 %s" % data["unfollow"]["done"])
    tracks = data.get("tracks", {})
    for track in ("A", "B", "C"):
        assert tracks.get(track) in QA_TRACK_LABELS, (
            "%s 轨必须标 mock / real / offline（报告不得把 mock 写成真实会话）" % track)
