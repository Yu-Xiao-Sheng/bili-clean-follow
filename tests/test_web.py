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
    text = body.decode("utf-8")
    assert text.startswith("follower_id,nickname")


def test_unfollow_requires_confirmation(sample_server):
    expected = web.summarize(export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED)))
    assert expected["counts"]["remove"] > 0
    base = _base(sample_server)
    _expect_error(base, "/unfollow", 400)
    status, headers, body = _get(base, "/unfollow?confirm=1")
    assert status == 200
    expected_ids = "\n".join(
        r["follower_id"] for r in export_run(demo.generate(SAMPLE_COUNT, SAMPLE_SEED))
        if r["class"] == "remove"
    )
    assert body.decode("utf-8") == expected_ids + "\n"
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
        assert body == b""
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