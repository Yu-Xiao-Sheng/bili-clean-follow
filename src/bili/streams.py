"""让 stdout/stderr 在 Windows 中文控制台（GBK/cp936）下不会炸（FOR-38）。

实测：Windows 中文环境里一旦输出走管道/重定向，sys.stdout.encoding == gbk，
一条含 emoji 的真实昵称（B 站很常见）就能让 bili-clean 直接
UnicodeEncodeError 崩栈、整份报告丢失。

这里在每个入口（CLI / Web / demo）统一把 stdout、stderr 重设为
UTF-8 + errors="replace"，再兜一层永不抛编码异常的 writer。
"""

from __future__ import annotations

import io
import sys

FALLBACK_ENCODING = "utf-8"


class _SafeTextWriter:
    """Thin proxy that degrades un-encodable characters instead of raising."""

    def __init__(self, stream):
        self._stream = stream

    def write(self, text):
        try:
            return self._stream.write(text)
        except UnicodeEncodeError:
            return self._stream.write(_sanitize(text, self._stream))

    def writelines(self, lines):
        for line in lines:
            self.write(line)

    def flush(self):
        try:
            self._stream.flush()
        except Exception:
            pass

    def isatty(self):
        try:
            return self._stream.isatty()
        except Exception:
            return False

    def __getattr__(self, item):
        return getattr(self._stream, item)


def _sanitize(text: str, stream=None) -> str:
    enc = getattr(stream, "encoding", None) or FALLBACK_ENCODING
    return text.encode(enc, "replace").decode(enc, "replace")


def harden_stdio() -> None:
    """Force UTF-8 on stdout/stderr; fall back to a never-raising proxy."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None or isinstance(stream, _SafeTextWriter):
            continue
        try:
            stream.reconfigure(encoding=FALLBACK_ENCODING, errors="replace")
        except (AttributeError, ValueError, OSError, LookupError):
            setattr(sys, name, _SafeTextWriter(stream))


def safe_write(text: str, stream=None) -> None:
    """Write text, degrading instead of crashing if the stream refuses it."""
    stream = sys.stdout if stream is None else stream
    try:
        stream.write(text)
        return
    except UnicodeEncodeError:
        pass
    buf = getattr(stream, "buffer", None)
    if buf is not None:
        buf.write(text.encode(FALLBACK_ENCODING, "replace"))
        try:
            stream.flush()
        except Exception:
            pass
    else:
        stream.write(_sanitize(text, stream))
