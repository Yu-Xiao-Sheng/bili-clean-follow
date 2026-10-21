import json
from typing import Any

from .model import FollowRecord


def load_from_text(text: str) -> list:
    data = json.loads(text)
    return [FollowRecord.from_dict(d) for d in _to_list(data)]


def load_from_file(path: str) -> list:
    with open(path, "r", encoding="utf-8") as fh:
        return load_from_text(fh.read())


def _to_list(data: Any) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        # A single bare follow object (has identity-ish fields).
        if any(k in data for k in ("follower_id", "mid", "nickname", "follower_name", "bio", "sign")):
            return [data]
        # Known wrapper shapes.
        for key in ("follower", "follow", "data", "list", "items"):
            if isinstance(data.get(key), list):
                return data[key]
    raise ValueError(
        "Could not find a list of follows in the JSON. "
        "Expected a list, a single follow object, or an object with a follower/data/list key."
    )
