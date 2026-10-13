// Movable Ticket Manager panel (mirrors the MT5 Ticket Manager v3). Keeps its own colours.

import type { EngineSnapshot, LadderKind, LadderView } from '../core/engine';
import type { Dir } from '../core/pips';

export interface PanelActions {
  order(dir: Dir, lot: number): void;
  setSL(ladderId: number, price: number | null): void;
  setTP(ladderId: number, price: number | null): void;
  be(ladderId: number): void;
  closeLadder(ladderId: number): void;
  closeAll(): void;
  newLadder(): void;
  cancelNewLadder(): void;
  setKind(ladderId: number, kind: LadderKind): void;
  newWarAccount(): void;
  lotChanged(lot: number): void;
  moved(pos: { x: number; y: number; collapsed: boolean }): void;
}

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
const signed = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

class LadderSection {
  root = el('div', 'ladder');
  private title = el('div', 'ladder-title');
  private kindBtn = el('button', 'kind', 'ladder');
  private f: Record<string, HTMLElement> = {};
  private slIn = el('input');
  private tpIn = el('input');
  private beBtn = el('button', 'btn be', 'BE');
  private closeBtn = el('button', 'btn close', 'Close ladder');
  private warn = el('div', 'warn');
  private kind: LadderKind = 'ladder';

  constructor(
    readonly id: number,
    a: PanelActions,
    digits: number,
  ) {
    const head = el('div', 'ladder-head');
    head.append(this.title, this.kindBtn);
    this.kindBtn.title = 'Journal type: ladder or normal (normal trades never mix into ladder stats)';
    this.kindBtn.onclick = () => a.setKind(id, this.kind === 'ladder' ? 'normal' : 'ladder');
    const grid = el('div', 'grid');
    const row = (label: string, key: string) => {
      grid.append(el('span', 'lbl', label));
      const v = el('span', 'val');
      this.f[key] = v;
      grid.append(v);
    };
    row('Tickets', 'tickets');
    row('Lot', 'lot');
    row('Avg entry', 'avg');
    row('Pips', 'pips');
    row('R ($)', 'R');
    row('RR now', 'rr');
    row('Stage', 'stage');
    row('Locked $', 'locked');
    row('Floating', 'floating');

    const step = (1 / 10 ** digits).toString();
    for (const [inp, lbl, set] of [
      [this.slIn, 'SL', (p: number | null) => a.setSL(id, p)],
      [this.tpIn, 'TP', (p: number | null) => a.setTP(id, p)],
    ] as const) {
      inp.type = 'number';
      inp.step = step;
      inp.placeholder = 'none';
      inp.className = 'price-in';
      inp.title = `${lbl} for every ticket of this ladder (Enter to apply, empty = remove)`;
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const v = inp.value.trim();
          set(v === '' ? null : Number(v));
          inp.blur();
        } else if (e.key === 'Escape') inp.blur();
      });
      grid.append(el('span', 'lbl', lbl), inp);
    }
    this.beBtn.onclick = () => a.be(id);
    this.closeBtn.onclick = () => a.closeLadder(id);
    const btns = el('div', 'row');
    btns.append(this.beBtn, this.closeBtn);
    this.root.append(head, grid, this.warn, btns);
  }

  update(l: LadderView, digits: number) {
    this.kind = l.kind;
    this.root.classList.toggle('active', l.active);
    this.title.innerHTML = '';
    this.title.append(el('b', l.dir === 'buy' ? 'buy' : 'sell', l.dir.toUpperCase()), ` L${l.id}${l.active ? ' (active)' : ''}`);
    this.kindBtn.textContent = l.kind;
    this.kindBtn.classList.toggle('normal', l.kind === 'normal');
    const f = this.f;
    f.tickets.textContent = String(l.ticketCount);
    const atSL = l.lockedAtSL === null ? 'no SL' : l.lockedAtSL >= 0 ? 'SL in profit' : `${(l.lossAtSLPct ?? 0).toFixed(1)}% loss at SL`;
    f.lot.textContent = `${l.totalLot.toFixed(2)}  (${atSL})`;
    f.avg.textContent = l.avg.toFixed(digits + 1);
    f.pips.textContent = signed(l.pips);
    f.pips.className = `val ${l.pips >= 0 ? 'pos' : 'neg'}`;
    f.R.textContent = l.R === null ? '-' : money(l.R);
    f.rr.textContent = l.rrNow === null ? '-' : `${signed(l.rrNow, 2)} R`;
    f.rr.className = `val ${l.rrNow !== null && l.rrNow >= 0 ? 'pos' : 'neg'}`;
    f.stage.textContent = l.stageLabel;
    f.locked.textContent = l.lockedAtSL === null ? '-' : money(l.lockedAtSL);
    f.locked.className = `val ${l.lockedAtSL !== null && l.lockedAtSL >= 0 ? 'pos' : 'neg'}`;
    f.floating.textContent = money(l.floating);
    f.floating.className = `val ${l.floating >= 0 ? 'pos' : 'neg'}`;
    if (document.activeElement !== this.slIn) this.slIn.value = l.sl === null ? '' : l.sl.toFixed(digits);
    if (document.activeElement !== this.tpIn) this.tpIn.value = l.tp === null ? '' : l.tp.toFixed(digits);
    this.beBtn.disabled = !l.beEnabled;
    this.beBtn.title = l.beApplied ? 'BE already set' : l.beEnabled ? 'Set SL to average +1 pip' : 'Available from +30 pips';
    this.warn.textContent = l.lotWarning ? 'Warning: total lot above 0.1 per $50 of balance' : '';
  }
}

