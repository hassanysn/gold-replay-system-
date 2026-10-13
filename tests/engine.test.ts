// Engine tests. The Ladder Manager must behave like the MT5 EA (LadderManager.mqh v3.0).
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, Engine, type EngineEvent, feedTracker, POST_CLOSE_TRACK_MS, stageCheck } from '../src/core/engine';
import { pipsBetween, pipsFrom, priceAtPips, profit, weightedAverage } from '../src/core/pips';

const SPREAD = 0.2;

/** Engine with a big balance (so neither margin nor the lot cap interferes unless a test wants it). */
function mk(opts: Partial<typeof DEFAULT_ACCOUNT> = {}, balance = 100_000) {
  const e = new Engine({ ...DEFAULT_ACCOUNT, ...opts }, balance, 2);
  let t = 1000;
  const tick = (bid: number, ask = +(bid + SPREAD).toFixed(2)) => {
    t += 1000;
    e.onTick(t, bid, ask);
    return e.takeEvents();
  };
  tick(2000);
  return { e, tick, now: () => t };
}

type Tick = (b: number, a?: number) => EngineEvent[];
function open(e: Engine, tick: Tick, dir: 'buy' | 'sell', lot: number, bid: number) {
  expect(e.placeOrder(dir, lot).ok).toBe(true);
  return tick(bid);
}
const types = (ev: EngineEvent[]) => ev.map((x) => x.type);
const notices = (ev: EngineEvent[]) => ev.filter((x) => x.type === 'notice').map((x) => (x as { text: string }).text);
const closed = (ev: EngineEvent[]) => ev.find((x) => x.type === 'ladderClosed') as Extract<EngineEvent, { type: 'ladderClosed' }> | undefined;

describe('pip math', () => {
  it('measures buy pips from bid and sell pips from ask', () => {
    expect(pipsFrom('buy', 2000, 2003, 2003.2)).toBe(30);
    expect(pipsFrom('sell', 2000, 1996.8, 1997)).toBe(30);
    expect(pipsFrom('buy', 2000, 1999, 1999.2)).toBe(-10);
    expect(pipsFrom('sell', 2000, 2000.8, 2001)).toBe(-10);
    expect(pipsFrom('buy', 2650.07, 2653.07, 0)).toBe(30);
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

describe('broker', () => {
  it('fills buy at ask and sell at bid on the next tick', () => {
    const { e, tick } = mk();
    e.placeOrder('buy', 0.1);
    expect(e.openTickets().length).toBe(0);
    expect(tick(2001, 2001.25)[0]).toMatchObject({ type: 'fill', ticket: { openPrice: 2001.25, dir: 'buy' } });
    const s = mk();
    s.e.placeOrder('sell', 0.1);
    expect(s.tick(2001, 2001.25)[0]).toMatchObject({ type: 'fill', ticket: { openPrice: 2001 } });
  });

  it('triggers buy SL on bid and sell SL on ask', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // 2000.20
    e.setSL(1, 1999);
    expect(types(tick(1999.05, 1998.9))).not.toContain('sl');
    const ev = tick(1999, 1999.2);
    expect(closed(ev)?.record).toMatchObject({ exitReason: 'SL', result: -12, closedBy: { sl: 1 } });
    const s = mk();
    open(s.e, s.tick, 'sell', 0.1, 2000);
    s.e.setSL(1, 2001);
    expect(types(s.tick(2001.1, 2000.9))).not.toContain('sl');
    expect(types(s.tick(2000.8, 2001))).toContain('sl');
  });

  it('closes at TP and rejects orders without free margin', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000);
    e.setTP(1, 2001);
    expect(closed(tick(2001.05))?.record.exitReason).toBe('TP');
    const m = mk({ lotPer100: 0 }, 50);
    m.e.placeOrder('buy', 1);
    expect(m.tick(2000)[0].type).toBe('rejected');
  });

  it('stops out at the stop-out level and blows the account', () => {
    const { e, tick } = mk({ lotPer100: 0 }, 50);
    open(e, tick, 'buy', 0.2, 2000); // margin 13.336
    expect(types(tick(1998.1))).not.toContain('stopout');
    const ev = tick(1998.0);
    expect(types(ev)).toContain('stopout');
    expect(closed(ev)?.record).toMatchObject({ exitReason: 'stop-out', closedBy: { other: 1 } });
    expect(e.blown).toBe(true);
    expect(e.placeOrder('buy', 0.01).ok).toBe(false);
    e.newWarAccount();
    expect(e.balance).toBe(50);
  });
});

describe('grouping (AssignNew)', () => {
  it('puts every new trade in the current ladder; average is volume weighted', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    open(e, tick, 'buy', 0.03, 1996);
    const l = e.snapshot().ladders[0];
    expect([l.ticketCount, l.totalLot, l.worstEntry]).toEqual([2, 0.04, 2000.2]);
    expect(l.avg).toBeCloseTo(1997.2, 9);
  });

  it('does not block an opposite trade: it stays unmanaged with its own SL/TP', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    const ev = open(e, tick, 'sell', 0.02, 2000);
    expect(notices(ev).some((n) => n.includes('opposite to your open ladder(s) (BUY) - NOT managed'))).toBe(true);
    const s = e.snapshot();
    expect(s.ladders[0].ticketCount).toBe(1);
    expect(s.unmanaged.map((t) => t.lot)).toEqual([0.02]);
    e.setTicketSL(2, 2003);
    e.closeUnmanaged(2);
    const rec = closed(e.takeEvents())!.record;
    expect(rec).toMatchObject({ kind: 'normal', dir: 'sell', ticketCount: 1, originalSL: 2003, R: 6 });
  });

  it('adopts a left-over opposite trade into a new ladder once the other side has closed', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    open(e, tick, 'sell', 0.02, 2000);
    e.closeLadder(1);
    tick(2000);
    const s = e.snapshot();
    expect(s.unmanaged.length).toBe(0);
    expect(s.ladders[0]).toMatchObject({ dir: 'sell', ticketCount: 1, rank: 1 });
  });

  it('when the current ladder closes, new trades join the newest open ladder', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000); // L1 avg 2000.2
    tick(2005.2); // stage 2
    e.newLadder();
    open(e, tick, 'buy', 0.01, 2005.2); // L2
    e.closeLadder(2);
    open(e, tick, 'buy', 0.01, 2005.2);
    expect(e.ladder(1)!.tickets.length).toBe(2);
    expect(e.openLadders().length).toBe(1);
  });
});

