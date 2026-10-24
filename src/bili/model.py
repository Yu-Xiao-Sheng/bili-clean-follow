from dataclasses import dataclass, field
from typing import Optional, Any
from enum import Enum


class Class(str, Enum):
    KEEP = "keep"
    REVIEW = "review"
    REMOVE = "remove"


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
        return cls(
            # follower_id is primary; mid is only a fallback (docs/spec.md)
            follower_id=str(d.get("follower_id", d.get("mid", ""))),
            # uname 是 B站 关注列表响应里的真实昵称字段（FOR-36：真实导出只有
            # mid + uname + sign + face，认不出 uname 会让取关清单变成一串空名字）。
            nickname=(d.get("nickname") or d.get("follower_name")
                      or d.get("uname") or d.get("name") or ""),
            bio=d.get("bio", d.get("sign", d.get("description", ""))),
            mid=d.get("mid"),
            last_seen_days=d.get("last_seen_days"),
            last_video_days=d.get("last_video_days"),
            follower_count=d.get("follower_count"),
            following_count=d.get("following_count"),
            extra=d.get("extra", {}),
        )
