// UI thread: wires the toolbar, charts, drawings, panel and pages to the simulation worker.

import type { Time } from 'lightweight-charts';
import { type Bar, TF_MS, TF_NAMES, type TfName } from './core/candles';
import type { Manifest } from './core/daydata';
import { type JournalRecord, POST_CLOSE_TRACK_MS } from './core/engine';
import { isoDate } from './core/stats';
import { type Frame, type FromWorker, LOCKED_SPEEDS, SPEEDS, type ToWorker } from './worker/protocol';
import SimWorker from './worker/sim.worker.ts?worker';
import { CHART_COLORS, ChartView, syncCharts, TradeLines } from './ui/charts';
import * as db from './ui/db';
import { type Drawing, DrawingStore, DrawingsPrimitive, Interaction, type Tool, zonesOf } from './ui/drawings';
import { JournalPage, SettingsPage, StatsPage } from './ui/pages';
import { Panel } from './ui/panel';
import { type AccountState, type AppSettings, loadAccountState, loadSettings, saveAccountState, saveSettings } from './ui/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state

let settings: AppSettings;
let account: AccountState;
let manifest: Manifest | null = null;
let digits = 2;
let session: { date: string; historyFrom: string } | null = null;
const bars: Record<TfName, Bar[]> = { M1: [], M15: [], M30: [] };
let lastFrame: Frame | null = null;
let journal: JournalRecord[] = [];
let page: 'chart' | 'journal' | 'stats' | 'settings' = 'chart';
const pendingShots: string[] = [];

const worker = new SimWorker();
const send = (m: ToWorker) => worker.postMessage(m);

// ------------------------------------------------------------------ toasts