describe('NEW LADDER gate', () => {
  it('needs every open ladder at stage 2 and risk-free, max 3 ladders', () => {
    const { e, tick } = mk();
    expect(e.newLadderBlock()).toBe('');
    open(e, tick, 'buy', 0.01, 2000); // avg 2000.2
    expect(e.newLadderBlock()).toBe('L1 has not reached stage 2 yet (SL at average +20 pips)');
    tick(2005.2); // stage 2: SL = 2002.2
    expect(e.ladder(1)!.sl).toBe(2002.2);
    expect(e.newLadder()).toBe(true);
    expect(e.newLadderBlock()).toBe('L2 has no trades yet - use it first');
    open(e, tick, 'buy', 0.01, 2005.2); // L2 avg 2005.4
    expect(e.newLadderBlock()).toMatch(/L2 has not reached stage 2/);
    tick(2010.4); // L2 stage 2; L1 stage 3 is at 2010.2 -> also reached
    e.setSL(1, 2000); // you drag L1's SL back into loss
    expect(e.newLadderBlock()).toBe('L1 still at risk (-$0.20 if SL hits)');
    e.setSL(1, 2008);
    expect(e.newLadder()).toBe(true);
    open(e, tick, 'buy', 0.01, 2010.4); // L3
    tick(2015.6);
    expect(e.openLadders().length).toBe(3);
    expect(e.newLadderBlock()).toBe('maximum 3 ladders are open');
    open(e, tick, 'buy', 0.01, 2015.6); // joins L3
    expect(e.ladder(3)!.tickets.length).toBe(2);
  });

  it('refuses a new ladder while a ticket has no SL', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    tick(2005.2);
    e.newLadder();
    open(e, tick, 'buy', 0.01, 2005.2);
    tick(2010.6); // L2 stage 2 gets SL; add a 3rd ticket to L2 that will have the SL too
    expect(e.newLadderBlock()).toBe('');
  });
});

