import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, Engine, type EngineEvent, feedTracker, POST_CLOSE_TRACK_MS } from '../src/core/engine';
import { pipsBetween, pipsFrom, priceAtPips, profit, weightedAverage } from '../src/core/pips';

const SPREAD = 0.2;

/** Engine with a big balance so margin never interferes unless a test wants it to. */
function mk(opts: Partial<typeof DEFAULT_ACCOUNT> = {}, balance = 100_000) {
  const e = new Engine({ ...DEFAULT_ACCOUNT, slBufferPips: 0, ...opts }, balance, 2);
  let t = 1000;
  const tick = (bid: number, ask = +(bid + SPREAD).toFixed(2)) => {
    t += 1000;
    e.onTick(t, bid, ask);
    return e.takeEvents();
  };
  tick(2000);
  return { e, tick };
}

function open(e: Engine, tick: (b: number, a?: number) => EngineEvent[], dir: 'buy' | 'sell', lot: number, bid: number) {
  expect(e.placeOrder(dir, lot).ok).toBe(true);
  return tick(bid);
}

const types = (ev: EngineEvent[]) => ev.map((x) => x.type);

describe('pip math', () => {
  it('measures buy pips from bid and sell pips from ask', () => {
    expect(pipsFrom('buy', 2000, 2003, 2003.2)).toBe(30);
    expect(pipsFrom('sell', 2000, 1996.8, 1997)).toBe(30);
    expect(pipsFrom('buy', 2000, 1999, 1999.2)).toBe(-10);
    expect(pipsFrom('sell', 2000, 2000.8, 2001)).toBe(-10);
    expect(pipsFrom('buy', 2650.07, 2653.07, 0)).toBe(30); // float noise removed
  });
  it('converts pips to prices in the profit direction', () => {
    expect(priceAtPips('buy', 2000, 20)).toBeCloseTo(2002, 9);
    expect(priceAtPips('sell', 2000, 20)).toBeCloseTo(1998, 9);
    expect(pipsBetween('sell', 2000, 1995)).toBe(50);
  });
  it('uses $10 per pip per lot and $1 per pip for 0.10 lot', () => {
    expect(profit('buy', 1, 2000, 2000.1, 100)).toBeCloseTo(10, 9);
    expect(profit('sell', 0.1, 2000, 1999.9, 100)).toBeCloseTo(1, 9);
  });
  it('computes a lot-weighted average', () => {
    expect(weightedAverage([{ lot: 0.01, price: 2000 }, { lot: 0.03, price: 2004 }])).toBeCloseTo(2003, 9);
  });
});

describe('order engine', () => {
  it('fills buy at ask and sell at bid on the next tick', () => {
    const { e, tick } = mk();
    e.placeOrder('buy', 0.1);
    expect(e.snapshot().ladders.length).toBe(0); // queued until the next tick
    const ev = tick(2001, 2001.25);
    expect(ev[0]).toMatchObject({ type: 'fill', ticket: { openPrice: 2001.25, dir: 'buy' } });
    const { e: e2, tick: t2 } = mk();
    e2.placeOrder('sell', 0.1);
    expect(t2(2001, 2001.25)[0]).toMatchObject({ type: 'fill', ticket: { openPrice: 2001 } });
  });

  it('triggers buy SL on bid and sell SL on ask, closing at that price', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // fills at 2000.20
    e.setSL(1, 1999);
    expect(types(tick(1999.05, 1998.9))).not.toContain('sl'); // ask below SL does not trigger a buy
    const ev = tick(1999, 1999.2);
    expect(types(ev)).toContain('sl');
    const rec = ev.find((x) => x.type === 'ladderClosed');
    expect(rec).toMatchObject({ record: { exitReason: 'SL', result: -12 } }); // (1999 - 2000.2) * 10

    const s = mk();
    open(s.e, s.tick, 'sell', 0.1, 2000); // fills at 2000.00
    s.e.setSL(1, 2001);
    expect(types(s.tick(2001.1, 2000.9))).not.toContain('sl'); // bid above SL does not trigger a sell
    expect(types(s.tick(2000.8, 2001))).toContain('sl');
    expect(s.e.balance).toBeCloseTo(100_000 - 10, 6);
  });

  it('closes at TP', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000);
    e.setTP(1, 2001);
    const ev = tick(2001.05);
    expect(ev.find((x) => x.type === 'ladderClosed')).toMatchObject({ record: { exitReason: 'TP' } });
  });

  it('rejects orders without enough free margin', () => {
    const { e, tick } = mk({}, 50);
    e.placeOrder('buy', 1); // needs 2000*100/3000 = $66.67
    const ev = tick(2000);
    expect(ev[0].type).toBe('rejected');
    open(e, tick, 'buy', 0.1, 2000);
    expect(e.snapshot().margin).toBeCloseTo((0.1 * 100 * 2000.2) / 3000, 6);
  });

  it('computes equity, margin and margin level live', () => {
    const { e, tick } = mk({}, 50);
    open(e, tick, 'buy', 0.1, 2000);
    tick(2001.2);
    const s = e.snapshot();
    expect(s.equity).toBeCloseTo(60, 6);
    expect(s.marginLevel).toBeCloseTo((60 / ((0.1 * 100 * 2000.2) / 3000)) * 100, 6);
  });
});

