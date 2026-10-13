// Reader for the daily .bin tick files written by converter/convert.py (layout in converter/grbin.py).

export const HEADER_SIZE = 48;

export interface DayData {
  date: string; // YYYY-MM-DD
  symbol: string;
  digits: number;
  /** Absolute ms of 00:00:00.000 server time of this date (server time treated as UTC). */
  dayStart: number;
  times: Uint32Array; // ms since day start
  bids: Int32Array; // price * 10**digits
  asks: Int32Array;
  count: number;
  scale: number;
}

export interface ManifestDay {
  date: string;
  file: string;
  ticks: number;
  digits: number;
  firstMs: number;
  lastMs: number;
}

export interface Manifest {
  symbol: string;
  digits: number;
  days: ManifestDay[];
}

export function dayStartMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function ascii(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

export function parseDay(buf: ArrayBuffer): DayData {
  if (buf.byteLength < HEADER_SIZE) throw new Error('day file too short');
  const dv = new DataView(buf);
  const magic = ascii(new Uint8Array(buf, 0, 4));
  if (magic !== 'GRPL') throw new Error('not a gold-replay day file');
  const version = dv.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported day file version ${version}`);
  const digits = dv.getUint8(6);
  const symbol = ascii(new Uint8Array(buf, 8, 16));
  const date = ascii(new Uint8Array(buf, 24, 12));
  const n = dv.getUint32(36, true);
  if (buf.byteLength !== HEADER_SIZE + 12 * n) throw new Error(`day file ${date}: size mismatch`);
  const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (!littleEndianHost) throw new Error('big-endian hosts are not supported');
  return {
    date,
    symbol,
    digits,
    dayStart: dayStartMs(date),
    times: new Uint32Array(buf, HEADER_SIZE, n),
    bids: new Int32Array(buf, HEADER_SIZE + 4 * n, n),
    asks: new Int32Array(buf, HEADER_SIZE + 8 * n, n),
    count: n,
    scale: 10 ** digits,
  };
}

/** Index of the first tick with absolute time >= t (count if none). */
export function lowerBound(day: DayData, absMs: number): number {
  const rel = absMs - day.dayStart;
  let lo = 0;
  let hi = day.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (day.times[mid] < rel) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
