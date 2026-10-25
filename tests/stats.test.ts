import { describe, expect, it } from 'vitest';
import type { JournalRecord } from '../src/core/engine';
import { capturedPct, computeStats, filterRecords, journalTable, toCSV } from '../src/core/stats';

function rec(p: Partial<JournalRecord>): JournalRecord {
  return {
    id: 'x',
    kind: 'ladder',
    dir: 'buy',
    openTime: Date.UTC(2026, 9, 12, 10),
    closeTime: Date.UTC(2026, 9, 12, 11),
    ticketCount: 1,
    tickets: [],
    avgEntry: 2000,
    totalLot: 0.1,
    originalSL: 1998,
    R: 20,
    highestStage: 'none',
    beApplied: false,
    exitReason: 'manual close',
    result: 0,
    resultR: 0,
    resultPips: 0,
    mfePips: 0,
    postClosePips: null,
    postCloseDone: false,
    balanceAfter: 50,
    ladderNo: 1,
    worstEntry: 2000,
    lotsMax: 0.1,
    finalSL: null,
    riskMax: null,
    slEdits: 0,
    slWidened: false,
    stage2Time: null,
    closedBy: { sl: 0, tp: 0, manager: 0, you: 1, other: 0 },
    autoSlRefused: 0,
    mfePrice: null,
    maePrice: null,
    giveback: null,
    balanceBefore: 50,
    tags: { session: 'London', pdArray: 'FVG', htfTrend: 'with', confirmation: 'deep', zonePips: 40, avgStopPips: 35, ruleFollowed: 'yes' },
    note: '',
    ...p,
  };
}

describe('stats', () => {
  const rs = [
    rec({ id: 'a', result: 40, resultR: 2, resultPips: 40, mfePips: 60, postClosePips: 80 }),
    rec({ id: 'b', result: 10, resultR: 0.5, resultPips: 10, mfePips: 20, postClosePips: 100, note: 'scared, "early"' }),
    rec({ id: 'c', result: -20, resultR: -1, resultPips: -20, mfePips: 5, exitReason: 'SL' }),
    rec({ id: 'n', kind: 'normal', result: 5, resultR: 0.25 }),
    rec({ id: 'old', openTime: Date.UTC(2026, 0, 2), result: 5, resultR: 0.25 }),
  ];

  it('separates ladder and normal trades and filters by date', () => {
    expect(filterRecords(rs, { kind: 'normal' }).map((r) => r.id)).toEqual(['n']);
    expect(filterRecords(rs, { kind: 'ladder', from: '2026-10-01', to: '2026-10-31' }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('computes win rate, average R, captured % and the below-1R list', () => {
    const s = computeStats(filterRecords(rs, { kind: 'ladder', from: '2026-10-01' }));
    expect(s.winRate).toBeCloseTo(66.67, 1);
    expect(s.avgR).toBeCloseTo(0.5, 9);
    expect(capturedPct(rs[0])).toBe(50); // 40 of max(60, 80)
    expect(capturedPct(rs[2])).toBe(-400);
    expect(s.capturedPct).toBeCloseTo((50 + 10 - 400) / 3, 9);
    expect(s.belowOneR.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('builds one table for CSV and Excel with tags, closed below 1R and the chart image name', () => {
    const t = journalTable([rs[1]]);
    const row = Object.fromEntries(t.header.map((h, i) => [h, t.rows[0][i]]));
    expect(row).toMatchObject({ session: 'London', pd_array: 'FVG', zone_size_pips: 40, result_R: 0.5, closed_below_1R: 'yes', result_usd: 10, chart_image: 'images/b.png', highest_stage: 'none', post_close_run_pips: 100 });
  });

  it('exports CSV with quoting', () => {
    const csv = toCSV([rs[1]]);
    const [head, row] = csv.trim().split('\r\n');
    expect(head.split(',')).toContain('result_R');
    expect(row.endsWith('"scared, ""early"""')).toBe(true);
  });
});
