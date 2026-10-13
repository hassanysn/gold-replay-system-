// Candles built live from ticks, bid based (MT5 style).

export interface Bar {
  /** Bar open time, seconds (server time shown as UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type TfName = 'M1' | 'M15' | 'M30';
export const TF_MS: Record<TfName, number> = { M1: 60_000, M15: 900_000, M30: 1_800_000 };
export const TF_NAMES: TfName[] = ['M1', 'M15', 'M30'];

export class CandleBuilder {
  readonly bars: Bar[] = [];
  private dirtyFrom = Infinity;

  constructor(readonly tfMs: number) {}

  add(absMs: number, price: number): void {
    const t = Math.floor(absMs / this.tfMs) * (this.tfMs / 1000);
    const last = this.bars[this.bars.length - 1];
    if (last && last.time === t) {
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      last.close = price;
      if (this.bars.length - 1 < this.dirtyFrom) this.dirtyFrom = this.bars.length - 1;
    } else {
      this.bars.push({ time: t, open: price, high: price, low: price, close: price });
      if (this.bars.length - 1 < this.dirtyFrom) this.dirtyFrom = this.bars.length - 1;
    }
  }

  /** Bars changed or added since the last call (copies, oldest first). */
  takeDirty(): Bar[] {
    if (this.dirtyFrom === Infinity) return [];
    const out = this.bars.slice(this.dirtyFrom).map((b) => ({ ...b }));
    this.dirtyFrom = Infinity;
    return out;
  }

  clearDirty(): void {
    this.dirtyFrom = Infinity;
  }
}
