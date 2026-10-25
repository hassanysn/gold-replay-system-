// Gold Replay LIVE: the replay UI (charts, drawings, EA panel, journal) on your real MT5 account,
// through live/bridge.py. The EA on the MT5 chart stays the ladder manager; this page reads its
// state file and sends it NEW LADDER / MOVE TO BE. Orders, closes and SL/TP edits go straight to MT5.

import type { Time } from 'lightweight-charts';
import { type Bar, TF_MS, TF_NAMES, type TfName } from '../core/candles';
import { EMPTY_TAGS, type JournalRecord, tagsComplete } from '../core/engine';
import type { Dir } from '../core/pips';
import { ZONE_REARM, type Zone } from '../core/replay';
import { isoDate } from '../core/stats';
import { CHART_COLORS, ChartView, syncCharts, TradeLines } from '../ui/charts';
import * as db from '../ui/db';
import { type Drawing, DrawingStore, DrawingsPrimitive, Interaction, type Tool, zonesOf } from '../ui/drawings';
import { onJournalSyncStatus, syncJournal, uploadShot } from '../ui/journalSync';
import { JournalPage, StatsPage } from '../ui/pages';
import { Panel } from '../ui/panel';
import { playAlert, playClose, playOpen, setSoundEnabled, unlockSound } from '../ui/sound';
import { openTagCard } from '../ui/tags';
import { api, type LiveInit, type Poll, resultText, type TradeResult } from './api';
import { buildRecord, postCloseFromRange } from './journal';
import { type Group, LiveState, type Tracker, type UpdateResult } from './state';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const POLL_MS = 150;
const POST_CLOSE_MS = 4 * 60 * 60 * 1000;
const BARS: Record<TfName, number> = { M1: 1500, M15: 1000, M30: 600 };

// ------------------------------------------------------------------ preferences (this browser)

interface Prefs {
  htf: 'M15' | 'M30';
  lot: number;
  sound: boolean;
}
const prefs: Prefs = (() => {
  const def: Prefs = { htf: 'M15', lot: 0.01, sound: true };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem('grl-prefs') ?? '{}') };
  } catch {
    return def;
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem('grl-prefs', JSON.stringify(prefs));
  } catch {
    /* private window */
  }
};

// ------------------------------------------------------------------ state

let info: LiveInit;
let state: LiveState;
let last: { poll: Poll; r: UpdateResult } | null = null;
let journal: JournalRecord[] = [];
let page: 'chart' | 'journal' | 'stats' = 'chart';
let armed = false;
let busy = false;
const bars: Record<TfName, Bar[]> = { M1: [], M15: [], M30: [] };
const pendingShots: string[] = [];
/** EA commands sent, waiting for the EA's answer in its state file. */
const pendingCmds = new Map<number, { what: string; sent: number }>();

window.addEventListener('pointerdown', unlockSound, { once: true });

function toast(text: string, level: 'info' | 'warn' | 'pause' = 'info', ms = 4500) {
  const t = document.createElement('div');
  t.className = `toast ${level}`;
  t.textContent = text;
  $('toasts').append(t);
  while ($('toasts').children.length > 6) $('toasts').firstElementChild!.remove();
  setTimeout(() => t.remove(), ms);
}

function setEmpty(html: string) {
  $('empty').innerHTML = html;
}

// ------------------------------------------------------------------ charts & drawings

const htfView = new ChartView($('chart-htf'), TF_MS.M15 / 1000, 2);
const m1View = new ChartView($('chart-m1'), 60, 2);
syncCharts(htfView, m1View);
const tradeLines = new TradeLines(m1View);
const store = new DrawingStore();
const nowMs = () => last?.poll.quote.time ?? Date.now();
const currentDay = () => isoDate(nowMs());

