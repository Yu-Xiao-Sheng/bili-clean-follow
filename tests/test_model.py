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

    def test_uname_is_the_real_bilibili_nickname_field(self):
        # FOR-36: 真实导出里昵称字段是 uname，认不出它取关清单就只剩空名字。
        r = FollowRecord.from_dict({"mid": "300000", "uname": "阿花", "sign": "摄影"})
        assert r.nickname == "阿花"
        assert r.bio == "摄影"
        # nickname 仍然是第一优先，不能被 uname 覆盖。
        assert FollowRecord.from_dict({"mid": "1", "nickname": "N", "uname": "U"}).nickname == "N"

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


class TestOfficialCertification:
    """FOR-37：official / official_verify 识别结果落到 extra.official_*。"""

    def test_official_block_is_captured(self):
        r = FollowRecord.from_dict({
            "mid": "22000", "name": "人民日报", "sign": "官方认证的媒体账号",
            "official": {"role": "认证：媒体", "title": "知名科技媒体", "department": ""},
            "official_verify": {"type": 1},
        })
        assert r.nickname == "人民日报"
        assert r.extra["official_title"] == "知名科技媒体"
        assert r.extra["official_role"] == "认证：媒体"
        assert r.extra["official_verified"] is True
        # department 是空串 -> 不落键，extra 里不留空值。
        assert "official_department" not in r.extra

    def test_flat_official_fields_work_too(self):
        r = FollowRecord.from_dict({"mid": "1", "nickname": "n",
                                    "official_title": "知名科技媒体",
                                    "official_verify": {"type": -1}})
        assert r.extra["official_title"] == "知名科技媒体"
        assert r.extra["official_verified"] is True

    def test_verify_type_zero_or_minus_one_is_not_certification(self):
        # 导出里 official_verify.type = 0 / -1 是「没有认证」的占位，不能当证据。
        r = FollowRecord.from_dict({"mid": "1", "name": "老番茄",
                                    "official_verify": {"type": 0}})
        assert r.extra == {}
        r2 = FollowRecord.from_dict({"mid": "2", "name": "x",
                                     "official_verify": {"type": -1}})
        assert r2.extra == {}

    def test_verify_source_is_a_title_fallback(self):
        r = FollowRecord.from_dict({"mid": "1", "nickname": "n",
                                    "official_verify": {"type": 1, "source": "某机构"}})
        assert r.extra["official_title"] == "某机构"

    def test_non_int_verify_type_does_not_crash(self):
        r = FollowRecord.from_dict({"mid": "1", "nickname": "n",
                                    "official_verify": {"type": "unknown"}})
        assert r.extra == {}

    def test_existing_extra_keys_survive(self):
        r = FollowRecord.from_dict({"mid": "1", "nickname": "n",
                                    "extra": {"tag": "a"},
                                    "official": {"title": "T"}})
        assert r.extra["tag"] == "a"
        assert r.extra["official_title"] == "T"

    def test_extra_is_not_shared_between_records(self):
        a = FollowRecord.from_dict({"mid": "1", "nickname": "a",
                                    "official": {"title": "T"}})
        b = FollowRecord.from_dict({"mid": "2", "nickname": "b"})
        assert "official_title" not in b.extra
        assert a.extra is not b.extra
