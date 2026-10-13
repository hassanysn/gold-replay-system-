"""Converter tests: python -m unittest discover converter"""

from __future__ import annotations

import codecs
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import convert  # noqa: E402
import grbin  # noqa: E402
import make_sample  # noqa: E402


def write_export(path: str, lines: list[str], encoding: str = "utf-16") -> None:
    with open(path, "w", encoding=encoding, newline="") as f:
        f.write("<DATE>\t<TIME>\t<BID>\t<ASK>\t<LAST>\t<VOLUME>\t<FLAGS>\r\n")
        for ln in lines:
            f.write(ln + "\r\n")


def fmt(v: int, digits: int) -> str:
    s = str(v).rjust(digits + 1, "0")
    return f"{s[:-digits]}.{s[-digits:]}" if digits else s


class ParsingTests(unittest.TestCase):
    def test_scale_price_exact(self):
        self.assertEqual(convert.scale_price("2650.45", 2), 265045)
        self.assertEqual(convert.scale_price("2650.4", 2), 265040)
        self.assertEqual(convert.scale_price("2650", 2), 265000)
        self.assertEqual(convert.scale_price("2650.455", 3), 2650455)
        self.assertEqual(convert.scale_price("2650.450", 2), 265045)
        with self.assertRaises(ValueError):
            convert.scale_price("2650.455", 2)

    def test_time_and_date(self):
        self.assertEqual(convert.parse_time_ms("14:30:01.123"), ((14 * 60 + 30) * 60 + 1) * 1000 + 123)
        self.assertEqual(convert.parse_time_ms("00:00:00"), 0)
        self.assertEqual(convert.parse_time_ms("00:00:00.5"), 500)
        self.assertEqual(convert.parse_date("2026.10.12"), "2026-10-12")

    def test_forward_fill_and_skips(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "t.csv")
            write_export(
                src,
                [
                    "2026.10.12\t01:00:00.100\t2650.10\t\t\t\t2",  # ask unknown yet -> skipped
                    "2026.10.12\t01:00:00.200\t\t2650.30\t\t\t4",  # bid filled 2650.10
                    "2026.10.12\t01:00:00.300\t2650.20\t\t\t\t2",  # ask filled 2650.30
                    "2026.10.12\t01:00:00.400\t\t\t2650.25\t1\t8",  # no quote -> skipped
                    "2026.10.13\t01:00:00.000\t\t2651.00\t\t\t4",  # fill crosses days
                ],
            )
            convert.convert([src], tmp, "XAUUSD", None, False)
            d12 = grbin.read_day(os.path.join(tmp, "XAUUSD", "2026-10-12.bin"))
            self.assertEqual(list(d12.times), [200 + 3_600_000, 300 + 3_600_000])
            self.assertEqual(list(d12.bids), [265010, 265020])
            self.assertEqual(list(d12.asks), [265030, 265030])
            d13 = grbin.read_day(os.path.join(tmp, "XAUUSD", "2026-10-13.bin"))
            self.assertEqual((list(d13.bids), list(d13.asks)), ([265020], [265100]))
            m = json.load(open(os.path.join(tmp, "XAUUSD", "manifest.json")))
            self.assertEqual([d["date"] for d in m["days"]], ["2026-10-12", "2026-10-13"])
            self.assertEqual(m["days"][0]["ticks"], 2)

    def test_utf8_and_comma_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "t.csv")
            with open(src, "w", encoding="utf-8") as f:
                f.write("<DATE>,<TIME>,<BID>,<ASK>,<LAST>,<VOLUME>,<FLAGS>\n")
                f.write("2026.10.12,10:00:00.000,2650.10,2650.30,,,6\n")
            convert.convert([src], tmp, "XAUUSD", None, False)
            d = grbin.read_day(os.path.join(tmp, "XAUUSD", "2026-10-12.bin"))
            self.assertEqual(d.count, 1)


class RealExportTests(unittest.TestCase):
    """Excerpt of a real MT5 tick export (broker symbol XAUUSD.m): UTF-8 without BOM, CRLF,
    trade-only rows (flags 96) with no bid/ask, and bid-only rows (flags 98)."""

    FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "mt5_xauusd_m_excerpt.csv")

    def test_real_export_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            convert.convert([self.FIXTURE], tmp, "XAUUSD", None, False)
            d = grbin.read_day(os.path.join(tmp, "XAUUSD", "2026-10-13.bin"))
            rows = [ln.split("\t") for ln in open(self.FIXTURE, encoding="utf-8").read().splitlines()[1:]]
            quoted = [r for r in rows if r[2] or r[3]]
            self.assertEqual(d.digits, 2)
            self.assertEqual(d.count, len(quoted))
            self.assertEqual(d.times[0], convert.parse_time_ms("10:00:00.035"))
            self.assertEqual((d.bids[0], d.asks[0]), (419180, 419206))
            # a bid-only row keeps the previous ask
            i = next(k for k, r in enumerate(quoted) if not r[3])
            self.assertEqual(d.asks[i], d.asks[i - 1])
            self.assertEqual(d.bids[i], convert.scale_price(quoted[i][2], 2))


class RoundTripTests(unittest.TestCase):
    def test_sample_roundtrip_exact_and_rerun(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "sample.csv")
            make_sample.generate(__import__("datetime").date(2026, 10, 9), 2, src, mean_gap_ms=3000)
            with open(src, "rb") as f:
                self.assertTrue(f.read(2) == codecs.BOM_UTF16_LE)
            out = os.path.join(tmp, "data")
            self.assertEqual(convert.convert([src], out, "XAUUSD", None, False), 2)

            # Independent re-read of the text: forward-filled strings must match the binary exactly.
            expected: dict[str, list[tuple[int, str, str]]] = {}
            last_b = last_a = None
            with open(src, encoding="utf-16") as f:
                next(f)
                for line in f:
                    c = line.rstrip("\r\n").split("\t")
                    last_b = c[2] or last_b
                    last_a = c[3] or last_a
                    if last_b is None or last_a is None:
                        continue
                    date = c[0].replace(".", "-")
                    expected.setdefault(date, []).append((convert.parse_time_ms(c[1]), last_b, last_a))
            self.assertEqual(sorted(expected), ["2026-10-09", "2026-10-12"])  # weekend skipped
            for date, rows in expected.items():
                d = grbin.read_day(os.path.join(out, "XAUUSD", f"{date}.bin"))
                self.assertEqual(d.count, len(rows))
                got = [(d.times[i], fmt(d.bids[i], d.digits), fmt(d.asks[i], d.digits)) for i in range(d.count)]
                self.assertEqual(got, rows)

            # Re-running adds nothing and leaves old days untouched.
            self.assertEqual(convert.convert([src], out, "XAUUSD", None, False), 0)
            self.assertEqual(convert.convert([src], out, "XAUUSD", None, True), 2)


if __name__ == "__main__":
    unittest.main()
