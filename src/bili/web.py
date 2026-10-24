"""Local read-only web report for bili-clean-follow (FOR-27).

Start:
    python -m bili.demo                          # 生成 sample-follows.json
    python -m bili.web --input sample-follows.json
    # 打开 http://127.0.0.1:8787

设计要点（FOR-27 设计简报）：
  * 顶部摘要卡：总关注数 + keep/review/remove 数量与占比；
  * 分类表格：昵称/分类/得分/最近活跃/最新视频/粉丝比/原因，
    keep 绿、review 橙、remove 红，可筛选、可排序；
  * 一键导出 Markdown / CSV（复用 CLI 的 export 逻辑）；
  * 删除候选预览 + 两次确认：导出按钮默认禁用，
    勾选确认后启用，服务端也要求 confirm=1；
  * 安全：默认仅绑定 127.0.0.1，只读，无外网、无上传，
    日志不落任何记录字段；拒绝加载 cookie/凭据类文件名。
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import __version__
from .export import (CSV_ENCODING, run, signal_warning, to_csv, to_markdown,
                     to_unfollow_list)
from .streams import harden_stdio
from .loaders import SENSITIVE_NAME_RE, load_from_file, refuse_sensitive_path  # noqa: F401

DEFAULT_PORT = 8787


def load_report(input_path: str) -> list:
    """Load a cleaned JSON export and classify it. Returns raw result dicts."""
    refuse_sensitive_path(input_path)
    records = load_from_file(input_path)
    if not records:
        raise ValueError("no follows found in %r" % input_path)
    return run(records)


def summarize(results: list) -> dict:
    total = len(results)
    counts = {"keep": 0, "review": 0, "remove": 0}
    for r in results:
        cls = r.get("class", "review")
        if cls in counts:
            counts[cls] += 1
    pct = {k: (counts[k] / total * 100.0) if total else 0.0 for k in counts}
    return {"total": total, "counts": counts, "pct": pct}


def _display_rows(results: list) -> list:
    """Raw classification results -> lightweight table rows.

    Intentionally drops bio and any extra fields: the page only ever shows
    nicknames, scores and class labels - never raw export content.
    """
    rows = []
    for r in results:
        ratio = ""
        if r.get("follower_count") is not None and r.get("following_count") is not None:
            ratio = "%d / %d" % (r["follower_count"], r["following_count"])
        reasons = (r.get("reason") or [])[:4]
        rows.append({
            "follower_id": str(r.get("follower_id", "")),
            "nickname": str(r.get("nickname", "")),
            "class": str(r.get("class", "review")),
            "score": r.get("score", 0),
            # FOR-36: 每行露出用了几个信号（0-3）。
            "signals_used": r.get("signals_used", 0),
            "last_seen_days": r.get("last_seen_days"),
            "last_video_days": r.get("last_video_days"),
            "ratio": ratio,
            "reason": " · ".join(str(x) for x in reasons),
        })
    return rows

PAGE_HEAD = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>B站关注分类报告 · bili-clean-follow</title>
<style>
:root{
  --keep:#3ecf8a; --review:#f0a35a; --remove:#e2605b;
  --bg:#0f1216; --card:#171d24; --line:#26303b;
  --text:#e6edf3; --muted:#7f8c99;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
  font-size:14px;line-height:1.55}
.wrap{max-width:1100px;margin:0 auto;padding:18px 18px 40px}
h1{margin:0 0 4px;font-size:22px}
.sub{color:var(--muted);font-size:13px;margin:0 0 12px}
.btn{display:inline-block;border:1px solid var(--line);background:#1a222c;color:var(--text);
  border-radius:8px;padding:8px 14px;text-decoration:none;font-size:13px;font-weight:600}
.btn:hover{border-color:#3b5068;background:#1e2834}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:12px 16px;min-width:138px}
.card .num{font-size:26px;font-weight:700;line-height:1}
.card .lab{color:var(--muted);font-size:12px;margin-top:6px}
.card.keep .num{color:var(--keep)}
.card.review .num{color:var(--review)}
.card.remove .num{color:var(--remove)}
.card.total{background:#131b24;border-color:#2e4254}
.tabs{display:flex;gap:8px;margin:4px 0 14px;flex-wrap:wrap}
.tab{border:1px solid var(--line);background:transparent;color:var(--muted);
  border-radius:999px;padding:6px 14px;cursor:pointer;font-size:13px}
.tab.active{background:#2a3a49;color:var(--text);border-color:#3b5267;font-weight:600}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid var(--line);padding:9px 8px;text-align:left;word-break:break-word}
th{color:var(--muted);font-weight:600;cursor:pointer;user-select:none;background:#121a21}
th:hover{color:var(--text)}
td{vertical-align:top}
.badge{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600}
.b-keep{color:var(--keep);border:1px solid var(--keep)}
.b-review{color:var(--review);border:1px solid var(--review)}
.b-remove{color:var(--remove);border:1px solid var(--remove)}
.reason{color:var(--muted);font-size:12px}
.empty{color:var(--muted);text-align:center;padding:20px}
.remove-panel{background:var(--card);border:1px solid var(--remove);
  border-radius:10px;padding:14px 16px;margin-top:22px}
.remove-panel h2{margin:0 0 8px;color:var(--remove);font-size:16px}
.remove-panel ul{margin:6px 0 12px;padding-left:18px}
.remove-panel li{margin:4px 0}
.code{color:var(--muted);background:#10161c;padding:1px 5px;border-radius:5px;
  font-family:Consolas,Monaco,monospace;font-size:12px}
.confirm-row{display:flex;align-items:center;gap:8px;cursor:pointer;margin:10px 0 8px}
.confirm-row input{cursor:pointer}
.hint{color:var(--muted);font-size:12px;margin-top:6px}
.warn{background:#2a1f16;border:1px solid var(--review);color:var(--review);
  border-radius:10px;padding:10px 14px;margin:0 0 14px;font-size:13px}
.hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>B站关注分类报告</h1>
  <p class="sub">bili-clean-follow v__VER__ · 本地只读 · 数据不出本机</p>
  <a class="btn" href="/export?fmt=md" download="bili-clean-report.md">导出 Markdown</a>
  <a class="btn" href="/export?fmt=csv" download="bili-clean-report.csv">导出 CSV（Excel 可直接打开）</a>
</header>
__WARNING_HTML__
<section class="cards">
  <div class="card total">
    <div class="num" id="c-total"></div>
    <div class="lab">总关注数</div>
  </div>
  <div class="card keep">
    <div class="num" id="c-keep"></div>
    <div class="lab">保留 keep · <span id="p-keep"></span></div>
  </div>
  <div class="card review">
    <div class="num" id="c-review"></div>
    <div class="lab">需审视 review · <span id="p-review"></span></div>
  </div>
  <div class="card remove">
    <div class="num" id="c-remove"></div>
    <div class="lab">删除候选 remove · <span id="p-remove"></span></div>
  </div>
</section>
<nav class="tabs" id="tabs">
  <button class="tab active" data-cls="all">全部</button>
  <button class="tab" data-cls="keep">保留 <span class="t-keep"></span></button>
  <button class="tab" data-cls="review">需审视 <span class="t-review"></span></button>
  <button class="tab" data-cls="remove">删除候选 <span class="t-remove"></span></button>
</nav>
<main>
<table id="report">
  <thead id="thead"></thead>
  <tbody id="tbody"></tbody>
</table>
</main>
"""

