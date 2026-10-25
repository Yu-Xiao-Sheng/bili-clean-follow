# Getting Started

## 1. Install (required)

The package uses a src/ layout, so on a fresh clone `python -m bili.cli ...` fails with
`ModuleNotFoundError: No module named 'bili'`. Install the package first - pick one:

Option A - install the release zip (no clone):

```
pip install https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.3/bili-clean-follow-0.1.3.zip
```

Option B - clone, then install in editable mode:

```
git clone https://github.com/Yu-Xiao-Sheng/bili-clean-follow.git
cd bili-clean-follow
pip install -e .
```

Sanity check: `bili-clean --version` prints `bili-clean 0.1.3`.

If you would rather not install, run everything from the source tree with
`PYTHONPATH=src` (Windows: `set PYTHONPATH=src`). That is exactly what CI does.

## 2. Try it with sample data

```
python -m bili.demo   # writes sample-follows.json in the current directory
bili-clean sample-follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

The sample is fixed, so the expected summary is `keep=13 review=2 remove=9`.

## 3. Prepare a real input file

Bilibili's public follow-list endpoint does not expose per-follow "last active"
timestamps, so the tool works from a normalized JSON export. The simplest,
privacy-safe way to get one:

1. Open your Bilibili follows page in the browser (logged in).
2. Open DevTools -> Network and find the request that returns the follow list
   (the page calls an endpoint that returns a follower array).
3. Copy the response body into follows.json.
   - If the body looks like {"code":0,"data":{"follower":[...]}}, the loader unwraps
     the follower / data / list keys automatically - including the nested
     data.follower envelope you get by copying the browser response verbatim.
   - In that response the display name is `uname` (some endpoints use `name`); the loader
     maps it to nickname, so the unfollow list still carries names (FOR-36).
   - Certification is read from fields, not from bio wording: `official.role/title/department`,
     flat `official_*` keys and `official_verify.type > 0` become `extra.official_*` and feed
     the relevance signal; `face` is kept as `extra.face` (FOR-37).
   - Reference fixture you can run as-is: `tests/fixture-bili-real.json` (20 rows in the
     `code/data.follower` envelope, three certified accounts, one emoji nickname) and its
     `data.list` variant `tests/fixture-bili-real-list.json`:

     ```
     python -m bili tests/fixture-bili-real.json --md report.md --csv report.csv
     # Summary: keep=0 review=20 remove=0  (no signal was invented for the missing ones)
     ```
   - Optionally enrich each object with last_seen_days / last_video_days /
     follower_count / following_count to get a better score. The raw endpoint only
     gives identity + bio + avatar; the richer signals come from the per-profile
     lookups you do by hand - and §4 shows the bundled `bili-merge`, which writes
     the fill-in template for you and merges the numbers back in.

> Privacy note: the input file is yours. This tool never uploads or shares it.
> Never commit it to this repository. The CLI judges the file **content**: it refuses
> anything that really carries cookie/credential keys (SESSDATA, bili_jct, ...). If
> only the file *name* looks like a cookie export you get a warning plus a rename hint
> (save it as bili-follows.json), not a hard refusal.

## 4. Fill in the missing signals (bili-merge, recommended)

The export you can actually produce in §3 carries identity + bio + avatar only,
while scoring needs recency and authority. `bili-merge` is the offline helper for
that gap - it makes no network calls and never touches your account:

```
bili-merge follows.json --template signals.csv
```

That writes `signals.csv` with `mid` and `nickname` already filled in (utf-8-sig,
so Excel / WPS open it without mojibake). You only type four numbers per row:

| column | where to read it on the profile page |
|:---|:---|
| `last_seen_days` | 最近一次看到 TA 的动态距今多少天（不确定就留空） |
| `last_video_days` | 主页「投稿」第一页顶部日期，距今多少天 |
| `follower_count` | 粉丝数（主页头部） |
| `following_count` | 关注数（主页头部） |

Then merge and re-run:

```
bili-merge follows.json --signals signals.csv     # -> follows.merged.json
bili-clean follows.merged.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

Leave a cell empty whenever you cannot find the number: empty means unknown, and
unknown is never treated as a reason to unfollow - those rows stay in review and
only affect ordering. `bili-merge` prints the three steps plus a final
`Summary: merged_rows=... blank_rows=... unknown_mid=...` line, which keeps the
whole flow readable in a terminal recording.

If you skip this step the report is still produced, but it can only rank your
follow list - it is not a basis for unfollow decisions. Run from the source tree
with `PYTHONPATH=src python -m bili.merge_cli` if you did not install the package.

## 5. Run the cleaner

```
bili-clean follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

Then open report.md and act on to-unfollow.txt manually in your Bilibili account.
This tool does not touch your account. Each to-unfollow.txt row is `mid <TAB> nickname`
(search the nickname on your follows page), and report.csv is utf-8-sig so Excel /
WPS on Windows opens it without mojibake.

## 6. Optional: the local web report

If you would rather click than read terminal output, the same input file feeds a
read-only local report (v0.1.1+, no extra dependencies):

```
python -m bili.demo                            # only if you have no follows.json yet
python -m bili.web --input follows.json
```

Open http://127.0.0.1:8787 - the server binds to 127.0.0.1 only, there is no upload
endpoint and nothing is written to disk. The page header reads
`bili-clean-follow v0.1.3 · 本地只读 · 数据不出本机` and gives you:

- summary cards: total follows plus the keep / review / remove counts and shares;
- the full classified table, filterable by tab and sortable by any column;
- a delete-candidate preview you confirm one by one, exported as .txt (`mid <TAB> nickname`);
- one-click Markdown / CSV export (CSV carries a UTF-8 BOM for Excel / WPS).

If 8787 is already taken, move it: `python -m bili.web --input follows.json --port 8899`.
Without the installed package run `PYTHONPATH=src python -m bili.web --input follows.json`.

## 7. How scoring works

See [docs/scoring-model.md](scoring-model.md) and [docs/spec.md](spec.md) for the weights,
signals and thresholds. Tweak WEIGHTS, REVIEW_MIN and KEEP_MIN in src/bili/score.py if
you want a different default bias (for example, keep more follows).

Since v0.1.2 (FOR-36) a missing signal is *unknown*, not *worst*: the score is a weighted
average over the signals you actually provided, and two gates sit on top of the thresholds -
**without a recency signal a row can never be REMOVE**, and **a bio-only row can never be
KEEP**. Those rows stay in review for you to confirm. Every row of the report and the CSV
shows `signals_used` and `missing_signals` (signal names joined by `;`, complementary), and
the Markdown/web reports render "unknown" as 未知; when at least half of the rows lack recency the report opens
with a `missing-signal warning` line, because such a run is a ranking, not an unfollow basis.

## Extending

- Add a signal: extend src/bili/score.py and the loader in src/bili/loaders.py.
- Change the bias: edit WEIGHTS, REVIEW_MIN, KEEP_MIN in src/bili/score.py.
- New export format: add a function to src/bili/export.py.
- Run the tests: `pip install pytest && pytest tests -q` (or with PYTHONPATH=src).
