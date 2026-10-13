// Journal statistics and CSV export. Pure functions over journal records.

import type { JournalRecord, LadderKind } from './engine';

export interface StatsFilter {
  kind: LadderKind;
  /** Inclusive YYYY-MM-DD bounds on the open date (server time). */
  from?: string;
  to?: string;
}

export interface Stats {
  count: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  /** Average of result / available move, where available = max(MFE, post-close run). */
  capturedPct: number | null;
  belowOneR: JournalRecord[];
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function filterRecords(records: readonly JournalRecord[], f: StatsFilter): JournalRecord[] {
  return records.filter((r) => {
    if (r.kind !== f.kind) return false;
    const d = isoDate(r.openTime);
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
    return true;
  });
}

/** Best move available to the ladder in pips: max of MFE while open and the post-close run. */
export function availablePips(r: JournalRecord): number {
  return Math.max(r.mfePips, r.postClosePips ?? -Infinity);
}

export function capturedPct(r: JournalRecord): number | null {
  const avail = availablePips(r);
  return avail > 0 ? (r.resultPips / avail) * 100 : null;
}

export function computeStats(records: readonly JournalRecord[]): Stats {
  const count = records.length;
  const wins = records.filter((r) => r.result > 0).length;
  const withR = records.filter((r) => r.resultR !== null);
  const caps = records.map(capturedPct).filter((x): x is number => x !== null);
  return {
    count,
    wins,
    winRate: count ? (wins / count) * 100 : null,
    avgR: withR.length ? withR.reduce((s, r) => s + (r.resultR as number), 0) / withR.length : null,
    capturedPct: caps.length ? caps.reduce((s, x) => s + x, 0) / caps.length : null,
    belowOneR: records.filter((r) => r.resultR !== null && r.resultR < 1),
  };
}

export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const CSV_COLUMNS: [string, (r: JournalRecord) => unknown][] = [
  ['id', (r) => r.id],
  ['type', (r) => r.kind],
  ['direction', (r) => r.dir],
  ['open_time', (r) => fmtTime(r.openTime)],
  ['close_time', (r) => fmtTime(r.closeTime)],
  ['tickets', (r) => r.ticketCount],
  ['avg_entry', (r) => r.avgEntry.toFixed(3)],
  ['total_lot', (r) => r.totalLot],
  ['original_sl', (r) => r.originalSL ?? ''],
  ['risk_at_first_sl_usd', (r) => r.R ?? ''],
  ['ladder_no', (r) => (r.ladderNo ? `L${r.ladderNo}` : '')],
  ['worst_entry', (r) => r.worstEntry ?? ''],
  ['lots_max_open', (r) => r.lotsMax ?? ''],
  ['final_sl', (r) => r.finalSL ?? ''],
  ['sl_edits', (r) => r.slEdits ?? ''],
  ['sl_widened', (r) => (r.slWidened === undefined ? '' : r.slWidened ? 'yes' : 'no')],
  ['risk_max_usd', (r) => r.riskMax ?? ''],
  ['balance_before', (r) => r.balanceBefore ?? ''],
  ['highest_stage', (r) => r.highestStage],
  ['stage2_time', (r) => (r.stage2Time ? fmtTime(r.stage2Time) : '')],
  ['be_applied', (r) => (r.beApplied ? 'yes' : 'no')],
  ['exit_reason', (r) => r.exitReason],
  ['result_usd', (r) => r.result.toFixed(2)],
  ['result_R', (r) => (r.resultR === null ? '' : r.resultR.toFixed(2))],
  ['result_pips', (r) => r.resultPips],
  ['mfe_pips', (r) => r.mfePips],
  ['mfe_price', (r) => r.mfePrice ?? ''],
  ['mae_price', (r) => r.maePrice ?? ''],
  ['exit_giveback', (r) => r.giveback ?? ''],
  ['closed_by_sl', (r) => r.closedBy?.sl ?? ''],
  ['closed_by_tp', (r) => r.closedBy?.tp ?? ''],
  ['closed_by_manager', (r) => r.closedBy?.manager ?? ''],
  ['closed_by_you', (r) => r.closedBy?.you ?? ''],
  ['closed_by_other', (r) => r.closedBy?.other ?? ''],
  ['auto_sl_refused', (r) => r.autoSlRefused ?? ''],
  ['post_close_run_pips', (r) => (r.postClosePips === null ? '' : r.postClosePips)],
  ['post_close_complete', (r) => (r.postCloseDone ? 'yes' : 'no')],
  ['captured_pct', (r) => {
    const c = capturedPct(r);
    return c === null ? '' : c.toFixed(1);
  }],
  ['balance_after', (r) => r.balanceAfter.toFixed(2)],
  ['ticket_detail', (r) => r.tickets.map((t) => `${t.lot}@${t.openPrice}->${t.closePrice} ${t.profit.toFixed(2)} ${t.reason}`).join(' | ')],
  ['note', (r) => r.note],
];

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(records: readonly JournalRecord[]): string {
  const lines = [CSV_COLUMNS.map((c) => c[0]).join(',')];
  for (const r of records) lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}
