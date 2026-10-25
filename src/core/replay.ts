// Replay engine: walks ticks across day files, builds candles, drives the order engine and auto-pause.
// Pure and synchronous; day files are provided by the caller (the worker loads them).

import { CandleBuilder, TF_MS, TF_NAMES, type TfName } from './candles';
import { type DayData, dayStartMs, lowerBound, type ManifestDay } from './daydata';
import type { Engine, EngineEvent } from './engine';

/** Gaps without ticks longer than this are skipped while playing (market closed, day breaks, weekends). */
export const GAP_SKIP_MS = 30 * 60_000;

export interface Zone {
  id: string;
  t1: number; // abs ms
  t2: number;
  low: number;
  high: number;
  extendRight: boolean;
}

export interface AutoPauseSettings {
  zone: boolean;
  fill: boolean;
  sl: boolean;
  stage: boolean;
}

export type ReplayEvent = EngineEvent | { type: 'zone'; zoneId: string } | { type: 'autopause'; reason: string };

export interface AdvanceResult {
  pausedBy: string | null;
  /** Manifest index of a day file that must be loaded before replay can continue. */
  needDay: number | null;
  end: boolean;
  processed: number;
}

const STAGE_PAUSE = ['', 'BE allowed (+30)', 'Stage 2 reached (+50)', 'Stage 3 reached (+100)'];

export class Replay {
  readonly candles: Record<TfName, CandleBuilder>;
  /** Manifest index of the day holding the next tick, and that tick's index. */
  di = 0;
  ti = 0;
  /** Replay time (abs ms). Every tick with time < clock has been processed. */
  clock = 0;
  bid = NaN;
  ask = NaN;
  /** Time of the last processed tick (history included). */
  lastTickTime: number | null = null;
  zones: Zone[] = [];
  events: ReplayEvent[] = [];
  private loaded = new Map<number, DayData>();
  private inside = new Map<string, boolean>();

  constructor(
    readonly manifest: readonly ManifestDay[],
    readonly engine: Engine,
    public autoPause: AutoPauseSettings,
  ) {
    this.candles = { M1: new CandleBuilder(TF_MS.M1), M15: new CandleBuilder(TF_MS.M15), M30: new CandleBuilder(TF_MS.M30) };
  }

  setDay(index: number, day: DayData): void {
    this.loaded.set(index, day);
  }

  hasDay(index: number): boolean {
    return this.loaded.has(index);
  }

  loadedDays(): number[] {
    return [...this.loaded.keys()];
  }

  dropDay(index: number): void {
    this.loaded.delete(index);
  }

  day(index: number): DayData | undefined {
    return this.loaded.get(index);
  }

  /**
   * Positions the replay at `startAbs` on manifest day `startIdx`. Ticks from `historyFrom` up to the
   * start build the candle history only. All those days must be loaded.
   */
  start(startIdx: number, startAbs: number, historyFrom: number): void {
    let last: { t: number; bid: number; ask: number } | null = null;
    for (let i = historyFrom; i <= startIdx; i++) {
      const d = this.loaded.get(i);
      if (!d) throw new Error(`day ${this.manifest[i].date} not loaded`);
      const end = i === startIdx ? lowerBound(d, startAbs) : d.count;
      for (let k = 0; k < end; k++) {
        const t = d.dayStart + d.times[k];
        const bid = d.bids[k] / d.scale;
        for (const tf of TF_NAMES) this.candles[tf].add(t, bid);
        last = { t, bid, ask: d.asks[k] / d.scale };
      }
    }
    const sd = this.loaded.get(startIdx)!;
    this.di = startIdx;
    this.ti = lowerBound(sd, startAbs);
    this.clock = startAbs;
    if (last) {
      this.engine.onTick(last.t, last.bid, last.ask);
      this.engine.takeEvents();
      this.bid = last.bid;
      this.ask = last.ask;
      this.lastTickTime = last.t;
    }
    for (const tf of TF_NAMES) this.candles[tf].clearDirty();
  }

  /** Time of the next unprocessed tick (from the manifest if that day is not loaded yet); null at the end of data. */
  peekTime(): number | null {
    const d = this.loaded.get(this.di);
    if (d && this.ti < d.count) return d.dayStart + d.times[this.ti];
    const j = this.di + 1;
    if (j >= this.manifest.length) return null;
    const nd = this.loaded.get(j);
    if (nd) return nd.count ? nd.dayStart + nd.times[0] : null;
    return dayStartMs(this.manifest[j].date) + this.manifest[j].firstMs;
  }

