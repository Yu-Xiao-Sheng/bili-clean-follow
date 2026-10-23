"""bili-merge：把「手工补的信号」合回关注列表导出（FOR-40）。

为什么要有这个命令：docs/getting-started.md §3 让用户「手工去个人主页把
last_seen_days / follower_count 抄进导出」，但 v0.1.1 没有任何工具或模板，真实
用户跑完只能得到一边倒的报告。bili-merge 补上这段：模板预填 mid + 昵称，用户只
填数字；合并后直接重跑 bili-clean。全程本地，不联网、不调任何 B站 API。

用法：
    bili-merge follows.json --template signals.csv      # 第 1 步：生成待填模板
    # 在 Excel / WPS / 记事本里填 4 个数字列（拿不到的留空）
    bili-merge follows.json --signals signals.csv       # 第 2 步：合并
    bili-clean follows.merged.json --md report.md --csv report.csv   # 第 3 步
"""

import argparse
import os
import sys
from pathlib import Path

from . import __version__
from .loaders import load_raw_from_file
from .signals import (SIGNAL_FIELDS, SignalError, dump_merged, merge,
                      next_step_command, read_signals, write_template)
from .streams import harden_stdio

USAGE_EXAMPLES = (
    "  第 1 步 · 生成待填模板（mid + 昵称已经填好，你只填数字）\n"
    "    bili-merge follows.json --template signals.csv\n"
    "  第 2 步 · 在 Excel / WPS / 记事本里填 4 个数字列，然后合并\n"
    "    bili-merge follows.json --signals signals.csv\n"
    "  第 3 步 · 用合并后的文件重跑报告\n"
    "    bili-clean follows.merged.json --md report.md --csv report.csv "
    "--unfollow-list to-unfollow.txt"
)

COLUMN_HELP = (
    "    要填的四列（拿不到的留空，空 = 未知，未知不会被当成取关理由）：\n"
    "      last_seen_days    最近一次看到 TA 的动态，距今多少天\n"
    "      last_video_days   TA 最近一次投稿，距今多少天（主页「投稿」页第一页顶部日期）\n"
    "      follower_count    粉丝数（个人主页头部）\n"
    "      following_count   关注数（个人主页头部）\n"
    "    天数换算：今天减投稿日期。例：8 月 1 日投稿、今天 10 月 23 日 -> 83"
)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="bili-merge",
        description="Offline companion tool: merge hand-collected signals "
                    "(last_seen_days / last_video_days / follower_count / "
                    "following_count) back into your follows export.")
    p.add_argument("input", help="你的关注列表导出（follows.json）")
    p.add_argument("--template", metavar="PATH",
                   help="生成待填的 signals.csv 模板：mid 与昵称已预填，只等你填数字")
    p.add_argument("--signals", metavar="PATH",
                   help="把你填好的 signals.csv 合并进导出，输出新的 follows.json")
    p.add_argument("--out", metavar="PATH",
                   help="合并结果路径（默认 <input>.merged.json，不会覆盖原始导出）")
    p.add_argument("--overwrite", action="store_true",
                   help="CSV 里的值覆盖导出里已有的信号（默认只填空缺，不动已有值）")
    p.add_argument("--version", action="version", version="%(prog)s " + __version__)
    return p


def default_out(input_path: str) -> str:
    path = Path(str(input_path))
    return str(path.with_suffix(".merged.json"))


def _same_file(a: str, b: str) -> bool:
    try:
        return os.path.normcase(os.path.abspath(str(a))) == \
            os.path.normcase(os.path.abspath(str(b)))
    except (OSError, ValueError):
        return str(a) == str(b)


def _summary_line(stats, table) -> str:
    return ("Summary: merged_rows=%d added=%d overwritten=%d unknown_mid=%d "
            "blank_rows=%d parse_errors=%d"
            % (stats["updated"], stats["added"], stats["overwritten"],
               len(stats["unknown_mid"]), table.blank_rows, len(table.errors)))