const interactions: Interaction[] = [];
const prims = [htfView, m1View].map((v) => {
  const p = new DrawingsPrimitive(v, store, () => interactions[v === htfView ? 0 : 1] ?? null);
  v.series.attachPrimitive(p);
  return p;
});
interactions.push(
  new Interaction(htfView, store, { currentDay, onToolDone: () => store.setTool('select'), now: nowMs }),
  new Interaction(m1View, store, {
    currentDay,
    onToolDone: () => store.setTool('select'),
    now: nowMs,
    tradeLines,
    onTradeDrag: (hit, price, done) => {
      const p = Math.round(price * 10 ** info.digits) / 10 ** info.digits;
      if (!done) {
        tradeLines.dragging = { ladderId: hit.ladderId, kind: hit.kind, price: p };
        if (last) tradeLines.update(last.r.snap);
        return;
      }
      tradeLines.dragging = null;
      const snap = last?.r.snap;
      const g =
        hit.ladderId > 0
          ? snap?.ladders.find((x) => x.id === hit.ladderId)
          : snap?.unmanaged.map((t) => ({ ...t, avg: t.openPrice })).find((t) => t.id === -hit.ladderId);
      if (g && g.dir && Math.abs(p - hit.price) >= 1 / 10 ** info.digits) {
        const kind = hit.kind === 'avg' ? ((p < g.avg) === (g.dir === 'buy') ? 'sl' : 'tp') : hit.kind;
        if (hit.ladderId > 0) void (kind === 'sl' ? setLadderSL(hit.ladderId, p) : setLadderTP(hit.ladderId, p));
        else void setTicket(-hit.ladderId, kind, p);
      } else if (snap) tradeLines.update(snap);
    },
  }),
);

// zone alert: once per touch, re-armed after price moved 10 pips away (same rule as the replay)
let zones: Zone[] = [];
const zoneArmed = new Map<string, boolean>();
function setZones(z: Zone[]) {
  const bid = last?.poll.quote.bid ?? NaN;
  const t = nowMs();
  zones = z;
  const next = new Map<string, boolean>();
  for (const x of z) next.set(x.id, zoneArmed.get(x.id) ?? !(zoneLive(x, t) && bid >= x.low && bid <= x.high));
  zoneArmed.clear();
  for (const [k, v] of next) zoneArmed.set(k, v);
}
const zoneLive = (z: Zone, t: number) => t >= z.t1 && (z.extendRight || t <= z.t2);
function checkZones(p: Poll) {
  const [lo, hi] = p.range ?? [p.quote.bid, p.quote.bid];
  let hit = false;
  for (const z of zones) {
    if (!zoneLive(z, p.quote.time)) continue;
    if (hi >= z.low && lo <= z.high) {
      if (zoneArmed.get(z.id)) {
        zoneArmed.set(z.id, false);
        hit = true;
      }
    } else if (p.quote.bid >= z.high + ZONE_REARM || p.quote.bid <= z.low - ZONE_REARM) zoneArmed.set(z.id, true);
  }
  if (hit) playAlert();
}

let zonesTimer = 0;
store.onChange((persist, removed) => {
  for (const p of prims) p.redraw();
  if (persist) void db.put('drawings', persist);
  if (removed) void db.del('drawings', removed);
  if (persist || removed) {
    clearTimeout(zonesTimer);
    zonesTimer = window.setTimeout(() => setZones(zonesOf(store.items)), 50);
  }
  updateToolButtons();
});

function updateToolButtons() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) b.classList.toggle('on', b.dataset.tool === store.tool);
  const sel = store.selected();
  $<HTMLButtonElement>('delDrawing').disabled = !sel;
  $('extend-wrap').hidden = !(sel && sel.kind === 'rect');
  if (sel && sel.kind === 'rect') $<HTMLInputElement>('extend').checked = sel.extendRight;
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) b.onclick = () => store.setTool(b.dataset.tool as Tool);
$<HTMLButtonElement>('delDrawing').onclick = () => store.selectedId && store.remove(store.selectedId);
$<HTMLInputElement>('extend').onchange = () => {
  const sel = store.selected();
  if (sel && sel.kind === 'rect') {
    sel.extendRight = $<HTMLInputElement>('extend').checked;
    store.changed(sel);
  }
};

function showHtf() {
  const tf = prefs.htf;
  htfView.setBars(bars[tf], TF_MS[tf] / 1000);
  $('htf-label').textContent = tf;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.htf')) b.classList.toggle('on', b.dataset.htf === tf);
  for (const p of prims) p.redraw();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.htf')) {
  b.onclick = () => {
    prefs.htf = b.dataset.htf as 'M15' | 'M30';
    savePrefs();
    showHtf();
    htfView.chart.timeScale().setVisibleLogicalRange({ from: bars[prefs.htf].length - 120, to: bars[prefs.htf].length + 8 });
  };
}
$('now').onclick = () => {
  htfView.scrollToNow();
  m1View.scrollToNow();
};
$<HTMLInputElement>('sound').checked = prefs.sound;
$<HTMLInputElement>('sound').onchange = () => {
  prefs.sound = $<HTMLInputElement>('sound').checked;
  setSoundEnabled(prefs.sound);
  savePrefs();
};

