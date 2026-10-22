"""Tests for bili.export: run() / to_markdown() / to_csv()."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bili.export import run, to_markdown, to_csv, _clean_pipe
from bili.model import FollowRecord


def rec(nickname="n", **kw):
    kw.setdefault("follower_id", "id")
    return FollowRecord(nickname=nickname, **kw)


def keep_rec(nickname="a"):
    # high recency + high authority, empty bio -> score 0.75 -> keep
    return rec(nickname=nickname, last_seen_days=0.0,
               follower_count=10000, following_count=1)


def csv_rows(s):
    """Normalize CSV text into a list of rows (no line endings, no blanks)."""
    return [l for l in s.strip().splitlines() if l]


class TestRun:
    def test_returns_list_of_dicts(self):
        results = run([rec(nickname="a"), rec(nickname="b")])
        assert len(results) == 2
        assert all(isinstance(r, dict) for r in results)
        for r in results:
            assert set(("follower_id", "nickname", "class", "score", "reason")).issubset(r)
            assert r["class"] in ("keep", "review", "remove")
            assert 0.0 <= r["score"] <= 1.0
            assert r["follower_id"] == "id"

    def test_classification_keep(self):
        r = run([keep_rec()])[0]
        assert r["class"] == "keep"
        assert r["score"] >= 0.7
        assert abs(r["score"] - 0.75) < 1e-9  # deterministic: 0.45+0.30

    def test_classification_remove_empty(self):
        r = run([rec()])[0]
        assert r["class"] == "remove"
        assert r["score"] < 0.4

    def test_reason_is_list(self):
        r = run([keep_rec()])[0]
        assert isinstance(r["reason"], list)
        assert len(r["reason"]) >= 1

    def test_preserves_fields(self):
        r = run([rec(nickname="z", last_seen_days=5.0, follower_count=10, following_count=11)])[0]
        assert r["nickname"] == "z"
        assert r["last_seen_days"] == 5.0
        assert r["follower_count"] == 10
        assert r["following_count"] == 11


class TestToMarkdown:
    def test_sections_present(self):
        res = run([keep_rec("a"), rec("b")])
        md = to_markdown(res)
        assert "# Bili Clean Follow Report" in md
        assert "Total follows: 2" in md
        assert "## KEEP" in md
        assert "## REVIEW" in md
        assert "## REMOVE" in md

    def test_counts_in_headers(self):
        res = run([keep_rec("a"), rec("b")])
        md = to_markdown(res)
        assert "## KEEP (1)" in md
        assert "## REMOVE (1)" in md

    def test_empty_group_header_zero(self):
        res = run([keep_rec("a")])
        md = to_markdown(res)
        assert "## KEEP (1)" in md
        assert "## REVIEW (0)" in md
        assert "## REMOVE (0)" in md

    def test_no_missing_groups_crash(self):
        # Even a fully empty input should produce a valid document.
        md = to_markdown([])
        assert "Total follows: 0" in md
        assert "## KEEP (0)" in md
        assert "## REVIEW (0)" in md
        assert "## REMOVE (0)" in md

    def test_reason_pipe_escaped(self):
        res = run([keep_rec()])
        md = to_markdown(res)
        # a data row has the expected 6 pipe-delimited cells
        for line in md.splitlines():
            if line.startswith("| "):
                assert line.count("|") == 7

    def test_score_shown_two_decimals(self):
        res = run([keep_rec("a")])
        md = to_markdown(res)
        assert "| 1 | a |" in md
        assert "0.75" in md
        # verify the score cell of the keep row shows two decimals
        row = [ln for ln in md.splitlines() if ln.startswith("| 1 | a |")][0]
        assert "| 1 | a | 0.75 |" in row


class TestToCsv:
    def test_header_and_rows(self):
        res = run([keep_rec("a"), rec("b")])
        rows = csv_rows(to_csv(res))
        assert rows[0] == ("follower_id,nickname,class,score,last_seen_days,"
                           "last_video_days,follower_count,following_count")
        assert len(rows) == 3  # header + 2 rows

    def test_none_fields_blank(self):
        res = run([rec("b")])
        rows = csv_rows(to_csv(res))
        cols = rows[1].split(",")
        assert cols[4] == ""  # last_seen_days None -> blank
        assert cols[7] == ""  # following_count None -> blank

    def test_csv_round_trips_class(self):
        res = run([keep_rec("a")])
        rows = csv_rows(to_csv(res))
        assert "keep" in rows[1]

    def test_clean_pipe(self):
        assert _clean_pipe("a|b") == "a\\|b"
        assert _clean_pipe("no pipes") == "no pipes"
