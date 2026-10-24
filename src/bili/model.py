from dataclasses import dataclass, field
from typing import Optional, Any
from enum import Enum


class Class(str, Enum):
    KEEP = "keep"
    REVIEW = "review"
    REMOVE = "remove"


def _text(*values) -> str:
    """First non-empty stripped string among *values* ("" when none)."""
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _official_fields(d: dict) -> dict:
    """Read B站 官方认证信息 into extra.official_* (FOR-37).

    真实关注列表响应把认证信息放在三处（不同接口版本都有）：
      * ``official`` 块：``{"role": "...", "title": "...", "department": "..."}``
      * 平铺字段：``official_role`` / ``official_title`` / ``official_department``
      * ``official_verify``：``{"type": 1, "source": "..."}``，type > 0 = 已认证
        （type 0 / -1 在导出里就是「没有认证」的占位，不能当认证证据）

    只落有内容的键，不塞空串：score 层用 extra.official_* 判认证，
    不再只靠简介里有没有「官方」两个字（换个 bio 就掉）。
    """
    block = d.get("official") if isinstance(d.get("official"), dict) else {}
    verify = d.get("official_verify") if isinstance(d.get("official_verify"), dict) else {}

    role = _text(block.get("role"), d.get("official_role"))
    title = _text(block.get("title"), d.get("official_title"), verify.get("source"))
    department = _text(block.get("department"), d.get("official_department"))

    verified = bool(role or title or department)
    try:
        if verify.get("type") is not None and int(verify.get("type")) > 0:
            verified = True
    except (TypeError, ValueError):
        pass

    out = {}
    if title:
        out["official_title"] = title
    if role:
        out["official_role"] = role
    if department:
        out["official_department"] = department
    if verified:
        out["official_verified"] = True
    return out


@dataclass
class FollowRecord:
    """One entry from a user's Bilibili follow list."""

    follower_id: str
    nickname: str
    bio: str = ""
    mid: Optional[str] = None
    # Optional signals (None means "unknown" and is scored as neutral)
    last_seen_days: Optional[float] = None
    last_video_days: Optional[float] = None
    follower_count: Optional[int] = None
    following_count: Optional[int] = None
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: "dict") -> "FollowRecord":
        extra = dict(d.get("extra") or {})
        # FOR-37：official / official_verify 识别结果并进 extra，供 relevance 使用。
        extra.update(_official_fields(d))
        return cls(
            # follower_id is primary; mid is only a fallback (docs/spec.md)
            follower_id=str(d.get("follower_id", d.get("mid", ""))),
            # uname / name 是 B站 关注列表响应里的真实昵称字段（FOR-37：真实导出只有
            # mid + name/uname + sign + face，认不出它会让取关清单变成一串空名字）。
            nickname=(d.get("nickname") or d.get("follower_name")
                      or d.get("uname") or d.get("name") or ""),
            bio=d.get("bio", d.get("sign", d.get("description", ""))),
            mid=d.get("mid"),
            last_seen_days=d.get("last_seen_days"),
            last_video_days=d.get("last_video_days"),
            follower_count=d.get("follower_count"),
            following_count=d.get("following_count"),
            extra=extra,
        )