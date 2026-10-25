// Order engine (the "broker") + Ladder Manager (a port of the MT5 EA GoldLadderManager v3.0 /
// LadderManager.mqh). Pure module: no DOM, no timers, no I/O. The caller drains `takeEvents()`.
//
// Per tick, in the order MT5 sees it:
//   broker: queued market orders fill -> SL/TP triggers -> EA pass (Run) -> stop-out.
// The EA pass mirrors CLadderManager::Run(): AssignNew, then for every ladder:
//   closed? -> EnforceCap -> Sync -> stage 2 -> stage 3 -> retry pending auto SL -> Track.
// User actions (SL/TP edits, MOVE TO BE, NEW LADDER, closes) are applied immediately, like
// OnChartEvent / OnTradeTransaction in the EA.

import { type Dir, PIP, pipsFrom, profit, round2, roundPrice, weightedAverage } from './pips';

export type LadderKind = 'ladder' | 'normal';
export type ExitReason = 'SL' | 'stage SL' | 'TP' | 'manual close' | 'cap close' | 'stop-out';
/** Who closed a ticket, as the EA journal counts it (DEAL_REASON). */
export type ClosedBy = 'sl' | 'tp' | 'manager' | 'you' | 'other';
/** EA stages: 0 waiting, 2 stage 2 done, 3 stage 3 done (runner is yours). 1 is only used in
 *  events: "BE allowed" (+BEMinPips reached), which drives the simulator's auto-pause. */
export type Stage = 0 | 1 | 2 | 3;

export const STAGE_NAMES = ['none', 'BE', 'Stage 2', 'Stage 3'] as const;
export const MAX_OPEN_LADDERS = 3; // LM_MAX
export const POST_CLOSE_TRACK_MS = 4 * 60 * 60 * 1000;

export interface AccountSettings {
  // broker / account
  startBalance: number;
  leverage: number;
  contractSize: number;
  /** $ per lot, charged once per ticket at close (round turn). */
  commissionPerLot: number;
  /** Margin level % at or below which everything is closed. */
  stopOutLevel: number;
  /** Broker SYMBOL_TRADE_STOPS_LEVEL / FREEZE_LEVEL in points (minimum SL/TP distance). */
  stopsLevelPoints: number;
  // EA inputs (GoldLadderManager.mq5)
  beMinPips: number; // InpBEMinPips
  beBufferPips: number; // InpBEBufferPips
  s2TrigPips: number; // InpS2TrigPips
  s2LockPips: number; // InpS2LockPips
  s3TrigPips: number; // InpS3TrigPips
  s3LockPips: number; // InpS3LockPips
  /** Lot cap PER LADDER per $100 of balance (InpLotPer100). 0 = no cap. */
  lotPer100: number;
  /** Wait before retrying a refused change (InpRetryCooldownSec). */
  retryCooldownSec: number;
}

export const DEFAULT_ACCOUNT: AccountSettings = {
  startBalance: 50,
  leverage: 3000,
  contractSize: 100,
  commissionPerLot: 0,
  stopOutLevel: 50,
  stopsLevelPoints: 0,
  beMinPips: 30,
  beBufferPips: 1,
  s2TrigPips: 50,
  s2LockPips: 20,
  s3TrigPips: 100,
  s3LockPips: 50,
  lotPer100: 0.1,
  retryCooldownSec: 5,
};

/** The EA's input check (StageCheck + OnInit). Empty string = valid. */
export function stageCheck(s: Pick<AccountSettings, 'beMinPips' | 'beBufferPips' | 's2TrigPips' | 's2LockPips' | 's3TrigPips' | 's3LockPips'>): string {
  if (s.beMinPips < 0 || s.beBufferPips < 0 || s.beBufferPips >= s.beMinPips) return 'BE buffer must be below the BE minimum distance';
  for (const v of [s.s2TrigPips, s.s2LockPips, s.s3TrigPips, s.s3LockPips]) if (!(v > 0 && v <= 1000)) return 'stage pips must be between 0 and 1000';
  if (s.s2LockPips <= s.beBufferPips) return 'stage 2 lock must be above the BE buffer';
  if (s.s2TrigPips <= s.s2LockPips) return 'stage 2 trigger must be above stage 2 lock';
  if (s.s3LockPips <= s.s2LockPips) return 'stage 3 lock must be above stage 2 lock';
  if (s.s3TrigPips <= s.s3LockPips) return 'stage 3 trigger must be above stage 3 lock';
  if (s.s3TrigPips <= s.s2TrigPips) return 'stage 3 trigger must be above stage 2 trigger';
  return '';
}

export interface Ticket {
  id: number;
  dir: Dir;
  lot: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  /** Owning ladder; null = not assigned yet, or opposite to the open ladders (unmanaged). */
  ladderId: number | null;
  /** Opposite-direction ticket already reported as unmanaged. */
  reported: boolean;
  /** Has received the ladder SL/TP at least once. */
  synced: boolean;
  closePrice: number | null;
  closeTime: number | null;
  closeReason: ExitReason | null;
  closedBy: ClosedBy | null;
  profit: number | null;
  // used when an unmanaged ticket is journaled as a "normal" trade
  firstSL: number | null;
  risk1: number | null;
  mfePips: number;
}

export interface Ladder {
  id: number;
  /** null = empty ladder made by NEW LADDER, side not known yet. */
  dir: Dir | null;
  /** Every ticket that ever belonged (closed ones included). */
  tickets: Ticket[];
  open: boolean;
  openTime: number | null;
  closeTime: number | null;
  /** Ladder (master) SL / TP. hasTP = a TP was ever set (null with hasTP = "TP none" is the master). */
  sl: number | null;
  tp: number | null;
  hasTP: boolean;
  stage: 0 | 2 | 3;
  /** Average entry frozen at stage 2. */
  anchor: number;
  /** Stage 3 trigger price (from the anchor). */
  next: number;
  /** Auto SL not applied yet (too close to price), retried every pass. */
  pending: number | null;
  /** Time (ms) of the last refused/waiting change; retries wait retryCooldownSec. */
  fail: number;
  logWait: number | null;
  syncLogWait: boolean;
  /** Simulator only: +BEMinPips reached once (auto-pause "BE available"). */
  beReached: boolean;
  beApplied: boolean;
  // journal (EA v2.2 fields)
  no: number;
  balBefore: number;
  firstSL: number | null;
  risk1: number;
  riskMax: number | null;
  lotsTotal: number;
  lotsMax: number;
  worst: number;
  mfe: number;
  mae: number;
  moveSeen: boolean;
  slEdits: number;
  slWidened: boolean;
  s2Time: number | null;
  autoRefused: number;
  refLast: number | null;
  /** Spec: best favourable pips from the (stage) average while open. */
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
  ladderNo: number;
  openTime: number;
  closeTime: number;
  ticketCount: number;
  tickets: JournalTicket[];
  avgEntry: number;
  worstEntry: number;
  totalLot: number;
  lotsMax: number;
  originalSL: number | null;
  finalSL: number | null;
  /** EA risk_at_first_sl as a positive $ amount; net_R = result / R. */
  R: number | null;
  /** EA risk_max: worst IF SL HITS seen ($, negative = loss). */
  riskMax: number | null;
  slEdits: number;
  slWidened: boolean;
  highestStage: (typeof STAGE_NAMES)[number];
  stage2Time: number | null;
  beApplied: boolean;
  exitReason: ExitReason;
  closedBy: Record<ClosedBy, number>;
  autoSlRefused: number;
  result: number;
  resultR: number | null;
  resultPips: number;
  /** EA mfe/mae/giveback: move from the worst entry, $ of price. */
  mfePrice: number | null;
  maePrice: number | null;
  giveback: number | null;
  /** Spec MFE: best favourable pips from the average entry while open. */
  mfePips: number;
  postClosePips: number | null;
  postCloseDone: boolean;
  balanceBefore: number;
  balanceAfter: number;
  note: string;
}

