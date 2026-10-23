"""Command-line entry point for bili-clean."""

import argparse
import sys

from . import __version__
from .export import (CSV_ENCODING, TEXT_ENCODING, run, to_csv,
                     to_markdown, to_unfollow_list)
from .loaders import load_from_file
from .streams import harden_stdio, safe_write


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="bili-clean",
        description="Analyze and clean your Bilibili follow list into keep/review/remove.")
    p.add_argument("input", help="Path to a JSON file of follows")
    p.add_argument("--md", help="Write Markdown report to this file (default: print to stdout)")
    p.add_argument("--csv", help="Write CSV (utf-8 BOM, Excel-friendly) to this file (default: none)")
    p.add_argument("--dry-run", action="store_true", default=True,
        help="Report-only mode (default). Never touches your account.")
    p.add_argument("--unfollow-list", metavar="PATH",
        help="After review, write the REMOVE list (mid + nickname) to this file for manual action.")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def main(argv=None) -> int:
    # Windows 中文控制台默认 GBK，emoji 昵称会直接崩（FOR-38）：先重设输出编码。
    harden_stdio()
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)

    try:
        records = load_from_file(args.input)
    except Exception as exc:
        print("error: could not load follows from %s: %s" % (args.input, exc), file=sys.stderr)
        return 2

    results = run(records)
    md = to_markdown(results)

    if args.md:
        with open(args.md, "w", encoding=TEXT_ENCODING, newline="\n") as fh:
            fh.write(md)
        print("Markdown report written to %s" % args.md)
    else:
        safe_write(md)

    if args.csv:
        # utf-8-sig：没有 BOM 的话，Windows Excel/WPS 双击打开中文全是乱码。
        with open(args.csv, "w", encoding=CSV_ENCODING, newline="") as fh:
            fh.write(to_csv(results))
        print("CSV written to %s" % args.csv)

    removed = [r for r in results if r["class"] == "remove"]
    print("Summary: keep=%d review=%d remove=%d" % (
        len([r for r in results if r["class"] == "keep"]),
        len([r for r in results if r["class"] == "review"]),
        len(removed)), file=sys.stderr)
    if args.unfollow_list:
        text = to_unfollow_list(results)
        with open(args.unfollow_list, "w", encoding=CSV_ENCODING, newline="\n") as fh:
            fh.write(text)
        print("Unfollow list written to %s (%d ids, mid + nickname). "
              "请核对昵称后手工处理，工具不会自动取关。"
              % (args.unfollow_list, len(removed)), file=sys.stderr)
    sys.stderr.write("Done. This tool reports only; it never unfollows by itself.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
