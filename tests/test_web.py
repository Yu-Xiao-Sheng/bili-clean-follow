"""Tests for the local web report (FOR-27)."""

import json
import threading
from pathlib import Path

from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from bili import demo
from bili import web
from bili.export import run as export_run


SAMPLE_COUNT = 24
SAMPLE_SEED = 7


def _start_server(records):
    srv = web.build_server(records)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv


def _base(srv):
    return "http://127.0.0.1:%d" % srv.server_address[1]


def _get(base, path):
    with urlopen(Request(base + path), timeout=5) as resp:
        return resp.status, resp.headers, resp.read()


def _expect_error(base, path, code):
    try:
        with urlopen(Request(base + path), timeout=5):
            raise AssertionError("expected HTTP %d, got 200" % code)
    except HTTPError as exc:
        assert exc.code == code, "expected %d, got %s" % (code, exc.code)


@pytest.fixture
def sample_server():
    records = export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED))
    srv = _start_server(records)
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


def test_index_html_serves_report(sample_server):
    base = _base(sample_server)
    status, headers, body = _get(base, "/")
    assert status == 200
    text = body.decode("utf-8")
    # FOR-38: 导出说明要在页面上写清楚（BOM / mid + 昵称），用户才不会再踩坑。
    assert "mid + Tab + 昵称" in text
    assert "UTF-8 BOM" in text
    assert "B站关注分类报告" in text
    assert "导出 Markdown" in text
    assert "导出 CSV" in text
    assert "导出取关清单" in text
    assert "本地只读" in text
    assert '"total": 24' in text
    assert '"class": "keep"' in text
    assert '"class": "remove"' in text


def test_summary_api(sample_server):
    expected = web.summarize(export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED)))
    status, headers, body = _get(_base(sample_server), "/api/summary")
    assert status == 200
    assert json.loads(body.decode("utf-8")) == expected


def test_health(sample_server):
    status, headers, body = _get(_base(sample_server), "/api/health")
    assert status == 200
    assert json.loads(body.decode("utf-8")) == {"ok": True, "version": "0.1.1"}


def test_results_filter(sample_server):
    expected = web.summarize(export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED)))
    base = _base(sample_server)
    _, headers, body = _get(base, "/api/results")
    data = json.loads(body.decode("utf-8"))
    assert data["count"] == expected["total"]
    for r in data["rows"]:
        assert "follower_id" in r and "class" in r
    _, headers, body = _get(base, "/api/results?cls=keep")
    keep = json.loads(body.decode("utf-8"))
    assert keep["count"] == expected["counts"]["keep"]
    assert all(r["class"] == "keep" for r in keep["rows"])


def test_export_md_and_csv(sample_server):
    base = _base(sample_server)
    status, headers, body = _get(base, "/export?fmt=md")
    assert status == 200
    assert "Report" in body.decode("utf-8")
    assert "attachment" in headers.get("Content-Disposition", "")
    assert "markdown" in headers.get("Content-Type", "").lower()

    status, headers, body = _get(base, "/export?fmt=csv")
    assert status == 200
    # FOR-38: CSV 必须带 UTF-8 BOM，否则 Windows Excel/WPS 双击打开中文乱码。
    assert body.startswith(b"\xef\xbb\xbf"), "web CSV must be utf-8-sig"
    text = body.decode("utf-8-sig")
    assert text.startswith("follower_id,nickname")


def test_unfollow_requires_confirmation(sample_server):
    expected = web.summarize(export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED)))
    assert expected["counts"]["remove"] > 0
    base = _base(sample_server)
    _expect_error(base, "/unfollow", 400)
    status, headers, body = _get(base, "/unfollow?confirm=1")
    assert status == 200
    results = export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED))
    expected = [r for r in results if r["class"] == "remove"]
    assert expected
    assert body.startswith(b"\xef\xbb\xbf"), "unfollow list must be utf-8-sig"
    text = body.decode("utf-8-sig")
    rows = [l for l in text.splitlines() if l and not l.startswith("#")]
    # FOR-38: 只有 mid 的清单没用，每行必须带上昵称才能人工对上号。
    # 清单第一列是 B站 UID（mid），没有 mid 时才退回 follower_id。
    assert [l.split("\t")[0] for l in rows] == \
        [(r["mid"] or r["follower_id"]) for r in expected]
    assert [l.split("\t")[1] for l in rows] == [r["nickname"] for r in expected]
    comments = [l for l in text.splitlines() if l.startswith("#")]
    assert any("不会自动取关" in l for l in comments)
    assert any("nickname" in l.lower() for l in comments)
    assert "attachment" in headers.get("Content-Disposition", "")


