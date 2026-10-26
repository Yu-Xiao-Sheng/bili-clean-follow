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
TOOLS = REPO_ROOT / "tools"


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


# ---- check_url 的取证输出：坏法要落成 FAIL 行，不能把 urllib 的栈糊进日志 ----

CALL_CHECK_URL = """
import sys
sys.path.insert(0, __TOOLS_DIR__)
import publish_pages as pp

out_dir = __OUT_DIR__
import pathlib
out_dir = pathlib.Path(out_dir)
httpd = pp.start_server(out_dir, int(__PORT__))
import threading
threading.Thread(target=httpd.serve_forever, daemon=True).start()
rc = pp.check_url(__BASE_URL__)
httpd.shutdown()
print("RC=%d" % rc)
""".replace("__TOOLS_DIR__", repr(str(TOOLS)))


def _call_check_url(tmp_path, base_url, port):
    script = tmp_path / "call_check_url.py"
    script.write_text(CALL_CHECK_URL.replace("__OUT_DIR__", repr(str(tmp_path)))
                      .replace("__PORT__", repr(str(port)))
                      .replace("__BASE_URL__", repr(base_url)), encoding="utf-8")
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    return subprocess.run([sys.executable, str(script)], cwd=str(REPO_ROOT), env=env,
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=False)


def test_a_404_landing_page_is_reported_not_raised(tmp_path):
    """Pages 开关没开 / 部署失败 => FAIL 行 + 退出码 1，不是 urllib 的栈。

    FOR-66 的 C 轨上线取证与 .github/workflows/pages.yml 部署后的 --check-url 都要读
    这份输出；上一版这里直接 HTTPError 崩栈，人会以为工具坏了而不是"页没上线"。
    """
    (tmp_path / "index.html").write_text("<html>空壳，没有 video</html>", encoding="utf-8")
    proc = _call_check_url(tmp_path, "http://127.0.0.1:8791/nope/", 8791)
    assert "Traceback" not in proc.stdout + proc.stderr, proc.stdout + proc.stderr
    out = proc.stdout
    assert "index.html HTTP 404" in out, out + proc.stderr
    for _, name in [("promo", "bili-clean-promo.mp4"), ("walk", "bili-clean-walkthrough.mp4")]:
        assert ("%s HTTP 404" % name) in out, out
    assert "RC=1" in out, out + proc.stderr


def test_a_streamable_local_build_still_passes_the_check(tmp_path):
    """正向对照：可流式的本地产物必须放行（否则这条门禁是"一律红"的摆设）。"""
    (tmp_path / "index.html").write_text(
        '<video controls preload="metadata" poster="p.jpg" src="bili-clean-promo.mp4"></video>',
        encoding="utf-8")
    for _, name in [("promo", "bili-clean-promo.mp4"), ("walk", "bili-clean-walkthrough.mp4")]:
        (tmp_path / name).write_bytes(b"\x00" * 2048)
    proc = _call_check_url(tmp_path, "http://127.0.0.1:8792/", 8792)
    out = proc.stdout
    assert "RC=0" in out, out + proc.stderr
    assert "可流式播放" in out, out