def main(argv=None) -> int:
    harden_stdio()
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)

    if not args.template and not args.signals:
        print("bili-merge 需要 --template（生成模板）或 --signals（合并）之一：")
        print(USAGE_EXAMPLES)
        print("\n提示：不补信号时，bili-clean 的结果只用于排序，不构成取关建议。")
        return 2

    try:
        items = load_raw_from_file(args.input)
    except Exception as exc:
        print("错误 error: 读不到关注列表导出 %s：%s" % (args.input, exc),
              file=sys.stderr)
        return 2
    if not items:
        print("错误 error: %s 里没有关注记录。"
              "期望是 JSON 数组，或带 follower / data / list 键的对象。" % args.input,
              file=sys.stderr)
        return 2

    print("bili-merge v%s · 补信号工具 · 纯本地：不联网、不调 B站 API、不碰账号"
          % __version__)
    print("  读 %s：%d 条关注记录" % (args.input, len(items)))

    if args.template:
        try:
            count = write_template(args.template, items)
        except OSError as exc:
            print("错误 error: 写不出模板 %s：%s" % (args.template, exc),
                  file=sys.stderr)
            return 2
        print("")
        print("第 1 步 · 模板已生成：[OK] %s（%d 行，utf-8 BOM，Excel/WPS 双击不乱码）"
              % (args.template, count))
        print("  mid 与昵称已经预填好，你只需要填 4 个数字列，不用抄 mid。")
        print(COLUMN_HELP)
        print("  填完保存（保持 CSV 格式），再跑：")
        print("    bili-merge %s --signals %s" % (args.input, args.template))

    merged_path = None
    if args.signals:
        try:
            table = read_signals(args.signals)
        except SignalError as exc:
            print("错误 error: %s" % exc, file=sys.stderr)
            return 2
        merged, stats = merge(items, table, overwrite=args.overwrite)
        out = args.out or default_out(args.input)
        if _same_file(out, args.input):
            print("错误 error: --out 不能是原始导出 %s，"
                  "我不想覆盖你的原始数据。请换个文件名，例如 follows.merged.json。"
                  % args.input, file=sys.stderr)
            return 2
        try:
            dump_merged(merged, out)
        except OSError as exc:
            print("错误 error: 写不出合并结果 %s：%s" % (out, exc), file=sys.stderr)
            return 2
        merged_path = out
        print("")
        print("第 2 步 · 合并信号：[OK] %s（%d 行给了信号，%d 行留空）"
              % (args.signals, len(table), table.blank_rows))
        print("  新增信号字段 %d 个，覆盖已有字段 %d 个%s"
              % (stats["added"], stats["overwritten"],
                 "" if args.overwrite else "（默认不覆盖已有值，加 --overwrite 才覆盖）"))
        print("  合并后仍完全没有信号的记录：%d 条（这些只会进 review，不会被建议取关）"
              % stats["untouched"])
        if stats["unknown_mid"]:
            shown = ", ".join(stats["unknown_mid"][:5])
            print("  警告 warning: %d 行的 mid 不在你的关注列表里（抄错或已取关）：%s%s"
                  % (len(stats["unknown_mid"]), shown,
                     " ..." if len(stats["unknown_mid"]) > 5 else ""))
        for line in table.errors:
            print("  提示 hint: %s" % line)
        if not len(table):
            print("  警告 warning: signals.csv 里没有任何可合并的值（全都留空），"
                  "合并结果与原始导出一致。")
        print("  已写出 %s（扁平 JSON 数组，bili-clean 直接读）" % out)

    if merged_path:
        print("")
        print("第 3 步 · 用合并后的文件重跑报告：")
        print("  " + next_step_command(merged_path))
    else:
        print("")
        print("第 2 步 · 填完 CSV 后合并：")
        print("  bili-merge %s --signals <你填的 signals.csv>" % args.input)
    print("")
    print("提示：不补信号时，报告结果只用于排序，不构成取关建议；"
          "只有带 recency 依据的记录才可能进 remove。")
    if merged_path:
        print(_summary_line(stats, table))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())