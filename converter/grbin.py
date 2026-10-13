"""Binary day-file format shared by the converter and the browser app.

Layout (little-endian), one file per trading day:

    offset  size  field
    0       4     magic  b"GRPL"
    4       2     format version (uint16) = 1
    6       1     price digits (uint8), e.g. 2 -> prices stored as price * 100
    7       1     reserved (0)
    8       16    symbol, ASCII, NUL padded
    24      12    date "YYYY-MM-DD", ASCII, NUL padded
    36      4     tick count N (uint32)
    40      8     reserved (0)
    48      4*N   time   uint32  ms since 00:00:00.000 of the day (broker server time)
    48+4N   4*N   bid    int32   price * 10**digits
    48+8N   4*N   ask    int32   price * 10**digits

The header is 48 bytes so every array starts 4-byte aligned and the browser can
view the arrays directly (Uint32Array / Int32Array) without copying.
"""

from __future__ import annotations

import struct
import sys
from array import array
from dataclasses import dataclass

MAGIC = b"GRPL"
VERSION = 1
HEADER_SIZE = 48
_HEADER = struct.Struct("<4sHBB16s12sI8s")
assert _HEADER.size == HEADER_SIZE


@dataclass
class DayTicks:
    symbol: str
    date: str  # YYYY-MM-DD
    digits: int
    times: array  # 'I' ms since day start
    bids: array  # 'i' scaled
    asks: array  # 'i' scaled

    @property
    def count(self) -> int:
        return len(self.times)


def _le(a: array) -> bytes:
    if sys.byteorder == "big":
        a = array(a.typecode, a)
        a.byteswap()
    return a.tobytes()


def write_day(path: str, day: DayTicks) -> None:
    n = day.count
    if not (len(day.bids) == n and len(day.asks) == n):
        raise ValueError("times/bids/asks length mismatch")
    header = _HEADER.pack(
        MAGIC,
        VERSION,
        day.digits,
        0,
        day.symbol.encode("ascii")[:16],
        day.date.encode("ascii")[:12],
        n,
        b"\0" * 8,
    )
    with open(path, "wb") as f:
        f.write(header)
        f.write(_le(day.times))
        f.write(_le(day.bids))
        f.write(_le(day.asks))


def read_header(path: str) -> tuple[str, str, int, int]:
    """Return (symbol, date, digits, tick_count) without reading the arrays."""
    with open(path, "rb") as f:
        raw = f.read(HEADER_SIZE)
    return _parse_header(raw)


def _parse_header(raw: bytes) -> tuple[str, str, int, int]:
    if len(raw) < HEADER_SIZE:
        raise ValueError("file too short for header")
    magic, version, digits, _r, sym, date, n, _r2 = _HEADER.unpack(raw[:HEADER_SIZE])
    if magic != MAGIC:
        raise ValueError("bad magic, not a gold-replay day file")
    if version != VERSION:
        raise ValueError(f"unsupported format version {version}")
    return (
        sym.rstrip(b"\0").decode("ascii"),
        date.rstrip(b"\0").decode("ascii"),
        digits,
        n,
    )


def read_time_bounds(path: str) -> tuple[int, int]:
    """First and last tick time (ms) without reading the whole file."""
    _, _, _, n = read_header(path)
    if n == 0:
        return 0, 0
    with open(path, "rb") as f:
        f.seek(HEADER_SIZE)
        first = struct.unpack("<I", f.read(4))[0]
        f.seek(HEADER_SIZE + 4 * (n - 1))
        last = struct.unpack("<I", f.read(4))[0]
    return first, last


def read_day(path: str) -> DayTicks:
    with open(path, "rb") as f:
        raw = f.read()
    symbol, date, digits, n = _parse_header(raw)
    expected = HEADER_SIZE + 12 * n
    if len(raw) != expected:
        raise ValueError(f"size mismatch: {len(raw)} bytes, expected {expected}")
    arrays = []
    for i, code in enumerate(("I", "i", "i")):
        a = array(code)
        start = HEADER_SIZE + 4 * n * i
        a.frombytes(raw[start : start + 4 * n])
        if sys.byteorder == "big":
            a.byteswap()
        arrays.append(a)
    return DayTicks(symbol, date, digits, arrays[0], arrays[1], arrays[2])
