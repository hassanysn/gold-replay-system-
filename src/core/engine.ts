// Order engine, account and Ladder Manager. Pure module: no DOM, no timers, no I/O.
// All state changes happen through method calls; the caller drains `takeEvents()` afterwards.

import { type Dir, PIP, pipsFrom, priceAtPips, profit, round2, roundPrice, weightedAverage } from './pips';

export type LadderKind = 'ladder' | 'normal';
export type ExitReason = 'SL' | 'stage SL' | 'TP' | 'manual close' | 'stop-out';
/** 0 = initial, 1 = +30 reached (BE available), 2 = stage 2, 3 = stage 3 (runner after it). */
export type Stage = 0 | 1 | 2 | 3;

export const STAGE_NAMES = ['none', 'BE', 'Stage 2', 'Stage 3'] as const;

export const BE_TRIGGER_PIPS = 30;
export const BE_LOCK_PIPS = 1;
export const S2_TRIGGER_PIPS = 50;
export const S2_LOCK_PIPS = 20;
export const S3_TRIGGER_PIPS = 100;
export const S3_LOCK_PIPS = 50;
export const MAX_OPEN_LADDERS = 3;
export const POST_CLOSE_TRACK_MS = 4 * 60 * 60 * 1000;
/** Lot warning threshold: 0.1 lot per $50 of balance. */
export const LOT_WARN_PER_50 = 0.1;

export interface AccountSettings {
  startBalance: number;
  leverage: number;
  contractSize: number;
  /** $ per lot, charged once per ticket at close (round turn). */
  commissionPerLot: number;
  /** Margin level % at or below which everything is closed. */
  stopOutLevel: number;
  /** Pips of room added when the manager sets an SL (BE / stage 2 / stage 3). */
  slBufferPips: number;
}

export const DEFAULT_ACCOUNT: AccountSettings = {
  startBalance: 50,
  leverage: 3000,
  contractSize: 100,
  commissionPerLot: 0,
  stopOutLevel: 50,
  slBufferPips: 1,
};

export interface Ticket {
  id: number;
  ladderId: number;
  dir: Dir;
  lot: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  closePrice: number | null;
  closeTime: number | null;
  closeReason: ExitReason | null;
  profit: number | null;
}

export interface Ladder {
  id: number;
  dir: Dir;
  kind: LadderKind;
  tickets: Ticket[];
  open: boolean;
  openTime: number;
  closeTime: number | null;
  /** Last SL / TP price synced across the ladder. */
  sl: number | null;
  tp: number | null;
  originalSL: number | null;
  /** Frozen risk in $; null until an SL with a loss is first set. */
  R: number | null;
  stage: Stage;
  beApplied: boolean;
  /** True once BE was applied or an automatic stage SL was set ("after BE"). */
  protected: boolean;
  mfePips: number;
  exitReason: ExitReason | null;
}

export interface JournalTicket {
  lot: number;
  openPrice: number;
  openTime: number;
  closePrice: number;
  closeTime: number;
  profit: number;
  reason: ExitReason;
}

export interface JournalRecord {
  id: string;
  kind: LadderKind;
  dir: Dir;
  openTime: number;
  closeTime: number;
  ticketCount: number;
  tickets: JournalTicket[];
  avgEntry: number;
  totalLot: number;
  originalSL: number | null;
  R: number | null;
  highestStage: (typeof STAGE_NAMES)[number];
  beApplied: boolean;
  exitReason: ExitReason;
  result: number;
  resultR: number | null;
  resultPips: number;
  mfePips: number;
  /** Max favourable pips from average entry in the 4 h after close; null until tracked. */
  postClosePips: number | null;
  postCloseDone: boolean;
  balanceAfter: number;
  note: string;
}

