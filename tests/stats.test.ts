import { describe, expect, it } from 'vitest';
import type { JournalRecord } from '../src/core/engine';
import { capturedPct, computeStats, filterRecords, toCSV } from '../src/core/stats';

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

  it('exports CSV with quoting', () => {
    const csv = toCSV([rs[1]]);
    const [head, row] = csv.trim().split('\r\n');
    expect(head.split(',')).toContain('result_R');
    expect(row.endsWith('"scared, ""early"""')).toBe(true);
  });
});