export type EngineEvent =
  | { type: 'fill'; ticket: Ticket }
  | { type: 'rejected'; reason: string }
  | { type: 'sl'; ladderId: number | null; ticketIds: number[]; reason: ExitReason }
  | { type: 'tp'; ladderId: number | null; ticketIds: number[] }
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

export interface TicketView {
  id: number;
  dir: Dir;
  lot: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  floating: number;
}

export interface LadderView {
  id: number;
  /** L1..L3 by age among the open ladders (the EA's Rank). */
  rank: number;
  dir: Dir | null;
  /** Receives new trades ("<- new trades"). */
  active: boolean;
  ticketCount: number;
  totalLot: number;
  worstEntry: number;
  /** Average used for stages: live before stage 2, frozen after. */
  avg: number;
  pips: number;
  sl: number | null;
  tp: number | null;
  /** "BE done" / "BE allowed" / "BE from <price>" */
  beText: string;
  beEnabled: boolean;
  beApplied: boolean;
  stage: 0 | 2 | 3;
  stageText: string;
  pending: number | null;
  /** IF SL HITS ($, negative = loss); null = a ticket has no SL (unlimited loss). */
  ifSLHits: number | null;
  ifSLHitsPct: number | null;
  /** IF CLOSED NOW = floating P/L of the open tickets. */
  ifClosedNow: number;
  /** 1R = worst IF SL HITS seen; null = R unknown (no SL yet). */
  R: number | null;
  rr: number | null;
  mfePips: number;
  tickets: TicketView[];
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
  contractSize: number;
  /** Lot cap per ladder (Infinity = no cap). */
  lotCap: number;
  ladderCount: number;
  ladders: LadderView[];
  activeLadderId: number | null;
  /** NEW LADDER made an empty ladder that takes the next trades. */
  emptyLadder: boolean;
  canNewLadder: boolean;
  newLadderWhy: string;
  /** TOTAL IF SL HITS over managed tickets; null = a managed ticket has no SL. */
  totalIfSLHits: number | null;
  unmanaged: TicketView[];
  pendingOrders: number;
}

interface PendingOrder {
  dir: Dir;
  lot: number;
}

const DIR = (d: Dir) => (d === 'buy' ? 1 : -1);

export class Engine {
  settings: AccountSettings;
  readonly digits: number;
  balance: number;
  blown = false;
  ladders: Ladder[] = [];
  tickets: Ticket[] = [];
  /** m_cur: ladder receiving new trades. */
  activeLadderId: number | null = null;
  quote: Quote | null = null;
  trackers: PostCloseTracker[] = [];
  /** Prefix for journal entry ids, so ids from different sessions never collide. */
  idPrefix = 's';
  private pending: PendingOrder[] = [];
  private events: EngineEvent[] = [];
  private nextTicketId = 1;
  private nextLadderId = 1;

  constructor(settings: AccountSettings = DEFAULT_ACCOUNT, balance?: number, digits = 2) {
    this.settings = { ...DEFAULT_ACCOUNT, ...settings };
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

  // ---------------------------------------------------------------- helpers (EA names)

  private get point(): number {
    return 1 / 10 ** this.digits;
  }
  private eps(): number {
    return this.point * 0.5;
  }
  private N(p: number): number {
    return roundPrice(p, this.digits);
  }
  private same(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) < this.eps();
  }
  /** a is a better (tighter-in-profit) SL than b. */
  private better(dir: Dir, a: number | null, b: number | null): boolean {
    if (a === null) return false;
    if (b === null) return true;
    return dir === 'buy' ? a > b + this.eps() : a < b - this.eps();
  }
  private px(p: number | null): string {
    return p === null ? 'none' : p.toFixed(this.digits);
  }
  private money(v: number): string {
    return `${v >= 0 ? '+$' : '-$'}${Math.abs(v).toFixed(2)}`;
  }
  private priceNow(dir: Dir): number {
    const q = this.quote!;
    return dir === 'buy' ? q.bid : q.ask;
  }
  private stopDist(): number {
    return this.settings.stopsLevelPoints * this.point;
  }
  slValidNow(dir: Dir, sl: number | null): boolean {
    if (sl === null || !this.quote) return true;
    return dir === 'buy' ? sl <= this.quote.bid - this.stopDist() + 1e-9 : sl >= this.quote.ask + this.stopDist() - 1e-9;
  }
  tpValidNow(dir: Dir, tp: number | null): boolean {
    if (tp === null || !this.quote) return true;
    return dir === 'buy' ? tp >= this.quote.bid + this.stopDist() - 1e-9 : tp <= this.quote.ask - this.stopDist() + 1e-9;
  }
  private moneyAt(ts: Ticket[], price: number): number {
    return ts.reduce((s, t) => s + profit(t.dir, t.lot, t.openPrice, price, this.settings.contractSize), 0);
  }

  // ---------------------------------------------------------------- queries

  openTicketsOf(l: Ladder): Ticket[] {
    return l.tickets.filter((t) => t.closePrice === null);
  }

  static openTickets(l: Ladder): Ticket[] {
    return l.tickets.filter((t) => t.closePrice === null);
  }

  /** Volume-weighted average entry of the open tickets. */
  static average(l: Ladder): number {
    return weightedAverage(Engine.openTickets(l).map((t) => ({ lot: t.lot, price: t.openPrice })));
  }