export type EngineEvent =
  | { type: 'fill'; ticket: Ticket }
  | { type: 'rejected'; reason: string }
  | { type: 'sl'; ladderId: number; ticketIds: number[]; reason: ExitReason }
  | { type: 'tp'; ladderId: number; ticketIds: number[] }
  | { type: 'stage'; ladderId: number; stage: Stage }
  | { type: 'stopout' }
  | { type: 'ladderClosed'; record: JournalRecord }
  | { type: 'postClose'; entryId: string; pips: number | null; done: boolean }
  | { type: 'notice'; text: string };

export interface Quote {
  time: number;
  bid: number;
  ask: number;
}

export interface PostCloseTracker {
  entryId: string;
  dir: Dir;
  avg: number;
  /** Tracking covers ticks with time <= until. */
  until: number;
  max: number | null;
}

/** Feeds one tick to a tracker. Returns true once the tracker is complete (tick beyond its window). */
export function feedTracker(tr: PostCloseTracker, time: number, bid: number, ask: number): boolean {
  if (time > tr.until) return true;
  const p = pipsFrom(tr.dir, tr.avg, bid, ask);
  if (tr.max === null || p > tr.max) tr.max = p;
  return false;
}

export interface LadderView {
  id: number;
  dir: Dir;
  kind: LadderKind;
  ticketCount: number;
  totalLot: number;
  avg: number;
  sl: number | null;
  tp: number | null;
  R: number | null;
  /** P/L in $ if every ticket closes at its SL now (negative = loss). */
  lockedAtSL: number | null;
  /** Loss at SL as % of balance (0 when the SL locks profit). */
  lossAtSLPct: number | null;
  floating: number;
  pips: number;
  rrNow: number | null;
  stage: Stage;
  stageLabel: string;
  beEnabled: boolean;
  beApplied: boolean;
  lotWarning: boolean;
  mfePips: number;
  active: boolean;
  tickets: { id: number; lot: number; openPrice: number; openTime: number; sl: number | null; tp: number | null; floating: number }[];
}

export interface EngineSnapshot {
  time: number;
  bid: number;
  ask: number;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  blown: boolean;
  ladders: LadderView[];
  activeLadderId: number | null;
  newLadderArmed: boolean;
  canNewLadder: boolean;
  openLadders: number;
  pendingOrders: number;
}

interface PendingOrder {
  dir: Dir;
  lot: number;
}

export class Engine {
  settings: AccountSettings;
  readonly digits: number;
  balance: number;
  blown = false;
  ladders: Ladder[] = [];
  activeLadderId: number | null = null;
  newLadderArmed = false;
  quote: Quote | null = null;
  trackers: PostCloseTracker[] = [];
  /** Prefix for journal entry ids, so ids from different sessions never collide. */
  idPrefix = 's';
  private pending: PendingOrder[] = [];
  private events: EngineEvent[] = [];
  private nextTicketId = 1;
  private nextLadderId = 1;

  constructor(settings: AccountSettings = DEFAULT_ACCOUNT, balance?: number, digits = 2) {
    this.settings = { ...settings };
    this.balance = balance ?? settings.startBalance;
    this.digits = digits;
  }

  takeEvents(): EngineEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private emit(e: EngineEvent) {
    this.events.push(e);
  }

  private notice(text: string) {
    this.emit({ type: 'notice', text });
  }

  // ---------------------------------------------------------------- queries

  openLadders(): Ladder[] {
    return this.ladders.filter((l) => l.open);
  }

  ladder(id: number): Ladder | undefined {
    return this.ladders.find((l) => l.id === id);
  }

  hasOpenPositions(): boolean {
    return this.ladders.some((l) => l.open) || this.pending.length > 0;
  }

  activeLadder(): Ladder | null {
    const l = this.activeLadderId === null ? undefined : this.ladder(this.activeLadderId);
    return l && l.open ? l : null;
  }

  static openTickets(l: Ladder): Ticket[] {
    return l.tickets.filter((t) => t.closePrice === null);
  }

