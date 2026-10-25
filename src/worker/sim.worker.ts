/// <reference lib="webworker" />
// Simulation worker: owns the tick data, the replay clock, candles and the order engine.
// The UI thread only ever receives what happened up to the current replay time.

import { TF_MS, TF_NAMES, type Bar, type TfName } from '../core/candles';
import { type DayData, dayStartMs, lowerBound, type Manifest, parseDay } from '../core/daydata';
import { Engine, feedTracker, type PostCloseTracker } from '../core/engine';
import { Replay, type AdvanceResult } from '../core/replay';
import {
  type Frame,
  type FromWorker,
  HISTORY_DAYS,
  LOCKED_SPEEDS,
  type PostCloseScan,
  SPEEDS,
  type ToWorker,
  type UiEvent,
} from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const TICK_MS = 33;

let dataUrl = '';
let manifest: Manifest | null = null;
const cache = new Map<number, Promise<DayData>>();

let replay: Replay | null = null;
let playing = false;
let speed = 1;
let speedLock = true;
let ended = false;
let waitingForData = false;
let lastWall = 0;
let uiEvents: UiEvent[] = [];

function post(msg: FromWorker, transfer?: Transferable[]) {
  self.postMessage(msg, transfer ?? []);
}

function notice(text: string, level: 'info' | 'warn' | 'pause' = 'info') {
  post({ type: 'notice', text, level });
}

// ------------------------------------------------------------------ data

