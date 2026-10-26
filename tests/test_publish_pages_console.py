"""Pages 发布器自己的输出编码钉（FOR-66 缺陷登记 -> FOR-38 / FOR-59 同一份口径）。

实测复现（Windows 中文控制台，本机）：
    python tools/publish_pages.py
输出走管道时 sys.stdout.encoding == gbk（cp936），于是"缺影片 …""组装 / 发布 / 验证
Pages 落地页"这类中文提示被打成 cp936 字节；调用方（CI 日志、agent 取证、
重定向到文件）按 UTF-8 读就是整段花屏——取证文字本身不可信。
CI 只跑 ubuntu + UTF-8，抓不到这个环境，所以把它钉成测试。

修法沿用 FOR-38 已定型的 bili.streams.harden_stdio()，不留第二份实现。
这几条不需要影片、不需要浏览器、也不需要网络。
"""
import os
import pathlib
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / "tools" / "publish_pages.py"


def _run(args, env_extra):
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.update(env_extra)
    return subprocess.run([sys.executable, str(TOOL)] + args, cwd=str(REPO_ROOT),
                          env=env, capture_output=True, check=False)


def _console_env(encoding):
    return {"PYTHONIOENCODING": encoding, "PYTHONUTF8": "0"}


def test_missing_film_hint_is_readable_utf8_on_a_gbk_console():
    """FOR-66 验收：GBK 控制台下缺影片的中文提示必须是 UTF-8 字节，不是花屏。"""
    proc = _run([], _console_env("gbk"))
    assert proc.returncode == 1, "缺影片应当退 1：%s" % proc.stderr[:400]
    err = proc.stderr.decode("utf-8", "replace")
    assert "UnicodeEncodeError" not in err, err
    # 断言落在字节上：能按 UTF-8 解出这几个字，才说明没退回 cp936。
    assert "缺影片".encode("utf-8") in proc.stderr, repr(proc.stderr[:400])
    assert " bili-clean-promo.mp4" in err, err


def test_help_text_is_readable_utf8_on_a_cp936_console():
    """cp936（Windows 中文代码页）别名同样要活着：argparse 的中文帮助也走 UTF-8。"""
    proc = _run(["--help"], _console_env("cp936"))
    assert proc.returncode == 0, proc.stderr[:400]
    assert "落地页".encode("utf-8") in proc.stdout, repr(proc.stdout[:400])
    assert "线上取证".encode("utf-8") in proc.stdout, repr(proc.stdout[:400])


def test_publish_pages_pins_the_stdio_hardening():
    """入口和 check_url 都要兜底：前者管 main() 自己的 print，后者管被直接 import 调用。"""
    src = TOOL.read_text(encoding="utf-8")
    assert "from bili.streams import harden_stdio" in src, (
        "tools/publish_pages.py 又没兜 stdout 编码（FOR-66 回归）")
    assert src.count("harden_stdio()") >= 2, (
        "入口或 check_url 少了一处 harden_stdio()（FOR-66）")
