import os
import subprocess
import sys
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixture-follows.json"
REPO_ROOT = FIXTURE.parent.parent
SRC = REPO_ROOT / "src"


def run_cli(*args):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(SRC)
    return subprocess.run(
        [sys.executable, "-m", "bili.cli", *args],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
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


def test_cli_csv():
    tmp = REPO_ROOT / "tmp"
    tmp.mkdir(exist_ok=True)
    out = run_cli(str(FIXTURE), "--csv", str(tmp / "report.csv"))
    assert out.returncode == 0
    lines = (tmp / "report.csv").read_text(encoding="utf-8").strip().split("\n")
    assert lines[0].startswith("follower_id,nickname,class")
    assert len(lines) == 5


def test_cli_summary_in_stderr():
    out = run_cli(str(FIXTURE))
    assert "Summary:" in out.stderr
    assert "keep=" in out.stderr
    assert "remove=" in out.stderr


def test_cli_unfollow_list_only_remove():
    tmp = REPO_ROOT / "tmp"
    tmp.mkdir(exist_ok=True)
    out = run_cli(str(FIXTURE), "--unfollow-list", str(tmp / "unfollow.txt"))
    assert out.returncode == 0
    ids = [l.strip() for l in (tmp / "unfollow.txt").read_text().splitlines() if l.strip()]
    # only REMOVE-class ids are written: U100003 and U100004 (no signals)
    assert ids == ["U100003", "U100004"]
    assert all(i.startswith("U") for i in ids)


def test_cli_version():
    out = run_cli("--version")
    assert out.returncode == 0
    assert out.stdout.strip() == "bili-clean 0.1.0"
    assert "%(prog)s" not in out.stdout  # regression: f-string bug (literal %%(prog)s)


def test_cli_missing_file_exit_code_2():
    out = run_cli("does-not-exist.json")
    assert out.returncode == 2
    assert "error:" in out.stderr
    assert "could not load follows" in out.stderr
