# Bili Clean Follow  (B站关注列表清理工具)

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
```

python -m bili.demo          # writes sample-follows.json
bili-clean sample-follows.json --md report.md
```

Or with your own export:
```

bili-clean follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

Then open report.md and act on to-unfollow.txt manually.

## Getting a real input
Bilibili's public follow-list endpoint does not expose per-follow "last active"
timestamps, so the tool works from a **normalized JSON export**. See
[docs/getting-started.md](docs/getting-started.md) for the safest ways to
produce it.

## How scoring works
Three weighted signals (see [docs/spec.md](docs/spec.md)):
- **recency (0.45)** — how recently you saw them / they posted.
- **authority (0.30)** — follower/following ratio (niche-quality proxy).
- **relevance (0.25)** — bio quality + official/verified marker.

Thresholds: score >= 0.70 -> keep, >= 0.40 -> review, else remove.

## Project layout
```

src/bili/        # package: model, loaders, score, export, cli, demo
tests/           # pytest suite
docs/            # spec.md, getting-started.md
.github/         # CI workflow
pyproject.toml
```

## Safety note
This tool reports only. It does **not** unfollow, does **not** upload your data,
and stores nothing. Review the report before acting on any follow.

## License
MIT.
