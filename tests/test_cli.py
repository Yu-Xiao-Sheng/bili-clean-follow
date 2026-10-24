import os
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURE = Path(__file__).resolve().parent / "fixture-follows.json"
REPO_ROOT = FIXTURE.parent.parent
SRC = REPO_ROOT / "src"

UTF8_ENV = dict(os.environ, PYTHONIOENCODING="utf-8")


def run_cli(*args, env=None, cwd=None):
    run_env = dict(UTF8_ENV)
    run_env["PYTHONPATH"] = str(SRC)
    if env:
        run_env.update(env)
    return subprocess.run(
        [sys.executable, "-m", "bili.cli", *args],
        cwd=str(cwd or REPO_ROOT),
        env=run_env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def test_cli_produces_markdown():
    tmp = REPO_ROOT / "tmp"
    tmp.mkdir(exist_ok=True)
    out = run_cli(str(FIXTURE), "--md", str(tmp / "report.md"))
    assert out.returncode == 0
    report = (tmp / "report.md").read_text(encoding="utf-8")
    assert "Total follows: 4" in report
    assert "KEEP" in report
    assert "REMOVE" in report


def test_cli_csv(tmp_path):
    out = run_cli(str(FIXTURE), "--csv", str(tmp_path / "report.csv"))
    assert out.returncode == 0
    raw = (tmp_path / "report.csv").read_bytes()
    # FOR-38: utf-8 BOM, otherwise Excel/WPS on Windows shows mojibake.
    assert raw.startswith(b"\xef\xbb\xbf"), "CSV must be utf-8-sig"
    lines = raw.decode("utf-8-sig").strip().splitlines()
    assert lines[0].startswith("follower_id,nickname,class")
    assert len(lines) == 5


def test_cli_markdown_has_no_bom(tmp_path):
    out = run_cli(str(FIXTURE), "--md", str(tmp_path / "report.md"))
    assert out.returncode == 0
    assert not (tmp_path / "report.md").read_bytes().startswith(b"\xef\xbb\xbf")


def test_cli_summary_in_stderr():
    out = run_cli(str(FIXTURE))
    assert "Summary:" in out.stderr
    assert "keep=" in out.stderr
    assert "remove=" in out.stderr


def test_cli_unfollow_list_only_remove(tmp_path):
    out = run_cli(str(FIXTURE), "--unfollow-list", str(tmp_path / "unfollow.txt"))
    assert out.returncode == 0
    lines = _unfollow_lines(tmp_path / "unfollow.txt")
    # FOR-36: only U100003 is REMOVE (stale + weak authority, signals known).
    # U100004 carries identity only -> 闸门 A 把它留在 review，不再进取关清单。
    assert [c[0] for c in lines] == ["mid100003"]
    assert all(mid.startswith("mid") for mid, _ in lines)
    # FOR-38: mid alone is useless - every row carries the nickname too.
    assert [name for _, name in lines] == ["阿远03"]


def test_cli_unfollow_list_carries_manual_only_notice(tmp_path):
    out = run_cli(str(FIXTURE), "--unfollow-list", str(tmp_path / "unfollow.txt"))
    assert out.returncode == 0
    text = (tmp_path / "unfollow.txt").read_text(encoding="utf-8-sig")
    comments = [l for l in text.splitlines() if l.startswith("#")]
    assert any("不会自动取关" in l for l in comments)
    assert any("report-only" in l.lower() for l in comments)
    assert "mid" in comments[-1] and "nickname" in comments[-1]


def test_cli_version():
    out = run_cli("--version")
    assert out.returncode == 0
    assert out.stdout.strip() == "bili-clean 0.1.1"
    assert "%(prog)s" not in out.stdout  # regression: f-string bug (literal %%(prog)s)


def test_cli_missing_file_exit_code_2():
    out = run_cli("does-not-exist.json")
    assert out.returncode == 2
    assert "error:" in out.stderr
    assert "could not load follows" in out.stderr


def test_cli_refuses_credential_input():
    # v0.1.1 shipped the guard on the web path only; the CLI shares it now.
    for bad in ("SESS_bili.json", "bili_cookies.json", "my_api_key.json",
                "user.env", "auth.json", "session.json"):
        out = run_cli(bad)
        assert out.returncode == 2, bad
        assert "refusing to load" in out.stderr, bad
        assert "Traceback" not in out.stderr, bad


class TestWindowsConsoleSafety:
    """FOR-38 P0: emoji 昵称 + GBK 控制台不能崩，不能丢报告。"""

    def _emoji_input(self, tmp_path):
        payload = [{
            "follower_id": "22965610",
            "mid": "22965610",
            "nickname": "头条小哥🔥",
            "bio": "热点资讯 · 现场直击",
            "last_seen_days": 3,
            "follower_count": 120000,
            "following_count": 60,
        }]
        path = tmp_path / "emoji_case.json"
        path.write_text(__import__("json").dumps(payload, ensure_ascii=False),
                        encoding="utf-8")
        return path

    def test_gbk_console_with_emoji_nickname_exits_zero(self, tmp_path):
        path = self._emoji_input(tmp_path)
        out = run_cli(str(path), cwd=tmp_path, env={"PYTHONIOENCODING": "gbk"})
        assert out.returncode == 0, out.stderr
        assert "Traceback" not in out.stderr, out.stderr
        assert "头条小哥" in out.stdout
        assert "🔥" in out.stdout
        assert "Summary:" in out.stderr

    def test_gbk_console_still_writes_all_artifacts(self, tmp_path):
        path = self._emoji_input(tmp_path)
        md, csv_path, unfollow = (tmp_path / "r.md", tmp_path / "r.csv",
                                  tmp_path / "unfollow.txt")
        out = run_cli(str(path), "--md", str(md), "--csv", str(csv_path),
                      "--unfollow-list", str(unfollow), cwd=tmp_path,
                      env={"PYTHONIOENCODING": "gbk"})
        assert out.returncode == 0, out.stderr
        assert "头条小哥🔥" in md.read_text(encoding="utf-8")
        assert csv_path.read_bytes().startswith(b"\xef\xbb\xbf")
        rows = _unfollow_lines(unfollow)
        assert rows == [] or rows[0][1].startswith("头条小哥")


class TestCredentialGuardIsContentFirst:
    """FOR-38 补充：按内容判定，别误伤名字里带 cookie 的正常导出。"""

    def test_clean_file_named_like_a_cookie_file_is_accepted(self, tmp_path):
        path = tmp_path / "follows_from_browser_cookies.json"
        path.write_text('[{"follower_id": "1", "nickname": "阿花", "bio": "风景"}]',
                        encoding="utf-8")
        out = run_cli(str(path), cwd=tmp_path)
        assert out.returncode == 0, out.stderr
        assert "refusing to load" not in out.stderr
        assert "建议改名" in out.stderr  # 放行但提示改名

    def test_real_cookie_content_is_refused_with_key_name(self, tmp_path):
        path = tmp_path / "follows.json"
        path.write_text('{"follower_id": "1", "cookies": {"SESSDATA": "abc123"}}',
                        encoding="utf-8")
        out = run_cli(str(path), cwd=tmp_path)
        assert out.returncode == 2
        assert "SESSDATA" in out.stderr
        assert "refusing to load" in out.stderr
        assert "Traceback" not in out.stderr

    def test_refusal_message_gives_a_rename_hint(self, tmp_path):
        path = tmp_path / "bili_cookies.json"
        path.write_text('[{"mid": "1", "name": "x", "sessdata": "leak"}]',
                        encoding="utf-8")
        out = run_cli(str(path), cwd=tmp_path)
        assert out.returncode == 2
        assert "bili-follows.json" in out.stderr

    def test_bom_prefixed_input_still_loads(self, tmp_path):
        path = tmp_path / "from_notepad.json"
        path.write_bytes('\ufeff[{"follower_id": "1", "nickname": "记事本"}]'.encode("utf-8"))
        out = run_cli(str(path), cwd=tmp_path)
        assert out.returncode == 0, out.stderr
        assert "记事本" in out.stdout


def _unfollow_lines(path):
    """Parse the mid<TAB>nickname rows, skipping the leading notice."""
    rows = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        mid, _, name = line.partition("\t")
        rows.append((mid.strip(), name.strip()))
    return rows


class TestMissingSignalsAreNotEvidence:
    """FOR-36 验收：真实最小导出不能一边倒 remove。"""

    def _summary(self, stderr):
        import re
        m = re.search(r"Summary: keep=(\d+) review=(\d+) remove=(\d+)", stderr)
        assert m, stderr
        return [int(x) for x in m.groups()]

    def test_minimal_export_is_all_review_not_remove(self, tmp_path):
        out = run_cli(str(MINIMAL_FIXTURE), "--csv", str(tmp_path / "r.csv"))
        assert out.returncode == 0, out.stderr
        assert self._summary(out.stderr) == [0, 13, 0]

    def test_minimal_export_unfollow_list_is_empty(self, tmp_path):
        out = run_cli(str(MINIMAL_FIXTURE), "--unfollow-list", str(tmp_path / "u.txt"))
        assert out.returncode == 0, out.stderr
        assert _unfollow_lines(tmp_path / "u.txt") == []

    def test_minimal_export_prints_missing_signal_warning(self, tmp_path):
        md = tmp_path / "r.md"
        out = run_cli(str(MINIMAL_FIXTURE), "--md", str(md))
        assert out.returncode == 0, out.stderr
        assert "\u7f3a\u4fe1\u53f7\u8b66\u544a" in out.stderr
        assert "last_seen_days" in out.stderr
        text = md.read_text(encoding="utf-8")
        assert "missing-signal warning" in text
        assert text.index("missing-signal warning") < text.index("## KEEP")

    def test_minimal_export_csv_exposes_signals_used(self, tmp_path):
        csv_path = tmp_path / "r.csv"
        out = run_cli(str(MINIMAL_FIXTURE), "--csv", str(csv_path))
        assert out.returncode == 0, out.stderr
        lines = csv_path.read_bytes().decode("utf-8-sig").strip().splitlines()
        header = lines[0].split(",")
        assert "signals_used" in header and "missing_signals" in header
        # ADR r2 §3.4：数据层存信号名，不存 0-3 整数。
        col = header.index("signals_used")
        used = {row.split(",")[col] for row in lines[1:]}
        assert used <= {"", "relevance"}, used

    def test_full_signal_fixture_still_produces_removes(self, tmp_path):
        unfollow = tmp_path / "u.txt"
        out = run_cli(str(FULL_FIXTURE), "--unfollow-list", str(unfollow))
        assert out.returncode == 0, out.stderr
        keep, review, remove = self._summary(out.stderr)
        assert keep >= 1 and remove >= 1, "\u53d6\u5173\u5224\u5b9a\u4e0d\u80fd\u88ab\u524a\u5f31"
        assert len(_unfollow_lines(unfollow)) == remove
        assert "\u7f3a\u4fe1\u53f7\u8b66\u544a" not in out.stderr

    def test_gbk_console_survives_the_chinese_warning_line(self, tmp_path):
        out = run_cli(str(MINIMAL_FIXTURE), cwd=tmp_path,
                      env={"PYTHONIOENCODING": "gbk"})
        assert out.returncode == 0, out.stderr
        assert "Traceback" not in out.stderr
        assert "Summary:" in out.stderr


MINIMAL_FIXTURE = Path(__file__).resolve().parent / "fixture-minimal.json"
FULL_FIXTURE = Path(__file__).resolve().parent / "fixture-full-signals.json"
