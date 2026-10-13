"""Convert MT5 tick exports into daily binary files for the Gold Replay Simulator.

Usage:
    python converter/convert.py EXPORT.csv [EXPORT2.csv ...] [--out data] [--symbol XAUUSD]
                                [--digits N] [--force]

Input is the MT5 tick export (Symbols window -> Ticks tab -> Export). Expected columns:
    <DATE> <TIME> <BID> <ASK> <LAST> <VOLUME> <FLAGS>
with dates like 2026.10.12 and times like 14:30:01.123, tab separated. Columns are
located by their header names, so extra/reordered columns are fine.

- A blank BID or ASK is forward-filled from the previous tick.
- Rows where both BID and ASK are blank (LAST/volume-only updates) carry no quote and are skipped.
- Rows before both sides are known (start of the export) are skipped.
- Times are kept as broker server time.

Output: data/<SYMBOL>/YYYY-MM-DD.bin (see grbin.py) and data/<SYMBOL>/manifest.json.
Days that already have a .bin are left alone unless --force is given, so the converter can be
re-run with new exports to add days. Every written day is read back and compared with the input.
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import sys
from array import array
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import grbin  # noqa: E402

DEFAULT_COLUMNS = ["<DATE>", "<TIME>", "<BID>", "<ASK>", "<LAST>", "<VOLUME>", "<FLAGS>"]


def detect_encoding(path: str) -> str:
    with open(path, "rb") as f:
        head = f.read(4096)
    if head.startswith(codecs.BOM_UTF16_LE):
        return "utf-16"
    if head.startswith(codecs.BOM_UTF16_BE):
        return "utf-16"
    if head.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    # UTF-16 without BOM: every other byte is NUL for ASCII text.
    if head and head.count(b"\0") > len(head) // 4:
        return "utf-16-le" if head[1:2] == b"\0" else "utf-16-be"
    return "utf-8"


def detect_delimiter(line: str) -> str:
    for d in ("\t", ";", ","):
        if d in line:
            return d
    return "\t"


def parse_time_ms(s: str) -> int:
    """'14:30:01.123' -> ms since day start. Fraction may be absent or have 1-3+ digits."""
    hms, _, frac = s.strip().partition(".")
    h, m, sec = hms.split(":")
    ms = int((frac + "000")[:3]) if frac else 0
    return ((int(h) * 60 + int(m)) * 60 + int(sec)) * 1000 + ms


def parse_date(s: str) -> str:
    """'2026.10.12' -> '2026-10-12'."""
    s = s.strip().replace(".", "-").replace("/", "-")
    y, mo, d = s.split("-")
    return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"


def decimals_of(s: str) -> int:
    s = s.strip()
    if "." not in s:
        return 0
    return len(s.split(".", 1)[1])


def scale_price(s: str, digits: int) -> int:
    """Exact decimal string -> integer price * 10**digits (no float rounding)."""
    s = s.strip()
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    whole, _, frac = s.partition(".")
    if len(frac) > digits:
        if int(frac[digits:] or "0") != 0:
            raise ValueError(f"price {s} has more than {digits} decimals")
        frac = frac[:digits]
    v = int(whole or "0") * 10**digits + int((frac + "0" * digits)[:digits] or "0")
    return -v if neg else v


@dataclass
class ParseStats:
    rows: int = 0
    skipped_no_quote: int = 0
    skipped_before_first_quote: int = 0
    filled_bid: int = 0
    filled_ask: int = 0
    out_of_order_days: list = field(default_factory=list)


def open_rows(path: str):
    """Yield (header_columns, row_iterator). Header is located by its <DATE> column."""
    enc = detect_encoding(path)
    f = open(path, "r", encoding=enc, newline="")
    first = f.readline()
    delim = detect_delimiter(first)
    cols = [c.strip().upper() for c in first.rstrip("\r\n").split(delim)]
    if "<DATE>" in cols:
        header = cols
        pending = []
    else:
        header = DEFAULT_COLUMNS
        pending = [first]

    def rows():
        try:
            for line in pending:
                yield line.rstrip("\r\n").split(delim)
            for line in f:
                line = line.rstrip("\r\n")
                if line:
                    yield line.split(delim)
        finally:
            f.close()

    return header, rows()


def scan_digits(path: str) -> int:
    header, rows = open_rows(path)
    bi, ai = header.index("<BID>"), header.index("<ASK>")
    best = 0
    for r in rows:
        for i in (bi, ai):
            if i < len(r) and r[i].strip():
                best = max(best, decimals_of(r[i]))
    return best


def parse_export(path: str, digits: int, stats: ParseStats):
    """Yield (date, time_ms, bid_int, ask_int, bid_str, ask_str) with forward fill applied."""
    header, rows = open_rows(path)
    try:
        di, ti = header.index("<DATE>"), header.index("<TIME>")
        bi, ai = header.index("<BID>"), header.index("<ASK>")
    except ValueError as e:
        raise SystemExit(f"{path}: missing column in header {header}: {e}")
    last_bid: str | None = None
    last_ask: str | None = None
    for r in rows:
        stats.rows += 1
        bid = r[bi].strip() if bi < len(r) else ""
        ask = r[ai].strip() if ai < len(r) else ""
        if not bid and not ask:
            stats.skipped_no_quote += 1
            continue
        if not bid:
            stats.filled_bid += 1
        if not ask:
            stats.filled_ask += 1
        bid = bid or last_bid
        ask = ask or last_ask
        last_bid, last_ask = bid, ask
        if bid is None or ask is None:
            stats.skipped_before_first_quote += 1
            continue
        yield (
            parse_date(r[di]),
            parse_time_ms(r[ti]),
            scale_price(bid, digits),
            scale_price(ask, digits),
        )


def group_days(path: str, symbol: str, digits: int, stats: ParseStats) -> dict[str, grbin.DayTicks]:
    days: dict[str, grbin.DayTicks] = {}
    for date, t, b, a in parse_export(path, digits, stats):
        d = days.get(date)
        if d is None:
            d = days[date] = grbin.DayTicks(symbol, date, digits, array("I"), array("i"), array("i"))
        d.times.append(t)
        d.bids.append(b)
        d.asks.append(a)
    for date, d in days.items():
        if any(d.times[i] > d.times[i + 1] for i in range(len(d.times) - 1)):
            stats.out_of_order_days.append(date)
            order = sorted(range(d.count), key=d.times.__getitem__)  # stable
            d.times = array("I", (d.times[i] for i in order))
            d.bids = array("i", (d.bids[i] for i in order))
            d.asks = array("i", (d.asks[i] for i in order))
    return days


def fmt_ms(ms: int) -> str:
    s, ms = divmod(ms, 1000)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def build_manifest(out_dir: str, symbol: str) -> dict:
    days = []
    for name in sorted(os.listdir(out_dir)):
        if not name.endswith(".bin"):
            continue
        path = os.path.join(out_dir, name)
        sym, date, digits, n = grbin.read_header(path)
        first, last = grbin.read_time_bounds(path)
        days.append(
            {
                "date": date,
                "file": name,
                "ticks": n,
                "digits": digits,
                "firstMs": first,
                "lastMs": last,
                "first": fmt_ms(first),
                "last": fmt_ms(last),
            }
        )
    manifest = {
        "symbol": symbol,
        "digits": max((d["digits"] for d in days), default=2),
        "timezone": "broker server time",
        "days": days,
    }
    tmp = os.path.join(out_dir, "manifest.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    os.replace(tmp, os.path.join(out_dir, "manifest.json"))
    return manifest


def verify_day(path: str, expected: grbin.DayTicks) -> None:
    got = grbin.read_day(path)
    if (
        got.date != expected.date
        or got.digits != expected.digits
        or got.times != expected.times
        or got.bids != expected.bids
        or got.asks != expected.asks
    ):
        raise SystemExit(f"VERIFY FAILED for {path}: read-back differs from input")


def convert(paths: list[str], out_root: str, symbol: str, digits: int | None, force: bool) -> int:
    out_dir = os.path.join(out_root, symbol)
    os.makedirs(out_dir, exist_ok=True)
    written = 0
    for path in paths:
        dg = digits if digits is not None else scan_digits(path)
        stats = ParseStats()
        days = group_days(path, symbol, dg, stats)
        print(f"{path}: {stats.rows} rows, {len(days)} day(s), {dg} price digits")
        print(
            f"  forward-filled bid {stats.filled_bid}, ask {stats.filled_ask}; skipped "
            f"{stats.skipped_no_quote} rows without bid/ask, "
            f"{stats.skipped_before_first_quote} rows before first full quote"
        )
        if stats.out_of_order_days:
            print(f"  WARNING: times out of order on {stats.out_of_order_days}; sorted by time")
        for date in sorted(days):
            d = days[date]
            target = os.path.join(out_dir, f"{date}.bin")
            if os.path.exists(target) and not force:
                _, _, _, n_old = grbin.read_header(target)
                note = ""
                if n_old != d.count:
                    note = f" (existing has {n_old} ticks, this export {d.count}; use --force to replace)"
                print(f"  {date}: already converted, skipped{note}")
                continue
            tmp = target + ".tmp"
            grbin.write_day(tmp, d)
            verify_day(tmp, d)
            os.replace(tmp, target)
            written += 1
            print(f"  {date}: {d.count} ticks {fmt_ms(d.times[0])} - {fmt_ms(d.times[-1])} -> verified OK")
    manifest = build_manifest(out_dir, symbol)
    print(f"manifest: {len(manifest['days'])} day(s) in {out_dir}")
    return written


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="MT5 tick export file(s)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))
    ap.add_argument("--symbol", default="XAUUSD")
    ap.add_argument("--digits", type=int, default=None, help="price digits (default: detect from file)")
    ap.add_argument("--force", action="store_true", help="overwrite days that already exist")
    a = ap.parse_args(argv)
    convert(a.inputs, os.path.normpath(a.out), a.symbol, a.digits, a.force)


if __name__ == "__main__":
    main()
