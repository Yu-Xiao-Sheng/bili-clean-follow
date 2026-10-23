"""FOR-38：中文控制台（GBK/cp936）下的输出安全。

Windows 中文环境里 sys.stdout.encoding 常常是 gbk，一条含 emoji 的真实昵称
（B 站很常见）就能让报告崩在 sys.stdout.write，整份输出丢失。CLI / Web / demo
都走 bili.streams 这一套：入口 reconfigure，写入再兜一层。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"

sys.path.insert(0, str(SRC))

from bili import web
from bili.streams import _SafeTextWriter, harden_stdio, safe_write

EMOJI_NAME = "头条小哥🔥"


def _run(args, env, cwd=None):
    full = dict(os.environ)
    full["PYTHONPATH"] = str(SRC)
    full.update(env)
    return subprocess.run(
        [sys.executable, *args], cwd=str(cwd or REPO_ROOT), env=full,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        check=False)


def test_harden_stdio_prints_emoji_under_gbk():
    code = ("import sys; from bili.streams import harden_stdio; harden_stdio(); "
            "sys.stdout.write('%s'); sys.stderr.write('取关清单🔥')") % EMOJI_NAME
    out = _run(["-c", code], {"PYTHONIOENCODING": "gbk"})
    assert out.returncode == 0, out.stderr
    assert "Traceback" not in out.stderr
    assert EMOJI_NAME in out.stdout
    assert "取关清单" in out.stderr


def test_web_render_and_report_under_gbk(tmp_path):
    payload = [{"follower_id": "22965610", "mid": "22965610", "nickname": EMOJI_NAME,
                "bio": "热点资讯 · 现场直击", "last_seen_days": 3.0,
                "follower_count": 120000, "following_count": 60}]
    src = tmp_path / "follows.json"
    src.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    code = ("import sys; from bili.streams import harden_stdio; harden_stdio();"
            "from bili import web; rs = web.load_report(sys.argv[1]);"
            "s = web.summarize(rs); print(s['counts'], file=sys.stderr);"
            "sys.stdout.write(web.build_page_html(rs, s))")
    out = _run(["-c", code, str(src)], {"PYTHONIOENCODING": "gbk"}, cwd=tmp_path)
    assert out.returncode == 0, out.stderr
    assert "Traceback" not in out.stderr
    assert EMOJI_NAME in out.stdout
    assert "mid + Tab + 昵称" in out.stdout  # 页面把导出说明写清楚了


def test_page_html_survives_emoji_nickname_in_process():
    results = [{"follower_id": "1", "mid": "1", "nickname": EMOJI_NAME, "bio": "",
                "class": "review", "score": 0.5, "reason": ["recency: unknown"],
                "last_seen_days": None, "last_video_days": None,
                "follower_count": None, "following_count": None}]
    html = web.build_page_html(results, web.summarize(results))
    html.encode("utf-8")
    assert EMOJI_NAME in html


def test_safe_writer_proxy_degrades_instead_of_raising():
    class AsciiOnly:
        encoding = "ascii"

        def write(self, text):
            if not text.isascii():
                raise UnicodeEncodeError("ascii", text, 0, 1, "unencodable")
            return len(text)

        def flush(self):
            pass

    proxy = _SafeTextWriter(AsciiOnly())
    proxy.write("取关清单🔥")  # 不能再抛 UnicodeEncodeError
    assert proxy.isatty() is False


def test_harden_stdio_is_idempotent(capsys):
    harden_stdio()
    harden_stdio()
    safe_write("取关清单🔥\n")
    assert "取关清单" in capsys.readouterr().out