// Journal record of a closed live ladder, built from its MT5 deals (real fills, profit, commission,
// swap, close reason) plus what the page tracked while it was open. Same JournalRecord as the
// simulator, so the Journal / Stats pages and the Excel columns are identical.

import { type ClosedBy, type ExitReason, type JournalRecord, type JournalTicket, STAGE_NAMES } from '../core/engine';
import { PIP } from '../core/pips';
import type { Deal } from './api';
import type { Tracker } from './state';

const r2 = (v: number) => Math.round(v * 100) / 100;

/** MT5 DEAL_REASON -> exit reason / who closed it. */
function why(reason: number, stage: number): { exit: ExitReason; by: ClosedBy } {
  if (reason === 4) return { exit: stage >= 2 ? 'stage SL' : 'SL', by: 'sl' };
  if (reason === 5) return { exit: 'TP', by: 'tp' };
  if (reason === 6) return { exit: 'stop-out', by: 'other' };
  if (reason === 3) return { exit: 'cap close', by: 'manager' }; // closed by an EA: the ladder manager's cap
  if (reason <= 2) return { exit: 'manual close', by: 'you' }; // terminal, mobile, web
  return { exit: 'manual close', by: 'other' };
}

export function buildRecord(t: Tracker, deals: Deal[], contractSize: number, balanceAfter: number, login: number): JournalRecord | null {
  const tickets: JournalTicket[] = [];
  const closedBy: Record<ClosedBy, number> = { sl: 0, tp: 0, manager: 0, you: 0, other: 0 };
  let last: { time: number; exit: ExitReason } | null = null;
  let result = 0;
  for (const k of t.tickets) {
    const ds = deals.filter((d) => d.position === k);
    const ins = ds.filter((d) => d.entry === 'in');
    const outs = ds.filter((d) => d.entry !== 'in');
    if (!ins.length || !outs.length) continue;
    const lot = ins.reduce((a, d) => a + d.lot, 0);
    const outLot = outs.reduce((a, d) => a + d.lot, 0);
    const profit = r2(ds.reduce((a, d) => a + d.profit + d.commission + d.swap + d.fee, 0));
    const lastOut = outs[outs.length - 1];
    const w = why(lastOut.reason, t.stage);
    closedBy[w.by]++;
    if (!last || lastOut.time >= last.time) last = { time: lastOut.time, exit: w.exit };
    const closePrice = outs.reduce((a, d) => a + d.price * d.lot, 0) / outLot;
    result += profit;
    tickets.push({
      lot: r2(lot),
      openPrice: ins.reduce((a, d) => a + d.price * d.lot, 0) / lot,
      openTime: ins[0].time,
      closePrice,
      closeTime: lastOut.time,
      profit,
      reason: w.exit,
    });
  }
  if (!tickets.length || !t.dir || !last) return null;
  tickets.sort((a, b) => a.openTime - b.openTime);
  const dir = t.dir;
  const d = dir === 'buy' ? 1 : -1;
  const totalLot = r2(tickets.reduce((a, x) => a + x.lot, 0));
  const avg = tickets.reduce((a, x) => a + x.openPrice * x.lot, 0) / totalLot;
  const worst = tickets.reduce((w, x) => (dir === 'sell' ? Math.min(w, x.openPrice) : Math.max(w, x.openPrice)), tickets[0].openPrice);
  result = r2(result);
  const hasR1 = t.firstSL !== null && Math.abs(t.risk1) > 0.005;
  const lastTicket = tickets.reduce((a, x) => (x.closeTime >= a.closeTime ? x : a));
  const fin = d * (lastTicket.closePrice - worst);
  const mfe = t.moveSeen ? Math.max(t.mfe, fin) : fin;
  const mae = t.moveSeen ? Math.min(t.mae, fin) : fin;
  return {
    id: `live-${login}-${t.key.replace(/[^A-Za-z0-9]+/g, '-')}-${last.time}`,
    kind: t.kind,
    dir,
    ladderNo: t.kind === 'ladder' ? t.rank : 0,
    openTime: tickets[0].openTime,
    closeTime: last.time,
    ticketCount: tickets.length,
    tickets,
    avgEntry: avg,
    worstEntry: worst,
    totalLot,
    lotsMax: t.lotsMax,
    originalSL: t.firstSL,
    finalSL: t.lastSL,
    R: hasR1 ? r2(Math.abs(t.risk1)) : null,
    riskMax: t.riskMax === null ? null : r2(t.riskMax),
    slEdits: t.slEdits,
    slWidened: t.slWidened,
    highestStage: STAGE_NAMES[t.stage],
    stage2Time: t.s2Time,
    beApplied: t.beApplied,
    bePulledBack: t.bePulled,
    exitReason: last.exit,
    closedBy,
    autoSlRefused: 0,
    result,
    resultR: hasR1 ? Math.round((result / Math.abs(t.risk1)) * 100) / 100 : null,
    // like the simulator: net $ expressed in pips of the total lot (includes commission and swap)
    resultPips: Math.round((result / (totalLot * contractSize * PIP)) * 10) / 10,
    mfePrice: r2(mfe),
    maePrice: r2(mae),
    giveback: r2(mfe - fin),
    mfePips: Number.isFinite(t.mfePips) ? t.mfePips : 0,
    postClosePips: null,
    postCloseDone: false,
    balanceBefore: t.balBefore,
    balanceAfter: balanceAfter,
    note: '',
    tags: { ...t.tags },
  };
}

/** Post-close run in pips from the average entry, from the M1 high/low after the close. */
export function postCloseFromRange(r: JournalRecord, high: number | null, low: number | null): number | null {
  if (high === null || low === null) return null;
  const p = r.dir === 'buy' ? (high - r.avgEntry) / PIP : (r.avgEntry - low) / PIP;
  return Math.round(p * 10) / 10;
}
