# Getting Started

## 1. Install (local)
```

pip install .
```

Or run the source directly:
```

python -m bili.cli INPUT.json
```

## 2. Try it with sample data
```

python -m bili.demo        # writes sample-follows.json in the current directory
bili-clean sample-follows.json --md report.md
cat report.md
```

## 3. Prepare a real input file
Bilibili's web "my follows" page is a list of user objects. The simplest,
privacy-safe way to get an export:

1. In the browser, open your Bilibili follows page (logged in).
2. Open DevTools -> Network, and filter for the request that returns your follow
   list (the page calls an endpoint that returns a ollower array).
3. Copy the **response** into ollows.json.
   - If the response is {"data": {"follower": [...]}}, the loader picks it up
     automatically (we unwrap the ollower / data / list keys).
   - Optionally enrich each object with last_seen_days / last_video_days /
     ollower_count / ollowing_count to get a better score. (The raw
     endpoint alone only gives identity + bio + avatar; richer signals need the
     per-profile lookups you export by hand or via a companion script.)

> Privacy note: the input file is yours. It is never uploaded or shared by this
> tool. Never commit it to this repository.

## 4. Run the cleaner
```

bili-clean follows.json --md report.md --csv report.csv --unfollow-list to-unfollow.txt
```

Then open 
eport.md and act on 	o-unfollow.txt manually in your Bilibili
account. This tool does not touch your account.

## 5. How scoring works
See [docs/spec.md](spec.md) for the weights, signals, and thresholds. Tweak
WEIGHTS and the thresholds in src/bili/score.py if you want a different
default bias (e.g. keep more).

## Extending
- Add a signal: add it to score.py and to the FollowRecord loader.
- Change the bias: edit WEIGHTS, REVIEW_MIN, KEEP_MIN.
- New export format: add a function to xport.py.
