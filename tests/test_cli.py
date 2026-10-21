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


def test_cli_unfollow_list_only_remove():
    import csv, io
    tmp = REPO_ROOT / "tmp"
    tmp.mkdir(exist_ok=True)
    out = run_cli(str(FIXTURE), "--unfollow-list", str(tmp / "unfollow.txt"))
    assert out.returncode == 0
    ids = [l.strip() for l in (tmp / "unfollow.txt").read_text().splitlines() if l.strip()]
    assert all(i.startswith("U") for i in ids)
    assert "U100003" in ids
