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
4. **Unknown is not worst-case** (since v0.1.2, FOR-36). Missing signals drop out of
   the score denominator instead of scoring 0, and two hard gates apply: a record
   without a recency signal is never REMOVE, and a record without recency *or*
   authority is never KEEP. Both fall to review, where a human confirms.

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

The loader accepts a bare list, a single object, or wrappers shaped like
{"follower": [...]} / {"data": [...]} / {"list": [...]}, including the nested
{"code":0,"data":{"follower":[...]}} envelope you get by copying the browser
response verbatim (FOR-36). In that response the display name lives under
`uname`, which is mapped to nickname (nickname / follower_name / uname / name).

## Scoring model
Each record is scored from three signals (weights sum to 1.0):

| signal      | weight | how it is computed                                          |
|-------------|--------|-------------------------------------------------------------|
| recency     | 0.45   | last_seen_days preferred, else last_video_days. 0d->1.0, 365d->0.1 decay |
| authority   | 0.30   | log10(follower/following + 1) / 3, clamped to 0..1        |
| relevance   | 0.25   | bio length quality (>=12 chars full) + official/verified marker bonus |

A signal is only counted if the record actually provides it, and the score is the
weighted average over the provided signals: `score = sum(w_k*p_k) / sum(w_k)`,
where the denominator contains only the weights of provided signals
(0.0 when nothing is provided). The final score is clamped to 0..1.

Classification thresholds:
- score >= 0.70  -> **keep**
- score >= 0.40  -> **review**
- otherwise      -> **remove**

Hard gates on top of the thresholds (FOR-36):

- **Gate A (unfollow direction)** - no recency signal -> the record can never be
  REMOVE; it is downgraded to review with the reason line
  `downgraded to review: no recency signal`.
- **Gate B (keep direction)** - KEEP requires recency or authority; a bio-only
  record (even one that says "official verified") is downgraded to review.

Every exported row also carries `signals_used` (0-3), and when at least 50% of the
rows lack recency the Markdown and web reports start with a `missing-signal warning`
line telling the user to fill the signals with bili-merge first.

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