  static average(l: Ladder): number {
    return weightedAverage(Engine.openTickets(l).map((t) => ({ lot: t.lot, price: t.openPrice })));
  }

  static totalLot(l: Ladder): number {
    return Math.round(Engine.openTickets(l).reduce((s, t) => s + t.lot, 0) * 100) / 100;
  }

  private closePriceFor(dir: Dir, q: Quote): number {
    return dir === 'buy' ? q.bid : q.ask;
  }

  floating(): number {
    const q = this.quote;
    if (!q) return 0;
    let f = 0;
    for (const l of this.ladders) {
      if (!l.open) continue;
      for (const t of Engine.openTickets(l)) f += profit(t.dir, t.lot, t.openPrice, this.closePriceFor(t.dir, q), this.settings.contractSize);
    }
    return f;
  }

  margin(): number {
    let m = 0;
    for (const l of this.ladders) {
      if (!l.open) continue;
      for (const t of Engine.openTickets(l)) m += this.marginFor(t.lot, t.openPrice);
    }
    return m;
  }

  private marginFor(lot: number, price: number): number {
    return (lot * this.settings.contractSize * price) / this.settings.leverage;
  }

  equity(): number {
    return this.balance + this.floating();
  }

  marginLevel(): number | null {
    const m = this.margin();
    return m > 0 ? (this.equity() / m) * 100 : null;
  }

  canNewLadder(): boolean {
    const a = this.activeLadder();
    return !!a && a.stage >= 2 && this.openLadders().length < MAX_OPEN_LADDERS && !this.newLadderArmed;
  }

  /** P/L in $ if all open tickets of the ladder closed at their current SL (null if none has an SL). */
  lockedAtSL(l: Ladder): number | null {
    let any = false;
    let sum = 0;
    for (const t of Engine.openTickets(l)) {
      if (t.sl === null) continue;
      any = true;
      sum += profit(t.dir, t.lot, t.openPrice, t.sl, this.settings.contractSize);
    }
    return any ? sum : null;
  }

  /** SL price that locks `pips` from the average, with the SL spread buffer applied (more room). */
  lockPrice(l: Ladder, pips: number): number {
    const avg = Engine.average(l);
    const target = priceAtPips(l.dir, avg, pips - this.settings.slBufferPips);
    return roundPrice(target, this.digits);
  }

  // ---------------------------------------------------------------- orders

  private orderBlock(dir: Dir): string | null {
    if (this.blown) return 'Account blown - start a new war account';
    const opposite = this.openLadders().find((l) => l.dir !== dir) ?? this.pending.find((p) => p.dir !== dir);
    if (opposite) return `Blocked: ${dir} is opposite to the open ${dir === 'buy' ? 'sell' : 'buy'} ladder`;
    if (this.needsNewLadder() && this.openLadders().length >= MAX_OPEN_LADDERS) return `Blocked: max ${MAX_OPEN_LADDERS} ladders open`;
    return null;
  }

  private needsNewLadder(): boolean {
    return this.newLadderArmed || this.activeLadder() === null;
  }

  /** Queues a market ticket. It fills on the first tick at or after now (next `onTick`). */
  placeOrder(dir: Dir, lot: number): { ok: boolean; reason?: string } {
    lot = Math.round(lot * 100) / 100;
    if (!(lot >= 0.01)) return this.reject('Lot must be at least 0.01');
    const block = this.orderBlock(dir);
    if (block) return this.reject(block);
    this.pending.push({ dir, lot });
    return { ok: true };
  }

  private reject(reason: string): { ok: false; reason: string } {
    this.emit({ type: 'rejected', reason });
    return { ok: false, reason };
  }

  newLadder(): boolean {
    if (!this.canNewLadder()) {
      this.notice('New ladder is available once the active ladder has reached stage 2 (max 3 ladders)');
      return false;
    }
    this.newLadderArmed = true;
    return true;
  }

  cancelNewLadder() {
    this.newLadderArmed = false;
  }

