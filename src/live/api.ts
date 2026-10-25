// HTTP client for live/bridge.py (127.0.0.1 only). Every call carries the X-Gold-Replay header the
// bridge requires, so no other web page can drive the terminal.

import type { Bar, TfName } from '../core/candles';

export interface LiveInit {
  symbol: string;
  digits: number;
  point: number;
  contractSize: number;
  stopsLevel: number;
  volumeMin: number;
  volumeStep: number;
  account: { login: number; server: string; name: string; currency: string; mode: 'DEMO' | 'CONTEST' | 'REAL'; leverage: number };
  tradeAllowed: boolean;
  commonFiles: string;
  fake: boolean;
  time: number;
}

export interface LivePosition {
  ticket: number;
  dir: 'buy' | 'sell';
  lot: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  /** Profit + swap in account currency, as MT5 shows it. */
  profit: number;
  magic: number;
}

/** One ladder of the EA state file (GLM_state_<symbol>.json, written by GoldLadderManager s6). */
export interface EaLadder {
  id: number;
  rank: number;
  /** 0 buy, 1 sell, -1 empty */
  side: number;
  stage: 0 | 2 | 3;
  anchor: number;
  next: number;
  pending: number;
  sl: number;
  tp: number;
  riskSeen: boolean;
  riskMax: number;
  firstSL: number;
  risk1: number;
  bePulled: boolean;
  start: number;
  current: boolean;
  tickets: number[];
}

export interface EaSettings {
  beMin: number;
  beBuf: number;
  s2t: number;
  s2l: number;
  s3t: number;
  s3l: number;
  pip: number;
}

export interface EaState {
  version: string;
  symbol: string;
  time: number;
  lotCap: number;
  canNewLadder: boolean;
  newLadderWhy: string;
  cmd: { seq: number; ok: boolean; msg: string };
  settings: EaSettings;
  ladders: EaLadder[];
  /** Seconds since the EA wrote the file; running = written in the last 5 s. */
  age: number;
  running: boolean;
}

export interface LiveAccount {
  balance: number;
  equity: number;
  margin: number;
  margin_free: number;
  margin_level: number;
  profit: number;
}

export interface Poll {
  quote: { time: number; bid: number; ask: number };
  bars: Record<TfName, Bar[]>;
  positions: LivePosition[];
  ea: EaState | null;
  tradeAllowed: boolean;
  account: LiveAccount;
  lotCap: number;
  /** Bid low/high of every tick since the previous poll. */
  range?: [number, number];
}

export interface Deal {
  ticket: number;
  position: number;
  time: number;
  entry: 'in' | 'out' | 'inout';
  dir: 'buy' | 'sell';
  lot: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  fee: number;
  /** MT5 DEAL_REASON: 0 client, 1 mobile, 2 web, 3 expert, 4 SL, 5 TP, 6 stop-out */
  reason: number;
}

export interface TradeResult {
  ok: boolean;
  retcode?: number;
  comment: string;
  results?: { ticket: number; ok: boolean; retcode?: number; comment: string }[];
  seq?: number;
}

const HEADERS = { 'X-Gold-Replay': 'live' };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? HEADERS : { ...HEADERS, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  init: () => call<LiveInit>('/api/live/init'),
  rates: (tf: TfName, count: number) => call<{ bars: Bar[] }>(`/api/live/rates?tf=${tf}&count=${count}`),
  poll: (since: number) => call<Poll>(`/api/live/poll?since=${since}`),
  range: (from: number, to: number) => call<{ high: number | null; low: number | null; last: number | null }>(`/api/live/range?from=${from}&to=${to}`),
  order: (dir: 'buy' | 'sell', lot: number) => call<TradeResult>('/api/live/order', { dir, lot }),
  close: (tickets: number[]) => call<TradeResult>('/api/live/close', { tickets }),
  modify: (items: { ticket: number; sl?: number | null; tp?: number | null }[]) => call<TradeResult>('/api/live/modify', { items }),
  ea: (action: 'newLadder' | 'moveToBE', ladderId = 0) => call<TradeResult>('/api/live/ea', { action, ladderId }),
  deals: (tickets: number[]) => call<{ deals: Deal[] }>('/api/live/deals', { tickets }),
};

/** First failing ticket's broker message, for a toast. */
export function resultText(r: TradeResult): string {
  const bad = r.results?.find((x) => !x.ok);
  if (bad) return `#${bad.ticket}: ${bad.comment}${bad.retcode ? ` (${bad.retcode})` : ''}`;
  return `${r.comment}${r.retcode ? ` (${r.retcode})` : ''}`;
}
