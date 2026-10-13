// Drawing tools: rectangle (zones), horizontal line, text label. Select, move, resize, delete.
// One shared store; every chart renders it through a series primitive using absolute time/price,
// so a drawing made on the HTF chart also shows on M1.

import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitiveHoveredItem, Time } from 'lightweight-charts';
import type { Zone } from '../core/replay';
import type { ChartView, TradeLineHit, TradeLines } from './charts';

interface Base {
  id: string;
  /** Replay date the drawing was made on (YYYY-MM-DD); used for per-day saving and to hide future drawings. */
  day: string;
}
export interface RectDrawing extends Base {
  kind: 'rect';
  t1: number;
  t2: number;
  p1: number;
  p2: number;
  extendRight: boolean;
}
export interface HLineDrawing extends Base {
  kind: 'hline';
  price: number;
}
export interface TextDrawing extends Base {
  kind: 'text';
  t: number;
  p: number;
  text: string;
}
export type Drawing = RectDrawing | HLineDrawing | TextDrawing;
export type Tool = 'select' | 'rect' | 'hline' | 'text';

const COL = {
  rectFill: 'rgba(60, 100, 190, 0.13)',
  rectStroke: 'rgba(60, 100, 190, 0.85)',
  line: '#3c64be',
  text: '#1d2a44',
  handle: '#ffffff',
  sel: '#1d2a44',
};

export function zonesOf(items: readonly Drawing[]): Zone[] {
  return items
    .filter((d): d is RectDrawing => d.kind === 'rect')
    .map((r) => ({
      id: r.id,
      t1: Math.min(r.t1, r.t2),
      t2: Math.max(r.t1, r.t2),
      low: Math.min(r.p1, r.p2),
      high: Math.max(r.p1, r.p2),
      extendRight: r.extendRight,
    }));
}

export class DrawingStore {
  items: Drawing[] = [];
  selectedId: string | null = null;
  tool: Tool = 'select';
  private listeners: ((persist: Drawing | null, removed?: string) => void)[] = [];

  onChange(fn: (persist: Drawing | null, removed?: string) => void) {
    this.listeners.push(fn);
  }

  /** `persist` = drawing to save; null for a visual-only change (selection, live drag). */
  changed(persist: Drawing | null = null, removed?: string) {
    for (const fn of this.listeners) fn(persist, removed);
  }

  setAll(items: Drawing[]) {
    this.items = items;
    this.selectedId = null;
    this.changed();
  }

  add(d: Drawing) {
    this.items.push(d);
    this.selectedId = d.id;
    this.changed(d);
  }

  remove(id: string) {
    this.items = this.items.filter((d) => d.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.changed(null, id);
  }

  selected(): Drawing | null {
    return this.items.find((d) => d.id === this.selectedId) ?? null;
  }

  select(id: string | null) {
    if (this.selectedId !== id) {
      this.selectedId = id;
      this.changed();
    }
  }

  setTool(t: Tool) {
    this.tool = t;
    this.changed();
  }
}

// ------------------------------------------------------------------ geometry

interface RectPx {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

type Handle = 'tl' | 'tr' | 'bl' | 'br';

function rectPx(v: ChartView, r: RectDrawing, paneWidth: number): RectPx | null {
  const xa = v.timeToX(r.t1);
  const xb = v.timeToX(r.t2);
  const ya = v.priceToY(r.p1);
  const yb = v.priceToY(r.p2);
  if (xa === null || xb === null || ya === null || yb === null) return null;
  const x1 = Math.min(xa, xb);
  const x2 = r.extendRight ? Math.max(paneWidth, Math.max(xa, xb)) : Math.max(xa, xb);
  return { x1, x2, y1: Math.min(ya, yb), y2: Math.max(ya, yb) };
}

function textBox(ctx: CanvasRenderingContext2D | null, d: TextDrawing, x: number, y: number) {
  const w = ctx ? ctx.measureText(d.text).width : d.text.length * 7;
  return { x1: x - 2, x2: x + w + 2, y1: y - 14, y2: y + 3 };
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(): CanvasRenderingContext2D | null {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    if (measureCtx) measureCtx.font = '12px system-ui, sans-serif';
  }
  return measureCtx;
}

// ------------------------------------------------------------------ rendering primitive

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private p: DrawingsPrimitive) {}

  draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]) {
    const { view, store } = this.p;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = '12px system-ui, sans-serif';
      for (const d of store.items) {
        const sel = d.id === store.selectedId;
        if (d.kind === 'rect') {
          const r = rectPx(view, d, mediaSize.width);
          if (!r) continue;
          ctx.fillStyle = COL.rectFill;
          ctx.fillRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
          ctx.strokeStyle = sel ? COL.sel : COL.rectStroke;
          ctx.lineWidth = sel ? 1.5 : 1;
          ctx.strokeRect(r.x1 + 0.5, r.y1 + 0.5, r.x2 - r.x1, r.y2 - r.y1);
          if (sel) {
            const xb = d.extendRight ? Math.max(view.timeToX(d.t1) ?? 0, view.timeToX(d.t2) ?? 0) : r.x2;
            for (const [hx, hy] of [
              [r.x1, r.y1],
              [xb, r.y1],
              [r.x1, r.y2],
              [xb, r.y2],
            ]) {
              ctx.fillStyle = COL.handle;
              ctx.fillRect(hx - 4, hy - 4, 8, 8);
              ctx.strokeStyle = COL.sel;
              ctx.strokeRect(hx - 4 + 0.5, hy - 4 + 0.5, 8, 8);
            }
          }
        } else if (d.kind === 'hline') {
          const y = view.priceToY(d.price);
          if (y === null) continue;
          ctx.strokeStyle = sel ? COL.sel : COL.line;
          ctx.lineWidth = sel ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(mediaSize.width, Math.round(y) + 0.5);
          ctx.stroke();
        } else {
          const x = view.timeToX(d.t);
          const y = view.priceToY(d.p);
          if (x === null || y === null) continue;
          ctx.fillStyle = COL.text;
          ctx.fillText(d.text, x, y);
          if (sel) {
            const b = textBox(ctx, d, x, y);
            ctx.strokeStyle = COL.sel;
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(b.x1 + 0.5, b.y1 + 0.5, b.x2 - b.x1, b.y2 - b.y1);
            ctx.setLineDash([]);
          }
        }
      }
      ctx.restore();
    });
  }
}

class DrawingsPaneView implements IPrimitivePaneView {
  private r: DrawingsRenderer;
  constructor(p: DrawingsPrimitive) {
    this.r = new DrawingsRenderer(p);
  }
  renderer() {
    return this.r;
  }
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private views: DrawingsPaneView[];
  private requestUpdate: (() => void) | null = null;

  constructor(
    readonly view: ChartView,
    readonly store: DrawingStore,
    private interaction: () => Interaction | null,
  ) {
    this.views = [new DrawingsPaneView(this)];
  }

  attached(param: { requestUpdate: () => void }) {
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.requestUpdate = null;
  }

  paneViews() {
    return this.views;
  }

  redraw() {
    this.requestUpdate?.();
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const cursor = this.interaction()?.cursorAt(x, y);
    return cursor ? { cursorStyle: cursor, externalId: 'drawing', zOrder: 'top' } : null;
  }
}

// ------------------------------------------------------------------ interaction

type Drag =
  | { type: 'create'; id: string }
  | { type: 'move'; id: string; x0: number; y0: number; orig: Drawing }
  | { type: 'resize'; id: string; handle: Handle }
  | { type: 'trade'; hit: TradeLineHit };

export interface InteractionOptions {
  /** M1 chart only: draggable trade lines. */
  tradeLines?: TradeLines;
  onTradeDrag?: (hit: TradeLineHit, price: number, done: boolean) => void;
  currentDay: () => string;
  onToolDone: () => void;
}