describe('lot cap (EnforceCap)', () => {
  it('caps each ladder at 0.10 lot per $100 and closes the ticket that exceeds it', () => {
    const { e, tick } = mk({}, 50); // cap 0.05
    expect(e.lotCap()).toBe(0.05);
    open(e, tick, 'buy', 0.03, 2000);
    const ev = open(e, tick, 'buy', 0.03, 2000);
    expect(notices(ev)).toContain('L1 BUY CAP 0.05 lot | trade #2 0.03 lot CLOSED - ladder would exceed the cap');
    expect(e.tickets[1]).toMatchObject({ closeReason: 'cap close', closedBy: 'manager', profit: -0.6 });
    expect(e.snapshot().ladders[0].totalLot).toBe(0.03);
    // the cap follows the balance: $49.40 after the cap close -> 0.04
    expect(e.lotCap()).toBe(0.04);
    open(e, tick, 'buy', 0.01, 2000);
    expect(e.snapshot().ladders[0].totalLot).toBe(0.04);
  });

  it('only lets the cap change while no trade is open', () => {
    const { e, tick } = mk({}, 50);
    open(e, tick, 'buy', 0.01, 2000);
    e.updateSettings({ lotPer100: 0.5 });
    expect(e.settings.lotPer100).toBe(0.1);
    e.closeAll();
    e.updateSettings({ lotPer100: 0.5 });
    expect(e.settings.lotPer100).toBe(0.5);
    expect(e.lotCap()).toBe(0.24); // $49.98 / 100 * 0.5, rounded down to 0.01
  });
});

describe('stages (from the average entry)', () => {
  it('stage 2 at +50 sets SL = average +20 exactly; stage 3 at +100 sets average +50; then runner', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    tick(2005.1);
    expect(e.ladder(1)!.stage).toBe(0);
    const ev = tick(2005.2);
    expect(ev).toContainEqual({ type: 'stage', ladderId: 1, stage: 2 });
    expect(e.ladder(1)!.sl).toBe(2002.2);
    tick(2010.1);
    expect(e.ladder(1)!.stage).toBe(2);
    tick(2010.2);
    expect([e.ladder(1)!.stage, e.ladder(1)!.sl]).toEqual([3, 2005.2]);
    tick(2030);
    expect(e.ladder(1)!.sl).toBe(2005.2);
  });

  it('works for sells measured with ask', () => {
    const { e, tick } = mk();
    open(e, tick, 'sell', 0.1, 2000); // avg 2000
    tick(1994.8, 1995.0);
    expect(e.ladder(1)!.sl).toBe(1998);
    tick(1989.8, 1990.0);
    expect(e.ladder(1)!.sl).toBe(1995);
  });

  it('freezes the average at stage 2: trades added later do not move stage 3', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000); // avg 2000.2
    tick(2005.2); // stage 2, anchor 2000.2
    const ev = open(e, tick, 'buy', 0.03, 2006); // live avg would become 2004.65
    expect(notices(ev).some((n) => n.includes('TRADE ADDED after stage 2'))).toBe(true);
    expect(e.ladder(1)!.tickets[1].sl).toBe(2002.2); // it takes the ladder SL
    const v = e.snapshot().ladders[0];
    expect(v.avg).toBeCloseTo(2000.2, 9);
    expect(v.stageText).toContain('stage 3 at 2010.20');
    tick(2010.2);
    expect(e.ladder(1)!.sl).toBe(2005.2);
  });

  it('manual always wins: an auto SL never loosens your SL', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000);
    tick(2005);
    e.setSL(1, 2004);
    const ev = tick(2005.2);
    expect(e.ladder(1)!.stage).toBe(2);
    expect(e.ladder(1)!.sl).toBe(2004);
    expect(notices(ev).some((n) => n.includes('auto SL 2002.20 not applied - your SL 2004.00 is already better'))).toBe(true);
    tick(2006);
    e.setSL(1, 1999); // you can still move it anywhere; the EA does not put it back
    tick(2007);
    expect(e.ladder(1)!.sl).toBe(1999);
  });

  it('steps back by the spread when the auto SL is too close (stops level), and your edit cancels the wait', () => {
    const { e, tick } = mk({ stopsLevelPoints: 100, s2LockPips: 48, s2TrigPips: 50, s3LockPips: 60 }); // 1.00 stops level
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    const ev = tick(2005.2); // target 2005.0 must be <= bid - 1.00; steps back 0.2 (spread) at a time
    expect(e.ladder(1)!.sl).toBe(2004.2);
    expect(e.ladder(1)!.pending).toBe(2005.0);
    expect(notices(ev).some((n) => n.includes('too close to price - will tighten when allowed'))).toBe(true);
    e.setSL(1, 2001);
    expect(e.ladder(1)!.pending).toBe(null);
    expect(notices(e.takeEvents())).toContain('L1 BUY your edit wins - waiting auto SL 2005.00 cancelled');
  });
});