async function loadBars(tf: TfName) {
  const r = await api.rates(tf, BARS[tf]);
  bars[tf] = r.bars;
  if (tf === 'M1') m1View.setBars(bars.M1, 60);
  if (tf === prefs.htf) showHtf();
}

const reloading = new Set<TfName>();
function applyBars(p: Poll) {
  for (const tf of TF_NAMES) {
    const arr = bars[tf];
    for (const b of p.bars[tf] ?? []) {
      const lastBar = arr[arr.length - 1];
      if (lastBar && lastBar.time === b.time) {
        if (lastBar.high === b.high && lastBar.low === b.low && lastBar.close === b.close && lastBar.open === b.open) continue;
        arr[arr.length - 1] = b;
      } else if (!lastBar || b.time > lastBar.time) {
        // bars missed (PC asleep, connection lost): reload this timeframe from MT5
        if (lastBar && b.time - lastBar.time > (TF_MS[tf] / 1000) * 2 && p.bars[tf][0].time > lastBar.time) {
          if (!reloading.has(tf)) {
            reloading.add(tf);
            void loadBars(tf).finally(() => reloading.delete(tf));
          }
          break;
        }
        arr.push(b);
      } else continue;
      if (tf === 'M1') m1View.update(b);
      if (tf === prefs.htf) htfView.update(b);
    }
  }
}

// ------------------------------------------------------------------ trading actions

function group(uid: number): Group | undefined {
  return last?.r.groups.find((g) => g.tracker.uid === uid);
}

function canTrade(): boolean {
  if (!armed) {
    toast('LIVE trading is OFF - tick "LIVE trading" in the toolbar first.', 'warn');
    return false;
  }
  if (last && !last.poll.tradeAllowed) {
    toast('Algo Trading is OFF in MT5: press the "Algo Trading" button in the MT5 toolbar.', 'warn');
    return false;
  }
  if (busy) {
    toast('Still sending the last request...', 'info', 1500);
    return false;
  }
  return true;
}

async function trade(label: string, fn: () => Promise<TradeResult>): Promise<boolean> {
  busy = true;
  try {
    const r = await fn();
    if (r.ok) toast(label, 'info', 3000);
    else toast(`${label.split(' |')[0]} - refused: ${resultText(r)}`, 'warn', 7000);
    return r.ok;
  } catch (e) {
    toast(`${label.split(' |')[0]} - failed: ${(e as Error).message}`, 'warn', 7000);
    return false;
  } finally {
    busy = false;
    void pollNow();
  }
}

const px = (p: number) => p.toFixed(info.digits);

async function order(dir: Dir, lot: number) {
  if (!canTrade() || !last) return;
  lot = Math.round(lot * 100) / 100;
  if (!(lot >= info.volumeMin)) return toast(`Lot must be at least ${info.volumeMin}`, 'warn');
  const j = state.joinInfo(last.r, dir);
  const cap = last.r.snap.lotCap;
  if (j.opposite) {
    if (!confirm(`${dir.toUpperCase()} ${lot.toFixed(2)} is opposite to ${j.ladder}. The EA will NOT manage it (unmanaged ticket). Send it anyway?`)) return;
  } else if (j.lots + lot > cap + 1e-9) {
    return toast(`LOT CAP: ${j.ladder} has ${j.lots.toFixed(2)} lot, + ${lot.toFixed(2)} is over the cap of ${cap.toFixed(2)} lot (0.10 lot per $100 of balance). Not sent.`, 'warn', 7000);
  }
  await trade(`${dir.toUpperCase()} ${lot.toFixed(2)} sent`, () => api.order(dir, lot));
}

async function setLadderSL(uid: number, price: number | null) {
  const g = group(uid);
  if (!g || !g.positions.length || !last || !canTrade()) return refresh();
  if (price === null) {
    toast('The ladder SL cannot be removed, only moved (like the EA).', 'warn');
    return refresh();
  }
  const dir = g.positions[0].dir;
  const q = last.poll.quote;
  if (dir === 'buy' ? price >= q.bid : price <= q.ask) {
    toast(`SL ${px(price)} is on the wrong side of price (${dir === 'buy' ? `bid ${px(q.bid)}` : `ask ${px(q.ask)}`}) - the broker rejects it.`, 'warn');
    return refresh();
  }
  await trade(`L${g.tracker.rank} SL -> ${px(price)} on ${g.positions.length} ticket(s)`, () => api.modify(g.positions.map((x) => ({ ticket: x.ticket, sl: price }))));
}