  private fill(o: PendingOrder, q: Quote) {
    const block = this.orderBlock(o.dir);
    if (block) {
      this.reject(block);
      return;
    }
    const price = o.dir === 'buy' ? q.ask : q.bid;
    const need = this.marginFor(o.lot, price);
    const free = this.equity() - this.margin();
    if (need > free) {
      this.reject(`Not enough free margin: need $${need.toFixed(2)}, free $${free.toFixed(2)}`);
      return;
    }
    let ladder = this.needsNewLadder() ? null : this.activeLadder();
    if (!ladder) {
      ladder = {
        id: this.nextLadderId++,
        dir: o.dir,
        kind: 'ladder',
        tickets: [],
        open: true,
        openTime: q.time,
        closeTime: null,
        sl: null,
        tp: null,
        originalSL: null,
        R: null,
        stage: 0,
        beApplied: false,
        protected: false,
        mfePips: -Infinity,
        exitReason: null,
      };
      this.ladders.push(ladder);
      this.activeLadderId = ladder.id;
      this.newLadderArmed = false;
    }
    const t: Ticket = {
      id: this.nextTicketId++,
      ladderId: ladder.id,
      dir: o.dir,
      lot: o.lot,
      openPrice: price,
      openTime: q.time,
      sl: null,
      tp: null,
      closePrice: null,
      closeTime: null,
      closeReason: null,
      profit: null,
    };
    // A new ticket joins the ladder's synced SL/TP when that price is valid for it.
    if (ladder.sl !== null) {
      if (this.slValid(o.dir, ladder.sl, q)) t.sl = ladder.sl;
      else this.notice(`Ladder SL ${ladder.sl} is on the wrong side of price for the new ticket - not set`);
    }
    if (ladder.tp !== null) {
      if (this.tpValid(o.dir, ladder.tp, q)) t.tp = ladder.tp;
      else this.notice(`Ladder TP ${ladder.tp} is on the wrong side of price for the new ticket - not set`);
    }
    ladder.tickets.push(t);
    ladder.mfePips = Math.max(ladder.mfePips, pipsFrom(ladder.dir, Engine.average(ladder), q.bid, q.ask));
    this.emit({ type: 'fill', ticket: { ...t } });
  }

  // ---------------------------------------------------------------- SL / TP sync

  private slValid(dir: Dir, price: number, q: Quote): boolean {
    return dir === 'buy' ? price < q.bid : price > q.ask;
  }

  private tpValid(dir: Dir, price: number, q: Quote): boolean {
    return dir === 'buy' ? price > q.bid : price < q.ask;
  }

  /** Sets the same SL on every open ticket of the ladder. Invalid tickets are skipped with a notice. */
  setSL(ladderId: number, price: number | null): void {
    this.applySL(ladderId, price, false);
  }

  private applySL(ladderId: number, price: number | null, auto: boolean): void {
    const l = this.ladder(ladderId);
    const q = this.quote;
    if (!l || !l.open || !q) return;
    if (price !== null) price = roundPrice(price, this.digits);
    const prevSL = l.sl;
    let skipped = 0;
    let applied = 0;
    for (const t of Engine.openTickets(l)) {
      if (price === null) {
        t.sl = null;
        continue;
      }
      if (!this.slValid(l.dir, price, q)) {
        skipped++;
        continue;
      }
      if (auto && t.sl !== null && (l.dir === 'buy' ? price <= t.sl : price >= t.sl)) continue; // never loosen
      t.sl = price;
      applied++;
    }
    if (price === null) l.sl = null;
    else if (applied > 0) l.sl = price;
    if (skipped > 0) this.notice(`SL ${price} is on the wrong side of price for ${skipped} ticket(s) of ladder ${l.id} - skipped`);
    if (price !== null && applied > 0) this.updateR(l, prevSL, price);
  }