export class Panel {
  readonly root = el('div', 'panel');
  private body = el('div', 'panel-body');
  private collapseBtn = el('button', 'collapse', '-');
  private lotIn = el('input');
  private buyBtn = el('button', 'btn buy', 'BUY');
  private sellBtn = el('button', 'btn sell', 'SELL');
  private acct: Record<string, HTMLElement> = {};
  private newLadderBtn = el('button', 'btn', 'New ladder');
  private closeAllBtn = el('button', 'btn close', 'Close all');
  private warBtn = el('button', 'btn', 'New war account');
  private ladderBox = el('div', 'ladders');
  private sections = new Map<number, LadderSection>();
  private armed = false;
  private collapsed = false;
  digits = 2;

  constructor(
    host: HTMLElement,
    private a: PanelActions,
    pos: { x: number; y: number; collapsed: boolean } | null,
    lot: number,
  ) {
    const head = el('div', 'panel-head');
    head.append(el('span', 'panel-title', 'Ticket Manager'), this.collapseBtn);
    this.collapseBtn.title = 'Collapse / expand';
    this.collapseBtn.onclick = () => this.setCollapsed(!this.collapsed, true);

    this.lotIn.type = 'number';
    this.lotIn.step = '0.01';
    this.lotIn.min = '0.01';
    this.lotIn.value = lot.toFixed(2);
    this.lotIn.className = 'lot-in';
    this.lotIn.title = 'Lot size';
    this.lotIn.onchange = () => a.lotChanged(Number(this.lotIn.value));
    this.buyBtn.onclick = () => a.order('buy', Number(this.lotIn.value));
    this.sellBtn.onclick = () => a.order('sell', Number(this.lotIn.value));
    const orderRow = el('div', 'row order');
    orderRow.append(this.sellBtn, this.lotIn, this.buyBtn);

    const acct = el('div', 'grid acct');
    for (const [k, label] of [
      ['balance', 'Balance'],
      ['equity', 'Equity'],
      ['ml', 'Margin level'],
      ['free', 'Free margin'],
    ]) {
      acct.append(el('span', 'lbl', label));
      this.acct[k] = el('span', 'val');
      acct.append(this.acct[k]);
    }
    this.newLadderBtn.onclick = () => (this.armed ? a.cancelNewLadder() : a.newLadder());
    this.closeAllBtn.onclick = () => a.closeAll();
    this.warBtn.onclick = () => a.newWarAccount();
    const globalBtns = el('div', 'row');
    globalBtns.append(this.newLadderBtn, this.closeAllBtn, this.warBtn);
    this.body.append(orderRow, acct, globalBtns, this.ladderBox);
    this.root.append(head, this.body);
    host.append(this.root);

    // Default: left part of the M1 chart, away from the newest bars on the right.
    this.root.style.left = `${pos?.x ?? Math.round(window.innerWidth / 2) + 14}px`;
    this.root.style.top = `${pos?.y ?? 100}px`;
    this.setCollapsed(pos?.collapsed ?? false, false);
    this.makeDraggable(head);
  }

  private setCollapsed(c: boolean, save: boolean) {
    this.collapsed = c;
    this.body.style.display = c ? 'none' : '';
    this.collapseBtn.textContent = c ? '+' : '-';
    if (save) this.savePos();
  }

  private savePos() {
    this.a.moved({ x: parseInt(this.root.style.left, 10), y: parseInt(this.root.style.top, 10), collapsed: this.collapsed });
  }

  private makeDraggable(handle: HTMLElement) {
    handle.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      e.preventDefault();
      const sx = e.clientX - this.root.offsetLeft;
      const sy = e.clientY - this.root.offsetTop;
      const move = (m: MouseEvent) => {
        const x = Math.min(Math.max(0, m.clientX - sx), window.innerWidth - 60);
        const y = Math.min(Math.max(0, m.clientY - sy), window.innerHeight - 30);
        this.root.style.left = `${x}px`;
        this.root.style.top = `${y}px`;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.savePos();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  update(s: EngineSnapshot) {
    const d = this.digits;
    this.buyBtn.textContent = Number.isFinite(s.ask) ? `BUY ${s.ask.toFixed(d)}` : 'BUY';
    this.sellBtn.textContent = Number.isFinite(s.bid) ? `SELL ${s.bid.toFixed(d)}` : 'SELL';
    this.acct.balance.textContent = money(s.balance) + (s.blown ? '  BLOWN' : '');
    this.acct.balance.className = `val ${s.blown ? 'neg' : ''}`;
    this.acct.equity.textContent = money(s.equity);
    this.acct.equity.className = `val ${s.equity >= s.balance ? 'pos' : 'neg'}`;
    this.acct.ml.textContent = s.marginLevel === null ? '-' : `${s.marginLevel.toFixed(0)}%`;
    this.acct.free.textContent = money(s.freeMargin);
    this.armed = s.newLadderArmed;
    this.newLadderBtn.disabled = !s.canNewLadder && !s.newLadderArmed;
    this.newLadderBtn.textContent = s.newLadderArmed ? 'New ladder: next ticket (cancel)' : 'New ladder';
    this.newLadderBtn.classList.toggle('armed', s.newLadderArmed);
    this.newLadderBtn.title = 'Enabled when the active ladder has reached stage 2 (max 3 ladders)';
    this.closeAllBtn.disabled = s.ladders.length === 0 && s.pendingOrders === 0;

    const seen = new Set<number>();
    for (const l of s.ladders) {
      seen.add(l.id);
      let sec = this.sections.get(l.id);
      if (!sec) {
        sec = new LadderSection(l.id, this.a, d);
        this.sections.set(l.id, sec);
        this.ladderBox.append(sec.root);
      }
      sec.update(l, d);
    }
    for (const [id, sec] of this.sections) {
      if (!seen.has(id)) {
        sec.root.remove();
        this.sections.delete(id);
      }
    }
  }
}