async function setLadderTP(uid: number, price: number | null) {
  const g = group(uid);
  if (!g || !g.positions.length || !last || !canTrade()) return refresh();
  const dir = g.positions[0].dir;
  const q = last.poll.quote;
  if (price !== null && (dir === 'buy' ? price <= q.bid : price >= q.ask)) {
    toast(`TP ${px(price)} is on the wrong side of price - the broker rejects it.`, 'warn');
    return refresh();
  }
  await trade(`L${g.tracker.rank} TP -> ${price === null ? 'none' : px(price)}`, () => api.modify(g.positions.map((x) => ({ ticket: x.ticket, tp: price }))));
}

async function setTicket(ticket: number, kind: 'sl' | 'tp', price: number | null) {
  if (!canTrade()) return refresh();
  await trade(`#${ticket} ${kind.toUpperCase()} -> ${price === null ? 'none' : px(price)}`, () => api.modify([{ ticket, [kind]: price }]));
}

async function moveToBE(uid: number) {
  const g = group(uid);
  if (!g || !g.positions.length || !last || !canTrade()) return;
  if (g.ea) return eaCommand('moveToBE', g.ea.id, `MOVE TO BE L${g.ea.rank}`);
  // EA not running: same rule done here - from +30 pips, SL = average +1 pip on every ticket
  const s = last.r.settings;
  const dir = g.positions[0].dir;
  const d = dir === 'buy' ? 1 : -1;
  const avg = LiveState.average(g.positions);
  const q = last.poll.quote;
  const pips = (dir === 'buy' ? q.bid - avg : avg - q.ask) / s.pip;
  if (pips < s.beMin - 1e-6) return toast(`MOVE TO BE refused - TOO EARLY | price ${pips.toFixed(1)} pips from average ${px(avg)} | allowed from +${s.beMin} pips`, 'warn');
  const be = Math.round((avg + d * s.beBuf * s.pip) * 10 ** info.digits) / 10 ** info.digits;
  await trade(`L${g.tracker.rank} SL -> ${px(be)} (average +${s.beBuf} pip)`, () => api.modify(g.positions.map((x) => ({ ticket: x.ticket, sl: be }))));
}

async function eaCommand(action: 'newLadder' | 'moveToBE', ladderId: number, what: string) {
  busy = true;
  try {
    const r = await api.ea(action, ladderId);
    if (!r.ok || !r.seq) toast(`${what} - ${r.comment}`, 'warn', 7000);
    else pendingCmds.set(r.seq, { what, sent: Date.now() });
  } catch (e) {
    toast(`${what} - failed: ${(e as Error).message}`, 'warn');
  } finally {
    busy = false;
  }
}

function checkCommands(p: Poll) {
  const c = p.ea?.cmd;
  for (const [seq, v] of pendingCmds) {
    if (c && c.seq === seq) {
      toast(`${v.what}: ${c.ok ? '' : 'refused - '}${c.msg}`, c.ok ? 'info' : 'warn', 6000);
      pendingCmds.delete(seq);
    } else if (Date.now() - v.sent > 6000) {
      toast(`${v.what}: the EA did not answer (is it still on the ${info.symbol} chart with Algo Trading on?)`, 'warn', 7000);
      pendingCmds.delete(seq);
    }
  }
}

async function closeTickets(tickets: number[], label: string) {
  if (!tickets.length || !canTrade()) return;
  await trade(label, () => api.close(tickets));
}

function refresh() {
  if (last) {
    panel.update(last.r.snap);
    tradeLines.update(last.r.snap);
  }
}

// ------------------------------------------------------------------ panel

const panelPos = (() => {
  try {
    return JSON.parse(localStorage.getItem('grl-panel') ?? 'null');
  } catch {
    return null;
  }
})();

