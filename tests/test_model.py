"""Tests for bili.model: FollowRecord dataclass and from_dict()."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bili.model import Class, FollowRecord


class TestFromDict:
    """from_dict maps recognized fields and keeps sensible defaults."""

    def test_follower_id_primary_mid_fallback(self):
        # Per spec: follower_id is primary; mid only a fallback.
        r = FollowRecord.from_dict({"follower_id": "F1", "mid": "M1", "nickname": "n"})
        assert r.follower_id == "F1"
        assert r.mid == "M1"
        r2 = FollowRecord.from_dict({"mid": "M2", "nickname": "n"})
        assert r2.follower_id == "M2"
        assert r2.mid == "M2"
        assert FollowRecord.from_dict({"follower_id": "F", "mid": "M", "nickname": "n"}).follower_id == "F"

    def test_only_mid(self):
        r = FollowRecord.from_dict({"mid": "M9", "nickname": "n"})
        assert r.follower_id == "M9"

    def test_only_follower_id(self):
        r = FollowRecord.from_dict({"follower_id": "F9", "nickname": "n"})
        assert r.follower_id == "F9"

    def test_nickname_fallbacks(self):
        assert FollowRecord.from_dict({"follower_id": "x", "nickname": "A"}).nickname == "A"
        assert FollowRecord.from_dict({"follower_id": "x", "follower_name": "B"}).nickname == "B"
        assert FollowRecord.from_dict({"follower_id": "x"}).nickname == ""

    def test_bio_fallbacks(self):
        assert FollowRecord.from_dict({"follower_id": "x", "bio": "x"}).bio == "x"
        assert FollowRecord.from_dict({"follower_id": "x", "sign": "y"}).bio == "y"
        assert FollowRecord.from_dict({"follower_id": "x", "description": "z"}).bio == "z"
        assert FollowRecord.from_dict({"follower_id": "x"}).bio == ""

    def test_default_signals_are_none(self):
        r = FollowRecord.from_dict({"follower_id": "id", "nickname": "n"})
        assert r.last_seen_days is None
        assert r.last_video_days is None
        assert r.follower_count is None
        assert r.following_count is None
        assert r.mid is None

    def test_signal_fields_present(self):
        r = FollowRecord.from_dict({
            "follower_id": "id",
            "nickname": "n",
            "last_seen_days": 3.0,
            "last_video_days": 7.5,
            "follower_count": 10,
            "following_count": 20,
            "mid": "m",
            "extra": {"tag": "a"},
        })
        assert r.last_seen_days == 3.0
        assert r.last_video_days == 7.5
        assert r.follower_count == 10
        assert r.following_count == 20
        assert r.mid == "m"
        assert r.extra == {"tag": "a"}

    def test_extra_default_empty_dict_and_per_record(self):
        r1 = FollowRecord.from_dict({"follower_id": "id"})
        r2 = FollowRecord.from_dict({"follower_id": "id2"})
        assert isinstance(r1.extra, dict)
        assert r1.extra == {}
        assert r1.extra is not r2.extra


class TestClass:
    def test_class_values(self):
        assert Class.KEEP == "keep"
        assert Class.REVIEW == "review"
        assert Class.REMOVE == "remove"

    def test_class_is_str(self):
        # str-enum: comparisons with plain literals hold
        assert Class.KEEP == "keep"
        assert "keep" in (Class.KEEP,)