describe('ladder grouping', () => {
  it('puts every new ticket in the active ladder and averages lot-weighted', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000); // 2000.2
    open(e, tick, 'buy', 0.03, 1996); // 1996.2
    const s = e.snapshot();
    expect(s.ladders.length).toBe(1);
    expect(s.ladders[0].ticketCount).toBe(2);
    expect(s.ladders[0].totalLot).toBe(0.04);
    expect(s.ladders[0].avg).toBeCloseTo(1997.2, 9);
  });

  it('blocks a ticket opposite to an open ladder', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    expect(e.placeOrder('sell', 0.01).ok).toBe(false);
  });

  it('enables New ladder only after stage 2 and allows max 3 ladders', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000); // avg 2000.2
    expect(e.canNewLadder()).toBe(false);
    expect(e.newLadder()).toBe(false);
    tick(2003.2); // +30
    expect(e.canNewLadder()).toBe(false);
    tick(2005.2); // +50 -> stage 2
    expect(e.canNewLadder()).toBe(true);
    expect(e.newLadder()).toBe(true);
    open(e, tick, 'buy', 0.01, 2005.2); // ladder 2, avg 2005.4
    expect(e.snapshot().ladders.map((l) => l.ticketCount)).toEqual([1, 1]);
    expect(e.canNewLadder()).toBe(false);
    tick(2010.4); // ladder 2 +50
    expect(e.newLadder()).toBe(true);
    open(e, tick, 'buy', 0.01, 2010.4); // ladder 3
    tick(2015.6); // ladder 3 +50
    expect(e.openLadders().length).toBe(3);
    expect(e.canNewLadder()).toBe(false); // max 3
    expect(e.newLadder()).toBe(false);
    open(e, tick, 'buy', 0.01, 2015.6); // joins the active ladder 3
    expect(e.ladder(3)!.tickets.length).toBe(2);
  });

  it('opens a new ladder when the active one is closed', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    e.closeLadder(1);
    open(e, tick, 'buy', 0.01, 2000);
    expect(e.snapshot().ladders[0].id).toBe(2);
  });
});

describe('R', () => {
  it('freezes R at the first SL set and grows it only when widened before BE', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // 2000.2
    open(e, tick, 'buy', 0.1, 1999); // 1999.2, avg 1999.7
    e.setSL(1, 1998.7); // loss = (1.5 + 0.5) * 10 = 20
    expect(e.ladder(1)!.R).toBeCloseTo(20, 6);
    e.setSL(1, 1999.2); // tightened: R stays
    expect(e.ladder(1)!.R).toBeCloseTo(20, 6);
    e.setSL(1, 1997.7); // widened: (2.5 + 1.5) * 10 = 40
    expect(e.ladder(1)!.R).toBeCloseTo(40, 6);
    e.setSL(1, 1998.0); // tightened again: never decreases
    expect(e.ladder(1)!.R).toBeCloseTo(40, 6);
    expect(e.ladder(1)!.originalSL).toBe(1998.7);
  });

  it('does not grow R when the SL is widened after BE', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // 2000.2
    e.setSL(1, 1999.2); // R = 10
    tick(2003.2); // +30
    e.applyBE(1);
    expect(e.ladder(1)!.sl).toBe(2000.3); // avg + 1 pip (buffer 0 in this test)
    e.setSL(1, 1998.2); // user drags it far back
    expect(e.ladder(1)!.R).toBeCloseTo(10, 6);
  });

  it('reports result in R', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // 2000.2
    e.setSL(1, 1999.2); // R = 10
    tick(2002.2);
    e.closeLadder(1);
    const rec = e.takeEvents().find((x) => x.type === 'ladderClosed');
    expect(rec).toMatchObject({ record: { result: 20, resultR: 2, resultPips: 20, exitReason: 'manual close' } });
  });
});