const panel = new Panel(
  document.body,
  {
    order: (dir, lot) => void order(dir, lot),
    setSL: (uid, price) => void setLadderSL(uid, price),
    setTP: (uid, price) => void setLadderTP(uid, price),
    be: (uid) => void moveToBE(uid),
    closeLadder: (uid) => {
      const g = group(uid);
      if (g) void closeTickets(g.positions.map((x) => x.ticket), `L${g.tracker.rank} closed (${g.positions.length} ticket(s))`);
    },
    closeAll: () => {
      const all = last?.poll.positions.map((x) => x.ticket) ?? [];
      if (all.length && canTrade() && confirm(`Close ALL ${all.length} ${info.symbol} position(s) at market?`)) void closeTickets(all, 'All positions closed');
    },
    newLadder: () => {
      if (!canTrade() || !last) return;
      if (!last.r.eaOn) return toast('NEW LADDER is an EA button: attach GoldLadderManager v3.0-s6 to the chart first.', 'warn');
      if (!last.r.snap.canNewLadder) return toast(`NEW LADDER refused - ${last.r.snap.newLadderWhy}`, 'warn');
      void eaCommand('newLadder', 0, 'NEW LADDER');
    },
    setTicketSL: (ticket, price) => void setTicket(ticket, 'sl', price),
    setTicketTP: (ticket, price) => void setTicket(ticket, 'tp', price),
    closeTicket: (ticket) => void closeTickets([ticket], `#${ticket} closed`),
    setTags: (uid, tags) => {
      const t = state?.tracker(uid);
      if (t) {
        t.tags = tags;
        saveTrackers(true);
      }
    },
    newWarAccount: () => {},
    lotChanged: (lot) => {
      prefs.lot = lot;
      savePrefs();
    },
    moved: (pos) => localStorage.setItem('grl-panel', JSON.stringify(pos)),
  },
  panelPos,
  prefs.lot,
  { war: false },
);

function setArmed(on: boolean) {
  if (on && info?.account.mode === 'REAL' && !confirm(`Turn on LIVE trading on your REAL account ${info.account.login} (${info.account.server})?\n\nOrders from this page are real money.`)) on = false;
  armed = on;
  $<HTMLInputElement>('arm').checked = on;
  $('arm-text').textContent = on ? 'LIVE trading ON' : 'LIVE trading OFF';
  $('arm-wrap').classList.toggle('on', on);
  panel.root.classList.toggle('disarmed', !on);
}
$<HTMLInputElement>('arm').onchange = () => setArmed($<HTMLInputElement>('arm').checked);

// ------------------------------------------------------------------ journal

function saveRecord(r: JournalRecord) {
  void db.put('journal', r);
  syncJournal(journal);
}

function editTags(r: JournalRecord) {
  openTagCard(`Setup tags - ${r.dir.toUpperCase()} ${r.ladderNo ? `L${r.ladderNo} ` : ''}closed ${new Date(r.closeTime).toISOString().slice(0, 16).replace('T', ' ')}`, r.tags, (t) => {
    r.tags = t;
    saveRecord(r);
    if (page === 'journal') journalPage.render();
  });
}

async function journalize(t: Tracker, tries = 0) {
  try {
    const { deals } = await api.deals(t.tickets);
    const complete = t.tickets.every((k) => deals.some((d) => d.position === k && d.entry !== 'in'));
    if (!complete && tries < 5) {
      setTimeout(() => void journalize(t, tries + 1), 1500);
      return;
    }
    const rec = buildRecord(t, deals, info.contractSize, last?.poll.account.balance ?? t.balBefore, info.account.login);
    if (!rec || journal.some((r) => r.id === rec.id)) return;
    journal.push(rec);
    saveRecord(rec);
    if (rec.kind === 'ladder' && !tagsComplete(rec.tags)) editTags(rec);
    const lt = rec.tickets[rec.tickets.length - 1];
    tradeLines.addMarker({
      time: (Math.floor(rec.closeTime / 60_000) * 60) as Time,
      position: 'atPriceMiddle',
      price: lt.closePrice,
      shape: 'circle',
      color: CHART_COLORS.exit,
      text: `${{ SL: 'SL', 'stage SL': 'SL', TP: 'TP', 'manual close': 'X', 'cap close': 'CAP', 'stop-out': 'SO' }[rec.exitReason]} ${rec.result >= 0 ? '+' : ''}${rec.result.toFixed(2)}`,
    });
    pendingShots.push(rec.id);
    requestAnimationFrame(() => requestAnimationFrame(takeShots));
    toast(`${rec.kind === 'ladder' ? `Ladder L${rec.ladderNo}` : 'Ticket'} closed (${rec.exitReason}): ${rec.result >= 0 ? '+' : ''}$${rec.result.toFixed(2)}${rec.resultR !== null ? ` = ${rec.resultR.toFixed(2)}R` : ''}`, 'info', 7000);
    if (page === 'journal') journalPage.render();
  } catch (e) {
    if (tries < 5) setTimeout(() => void journalize(t, tries + 1), 3000);
    else toast(`Journal: could not read the deals of the closed ladder (${(e as Error).message})`, 'warn');
  }
}