def test_all_keep_has_empty_unfollow_list(tmp_path):
    recs = []
    for i in range(3):
        recs.append({
            "follower_id": "K%d" % i,
            "nickname": "keeper%d" % i,
            "bio": "官方认证工作室",
            "last_seen_days": 0.0,
            "last_video_days": 1.0,
            "follower_count": 50000,
            "following_count": 50,
        })
    path = tmp_path / "keeps.json"
    path.write_text(json.dumps(recs, ensure_ascii=False), encoding="utf-8")
    results = web.load_report(str(path))
    assert all(r["class"] == "keep" for r in results)
    srv = _start_server(results)
    try:
        base = _base(srv)
        status, headers, body = _get(base, "/unfollow?confirm=1")
        assert status == 200
        # 没有删除候选时只剩说明行，没有任何可执行条目。
        text = body.decode("utf-8-sig")
        assert [l for l in text.splitlines() if l and not l.startswith("#")] == []
        assert any("不会自动取关" in l for l in text.splitlines())
        status, headers, body = _get(base, "/api/results?cls=remove")
        assert json.loads(body.decode("utf-8"))["count"] == 0
    finally:
        srv.shutdown()
        srv.server_close()


def test_sensitive_input_refused():
    bad = ("SESS_bili.txt", "credentials.json", "my_api_key.json",
           "user.env", "auth.json", "session.json", "my cookie.txt")
    for name in bad:
        with pytest.raises(ValueError):
            web.refuse_sensitive_path(name)
    # clean export names must pass the guard
    web.refuse_sensitive_path("sample-follows.json")
    web.refuse_sensitive_path("follows.json")
    web.refuse_sensitive_path("report/keeps.json")


def test_load_report_missing_file(tmp_path):
    with pytest.raises(OSError):
        web.load_report(str(tmp_path / "nope.json"))


MINIMAL_FIXTURE = Path(__file__).resolve().parent / "fixture-minimal.json"


class TestMissingSignalBanner:
    """FOR-36 规则 4：Web 报告顶部也要打缺信号警告。"""

    def test_banner_shown_for_minimal_export(self):
        results = web.load_report(str(MINIMAL_FIXTURE))
        html = web.build_page_html(results, web.summarize(results))
        assert 'class="warn"' in html
        assert "missing-signal warning" in html
        assert "last_seen_days" in html

    def test_banner_hidden_for_full_signal_sample(self):
        results = export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED))
        html = web.build_page_html(results, web.summarize(results))
        assert 'class="warn"' not in html
        assert "missing-signal warning" not in html

    def test_no_placeholder_left_in_page(self):
        results = export_run(demo.generate(6, SAMPLE_SEED))
        html = web.build_page_html(results, web.summarize(results))
        assert "__WARNING_HTML__" not in html


class TestSignalsUsedColumnInWeb:
    def test_page_and_api_carry_signals_used(self):
        results = export_run(demo.generate(6, SAMPLE_SEED))
        html = web.build_page_html(results, web.summarize(results))
        assert "signals_used" in html
        srv = _start_server(results)
        try:
            status, _, body = _get(_base(srv), "/api/results")
            rows = json.loads(body.decode("utf-8"))["rows"]
            assert rows and all(r["signals_used"] == 3 for r in rows)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_minimal_export_rows_show_zero_or_one_signal(self):
        rows = web._display_rows(web.load_report(str(MINIMAL_FIXTURE)))
        assert rows
        assert all(r["signals_used"] <= 1 for r in rows)
