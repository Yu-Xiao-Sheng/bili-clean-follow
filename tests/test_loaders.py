"""Tests for bili.loaders: load_from_text / load_from_file / _to_list."""
import json
import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bili.loaders import load_from_text, load_from_file, _to_list
from bili.model import FollowRecord


class TestLoadFromText:
    def test_bare_list(self):
        recs = load_from_text(json.dumps([
            {"follower_id": "a", "nickname": "a"},
            {"follower_id": "b", "nickname": "b"},
        ]))
        assert len(recs) == 2
        assert all(isinstance(r, FollowRecord) for r in recs)
        assert recs[0].follower_id == "a"
        assert recs[1].nickname == "b"

    def test_single_object(self):
        # A bare object with identity-ish fields -> wrapped in a list.
        recs = load_from_text('{"follower_id":"x","nickname":"x"}')
        assert len(recs) == 1
        assert recs[0].follower_id == "x"

    def test_single_object_via_mid(self):
        recs = load_from_text('{"mid":"M","bio":"b"}')
        assert len(recs) == 1
        assert recs[0].follower_id == "M"

    def test_empty_list(self):
        assert load_from_text("[]") == []

    def test_wrapper_shapes(self):
        body = [{"follower_id": "x", "nickname": "x"}]
        for key in ("follower", "follow", "data", "list", "items"):
            recs = load_from_text(json.dumps({key: body}))
            assert len(recs) == 1, key
            assert recs[0].follower_id == "x"

    def test_single_object_wrapper_no_wrap(self):
        # {"data": {...single...}} where data is a dict not a list -> not a list -> error
        with pytest.raises(ValueError):
            load_from_text('{"data": {"follower_id": "x"}}')

    def test_wrapper_non_list_ignored(self):
        with pytest.raises(ValueError):
            load_from_text('{"follower": "not-a-list", "other": 1}')

    def test_invalid_json(self):
        # json.JSONDecodeError is a subclass of ValueError
        with pytest.raises(ValueError):
            load_from_text("not json [")

    def test_unicode_chinese(self):
        recs = load_from_text('{"follower_id":"a","nickname":"中文昵称","bio":"风景"}')
        assert recs[0].nickname == "中文昵称"
        assert recs[0].bio == "风景"

    def test_empty_dict_raises(self):
        with pytest.raises(ValueError):
            load_from_text("{}")


class TestLoadFromFile:
    def test_read_file(self, tmp_path):
        p = tmp_path / "f.json"
        p.write_text(json.dumps([{"follower_id": "a", "nickname": "a"}]), encoding="utf-8")
        recs = load_from_file(str(p))
        assert len(recs) == 1
        assert recs[0].follower_id == "a"

    def test_read_file_utf8(self, tmp_path):
        p = tmp_path / "f.json"
        p.write_text(
            json.dumps([{"follower_id": "a", "nickname": "中文"}], ensure_ascii=False),
            encoding="utf-8",
        )
        recs = load_from_file(str(p))
        assert recs[0].nickname == "中文"


class TestToList:
    def test_list_passthrough(self):
        assert _to_list([1, 2]) == [1, 2]

    def test_single_object_wrap(self):
        d = {"mid": "M", "bio": "b"}
        assert _to_list(d) == [d]

    def test_unknown_dict_raises(self):
        with pytest.raises(ValueError):
            _to_list({"a": 1, "b": 2})