  private updateR(l: Ladder, prevSL: number | null, newSL: number) {
    const locked = this.lockedAtSL(l);
    if (locked === null) return;
    const loss = -locked;
    if (l.R === null) {
      if (loss > 0) {
        l.R = round2(loss);
        l.originalSL = newSL;
      }
      return;
    }
    const widened = prevSL === null || (l.dir === 'buy' ? newSL < prevSL : newSL > prevSL);
    if (!l.protected && widened && loss > l.R) l.R = round2(loss);
  }

  setTP(ladderId: number, price: number | null): void {
    const l = this.ladder(ladderId);
    const q = this.quote;
    if (!l || !l.open || !q) return;
    if (price !== null) price = roundPrice(price, this.digits);
    let skipped = 0;
    let applied = 0;
    for (const t of Engine.openTickets(l)) {
      if (price !== null && !this.tpValid(l.dir, price, q)) {
        skipped++;
        continue;
      }
      t.tp = price;
      applied++;
    }
    if (price === null || applied > 0) l.tp = price;
    if (skipped > 0) this.notice(`TP ${price} is on the wrong side of price for ${skipped} ticket(s) of ladder ${l.id} - skipped`);
  }

  beEnabled(l: Ladder): boolean {
    if (!l.open || l.stage < 1 || l.beApplied) return false;
    const be = this.lockPrice(l, BE_LOCK_PIPS);
    return l.sl === null || (l.dir === 'buy' ? l.sl < be : l.sl > be);
  }

  applyBE(ladderId: number): void {
    const l = this.ladder(ladderId);
    if (!l || !l.open) return;
    if (!this.beEnabled(l)) {
      this.notice(`BE is not available for ladder ${l.id}`);
      return;
    }
    l.protected = true;
    l.beApplied = true;
    this.applySL(l.id, this.lockPrice(l, BE_LOCK_PIPS), true);
  }

  setKind(ladderId: number, kind: LadderKind) {
    const l = this.ladder(ladderId);
    if (l) l.kind = kind;
  }

  // ---------------------------------------------------------------- closing

  private closeTicket(t: Ticket, price: number, time: number, reason: ExitReason) {
    const gross = profit(t.dir, t.lot, t.openPrice, price, this.settings.contractSize);
    t.closePrice = price;
    t.closeTime = time;
    t.closeReason = reason;
    t.profit = round2(gross - this.settings.commissionPerLot * t.lot);
    this.balance = round2(this.balance + t.profit);
  }

  private finishIfEmpty(l: Ladder, reason: ExitReason, time: number) {
    if (Engine.openTickets(l).length > 0) return;
    l.open = false;
    l.closeTime = time;
    l.exitReason = reason;
    if (this.activeLadderId === l.id) this.activeLadderId = null;
    if (this.activeLadderId === null) this.newLadderArmed = false;
    const record = this.buildRecord(l);
    this.trackers.push({ entryId: record.id, dir: l.dir, avg: record.avgEntry, until: time + POST_CLOSE_TRACK_MS, max: null });
    this.emit({ type: 'ladderClosed', record });
  }

  private buildRecord(l: Ladder): JournalRecord {
    const ts = l.tickets;
    const totalLot = Math.round(ts.reduce((s, t) => s + t.lot, 0) * 100) / 100;
    const avg = weightedAverage(ts.map((t) => ({ lot: t.lot, price: t.openPrice })));
    const result = round2(ts.reduce((s, t) => s + (t.profit ?? 0), 0));
    return {
      id: `${this.idPrefix}-${l.id}`,
      kind: l.kind,
      dir: l.dir,
      openTime: l.openTime,
      closeTime: l.closeTime ?? 0,
      ticketCount: ts.length,
      tickets: ts.map((t) => ({
        lot: t.lot,
        openPrice: t.openPrice,
        openTime: t.openTime,
        closePrice: t.closePrice ?? 0,
        closeTime: t.closeTime ?? 0,
        profit: t.profit ?? 0,
        reason: t.closeReason ?? 'manual close',
      })),
      avgEntry: avg,
      totalLot,
      originalSL: l.originalSL,
      R: l.R,
      highestStage: STAGE_NAMES[l.stage],
      beApplied: l.beApplied,
      exitReason: l.exitReason ?? 'manual close',
      result,
      resultR: l.R ? Math.round((result / l.R) * 100) / 100 : null,
      resultPips: Math.round((result / (totalLot * this.settings.contractSize * PIP)) * 10) / 10,
      mfePips: Number.isFinite(l.mfePips) ? l.mfePips : 0,
      postClosePips: null,
      postCloseDone: false,
      balanceAfter: this.balance,
      note: '',
    };
  }

