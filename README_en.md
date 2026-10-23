# Bili Clean Follow  (B站关注列表清理工具)
> **English / 中文** — currently English; [Switch to 中文](README.md).
> **Local only**: your cookies and API keys are never uploaded to any service.

An open-source tool that analyzes your Bilibili follow list and classifies each
follow into **keep / review / remove** with explainable reasons — so you can
clean up stale, inactive, or low-value follows with confidence.

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
  optional "unfollow list" of candidate ids.
- **Neutral on missing data** — a follow with no signals is never auto-kept.
- **No committed credentials**; works from a user-provided JSON export.

## Quick start

Prerequisite: Python 3.9+ (CI covers 3.9-3.13; verified locally on 3.13.15, 63 tests green).
The commands below work the same on Windows, macOS and Linux. A clean virtual environment
is recommended.

**Step 1 - install first (required, pick one)**

The package uses a src/ layout, so running the CLI before installing fails with
ModuleNotFoundError: No module named 'bili'.

Option A - install the release zip (no clone needed):

```
pip install https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.1/bili-clean-follow-0.1.1.zip
```

Option B - clone, then install:

```
git clone https://github.com/Yu-Xiao-Sheng/bili-clean-follow.git
cd bili-clean-follow
pip install -e .
```

Sanity check: `bili-clean --version` prints `bili-clean 0.1.1`.

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

**Step 4 - optional local web report**

```
python -m bili.web --input sample-follows.json
```

Open http://127.0.0.1:8787 (bound to 127.0.0.1 only, read-only; the page header shows
`bili-clean-follow v0.1.1 · 本地只读 · 数据不出本机`).

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
- a filterable (class tabs) and sortable classification table;
- removal-candidate preview: export the unfollow list (.txt) after confirming each item;
- one-click Markdown / CSV export.

Everything stays on this machine: the tool never calls an unfollow API,
and it never connects to any external service.

## Safety note
This tool reports only. It does **not** unfollow, does **not** upload your data,
and stores nothing. Review the report before acting on any follow.

## License
MIT.
