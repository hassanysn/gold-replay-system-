// Journal, Stats and Settings pages.

import { type JournalRecord, type LadderKind, stageCheck } from '../core/engine';
import { tagSummary } from './tags';
import { availablePips, capturedPct, computeStats, filterRecords, fmtTime, toCSV } from '../core/stats';
import * as db from './db';
import type { AppSettings } from './settings';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
const cls = (v: number | null) => (v === null ? '' : v >= 0 ? 'pos' : 'neg');

function closedBy(r: JournalRecord): string {
  const c = r.closedBy;
  if (!c) return '-';
  return (['sl', 'tp', 'manager', 'you', 'other'] as const)
    .filter((k) => c[k] > 0)
    .map((k) => `${k} ${c[k]}`)
    .join(', ');
}

function postClose(r: JournalRecord): string {
  if (r.postClosePips === null) return r.postCloseDone ? '-' : 'tracking...';
  return `${r.postClosePips.toFixed(1)}${r.postCloseDone ? '' : ' (tracking)'}`;
}

// ------------------------------------------------------------------ journal

export class JournalPage {
  constructor(
    private root: HTMLElement,
    private getRecords: () => JournalRecord[],
    private saveNote: (id: string, note: string) => void,
    private editTags: (id: string) => void,
  ) {}

