"""取证脚本自己的输出编码钉（FOR-59）：Windows GBK 控制台下这条门禁不得假红。

实测复现（Windows 中文控制台，CEO 本机）：
    PYTHONIOENCODING=gbk PYTHONUTF8=0 python tools/probe_web_render.py
渲染层断言其实全部通过，但 print_report 打含 emoji 的昵称时炸出
UnicodeEncodeError: 'gbk' codec can't encode character '\U0001f600'，进程 exit=1
—— Windows 上这条门禁假红，本地复核会被误导；CI 只跑 ubuntu 抓不到这个环境。

这条测试不需要浏览器：它只调 print_report，走的是与 CLI / Web 同一份
bili.streams.harden_stdio() 兜底（FOR-38 已定型的口径，不留第二份实现）。
"""
import os
import pathlib
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLS = REPO_ROOT / "tools"

CALL_PRINT_REPORT = """
import sys

sys.path.insert(0, __TOOLS_DIR__)
import probe_web_render as probe

EMOJI_NICK = "\\U0001f600 阿婆主"
rows = [{"nickname": EMOJI_NICK, "class": "keep", "score": 0.82,
         "signals_used": "recency;authority", "last_seen_days": 3.14,
         "last_video_days": 7, "ratio": "1000 / 10", "reason": "长期不活跃 \\U0001f600"}]
tbody = ('<tr><td>' + EMOJI_NICK + '</td><td class="b-keep">保留</td>'
         '<td>0.82</td></tr>')
result = {"ok": True, "label": "fixture-gbk.json", "api_count": 1, "rows": rows,
          "dom_rows": [[EMOJI_NICK, "保留", "0.82"]], "tbody": tbody,
          "dom": "<tbody>" + tbody + "</tbody>"}
probe.print_report(result)
# 服务起不来的分支同样要打日志（日志里也可能带 emoji），同样不许崩。
probe.print_report({"ok": False, "label": "fixture-gbk.json",
                    "log": "bili.web 起不来：昵称 " + EMOJI_NICK + " 编码失败"})
print("[probe] DONE 两次 print_report 都没抛异常")
""".replace("__TOOLS_DIR__", repr(str(TOOLS)))


def _run_print_report(tmp_path, env_extra):
    script = tmp_path / "call_print_report.py"
    script.write_text(CALL_PRINT_REPORT, encoding="utf-8")
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.update(env_extra)
    return subprocess.run([sys.executable, str(script)], cwd=str(REPO_ROOT), env=env,
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=False)


def test_print_report_survives_a_gbk_console(tmp_path):
    """FOR-59 验收：GBK 控制台下 print_report 不抛 UnicodeEncodeError，退出码 0。"""
    proc = _run_print_report(tmp_path, {"PYTHONIOENCODING": "gbk", "PYTHONUTF8": "0"})
    assert "UnicodeEncodeError" not in proc.stderr, (
        "GBK 控制台下 print_report 又崩了：\n%s" % proc.stderr)
    assert proc.returncode == 0, "退出码 %s != 0（渲染断言本来是全过的）\n%s" % (
        proc.returncode, proc.stderr)
    # print_report 真的跑到了（不是被 import 失败空跑）
    assert "fixture-gbk.json" in proc.stdout, proc.stdout + proc.stderr
    assert "DONE" in proc.stdout, proc.stdout + proc.stderr


def test_print_report_survives_a_cp936_console(tmp_path):
    """同一件事换个别名：cp936（Windows 中文代码页）下也得活着。"""
    proc = _run_print_report(tmp_path, {"PYTHONIOENCODING": "cp936", "PYTHONUTF8": "0"})
    assert "UnicodeEncodeError" not in proc.stderr, proc.stderr
    assert proc.returncode == 0, proc.stderr


def test_probe_script_pins_the_stdio_hardening():
    """入口和 print_report 都要兜底：前者管 main() 自己的 print，后者管被直接调用。"""
    src = (TOOLS / "probe_web_render.py").read_text(encoding="utf-8")
    assert "harden_stdio" in src, "取证脚本又没兜 stdout 编码（FOR-59 回归）"
    assert src.count("harden_stdio()") >= 2, (
        "入口或 print_report 少了一处 harden_stdio()（FOR-59）")