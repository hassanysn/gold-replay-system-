// The two synced charts: HTF (M15/M30) on the left, M1 with trade lines on the right.
// Chart colours are grey/black on white only - no green or red anywhere on the charts.

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineStyle,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import type { Bar } from '../core/candles';
import type { EngineSnapshot } from '../core/engine';

export const CHART_COLORS = {
  up: '#a6a6a6',
  upBorder: '#6b6b6b',
  down: '#111111',
  avg: '#1559c1',
  sl: '#7b1fa2',
  tp: '#a05a00',
  ticket: '#6f6f6f',
  ask: '#b0b0b0',
  marker: '#1559c1',
  exit: '#333333',
};

function fmtServer(t: Time): string {
  const d = new Date((t as number) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export class ChartView {
  readonly chart: IChartApi;
  readonly series: ISeriesApi<'Candlestick'>;
  bars: Bar[] = [];
  tfSec: number;

  constructor(
    readonly el: HTMLElement,
    tfSec: number,
    digits: number,
  ) {
    this.tfSec = tfSec;
    this.chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#222222', fontSize: 11 },
      grid: { vertLines: { color: '#f1f1f1' }, horzLines: { color: '#f1f1f1' } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#777777', labelBackgroundColor: '#444444' },
        horzLine: { color: '#777777', labelBackgroundColor: '#444444' },
      },
      rightPriceScale: { borderColor: '#cccccc' },
      timeScale: { borderColor: '#cccccc', timeVisible: true, secondsVisible: false, rightOffset: 10, tickMarkFormatter: undefined },
      localization: { timeFormatter: fmtServer },
    });
    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up,
      downColor: CHART_COLORS.down,
      borderUpColor: CHART_COLORS.upBorder,
      borderDownColor: CHART_COLORS.down,
      wickUpColor: CHART_COLORS.upBorder,
      wickDownColor: CHART_COLORS.down,
      priceLineColor: '#555555',
      priceFormat: { type: 'price', precision: digits, minMove: 1 / 10 ** digits },
    });
  }

  setBars(bars: Bar[], tfSec: number) {
    this.tfSec = tfSec;
    this.bars = bars;
    this.series.setData(bars as never);
  }

  /** Applies a changed/new bar (bars arrive in time order). The shared bars array is updated by the caller. */
  update(bar: Bar) {
    this.series.update(bar as never);
  }

  // ---- coordinate helpers (fractional, also outside the data range) ----

  private spacing(): { x0: number; dx: number } | null {
    const ts = this.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0 as never);
    const x1 = ts.logicalToCoordinate(1 as never);
    if (x0 === null || x1 === null) return null;
    return { x0, dx: x1 - x0 };
  }

  /** Fractional bar index of an absolute time in ms. */
  timeToLogical(ms: number): number | null {
    const b = this.bars;
    if (!b.length) return null;
    const t = ms / 1000;
    if (t <= b[0].time) return (t - b[0].time) / this.tfSec;
    const last = b.length - 1;
    if (t >= b[last].time) return last + (t - b[last].time) / this.tfSec;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid].time <= t) lo = mid;
      else hi = mid;
    }
    const span = Math.min(b[hi].time - b[lo].time, this.tfSec);
    return lo + Math.min((t - b[lo].time) / span, 1);
  }

  logicalToTime(l: number): number {
    const b = this.bars;
    if (!b.length) return 0;
    const last = b.length - 1;
    if (l <= 0) return (b[0].time + l * this.tfSec) * 1000;
    if (l >= last) return (b[last].time + (l - last) * this.tfSec) * 1000;
    const i = Math.floor(l);
    const f = l - i;
    return (b[i].time + f * Math.min(b[i + 1].time - b[i].time, this.tfSec)) * 1000;
  }

  timeToX(ms: number): number | null {
    const l = this.timeToLogical(ms);
    const s = this.spacing();
    if (l === null || !s) return null;
    return s.x0 + l * s.dx;
  }

  xToTime(x: number): number | null {
    const s = this.spacing();
    if (!s || !this.bars.length || s.dx === 0) return null;
    return this.logicalToTime((x - s.x0) / s.dx);
  }

  priceToY(p: number): number | null {
    return this.series.priceToCoordinate(p);
  }

  yToPrice(y: number): number | null {
    return this.series.coordinateToPrice(y);
  }

  paneSize(): { width: number; height: number } {
    return { width: this.chart.timeScale().width(), height: this.chart.paneSize(0).height };
  }

  /** Open time (s) of the bar containing `sec`: the last bar opening at or before it; null before the first bar. */
  barAt(sec: number): number | null {
    const b = this.bars;
    let lo = 0;
    let hi = b.length - 1;
    if (hi < 0 || sec < b[0].time) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b[mid].time <= sec) lo = mid;
      else hi = mid - 1;
    }
    return b[lo].time;
  }

  /** x of the boundary right after the candle that ends at `endMs` (half a bar right of its centre). */
  cutX(endMs: number): number | null {
    const s = this.spacing();
    const l = this.timeToLogical(endMs - this.tfSec * 1000);
    if (!s || l === null) return null;
    return s.x0 + (l + 0.5) * s.dx;
  }

  /** Bar index whose bar contains `ms` (or the nearest following bar). */
  barTimeAtOrAfter(sec: number): number | null {
    const b = this.bars;
    let lo = 0;
    let hi = b.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid].time < sec) lo = mid + 1;
      else hi = mid;
    }
    return lo < b.length ? b[lo].time : b.length ? b[b.length - 1].time : null;
  }

  scrollToNow() {
    this.chart.timeScale().scrollToRealTime();
  }
}

/** Mirrors the crosshair between the HTF and M1 charts. Zoom and scroll stay independent: only the
 *  replay time (and the Now / End key) moves both charts. */
