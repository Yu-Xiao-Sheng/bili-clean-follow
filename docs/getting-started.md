# Getting Started

## 1. Install (required)

The package uses a src/ layout, so on a fresh clone `python -m bili.cli ...` fails with
`ModuleNotFoundError: No module named 'bili'`. Install the package first - pick one:

Option A - install the release zip (no clone):

```
pip install https://github.com/Yu-Xiao-Sheng/bili-clean-follow/releases/download/v0.1.1/bili-clean-follow-0.1.1.zip
```

Option B - clone, then install in editable mode:

```
git clone https://github.com/Yu-Xiao-Sheng/bili-clean-follow.git
cd bili-clean-follow
pip install -e .
```

Sanity check: `bili-clean --version` prints `bili-clean 0.1.1`.

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
   - If the body looks like {"data": {"follower": [...]}}, the loader unwraps the
     follower / data / list keys automatically.
   - Optionally enrich each object with last_seen_days / last_video_days /
     follower_count / following_count to get a better score. The raw endpoint only
     gives identity + bio + avatar; the richer signals come from the per-profile
     lookups you export by hand or with a companion script.

> Privacy note: the input file is yours. This tool never uploads or shares it.
> Never commit it to this repository. The CLI judges the file **content**: it refuses
> anything that really carries cookie/credential keys (SESSDATA, bili_jct, ...). If
> only the file *name* looks like a cookie export you get a warning plus a rename hint
> (save it as bili-follows.json), not a hard refusal.

## 4. Run the cleaner

```
bili-clean follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

Then open report.md and act on to-unfollow.txt manually in your Bilibili account.
This tool does not touch your account. Each to-unfollow.txt row is `mid <TAB> nickname`
(search the nickname on your follows page), and report.csv is utf-8-sig so Excel /
WPS on Windows opens it without mojibake.

## 5. How scoring works

See [docs/scoring-model.md](scoring-model.md) and [docs/spec.md](spec.md) for the weights,
signals and thresholds. Tweak WEIGHTS, REVIEW_MIN and KEEP_MIN in src/bili/score.py if
you want a different default bias (for example, keep more follows).

## Extending

- Add a signal: extend src/bili/score.py and the loader in src/bili/loaders.py.
- Change the bias: edit WEIGHTS, REVIEW_MIN, KEEP_MIN in src/bili/score.py.
- New export format: add a function to src/bili/export.py.
- Run the tests: `pip install pytest && pytest tests -q` (or with PYTHONPATH=src).
