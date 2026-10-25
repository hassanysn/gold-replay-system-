import { type AccountSettings, DEFAULT_ACCOUNT } from '../core/engine';
import * as db from './db';

export interface AppSettings {
  account: AccountSettings;
  speedLock: boolean;
  /** Broker server UTC offset in hours. Display only; all times stay in server time. */
  serverUtcOffset: number;
  htf: 'M15' | 'M30';
  lot: number;
  /** Trade open / close / zone alert sounds. */
  sound: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  account: { ...DEFAULT_ACCOUNT },
  speedLock: true,
  serverUtcOffset: 2,
  htf: 'M15',
  lot: 0.01,
  sound: true,
};

/** Persistent war-account state (survives reloads; reset by "New war account"). */
export interface AccountState {
  balance: number;
  blown: boolean;
}

export async function loadSettings(): Promise<AppSettings> {
  const s = await db.get<Partial<AppSettings>>('kv', 'settings').catch(() => undefined);
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    account: { ...DEFAULT_SETTINGS.account, ...s?.account },
  };
}

export function saveSettings(s: AppSettings): Promise<void> {
  return db.put('kv', s, 'settings');
}

export async function loadAccountState(s: AppSettings): Promise<AccountState> {
  return (await db.get<AccountState>('kv', 'account').catch(() => undefined)) ?? { balance: s.account.startBalance, blown: false };
}

export function saveAccountState(a: AccountState): Promise<void> {
  return db.put('kv', a, 'account');
}
