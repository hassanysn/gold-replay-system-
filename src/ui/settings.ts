import { type AccountSettings, DEFAULT_ACCOUNT } from '../core/engine';
import * as db from './db';

export interface AppSettings {
  account: AccountSettings;
  speedLock: boolean;
  /** Broker server UTC offset in hours. Display only; all times stay in server time. */
  serverUtcOffset: number;
  htf: 'M15' | 'M30';
  lot: number;
  /** Balances of the 1-3 real accounts traded together (their sum is the war account balance). */
  accountBalances: number[];
  /** Trade open / close / zone alert sounds. */
  sound: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  account: { ...DEFAULT_ACCOUNT },
  speedLock: true,
  serverUtcOffset: 2,
  htf: 'M15',
  lot: 0.01,
  accountBalances: [50],
  sound: true,
};

/** Persistent war-account state (survives reloads; reset by "New war account"). */
export interface AccountState {
  balance: number;
  blown: boolean;
  /** Accounts combined in the balance (1-3). */
  accounts: number;
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
  const a = await db.get<AccountState>('kv', 'account').catch(() => undefined);
  return a ? { ...a, accounts: a.accounts ?? 1 } : { balance: s.account.startBalance, blown: false, accounts: s.accountBalances.length };
}

export function saveAccountState(a: AccountState): Promise<void> {
  return db.put('kv', a, 'account');
}
