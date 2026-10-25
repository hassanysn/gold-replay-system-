// Messages between the UI thread and the simulation worker.

import type { Bar, TfName } from '../core/candles';
import type { Manifest } from '../core/daydata';
import type { AccountSettings, EngineSnapshot, JournalRecord, SetupTags } from '../core/engine';
import type { Dir } from '../core/pips';
import type { Zone } from '../core/replay';

export const SPEEDS = [1, 2, 5, 10, 60] as const;
/** Speeds allowed while a ladder is open and the speed lock is on. */
export const LOCKED_SPEEDS = [1, 2];
/** Trading days of history loaded before the start point (for HTF context). */
export const HISTORY_DAYS = 5;

export interface PostCloseScan {
  entryId: string;
  dir: Dir;
  avg: number;
  /** Scan ticks with from <= time <= until. */
  from: number;
  until: number;
  max: number | null;
}

export type ToWorker =
  | { type: 'init'; dataUrl: string }
  | {
      type: 'load';
      date: string;
      time: string; // HH:MM or HH:MM:SS
      account: AccountSettings;
      balance: number;
      blown: boolean;
      speedLock: boolean;
      zones: Zone[];
    }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; speed: number }
  | { type: 'step'; tf: 'M1' | 'M15' }
  | { type: 'order'; dir: Dir; lot: number }
  | { type: 'setSL'; ladderId: number; price: number | null }
  | { type: 'setTP'; ladderId: number; price: number | null }
  | { type: 'be'; ladderId: number }
  | { type: 'closeLadder'; ladderId: number }
  | { type: 'closeAll' }
  | { type: 'newLadder' }
  | { type: 'setTicketSL'; ticketId: number; price: number | null }
  | { type: 'setTicketTP'; ticketId: number; price: number | null }
  | { type: 'closeTicket'; ticketId: number }
  | { type: 'setTags'; ladderId: number; tags: SetupTags }
  | { type: 'newWarAccount'; account: AccountSettings }
  | { type: 'settings'; account: AccountSettings; speedLock: boolean }
  | { type: 'zones'; zones: Zone[] }
  | { type: 'finalizePostClose'; items: PostCloseScan[] };

export interface UiEvent {
  type: 'fill' | 'close' | 'sl' | 'tp' | 'stage' | 'zone' | 'stopout';
  time: number;
  dir?: Dir;
  price?: number;
  lot?: number;
  ticketId?: number;
  ladderId?: number | null;
}

export interface Frame {
  clock: number;
  playing: boolean;
  speed: number;
  ended: boolean;
  /** Changed or new bars per timeframe since the previous frame. */
  bars: Partial<Record<TfName, Bar[]>>;
  snap: EngineSnapshot;
  events: UiEvent[];
}

export type FromWorker =
  | { type: 'manifest'; manifest: Manifest }
  | { type: 'error'; message: string }
  | { type: 'status'; text: string }
  | { type: 'loaded'; date: string; historyFrom: string; bars: Record<TfName, Bar[]>; frame: Frame }
  | { type: 'frame'; frame: Frame }
  | { type: 'journal'; record: JournalRecord }
  | { type: 'postClose'; entryId: string; pips: number | null; done: boolean }
  | { type: 'notice'; text: string; level: 'info' | 'warn' | 'pause' };
