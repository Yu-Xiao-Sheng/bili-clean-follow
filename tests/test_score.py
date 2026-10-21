import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bili.model import Class, FollowRecord
from bili.score import classify
from bili.loaders import load_from_text


def record(name: str = "t", **kw) -> FollowRecord:
    kw.setdefault("nickname", name)
    return FollowRecord(follower_id="x", **kw)


def test_fresh_creator_is_kept():
    cls, score, _ = classify(record("新",
        bio="官方认证工作室", last_seen_days=1.0, last_video_days=1.0,
        follower_count=200000, following_count=50))
    assert cls == Class.KEEP
    assert score >= 0.7


def test_stale_inactive_is_removed():
    cls, score, _ = classify(record("废",
        bio="", last_seen_days=700.0, last_video_days=700.0,
        follower_count=10, following_count=30000))
    assert cls == Class.REMOVE


def test_mixed_signals_is_review():
    cls, score, reasons = classify(record("中",
        bio="分享风景与生活", last_seen_days=60.0, last_video_days=80.0,
        follower_count=5000, following_count=500))
    assert cls == Class.REVIEW
    assert isinstance(reasons, list) and len(reasons) >= 1


def test_no_signals_never_kept():
    cls, score, _ = classify(record("空"))
    assert cls != Class.KEEP


def test_wrapper_load():
    recs = load_from_text(json.dumps({"follower": [
        {"follower_id": "A", "nickname": "a"},
        {"follower_id": "B", "nickname": "b"},
    ]}))
    assert len(recs) == 2
    assert recs[0].follower_id == "A"
    assert recs[1].nickname == "b"


def test_load_bare_list():
    recs = load_from_text('{"follower_id": "C", "nickname": "c"}')
    assert len(recs) == 1
    assert recs[0].follower_id == "C"
    assert recs[0].nickname == "c"


def test_reason_mentions_name():
    cls, score, reasons = classify(record("显名",
        bio="官方认证工作室", last_seen_days=1.0,
        follower_count=99999, following_count=1))
    text = " ".join(reasons)
    assert "显名" in text
