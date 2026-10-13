"""Generate a synthetic XAUUSD tick export in MT5's format, for trying the app before real data.

    python converter/make_sample.py [--start 2026-10-05] [--days 5] [--out sample_ticks.csv]

The file mimics an MT5 tick export: UTF-16 with BOM, tab separated, header
<DATE> <TIME> <BID> <ASK> <LAST> <VOLUME> <FLAGS>, and rows where only the bid or only the
ask changed (the other column blank). Weekends are left out. Prices are a seeded random walk,
so the output is the same every run. This is NOT market data; use it only to test the tools.
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import random


def generate(start: dt.date, days: int, path: str, seed: int = 7, mean_gap_ms: float = 400.0) -> int:
    rng = random.Random(seed)
    price = 2650.00
    rows = 0
    d = start
    produced = 0
    with open(path, "w", encoding="utf-16", newline="") as f:
        f.write("<DATE>\t<TIME>\t<BID>\t<ASK>\t<LAST>\t<VOLUME>\t<FLAGS>\r\n")
        while produced < days:
            if d.weekday() >= 5:
                d += dt.timedelta(days=1)
                continue
            produced += 1
            date_s = d.strftime("%Y.%m.%d")
            t = 60 * 60 * 1000 + rng.randint(0, 2000)  # session opens 01:00 server time
            end = 23 * 60 * 60 * 1000 + 57 * 60 * 1000
            drift = rng.choice((-1, 1)) * rng.uniform(0.0, 0.0002)
            bid_c = round(price * 100)
            spread = 20
            ask_c = bid_c + spread
            while t < end:
                hour = t / 3_600_000
                # busier London/NY hours, quieter Asia
                activity = 1.0 + 1.5 * math.exp(-((hour - 16.0) ** 2) / 8.0) + 0.6 * math.exp(-((hour - 10.5) ** 2) / 4.0)
                t += max(1, int(rng.expovariate(activity / mean_gap_ms)))
                if t >= end:
                    break
                if rng.random() < 0.002:
                    drift = rng.choice((-1, 1)) * rng.uniform(0.0, 0.0003)
                step = rng.gauss(drift, 0.055 * math.sqrt(activity))
                price += step
                new_bid = round(price * 100)
                new_spread = max(10, min(45, spread + rng.choice((-2, -1, 0, 0, 0, 1, 2))))
                new_ask = new_bid + new_spread
                bid_changed = new_bid != bid_c
                ask_changed = new_ask != ask_c
                if not bid_changed and not ask_changed:
                    continue
                bid_c, ask_c, spread = new_bid, new_ask, new_spread
                flags = (2 if bid_changed else 0) | (4 if ask_changed else 0)
                bid_s = f"{bid_c / 100:.2f}" if bid_changed else ""
                ask_s = f"{ask_c / 100:.2f}" if ask_changed else ""
                hh, rem = divmod(t, 3_600_000)
                mm, rem = divmod(rem, 60_000)
                ss, ms = divmod(rem, 1000)
                f.write(f"{date_s}\t{hh:02d}:{mm:02d}:{ss:02d}.{ms:03d}\t{bid_s}\t{ask_s}\t\t\t{flags}\r\n")
                rows += 1
            d += dt.timedelta(days=1)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default="2026-10-05", help="first day (YYYY-MM-DD)")
    ap.add_argument("--days", type=int, default=5, help="number of weekdays to generate")
    ap.add_argument("--out", default="sample_ticks.csv")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    n = generate(dt.date.fromisoformat(a.start), a.days, a.out, a.seed)
    print(f"wrote {n} ticks to {a.out}")


if __name__ == "__main__":
    main()
