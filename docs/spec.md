# Product Specification — Bili Clean Follow

## Goal
Help a Bilibili user review and clean up their follow list. The tool takes their
follow list, scores each follow for "worth keeping", and classifies each into
**keep / review / remove** with a human-readable reason. It exports a Markdown
and/or CSV report.

## Principles
1. **Safe by default.** The tool is report-only. It never calls the unfollow API,
   never stores credentials in committed code, and requires an explicit --unfollow-list
   flag to even write a list of candidate follow-ids.
2. **User-provided data.** Bilibili's public follow-list endpoint does not expose
   per-follow "last active" timestamps. We therefore work from a **normalized JSON
   export** that captures identity + optional signals. (See Getting Started for
   how to produce the input, including an optional browser-export approach.)
3. **Explainable.** Every record gets a numeric score and a reason string.
4. **Neutral on missing data.** A record with no available signals is never
   auto-kept; it falls to review/remove conservatively.

## Input data model
A JSON list of follow objects. Recognized fields:

| field            | type     | required | meaning                                  |
|------------------|----------|----------|------------------------------------------|
| follower_id      | string   | yes      | Unique id for the follow                  |
| nickname         | string   | yes      | Display name                              |
| bio              | string   | no       | Profile description                       |
| mid              | string   | no       | Bilibili mid (fallback id)                |
| last_seen_days   | number   | no       | Days since the user last saw this follow  |
| last_video_days  | number   | no       | Days since this follow last posted        |
| follower_count   | number   | no       | This follow's follower count              |
| following_count  | number   | no       | This follow's following count             |
| extra            | object   | no       | Arbitrary extra fields (ignored in scoring) |

The loader accepts a bare list, or wrappers shaped like
{"follower": [...]} / {"data": [...]} / {"list": [...]}.

## Scoring model
Each record is scored from three signals (weights sum to 1.0):

| signal      | weight | how it is computed                                          |
|-------------|--------|-------------------------------------------------------------|
| recency     | 0.45   | last_seen_days preferred, else last_video_days. 0d->1.0, 365d->0.1 decay |
| authority   | 0.30   | log10(follower/following + 1) / 3, clamped to 0..1        |
| relevance   | 0.25   | bio length quality (>=12 chars full) + official/verified marker bonus |

A signal is only counted (and its weight applied) if the record actually
provides it. The final score is clamped to 0..1.

Classification thresholds:
- score >= 0.70  -> **keep**
- score >= 0.40  -> **review**
- otherwise      -> **remove**

## Output
- **Markdown report** (--md FILE or stdout): a table per class (KEEP/REVIEW/REMOVE)
  with name, score, recency, last video, and truncated reason.
- **CSV** (--csv FILE): flat rows for spreadsheet import / programmatic use.
- **Unfollow list** (--unfollow-list FILE): one candidate ollower_id per line
  for the REMOVE class — purely for manual action.
- Summary line on stderr: keep=N review=M remove=K.

## CLI
```

bili-clean INPUT [options]
  --md FILE            write markdown report to FILE (else print to stdout)
  --csv FILE           write CSV to FILE
  --dry-run            report-only (default; always true)
  --unfollow-list FILE write remove-class ids to FILE
```

## MVP scope (v0.1.0)
- Load normalized JSON -> FollowRecord
- Score + classify -> keep/review/remove with reasons
- Export markdown + csv + optional unfollow list
- Demo sample generator (python -m bili.demo)
- Test suite
- CI

## Non-goals (v0.1.0, future)
- Directly fetching the follow list from a login session (requires cookies; deferred)
- Actual unfollow API integration (intentionally omitted for safety)
- Web/interactive UI
- Multi-account support
