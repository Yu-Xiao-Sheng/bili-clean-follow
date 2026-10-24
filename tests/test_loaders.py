"""Tests for bili.loaders: load_from_text / load_from_file / _to_list."""
import json
import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bili.loaders import (load_from_text, load_from_file, load_raw_from_file,
                     _to_list)
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


class TestBomInput:
    """FOR-36 / FOR-35：记事本、Excel另存的 UTF-8 BOM 输入不能再报错。"""

    BOM = "\ufeff"

    def _write(self, tmp_path, name, text):
        p = tmp_path / name
        p.write_bytes(text.encode("utf-8"))
        return p

    def test_load_from_file_strips_bom(self, tmp_path):
        p = self._write(tmp_path, "f.json", self.BOM + json.dumps([
            {"follower_id": "a", "nickname": "a"}]))
        recs = load_from_file(str(p))
        assert len(recs) == 1 and recs[0].follower_id == "a"

    def test_bom_chinese_nickname_survives(self, tmp_path):
        p = self._write(tmp_path, "f.json",
                        self.BOM + json.dumps([{"mid": "1", "nickname": "\u4e2d\u6587"}],
                                              ensure_ascii=False))
        recs = load_from_file(str(p))
        assert recs[0].nickname == "\u4e2d\u6587"

    def test_bom_plus_crlf_plus_indent_is_loadable(self, tmp_path):
        body = json.dumps({"follower": [{"follower_id": "x", "nickname": "x"}]},
                          indent=2)
        p = self._write(tmp_path, "f.json", self.BOM + body.replace("\n", "\r\n"))
        assert len(load_from_file(str(p))) == 1

    def test_load_raw_from_file_strips_bom(self, tmp_path):
        p = self._write(tmp_path, "s.csv.json",
                        self.BOM + json.dumps([{"mid": "7", "nickname": "n"}]))
        raw = load_raw_from_file(str(p))
        assert raw == [{"mid": "7", "nickname": "n"}]

    def test_load_from_text_with_bom_raises_like_json(self):
        # load_from_text 是纯文本入口：BOM 归调用方（文件读取已用 utf-8-sig）。
        with pytest.raises(ValueError):
            load_from_text(self.BOM + "[]")


class TestRealResponseEnvelope:
    """FOR-36：浏览器里直接复制的真实关注列表响应。"""

    def test_nested_data_follower_envelope(self):
        body = {"code": 0, "message": "0", "ttl": 0,
                "data": {"follower": [{"mid": "1", "uname": "a"},
                                      {"mid": "2", "uname": "b"}], "total": 2}}
        recs = load_from_text(json.dumps(body))
        assert len(recs) == 2
        assert recs[0].follower_id == "1"

    def test_nested_data_list_key(self):
        body = {"code": 0, "data": {"list": [{"mid": "9", "nickname": "n"}]}}
        assert len(load_from_text(json.dumps(body))) == 1

    def test_nested_data_single_object_still_raises(self):
        with pytest.raises(ValueError):
            load_from_text('{"data": {"follower_id": "x"}}')

    def test_uname_only_rows_get_a_nickname(self):
        recs = load_from_text(json.dumps([{"mid": "3", "uname": "\u963f\u82b1", "sign": "\u6444\u5f71"}]))
        assert recs[0].nickname == "\u963f\u82b1"
        assert recs[0].bio == "\u6444\u5f71"


class TestRealExportFixtures:
    """FOR-37：真实形状夹具文件进 tests（浏览器复制的响应，带 official 块与 emoji 昵称）。"""

    REAL = Path(__file__).resolve().parent / "fixture-bili-real.json"
    REAL_LIST = Path(__file__).resolve().parent / "fixture-bili-real-list.json"

    def test_data_follower_envelope_file_loads(self):
        recs = load_from_file(str(self.REAL))
        assert len(recs) == 20
        assert all(r.nickname for r in recs), "真实导出昵称不能空"
        assert recs[0].mid == 22000

    def test_data_list_variant_loads(self):
        recs = load_from_file(str(self.REAL_LIST))
        assert len(recs) == 20
        assert all(r.nickname for r in recs)

    def test_name_is_the_nickname_field_and_sign_is_the_bio(self):
        recs = load_from_file(str(self.REAL))
        row = [r for r in recs if r.mid == 22000][0]
        assert row.nickname == "人民日报"
        assert row.bio == "官方认证的媒体账号，每日更新"

    def test_official_block_reaches_the_record(self):
        recs = load_from_file(str(self.REAL))
        certified = [r for r in recs if r.extra.get("official_title")]
        assert [r.mid for r in certified] == [22000, 22001, 22017]
        assert certified[0].extra["official_role"] == "认证：媒体"
        # official_verify.type = 0 的那些账号不算认证。
        assert len(certified) == 3

    def test_emoji_nickname_survives_the_round_trip(self):
        recs = load_from_file(str(self.REAL))
        names = [r.nickname for r in recs]
        assert any(n.startswith(chr(0x1F600)) for n in names)

    def test_hoisted_array_variant_loads(self):
        # 有的用户把 data.follower 手工提到顶层（docs/getting-started.md 方式 B）。
        payload = json.loads(self.REAL.read_text(encoding="utf-8"))
        rows = payload["data"]["follower"]
        assert len(load_from_text(json.dumps(rows, ensure_ascii=False))) == 20
