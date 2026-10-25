import { describe, expect, it } from 'vitest';
import type { Deal, EaLadder, EaState, LivePosition, Poll } from '../src/live/api';
import { buildRecord, postCloseFromRange } from '../src/live/journal';
import { DEFAULT_EA_SETTINGS, LiveState, lotCap } from '../src/live/state';

const pos = (ticket: number, dir: 'buy' | 'sell', lot: number, openPrice: number, sl: number | null = null, profit = 0): LivePosition => ({
  ticket,
  dir,
  lot,
  openPrice,
  openTime: 1_000_000 + ticket,
  sl,
  tp: null,
  profit,
  magic: 0,
});

const ladder = (o: Partial<EaLadder>): EaLadder => ({
  id: 1,
  rank: 1,
  side: 0,
  stage: 0,
  anchor: 0,
  next: 0,
  pending: 0,
  sl: 0,
  tp: 0,
  riskSeen: false,
  riskMax: 0,
  firstSL: 0,
  risk1: 0,
  bePulled: false,
  start: 100,
  current: true,
  tickets: [],
  ...o,
});

const ea = (ladders: EaLadder[], o: Partial<EaState> = {}): EaState => ({
  version: '3.0-s6',
  symbol: 'XAUUSD.m',
  time: 0,
  lotCap: 0.05,
  canNewLadder: false,
  newLadderWhy: 'L1 is not at BE yet (-$2.00 if SL hits)',
  cmd: { seq: 0, ok: false, msg: '' },
  settings: DEFAULT_EA_SETTINGS,
  ladders,
  age: 0.4,
  running: true,
  ...o,
});

const poll = (positions: LivePosition[], e: EaState | null, bid = 2000, o: Partial<Poll> = {}): Poll => ({
  quote: { time: 2_000_000, bid, ask: bid + 0.2 },
  bars: { M1: [], M15: [], M30: [] },
  positions,
  ea: e,
  tradeAllowed: true,
  account: { balance: 50, equity: 50, margin: 0, margin_free: 50, margin_level: 0, profit: 0 },
  lotCap: 0.05,
  ...o,
});

describe('live lot cap', () => {
  it('is 0.10 lot per $100, rounded down (0.05 for $50)', () => {
    expect([lotCap(50), lotCap(100), lotCap(149.99), lotCap(9)]).toEqual([0.05, 0.1, 0.14, 0]);
  });
});