describe('SL/TP sync', () => {
  it('applies one SL to every ticket of the ladder', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    open(e, tick, 'buy', 0.01, 2001);
    e.setSL(1, 1998);
    e.setTP(1, 2010);
    expect(e.ladder(1)!.tickets.map((t) => [t.sl, t.tp])).toEqual([
      [1998, 2010],
      [1998, 2010],
    ]);
  });

  it('skips a ticket for which the synced stop is invalid and notices it', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    e.setSL(1, 1999);
    // Make only this one ticket's SL differ, then sync an SL above the current bid -> invalid for all.
    e.setSL(1, 2000.5); // bid is 2000 -> wrong side
    const ev = e.takeEvents();
    expect(ev.some((x) => x.type === 'notice' && x.text.includes('skipped'))).toBe(true);
    expect(e.ladder(1)!.tickets[0].sl).toBe(1999); // untouched
    expect(e.ladder(1)!.sl).toBe(1999);
  });

  it('a new ticket inherits the ladder SL/TP when valid', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    e.setSL(1, 1998);
    open(e, tick, 'buy', 0.01, 1999);
    expect(e.ladder(1)!.tickets[1].sl).toBe(1998);
    // SL above price: new ticket skips it with a notice
    const s = mk();
    open(s.e, s.tick, 'buy', 0.01, 2000);
    s.tick(2006); // +58 -> stage 2 SL = avg+20 = 2002.2
    const ev = open(s.e, s.tick, 'buy', 0.01, 2001);
    expect(ev.some((x) => x.type === 'notice')).toBe(true);
    expect(s.e.ladder(1)!.tickets[1].sl).toBe(null);
  });
});

describe('management stages', () => {
  it('BE becomes available at +30 (not before) and sets avg + 1 pip', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    e.setSL(1, 1999.2);
    tick(2003.1); // +29
    expect(e.snapshot().ladders[0].beEnabled).toBe(false);
    const ev = tick(2003.2); // +30
    expect(ev).toContainEqual({ type: 'stage', ladderId: 1, stage: 1 });
    expect(e.snapshot().ladders[0].beEnabled).toBe(true);
    expect(e.ladder(1)!.sl).toBe(1999.2); // not automatic
    e.applyBE(1);
    expect(e.ladder(1)!.sl).toBe(2000.3);
    expect(e.snapshot().ladders[0].beEnabled).toBe(false);
  });

  it('applies the SL spread buffer when the manager sets an SL', () => {
    const { e, tick } = mk({ slBufferPips: 1 });
    open(e, tick, 'sell', 0.1, 2000); // sell at bid 2000, avg 2000
    tick(1996.8, 1997); // +30 (ask based)
    e.applyBE(1);
    expect(e.ladder(1)!.sl).toBe(2000); // avg - 1 pip + 1 pip buffer
    tick(1994.8, 1995); // +50
    expect(e.ladder(1)!.sl).toBe(1998.1); // avg - 20 pips + 1 pip buffer
  });

  it('stage 2 at +50 sets avg + 20, stage 3 at +100 sets avg + 50 (buy)', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    tick(2005.1); // +49
    expect(e.ladder(1)!.stage).toBe(1);
    const ev = tick(2005.2); // +50
    expect(ev).toContainEqual({ type: 'stage', ladderId: 1, stage: 2 });
    expect(e.ladder(1)!.sl).toBe(2002.2);
    tick(2010.1);
    expect(e.ladder(1)!.stage).toBe(2);
    tick(2010.2); // +100
    expect(e.ladder(1)!.stage).toBe(3);
    expect(e.ladder(1)!.sl).toBe(2005.2);
    tick(2030); // runner: no more automatic moves
    expect(e.ladder(1)!.sl).toBe(2005.2);
  });

  it('stages work for sells measured with ask', () => {
    const { e, tick } = mk();
    open(e, tick, 'sell', 0.1, 2000); // avg 2000
    tick(1994.8, 1995.0); // +50
    expect(e.ladder(1)!.sl).toBe(1998);
    tick(1989.8, 1990.0); // +100
    expect(e.ladder(1)!.sl).toBe(1995);
  });

  it('never moves the SL backwards automatically', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    tick(2005);
    e.setSL(1, 2004); // user already locks +38
    tick(2005.2); // stage 2 would set 2002.2 -> must not loosen
    expect(e.ladder(1)!.stage).toBe(2);
    expect(e.ladder(1)!.sl).toBe(2004);
  });

  it('lets the user drag the SL anywhere after stages, still synced', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000);
    open(e, tick, 'buy', 0.1, 2000);
    tick(2006); // stage 2
    e.setSL(1, 1999);
    expect(e.ladder(1)!.tickets.map((t) => t.sl)).toEqual([1999, 1999]);
  });

  it('labels a protected SL hit as stage SL and records highest stage and MFE', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    e.setSL(1, 1999.2);
    tick(2006.2); // +60 -> stage 2, SL 2002.2
    const ev = tick(2002.1);
    const rec = ev.find((x) => x.type === 'ladderClosed');
    expect(rec).toMatchObject({ record: { exitReason: 'stage SL', highestStage: 'Stage 2', mfePips: 60, resultPips: 19 } });
  });
});