export function syncCharts(a: ChartView, b: ChartView) {
  let syncing = false;
  const crosshair = (from: ChartView, to: ChartView) => {
    from.chart.subscribeCrosshairMove((p) => {
      if (syncing) return;
      syncing = true;
      try {
        if (!p.time || !p.point) {
          to.chart.clearCrosshairPosition();
          return;
        }
        const price = from.series.coordinateToPrice(p.point.y);
        const sec = p.time as number;
        const t = to.tfSec >= from.tfSec ? Math.floor(sec / to.tfSec) * to.tfSec : to.barTimeAtOrAfter(sec);
        if (price !== null && t !== null) to.chart.setCrosshairPosition(price, t as Time, to.series);
      } finally {
        syncing = false;
      }
    });
  };
  crosshair(a, b);
  crosshair(b, a);
}

type LineKind = 'avg' | 'sl' | 'tp' | 'ticket' | 'ask';

export interface TradeLineHit {
  ladderId: number;
  kind: 'avg' | 'sl' | 'tp';
  price: number;
}

/** Average entry, SL, TP and ticket lines plus fill/exit markers on the M1 chart. */
export class TradeLines {
  private lines = new Map<string, { line: IPriceLine; kind: LineKind; ladderId: number; price: number; title: string }>();
  private markers: ISeriesMarkersPluginApi<Time>;
  private markerList: SeriesMarker<Time>[] = [];
  /** Ladder/kind being dragged: its line follows the mouse instead of the engine value. */
  dragging: { ladderId: number; kind: 'avg' | 'sl' | 'tp'; price: number } | null = null;

  constructor(private view: ChartView) {
    this.markers = createSeriesMarkers(view.series, []);
  }

  private upsert(key: string, kind: LineKind, ladderId: number, price: number, title: string) {
    const style = {
      avg: { color: CHART_COLORS.avg, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true },
      sl: { color: CHART_COLORS.sl, lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true },
      tp: { color: CHART_COLORS.tp, lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true },
      ticket: { color: CHART_COLORS.ticket, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false },
      ask: { color: CHART_COLORS.ask, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true },
    }[kind];
    const existing = this.lines.get(key);
    if (existing) {
      if (existing.price !== price || existing.title !== title) existing.line.applyOptions({ price, title });
      existing.price = price;
      existing.title = title;
      return;
    }
    const line = this.view.series.createPriceLine({ price, title, ...style } as never);
    this.lines.set(key, { line, kind, ladderId, price, title });
  }

  update(snap: EngineSnapshot) {
    const seen = new Set<string>();
    const put = (key: string, kind: LineKind, ladderId: number, price: number | null, title: string) => {
      if (price === null || !Number.isFinite(price)) return;
      seen.add(key);
      this.upsert(key, kind, ladderId, price, title);
    };
    if (Number.isFinite(snap.ask)) put('ask', 'ask', 0, snap.ask, 'ask');
    // Ladder lines (master SL/TP). Unmanaged opposite tickets use ladderId = -ticketId.
    const groups = [
      ...snap.ladders.filter((l) => l.dir && l.ticketCount > 0).map((l) => ({ id: l.id, name: `L${l.rank}`, dir: l.dir!, avg: l.avg, sl: l.sl, tp: l.tp, tickets: l.tickets })),
      ...snap.unmanaged.map((t) => ({ id: -t.id, name: `#${t.id}`, dir: t.dir, avg: t.openPrice, sl: t.sl, tp: t.tp, tickets: [] })),
    ];
    for (const g of groups) {
      const d = this.dragging && this.dragging.ladderId === g.id ? this.dragging : null;
      const n = g.tickets.length;
      put(`${g.id}:avg`, 'avg', g.id, g.avg, g.id < 0 ? `${g.name} ${g.dir}` : `${g.name}: ${n} trade${n === 1 ? '' : 's'}`);
      put(`${g.id}:sl`, 'sl', g.id, d?.kind === 'sl' ? d.price : g.sl, `${g.name} SL`);
      put(`${g.id}:tp`, 'tp', g.id, d?.kind === 'tp' ? d.price : g.tp, `${g.name} TP`);
      if (d?.kind === 'avg') put(`${g.id}:new`, d.price < g.avg === (g.dir === 'buy') ? 'sl' : 'tp', g.id, d.price, `${g.name} new`);
      for (const t of g.tickets) put(`t${t.id}`, 'ticket', g.id, t.openPrice, '');
    }
    for (const [key, v] of this.lines) {
      if (!seen.has(key)) {
        this.view.series.removePriceLine(v.line);
        this.lines.delete(key);
      }
    }
  }

  /** Line of an open ladder within `tol` px of y (SL/TP take priority over the average line). */
  hitTest(y: number, tol = 5): TradeLineHit | null {
    let best: TradeLineHit | null = null;
    let bestD = tol + 1;
    for (const v of this.lines.values()) {
      if (v.kind !== 'avg' && v.kind !== 'sl' && v.kind !== 'tp') continue;
      const ly = this.view.priceToY(v.price);
      if (ly === null) continue;
      const d = Math.abs(ly - y) - (v.kind === 'avg' ? 0 : 0.5);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = { ladderId: v.ladderId, kind: v.kind, price: v.price };
      }
    }
    return best;
  }

  addMarker(m: SeriesMarker<Time>) {
    this.markerList.push(m);
    this.markerList.sort((a, b) => (a.time as number) - (b.time as number));
    this.markers.setMarkers(this.markerList);
  }

  clearMarkers() {
    this.markerList = [];
    this.markers.setMarkers([]);
  }

  clearLines() {
    for (const v of this.lines.values()) this.view.series.removePriceLine(v.line);
    this.lines.clear();
  }
}