  static totalLot(ts: Ticket[]): number {
    return Math.round(ts.reduce((s, t) => s + t.lot, 0) * 100) / 100;
  }

  /** StageAvg: live before stage 2, frozen anchor after. */
  stageAvg(l: Ladder): number {
    return l.stage >= 2 && l.anchor > 0 ? l.anchor : Engine.average(l);
  }

  worst(l: Ladder): number {
    const ts = this.openTicketsOf(l);
    let w = ts[0]?.openPrice ?? 0;
    for (const t of ts) w = l.dir === 'sell' ? Math.min(w, t.openPrice) : Math.max(w, t.openPrice);
    return w;
  }

  /** Active ladders (open, including an empty one made by NEW LADDER). */
  openLadders(): Ladder[] {
    return this.ladders.filter((l) => l.open);
  }

  ladder(id: number): Ladder | undefined {
    return this.ladders.find((l) => l.id === id);
  }

  openTickets(): Ticket[] {
    return this.tickets.filter((t) => t.closePrice === null);
  }

  unmanagedTickets(): Ticket[] {
    return this.openTickets().filter((t) => t.ladderId === null);
  }

  hasOpenPositions(): boolean {
    return this.openTickets().length > 0 || this.pending.length > 0;
  }

  activeLadder(): Ladder | null {
    const l = this.activeLadderId === null ? undefined : this.ladder(this.activeLadderId);
    return l && l.open ? l : null;
  }

  private newestActive(): Ladder | null {
    const open = this.openLadders();
    return open.length ? open.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  }

  rank(l: Ladder): number {
    return this.openLadders().filter((x) => x.id <= l.id).length;
  }

  private tag(l: Ladder): string {
    return `L${this.rank(l)} ${l.dir ? l.dir.toUpperCase() : '-'}`;
  }

  floating(): number {
    if (!this.quote) return 0;
    return this.openTickets().reduce((s, t) => s + profit(t.dir, t.lot, t.openPrice, this.priceNow(t.dir), this.settings.contractSize), 0);
  }

