import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CandleBuilder } from '../src/core/candles';
import { type DayData, dayStartMs, type ManifestDay, parseDay } from '../src/core/daydata';
import { DEFAULT_ACCOUNT, Engine } from '../src/core/engine';
import { GAP_SKIP_MS, Replay } from '../src/core/replay';

function readFixture(): DayData {
  const b = readFileSync(new URL('./fixtures/XAUUSD/2026-10-12.bin', import.meta.url));
  return parseDay(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** Builds a DayData from [ms-of-day, bid, ask] rows (2 digits). */
function day(date: string, rows: [number, number, number][]): DayData {
  return {
    date,
    symbol: 'XAUUSD',
    digits: 2,
    dayStart: dayStartMs(date),
    times: Uint32Array.from(rows.map((r) => r[0])),
    bids: Int32Array.from(rows.map((r) => Math.round(r[1] * 100))),
    asks: Int32Array.from(rows.map((r) => Math.round(r[2] * 100))),
    count: rows.length,
    scale: 100,
  };
}

function manifestOf(days: DayData[]): ManifestDay[] {
  return days.map((d) => ({ date: d.date, file: `${d.date}.bin`, ticks: d.count, digits: 2, firstMs: d.times[0], lastMs: d.times[d.count - 1] }));
}

const AP = { zone: true, fill: true, sl: true, stage: true };
const H = 3_600_000;
const M = 60_000;

function setup(days: DayData[], ap = AP) {
  const engine = new Engine({ ...DEFAULT_ACCOUNT, lotPer100: 0 }, 10_000, 2);
  const r = new Replay(manifestOf(days), engine, ap);
  days.forEach((d, i) => r.setDay(i, d));
  return r;
}

describe('day file reader', () => {
  it('reads the converter output exactly (forward-filled)', () => {
    const d = readFixture();
    expect(d.date).toBe('2026-10-12');
    expect(d.symbol).toBe('XAUUSD');
    expect(d.digits).toBe(2);
    expect([...d.times]).toEqual([3600100, 3600250, 52201123, 86219999]);
    expect([...d.bids]).toEqual([265010, 265010, 265105, 264999]);
    expect([...d.asks]).toEqual([265030, 265035, 265035, 265020]);
  });
});

describe('candles', () => {
  it('builds bid OHLC per timeframe and reports changed bars', () => {
    const c = new CandleBuilder(M);
    c.add(0, 10);
    c.add(1000, 12);
    c.add(2000, 9);
    c.add(M, 11);
    expect(c.bars).toEqual([
      { time: 0, open: 10, high: 12, low: 9, close: 9 },
      { time: 60, open: 11, high: 11, low: 11, close: 11 },
    ]);
    expect(c.takeDirty().length).toBe(2);
    c.add(M + 1, 13);
    expect(c.takeDirty()).toEqual([{ time: 60, open: 11, high: 13, low: 11, close: 13 }]);
  });
});

describe('replay', () => {
  const d1 = day('2026-10-09', [
    [H, 2000, 2000.2],
    [H + 30_000, 2001, 2001.2],
    [H + M + 1, 2002, 2002.2],
    [H + 20 * M, 2003, 2003.2],
    [23 * H, 2004, 2004.2],
  ]);
  const d2 = day('2026-10-12', [
    [H, 2010, 2010.2],
    [H + 5_000, 2011, 2011.2],
  ]);

  it('hides everything after the start time and builds history candles', () => {
    const r = setup([d1, d2]);
    r.start(0, d1.dayStart + H + M, 0);
    expect(r.candles.M1.bars.map((b) => b.close)).toEqual([2001]);
    expect(r.bid).toBe(2001);
    expect(r.peekTime()).toBe(d1.dayStart + H + M + 1);
  });

  it('plays with real tick gaps and never shows future ticks', () => {
    const r = setup([d1, d2]);
    r.start(0, d1.dayStart + H + M, 0);
    r.play(0); // nothing due yet
    expect(r.bid).toBe(2001);
    r.play(2); // reaches H+M+1
    expect(r.bid).toBe(2002);
    r.play(10 * M); // 19 min gap is not skipped
    expect(r.bid).toBe(2002);
    r.play(10 * M);
    expect(r.bid).toBe(2003);
  });

  it('skips long gaps and continues into the next day file (weekend skipped)', () => {
    const r = setup([d1, d2]);
    r.start(0, d1.dayStart + H + 20 * M + 1, 0);
    r.play(1000); // gap to 23:00 > 30 min -> jump
    expect(r.bid).toBe(2004);
    r.play(1000); // Friday -> Monday
    expect(r.bid).toBe(2010);
    expect(r.di).toBe(1);
    expect(GAP_SKIP_MS).toBe(30 * M);
  });

  it('asks for the next day file when it is not loaded', () => {
    const engine = new Engine(DEFAULT_ACCOUNT, 50, 2);
    const r = new Replay(manifestOf([d1, d2]), engine, AP);
    r.setDay(0, d1);
    r.start(0, d1.dayStart + 23 * H + 1, 0);
    const res = r.play(1000);
    expect(res.needDay).toBe(1);
    r.setDay(1, d2);
    r.play(1000);
    expect(r.bid).toBe(2010);
  });

  it('steps one M1 candle and to the next M15 close', () => {
    const r = setup([d1, d2]);
    r.start(0, d1.dayStart + H, 0);
    r.step(M);
    expect(r.clock).toBe(d1.dayStart + H + M);
    expect(r.candles.M1.bars.map((b) => b.close)).toEqual([2001]);
    r.step(M); // next minute has the tick at H+M+1
    expect(r.clock).toBe(d1.dayStart + H + 2 * M);
    expect(r.bid).toBe(2002);
    r.step(15 * M);
    expect(r.clock).toBe(d1.dayStart + H + 15 * M);
    r.step(15 * M); // next tick at H+20M -> close at H+30M
    expect(r.clock).toBe(d1.dayStart + H + 30 * M);
    expect(r.bid).toBe(2003);
  });

  it('fills an order on the first tick at or after the click', () => {
    const r = setup([d1, d2]);
    r.start(0, d1.dayStart + H + M, 0);
    r.engine.placeOrder('buy', 0.1);
    r.processNextTick();
    expect(r.engine.ladders[0].tickets[0].openPrice).toBe(2002.2);
  });

  it('auto-pauses on fill, SL, stage and zone touch (each can be turned off)', () => {
    const rows: [number, number, number][] = [];
    for (let i = 0; i < 200; i++) rows.push([H + i * 1000, 2000 + i * 0.1, 2000.2 + i * 0.1]);
    const d = day('2026-10-09', rows);
    const r = setup([d]);
    r.start(0, d.dayStart + H + 500, 0);
    r.engine.placeOrder('buy', 0.1);
    expect(r.play(10 * M).pausedBy).toBe('Ticket filled'); // fills at 2000.3 (tick 1)
    expect(r.play(10 * M).pausedBy).toBe('BE allowed (+30)');
    expect(r.bid).toBeCloseTo(2003.3, 6); // fill at ask 2000.30 + 30 pips
    r.setZones([{ id: 'z', t1: d.dayStart, t2: d.dayStart + 1, low: 2004, high: 2005, extendRight: true }]);
    expect(r.play(10 * M).pausedBy).toBe('Price touched a zone');
    expect(r.bid).toBeCloseTo(2004, 6);
    expect(r.play(10 * M).pausedBy).toBe('Stage 2 reached (+50)');
    r.autoPause = { ...AP, stage: false };
    expect(r.play(10 * M).pausedBy).toBe(null);
    expect(r.engine.ladders[0].stage).toBe(3);
  });

  it('does not auto-pause on a zone that does not extend right once its time has passed', () => {
    const d = day('2026-10-09', [
      [H, 2000, 2000.2],
      [H + 1000, 2010, 2010.2],
      [H + 2000, 2000, 2000.2],
      [H + 3000, 2010, 2010.2],
    ]);
    const r = setup([d]);
    r.start(0, d.dayStart + H + 1, 0);
    r.setZones([{ id: 'z', t1: d.dayStart, t2: d.dayStart + H + 1500, low: 2005, high: 2015, extendRight: false }]);
    expect(r.play(1000).pausedBy).toBe('Price touched a zone');
    expect(r.play(5000).pausedBy).toBe(null);
  });

  it('is deterministic: same data and actions give the same results', () => {
    const run = () => {
      const rows: [number, number, number][] = [];
      let p = 2000;
      for (let i = 0; i < 5000; i++) {
        p += Math.sin(i * 0.37) * 0.3 + Math.cos(i * 0.011) * 0.05;
        rows.push([H + i * 700, +p.toFixed(2), +(p + 0.25).toFixed(2)]);
      }
      const d = day('2026-10-09', rows);
      const r = setup([d], { zone: false, fill: false, sl: false, stage: false });
      r.start(0, d.dayStart + H + 1, 0);
      r.engine.placeOrder('buy', 0.05);
      r.play(60_000);
      r.engine.setSL(1, r.bid - 3);
      r.play(600_000);
      r.engine.closeAll();
      r.play(60_000);
      return JSON.stringify([r.engine.balance, r.takeEvents(), r.candles.M1.bars]);
    };
    expect(run()).toBe(run());
  });
});

describe('replay events', () => {
  it('delivers engine events from user actions without waiting for the next tick', () => {
    const d = day('2026-10-09', [
      [H, 2000, 2000.2],
      [H + 1000, 2001, 2001.2],
    ]);
    const r = setup([d]);
    r.start(0, d.dayStart + H + 1, 0);
    r.engine.placeOrder('buy', 0.1);
    r.processNextTick();
    r.takeEvents();
    r.engine.placeOrder('sell', 0); // invalid lot
    r.engine.closeLadder(1);
    const types = r.takeEvents().map((e) => e.type);
    expect(types).toEqual(['rejected', 'ladderClosed']);
  });
});