function toast(text: string, level: 'info' | 'warn' | 'pause' = 'info', ms = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${level}`;
  t.textContent = text;
  $('toasts').append(t);
  while ($('toasts').children.length > 6) $('toasts').firstElementChild!.remove();
  setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------------ charts & drawings

const htfView = new ChartView($('chart-htf'), TF_MS.M15 / 1000, 2);
const m1View = new ChartView($('chart-m1'), 60, 2);
syncCharts(htfView, m1View);
const tradeLines = new TradeLines(m1View);
const store = new DrawingStore();

function currentDay(): string {
  return lastFrame ? isoDate(lastFrame.clock) : session?.date ?? '1970-01-01';
}

const interactions: Interaction[] = [];
const prims = [htfView, m1View].map((v) => {
  const p = new DrawingsPrimitive(v, store, () => interactions[v === htfView ? 0 : 1] ?? null);
  v.series.attachPrimitive(p);
  return p;
});
interactions.push(
  new Interaction(htfView, store, { currentDay, onToolDone: () => setTool('select') }),
  new Interaction(m1View, store, {
    currentDay,
    onToolDone: () => setTool('select'),
    tradeLines,
    onTradeDrag: (hit, price, done) => {
      const p = Math.round(price * 10 ** digits) / 10 ** digits;
      if (!done) {
        tradeLines.dragging = { ladderId: hit.ladderId, kind: hit.kind, price: p };
        if (lastFrame) tradeLines.update(lastFrame.snap);
        return;
      }
      tradeLines.dragging = null;
      const l = lastFrame?.snap.ladders.find((x) => x.id === hit.ladderId);
      if (l && Math.abs(p - hit.price) >= 1 / 10 ** digits) {
        // Dragging the average line creates an SL (loss side) or a TP (profit side).
        const kind = hit.kind === 'avg' ? ((p < l.avg) === (l.dir === 'buy') ? 'sl' : 'tp') : hit.kind;
        send({ type: kind === 'sl' ? 'setSL' : 'setTP', ladderId: hit.ladderId, price: p });
      } else if (lastFrame) tradeLines.update(lastFrame.snap);
    },
  }),
);

let zonesTimer = 0;
store.onChange((persist, removed) => {
  for (const p of prims) p.redraw();
  if (persist) void db.put('drawings', persist);
  if (removed) void db.del('drawings', removed);
  if (persist || removed) {
    clearTimeout(zonesTimer);
    zonesTimer = window.setTimeout(() => send({ type: 'zones', zones: zonesOf(store.items) }), 50);
  }
  updateToolButtons();
});

function setTool(t: Tool) {
  store.setTool(t);
}

function updateToolButtons() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) b.classList.toggle('on', b.dataset.tool === store.tool);
  const sel = store.selected();
  $<HTMLButtonElement>('delDrawing').disabled = !sel;
  $('extend-wrap').hidden = !(sel && sel.kind === 'rect');
  if (sel && sel.kind === 'rect') $<HTMLInputElement>('extend').checked = sel.extendRight;
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) b.onclick = () => setTool(b.dataset.tool as Tool);
$<HTMLButtonElement>('delDrawing').onclick = () => store.selectedId && store.remove(store.selectedId);
$<HTMLInputElement>('extend').onchange = () => {
  const sel = store.selected();
  if (sel && sel.kind === 'rect') {
    sel.extendRight = $<HTMLInputElement>('extend').checked;
    store.changed(sel);
  }
};

function showHtf() {
  const tf = settings.htf;
  htfView.setBars(bars[tf], TF_MS[tf] / 1000);
  $('htf-label').textContent = tf;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.htf')) b.classList.toggle('on', b.dataset.htf === tf);
  for (const p of prims) p.redraw();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.htf')) {
  b.onclick = () => {
    settings.htf = b.dataset.htf as 'M15' | 'M30';
    void saveSettings(settings);
    showHtf();
    htfView.scrollToNow();
  };
}
$('now').onclick = () => {
  htfView.scrollToNow();
  m1View.scrollToNow();
};

// ------------------------------------------------------------------ replay controls

const speedsEl = $('speeds');
for (const s of SPEEDS) {
  const b = document.createElement('button');
  b.className = 'btn speed';
  b.textContent = `${s}x`;
  b.dataset.speed = String(s);
  b.onclick = () => send({ type: 'speed', speed: s });
  speedsEl.append(b);
}

function togglePlay() {
  if (!lastFrame) return;
  send({ type: lastFrame.playing ? 'pause' : 'play' });
}
$('play').onclick = togglePlay;
$('stepM1').onclick = () => send({ type: 'step', tf: 'M1' });
$('stepM15').onclick = () => send({ type: 'step', tf: 'M15' });

function startLoad() {
  if (!manifest) return;
  if (lastFrame && (lastFrame.snap.ladders.length || lastFrame.snap.pendingOrders)) {
    if (!confirm('Open positions will be closed (manual close) before loading a new start point. Continue?')) return;
  }
  const date = $<HTMLSelectElement>('date').value;
  const time = $<HTMLInputElement>('time').value || '00:00';
  localStorage.setItem('gr-start', JSON.stringify({ date, time }));
  setEmpty('Loading...');
  send({
    type: 'load',
    date,
    time,
    account: settings.account,
    balance: account.balance,
    blown: account.blown,
    autoPause: settings.autoPause,
    speedLock: settings.speedLock,
    zones: [],
  });
}
$('load').onclick = startLoad;

function utcLabel(): string {
  const o = settings.serverUtcOffset;
  return `server time (UTC${o >= 0 ? '+' : ''}${o})`;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${wd} ${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function updateControls(f: Frame) {
  $('play').textContent = f.playing ? 'Pause' : 'Play';
  $('play').classList.toggle('on', f.playing);
  const locked = settings.speedLock && f.snap.ladders.length > 0;
  for (const b of speedsEl.querySelectorAll<HTMLButtonElement>('.speed')) {
    const s = Number(b.dataset.speed);
    b.classList.toggle('on', s === f.speed);
    b.disabled = locked && !LOCKED_SPEEDS.includes(s);
    b.title = b.disabled ? 'Speed lock: only 1x and 2x while a ladder is open' : '';
  }
  $('clock').textContent = `${fmtClock(f.clock)}  ${utcLabel()}${f.ended ? '  - end of data' : ''}`;
}

// ------------------------------------------------------------------ panel

const panelPos = (() => {
  try {
    return JSON.parse(localStorage.getItem('gr-panel') ?? 'null');
  } catch {
    return null;
  }
})();

let panel: Panel;

function initPanel() {
  panel = new Panel(
    document.body,
    {
      order: (dir, lot) => send({ type: 'order', dir, lot }),
      setSL: (ladderId, price) => send({ type: 'setSL', ladderId, price }),
      setTP: (ladderId, price) => send({ type: 'setTP', ladderId, price }),
      be: (ladderId) => send({ type: 'be', ladderId }),
      closeLadder: (ladderId) => send({ type: 'closeLadder', ladderId }),
      closeAll: () => send({ type: 'closeAll' }),
      newLadder: () => send({ type: 'newLadder' }),
      cancelNewLadder: () => send({ type: 'cancelNewLadder' }),
      setKind: (ladderId, kind) => send({ type: 'setKind', ladderId, kind }),
      newWarAccount: () => {
        if (!session) {
          account = { balance: settings.account.startBalance, blown: false };
          void saveAccountState(account);
          toast(`New war account: balance $${account.balance}`);
          return;
        }
        const open = lastFrame?.snap.ladders.length ? ' Open positions will be closed first.' : '';
        if (confirm(`Start a new war account with $${settings.account.startBalance}? The journal is kept.${open}`)) {
          send({ type: 'newWarAccount', account: settings.account });
        }
      },
      lotChanged: (lot) => {
        settings.lot = lot;
        void saveSettings(settings);
      },
      moved: (pos) => localStorage.setItem('gr-panel', JSON.stringify(pos)),
    },
    panelPos,
    settings.lot,
  );
}

// ------------------------------------------------------------------ pages

const journalPage = new JournalPage($('page-journal'), () => journal, (id, note) => {
  const r = journal.find((x) => x.id === id);
  if (r) {
    r.note = note;
    void db.put('journal', r);
  }
});
const statsPage = new StatsPage($('page-stats'), () => journal);
const settingsPage = new SettingsPage(
  $('page-settings'),
  () => settings,
  (s) => {
    settings = s;
    void saveSettings(s);
    send({ type: 'settings', account: s.account, autoPause: s.autoPause, speedLock: s.speedLock });
    if (lastFrame) updateControls(lastFrame);
  },
);

function showPage(p: typeof page) {
  page = p;
  for (const name of ['journal', 'stats', 'settings'] as const) $(`page-${name}`).hidden = p !== name;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav')) b.classList.toggle('on', b.dataset.page === p);
  panel.root.hidden = p !== 'chart';
  if (p === 'journal') journalPage.render();
  if (p === 'stats') statsPage.render();
  if (p === 'settings') settingsPage.render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.nav')) b.onclick = () => showPage(b.dataset.page as typeof page);

// ------------------------------------------------------------------ worker messages

function setEmpty(html: string) {
  $('empty').innerHTML = html;
}

function applyBars(f: Frame) {
  for (const tf of TF_NAMES) {
    const changed = f.bars[tf];
    if (!changed) continue;
    const arr = bars[tf];
    for (const b of changed) {
      const last = arr[arr.length - 1];
      if (last && last.time === b.time) arr[arr.length - 1] = b;
      else if (!last || b.time > last.time) arr.push(b);
      else continue;
      if (tf === 'M1') m1View.update(b);
      if (tf === settings.htf) htfView.update(b);
    }
  }
}

function applyFrame(f: Frame) {
  applyBars(f);
  lastFrame = f;
  for (const ev of f.events) {
    if (ev.type === 'fill' && ev.price !== undefined) {
      const buy = ev.dir === 'buy';
      tradeLines.addMarker({
        time: (Math.floor(ev.time / 60_000) * 60) as Time,
        position: buy ? 'atPriceBottom' : 'atPriceTop',
        price: ev.price,
        shape: buy ? 'arrowUp' : 'arrowDown',
        color: CHART_COLORS.marker,
        text: `${buy ? 'B' : 'S'} ${ev.lot}`,
      });
    }
  }
  tradeLines.update(f.snap);
  panel.update(f.snap);
  updateControls(f);
  if (f.snap.balance !== account.balance || f.snap.blown !== account.blown) {
    account = { balance: f.snap.balance, blown: f.snap.blown };
    void saveAccountState(account);
  }
  if (pendingShots.length) requestAnimationFrame(() => requestAnimationFrame(takeShots));
}

function takeShots() {
  while (pendingShots.length) {
    const id = pendingShots.shift()!;
    try {
      m1View.chart.takeScreenshot().toBlob((blob) => blob && void db.put('shots', blob, id), 'image/png');
    } catch {
      /* chart not visible */
    }
  }
}

function onJournal(r: JournalRecord) {
  journal.push(r);
  void db.put('journal', r);
  const exitText = { SL: 'SL', 'stage SL': 'SL', TP: 'TP', 'manual close': 'X', 'stop-out': 'SO' }[r.exitReason];
  const lastTicket = r.tickets[r.tickets.length - 1];
  if (lastTicket) {
    tradeLines.addMarker({
      time: (Math.floor(r.closeTime / 60_000) * 60) as Time,
      position: 'atPriceMiddle',
      price: lastTicket.closePrice,
      shape: 'circle',
      color: CHART_COLORS.exit,
      text: `${exitText} ${r.result >= 0 ? '+' : ''}${r.result.toFixed(2)}`,
    });
  }
  pendingShots.push(r.id);
  toast(`Ladder closed (${r.exitReason}): ${r.result >= 0 ? '+' : ''}$${r.result.toFixed(2)}${r.resultR !== null ? ` = ${r.resultR.toFixed(2)}R` : ''}`, 'info', 6000);
  if (page === 'journal') journalPage.render();
}

function onPostClose(entryId: string, pips: number | null, done: boolean) {
  const r = journal.find((x) => x.id === entryId);
  if (!r) return;
  r.postClosePips = pips;
  r.postCloseDone = done;
  void db.put('journal', r);
  if (page === 'journal') journalPage.render();
  if (page === 'stats') statsPage.render();
}

async function onLoaded(msg: Extract<FromWorker, { type: 'loaded' }>) {
  session = { date: msg.date, historyFrom: msg.historyFrom };
  bars.M1 = msg.bars.M1;
  bars.M15 = msg.bars.M15;
  bars.M30 = msg.bars.M30;
  lastFrame = null;
  tradeLines.clearMarkers();
  tradeLines.clearLines();
  m1View.setBars(bars.M1, 60);
  showHtf();
  // Drawings: those made up to this date (last 30 days), never ones made on later dates.
  const from = isoDate(Date.parse(msg.date) - 30 * 86_400_000);
  const items = await db.drawingsBetween<Drawing>(from, msg.date).catch(() => []);
  store.setAll(items);
  send({ type: 'zones', zones: zonesOf(items) });
  applyFrame(msg.frame);
  m1View.chart.timeScale().setVisibleLogicalRange({ from: bars.M1.length - 150, to: bars.M1.length + 10 });
  htfView.chart.timeScale().setVisibleLogicalRange({ from: bars[settings.htf].length - 120, to: bars[settings.htf].length + 8 });
  setEmpty('');
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'manifest':
      onManifest(msg.manifest);
      break;
    case 'loaded':
      void onLoaded(msg);
      break;
    case 'frame':
      applyFrame(msg.frame);
      break;
    case 'journal':
      onJournal(msg.record);
      break;
    case 'postClose':
      onPostClose(msg.entryId, msg.pips, msg.done);
      break;
    case 'notice':
      toast(msg.text, msg.level, msg.level === 'pause' ? 5000 : 4000);
      break;
    case 'status':
      $('status').textContent = msg.text;
      break;
    case 'error':
      toast(msg.message, 'warn', 8000);
      if (!session) setEmpty(`<div><h3>Could not load data</h3><p>${msg.message}</p>${HOWTO}</div>`);
      break;
  }
};

const HOWTO = `<p>Convert an MT5 tick export first (Symbols &rarr; Ticks &rarr; XAUUSD &rarr; Export):</p>
<pre>python converter\\convert.py path\\to\\XAUUSD_ticks.csv</pre>
<p>or try the synthetic sample:</p>
<pre>python converter\\make_sample.py --out sample_ticks.csv
python converter\\convert.py sample_ticks.csv</pre><p>Then reload this page.</p>`;

function onManifest(m: Manifest) {
  manifest = m;
  digits = m.digits;
  panel.digits = digits;
  for (const v of [htfView, m1View]) v.series.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 1 / 10 ** digits } });
  const sel = $<HTMLSelectElement>('date');
  sel.innerHTML = '';
  if (!m.days.length) {
    setEmpty(`<div><h3>No days in the data manifest</h3>${HOWTO}</div>`);
    return;
  }
  for (const d of m.days) {
    const o = document.createElement('option');
    o.value = d.date;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d.date}T00:00:00Z`).getUTCDay()];
    o.textContent = `${d.date} ${wd} (${Math.round(d.ticks / 1000)}k ticks)`;
    sel.append(o);
  }
  try {
    const last = JSON.parse(localStorage.getItem('gr-start') ?? 'null');
    if (last && m.days.some((d) => d.date === last.date)) {
      sel.value = last.date;
      $<HTMLInputElement>('time').value = last.time;
    } else sel.value = m.days[Math.min(m.days.length - 1, 5)].date;
  } catch {
    /* ignore */
  }
  setEmpty('<div><h3>Pick a start date and time, then Load</h3><p class="muted">Nothing after the start time is shown. Times are broker server time.</p></div>');
  // Finish post-close tracking for entries left unfinished by an earlier page session.
  const unfinished = journal.filter((r) => !r.postCloseDone);
  if (unfinished.length) {
    send({
      type: 'finalizePostClose',
      items: unfinished.map((r) => ({ entryId: r.id, dir: r.dir, avg: r.avgEntry, from: r.closeTime + 1, until: r.closeTime + POST_CLOSE_TRACK_MS, max: r.postClosePips })),
    });
  }
}

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(t.type));
  if (typing) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    send({ type: 'step', tf: e.shiftKey ? 'M15' : 'M1' });
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (store.selectedId) store.remove(store.selectedId);
  } else if (e.key === 'Escape') {
    setTool('select');
    store.select(null);
  } else if (e.key === 'End') {
    htfView.scrollToNow();
    m1View.scrollToNow();
  } else if (e.key === 'r' || e.key === 'R') setTool('rect');
  else if (e.key === 'h' || e.key === 'H') setTool('hline');
  else if (e.key === 't' || e.key === 'T') setTool('text');
});

window.addEventListener('beforeunload', (e) => {
  if (lastFrame && (lastFrame.snap.ladders.length || lastFrame.snap.pendingOrders)) e.preventDefault();
});

// ------------------------------------------------------------------ boot

async function boot() {
  settings = await loadSettings();
  account = await loadAccountState(settings);
  journal = await db.getAll<JournalRecord>('journal').catch(() => []);
  initPanel();
  panel.update({
    time: 0,
    bid: NaN,
    ask: NaN,
    balance: account.balance,
    equity: account.balance,
    margin: 0,
    freeMargin: account.balance,
    marginLevel: null,
    blown: account.blown,
    ladders: [],
    activeLadderId: null,
    newLadderArmed: false,
    canNewLadder: false,
    openLadders: 0,
    pendingOrders: 0,
  });
  showPage('chart');
  showHtf();
  setTool('select');
  setEmpty('Loading data manifest...');
  send({ type: 'init', dataUrl: new URL('data/XAUUSD/', new URL('/', location.href)).href });
}

void boot();

// Test hook: open the app with ?debug to reach the chart views from the console.
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __gr: { m1View, htfView, store, tradeLines } });
