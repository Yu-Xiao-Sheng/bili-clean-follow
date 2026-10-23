import json
import os
import re
from typing import Any

from .model import FollowRecord

# A "sensitive" input path is a raw cookie / credential file (SESS_bili,
# bili_cookies.json, auth.json, .env, ...). bili-clean only ever reads the
# cleaned JSON export the user produced, never raw credentials, so this guard
# is shared by the CLI and the web report (FOR-27 cookie/key hardening).
SENSITIVE_NAME_RE = re.compile(
    r"(?i)(sess|cookie|credent|secret|auth|api[_-]?key|token|passwd|password|\.env|session)"
)


def refuse_sensitive_path(path: str) -> None:
    """Reject credential-shaped input paths before anything is opened."""
    name = os.path.basename(str(path))
    if SENSITIVE_NAME_RE.search(name):
        raise ValueError(
            "refusing to load %r: bili-clean only accepts a cleaned JSON "
            "export. Never point it at cookies, keys or credential files."
            % name
        )


def load_from_text(text: str) -> list:
    data = json.loads(text)
    return [FollowRecord.from_dict(d) for d in _to_list(data)]


def load_from_file(path: str) -> list:
    refuse_sensitive_path(path)
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