describe('stop-out', () => {
  it('closes everything at the stop-out level and blows the account', () => {
    const { e, tick } = mk({ stopOutLevel: 50 }, 50);
    open(e, tick, 'buy', 0.2, 2000); // margin = 0.2*100*2000.2/3000 = 13.336
    // equity must fall to 6.668: floating = -43.33 -> bid = 2000.2 - 2.1666 = 1998.03
    expect(types(tick(1998.1))).not.toContain('stopout');
    const ev = tick(1998.0);
    expect(types(ev)).toContain('stopout');
    expect(ev.find((x) => x.type === 'ladderClosed')).toMatchObject({ record: { exitReason: 'stop-out' } });
    expect(e.blown).toBe(true);
    expect(e.balance).toBeCloseTo(50 - 44, 6);
    expect(e.placeOrder('buy', 0.01).ok).toBe(false);
    e.newWarAccount();
    expect(e.balance).toBe(50);
    expect(e.placeOrder('buy', 0.01).ok).toBe(true);
  });
});

describe('panel values', () => {
  it('shows loss at SL as % of account, RR now with frozen R, locked $ and lot warning', () => {
    const { e, tick } = mk({}, 50);
    open(e, tick, 'buy', 0.1, 2000); // 2000.2
    e.setSL(1, 1998.2); // R = 20 = 40% of 50
    tick(2001.2);
    const l = e.snapshot().ladders[0];
    expect(l.R).toBe(20);
    expect(l.lossAtSLPct).toBeCloseTo(40, 6);
    expect(l.rrNow).toBeCloseTo(0.5, 6);
    expect(l.lockedAtSL).toBeCloseTo(-20, 6);
    expect(l.lotWarning).toBe(false);
    open(e, tick, 'buy', 0.01, 2001.2);
    expect(e.snapshot().ladders[0].lotWarning).toBe(true);
  });
});

describe('post-close tracking', () => {
  it('records the max favourable pips from average within 4 hours after close', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    tick(2001.2);
    e.closeLadder(1);
    e.takeEvents();
    tick(2003.2); // +30
    tick(2002.2);
    const tr = e.trackers[0];
    expect(tr.max).toBe(30);
    expect(feedTracker(tr, tr.until + 1, 3000, 3000)).toBe(true);
    expect(tr.max).toBe(30);
    expect(tr.until - POST_CLOSE_TRACK_MS).toBe(e.ladder(1)!.closeTime);
  });

  it('emits the final value once a tick passes the 4-hour window', () => {
    const e = new Engine({ ...DEFAULT_ACCOUNT }, 1000, 2);
    e.onTick(0, 2000, 2000.2);
    e.placeOrder('sell', 0.01);
    e.onTick(10, 2000, 2000.2);
    e.closeLadder(1);
    e.onTick(20, 1990, 1990.2); // +98
    e.takeEvents();
    e.onTick(10 + POST_CLOSE_TRACK_MS + 1, 1900, 1900.2);
    expect(e.takeEvents()).toContainEqual({ type: 'postClose', entryId: 's-1', pips: 98, done: true });
  });
});
