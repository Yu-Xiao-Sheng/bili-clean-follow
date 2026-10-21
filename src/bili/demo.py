"""Generate a small sample follows.json so you can try the tool without a login.

Run: python -m bili.demo
"""

import json
import os
import random
from datetime import datetime, timedelta

from .model import FollowRecord


def _base_name(i):
    names = ["阿花", "山河", "草木", "老周", "小鹿", "阿远", "青禾", "木子",
             "风铃", "南野", "拾光", "青灯", "阿禾", "云归", "晚舟"]
    return "%s%s" % (names[i % len(names)], str(i))


def generate(count: int = 24, seed: int = 7) -> list:
    random.seed(seed)
    recs = []
    today = datetime.now().date()
    for i in range(count):
        r = random.randint(0, 1)
        if r == 0:
            last_seen = random.randint(0, 7)
            last_video = random.randint(0, 14)
            followers = random.randint(20000, 300000)
            following = random.randint(0, 200)
        elif r == 1:
            last_seen = random.randint(90, 700)
            last_video = random.randint(180, 900)
            followers = random.randint(50, 3000)
            following = random.randint(500, 20000)
        else:
            last_seen = random.randint(30, 180)
            last_video = random.randint(30, 180)
            followers = random.randint(500, 40000)
            following = random.randint(50, 1200)
        official = random.random() < 0.15
        bio = "官方认证工作室" if official else "%s的频道。分享%s。" % (_base_name(i), random.choice(["风景", "生活", "摄影", "读书", "烹饪"]))
        recs.append(FollowRecord(
            follower_id="U%d" % (100000 + i),
            nickname=_base_name(i) + str(i % 13),
            bio=bio.strip(),
            mid="mid%d" % (100000 + i),
            last_seen_days=float(last_seen),
            last_video_days=float(last_video),
            follower_count=followers,
            following_count=following,
        ))
    return recs


def save(path: str, count: int = 24, seed: int = 7) -> str:
    recs = generate(count=count, seed=seed)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(
            [{"follower_id": r.follower_id, "nickname": r.nickname, "bio": r.bio,
              "mid": r.mid, "last_seen_days": r.last_seen_days,
              "last_video_days": r.last_video_days,
              "follower_count": r.follower_count,
              "following_count": r.following_count} for r in recs],
            ensure_ascii=False, indent=2))
    return path


if __name__ == "__main__":
    path = os.path.join(os.getcwd(), "sample-follows.json")
    print("Sample follows written to %s" % save(path))