  private closeLadderAt(l: Ladder, reason: ExitReason) {
    const q = this.quote;
    if (!q || !l.open) return;
    const price = this.closePriceFor(l.dir, q);
    for (const t of Engine.openTickets(l)) this.closeTicket(t, price, q.time, reason);
    this.finishIfEmpty(l, reason, q.time);
  }

  closeLadder(ladderId: number): void {
    const l = this.ladder(ladderId);
    if (l) this.closeLadderAt(l, 'manual close');
  }

  closeAll(): void {
    this.pending = [];
    for (const l of this.openLadders()) this.closeLadderAt(l, 'manual close');
  }

  /** Resets the balance to the starting balance (open positions are closed first). Journal is kept by the caller. */
  newWarAccount(): void {
    this.closeAll();
    this.balance = this.settings.startBalance;
    this.blown = false;
    this.newLadderArmed = false;
  }

  updateSettings(s: Partial<AccountSettings>) {
    this.settings = { ...this.settings, ...s };
  }

  // ---------------------------------------------------------------- tick processing

  onTick(time: number, bid: number, ask: number): void {
    const q: Quote = { time, bid, ask };
    this.quote = q;

    // 1. post-close trackers (before closes on this tick register new ones)
    if (this.trackers.length) {
      this.trackers = this.trackers.filter((tr) => {
        if (!feedTracker(tr, time, bid, ask)) return true;
        this.emit({ type: 'postClose', entryId: tr.entryId, pips: tr.max, done: true });
        return false;
      });
    }

    // 2. queued market orders fill on this tick
    if (this.pending.length) {
      const orders = this.pending;
      this.pending = [];
      for (const o of orders) this.fill(o, q);
    }

    // 3. SL / TP triggers (buy on bid, sell on ask)
    for (const l of this.ladders) {
      if (!l.open) continue;
      const px = this.closePriceFor(l.dir, q);
      const slHit: number[] = [];
      const tpHit: number[] = [];
      const slReason: ExitReason = l.protected ? 'stage SL' : 'SL';
      for (const t of Engine.openTickets(l)) {
        if (t.sl !== null && (l.dir === 'buy' ? px <= t.sl : px >= t.sl)) {
          this.closeTicket(t, px, time, slReason);
          slHit.push(t.id);
        } else if (t.tp !== null && (l.dir === 'buy' ? px >= t.tp : px <= t.tp)) {
          this.closeTicket(t, px, time, 'TP');
          tpHit.push(t.id);
        }
      }
      if (slHit.length) this.emit({ type: 'sl', ladderId: l.id, ticketIds: slHit, reason: slReason });
      if (tpHit.length) this.emit({ type: 'tp', ladderId: l.id, ticketIds: tpHit });
      if (slHit.length || tpHit.length) this.finishIfEmpty(l, slHit.length ? slReason : 'TP', time);
    }

    // 4. management stages, measured from average entry
    for (const l of this.ladders) {
      if (!l.open) continue;
      const pips = pipsFrom(l.dir, Engine.average(l), bid, ask);
      if (pips > l.mfePips) l.mfePips = pips;
      if (l.stage < 1 && pips >= BE_TRIGGER_PIPS) {
        l.stage = 1;
        this.emit({ type: 'stage', ladderId: l.id, stage: 1 });
      }
      if (l.stage < 2 && pips >= S2_TRIGGER_PIPS) {
        l.stage = 2;
        l.protected = true;
        this.applySL(l.id, this.lockPrice(l, S2_LOCK_PIPS), true);
        this.emit({ type: 'stage', ladderId: l.id, stage: 2 });
      }
      if (l.stage < 3 && pips >= S3_TRIGGER_PIPS) {
        l.stage = 3;
        l.protected = true;
        this.applySL(l.id, this.lockPrice(l, S3_LOCK_PIPS), true);
        this.emit({ type: 'stage', ladderId: l.id, stage: 3 });
      }
    }

    // 5. stop-out
    const ml = this.marginLevel();
    if (ml !== null && ml <= this.settings.stopOutLevel) {
      for (const l of this.openLadders()) this.closeLadderAt(l, 'stop-out');
      this.pending = [];
      this.blown = true;
      this.emit({ type: 'stopout' });
      this.notice(`Stop-out at margin level ${ml.toFixed(1)}% - all positions closed. Account blown.`);
    }
  }