  render() {
    const rs = [...this.getRecords()].sort((a, b) => b.closeTime - a.closeTime);
    if (!rs.length) {
      this.root.innerHTML = '<h2>Journal</h2><p class="muted">No closed ladders yet. Every ladder is logged here automatically when its last ticket closes.</p>';
      return;
    }
    const rows = rs
      .map(
        (r) => `<tr data-id="${esc(r.id)}">
      <td><button class="shot-btn" title="M1 chart at close">img</button></td>
      <td>${fmtTime(r.openTime)}<br><span class="muted">${fmtTime(r.closeTime)}</span></td>
      <td class="${r.dir}">${r.dir.toUpperCase()}</td>
      <td>${r.kind}${(r.accounts ?? 1) > 1 ? ` · ${r.accounts} acc` : ''}</td>
      <td class="setup">${esc(tagSummary(r.tags)) || '<span class="muted">none</span>'} <button class="btn tags-btn">Edit</button></td>
      <td>${r.ticketCount}</td>
      <td>${r.avgEntry.toFixed(3)}</td>
      <td>${r.totalLot.toFixed(2)}</td>
      <td>${r.ladderNo ? `L${r.ladderNo}` : '-'}</td>
      <td>${r.worstEntry ?? '-'}</td>
      <td>${r.originalSL ?? '-'}</td>
      <td>${r.R === null ? '-' : money(r.R)}</td>
      <td>${r.riskMax === null || r.riskMax === undefined ? '-' : money(r.riskMax)}</td>
      <td>${r.slEdits ?? '-'}${r.slWidened ? ' (widened)' : ''}</td>
      <td>${r.highestStage}${r.bePulledBack ? ' (BE pulled back)' : r.beApplied ? ' (BE set)' : ''}</td>
      <td>${r.exitReason}</td>
      <td>${closedBy(r)}</td>
      <td class="${cls(r.result)}">${money(r.result)}</td>
      <td class="${cls(r.resultR)}">${r.resultR === null ? '-' : r.resultR.toFixed(2)}</td>
      <td>${r.resultPips.toFixed(1)}</td>
      <td>${r.mfePips.toFixed(1)}</td>
      <td>${r.mfePrice == null ? '-' : `${r.mfePrice.toFixed(2)} / ${r.maePrice?.toFixed(2)} / ${r.giveback?.toFixed(2)}`}</td>
      <td>${postClose(r)}</td>
      <td><textarea class="note" rows="2" placeholder="Why I closed">${esc(r.note)}</textarea></td>
    </tr>`,
      )
      .join('');
    this.root.innerHTML = `<h2>Journal <span class="muted">(${rs.length})</span></h2>
      <div class="table-wrap"><table class="journal">
      <thead><tr><th></th><th>Open / close</th><th>Dir</th><th>Type</th><th>Setup tags</th><th>Tickets</th><th>Avg entry</th><th>Lot</th>
      <th>Ladder</th><th>Worst entry</th>
      <th>First SL</th><th title="Risk at the first SL (EA risk_at_first_sl) - net R uses it">R</th><th title="Worst IF SL HITS seen (EA risk_max) - the panel's 1R">Risk max</th><th>SL edits</th>
      <th>Highest stage</th><th>Exit</th><th>Closed by</th><th>Result</th><th>R</th><th>Pips</th>
      <th>MFE pips</th><th title="EA journal: move from the worst entry, $ of price">MFE / MAE / giveback ($)</th><th>Post-close run (4h)</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    for (const tr of this.root.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
      const id = tr.dataset.id!;
      const ta = tr.querySelector('textarea')!;
      ta.addEventListener('change', () => this.saveNote(id, ta.value));
      tr.querySelector<HTMLButtonElement>('.shot-btn')!.onclick = () => showShot(id);
      tr.querySelector<HTMLButtonElement>('.tags-btn')!.onclick = () => this.editTags(id);
    }
  }
}

async function showShot(id: string) {
  const blob = await db.get<Blob>('shots', id);
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.onclick = () => modal.remove();
  if (blob) {
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    modal.append(img);
  } else {
    modal.append(Object.assign(document.createElement('div'), { className: 'modal-msg', textContent: 'No screenshot for this entry' }));
  }
  document.body.append(modal);
}

// ------------------------------------------------------------------ stats

export class StatsPage {
  private kind: LadderKind = 'ladder';
  private from = '';
  private to = '';

  constructor(
    private root: HTMLElement,
    private getRecords: () => JournalRecord[],
    private onExport: () => void,
  ) {}

  render() {
    const all = this.getRecords();
    const rs = filterRecords(all, { kind: this.kind, from: this.from || undefined, to: this.to || undefined });
    const s = computeStats(rs);
    const pct = (v: number | null, d = 1) => (v === null ? '-' : `${v.toFixed(d)}%`);
    const below = [...s.belowOneR]
      .sort((a, b) => b.closeTime - a.closeTime)
      .map(
        (r) => `<tr><td>${fmtTime(r.closeTime)}</td><td class="${r.dir}">${r.dir.toUpperCase()}</td><td>${r.exitReason}</td>
        <td class="${cls(r.result)}">${money(r.result)}</td><td class="${cls(r.resultR)}">${r.resultR?.toFixed(2)}</td>
        <td>${r.mfePips.toFixed(1)}</td><td>${postClose(r)}</td><td>${availablePips(r).toFixed(1)}</td>
        <td>${pct(capturedPct(r), 0)}</td><td>${esc(r.note)}</td></tr>`,
      )
      .join('');
    this.root.innerHTML = `<h2>Stats</h2>
      <div class="filters">
        <label><input type="radio" name="kind" value="ladder" ${this.kind === 'ladder' ? 'checked' : ''}> Ladder</label>
        <label><input type="radio" name="kind" value="normal" ${this.kind === 'normal' ? 'checked' : ''}> Normal</label>
        <label>From <input type="date" id="st-from" value="${this.from}"></label>
        <label>To <input type="date" id="st-to" value="${this.to}"></label>
        <button id="st-csv" class="btn">Export CSV (all journal rows)</button>
      </div>
      <div class="kpis">
        <div class="kpi"><span>Trades</span><b>${s.count}</b></div>
        <div class="kpi"><span>Win rate</span><b>${pct(s.winRate)}</b></div>
        <div class="kpi"><span>Average R</span><b>${s.avgR === null ? '-' : s.avgR.toFixed(2)}</b></div>
        <div class="kpi"><span>Move captured</span><b>${pct(s.capturedPct)}</b><small>result vs best of MFE and 4h post-close run</small></div>
      </div>
      <h3>Closed below 1R <span class="muted">(${s.belowOneR.length})</span></h3>
      ${
        below
          ? `<div class="table-wrap"><table class="journal"><thead><tr><th>Closed</th><th>Dir</th><th>Exit</th><th>Result</th><th>R</th>
             <th>MFE</th><th>Post-close</th><th>Available</th><th>Captured</th><th>Note</th></tr></thead><tbody>${below}</tbody></table></div>`
          : '<p class="muted">None.</p>'
      }`;
    for (const r of this.root.querySelectorAll<HTMLInputElement>('input[name=kind]')) {
      r.onchange = () => {
        this.kind = r.value as LadderKind;
        this.render();
      };
    }
    const f = this.root.querySelector<HTMLInputElement>('#st-from')!;
    const t = this.root.querySelector<HTMLInputElement>('#st-to')!;
    f.onchange = () => {
      this.from = f.value;
      this.render();
    };
    t.onchange = () => {
      this.to = t.value;
      this.render();
    };
    this.root.querySelector<HTMLButtonElement>('#st-csv')!.onclick = () => {
      downloadCSV(all);
      this.onExport(); // also refreshes journal/journal.xlsx
    };
  }
}

function downloadCSV(records: JournalRecord[]) {
  const sorted = [...records].sort((a, b) => a.closeTime - b.closeTime);
  const blob = new Blob([toCSV(sorted)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gold-replay-journal-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ settings

export class SettingsPage {
  constructor(
    private root: HTMLElement,
    private get: () => AppSettings,
    private save: (s: AppSettings) => void,
  ) {}

  render() {
    const s = this.get();
    const a = s.account;
    const num = (id: string, label: string, v: number, step: string, note = '') =>
      `<label class="field"><span>${label}</span><input type="number" id="${id}" value="${v}" step="${step}">${note ? `<small>${note}</small>` : ''}</label>`;
    const chk = (id: string, label: string, v: boolean) => `<label class="check"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${label}</label>`;
    this.root.innerHTML = `<h2>Settings</h2>
      <form id="settings-form">
      <fieldset><legend>Account</legend>
        ${num('s-balance', 'Starting balance ($)', a.startBalance, '1', 'Balance of a new war account')}
        ${num('s-leverage', 'Leverage (1:x)', a.leverage, '1')}
        ${num('s-contract', 'Contract size (oz per lot)', a.contractSize, '1')}
        ${num('s-commission', 'Commission ($ per lot, round turn)', a.commissionPerLot, '0.01')}
        ${num('s-stopout', 'Stop-out level (margin level %)', a.stopOutLevel, '1', 'Placeholder - confirm with your broker')}
        ${num('s-stops', 'Broker stops level (points)', a.stopsLevelPoints, '1', 'Minimum SL/TP distance from price (SYMBOL_TRADE_STOPS_LEVEL). 0 = none')}
      </fieldset>
      <fieldset><legend>Gold Ladder Manager (EA inputs, pips from the AVERAGE entry)</legend>
        ${num('s-bemin', 'BE allowed from + pips', a.beMinPips, '1', 'InpBEMinPips: MOVE TO BE works only while price is this far in profit')}
        ${num('s-bebuf', 'BE SL = average + pips', a.beBufferPips, '0.1', 'InpBEBufferPips')}
        ${num('s-s2t', 'Stage 2 trigger pips', a.s2TrigPips, '1')}
        ${num('s-s2l', 'Stage 2 lock pips', a.s2LockPips, '1', 'Stage 2: SL = average + lock. The average is frozen here for stage 3')}
        ${num('s-s3t', 'Stage 3 trigger pips', a.s3TrigPips, '1')}
        ${num('s-s3l', 'Stage 3 lock pips', a.s3LockPips, '1', 'After stage 3 the runner is yours: no more automatic moves')}
        ${num('s-cap', 'Lot cap per ladder per $100 of balance', a.lotPer100, '0.01', 'Trades above the cap are closed by the manager. Changes only while no trade is open. 0 = no cap')}
        ${num('s-retry', 'Retry cooldown (seconds)', a.retryCooldownSec, '1', 'Wait before retrying an SL/TP that could not be set yet')}
      </fieldset>
      <fieldset><legend>Replay</legend>
        ${chk('s-speedlock', 'Speed lock: only 1x and 2x while a ladder is open', s.speedLock)}
        ${chk('s-sound', 'Sounds: trade opened, trade closed, price touches a zone (like MT5)', s.sound)}
        ${num('s-utc', 'Broker server UTC offset (hours, display only)', s.serverUtcOffset, '0.5')}
      </fieldset>
      <button type="submit" class="btn primary">Save settings</button> <span id="s-saved" class="muted"></span>
      </form>`;
    const form = this.root.querySelector<HTMLFormElement>('#settings-form')!;
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = (id: string, fallback: number) => {
        const n = Number(this.root.querySelector<HTMLInputElement>(`#${id}`)!.value);
        return Number.isFinite(n) ? n : fallback;
      };
      const c = (id: string) => this.root.querySelector<HTMLInputElement>(`#${id}`)!.checked;
      const next: AppSettings = {
        ...s,
        account: {
          startBalance: Math.max(0, v('s-balance', a.startBalance)),
          leverage: Math.max(1, v('s-leverage', a.leverage)),
          contractSize: Math.max(1, v('s-contract', a.contractSize)),
          commissionPerLot: Math.max(0, v('s-commission', a.commissionPerLot)),
          stopOutLevel: Math.max(0, v('s-stopout', a.stopOutLevel)),
          stopsLevelPoints: Math.max(0, v('s-stops', a.stopsLevelPoints)),
          beMinPips: v('s-bemin', a.beMinPips),
          beBufferPips: v('s-bebuf', a.beBufferPips),
          s2TrigPips: v('s-s2t', a.s2TrigPips),
          s2LockPips: v('s-s2l', a.s2LockPips),
          s3TrigPips: v('s-s3t', a.s3TrigPips),
          s3LockPips: v('s-s3l', a.s3LockPips),
          lotPer100: Math.max(0, v('s-cap', a.lotPer100)),
          retryCooldownSec: Math.max(0, v('s-retry', a.retryCooldownSec)),
        },
        speedLock: c('s-speedlock'),
        sound: c('s-sound'),
        serverUtcOffset: v('s-utc', s.serverUtcOffset),
      };
      const why = stageCheck(next.account);
      if (why) {
        this.root.querySelector('#s-saved')!.textContent = `Not saved: ${why}`;
        return;
      }
      this.save(next);
      this.root.querySelector('#s-saved')!.textContent = 'Saved';
    };
  }
}