PAGE_TAIL = """<section class="remove-panel">
  <h2>删除候选 <span id="remove-count"></span></h2>
  <ul id="remove-list"></ul>
  <p class="empty hidden" id="no-remove">暂无删除候选，当前关注列表状态良好。</p>
  <label class="confirm-row">
    <input type="checkbox" id="confirm-box">
    <span>我已逐一审核以上待删除项，确认无误</span>
  </label>
  <a class="btn" id="export-unfollow" href="/unfollow?confirm=1"
     download="unfollow-list.txt" disabled>导出取关清单 (.txt · mid + 昵称)</a>
  <p class="hint">导出后仍需你在 B站 手动取关；本工具从不调用 unfollow API，
     也不会将你的 cookie / 密钥上传到任何服务。</p>
  <p class="hint">取关清单每行是 mid + Tab + 昵称，可先在 B站 关注页按昵称搜索核对；
     CSV 带 UTF-8 BOM，Excel / WPS 双击打开不会乱码。</p>
</section>
</div>
<script type="application/json" id="bili-summary">__SUMMARY_JSON__</script>
<script type="application/json" id="bili-data">__DATA_JSON__</script>
<script>
(function(){
  var SUMMARY = JSON.parse(document.getElementById('bili-summary').textContent);
  var DATA = JSON.parse(document.getElementById('bili-data').textContent);
  var esc = function(s){
    return (s==null ? '' : String(s)).replace(/&/g,'&amp;')
      .replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  };
  function fmtNum(v){
    if(v==null || v===''){ return '\u2014'; }
    v = Number(v);
    if(isNaN(v)){ return esc(String(v)); }
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
  var COLS = [
    {key:'nickname', label:'昵称', sort:'str'},
    {key:'class', label:'分类', sort:'str'},
    {key:'score', label:'得分', sort:'num'},
    {key:'signals_used', label:'信号数', sort:'num'},
    {key:'last_seen_days', label:'最近活跃(天)', sort:'num'},
    {key:'last_video_days', label:'最新视频(天)', sort:'num'},
    {key:'ratio', label:'粉丝/关注', sort:'str'},
    {key:'reason', label:'原因', sort:'str'},
  ];
  var state = {cls:'all', key:'score', dir:-1};

  document.getElementById('c-total').textContent = SUMMARY.total;
  ['keep','review','remove'].forEach(function(c){
    document.getElementById('c-'+c).textContent = (SUMMARY.counts[c]||0);
    document.getElementById('p-'+c).textContent = Math.round(SUMMARY.pct[c]||0)+'%';
    var t = document.querySelector('.t-'+c);
    if(t){ t.textContent = (SUMMARY.counts[c]||0)+''; }
  });

  function badge(c){
    return '<span class="b-'+c+'>'+esc(c)+'</span>';
  }
  function visible(){
    var rs = DATA.slice();
    if(state.cls !== 'all'){
      rs = rs.filter(function(r){ return r['class']===state.cls; });
    }
    rs.sort(function(a,b){
      var x = a[state.key], y = b[state.key];
      if(x==null && y==null) return 0;
      if(x==null) return 1;
      if(y==null) return -1;
      var d = (state.sort==='num')
        ? (Number(x)-Number(y))
        : String(x).localeCompare(String(y));
      return d * state.dir;
    });
    return rs;
  }
  function render(){
    var thead = document.getElementById('thead');
    var html = '';
    COLS.forEach(function(c){
      html += '<th data-key="'+esc(c.key)+'">'+esc(c.label)+'</th>';
    });
    thead.innerHTML = html;
    Array.prototype.forEach.call(thead.querySelectorAll('th'), function(th){
      th.addEventListener('click', function(){
        var k = th.getAttribute('data-key');
        if(state.key === k){ state.dir = -state.dir; }
        else { state.key = k; state.dir = -1; }
        render();
      });
    });
    var rs = visible();
    var body = document.getElementById('tbody');
    body.innerHTML = rs.map(function(r){
      var cells = COLS.map(function(c){
        if(c.key==='class'){ return '<td>'+badge(r['class'])+'</td>'; }
        if(c.key==='reason'){
          return '<td class="reason">'+esc(String(r['reason']||'').slice(0,160))+'</td>';
        }
        return '<td>'+fmtNum(r[c.key])+'</td>';
      }).join('');
      return '<tr class="'+esc(r['class'])+'">'+cells+'</tr>';
    }).join('')
    || '<tr><td colspan="'+COLS.length+'" class="empty">当前筛选下没有数据。</td></tr>';
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function(tab){
    tab.addEventListener('click', function(){
      state.cls = tab.getAttribute('data-cls');
      Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'),
        function(o){ o.classList.toggle('active', o===tab); });
      render();
    });
  });
  render();

  var removes = DATA.filter(function(r){ return r['class']==='remove'; });
  document.getElementById('remove-count').textContent = '（'+removes.length+' 项）';
  var ul = document.getElementById('remove-list');
  ul.innerHTML = removes.map(function(r){
    return '<li><b>'+esc(r['nickname'])+'</b> <span class="code">'+esc(r['follower_id'])
         +'</span> 得分 '+fmtNum(r['score'])
         +' · '+esc(String(r['reason']||'').slice(0,80))+'</li>';
  }).join('');
  if(removes.length===0){
    ul.style.display='none';
    document.getElementById('no-remove').classList.remove('hidden');
  }
  var box = document.getElementById('confirm-box');
  var btn = document.getElementById('export-unfollow');
  function update(){ btn.disabled = !(box.checked && removes.length); }
  box.addEventListener('change', update);
  update();
})();
</script>
</body>
</html>
"""

