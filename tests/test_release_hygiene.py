"""发布口径自检（FOR-35）。

v0.1.2 这轮真正反复出问题的不是功能，是口径：README 写 63、Release 说明写 62、
文档里还挂着上一版的 zip。这类断层靠人肉复验太贵，所以钉成测试：
版本号只有一个来源，Release 链接只有一个版本，README 的测试条数必须是真的。
"""
import os
import re
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