  margin(): number {
    return this.openTickets().reduce((s, t) => s + this.marginFor(t.lot, t.openPrice), 0);
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

  /** LotCap(): balance/100 * LotPer100, rounded down to the 0.01 lot step. */
  lotCap(): number {
    if (!(this.settings.lotPer100 > 0)) return Infinity;
    return Math.floor(((this.balance / 100) * this.settings.lotPer100) / 0.01 + 1e-9) / 100;
  }

  /** IF SL HITS for a set of tickets: $ at each ticket's own SL; null if any ticket has no SL. */
  ifSLHits(ts: Ticket[]): number | null {
    let r = 0;
    for (const t of ts) {
      if (t.sl === null) return null;
      r += profit(t.dir, t.lot, t.openPrice, t.sl, this.settings.contractSize);
    }
    return r;
  }

  // ---------------------------------------------------------------- broker: orders

  /** Queues a market ticket. It fills on the first tick at or after now (next `onTick`). */
  placeOrder(dir: Dir, lot: number): { ok: boolean; reason?: string } {
    lot = Math.round(lot * 100) / 100;
    if (!(lot >= 0.01)) return this.reject('Lot must be at least 0.01');
    if (this.blown) return this.reject('Account blown - start a new war account');
    this.pending.push({ dir, lot });
    return { ok: true };
  }

  private reject(reason: string): { ok: false; reason: string } {
    this.emit({ type: 'rejected', reason });
    return { ok: false, reason };
  }

  private fill(o: PendingOrder, q: Quote) {
    if (this.blown) return void this.reject('Account blown - start a new war account');
    const price = o.dir === 'buy' ? q.ask : q.bid;
    const need = this.marginFor(o.lot, price);
    const free = this.equity() - this.margin();
    if (need > free) return void this.reject(`Not enough free margin: need $${need.toFixed(2)}, free $${free.toFixed(2)}`);
    const t: Ticket = {
      id: this.nextTicketId++,
      dir: o.dir,
      lot: o.lot,
      openPrice: price,
      openTime: q.time,
      sl: null,
      tp: null,
      ladderId: null,
      reported: false,
      synced: false,
      closePrice: null,
      closeTime: null,
      closeReason: null,
      closedBy: null,
      profit: null,
      firstSL: null,
      risk1: null,
      mfePips: pipsFrom(o.dir, price, q.bid, q.ask),
    };
    this.tickets.push(t);
    this.emit({ type: 'fill', ticket: { ...t } });
  }

  private closeTicket(t: Ticket, price: number, time: number, reason: ExitReason, by: ClosedBy) {
    const gross = profit(t.dir, t.lot, t.openPrice, price, this.settings.contractSize);
    t.closePrice = price;
    t.closeTime = time;
    t.closeReason = reason;
    t.closedBy = by;
    t.profit = round2(gross - this.settings.commissionPerLot * t.lot);
    this.balance = round2(this.balance + t.profit);
    if (t.ladderId === null) this.journalNormal(t);
  }

  // ---------------------------------------------------------------- user actions

  private userLadder(ladderId: number): { l: Ladder; ts: Ticket[] } | null {
    const l = this.ladder(ladderId);
    if (!l || !l.open || !this.quote) return null;
    const ts = this.openTicketsOf(l);
    if (!ts.length) {
      this.notice(`L${this.rank(l)} has no open trades`);
      return null;
    }
    return { l, ts };
  }

  /** Your SL edit: becomes the ladder SL and is copied to every ticket ("your edit wins"). */
  setSL(ladderId: number, price: number | null): void {
    const u = this.userLadder(ladderId);
    if (!u) return;
    const { l, ts } = u;
    const dir = l.dir!;
    if (price === null) {
      if (l.sl !== null) this.notice(`${this.tag(l)} the manager keeps the ladder SL ${this.px(l.sl)} on every ticket - it cannot be removed, move it instead`);
      return;
    }
    price = this.N(price);
    if (!this.slValidNow(dir, price)) {
      this.notice(`Invalid SL ${this.px(price)}: wrong side of price or closer than the stops level - the broker rejects this edit`);
      return;
    }
    if (this.same(price, l.sl)) return;
    const before = l.sl;
    l.slEdits++;
    if (before !== null && this.better(dir, before, price)) l.slWidened = true;
    l.sl = price;
    if (l.pending !== null) {
      this.notice(`${this.tag(l)} your edit wins - waiting auto SL ${this.px(l.pending)} cancelled`);
      l.pending = null;
      l.logWait = null;
    }
    l.syncLogWait = false;
    const copied = this.push(l, ts, false, true);
    if (copied > 0) this.notice(`${this.tag(l)} your edit -> SL ${this.px(l.sl)} TP ${this.px(l.hasTP ? l.tp : null)} copied to ${copied} ticket(s)`);
    this.run();
  }

  setTP(ladderId: number, price: number | null): void {
    const u = this.userLadder(ladderId);
    if (!u) return;
    const { l, ts } = u;
    if (price !== null) {
      price = this.N(price);
      if (!this.tpValidNow(l.dir!, price)) {
        this.notice(`Invalid TP ${this.px(price)}: wrong side of price or closer than the stops level - the broker rejects this edit`);
        return;
      }
    }
    if (l.hasTP && this.same(price, l.tp)) return;
    l.tp = price;
    l.hasTP = true;
    l.syncLogWait = false;
    const copied = this.push(l, ts, false, true);
    if (copied > 0) this.notice(`${this.tag(l)} your edit -> SL ${this.px(l.sl)} TP ${this.px(l.tp)} copied to ${copied} ticket(s)`);
    this.run();
  }

  /** SL/TP of a single unmanaged (opposite) ticket - you manage it yourself. */
  setTicketSL(ticketId: number, price: number | null): void {
    const t = this.tickets.find((x) => x.id === ticketId && x.closePrice === null);
    if (!t || t.ladderId !== null) return;
    if (price !== null) {
      price = this.N(price);
      if (!this.slValidNow(t.dir, price)) return void this.notice(`Invalid SL ${this.px(price)} for #${t.id} - the broker rejects this edit`);
    }
    t.sl = price;
    if (price !== null && t.firstSL === null) {
      t.firstSL = price;
      t.risk1 = profit(t.dir, t.lot, t.openPrice, price, this.settings.contractSize);
    }
  }

  setTicketTP(ticketId: number, price: number | null): void {
    const t = this.tickets.find((x) => x.id === ticketId && x.closePrice === null);
    if (!t || t.ladderId !== null) return;
    if (price !== null) {
      price = this.N(price);
      if (!this.tpValidNow(t.dir, price)) return void this.notice(`Invalid TP ${this.px(price)} for #${t.id} - the broker rejects this edit`);
    }
    t.tp = price;
  }

  /** MOVE TO BE (stage 1) for one ladder. */
  applyBE(ladderId: number): boolean {
    const u = this.userLadder(ladderId);
    if (!u) return false;
    const { l, ts } = u;
    const dir = l.dir!;
    const d = DIR(dir);
    const avg = Engine.average(l);
    const pips = pipsFrom(dir, avg, this.quote!.bid, this.quote!.ask);
    const s = this.settings;
    if (pips < s.beMinPips - 1e-6) {
      this.notice(`MOVE TO BE refused - ${this.tag(l)} TOO EARLY | price ${pips >= 0 ? '+' : ''}${pips.toFixed(1)} pips from average ${this.px(this.N(avg))} | BE allowed from +${s.beMinPips} pips (${this.px(this.N(avg + d * s.beMinPips * PIP))})`);
      return false;
    }
    const be = this.N(avg + d * s.beBufferPips * PIP);
    if (!this.better(dir, be, l.sl)) {
      this.notice(`MOVE TO BE refused - ${this.tag(l)} SL ${this.px(l.sl)} is already at or past breakeven ${this.px(be)} - nothing changed`);
      return false;
    }
    if (!this.slValidNow(dir, be)) {
      this.notice(`MOVE TO BE refused - ${this.tag(l)} BE ${this.px(be)} is too close to price for the broker - press again in a moment`);
      return false;
    }
    const before = l.sl;
    this.modifyAll(l, ts, be);
    l.slEdits++;
    l.beApplied = true;
    this.run();
    this.notice(`${this.tag(l)} STAGE 1 | SL ${this.px(before)} -> ${this.px(be)} (average ${this.px(this.N(avg))} +${s.beBufferPips} pip) | price ${pips >= 0 ? '+' : ''}${pips.toFixed(1)} pips`);
    return true;
  }

  /** Why NEW LADDER is refused right now ('' = allowed). Mirrors CLadderManager::NewLadder. */
  newLadderBlock(): string {
    const cur = this.activeLadder();
    if (cur && this.openTicketsOf(cur).length === 0) return `L${this.rank(cur)} has no trades yet - use it first`;
    for (const l of this.openLadders()) {
      if (l.stage < 2) return `L${this.rank(l)} has not reached stage 2 yet (SL at average +${this.settings.s2LockPips} pips)`;
    }
    if (this.openLadders().length >= MAX_OPEN_LADDERS) return `maximum ${MAX_OPEN_LADDERS} ladders are open`;
    for (const l of this.openLadders()) {
      const r = this.ifSLHits(this.openTicketsOf(l));
      if (r === null) return `L${this.rank(l)} has a ticket with NO SL`;
      if (r < -0.005) return `L${this.rank(l)} still at risk (${this.money(r)} if SL hits)`;
    }
    return '';
  }

  canNewLadder(): boolean {
    return this.newLadderBlock() === '';
  }

  newLadder(): boolean {
    const why = this.newLadderBlock();
    if (why) {
      this.notice(`NEW LADDER refused - ${why}`);
      return false;
    }
    const locked = this.openLadders()
      .map((l) => `L${this.rank(l)} locked ${this.money(this.ifSLHits(this.openTicketsOf(l)) ?? 0)}`)
      .join(', ');
    const l = this.makeLadder();
    this.activeLadderId = l.id;
    this.notice(`NEW LADDER L${this.rank(l)} opened${locked ? ` | ${locked}` : ''} | your next trades join L${this.rank(l)}`);
    return true;
  }

  private makeLadder(): Ladder {
    const l: Ladder = {
      id: this.nextLadderId++,
      dir: null,
      tickets: [],
      open: true,
      openTime: null,
      closeTime: null,
      sl: null,
      tp: null,
      hasTP: false,
      stage: 0,
      anchor: 0,
      next: 0,
      pending: null,
      fail: 0,
      logWait: null,
      syncLogWait: false,
      beReached: false,
      beApplied: false,
      no: 0,
      balBefore: 0,
      firstSL: null,
      risk1: 0,
      riskMax: null,
      lotsTotal: 0,
      lotsMax: 0,
      worst: 0,
      mfe: 0,
      mae: 0,
      moveSeen: false,
      slEdits: 0,
      slWidened: false,
      s2Time: null,
      autoRefused: 0,
      refLast: null,
      mfePips: -Infinity,
      exitReason: null,
    };
    this.ladders.push(l);
    return l;
  }

  closeLadder(ladderId: number): void {
    const l = this.ladder(ladderId);
    if (!l || !l.open || !this.quote) return;
    for (const t of this.openTicketsOf(l)) this.closeTicket(t, this.priceNow(t.dir), this.quote.time, 'manual close', 'you');
    this.run();
  }

  closeUnmanaged(ticketId: number): void {
    const t = this.tickets.find((x) => x.id === ticketId && x.closePrice === null);
    if (!t || t.ladderId !== null || !this.quote) return;
    this.closeTicket(t, this.priceNow(t.dir), this.quote.time, 'manual close', 'you');
    this.run();
  }

  closeAll(): void {
    this.pending = [];
    if (!this.quote) return;
    for (const t of this.openTickets()) this.closeTicket(t, this.priceNow(t.dir), this.quote.time, 'manual close', 'you');
    this.run();
  }

  /** Resets the balance to the starting balance (open positions are closed first). Journal is kept by the caller. */
  newWarAccount(): void {
    this.closeAll();
    this.balance = this.settings.startBalance;
    this.blown = false;
  }

  /** Applies new settings. Like the EA, the lot cap only changes while no trade is open, and stage
   *  inputs must pass the EA's order check. */
  updateSettings(s: Partial<AccountSettings>) {
    const next = { ...this.settings, ...s };
    if (next.lotPer100 !== this.settings.lotPer100 && this.openTickets().length > 0) {
      this.notice(`Lot cap change IGNORED while trades are open - still ${this.settings.lotPer100.toFixed(2)} per $100 per ladder. Change it again when all ladders are closed.`);
      next.lotPer100 = this.settings.lotPer100;
    }
    const why = stageCheck(next);
    if (why) {
      this.notice(`SETTING refused: ${why}`);
      for (const k of ['beMinPips', 'beBufferPips', 's2TrigPips', 's2LockPips', 's3TrigPips', 's3LockPips'] as const) next[k] = this.settings[k];
    }
    this.settings = next;
  }

  // ---------------------------------------------------------------- EA pass

  /** CLadderManager::Run() */
  run(): void {
    if (!this.quote) return;
    this.assignNew();
    for (const l of [...this.ladders]) if (l.open) this.processLadder(l);
  }

  private assignNew(): void {
    const unowned = this.openTickets()
      .filter((t) => t.ladderId === null)
      .sort((a, b) => a.openTime - b.openTime || a.id - b.id);
    for (const t of unowned) {
      if (!this.activeLadder()) {
        const newest = this.newestActive();
        this.activeLadderId = (newest ?? this.makeLadder()).id;
      }
      const l = this.activeLadder()!;
      const reqSide = l.dir ?? this.openLadders().find((x) => x.dir !== null)?.dir ?? null;
      if (reqSide && t.dir !== reqSide) {
        if (!t.reported) {
          t.reported = true;
          this.notice(`${t.dir.toUpperCase()} #${t.id} is opposite to your open ladder(s) (${reqSide.toUpperCase()}) - NOT managed. Manage it yourself.`);
        }
        continue;
      }
      const first = l.tickets.length === 0;
      if (!l.dir) l.dir = t.dir;
      t.ladderId = l.id;
      t.reported = false;
      l.tickets.push(t);
      l.lotsTotal = Math.round((l.lotsTotal + t.lot) * 100) / 100;
      const ts = this.openTicketsOf(l);
      const avg = Engine.average(l);
      const d = DIR(l.dir);
      if (first) {
        l.balBefore = this.balance;
        l.no = this.rank(l);
        l.openTime = t.openTime;
        this.notice(`${this.tag(l)} STARTED | #${t.id} ${t.lot.toFixed(2)} @ ${this.px(t.openPrice)} | stage 2 at ${this.px(this.N(avg + d * this.settings.s2TrigPips * PIP))}`);
      } else if (l.stage === 0) {
        this.notice(`${this.tag(l)} TRADE ADDED #${t.id} ${t.lot.toFixed(2)} @ ${this.px(t.openPrice)} | ${ts.length} ticket(s) ${Engine.totalLot(ts).toFixed(2)} lot | average ${this.px(this.N(avg))} | stage 2 at ${this.px(this.N(avg + d * this.settings.s2TrigPips * PIP))}`);
      } else {
        this.notice(`${this.tag(l)} TRADE ADDED after stage 2 #${t.id} ${t.lot.toFixed(2)} @ ${this.px(t.openPrice)} | it takes the ladder SL ${this.px(l.sl)}`);
      }
    }
  }

  private processLadder(l: Ladder): void {
    let ts = this.openTicketsOf(l);
    if (ts.length === 0) {
      if (l.tickets.length > 0) this.finishLadder(l);
      return;
    }
    this.enforceCap(l, ts);
    ts = this.openTicketsOf(l);
    if (ts.length === 0) {
      this.finishLadder(l);
      return;
    }
    this.sync(l, ts);

    const dir = l.dir!;
    const d = DIR(dir);
    const price = this.priceNow(dir);
    const s = this.settings;

    // simulator only: first time BE is allowed (auto-pause "BE available")
    if (!l.beReached && pipsFrom(dir, this.stageAvg(l), this.quote!.bid, this.quote!.ask) >= s.beMinPips - 1e-6) {
      l.beReached = true;
      this.emit({ type: 'stage', ladderId: l.id, stage: 1 });
    }

    // STAGE 2 (average entry is frozen here)
    if (l.stage === 0) {
      const avg = Engine.average(l);
      if (avg > 0 && d * (price - avg) >= s.s2TrigPips * PIP - this.eps()) {
        l.anchor = avg;
        const target = this.N(avg + d * s.s2LockPips * PIP);
        l.next = this.N(avg + d * s.s3TrigPips * PIP);
        l.stage = 2;
        l.pending = target;
        l.s2Time = this.quote!.time;
        this.emit({ type: 'stage', ladderId: l.id, stage: 2 });
        this.tryPending(l, ts, `STAGE 2 | price ${this.px(price)} = average ${this.px(this.N(avg))} +${s.s2TrigPips} pips | locks ${this.money(this.moneyAt(ts, target))}`);
      }
    }

    // STAGE 3 (last automatic move - after this the runner is yours)
    if (l.stage === 2 && l.anchor > 0) l.next = this.N(l.anchor + d * s.s3TrigPips * PIP); // follows a settings change
    if (l.stage === 2 && l.next > 0 && d * (price - l.next) >= -this.eps()) {
      const target = this.N(l.anchor + d * s.s3LockPips * PIP);
      l.stage = 3;
      l.pending = target;
      this.emit({ type: 'stage', ladderId: l.id, stage: 3 });
      this.tryPending(l, ts, `STAGE 3 | price ${this.px(price)} = average ${this.px(this.N(l.anchor))} +${s.s3TrigPips} pips | locks ${this.money(this.moneyAt(ts, target))}`);
    }

    // retry a waiting auto SL
    if (l.pending !== null) this.tryPending(l, ts, '');

    this.track(l, ts);
  }

  /** EnforceCap: tickets (oldest first) that take the ladder over the cap are closed by the manager. */
  private enforceCap(l: Ladder, ts: Ticket[]): void {
    const cap = this.lotCap();
    if (!Number.isFinite(cap)) return;
    let run = 0;
    for (const t of ts) {
      if (run + t.lot > cap + 1e-9) {
        this.closeTicket(t, this.priceNow(t.dir), this.quote!.time, 'cap close', 'manager');
        this.notice(`${this.tag(l)} CAP ${cap.toFixed(2)} lot | trade #${t.id} ${t.lot.toFixed(2)} lot CLOSED - ladder would exceed the cap`);
        continue;
      }
      run += t.lot;
    }
  }

  /** Copies the ladder SL/TP to tickets that differ. Returns how many tickets were changed.
   *  Tickets that cannot take it yet (too close to price) wait and are retried after the cooldown. */
  private push(l: Ladder, ts: Ticket[], cooling: boolean, userEdit = false): number {
    const dir = l.dir!;
    let copied = 0;
    let waitN = 0;
    let what = '';
    for (const t of ts) {
      const wantSL = l.sl !== null ? l.sl : t.sl;
      const wantTP = l.hasTP ? l.tp : t.tp;
      if (this.same(wantSL, t.sl) && this.same(wantTP, t.tp)) continue;
      if (cooling) continue;
      if (!this.slValidNow(dir, wantSL) || !this.tpValidNow(dir, wantTP)) {
        waitN++;
        what = `SL ${this.px(wantSL)} TP ${this.px(wantTP)}`;
        continue;
      }
      const isNew = !t.synced;
      t.synced = true;
      t.sl = wantSL;
      t.tp = wantTP;
      if (isNew && !userEdit) this.notice(`${this.tag(l)} new trade #${t.id} got ladder SL ${this.px(wantSL)} TP ${this.px(wantTP)}`);
      else copied++;
    }
    if (waitN > 0) {
      l.fail = this.quote!.time;
      if (!l.syncLogWait) {
        l.syncLogWait = true;
        this.notice(`${this.tag(l)} ${waitN} ticket(s) cannot take ${what} yet (too close to price). Waiting.`);
      }
    }
    if (copied > 0) l.syncLogWait = false;
    return copied;
  }

  private sync(l: Ladder, ts: Ticket[]): void {
    const now = this.quote!.time;
    const cooling = l.fail > 0 && now - l.fail < this.settings.retryCooldownSec * 1000;
    const copied = this.push(l, ts, cooling);
    if (copied > 0) this.notice(`${this.tag(l)} ladder SL ${this.px(l.sl)} TP ${this.px(l.hasTP ? l.tp : null)} applied to ${copied} ticket(s)`);
  }

  private modifyAll(l: Ladder, ts: Ticket[], sl: number): void {
    for (const t of ts) {
      t.sl = sl;
      t.synced = true;
      if (l.hasTP) t.tp = l.tp;
    }
    l.sl = sl;
  }

  /** Moves the ladder SL to l.pending; steps back by the spread if the broker refuses (stops level). */
  private tryPending(l: Ladder, ts: Ticket[], label: string): void {
    if (l.pending === null || ts.length === 0) return;
    const now = this.quote!.time;
    if (label === '' && l.fail > 0 && now - l.fail < this.settings.retryCooldownSec * 1000) return;
    const dir = l.dir!;
    const cur = l.sl;
    if (!this.better(dir, l.pending, cur)) {
      if (label) this.notice(`${this.tag(l)} ${label} | auto SL ${this.px(l.pending)} not applied - your SL ${this.px(cur)} is already better`);
      l.pending = null;
      l.logWait = null;
      return;
    }
    let spread = this.quote!.ask - this.quote!.bid;
    if (spread <= 0) spread = this.point * 10;
    const d = DIR(dir);
    for (let k = 0; k <= 5; k++) {
      const c = this.N(l.pending - d * k * spread);
      if (!this.better(dir, c, cur)) break; // stepping back would not improve anything
      if (!this.slValidNow(dir, c)) continue;
      const before = cur;
      this.modifyAll(l, ts, c);
      const tail = l.stage === 2 ? ` | stage 3 at ${this.px(l.next)}` : l.stage === 3 ? ' | runner is yours' : '';
      if (k === 0) {
        this.notice(`${this.tag(l)} ${label || 'AUTO SL'} | SL ${this.px(before)} -> ${this.px(c)}${tail}`);
        l.pending = null;
        l.logWait = null;
      } else {
        this.notice(`${this.tag(l)} ${label || 'AUTO SL'} | SL ${this.px(before)} -> ${this.px(c)} (target ${this.px(l.pending)} too close to price - will tighten when allowed)`);
        if (!this.same(l.refLast, l.pending)) {
          l.refLast = l.pending;
          l.autoRefused++;
        }
      }
      l.fail = 0;
      return;
    }
    l.fail = now;
    if (!this.same(l.logWait, l.pending)) {
      l.logWait = l.pending;
      if (!this.same(l.refLast, l.pending)) {
        l.refLast = l.pending;
        l.autoRefused++;
      }
      this.notice(`${this.tag(l)} ${label ? `${label} | ` : ''}auto SL ${this.px(l.pending)} not allowed yet (too close to price). Waiting.`);
    }
  }

  /** Journal measurements every pass (no trading here). */
  private track(l: Ladder, ts: Ticket[]): void {
    const dir = l.dir!;
    const vol = Engine.totalLot(ts);
    if (vol > l.lotsMax + 1e-9) l.lotsMax = vol;
    const w = this.worst(l);
    l.worst = w;
    const price = this.priceNow(dir);
    const mv = DIR(dir) * (price - w);
    if (!l.moveSeen) {
      l.mfe = mv;
      l.mae = mv;
      l.moveSeen = true;
    }
    if (mv > l.mfe) l.mfe = mv;
    if (mv < l.mae) l.mae = mv;
    const r = this.ifSLHits(ts);
    if (r !== null && (l.riskMax === null || r < l.riskMax - 0.005)) l.riskMax = r;
    if (l.firstSL === null && l.sl !== null) {
      l.firstSL = l.sl;
      l.risk1 = this.moneyAt(ts, l.sl);
    }
    const pips = pipsFrom(dir, this.stageAvg(l), this.quote!.bid, this.quote!.ask);
    if (pips > l.mfePips) l.mfePips = pips;
  }

  private finishLadder(l: Ladder): void {
    const closed = l.tickets.filter((t) => t.closeTime !== null).sort((a, b) => a.closeTime! - b.closeTime! || a.id - b.id);
    const last = closed[closed.length - 1];
    l.open = false;
    l.closeTime = last?.closeTime ?? this.quote!.time;
    l.exitReason = last?.closeReason ?? 'manual close';
    const record = this.buildRecord(l, last ?? null);
    this.trackers.push({ entryId: record.id, dir: record.dir, avg: record.avgEntry, until: l.closeTime + POST_CLOSE_TRACK_MS, max: null });
    this.emit({ type: 'ladderClosed', record });
    if (this.activeLadderId === l.id) this.activeLadderId = this.newestActive()?.id ?? null;
  }

  private buildRecord(l: Ladder, last: Ticket | null): JournalRecord {
    const ts = l.tickets;
    const dir = l.dir!;
    const totalLot = Engine.totalLot(ts);
    const avg = weightedAverage(ts.map((t) => ({ lot: t.lot, price: t.openPrice })));
    const result = round2(ts.reduce((s, t) => s + (t.profit ?? 0), 0));
    const closedBy: Record<ClosedBy, number> = { sl: 0, tp: 0, manager: 0, you: 0, other: 0 };
    for (const t of ts) if (t.closedBy) closedBy[t.closedBy]++;
    let mfe: number | null = null;
    let mae: number | null = null;
    let give: number | null = null;
    if (last && l.worst > 0) {
      const fin = DIR(dir) * (last.closePrice! - l.worst);
      mfe = l.moveSeen ? Math.max(l.mfe, fin) : fin;
      mae = l.moveSeen ? Math.min(l.mae, fin) : fin;
      give = mfe - fin;
    }
    const hasR1 = l.firstSL !== null && Math.abs(l.risk1) > 0.005;
    return {
      id: `${this.idPrefix}-${l.id}`,
      kind: 'ladder',
      dir,
      ladderNo: l.no,
      openTime: l.openTime ?? 0,
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
      worstEntry: l.worst,
      totalLot,
      lotsMax: l.lotsMax,
      originalSL: l.firstSL,
      finalSL: l.sl,
      R: hasR1 ? round2(Math.abs(l.risk1)) : null,
      riskMax: l.riskMax === null ? null : round2(l.riskMax),
      slEdits: l.slEdits,
      slWidened: l.slWidened,
      highestStage: STAGE_NAMES[l.stage],
      stage2Time: l.s2Time,
      beApplied: l.beApplied,
      exitReason: l.exitReason ?? 'manual close',
      closedBy,
      autoSlRefused: l.autoRefused,
      result,
      resultR: hasR1 ? Math.round((result / Math.abs(l.risk1)) * 100) / 100 : null,
      resultPips: Math.round((result / (totalLot * this.settings.contractSize * PIP)) * 10) / 10,
      mfePrice: mfe === null ? null : round2(mfe),
      maePrice: mae === null ? null : round2(mae),
      giveback: give === null ? null : round2(give),
      mfePips: Number.isFinite(l.mfePips) ? l.mfePips : 0,
      postClosePips: null,
      postCloseDone: false,
      balanceBefore: l.balBefore,
      balanceAfter: this.balance,
      note: '',
    };
  }

  /** An unmanaged (opposite) ticket closed: journaled as a "normal" trade, never mixed into ladder stats. */
  private journalNormal(t: Ticket): void {
    const result = t.profit ?? 0;
    const R = t.risk1 !== null && t.risk1 < -0.005 ? round2(-t.risk1) : null;
    const record: JournalRecord = {
      id: `${this.idPrefix}-t${t.id}`,
      kind: 'normal',
      dir: t.dir,
      ladderNo: 0,
      openTime: t.openTime,
      closeTime: t.closeTime ?? 0,
      ticketCount: 1,
      tickets: [{ lot: t.lot, openPrice: t.openPrice, openTime: t.openTime, closePrice: t.closePrice ?? 0, closeTime: t.closeTime ?? 0, profit: result, reason: t.closeReason ?? 'manual close' }],
      avgEntry: t.openPrice,
      worstEntry: t.openPrice,
      totalLot: t.lot,
      lotsMax: t.lot,
      originalSL: t.firstSL,
      finalSL: t.sl,
      R,
      riskMax: t.risk1,
      slEdits: 0,
      slWidened: false,
      highestStage: 'none',
      stage2Time: null,
      beApplied: false,
      exitReason: t.closeReason ?? 'manual close',
      closedBy: { sl: 0, tp: 0, manager: 0, you: 0, other: 0, [t.closedBy ?? 'you']: 1 } as Record<ClosedBy, number>,
      autoSlRefused: 0,
      result,
      resultR: R ? Math.round((result / R) * 100) / 100 : null,
      resultPips: Math.round((result / (t.lot * this.settings.contractSize * PIP)) * 10) / 10,
      mfePrice: null,
      maePrice: null,
      giveback: null,
      mfePips: t.mfePips,
      postClosePips: null,
      postCloseDone: false,
      balanceBefore: round2(this.balance - result),
      balanceAfter: this.balance,
      note: '',
    };
    this.trackers.push({ entryId: record.id, dir: t.dir, avg: t.openPrice, until: (t.closeTime ?? 0) + POST_CLOSE_TRACK_MS, max: null });
    this.emit({ type: 'ladderClosed', record });
  }

  // ---------------------------------------------------------------- tick processing

  onTick(time: number, bid: number, ask: number): void {
    const q: Quote = { time, bid, ask };
    this.quote = q;

    // post-close trackers (before closes on this tick register new ones)
    if (this.trackers.length) {
      this.trackers = this.trackers.filter((tr) => {
        if (!feedTracker(tr, time, bid, ask)) return true;
        this.emit({ type: 'postClose', entryId: tr.entryId, pips: tr.max, done: true });
        return false;
      });
    }

    // broker: queued market orders fill on this tick
    if (this.pending.length) {
      const orders = this.pending;
      this.pending = [];
      for (const o of orders) this.fill(o, q);
    }

    // broker: SL / TP triggers (buy on bid, sell on ask), on every open ticket
    const hits = new Map<string, { ladderId: number | null; type: 'sl' | 'tp'; ids: number[]; reason: ExitReason }>();
    for (const t of this.openTickets()) {
      const px = this.priceNow(t.dir);
      const l = t.ladderId === null ? null : this.ladder(t.ladderId)!;
      if (t.sl !== null && (t.dir === 'buy' ? px <= t.sl : px >= t.sl)) {
        const reason: ExitReason = l && (l.stage >= 2 || l.beApplied) ? 'stage SL' : 'SL';
        this.closeTicket(t, px, time, reason, 'sl');
        const k = `sl:${t.ladderId}`;
        const h = hits.get(k) ?? { ladderId: t.ladderId, type: 'sl' as const, ids: [], reason };
        h.ids.push(t.id);
        hits.set(k, h);
      } else if (t.tp !== null && (t.dir === 'buy' ? px >= t.tp : px <= t.tp)) {
        this.closeTicket(t, px, time, 'TP', 'tp');
        const k = `tp:${t.ladderId}`;
        const h = hits.get(k) ?? { ladderId: t.ladderId, type: 'tp' as const, ids: [], reason: 'TP' as ExitReason };
        h.ids.push(t.id);
        hits.set(k, h);
      } else if (t.ladderId === null) {
        const p = pipsFrom(t.dir, t.openPrice, bid, ask);
        if (p > t.mfePips) t.mfePips = p;
      }
    }
    for (const h of hits.values()) {
      if (h.type === 'sl') this.emit({ type: 'sl', ladderId: h.ladderId, ticketIds: h.ids, reason: h.reason });
      else this.emit({ type: 'tp', ladderId: h.ladderId, ticketIds: h.ids });
    }

    // the EA pass
    this.run();

    // broker: stop-out
    const ml = this.marginLevel();
    if (ml !== null && ml <= this.settings.stopOutLevel) {
      for (const t of this.openTickets()) this.closeTicket(t, this.priceNow(t.dir), time, 'stop-out', 'other');
      this.pending = [];
      this.blown = true;
      this.run();
      this.emit({ type: 'stopout' });
      this.notice(`Stop-out at margin level ${ml.toFixed(1)}% - all positions closed. Account blown.`);
    }
  }

  // ---------------------------------------------------------------- snapshot (the EA panel)

  private ticketView(t: Ticket): TicketView {
    return {
      id: t.id,
      dir: t.dir,
      lot: t.lot,
      openPrice: t.openPrice,
      openTime: t.openTime,
      sl: t.sl,
      tp: t.tp,
      floating: this.quote ? profit(t.dir, t.lot, t.openPrice, this.priceNow(t.dir), this.settings.contractSize) : 0,
    };
  }

  snapshot(): EngineSnapshot {
    const q = this.quote ?? { time: 0, bid: NaN, ask: NaN };
    const margin = this.margin();
    const equity = this.equity();
    const s = this.settings;
    const ladders: LadderView[] = this.openLadders().map((l) => {
      const ts = this.openTicketsOf(l);
      const base = {
        id: l.id,
        rank: this.rank(l),
        dir: l.dir,
        active: l.id === this.activeLadderId,
        stage: l.stage,
        pending: l.pending,
        beApplied: l.beApplied,
        sl: l.sl,
        tp: l.hasTP ? l.tp : null,
        tickets: ts.map((t) => this.ticketView(t)),
      };
      if (!ts.length || !l.dir || !this.quote) {
        return {
          ...base,
          ticketCount: 0,
          totalLot: 0,
          worstEntry: 0,
          avg: NaN,
          pips: 0,
          beText: '',
          beEnabled: false,
          stageText: `${l.dir ? l.dir.toUpperCase() : ''} empty - your next trades join this ladder`.trim(),
          ifSLHits: null,
          ifSLHitsPct: null,
          ifClosedNow: 0,
          R: null,
          rr: null,
          mfePips: 0,
        };
      }
      const d = DIR(l.dir);
      const avg = this.stageAvg(l);
      const pips = pipsFrom(l.dir, avg, q.bid, q.ask);
      const be = this.N(avg + d * s.beBufferPips * PIP);
      let beText: string;
      if (l.sl !== null && !this.better(l.dir, be, l.sl)) beText = 'BE done';
      else if (pips >= s.beMinPips - 1e-6) beText = 'BE allowed';
      else beText = `BE from ${this.px(this.N(avg + d * s.beMinPips * PIP))}`;
      // the button acts on the live average, like MoveToBE
      const liveAvg = Engine.average(l);
      const liveBE = this.N(liveAvg + d * s.beBufferPips * PIP);
      const beEnabled = pipsFrom(l.dir, liveAvg, q.bid, q.ask) >= s.beMinPips - 1e-6 && this.better(l.dir, liveBE, l.sl);
      let stageText: string;
      if (l.stage === 0) {
        const s2 = this.N(avg + d * s.s2LockPips * PIP);
        stageText = `stage 2 at ${this.px(this.N(avg + d * s.s2TrigPips * PIP))} -> SL ${this.px(s2)} locks ${this.money(this.moneyAt(ts, s2))}`;
      } else if (l.stage === 2) {
        const s3 = this.N(l.anchor + d * s.s3LockPips * PIP);
        stageText = `STAGE 2 done | stage 3 at ${this.px(l.next)} -> SL ${this.px(s3)} locks ${this.money(this.moneyAt(ts, s3))}`;
      } else stageText = 'STAGE 3 done | runner is yours - move the SL as you see fit';
      if (l.pending !== null) stageText += ` | waiting ${this.px(l.pending)}`;
      const risk = this.ifSLHits(ts);
      const now = this.moneyAt(ts, this.priceNow(l.dir));
      const R = l.riskMax !== null && l.riskMax < -0.005 ? -l.riskMax : null;
      return {
        ...base,
        ticketCount: ts.length,
        totalLot: Engine.totalLot(ts),
        worstEntry: this.worst(l),
        avg,
        pips,
        beText,
        beEnabled,
        stageText,
        ifSLHits: risk,
        ifSLHitsPct: risk !== null && risk < -0.005 && this.balance > 0 ? (-risk / this.balance) * 100 : null,
        ifClosedNow: now,
        R,
        rr: R ? now / R : null,
        mfePips: Number.isFinite(l.mfePips) ? l.mfePips : 0,
      };
    });
    const managed = this.openTickets().filter((t) => t.ladderId !== null);
    const why = this.newLadderBlock();
    const active = this.activeLadder();
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
      contractSize: s.contractSize,
      lotCap: this.lotCap(),
      ladderCount: this.openLadders().length,
      ladders,
      activeLadderId: active?.id ?? null,
      emptyLadder: !!active && active.tickets.length === 0,
      canNewLadder: why === '',
      newLadderWhy: why,
      totalIfSLHits: this.ifSLHits(managed),
      unmanaged: this.unmanagedTickets().map((t) => this.ticketView(t)),
      pendingOrders: this.pending.length,
    };
  }
}