  // ---------------------------------------------------------------- snapshot

  snapshot(): EngineSnapshot {
    const q = this.quote ?? { time: 0, bid: NaN, ask: NaN };
    const margin = this.margin();
    const equity = this.equity();
    const ladders: LadderView[] = this.openLadders().map((l) => {
      const open = Engine.openTickets(l);
      const avg = Engine.average(l);
      const totalLot = Engine.totalLot(l);
      const locked = this.lockedAtSL(l);
      const floating = open.reduce(
        (s, t) => s + profit(t.dir, t.lot, t.openPrice, this.closePriceFor(t.dir, q), this.settings.contractSize),
        0,
      );
      const stageLabel = l.stage === 3 ? 'Stage 3 (runner)' : l.stage === 2 ? 'Stage 2' : l.beApplied ? 'BE set' : l.stage === 1 ? 'BE available' : 'Initial';
      return {
        id: l.id,
        dir: l.dir,
        kind: l.kind,
        ticketCount: open.length,
        totalLot,
        avg,
        sl: l.sl,
        tp: l.tp,
        R: l.R,
        lockedAtSL: locked,
        lossAtSLPct: locked === null ? null : locked < 0 && this.balance > 0 ? (-locked / this.balance) * 100 : 0,
        floating,
        pips: pipsFrom(l.dir, avg, q.bid, q.ask),
        rrNow: l.R ? floating / l.R : null,
        stage: l.stage,
        stageLabel,
        beEnabled: this.beEnabled(l),
        beApplied: l.beApplied,
        lotWarning: totalLot > (LOT_WARN_PER_50 * this.balance) / 50 + 1e-9,
        mfePips: Number.isFinite(l.mfePips) ? l.mfePips : 0,
        active: l.id === this.activeLadderId,
        tickets: open.map((t) => ({
          id: t.id,
          lot: t.lot,
          openPrice: t.openPrice,
          openTime: t.openTime,
          sl: t.sl,
          tp: t.tp,
          floating: profit(t.dir, t.lot, t.openPrice, this.closePriceFor(t.dir, q), this.settings.contractSize),
        })),
      };
    });
    return {
      time: q.time,
      bid: q.bid,
      ask: q.ask,
      balance: this.balance,
      equity,
      margin,
      freeMargin: equity - margin,
      marginLevel: margin > 0 ? (equity / margin) * 100 : null,
      blown: this.blown,
      ladders,
      activeLadderId: this.activeLadder()?.id ?? null,
      newLadderArmed: this.newLadderArmed,
      canNewLadder: this.canNewLadder(),
      openLadders: ladders.length,
      pendingOrders: this.pending.length,
    };
  }
}
