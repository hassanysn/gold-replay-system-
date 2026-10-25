// Sends the journal to serve.py, which keeps the permanent copy in journal/journal.xlsx
// (+ journal.json and images/). Failures are retried; the browser journal is never touched.

import type { JournalRecord } from '../core/engine';
import { journalHeader, journalRow } from '../core/stats';

let timer = 0;
let latest: JournalRecord[] | null = null;
let onStatus: (s: SyncStatus) => void = () => {};

export interface SyncStatus {
  ok: boolean;
  /** The server has the rows but Excel holds journal.xlsx open; it retries by itself. */
  waiting: boolean;
  text: string;
}

export function onJournalSyncStatus(fn: (s: SyncStatus) => void) {
  onStatus = fn;
}

/** Queue a full journal upload (debounced). */
export function syncJournal(records: JournalRecord[], delay = 400) {
  latest = records;
  clearTimeout(timer);
  timer = window.setTimeout(flush, delay);
}

async function flush() {
  if (!latest) return;
  const records = latest;
  const body = JSON.stringify({
    header: journalHeader(),
    items: records.map((r) => ({ id: r.id, closeTime: r.closeTime, row: journalRow(r) })),
  });
  try {
    const res = await fetch('/api/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const st = (await res.json()) as { waiting: boolean; rows: number };
    if (latest === records) latest = null;
    onStatus({
      ok: true,
      waiting: st.waiting,
      text: st.waiting
        ? 'journal.xlsx is open in Excel - rows are kept and saved when you close it'
        : `journal.xlsx saved (${st.rows} rows)`,
    });
  } catch (e) {
    onStatus({ ok: false, waiting: false, text: `Excel journal not saved (${(e as Error).message}). Start the simulator with start.bat; retrying.` });
    clearTimeout(timer);
    timer = window.setTimeout(flush, 10_000);
  }
}

export async function uploadShot(id: string, blob: Blob) {
  try {
    await fetch(`/api/shot/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  } catch {
    /* the screenshot also stays in the browser journal */
  }
}