function loadDay(i: number): Promise<DayData> {
  let p = cache.get(i);
  if (!p) {
    const m = manifest!.days[i];
    p = fetch(new URL(m.file, dataUrl))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading ${m.file}`);
        return r.arrayBuffer();
      })
      .then(parseDay);
    p.catch(() => cache.delete(i));
    cache.set(i, p);
  }
  return p;
}

/** Keeps memory bounded: drops cached days far behind the replay position. */
function evict(keepFrom: number) {
  for (const k of [...cache.keys()]) if (k < keepFrom) cache.delete(k);
  if (replay) for (const k of replay.loadedDays()) if (k < keepFrom) replay.dropDay(k);
}

function preloadNext() {
  if (!replay || !manifest) return;
  const j = replay.di + 1;
  if (j < manifest.days.length && !replay.hasDay(j)) {
    loadDay(j).then((d) => replay?.setDay(j, d)).catch(() => {});
  }
  evict(replay.di - 1);
}

function dayIndexAtOrBefore(t: number): number {
  const days = manifest!.days;
  let idx = 0;
  for (let i = 0; i < days.length; i++) if (dayStartMs(days[i].date) <= t) idx = i;
  return idx;
}

/** Completes post-close tracking from the data itself (when a session is abandoned or after a reload). */
async function finalizeScans(items: PostCloseScan[]) {
  if (!manifest) return;
  for (const it of items) {
    const tr: PostCloseTracker = { entryId: it.entryId, dir: it.dir, avg: it.avg, until: it.until, max: it.max };
    try {
      let done = false;
      for (let i = dayIndexAtOrBefore(it.from); i < manifest.days.length && !done; i++) {
        if (dayStartMs(manifest.days[i].date) > it.until) break;
        const d = await loadDay(i);
        for (let k = lowerBound(d, it.from); k < d.count; k++) {
          if (feedTracker(tr, d.dayStart + d.times[k], d.bids[k] / d.scale, d.asks[k] / d.scale)) {
            done = true;
            break;
          }
        }
      }
      post({ type: 'postClose', entryId: it.entryId, pips: tr.max, done: true });
    } catch (e) {
      notice(`Post-close tracking for ${it.entryId} failed: ${(e as Error).message}`, 'warn');
    }
  }
}

// ------------------------------------------------------------------ frames

function drainEvents() {
  if (!replay) return;
  for (const ev of replay.takeEvents()) {
    switch (ev.type) {
      case 'ladderClosed':
        post({ type: 'journal', record: ev.record });
        break;
      case 'postClose':
        post({ type: 'postClose', entryId: ev.entryId, pips: ev.pips, done: ev.done });
        break;
      case 'notice':
        // EA log line ([LM] ...): amber only when something was refused or needs your attention
        notice(ev.text, /refused|Invalid|NOT managed|CAP |cannot|not allowed|IGNORED|Stop-out/.test(ev.text) ? 'warn' : 'info');
        break;
      case 'rejected':
        notice(ev.reason, 'warn');
        break;
      case 'autopause':
        notice(`Auto-pause: ${ev.reason}`, 'pause');
        if (ev.reason === 'Price touched a zone') uiEvents.push({ type: 'zonePause', time: replay.clock });
        break;
      case 'closed':
        uiEvents.push({ type: 'close', time: replay.clock, ticketId: ev.ticketId });
        break;
      case 'fill':
        uiEvents.push({ type: 'fill', time: ev.ticket.openTime, dir: ev.ticket.dir, price: ev.ticket.openPrice, lot: ev.ticket.lot, ticketId: ev.ticket.id, ladderId: ev.ticket.ladderId });
        break;
      case 'sl':
      case 'tp':
        uiEvents.push({ type: ev.type, time: replay.clock, ladderId: ev.ladderId });
        break;
      case 'stage':
        uiEvents.push({ type: 'stage', time: replay.clock, ladderId: ev.ladderId });
        break;
      case 'zone':
        uiEvents.push({ type: 'zone', time: replay.clock });
        break;
      case 'stopout':
        uiEvents.push({ type: 'stopout', time: replay.clock });
        break;
    }
  }
}

function makeFrame(fullBars = false): Frame {
  const r = replay!;
  drainEvents();
  enforceSpeedLock();
  const bars: Partial<Record<TfName, Bar[]>> = {};
  if (!fullBars) {
    for (const tf of TF_NAMES) {
      const d = r.candles[tf].takeDirty();
      if (d.length) bars[tf] = d;
    }
  }
  const f: Frame = { clock: r.clock, playing, speed, ended, bars, snap: r.engine.snapshot(), events: uiEvents };
  uiEvents = [];
  return f;
}

function sendFrame() {
  if (replay) post({ type: 'frame', frame: makeFrame() });
}

// ------------------------------------------------------------------ clock

function enforceSpeedLock() {
  if (speedLock && replay?.hasOpenLadder() && !LOCKED_SPEEDS.includes(speed)) {
    speed = Math.max(...LOCKED_SPEEDS);
    notice(`Speed lock: ladder open, speed limited to ${speed}x`, 'info');
  }
}

function handle(res: AdvanceResult, retry?: () => AdvanceResult) {
  if (res.pausedBy) playing = false;
  if (res.end) {
    playing = false;
    ended = true;
    notice('End of available data', 'info');
  }
  if (res.needDay !== null && replay) {
    const r = replay;
    const idx = res.needDay;
    waitingForData = true;
    loadDay(idx)
      .then((d) => {
        if (replay !== r) return;
        r.setDay(idx, d);
        waitingForData = false;
        lastWall = performance.now();
        if (retry) handle(retry(), retry);
        preloadNext();
        sendFrame();
      })
      .catch((e) => {
        waitingForData = false;
        playing = false;
        notice(`Could not load ${manifest!.days[idx].date}: ${(e as Error).message}`, 'warn');
        sendFrame();
      });
  }
}

function loop() {
  if (!replay || !playing || waitingForData) return;
  const now = performance.now();
  const delta = Math.min(now - lastWall, 1000) * speed;
  lastWall = now;
  enforceSpeedLock();
  const prevDi = replay.di;
  handle(replay.play(delta));
  if (replay.di !== prevDi) preloadNext();
  sendFrame();
}

setInterval(loop, TICK_MS);

// ------------------------------------------------------------------ session

async function load(msg: Extract<ToWorker, { type: 'load' }>) {
  if (!manifest) throw new Error('No data manifest loaded');
  // Abandon the current session: close what is open and finish post-close tracking from data.
  if (replay) {
    playing = false;
    if (replay.engine.hasOpenPositions()) replay.engine.closeAll();
    drainEvents();
    const r = replay;
    const pending = r.engine.trackers.map((t) => ({ entryId: t.entryId, dir: t.dir, avg: t.avg, from: r.clock, until: t.until, max: t.max }));
    replay = null;
    if (pending.length) void finalizeScans(pending);
  }
  const days = manifest.days;
  let startIdx = days.findIndex((d) => d.date >= msg.date);
  if (startIdx < 0) throw new Error(`No data on or after ${msg.date}`);
  const [hh, mm, ss] = msg.time.split(':').map(Number);
  let startAbs = dayStartMs(days[startIdx].date);
  if (days[startIdx].date === msg.date) startAbs += ((hh || 0) * 3600 + (mm || 0) * 60 + (ss || 0)) * 1000;
  else startAbs += days[startIdx].firstMs; // date had no data: start at the next day's first tick
  const historyFrom = Math.max(0, startIdx - HISTORY_DAYS);
  post({ type: 'status', text: `Loading ${startIdx - historyFrom + 1} day file(s)...` });
  const t0 = performance.now();
  const loaded = await Promise.all(Array.from({ length: startIdx - historyFrom + 1 }, (_, k) => loadDay(historyFrom + k)));
  const digits = loaded[loaded.length - 1].digits;
  const engine = new Engine(msg.account, msg.balance, digits);
  engine.blown = msg.blown;
  engine.idPrefix = Date.now().toString(36);
  const r = new Replay(days, engine, msg.autoPause);
  loaded.forEach((d, k) => r.setDay(historyFrom + k, d));
  r.start(startIdx, startAbs, historyFrom);
  // Start inside a day: if the chosen time is after that day's last tick, move on to the next day.
  const sd = r.day(startIdx)!;
  if (r.ti >= sd.count && startIdx + 1 < days.length) {
    r.setDay(startIdx + 1, await loadDay(startIdx + 1));
  }
  r.setZones(msg.zones);
  replay = r;
  speedLock = msg.speedLock;
  playing = false;
  ended = false;
  waitingForData = false;
  speed = 1;
  uiEvents = [];
  preloadNext();
  const bars = { M1: r.candles.M1.bars, M15: r.candles.M15.bars, M30: r.candles.M30.bars } as Record<TfName, Bar[]>;
  post({ type: 'loaded', date: days[startIdx].date, historyFrom: days[historyFrom].date, bars, frame: makeFrame(true) });
  post({ type: 'status', text: `Loaded in ${Math.round(performance.now() - t0)} ms` });
}

function withReplay(fn: (r: Replay) => void) {
  if (!replay) {
    notice('Load a start date first', 'warn');
    return;
  }
  fn(replay);
  sendFrame();
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': {
        dataUrl = msg.dataUrl;
        const res = await fetch(new URL('manifest.json', dataUrl), { cache: 'no-store' });
        if (!res.ok) throw new Error(`No data found (HTTP ${res.status} for manifest.json). Run the converter first.`);
        manifest = (await res.json()) as Manifest;
        post({ type: 'manifest', manifest });
        break;
      }
      case 'load':
        await load(msg);
        break;
      case 'play':
        withReplay(() => {
          if (ended) return;
          playing = true;
          lastWall = performance.now();
        });
        break;
      case 'pause':
        withReplay(() => (playing = false));
        break;
      case 'speed':
        withReplay((r) => {
          if (!(SPEEDS as readonly number[]).includes(msg.speed)) return;
          if (speedLock && r.hasOpenLadder() && !LOCKED_SPEEDS.includes(msg.speed)) {
            notice('Speed lock: only 1x and 2x while a ladder is open', 'warn');
            return;
          }
          speed = msg.speed;
        });
        break;
      case 'step':
        withReplay((r) => {
          playing = false;
          const run = () => r.step(TF_MS[msg.tf]);
          handle(run(), run);
        });
        break;
      case 'order':
        withReplay((r) => {
          if (!r.engine.placeOrder(msg.dir, msg.lot).ok) return;
          // Fill = first tick at or after the click. While paused, process exactly that tick now.
          if (!playing) {
            const run = () => r.processNextTick();
            handle(run(), run);
          }
          enforceSpeedLock();
        });
        break;
      case 'setSL':
        withReplay((r) => r.engine.setSL(msg.ladderId, msg.price));
        break;
      case 'setTP':
        withReplay((r) => r.engine.setTP(msg.ladderId, msg.price));
        break;
      case 'be':
        withReplay((r) => r.engine.applyBE(msg.ladderId));
        break;
      case 'closeLadder':
        withReplay((r) => r.engine.closeLadder(msg.ladderId));
        break;
      case 'closeAll':
        withReplay((r) => r.engine.closeAll());
        break;
      case 'newLadder':
        withReplay((r) => r.engine.newLadder());
        break;
      case 'setTicketSL':
        withReplay((r) => r.engine.setTicketSL(msg.ticketId, msg.price));
        break;
      case 'setTicketTP':
        withReplay((r) => r.engine.setTicketTP(msg.ticketId, msg.price));
        break;
      case 'setTags':
        withReplay((r) => r.engine.setTags(msg.ladderId, msg.tags));
        break;
      case 'closeTicket':
        withReplay((r) => r.engine.closeUnmanaged(msg.ticketId));
        break;
      case 'newWarAccount':
        withReplay((r) => {
          r.engine.updateSettings(msg.account);
          r.engine.newWarAccount();
          notice(`New war account: balance $${msg.account.startBalance}`, 'info');
        });
        break;
      case 'settings':
        speedLock = msg.speedLock;
        if (replay) {
          replay.engine.updateSettings(msg.account);
          replay.autoPause = msg.autoPause;
          enforceSpeedLock();
          sendFrame();
        }
        break;
      case 'zones':
        replay?.setZones(msg.zones);
        break;
      case 'finalizePostClose':
        void finalizeScans(msg.items);
        break;
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