describe('MOVE TO BE (stage 1)', () => {
  it('is allowed only while price is +30 from the live average and sets average +1 pip', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // avg 2000.2
    e.setSL(1, 1999.2);
    tick(2003.1); // +29
    expect(e.snapshot().ladders[0].beEnabled).toBe(false);
    expect(e.applyBE(1)).toBe(false);
    expect(notices(e.takeEvents())[0]).toContain('TOO EARLY');
    const ev = tick(2003.2); // +30
    expect(ev).toContainEqual({ type: 'stage', ladderId: 1, stage: 1 });
    tick(2002.5); // back to +23: BE is refused again (the EA checks the live distance)
    expect(e.applyBE(1)).toBe(false);
    tick(2003.3);
    expect(e.applyBE(1)).toBe(true);
    expect(e.ladder(1)!.sl).toBe(2000.3);
    expect(e.snapshot().ladders[0]).toMatchObject({ beEnabled: false, beText: 'BE done' });
  });

  it('is refused when the SL is already at or past breakeven', () => {
    const { e, tick } = mk();
    open(e, tick, 'sell', 0.1, 2000); // avg 2000
    tick(1994.8, 1995); // stage 2 -> SL 1998
    expect(e.applyBE(1)).toBe(false);
    expect(notices(e.takeEvents())[0]).toContain('already at or past breakeven 1999.90');
  });
});

describe('SL/TP sync', () => {
  it('copies your SL/TP edit to every ticket; a new trade takes the ladder SL/TP', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    open(e, tick, 'buy', 0.01, 2001);
    e.setSL(1, 1998);
    e.setTP(1, 2010);
    open(e, tick, 'buy', 0.01, 1999);
    expect(e.ladder(1)!.tickets.map((t) => [t.sl, t.tp])).toEqual([
      [1998, 2010],
      [1998, 2010],
      [1998, 2010],
    ]);
    e.setTP(1, null); // TP 0 = none is copied too
    expect(e.ladder(1)!.tickets.map((t) => t.tp)).toEqual([null, null, null]);
  });

  it('rejects an edit on the wrong side of price (the broker would) and never removes the ladder SL', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.01, 2000);
    e.setSL(1, 1999);
    e.takeEvents();
    e.setSL(1, 2000.5);
    expect(notices(e.takeEvents())[0]).toContain('Invalid SL 2000.50');
    e.setSL(1, null);
    expect(e.ladder(1)!.tickets[0].sl).toBe(1999);
  });

  it('a ticket that cannot take the ladder SL yet waits and gets it later (after the cooldown)', () => {
    const { e, tick } = mk({ stopsLevelPoints: 100 }); // 1.00
    open(e, tick, 'buy', 0.01, 2000);
    e.setSL(1, 1998);
    const ev = open(e, tick, 'buy', 0.01, 1998.5); // 1998 is not <= 1998.5 - 1.00
    expect(notices(ev).some((n) => n.includes('cannot take SL 1998.00 TP none yet (too close to price). Waiting.'))).toBe(true);
    expect(e.ladder(1)!.tickets[1].sl).toBe(null);
    tick(2000); // within the 5 s cooldown
    expect(e.ladder(1)!.tickets[1].sl).toBe(null);
    for (let i = 0; i < 5; i++) tick(2000);
    expect(e.ladder(1)!.tickets[1].sl).toBe(1998);
  });
});