  /** Processes every tick with time < target, stopping early on an auto-pause event. */
  advanceTo(target: number): AdvanceResult {
    let processed = 0;
    for (;;) {
      const d = this.loaded.get(this.di);
      if (!d) return { pausedBy: null, needDay: this.di, end: false, processed };
      if (this.ti >= d.count) {
        const j = this.di + 1;
        if (j >= this.manifest.length) {
          this.clock = Math.max(this.clock, target);
          return { pausedBy: null, needDay: null, end: true, processed };
        }
        if (!this.loaded.has(j)) {
          const nextFirst = dayStartMs(this.manifest[j].date) + this.manifest[j].firstMs;
          this.clock = Math.max(this.clock, Math.min(target, nextFirst));
          return { pausedBy: null, needDay: target > nextFirst ? j : null, end: false, processed };
        }
        this.di = j;
        this.ti = 0;
        continue;
      }
      const t = d.dayStart + d.times[this.ti];
      if (t >= target) break;
      const bid = d.bids[this.ti] / d.scale;
      const ask = d.asks[this.ti] / d.scale;
      this.ti++;
      processed++;
      const reason = this.processTick(t, bid, ask);
      if (reason) {
        this.clock = t + 1;
        this.events.push({ type: 'autopause', reason });
        return { pausedBy: reason, needDay: null, end: false, processed };
      }
    }
    this.clock = Math.max(this.clock, target);
    return { pausedBy: null, needDay: null, end: false, processed };
  }

  /** Advances by `delta` ms of replay time; long gaps without ticks are jumped over. */
  play(delta: number): AdvanceResult {
    let target = this.clock + delta;
    const nt = this.peekTime();
    if (nt !== null && nt >= target && nt - this.clock > GAP_SKIP_MS) target = nt + 1;
    return this.advanceTo(target);
  }

  /**
   * Advances to the close of the forming candle of `tfMs`. When that candle has no ticks yet,
   * advances to the close of the next candle that has ticks.
   */
  step(tfMs: number): AdvanceResult {
    const nt = this.peekTime();
    if (nt === null) return { pausedBy: null, needDay: null, end: true, processed: 0 };
    let b = Math.floor(this.clock / tfMs) * tfMs + tfMs;
    const formingHasTicks = this.lastTickTime !== null && this.lastTickTime >= b - tfMs;
    if (!formingHasTicks && nt >= b) b = Math.floor(nt / tfMs) * tfMs + tfMs;
    return this.advanceTo(b);
  }

  /** Lets the next queued order fill right away: processes exactly the next tick. */
  processNextTick(): AdvanceResult {
    const nt = this.peekTime();
    if (nt === null) return { pausedBy: null, needDay: null, end: true, processed: 0 };
    return this.advanceTo(Math.max(this.clock, nt + 1));
  }

  setZones(zones: Zone[]): void {
    this.zones = zones;
    const next = new Map<string, boolean>();
    for (const z of zones) next.set(z.id, this.zoneContains(z, this.clock, this.bid));
    this.inside = next;
  }

  private zoneContains(z: Zone, t: number, price: number): boolean {
    const active = t >= z.t1 && (z.extendRight || t <= z.t2);
    return active && price >= z.low && price <= z.high;
  }

  private processTick(t: number, bid: number, ask: number): string | null {
    this.bid = bid;
    this.ask = ask;
    this.lastTickTime = t;
    this.candles.M1.add(t, bid);
    this.candles.M15.add(t, bid);
    this.candles.M30.add(t, bid);
    this.engine.onTick(t, bid, ask);
    let reason: string | null = null;
    const ap = this.autoPause;
    for (const ev of this.engine.takeEvents()) {
      this.events.push(ev);
      if (reason) continue;
      if (ev.type === 'fill' && ap.fill) reason = 'Ticket filled';
      else if (ev.type === 'sl' && ap.sl) reason = ev.reason === 'SL' ? 'SL hit' : 'Stage SL hit';
      else if (ev.type === 'stopout') reason = 'Stop-out';
      else if (ev.type === 'stage' && ap.stage) reason = STAGE_PAUSE[ev.stage];
    }
    for (const z of this.zones) {
      const now = this.zoneContains(z, t, bid);
      const was = this.inside.get(z.id) ?? false;
      this.inside.set(z.id, now);
      if (now && !was) {
        this.events.push({ type: 'zone', zoneId: z.id });
        if (!reason && ap.zone) reason = 'Price touched a zone';
      }
    }
    return reason;
  }

  /** Events since the last call, including engine events raised by user actions between ticks. */
  takeEvents(): ReplayEvent[] {
    for (const ev of this.engine.takeEvents()) this.events.push(ev);
    const e = this.events;
    this.events = [];
    return e;
  }

  hasOpenLadder(): boolean {
    return this.engine.hasOpenPositions();
  }
}
