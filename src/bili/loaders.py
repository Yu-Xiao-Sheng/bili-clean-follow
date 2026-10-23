import json
import os
import re
import sys
from typing import Any, List

from .model import FollowRecord

# 读文件内容做凭据判定时的采样上限（关注列表导出都很小，取 1MB 足够）。
_SNIFF_BYTES = 1_000_000

# A "sensitive" input *name* is a raw cookie / credential file (SESS_bili,
# bili_cookies.json, auth.json, .env, ...). bili-clean only ever reads the
# cleaned JSON export the user produced, never raw credentials.
#
# FOR-38：名字只是线索，不是证据。真实的中文用户会把自己的关注列表导出存成
# "follows_from_browser_cookies.json" 这类名字，v0.1.1 一刀切按名字拒读属于误伤。
# 现在先按内容判定（见 COOKIE_CONTENT_RE），只有内容里真的出现 cookie 键才拒绝。
SENSITIVE_NAME_RE = re.compile(
    r"(?i)(sess|cookie|credent|secret|auth|api[_-]?key|token|passwd|password|\.env|session)"
)

# B站 / 浏览器 cookie 里真正等于"登录凭据"的键名（FOR-38 要求的内容判定）。
COOKIE_CONTENT_RE = re.compile(
    r"(?i)[\"']?\b(SESSDATA|bili_jct|bili_jti|bili_uid|dede_?userid|buvid[34]|"
    r"access_key|ctoken|cookies?|sid_[a-z]{0,4}|lsid)\b[\"']?\s*[:=]"
)


def detect_credential_keys(text: str) -> List[str]:
    """Return the credential/cookie key names actually present in *text*."""
    if not text:
        return []
    found: List[str] = []
    for m in COOKIE_CONTENT_RE.finditer(text):
        key = m.group(1)
        if key.lower() not in [k.lower() for k in found]:
            found.append(key)
    return found


def credential_error_message(name: str, keys: List[str], unreadable: bool = False) -> str:
    """Bilingual, actionable refusal message (FOR-38: 提示必须可理解、可执行）。"""
    if keys:
        zh = "拒绝加载 %s：文件内容里检测到登录凭据键 %s。" % (name, "、".join(keys))
        en = ("refusing to load %s: the file content contains credential keys (%s)."
              % (name, ", ".join(keys)))
    elif unreadable:
        zh = "拒绝加载 %s：这个文件名看起来像 cookie / 凭据文件，而内容又读不出来，无法确认安全。" % name
        en = ("refusing to load %s: the name looks like a cookie/credential file "
              "and the content could not be read, so it cannot be verified." % name)
    else:
        zh = "拒绝加载 %s：这个文件名看起来像 cookie / 凭据文件。" % name
        en = "refusing to load %s: it looks like a cookie/credential file." % name
    hint = ("怎么做：在浏览器里把「清洗后的关注列表 JSON」另存成 bili-follows.json"
            "（文件名里别带 cookie / session / auth / token），再运行 "
            "bili-clean bili-follows.json。\n"
            "Tip: re-save the cleaned follow-list export as bili-follows.json "
            "(keep cookie/session/auth/token out of the name), then run "
            "bili-clean bili-follows.json.")
    return "错误 error: %s\n%s\n%s" % (zh, en, hint)


def refuse_sensitive_path(path: str) -> None:
    """Content-first credential guard, shared by the CLI and the web report.

    判定顺序（FOR-38）：
      1. 能读到内容 -> 内容里有 cookie/凭据键才拒绝（并说明是哪个键）；
      2. 内容干净但名字可疑 -> 放行，只在 stderr 上提示改名（修掉中文用户误伤）；
      3. 读不到内容（文件不存在/无权限）-> 退回按名字判定，保持默认拒绝。
    """
    name = os.path.basename(str(path))
    text = _sniff(path)
    if text is not None:
        keys = detect_credential_keys(text)
        if keys:
            raise ValueError(credential_error_message(name, keys))
        if SENSITIVE_NAME_RE.search(name):
            _warn_name_only(name)
        return
    if SENSITIVE_NAME_RE.search(name):
        raise ValueError(credential_error_message(name, [], unreadable=True))


def _sniff(path: str):
    """Read a small prefix of *path* for the credential check, or None."""
    try:
        with open(str(path), "r", encoding="utf-8-sig", errors="replace") as fh:
            return fh.read(_SNIFF_BYTES)
    except (OSError, ValueError):
        return None


def _warn_name_only(name: str) -> None:
    sys.stderr.write(
        "warning: 文件名 %s 像是 cookie / 凭据文件，但内容里没有 cookie 键，"
        "已按普通导出加载。\n"
        "         建议改名成 bili-follows.json，避免和真正的凭据文件混淆。\n" % name)


def load_from_text(text: str) -> list:
    data = json.loads(text)
    return [FollowRecord.from_dict(d) for d in _to_list(data)]


def load_from_file(path: str) -> list:
    refuse_sensitive_path(path)
    # utf-8-sig：兼容记事本/Excel 另存为时带 BOM 的 JSON（中文用户常见）。
    with open(path, "r", encoding="utf-8-sig") as fh:
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