def _html_escape(text) -> str:
    s = str(text or "")
    return (s.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def warning_html(results: list) -> str:
    """FOR-36: 缺信号警告横幅（无需警告时为空串）。"""
    warning = signal_warning(results)
    if not warning:
        return ""
    return '<p class="warn">%s</p>' % _html_escape(warning)


def build_page_html(results: list, summary: dict, version: str = None) -> str:
    """Render the single page report with the results embedded (ASCII-safe)."""
    if version is None:
        version = __version__
    rows = _display_rows(results)
    data_json = json.dumps(rows, ensure_ascii=False)
    data_json = data_json.replace("</script>", "<\\/script>")
    summary_json = json.dumps(summary, ensure_ascii=False)
    summary_json = summary_json.replace("</script>", "<\\/script>")
    page = PAGE_HEAD + PAGE_TAIL
    return (page
            .replace("__VER__", str(version))
            .replace("__WARNING_HTML__", warning_html(results))
            .replace("__SUMMARY_JSON__", summary_json)
            .replace("__DATA_JSON__", data_json))


class WebHandler(BaseHTTPRequestHandler):
    """Serve the report on localhost only. Read-only, no upload, no writes."""

    results = []
    summary = {"total": 0, "counts": {}, "pct": {}}
    page_html = ""
    version = __version__

    def log_message(self, fmt, *args):
        # Never log record content; the request path never carries user data.
        sys.stderr.write("%s\n" % (fmt % args))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_attachment(self, status: int, body: bytes, filename: str,
                         ctype: str = "application/octet-stream") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _first(self, qs: dict, key: str) -> str:
        v = qs.get(key, [])
        return v[0] if v else ""

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        qs = parse_qs(u.query)
        if p == "/":
            body = self.page_html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif p == "/api/health":
            self._send_json(200, {"ok": True, "version": self.version})
        elif p == "/api/summary":
            self._send_json(200, self.summary)
        elif p == "/api/results":
            want = self._first(qs, "cls")
            rows = self.results if not want else \
                [r for r in self.results if r.get("class") == want]
            self._send_json(200, {"count": len(rows), "rows": rows})
        elif p == "/export":
            fmt = self._first(qs, "fmt")
            if fmt == "md":
                self._send_attachment(
                    200, to_markdown(self.results).encode("utf-8"),
                    "bili-clean-report.md", "text/markdown; charset=utf-8")
            elif fmt == "csv":
                self._send_attachment(
                    200, to_csv(self.results).encode(CSV_ENCODING),
                    "bili-clean-report.csv", "text/csv; charset=utf-8")
            else:
                self._send_json(400, {"error": "fmt must be md or csv"})
        elif p == "/unfollow":
            if self._first(qs, "confirm") != "1":
                self._send_json(400, {
                    "error": "confirmation required: tick the confirmation "
                    "checkbox and request this page again"})
                return
            # FOR-38: 与 CLI 共用同一份清单（mid + Tab + 昵称 + 人工核对抬头），
            # 并用 utf-8-sig，记事本/Excel 打开不乱码。
            body = to_unfollow_list(self.results).encode(CSV_ENCODING)
            self._send_attachment(
                200, body, "unfollow-list.txt", "text/plain; charset=utf-8")
        else:
            self._send_json(404, {"error": "not found"})


def build_server(results: list, host: str = "127.0.0.1", port: int = 0):
    """Create a threaded server bound to localhost (default)."""
    summary = summarize(results)
    WebHandler.results = results
    WebHandler.summary = summary
    WebHandler.page_html = build_page_html(results, summary)
    srv = ThreadingHTTPServer((host, port), WebHandler)
    return srv
def main(argv: list = None) -> int:
    # FOR-38: Windows 中文控制台默认 GBK，中文 / emoji 日志不能炸栈。
    harden_stdio()
    parser = argparse.ArgumentParser(
        prog="bili.web",
        description="Serve a local read-only web report of the follow cleanup.")
    parser.add_argument("--input", default="follows.json",
                        help="cleaned follows JSON file (never a cookie file)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1",
                        help="bind host (default 127.0.0.1 only; "
                             "0.0.0.0 is for trusted networks, at your own risk)")
    args = parser.parse_args(argv)

    try:
        results = load_report(args.input)
    except Exception as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2

    summary = summarize(results)
    print("bili-clean web report v%s - read-only, localhost only" % __version__,
          file=sys.stderr)
    print("  total=%d keep=%d review=%d remove=%d" % (
        summary["total"], summary["counts"].get("keep", 0),
        summary["counts"].get("review", 0), summary["counts"].get("remove", 0)),
          file=sys.stderr)
    print("  open http://%s:%s" % (args.host, args.port), file=sys.stderr)

    srv = build_server(results, host=args.host, port=args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())