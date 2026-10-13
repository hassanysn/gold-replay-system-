// Gold pip math. 1 pip = 0.10 price. 1.00 lot = 100 oz -> $10 per pip; 0.10 lot -> $1 per pip.

export type Dir = 'buy' | 'sell';

export const PIP = 0.1;

/** Removes float noise so that e.g. exactly +30.0 pips compares as >= 30. */
export function clean(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function roundPrice(price: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(price * f) / f;
}

/** Profit-direction pips of the current quote relative to `ref` (buy: bid - ref, sell: ref - ask). */
export function pipsFrom(dir: Dir, ref: number, bid: number, ask: number): number {
  return clean((dir === 'buy' ? bid - ref : ref - ask) / PIP);
}

/** "ref + X pips" in the profit direction (buy: ref + X*0.10, sell: ref - X*0.10). */
export function priceAtPips(dir: Dir, ref: number, pips: number): number {
  return dir === 'buy' ? ref + pips * PIP : ref - pips * PIP;
}

/** Profit-direction pip distance between two prices (buy: to - from, sell: from - to). */
export function pipsBetween(dir: Dir, from: number, to: number): number {
  return clean((dir === 'buy' ? to - from : from - to) / PIP);
}

/** P/L in $ of closing `lot` opened at `open` at price `close`. */
export function profit(dir: Dir, lot: number, open: number, close: number, contractSize: number): number {
  return (dir === 'buy' ? close - open : open - close) * lot * contractSize;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function weightedAverage(items: readonly { lot: number; price: number }[]): number {
  let lots = 0;
  let sum = 0;
  for (const it of items) {
    lots += it.lot;
    sum += it.lot * it.price;
  }
  return lots > 0 ? sum / lots : NaN;
}
