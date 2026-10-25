# Bili Clean Follow  (B站关注列表清理工具)
> **English / 中文** — currently English; [Switch to 中文](README.md).
> **Local only**: your cookies and API keys are never uploaded to any service.

An open-source tool that analyzes your Bilibili follow list and classifies each
follow into **keep / review / remove** with explainable reasons — so you can
clean up stale, inactive, or low-value follows with confidence.

> 🎬 **Two ~60-second films** (1080p, with audio): [product intro](https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.2/bili-clean-promo.mp4) · [walkthrough](https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.2/bili-clean-walkthrough.mp4)

## Why
You may have a few hundred (or thousand) Bilibili follows, many of which you
no longer remember following. Manually going through them is painful. This tool
scores each follow for "worth keeping" and hands you a short list of candidates
to unfollow.

## Features
- **Report-only and safe by default**: it never calls the unfollow API and never
  touches your account.
- **Explainable**: every decision carries a numeric score and a reason string.
- **Exports** **Markdown** (for humans) and **CSV** (for spreadsheets), plus an
  optional "unfollow list": one row per candidate, `mid <TAB> nickname`.
- **Safe on Chinese Windows**: emoji nicknames no longer crash a GBK console,
  and CSV / unfollow-list files are utf-8-sig so Excel shows Chinese correctly.
- **Companion tool `bili-merge`**: writes a signals.csv template with mid +
  nickname already filled in, so you only type four numbers; fully offline.
- **Missing data means unknown, not worst-case**: the score is normalized over the signals you actually provided, then two gates apply - no recency signal means never REMOVE (gate A), a bio-only record means never KEEP (gate B). Those rows land in review for you to confirm.
- **Missing signals are called out**: every row exports `signals_used` and `missing_signals` (complementary lists of signal names joined by `;`; the CSV stores the names, the Markdown and web reports render 未知 when nothing is known), and when at least half of the rows lack recency the Markdown and web reports show an explicit warning telling you to fill the signals with `bili-merge` first.
- **Real exports load as-is**: a `"code":0,"data":{"follower":[…]}` or `data.list` response copied out of the browser is unwrapped automatically, nicknames come from `name` / `uname`, and official certification is read from `official.role/title/department` and `official_verify.type` - no hand-editing of the JSON.
- **BOM-safe input**: an export saved by Windows Notepad or Excel (UTF-8 BOM) loads
  without the confusing "Unexpected UTF-8 BOM" error.
- **No committed credentials**; works from a user-provided JSON export.

## Quick start

Prerequisite: Python 3.9+ (CI covers 3.9-3.13 plus a Windows GBK smoke job and a real-chromium DOM gate for the web report; verified locally on 3.13.15, 248 tests green).
The commands below work the same on Windows, macOS and Linux. A clean virtual environment
is recommended.

**Step 1 - install first (required, pick one)**

The package uses a src/ layout, so running the CLI before installing fails with
ModuleNotFoundError: No module named 'bili'.

Option A - install the release zip (no clone needed):

```
pip install https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.3/bili-clean-follow-0.1.3.zip
```

Option B - clone, then install:

```
git clone https://github.com/Yu-Xiao-Sheng/bili-clean-follow.git
cd bili-clean-follow
pip install -e .
```

Sanity check: `bili-clean --version` prints `bili-clean 0.1.3`.

**Step 2 - run the built-in sample**

```
python -m bili.demo
bili-clean sample-follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

The sample data is fixed, so the expected output is `Summary: keep=13 review=2 remove=9`
(24 follows, 9 unfollow candidates). Read report.md for the per-item reasons, then handle
to-unfollow.txt yourself.

**Step 3 - use your own export**

```
bili-clean follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

How to produce follows.json: see [docs/getting-started.md](docs/getting-started.md).

**Step 4 - fill in the missing signals (optional, decides whether REMOVE is trustworthy)**

A raw export only carries nickname + bio; recency and follower/following counts
are missing, so the report can only rank the list. The bundled `bili-merge`
closes that gap offline (no network, no API calls):

```
bili-merge follows.json --template signals.csv     # template, mid + nickname prefilled
# type the four numbers per row in Excel / WPS (blank = unknown)
bili-merge follows.json --signals signals.csv      # -> follows.merged.json
bili-clean follows.merged.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

An empty cell means unknown - unknown is never used as a reason to unfollow, so
those rows stay in review. Without the installed console script run
`PYTHONPATH=src python -m bili.merge_cli`.

**Step 5 - optional local web report**

```
python -m bili.web --input sample-follows.json
```

Open http://127.0.0.1:8787 (bound to 127.0.0.1 only, read-only; the page header shows
`bili-clean-follow v0.1.3 · 本地只读 · 数据不出本机`).

## Getting a real input
Bilibili's public follow-list endpoint does not expose per-follow "last active"
timestamps, so the tool works from a **normalized JSON export**. See
[docs/getting-started.md](docs/getting-started.md) for the safest ways to
produce it.

## How scoring works
Three weighted signals (see [docs/scoring-model.md](docs/scoring-model.md)):
- **recency (0.45)** — how recently you saw them / they posted.
- **authority (0.30)** — follower/following ratio (niche-quality proxy).
- **relevance (0.25)** — bio quality + official/verified marker.

Thresholds: score >= 0.70 -> keep, >= 0.40 -> review, else remove.

The score is a weighted average over the **provided** signals only: `score = sum(w_k*p_k) / sum(w_k)` (since v0.1.2, FOR-36). Two gates apply: **no recency signal -> never REMOVE** (unknown is not evidence to unfollow) and **keep requires recency or authority**. See [docs/scoring-model.md](docs/scoring-model.md).

## Project layout

```
src/bili/        # package: model, loaders, score, export, cli, demo
tests/           # pytest suite
docs/            # spec.md, getting-started.md, scoring-model.md
.github/         # CI workflow
pyproject.toml
```

## Optional local web report

If you prefer a visual report over terminal output or files, start the local
report UI (default: listen on 127.0.0.1 only, read-only):

```
python -m bili.demo                            # create sample-follows.json
python -m bili.web --input sample-follows.json
```

Open http://127.0.0.1:8787 to see:
- summary cards: total follows plus the count and share of keep/review/remove;
- a filterable (class tabs) and sortable classification table: click a header to sort by that
  column, click again to flip the direction, the active column shows an up/down caret;
  得分 / last-seen / last-video sort numerically (20 before 100), and a link can seed the sort,
  e.g. `http://127.0.0.1:8787/?sort=last_seen_days&dir=asc`;
- removal-candidate preview: export the unfollow list (.txt) after confirming each item;
- one-click Markdown / CSV export.

Everything stays on this machine: the tool never calls an unfollow API,
and it never connects to any external service.

## Safety note
This tool reports only. It does **not** unfollow, does **not** upload your data,
and stores nothing. Review the report before acting on any follow.

## License
MIT.
