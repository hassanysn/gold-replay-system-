// Live account state for the panel: groups the MT5 positions into ladders (from the EA's state file,
// or by direction when the EA is not running), tracks each ladder for the journal, and builds the
// same EngineSnapshot the simulator's panel and trade lines draw. Pure: no DOM, no network.

import { EMPTY_TAGS, type EngineSnapshot, type LadderView, type SetupTags, type TicketView } from '../core/engine';
import { type Dir, PIP } from '../core/pips';
import type { EaLadder, EaSettings, LivePosition, Poll } from './api';

export const DEFAULT_EA_SETTINGS: EaSettings = { beMin: 30, beBuf: 1, s2t: 50, s2l: 20, s3t: 100, s3l: 50, pip: PIP };
/** EA InpLotPer100 (0.10 lot per $100 = 0.05 for $50). */
export const LOT_PER_100 = 0.1;
export const MAX_LADDERS = 3;

/** One ladder (or one unmanaged ticket) followed from its first trade to its last close. */
export interface Tracker {
  /** Panel id (stable while open, also across page reloads). */
  uid: number;
  /** ea:<id>:<start> (EA ladder), fb:<dir>:<ticket> (EA off), t:<ticket> (unmanaged). */
  key: string;
  kind: 'ladder' | 'normal';
  eaId: number | null;
  dir: Dir | null;
  rank: number;
  /** Every ticket that was ever in it. */
  tickets: number[];
  openTime: number;
  balBefore: number;
  lotsMax: number;
  firstSL: number | null;
  /** IF SL HITS when the first SL was seen ($, negative). */
  risk1: number;
  riskMax: number | null;
  lastSL: number | null;
  slEdits: number;
  slWidened: boolean;
  stage: 0 | 2 | 3;
  s2Time: number | null;
  beApplied: boolean;
  bePulled: boolean;
  worst: number;
  mfe: number;
  mae: number;
  moveSeen: boolean;
  mfePips: number;
  tags: SetupTags;
}

export interface Group {
  tracker: Tracker;
  positions: LivePosition[];
  ea: EaLadder | null;
}

export interface UpdateResult {
  snap: EngineSnapshot;
  groups: Group[];
  unmanaged: Group[];
  /** Trackers whose last ticket closed (journal them). */
  closed: Tracker[];
  openedTickets: number[];
  closedTickets: number[];
  eaOn: boolean;
  settings: EaSettings;
}

const DIRN = (d: Dir) => (d === 'buy' ? 1 : -1);
const money = (v: number) => `${v >= 0 ? '+$' : '-$'}${Math.abs(v).toFixed(2)}`;

export function lotCap(balance: number): number {
  return Math.floor((balance / 100) * LOT_PER_100 * 100 + 1e-7) / 100;
}

export class LiveState {
  trackers: Tracker[] = [];
  nextUid = 1;
  private lastTickets = new Set<number>();
  private first = true;

  constructor(
    public contractSize: number,
    public digits: number,
  ) {}

  /** Restores trackers saved before a page reload (tags, first SL, MFE...). */
  restore(saved: { trackers: Tracker[]; nextUid: number } | undefined) {
    if (!saved) return;
    this.trackers = saved.trackers.map((t) => ({ ...t, tags: { ...EMPTY_TAGS, ...t.tags } }));
    this.nextUid = Math.max(saved.nextUid, ...this.trackers.map((t) => t.uid + 1), 1);
  }

  saved() {
    return { trackers: this.trackers, nextUid: this.nextUid };
  }

  tracker(uid: number): Tracker | undefined {
    return this.trackers.find((t) => t.uid === uid);
  }

  private N(p: number) {
    const f = 10 ** this.digits;
    return Math.round(p * f) / f;
  }

  private px(p: number | null) {
    return p === null ? 'none' : p.toFixed(this.digits);
  }

  private same(a: number | null, b: number | null) {
    return a !== null && b !== null && Math.abs(a - b) < 0.5 / 10 ** this.digits;
  }