function takeShots() {
  while (pendingShots.length) {
    const id = pendingShots.shift()!;
    try {
      m1View.chart.takeScreenshot().toBlob((blob) => {
        if (!blob) return;
        void db.put('shots', blob, id);
        void uploadShot(id, blob);
      }, 'image/png');
    } catch {
      /* chart hidden */
    }
  }
}

let postCloseBusy = false;
async function updatePostClose() {
  if (postCloseBusy || !last) return;
  postCloseBusy = true;
  const now = last.poll.quote.time;
  try {
    for (const r of journal.filter((x) => !x.postCloseDone && x.id.startsWith('live-'))) {
      const until = r.closeTime + POST_CLOSE_MS;
      const rg = await api.range(r.closeTime, Math.min(now, until));
      const pips = postCloseFromRange(r, rg.high, rg.low);
      const done = now >= until;
      if (pips !== r.postClosePips || done !== r.postCloseDone) {
        r.postClosePips = pips;
        r.postCloseDone = done;
        saveRecord(r);
      }
    }
    if (page === 'journal') journalPage.render();
  } catch {
    /* next round */
  } finally {
    postCloseBusy = false;
  }
}

const journalPage = new JournalPage(
  $('page-journal'),
  () => journal,
  (id, note) => {
    const r = journal.find((x) => x.id === id);
    if (r) {
      r.note = note;
      saveRecord(r);
    }
  },
  (id) => {
    const r = journal.find((x) => x.id === id);
    if (r) editTags(r);
  },
);
const statsPage = new StatsPage($('page-stats'), () => journal, () => syncJournal(journal, 0));

function showPage(p: typeof page) {
  page = p;
  for (const name of ['journal', 'stats'] as const) $(`page-${name}`).hidden = p !== name;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav')) b.classList.toggle('on', b.dataset.page === p);
  panel.root.hidden = p !== 'chart';
  if (p === 'journal') journalPage.render();
  if (p === 'stats') statsPage.render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.nav')) b.onclick = () => showPage(b.dataset.page as typeof page);

// ------------------------------------------------------------------ trackers (survive a reload)

let trackersSaved = '';
function saveTrackers(force = false) {
  const s = JSON.stringify(state.saved());
  if (!force && s === trackersSaved) return;
  trackersSaved = s;
  void db.put('kv', JSON.parse(s), `live-trackers-${info.account.login}`);
}

// ------------------------------------------------------------------ poll loop

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

let online = true;
let lastSave = 0;
let lastPostClose = 0;

function onPoll(p: Poll) {
  applyBars(p);
  const r = state.update(p);
  last = { poll: p, r };
  if (r.openedTickets.length) playOpen();
  if (r.closedTickets.length) playClose();
  checkZones(p);
  checkCommands(p);
  if (!tradeLines.dragging) tradeLines.update(r.snap);
  panel.update(r.snap);
  for (const t of r.closed) void journalize(t);

  const ea = p.ea;
  const eaEl = $('ea');
  if (ea?.running) {
    eaEl.textContent = `EA ${ea.version} running`;
    eaEl.className = 'ea-status ok';
    eaEl.title = 'GoldLadderManager is managing the ladders on the MT5 chart';
  } else {
    eaEl.textContent = ea ? `EA stopped (${Math.round(ea.age)} s ago)` : 'EA not running';
    eaEl.className = 'ea-status bad';
    eaEl.title = `Attach GoldLadderManager v3.0-s6 to the ${info.symbol} chart with Algo Trading on. Until then there are no automatic stages and no NEW LADDER.`;
  }
  $('arm-wrap').classList.toggle('blocked', !p.tradeAllowed);
  $('arm-wrap').title = p.tradeAllowed ? 'Trading from this page is off until you switch it on (every page load)' : 'Algo Trading is OFF in MT5 - orders will be refused';
  $('clock').textContent = `${fmtClock(p.quote.time)}  server time  ${info.symbol}`;
  if (Date.now() - lastSave > 2000) {
    lastSave = Date.now();
    saveTrackers();
  }
  if (Date.now() - lastPostClose > 60_000) {
    lastPostClose = Date.now();
    void updatePostClose();
  }
}

let polling = false;
async function pollNow() {
  if (polling) return;
  polling = true;
  try {
    const p = await api.poll(last?.poll.quote.time ?? 0);
    onPoll(p);
    if (!online) {
      online = true;
      setEmpty('');
      toast('Connected to MT5 again.');
    }
  } catch (e) {
    if (online) {
      online = false;
      setEmpty(`<div><h3>Lost the connection to MT5</h3><p>${(e as Error).message}</p><p class="muted">Is the start_live window still open and MT5 logged in? Retrying...</p></div>`);
    }
  } finally {
    polling = false;
  }
}

async function loop() {
  await pollNow();
  setTimeout(loop, online ? POLL_MS : 1000);
}

// ------------------------------------------------------------------ keyboard

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(t.type))) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (store.selectedId) store.remove(store.selectedId);
  } else if (e.key === 'Escape') {
    store.setTool('select');
    store.select(null);
  } else if (e.key === 'End') {
    htfView.scrollToNow();
    m1View.scrollToNow();
  } else if (e.key === 'r' || e.key === 'R') store.setTool('rect');
  else if (e.key === 'h' || e.key === 'H') store.setTool('hline');
  else if (e.key === 't' || e.key === 'T') store.setTool('text');
});

