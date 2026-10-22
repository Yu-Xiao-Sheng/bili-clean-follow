"""Command-line entry point for bili-clean."""

import argparse
import sys

from . import __version__
from .export import run, to_markdown, to_csv
from .loaders import load_from_file


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="bili-clean",
        description="Analyze and clean your Bilibili follow list into keep/review/remove.")
    p.add_argument("input", help="Path to a JSON file of follows")
    p.add_argument("--md", help="Write Markdown report to this file (default: print to stdout)")
    p.add_argument("--csv", help="Write CSV to this file (default: none)")
    p.add_argument("--dry-run", action="store_true", default=True,
        help="Report-only mode (default). Never touches your account.")
    p.add_argument("--unfollow-list", metavar="PATH",
        help="After review, write the REMOVE list to this file for manual action.")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        records = load_from_file(args.input)
    except Exception as exc:
        print("error: could not load follows from %s: %s" % (args.input, exc), file=sys.stderr)
        return 2

    results = run(records)
    md = to_markdown(results)

    if args.md:
        with open(args.md, "w", encoding="utf-8") as fh:
            fh.write(md)
        print("Markdown report written to %s" % args.md)
    else:
        sys.stdout.write(md)

    if args.csv:
        with open(args.csv, "w", encoding="utf-8", newline="") as fh:
            fh.write(to_csv(results))
        print("CSV written to %s" % args.csv)

    removed = [r for r in results if r["class"] == "remove"]
    print("Summary: keep=%d review=%d remove=%d" % (
        len([r for r in results if r["class"] == "keep"]),
        len([r for r in results if r["class"] == "review"]),
        len(removed)), file=sys.stderr)
    if args.unfollow_list:
        with open(args.unfollow_list, "w", encoding="utf-8") as fh:
            fh.write("\n".join(r["follower_id"] for r in removed) + ("\n" if removed else ""))
        print("Unfollow list written to %s (%d ids)" % (args.unfollow_list, len(removed)), file=sys.stderr)
    sys.stderr.write("Done. This tool reports only; it never unfollows by itself.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