  /** a is better (more profit-side) than b for this direction; b null = anything is better. */
  private better(dir: Dir, a: number | null, b: number | null) {
    if (a === null) return false;
    if (b === null) return true;
    return DIRN(dir) * (a - b) > 0.5 / 10 ** this.digits;
  }

  private moneyAt(ps: LivePosition[], price: number) {
    return ps.reduce((s, p) => s + DIRN(p.dir) * (price - p.openPrice) * p.lot * this.contractSize, 0);
  }

  /** IF SL HITS: null = a ticket has no SL (unlimited loss). */
  ifSLHits(ps: LivePosition[]): number | null {
    let s = 0;
    for (const p of ps) {
      if (p.sl === null) return null;
      s += DIRN(p.dir) * (p.sl - p.openPrice) * p.lot * this.contractSize;
    }
    return Math.round(s * 100) / 100;
  }

  static average(ps: LivePosition[]): number {
    const v = ps.reduce((s, p) => s + p.lot, 0);
    return v > 0 ? ps.reduce((s, p) => s + p.openPrice * p.lot, 0) / v : NaN;
  }

  private newTracker(key: string, kind: Tracker['kind'], eaId: number | null, balance: number, time: number): Tracker {
    const t: Tracker = {
      uid: this.nextUid++,
      key,
      kind,
      eaId,
      dir: null,
      rank: 0,
      tickets: [],
      openTime: time,
      balBefore: balance,
      lotsMax: 0,
      firstSL: null,
      risk1: 0,
      riskMax: null,
      lastSL: null,
      slEdits: 0,
      slWidened: false,
      stage: 0,
      s2Time: null,
      beApplied: false,
      bePulled: false,
      worst: 0,
      mfe: 0,
      mae: 0,
      moveSeen: false,
      mfePips: -Infinity,
      tags: { ...EMPTY_TAGS },
    };
    this.trackers.push(t);
    return t;
  }

  update(p: Poll): UpdateResult {
    const pos = new Map(p.positions.map((x) => [x.ticket, x]));
    const ea = p.ea && p.ea.running ? p.ea : null;
    const settings = ea?.settings ?? DEFAULT_EA_SETTINGS;
    const bal = p.account.balance;
    const now = p.quote.time;
    const groups: Group[] = [];
    const unmanaged: Group[] = [];
    const grouped = new Set<number>();
    const find = (key: string) => this.trackers.find((t) => t.key === key);

    if (ea) {
      for (const L of [...ea.ladders].sort((a, b) => a.rank - b.rank)) {
        const key = `ea:${L.id}:${L.start}`;
        const t = find(key) ?? this.newTracker(key, 'ladder', L.id, bal, now);
        t.eaId = L.id;
        t.rank = L.rank;
        const ps = L.tickets.map((k) => pos.get(k)).filter((x): x is LivePosition => !!x);
        for (const x of ps) grouped.add(x.ticket);
        groups.push({ tracker: t, positions: ps, ea: L });
      }
      for (const x of p.positions) {
        if (grouped.has(x.ticket)) continue;
        const t = find(`t:${x.ticket}`) ?? this.newTracker(`t:${x.ticket}`, 'normal', null, bal, x.openTime);
        grouped.add(x.ticket);
        unmanaged.push({ tracker: t, positions: [x], ea: null });
      }
    } else {
      // EA not running: keep the ladders we know, the rest joins the newest ladder of its direction.
      for (const t of this.trackers) {
        const ps = t.tickets.map((k) => pos.get(k)).filter((x): x is LivePosition => !!x && !grouped.has(x.ticket));
        if (!ps.length) continue;
        for (const x of ps) grouped.add(x.ticket);
        (t.kind === 'ladder' ? groups : unmanaged).push({ tracker: t, positions: ps, ea: null });
      }
      for (const x of [...p.positions].sort((a, b) => a.openTime - b.openTime)) {
        if (grouped.has(x.ticket)) continue;
        let g = [...groups].reverse().find((g) => g.tracker.dir === x.dir || g.tracker.dir === null);
        if (!g) {
          g = { tracker: this.newTracker(`fb:${x.dir}:${x.ticket}`, 'ladder', null, bal, x.openTime), positions: [], ea: null };
          groups.push(g);
        }
        g.positions.push(x);
        grouped.add(x.ticket);
      }
      groups.sort((a, b) => a.tracker.uid - b.tracker.uid);
      groups.forEach((g, i) => (g.tracker.rank = i + 1));
    }

    // closed: a tracker that is no longer shown and has no open ticket
    const shown = new Set([...groups, ...unmanaged].map((g) => g.tracker));
    const closed: Tracker[] = [];
    this.trackers = this.trackers.filter((t) => {
      if (shown.has(t)) return true;
      const open = t.tickets.filter((k) => pos.has(k));
      if (open.length && !open.every((k) => grouped.has(k))) return true; // still running somewhere
      if (!open.length && t.tickets.length) closed.push(t);
      return false; // closed, or its tickets now belong to another ladder (adopted)
    });

    for (const g of [...groups, ...unmanaged]) this.track(g, settings, bal, p);

    const tickets = new Set(pos.keys());
    const openedTickets = this.first ? [] : [...tickets].filter((k) => !this.lastTickets.has(k));
    const closedTickets = [...this.lastTickets].filter((k) => !tickets.has(k));
    this.lastTickets = tickets;
    this.first = false;

    return { snap: this.snapshot(p, groups, unmanaged, settings, ea), groups, unmanaged, closed, openedTickets, closedTickets, eaOn: !!ea, settings };
  }

