"""Tests for bili.score: 归一化打分 + FOR-36 两道闸门 + signals_used。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bili.model import Class, FollowRecord
from bili.loaders import load_from_file, load_from_text
from bili.score import (GATE_A_REASON, GATE_B_REASON, REVIEW_MIN, classify,
                        provided_signals, signals_used, weighted_score)

FIXTURES = Path(__file__).resolve().parent


def record(name="t", **kw):
    kw.setdefault("nickname", name)
    return FollowRecord(follower_id="x", **kw)


class TestScoringBasics:
    def test_fresh_creator_is_kept(self):
        cls, score, _ = classify(record("新",
            bio="官方认证工作室", last_seen_days=1.0, last_video_days=1.0,
            follower_count=200000, following_count=50))
        assert cls == Class.KEEP
        assert score >= 0.7

    def test_stale_inactive_is_removed(self):
        cls, score, _ = classify(record("废",
            bio="", last_seen_days=700.0, last_video_days=700.0,
            follower_count=10, following_count=30000))
        assert cls == Class.REMOVE

    def test_mixed_signals_is_review(self):
        cls, score, reasons = classify(record("中",
            bio="分享风景与生活", last_seen_days=60.0, last_video_days=80.0,
            follower_count=5000, following_count=500))
        assert cls == Class.REVIEW
        assert isinstance(reasons, list) and len(reasons) >= 1

    def test_reason_mentions_name(self):
        cls, score, reasons = classify(record("显名",
            bio="官方认证工作室", last_seen_days=1.0,
            follower_count=99999, following_count=1))
        text = " ".join(reasons)
        assert "显名" in text


class TestNormalizationIsOverProvidedSignals:
    """FOR-36 规则 1：分母只含已提供信号的权重，未知不等于最差。"""

    def test_no_signal_scores_zero_but_is_not_removed(self):
        cls, score, reasons = classify(record("空"))
        assert score == 0.0
        assert cls == Class.REVIEW, "无信号必须是 review，不能再是 remove"
        assert GATE_A_REASON in reasons

    def test_two_signals_are_normalized_over_their_weights(self):
        rec = record("两信号", last_seen_days=0.0,
                     follower_count=10000, following_count=1)
        # (0.45*1.0 + 0.30*1.0) / (0.45 + 0.30) == 1.0，不是旧的 0.75。
        assert abs(weighted_score(rec) - 1.0) < 1e-9
        assert provided_signals(rec) == ["recency", "authority"]

    def test_only_relevance_keeps_its_own_scale(self):
        rec = record("只有简介", bio="官方认证的媒体账号，每日更新")
        assert abs(weighted_score(rec) - 1.0) < 1e-9, "只有 relevance 时分母 0.25，不能变成 0.25"

    def test_missing_signal_never_lowers_score_below_provided_only(self):
        full = record("全", bio="分享风景", last_seen_days=1.0,
                      follower_count=5000, following_count=50)
        partial = record("缺", bio="分享风景", last_seen_days=1.0)
        assert weighted_score(partial) >= weighted_score(full)


class TestGateAUnknownRecencyCannotUnfollow:
    """闸门 A：recency 未知 = 没有取关依据，最多 review。"""

    def test_stale_authority_without_recency_is_review(self):
        cls, score, reasons = classify(record("旧",
            bio="停更很久", follower_count=12, following_count=20000))
        assert cls == Class.REVIEW
        assert GATE_A_REASON in reasons
        assert score < REVIEW_MIN, "分数仍然很低，但不能拿缺失当取关证据"

    def test_recency_present_allows_remove(self):
        cls, score, _ = classify(record("可删", bio="", last_seen_days=900.0,
                                        follower_count=5, following_count=900))
        assert cls == Class.REMOVE


class TestGateBOnlyBioCannotKeep:
    """闸门 B：只有简介（哪怕写着官方认证）不得 keep。"""

    def test_official_bio_alone_is_review_not_keep(self):
        cls, score, reasons = classify(record("官方",
            bio="官方认证的媒体账号，每日更新"))
        assert cls == Class.REVIEW
        assert GATE_B_REASON in reasons

    def test_keep_needs_recency_or_authority(self):
        cls, _, _ = classify(record("有权威", bio="官方认证工作室",
                                    follower_count=200000, following_count=10))
        assert cls == Class.KEEP, "authority 提供了，keep 允许"


class TestSignalsUsedObservability:
    def test_counts(self):
        assert signals_used(record("零")) == 0
        assert signals_used(record("一", bio="简介")) == 1
        assert signals_used(record("三", bio="简介", last_seen_days=3.0,
                                   follower_count=10, following_count=20)) == 3

    def test_class_line_reports_signals_used(self):
        _, _, reasons = classify(record("记", bio="简介"))
        assert "signals_used=1" in reasons[-1]


class TestFixturesAreTheAcceptanceProof:
    """CTO/CMO 的两类夹具：最小导出全 review，补齐信号后 remove 仍在。"""

    def test_minimal_identity_bio_export_is_all_review(self):
        recs = load_from_file(str(FIXTURES / "fixture-minimal.json"))
        assert len(recs) == 13
        counts = {"keep": 0, "review": 0, "remove": 0}
        for r in recs:
            counts[classify(r)[0].value] += 1
        assert counts == {"keep": 0, "review": 13, "remove": 0}

    def test_minimal_export_recognizes_the_real_response_envelope(self):
        # {"code":0,"data":{"follower":[...]}} 是浏览器里直接复制的真实形状。
        recs = load_from_file(str(FIXTURES / "fixture-minimal.json"))
        assert all(r.mid for r in recs)
        assert all(r.nickname for r in recs), "uname 必须能认出昵称"
        assert all(r.bio is not None for r in recs)

    def test_full_signal_export_still_produces_keep_and_remove(self):
        recs = load_from_file(str(FIXTURES / "fixture-full-signals.json"))
        counts = {"keep": 0, "review": 0, "remove": 0}
        for r in recs:
            counts[classify(r)[0].value] += 1
        assert counts["keep"] >= 1 and counts["remove"] >= 1

    def test_wrapper_load(self):
        recs = load_from_text(json.dumps({"follower": [
            {"follower_id": "A", "nickname": "a"},
            {"follower_id": "B", "nickname": "b"},
        ]}))
        assert len(recs) == 2
        assert recs[0].follower_id == "A"
        assert recs[1].nickname == "b"

    def test_load_bare_list(self):
        recs = load_from_text('{"follower_id": "C", "nickname": "c"}')
        assert len(recs) == 1
        assert recs[0].follower_id == "C"