describe('LiveState with the EA running', () => {
  it('shows the EA ladders, stage text, R and IF SL HITS; opposite tickets are unmanaged', () => {
    const s = new LiveState(100, 2);
    const ps = [pos(11, 'buy', 0.01, 2000.2, 1998.2, 0.5), pos(12, 'buy', 0.01, 2000.6, 1998.2, 0.3), pos(13, 'sell', 0.01, 2001, null)];
    const r = s.update(poll(ps, ea([ladder({ tickets: [11, 12], sl: 1998.2, riskSeen: true, riskMax: -4.4, firstSL: 1998.2, risk1: -4.4 })])));
    expect(r.eaOn).toBe(true);
    const l = r.snap.ladders[0];
    expect(l.ticketCount).toBe(2);
    expect(l.avg).toBeCloseTo(2000.4, 6);
    expect(l.ifSLHits).toBe(-4.4);
    expect(l.R).toBe(4.4);
    expect(l.ifClosedNow).toBe(0.8);
    expect(l.stageText).toBe('stage 2 at 2005.40 -> SL 2002.40 locks +$4.00');
    expect(l.beText).toBe('BE from 2003.40');
    expect(r.snap.unmanaged.map((t) => t.id)).toEqual([13]);
    expect(r.snap.canNewLadder).toBe(false);
    expect(r.snap.newLadderWhy).toMatch(/not at BE/);
    expect(s.joinInfo(r, 'buy')).toEqual({ lots: 0.02, opposite: false, ladder: 'L1' });
    expect(s.joinInfo(r, 'sell').opposite).toBe(true);
  });

  it('uses the frozen average after stage 2 and offers PULL BACK TO BE when the SL is better than BE', () => {
    const s = new LiveState(100, 2);
    const ps = [pos(11, 'buy', 0.01, 2000.2, 2002.2)];
    const r = s.update(poll(ps, ea([ladder({ tickets: [11], stage: 2, anchor: 2000.2, next: 2010.2, sl: 2002.2 })]), 2005.3));
    const l = r.snap.ladders[0];
    expect(l.avg).toBe(2000.2);
    expect(l.beText).toBe('BE done');
    expect(l.bePullBack).toBe(true);
    expect(l.stageText).toMatch(/^STAGE 2 done \| stage 3 at 2010.20 -> SL 2005.20/);
  });

  it('journals a ladder when its last ticket closes, from the MT5 deals', () => {
    const s = new LiveState(100, 2);
    const L = ladder({ tickets: [11, 12], sl: 1998.2, riskSeen: true, riskMax: -4.4, firstSL: 1998.2, risk1: -4.4 });
    s.update(poll([pos(11, 'buy', 0.01, 2000.2, 1998.2), pos(12, 'buy', 0.01, 2000.6, 1998.2)], ea([L])));
    const r = s.update(poll([], ea([])));
    expect(r.closed.length).toBe(1);
    const t = r.closed[0];
    const deals: Deal[] = [
      { ticket: 1, position: 11, time: 1000, entry: 'in', dir: 'buy', lot: 0.01, price: 2000.2, profit: 0, commission: -0.05, swap: 0, fee: 0, reason: 0 },
      { ticket: 2, position: 12, time: 1100, entry: 'in', dir: 'buy', lot: 0.01, price: 2000.6, profit: 0, commission: -0.05, swap: 0, fee: 0, reason: 0 },
      { ticket: 3, position: 11, time: 5000, entry: 'out', dir: 'sell', lot: 0.01, price: 1998.2, profit: -2, commission: -0.05, swap: 0, fee: 0, reason: 4 },
      { ticket: 4, position: 12, time: 5001, entry: 'out', dir: 'sell', lot: 0.01, price: 1998.2, profit: -2.4, commission: -0.05, swap: 0, fee: 0, reason: 4 },
    ];
    const rec = buildRecord(t, deals, 100, 45.4, 777)!;
    expect(rec.kind).toBe('ladder');
    expect(rec.exitReason).toBe('SL');
    expect(rec.result).toBe(-4.6);
    expect(rec.R).toBe(4.4);
    expect(rec.resultR).toBe(-1.05);
    expect(rec.closedBy.sl).toBe(2);
    expect(rec.ticketCount).toBe(2);
    expect(rec.avgEntry).toBeCloseTo(2000.4, 6);
    expect(rec.worstEntry).toBe(2000.6);
    expect(rec.closeTime).toBe(5001);
    expect(rec.id).toBe('live-777-ea-1-100-5001');
    expect(postCloseFromRange(rec, 2004.4, 1990)).toBe(40);
  });

  it('drops an unmanaged ticket silently when the EA adopts it into a ladder', () => {
    const s = new LiveState(100, 2);
    s.update(poll([pos(11, 'buy', 0.01, 2000.2), pos(13, 'sell', 0.01, 2001)], ea([ladder({ tickets: [11] })])));
    const r = s.update(poll([pos(13, 'sell', 0.01, 2001)], ea([ladder({ id: 2, start: 200, side: 1, tickets: [13] })])));
    // ladder 1 closed (ticket 11 gone) -> journaled; ticket 13 moved into ladder 2 -> not journaled
    expect(r.closed.map((t) => t.key)).toEqual(['ea:1:100']);
    expect(r.unmanaged.length).toBe(0);
    expect(r.snap.ladders.map((l) => l.ticketCount)).toEqual([1]);
  });
});

describe('LiveState without the EA', () => {
  it('groups by direction, keeps the ladder id, and refuses NEW LADDER', () => {
    const s = new LiveState(100, 2);
    let r = s.update(poll([pos(11, 'buy', 0.01, 2000.2)], null));
    const id = r.snap.ladders[0].id;
    r = s.update(poll([pos(11, 'buy', 0.01, 2000.2), pos(12, 'buy', 0.02, 2001), pos(13, 'sell', 0.01, 2001)], null));
    expect(r.eaOn).toBe(false);
    expect(r.snap.ladders.map((l) => [l.id === id, l.dir, l.ticketCount])).toEqual([
      [true, 'buy', 2],
      [false, 'sell', 1],
    ]);
    expect(r.snap.canNewLadder).toBe(false);
    expect(r.snap.ladders[0].stageText).toMatch(/EA not running/);
    expect(r.openedTickets).toEqual([12, 13]);
    // the first ticket closes: the ladder goes on with the second one (same id), nothing journaled
    r = s.update(poll([pos(12, 'buy', 0.02, 2001), pos(13, 'sell', 0.01, 2001)], null));
    expect(r.closed).toEqual([]);
    expect(r.closedTickets).toEqual([11]);
    expect(r.snap.ladders[0].id).toBe(id);
  });

  it('tracks R from the first SL and counts SL edits', () => {
    const s = new LiveState(100, 2);
    s.update(poll([pos(11, 'buy', 0.01, 2000.2, 1998.2)], null));
    s.update(poll([pos(11, 'buy', 0.01, 2000.2, 1997.2)], null)); // widened
    const r = s.update(poll([pos(11, 'buy', 0.01, 2000.2, 2000.3)], null, 2003.5)); // BE
    const t = r.groups[0].tracker;
    expect([t.firstSL, t.risk1, t.riskMax, t.slEdits, t.slWidened, t.beApplied]).toEqual([1998.2, -2, -3, 2, true, true]);
    expect(r.snap.ladders[0].R).toBe(3);
  });
});