  /** Journal data seen while the ladder is open. */
  private track(g: Group, s: EaSettings, balance: number, p: Poll) {
    const t = g.tracker;
    const ps = g.positions;
    for (const x of ps) if (!t.tickets.includes(x.ticket)) t.tickets.push(x.ticket);
    if (!ps.length) return;
    const dir = ps[0].dir;
    if (t.dir === null) {
      t.dir = dir;
      t.openTime = Math.min(...ps.map((x) => x.openTime));
      if (t.lotsMax === 0) t.balBefore = balance;
    }
    const d = DIRN(dir);
    const lots = ps.reduce((a, x) => a + x.lot, 0);
    t.lotsMax = Math.max(t.lotsMax, Math.round(lots * 100) / 100);
    const sl = g.ea ? (g.ea.sl > 0 ? g.ea.sl : null) : ps[ps.length - 1].sl;
    const stage = g.ea ? g.ea.stage : 0;
    if (stage >= 2 && t.stage < 2) t.s2Time = p.quote.time;
    const stageMoved = stage > t.stage;
    if (stage > t.stage) t.stage = stage;
    if (sl !== null && t.lastSL !== null && !this.same(sl, t.lastSL) && !stageMoved) {
      t.slEdits++;
      if (d * (sl - t.lastSL) < 0 && !(g.ea?.bePulled && !t.bePulled)) t.slWidened = true;
    }
    if (sl !== null) t.lastSL = sl;
    const risk = this.ifSLHits(ps);
    if (g.ea && g.ea.riskSeen) {
      t.firstSL = g.ea.firstSL || t.firstSL;
      t.risk1 = g.ea.risk1;
      t.riskMax = g.ea.riskMax;
    } else if (risk !== null) {
      if (t.firstSL === null) {
        t.firstSL = sl;
        t.risk1 = risk;
      }
      t.riskMax = t.riskMax === null ? risk : Math.min(t.riskMax, risk);
    }
    const avg = LiveState.average(ps);
    const be = this.N(avg + d * s.beBuf * s.pip);
    if (sl !== null && !this.better(dir, be, sl)) t.beApplied = true;
    if (g.ea?.bePulled) t.bePulled = true;
    // MFE / MAE from the worst entry ($ of price), MFE pips from the stage average
    const worst = ps.reduce((w, x) => (dir === 'sell' ? Math.min(w, x.openPrice) : Math.max(w, x.openPrice)), ps[0].openPrice);
    t.worst = worst;
    const close = dir === 'buy' ? p.quote.bid : p.quote.ask;
    const spread = p.quote.ask - p.quote.bid;
    const hi = p.range ? (dir === 'buy' ? p.range[1] : p.range[0] + spread) : close;
    const lo = p.range ? (dir === 'buy' ? p.range[0] : p.range[1] + spread) : close;
    const best = d * (hi - worst);
    const worstMv = d * (lo - worst);
    if (!t.moveSeen) {
      t.mfe = best;
      t.mae = worstMv;
      t.moveSeen = true;
    }
    t.mfe = Math.max(t.mfe, best);
    t.mae = Math.min(t.mae, worstMv);
    const sAvg = g.ea && g.ea.stage >= 2 && g.ea.anchor > 0 ? g.ea.anchor : avg;
    t.mfePips = Math.max(t.mfePips, Math.round(((d * (hi - sAvg)) / PIP) * 10) / 10);
  }