// ------------------------------------------------------------------ boot

async function boot() {
  setSoundEnabled(prefs.sound);
  setArmed(false);
  showPage('chart');
  store.setTool('select');
  setEmpty('Connecting to MT5...');
  try {
    info = await api.init();
  } catch (e) {
    setEmpty(`<div><h3>MT5 bridge not reachable</h3><p>${(e as Error).message}</p><p>Start <b>start_live.bat</b> (MT5 must be open and logged in), then reload this page.</p></div>`);
    setTimeout(() => location.reload(), 5000);
    return;
  }
  const a = info.account;
  const badge = $('badge');
  badge.textContent = info.fake ? 'FAKE MT5 (test)' : a.mode;
  badge.className = `badge ${info.fake ? 'fake' : a.mode === 'REAL' ? 'real' : 'demo'}`;
  $('acct').textContent = `${a.login} ${a.server} ${a.currency}`;
  document.title = `Gold Replay Live - ${a.mode} ${a.login}`;
  panel.digits = info.digits;
  for (const v of [htfView, m1View]) v.series.applyOptions({ priceFormat: { type: 'price', precision: info.digits, minMove: 1 / 10 ** info.digits } });
  state = new LiveState(info.contractSize, info.digits);
  state.restore(await db.get<{ trackers: Tracker[]; nextUid: number }>('kv', `live-trackers-${a.login}`).catch(() => undefined));
  journal = (await db.getAll<JournalRecord>('journal').catch(() => [] as JournalRecord[])).map((r) => ({ ...r, tags: { ...EMPTY_TAGS, ...r.tags } }));
  onJournalSyncStatus((st) => {
    $('status').textContent = st.text.replace('Start the simulator with start.bat', 'Keep start_live running');
    if (!st.ok || st.waiting) toast(st.text, 'warn', 6000);
  });
  if (journal.length) syncJournal(journal, 1500);
  try {
    await Promise.all(TF_NAMES.map((tf) => loadBars(tf)));
  } catch (e) {
    setEmpty(`<div><h3>Could not load ${info.symbol} candles</h3><p>${(e as Error).message}</p></div>`);
    return;
  }
  m1View.chart.timeScale().setVisibleLogicalRange({ from: bars.M1.length - 150, to: bars.M1.length + 10 });
  htfView.chart.timeScale().setVisibleLogicalRange({ from: bars[prefs.htf].length - 120, to: bars[prefs.htf].length + 8 });
  const today = isoDate(info.time);
  store.setAll(await db.drawingsBetween<Drawing>(isoDate(info.time - 30 * 86_400_000), today).catch(() => []));
  setZones(zonesOf(store.items));
  setEmpty('');
  if (!info.tradeAllowed) toast('Algo Trading is OFF in MT5: orders from this page will be refused until you turn it on.', 'warn', 9000);
  void loop();
}

window.addEventListener('beforeunload', () => {
  if (state) saveTrackers(true);
});

void boot();

if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __grl: { m1View, htfView, store, tradeLines, get last() { return last; }, get state() { return state; } } });