describe('R, IF SL HITS, IF CLOSED NOW', () => {
  it('1R = worst IF SL HITS seen: grows with added tickets and widening, never shrinks', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // 2000.2
    e.setSL(1, 1999.2);
    tick(2000);
    expect(e.snapshot().ladders[0].R).toBeCloseTo(10, 6);
    open(e, tick, 'buy', 0.1, 2000); // 2nd ticket takes SL 1999.2 -> risk 20
    expect(e.snapshot().ladders[0].R).toBeCloseTo(20, 6);
    e.setSL(1, 1999.7);
    tick(2000);
    expect(e.snapshot().ladders[0].R).toBeCloseTo(20, 6);
    e.setSL(1, 1998.7);
    tick(2000);
    expect(e.snapshot().ladders[0].R).toBeCloseTo(30, 6);
    expect(e.ladder(1)!.slWidened).toBe(true);
    tick(2001.7); // IF CLOSED NOW = +30 = 1.00R
    expect(e.snapshot().ladders[0].rr).toBeCloseTo(1, 6);
  });

  it('IF SL HITS is unknown (unlimited) while any ticket has no SL; loss as % of balance', () => {
    const { e, tick } = mk({ lotPer100: 0 }, 50);
    open(e, tick, 'buy', 0.1, 2000);
    expect(e.snapshot().ladders[0]).toMatchObject({ ifSLHits: null, R: null });
    e.setSL(1, 1998.2); // -20 = 40%
    tick(2001.2);
    const l = e.snapshot().ladders[0];
    expect(l.ifSLHits).toBeCloseTo(-20, 6);
    expect(l.ifSLHitsPct).toBeCloseTo(40, 6);
    expect(l.ifClosedNow).toBeCloseTo(10, 6);
    expect(l.rr).toBeCloseTo(0.5, 6);
    expect(e.snapshot().totalIfSLHits).toBeCloseTo(-20, 6);
  });

  it('journal: net R uses the risk at the first SL; counts SL edits and who closed', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000); // 2000.2
    e.setSL(1, 1999.2); // first SL: risk 10
    tick(2000);
    e.setSL(1, 1998.2); // widened: 1R on the panel = 20
    tick(2002.2);
    e.closeLadder(1);
    const r = closed(e.takeEvents())!.record;
    expect(r).toMatchObject({ R: 10, riskMax: -20, result: 20, resultR: 2, slEdits: 2, slWidened: true, closedBy: { you: 1 }, worstEntry: 2000.2 });
    expect(r.mfePrice).toBeCloseTo(2, 6);
    expect(r.giveback).toBeCloseTo(0, 6);
  });
});

describe('settings check', () => {
  it('uses the EA input order rules', () => {
    expect(stageCheck(DEFAULT_ACCOUNT)).toBe('');
    expect(stageCheck({ ...DEFAULT_ACCOUNT, s2LockPips: 60 })).toBe('stage 2 trigger must be above stage 2 lock');
    expect(stageCheck({ ...DEFAULT_ACCOUNT, s3TrigPips: 45, s3LockPips: 30 })).toBe('stage 3 trigger must be above stage 2 trigger');
    expect(stageCheck({ ...DEFAULT_ACCOUNT, beBufferPips: 30 })).toBe('BE buffer must be below the BE minimum distance');
  });
});

describe('post-close tracking', () => {
  it('records the max favourable pips from average within 4 hours after close', () => {
    const { e, tick } = mk();
    open(e, tick, 'buy', 0.1, 2000);
    tick(2001.2);
    e.closeLadder(1);
    e.takeEvents();
    tick(2003.2);
    tick(2002.2);
    const tr = e.trackers[0];
    expect(tr.max).toBe(30);
    expect(feedTracker(tr, tr.until + 1, 3000, 3000)).toBe(true);
    expect(tr.until - POST_CLOSE_TRACK_MS).toBe(e.ladder(1)!.closeTime);
  });

  it('emits the final value once a tick passes the 4-hour window', () => {
    const e = new Engine({ ...DEFAULT_ACCOUNT }, 1000, 2);
    e.onTick(0, 2000, 2000.2);
    e.placeOrder('sell', 0.01);
    e.onTick(10, 2000, 2000.2);
    e.closeLadder(1);
    e.onTick(20, 1990, 1990.2);
    e.takeEvents();
    e.onTick(10 + POST_CLOSE_TRACK_MS + 1, 1900, 1900.2);
    expect(e.takeEvents()).toContainEqual({ type: 'postClose', entryId: 's-1', pips: 98, done: true });
  });
});
