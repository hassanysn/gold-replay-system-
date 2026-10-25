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

export type Cell = string | number | null;

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: number | null | undefined): Cell => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

/** Name of the M1 screenshot saved next to journal.xlsx (journal/images/<id>.png). */
export function chartImageName(r: JournalRecord): string {
  return `images/${r.id}.png`;
}

/** One column per field; the same table feeds the CSV export and journal/journal.xlsx. */
const COLUMNS: [string, (r: JournalRecord) => Cell][] = [
  ['id', (r) => r.id],
  ['type', (r) => r.kind],
  ['ladder_no', (r) => (r.ladderNo ? `L${r.ladderNo}` : null)],
  ['direction', (r) => r.dir],
  ['open_time', (r) => fmtTime(r.openTime)],
  ['close_time', (r) => fmtTime(r.closeTime)],
  // setup tags
  ['session', (r) => r.tags?.session || null],
  ['pd_array', (r) => r.tags?.pdArray || null],
  ['htf_trend', (r) => r.tags?.htfTrend || null],
  ['confirmation', (r) => r.tags?.confirmation || null],
  ['zone_size_pips', (r) => num(r.tags?.zonePips)],
  ['avg_stop_pips', (r) => num(r.tags?.avgStopPips)],
  ['rule_followed', (r) => r.tags?.ruleFollowed || null],
  // result
  ['result_usd', (r) => r2(r.result)],
  ['result_R', (r) => num(r.resultR)],
  ['closed_below_1R', (r) => (r.resultR === null ? null : r.resultR < 1 ? 'yes' : 'no')],
  ['result_pips', (r) => num(r.resultPips)],
  ['highest_stage', (r) => r.highestStage],
  ['be_applied', (r) => (r.beApplied ? 'yes' : 'no')],
  ['be_pulled_back', (r) => (r.bePulledBack ? 'yes' : 'no')],
  ['exit_reason', (r) => r.exitReason],
  ['mfe_pips', (r) => num(r.mfePips)],
  ['post_close_run_pips', (r) => num(r.postClosePips)],
  ['post_close_complete', (r) => (r.postCloseDone ? 'yes' : 'no')],
  ['captured_pct', (r) => {
    const c = capturedPct(r);
    return c === null ? null : Math.round(c * 10) / 10;
  }],
  // ladder detail (EA journal fields)
  ['tickets', (r) => r.ticketCount],
  ['avg_entry', (r) => Math.round(r.avgEntry * 1000) / 1000],
  ['worst_entry', (r) => num(r.worstEntry)],
  ['total_lot', (r) => r.totalLot],
  ['lots_max_open', (r) => num(r.lotsMax)],
  ['original_sl', (r) => num(r.originalSL)],
  ['final_sl', (r) => num(r.finalSL)],
  ['risk_at_first_sl_usd', (r) => num(r.R)],
  ['risk_max_usd', (r) => num(r.riskMax)],
  ['sl_edits', (r) => num(r.slEdits)],
  ['sl_widened', (r) => (r.slWidened === undefined ? null : r.slWidened ? 'yes' : 'no')],
  ['stage2_time', (r) => (r.stage2Time ? fmtTime(r.stage2Time) : null)],
  ['mfe_price', (r) => num(r.mfePrice)],
  ['mae_price', (r) => num(r.maePrice)],
  ['exit_giveback', (r) => num(r.giveback)],
  ['closed_by_sl', (r) => num(r.closedBy?.sl)],
  ['closed_by_tp', (r) => num(r.closedBy?.tp)],
  ['closed_by_manager', (r) => num(r.closedBy?.manager)],
  ['closed_by_you', (r) => num(r.closedBy?.you)],
  ['closed_by_other', (r) => num(r.closedBy?.other)],
  ['auto_sl_refused', (r) => num(r.autoSlRefused)],
  ['accounts', (r) => num(r.accounts ?? 1)],
  ['balance_before', (r) => num(r.balanceBefore)],
  ['balance_after', (r) => r2(r.balanceAfter)],
  ['chart_image', (r) => chartImageName(r)],
  ['ticket_detail', (r) => r.tickets.map((t) => `${t.lot}@${t.openPrice}->${t.closePrice} ${t.profit.toFixed(2)} ${t.reason}`).join(' | ')],
  ['note', (r) => r.note || null],
];

export function journalHeader(): string[] {
  return COLUMNS.map((c) => c[0]);
}

export function journalRow(r: JournalRecord): Cell[] {
  return COLUMNS.map(([, f]) => f(r));
}

export function journalTable(records: readonly JournalRecord[]): { header: string[]; rows: Cell[][] } {
  return { header: journalHeader(), rows: records.map(journalRow) };
}

function csvCell(v: Cell): string {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(records: readonly JournalRecord[]): string {
  const t = journalTable(records);
  const lines = [t.header.join(',')];
  for (const row of t.rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