  private ticketView(x: LivePosition): TicketView {
    return { id: x.ticket, dir: x.dir, lot: x.lot, openPrice: x.openPrice, openTime: x.openTime, sl: x.sl, tp: x.tp, floating: x.profit };
  }

  private snapshot(p: Poll, groups: Group[], unmanaged: Group[], s: EaSettings, ea: Poll['ea']): EngineSnapshot {
    const q = p.quote;
    const bal = p.account.balance;
    const ladders: LadderView[] = groups.map((g) => {
      const t = g.tracker;
      const ps = g.positions;
      const tp = g.ea ? (g.ea.tp > 0 ? g.ea.tp : null) : (ps[ps.length - 1]?.tp ?? null);
      const sl = g.ea ? (g.ea.sl > 0 ? g.ea.sl : null) : (ps[ps.length - 1]?.sl ?? null);
      const base = {
        id: t.uid,
        rank: g.ea?.rank ?? t.rank,
        active: g.ea ? g.ea.current : false,
        stage: (g.ea?.stage ?? 0) as 0 | 2 | 3,
        pending: g.ea && g.ea.pending > 0 ? g.ea.pending : null,
        beApplied: t.beApplied,
        sl,
        tp,
        tags: t.tags,
        tickets: ps.map((x) => this.ticketView(x)),
      };
      if (!ps.length) {
        return {
          ...base,
          dir: null,
          ticketCount: 0,
          totalLot: 0,
          worstEntry: 0,
          avg: NaN,
          pips: 0,
          beText: '',
          beEnabled: false,
          bePullBack: false,
          stageText: 'empty - your next trades join this ladder',
          ifSLHits: null,
          ifSLHitsPct: null,
          ifClosedNow: 0,
          R: null,
          rr: null,
          mfePips: 0,
        };
      }
      const dir = ps[0].dir;
      const d = DIRN(dir);
      const liveAvg = LiveState.average(ps);
      const avg = g.ea && g.ea.stage >= 2 && g.ea.anchor > 0 ? g.ea.anchor : liveAvg;
      const pipsOf = (a: number) => (dir === 'buy' ? (q.bid - a) / PIP : (a - q.ask) / PIP);
      const pips = pipsOf(avg);
      const be = this.N(avg + d * s.beBuf * PIP);
      let beText: string;
      if (sl !== null && !this.better(dir, be, sl)) beText = 'BE done';
      else if (pips >= s.beMin - 1e-6) beText = 'BE allowed';
      else beText = `BE from ${this.px(this.N(avg + d * s.beMin * PIP))}`;
      const liveBE = this.N(liveAvg + d * s.beBuf * PIP);
      const beEnabled = pipsOf(liveAvg) >= s.beMin - 1e-6 && !(this.same(liveBE, sl) && ps.every((x) => this.same(x.sl, liveBE)));
      const bePullBack = beEnabled && this.better(dir, sl, liveBE);
      let stageText: string;
      const stage = g.ea?.stage ?? 0;
      if (!g.ea) stageText = 'EA not running - no automatic stages (attach GoldLadderManager s6)';
      else if (stage === 0) {
        const s2 = this.N(avg + d * s.s2l * PIP);
        stageText = `stage 2 at ${this.px(this.N(avg + d * s.s2t * PIP))} -> SL ${this.px(s2)} locks ${money(this.moneyAt(ps, s2))}`;
      } else if (stage === 2) {
        const s3 = this.N(g.ea.anchor + d * s.s3l * PIP);
        stageText = `STAGE 2 done | stage 3 at ${this.px(g.ea.next)} -> SL ${this.px(s3)} locks ${money(this.moneyAt(ps, s3))}`;
      } else stageText = 'STAGE 3 done | runner is yours - move the SL as you see fit';
      if (base.pending !== null) stageText += ` | waiting ${this.px(base.pending)}`;
      const risk = this.ifSLHits(ps);
      const now = Math.round(ps.reduce((a, x) => a + x.profit, 0) * 100) / 100;
      const rm = g.ea && g.ea.riskSeen ? g.ea.riskMax : t.riskMax;
      const R = rm !== null && rm < -0.005 ? -rm : null;
      return {
        ...base,
        dir,
        ticketCount: ps.length,
        totalLot: Math.round(ps.reduce((a, x) => a + x.lot, 0) * 100) / 100,
        worstEntry: t.worst,
        avg,
        pips,
        beText,
        beEnabled,
        bePullBack,
        stageText,
        ifSLHits: risk,
        ifSLHitsPct: risk !== null && risk < -0.005 && bal > 0 ? (-risk / bal) * 100 : null,
        ifClosedNow: now,
        R,
        rr: R ? now / R : null,
        mfePips: Number.isFinite(t.mfePips) ? t.mfePips : 0,
      };
    });
    const managed = groups.flatMap((g) => g.positions);
    const active = groups.find((g) => g.ea?.current);
    const why = !ea
      ? 'the EA is not running - attach GoldLadderManager v3.0-s6 to the chart (NEW LADDER is an EA button)'
      : ea.canNewLadder
        ? ''
        : ea.newLadderWhy;
    const a = p.account;
    return {
      time: q.time,
      bid: q.bid,
      ask: q.ask,
      balance: bal,
      equity: a.equity,
      margin: a.margin,
      freeMargin: a.margin_free,
      marginLevel: a.margin > 0 ? a.margin_level : null,
      blown: false,
      contractSize: this.contractSize,
      lotCap: ea ? ea.lotCap : p.lotCap,
      ladderCount: groups.length,
      ladders,
      activeLadderId: active?.tracker.uid ?? null,
      emptyLadder: !!active && active.positions.length === 0,
      canNewLadder: why === '',
      newLadderWhy: why,
      totalIfSLHits: this.ifSLHits(managed),
      unmanaged: unmanaged.flatMap((g) => g.positions.map((x) => this.ticketView(x))),
      pendingOrders: 0,
    };
  }

  /** Lots already in the ladder a new `dir` trade joins, and whether it would be unmanaged. */
  joinInfo(r: UpdateResult, dir: Dir): { lots: number; opposite: boolean; ladder: string } {
    if (r.eaOn) {
      const cur = r.groups.find((g) => g.ea?.current);
      if (!cur) return { lots: 0, opposite: false, ladder: 'a new ladder' };
      const side = cur.positions[0]?.dir ?? null;
      if (side && side !== dir) return { lots: 0, opposite: true, ladder: `L${cur.ea!.rank}` };
      return { lots: cur.positions.reduce((a, x) => a + x.lot, 0), opposite: false, ladder: `L${cur.ea!.rank}` };
    }
    const g = [...r.groups].reverse().find((x) => x.tracker.dir === dir);
    return { lots: g ? g.positions.reduce((a, x) => a + x.lot, 0) : 0, opposite: false, ladder: g ? `L${g.tracker.rank}` : 'a new ladder' };
  }
}