let idCounter = 0;
function newId(): string {
  return `d${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export class Interaction {
  private drag: Drag | null = null;

  constructor(
    private view: ChartView,
    private store: DrawingStore,
    private opts: InteractionOptions,
  ) {
    const el = view.el;
    el.addEventListener('mousedown', (e) => this.onDown(e), true);
    el.addEventListener('dblclick', (e) => this.onDblClick(e), true);
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
  }

  private local(e: MouseEvent): { x: number; y: number; inPane: boolean } {
    const r = this.view.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const s = this.view.paneSize();
    return { x, y, inPane: x >= 0 && y >= 0 && x <= s.width && y <= s.height };
  }

  private hit(x: number, y: number): { d: Drawing; handle?: Handle } | null {
    const s = this.view.paneSize();
    const sel = this.store.selected();
    if (sel && sel.kind === 'rect') {
      const r = rectPx(this.view, sel, s.width);
      if (r) {
        const xb = sel.extendRight ? Math.max(this.view.timeToX(sel.t1) ?? 0, this.view.timeToX(sel.t2) ?? 0) : r.x2;
        const hs: [Handle, number, number][] = [
          ['tl', r.x1, r.y1],
          ['tr', xb, r.y1],
          ['bl', r.x1, r.y2],
          ['br', xb, r.y2],
        ];
        for (const [h, hx, hy] of hs) if (Math.abs(x - hx) <= 6 && Math.abs(y - hy) <= 6) return { d: sel, handle: h };
      }
    }
    for (let i = this.store.items.length - 1; i >= 0; i--) {
      const d = this.store.items[i];
      if (d.kind === 'hline') {
        const ly = this.view.priceToY(d.price);
        if (ly !== null && Math.abs(ly - y) <= 4) return { d };
      } else if (d.kind === 'text') {
        const tx = this.view.timeToX(d.t);
        const ty = this.view.priceToY(d.p);
        if (tx === null || ty === null) continue;
        const b = textBox(measure(), d, tx, ty);
        if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) return { d };
      } else {
        const r = rectPx(this.view, d, s.width);
        if (r && x >= r.x1 - 3 && x <= r.x2 + 3 && y >= r.y1 - 3 && y <= r.y2 + 3) return { d };
      }
    }
    return null;
  }

  cursorAt(x: number, y: number): string | null {
    if (this.drag) return this.drag.type === 'trade' ? 'ns-resize' : this.drag.type === 'move' ? 'move' : 'crosshair';
    if (this.store.tool !== 'select') return 'crosshair';
    if (this.opts.tradeLines?.hitTest(y)) return 'ns-resize';
    const h = this.hit(x, y);
    if (!h) return null;
    if (h.handle) return h.handle === 'tl' || h.handle === 'br' ? 'nwse-resize' : 'nesw-resize';
    return h.d.kind === 'hline' ? 'ns-resize' : 'move';
  }

  private take(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const { x, y, inPane } = this.local(e);
    if (!inPane) return;
    const t = this.view.xToTime(x);
    const p = this.view.yToPrice(y);
    if (t === null || p === null) return;
    const day = this.opts.currentDay();
    const tool = this.store.tool;
    if (tool === 'rect') {
      this.take(e);
      const d: RectDrawing = { id: newId(), day, kind: 'rect', t1: t, t2: t, p1: p, p2: p, extendRight: true };
      this.store.items.push(d);
      this.store.selectedId = d.id;
      this.drag = { type: 'create', id: d.id };
      this.store.changed();
      return;
    }
    if (tool === 'hline') {
      this.take(e);
      this.store.add({ id: newId(), day, kind: 'hline', price: p });
      this.opts.onToolDone();
      return;
    }
    if (tool === 'text') {
      this.take(e);
      const text = window.prompt('Label text');
      if (text) this.store.add({ id: newId(), day, kind: 'text', t, p, text });
      this.opts.onToolDone();
      return;
    }
    const th = this.opts.tradeLines?.hitTest(y);
    if (th) {
      this.take(e);
      this.drag = { type: 'trade', hit: th };
      this.opts.onTradeDrag?.(th, th.price, false);
      return;
    }
    const h = this.hit(x, y);
    if (h) {
      this.take(e);
      this.store.select(h.d.id);
      this.drag = h.handle ? { type: 'resize', id: h.d.id, handle: h.handle } : { type: 'move', id: h.d.id, x0: x, y0: y, orig: { ...h.d } };
      return;
    }
    this.store.select(null);
  }

  private onMove(e: MouseEvent) {
    const drag = this.drag;
    if (!drag) return;
    const { x, y } = this.local(e);
    const t = this.view.xToTime(x);
    const p = this.view.yToPrice(y);
    if (t === null || p === null) return;
    if (drag.type === 'trade') {
      this.opts.onTradeDrag?.(drag.hit, p, false);
      return;
    }
    const d = this.store.items.find((it) => it.id === drag.id);
    if (!d) return;
    if (drag.type === 'create' && d.kind === 'rect') {
      d.t2 = t;
      d.p2 = p;
    } else if (drag.type === 'resize' && d.kind === 'rect') {
      // Normalise so t1/p1 is the left/top corner, then move the grabbed corner.
      const left = Math.min(d.t1, d.t2);
      const right = Math.max(d.t1, d.t2);
      const top = Math.max(d.p1, d.p2);
      const bottom = Math.min(d.p1, d.p2);
      const h = drag.handle;
      d.t1 = h === 'tl' || h === 'bl' ? t : left;
      d.t2 = h === 'tl' || h === 'bl' ? right : t;
      d.p1 = h === 'tl' || h === 'tr' ? p : top;
      d.p2 = h === 'tl' || h === 'tr' ? bottom : p;
    } else if (drag.type === 'move') {
      const o = drag.orig;
      const t0 = this.view.xToTime(drag.x0);
      const pr0 = this.view.yToPrice(drag.y0);
      if (t0 === null || pr0 === null) return;
      const dt = t - t0;
      const dp = p - pr0;
      if (d.kind === 'rect' && o.kind === 'rect') {
        d.t1 = o.t1 + dt;
        d.t2 = o.t2 + dt;
        d.p1 = o.p1 + dp;
        d.p2 = o.p2 + dp;
      } else if (d.kind === 'hline' && o.kind === 'hline') {
        d.price = o.price + dp;
      } else if (d.kind === 'text' && o.kind === 'text') {
        d.t = o.t + dt;
        d.p = o.p + dp;
      }
    }
    this.store.changed();
  }

  private onUp(e: MouseEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.type === 'trade') {
      const { y } = this.local(e);
      const p = this.view.yToPrice(y);
      this.opts.onTradeDrag?.(drag.hit, p ?? drag.hit.price, true);
      return;
    }
    const d = this.store.items.find((it) => it.id === drag.id);
    if (!d) return;
    if (drag.type === 'create' && d.kind === 'rect') {
      const a = this.view.timeToX(d.t1);
      const b = this.view.timeToX(d.t2);
      const ya = this.view.priceToY(d.p1);
      const yb = this.view.priceToY(d.p2);
      if (a !== null && b !== null && ya !== null && yb !== null && Math.abs(a - b) < 3 && Math.abs(ya - yb) < 3) {
        this.store.remove(d.id); // a click without a drag makes no rectangle
        return;
      }
      this.opts.onToolDone();
    }
    this.store.changed(d);
  }

  private onDblClick(e: MouseEvent) {
    if (this.store.tool !== 'select') return;
    const { x, y, inPane } = this.local(e);
    if (!inPane) return;
    const h = this.hit(x, y);
    if (h && h.d.kind === 'text') {
      this.take(e);
      const text = window.prompt('Label text', h.d.text);
      if (text) {
        h.d.text = text;
        this.store.changed(h.d);
      }
    }
  }
}
