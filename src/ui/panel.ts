// Movable Gold Ladder Manager panel - shows the same lines as the MT5 EA panel (GoldLadderManager.mq5):
// balance / cap / ladders, TOTAL IF SL HITS, NEW LADDER, MOVE TO BE, per ladder the 5 page lines,
// setup tags per ladder. All ladders are listed at once instead of < > pages. Keeps its own colours.
// (The PLAN line was removed from the EA in v3.0-s5 and is not shown here either.)

import type { EngineSnapshot, LadderView, TicketView } from '../core/engine';
import type { Dir } from '../core/pips';
import type { SetupTags } from '../core/engine';
import { TagEditor, tagSummary } from './tags';

export interface PanelActions {
  order(dir: Dir, lot: number): void;
  setSL(ladderId: number, price: number | null): void;
  setTP(ladderId: number, price: number | null): void;
  be(ladderId: number): void;
  closeLadder(ladderId: number): void;
  setTicketSL(ticketId: number, price: number | null): void;
  setTicketTP(ticketId: number, price: number | null): void;
  closeTicket(ticketId: number): void;
  setTags(ladderId: number, tags: SetupTags): void;
  closeAll(): void;
  newLadder(): void;
  newWarAccount(): void;
  lotChanged(lot: number): void;
  moved(pos: { x: number; y: number; collapsed: boolean }): void;
}

const money = (v: number) => `${v >= 0 ? '+$' : '-$'}${Math.abs(v).toFixed(2)}`;
const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Number input that applies on Enter (empty = none) and is not overwritten while focused. */
function priceInput(digits: number, title: string, apply: (p: number | null) => void): HTMLInputElement {
  const inp = el('input', 'price-in');
  inp.type = 'number';
  inp.step = (1 / 10 ** digits).toString();
  inp.placeholder = 'none';
  inp.title = title;
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = inp.value.trim();
      apply(v === '' ? null : Number(v));
      inp.blur();
    } else if (e.key === 'Escape') inp.blur();
  });
  return inp;
}

function setPrice(inp: HTMLInputElement, v: number | null, digits: number) {
  if (document.activeElement !== inp) inp.value = v === null ? '' : v.toFixed(digits);
}

class LadderSection {
  root = el('div', 'ladder');
  private title = el('div', 'ladder-title');
  private l1 = el('div', 'line l1');
  private l2 = el('div', 'line');
  private l3 = el('div', 'line l3');
  private l4 = el('div', 'line l4');
  private l5 = el('div', 'line l5');
  private slIn: HTMLInputElement;
  private tpIn: HTMLInputElement;
  private beBtn = el('button', 'btn be', 'MOVE TO BE');
  private tagBox = el('details', 'tags');
  private tagHead = el('summary');
  private tags: TagEditor;
  private closeBtn = el('button', 'btn close', 'Close ladder');

  constructor(
    readonly id: number,
    a: PanelActions,
    digits: number,
  ) {
    this.slIn = priceInput(digits, 'Ladder SL - copied to every ticket (Enter)', (p) => a.setSL(id, p));
    this.tpIn = priceInput(digits, 'Ladder TP - copied to every ticket (Enter, empty = none)', (p) => a.setTP(id, p));
    const edits = el('div', 'edits');
    edits.append(el('span', 'lbl', 'SL'), this.slIn, el('span', 'lbl', 'TP'), this.tpIn);
    this.beBtn.title = 'Stage 1: SL = average entry + BE buffer, allowed from +BE minimum pips';
    this.beBtn.onclick = () => a.be(id);
    this.closeBtn.onclick = () => a.closeLadder(id);
    const btns = el('div', 'row');
    btns.append(this.beBtn, this.closeBtn);
    this.tags = new TagEditor(undefined, (t) => a.setTags(id, t));
    this.tagBox.append(this.tagHead, this.tags.root);
    this.root.append(this.title, this.l1, edits, this.l2, this.l3, this.l4, this.l5, btns, this.tagBox);
  }

  update(l: LadderView, count: number, digits: number) {
    const d = digits;
    this.root.classList.toggle('active', l.active);
    this.title.textContent = `LADDER L${l.rank} of ${count}${l.tickets[0] ? `   opened ${new Date(l.tickets[0].openTime).toISOString().slice(11, 16)}` : ''}${l.active ? '   <- new trades' : ''}`;
    const empty = l.ticketCount === 0;
    for (const e of [this.l2, this.l4, this.l5]) e.hidden = empty;
    this.slIn.disabled = this.tpIn.disabled = empty;
    this.beBtn.disabled = empty || !l.beEnabled;
    this.closeBtn.disabled = empty;
    setPrice(this.slIn, l.sl, d);
    setPrice(this.tpIn, l.tp, d);
    this.tags.set(l.tags);
    const sum = tagSummary(l.tags);
    this.tagHead.textContent = sum ? `Setup: ${sum}` : 'Setup tags (session, PD array, trend...)';
    if (empty) {
      this.l1.textContent = l.stageText;
      this.l3.textContent = '';
      return;
    }
    this.l1.innerHTML = '';
    this.l1.append(el('b', l.dir ?? '', (l.dir ?? '-').toUpperCase()), ` | ${l.ticketCount} ticket(s) ${l.totalLot.toFixed(2)} lot | worst entry ${l.worstEntry.toFixed(d)}`);
    this.l2.textContent = `avg ${l.avg.toFixed(d)}  ${l.pips >= 0 ? '+' : ''}${l.pips.toFixed(1)} pips | ${l.beText}`;
    this.l3.textContent = l.stageText;
    if (l.ifSLHits === null) {
      this.l4.textContent = 'IF SL HITS: NO SL - UNLIMITED LOSS';
      this.l4.className = 'line l4 neg';
    } else {
      const r = l.ifSLHits;
      this.l4.textContent = `IF SL HITS: ${money(r)}${l.ifSLHitsPct !== null ? ` = ${l.ifSLHitsPct.toFixed(1)}% of balance` : r >= 0 ? ' (locked)' : ''}`;
      this.l4.className = `line l4 ${r >= 0 ? 'pos' : 'neg'}`;
    }
    let t5 = `IF CLOSED NOW: ${money(l.ifClosedNow)}`;
    if (l.R !== null && l.rr !== null) t5 += ` = ${l.rr.toFixed(2)}R   (1R = $${l.R.toFixed(2)})${l.rr < 1 ? '   below 1R' : ''}`;
    else t5 += '   (R unknown - no SL set yet)';
    this.l5.textContent = t5;
    this.beBtn.textContent = l.bePullBack ? 'PULL BACK TO BE' : 'MOVE TO BE';
    this.beBtn.classList.toggle('pullback', l.bePullBack);
    this.beBtn.title = l.bePullBack
      ? 'Pull the SL back to average +1 pip: gives back locked profit to leave room for a retracement (stays risk-free)'
      : l.beEnabled
        ? 'Set SL to average +1 pip on every ticket'
        : l.beText;
  }
}

class UnmanagedRow {
  root = el('div', 'unmanaged-row');
  private text = el('div', 'line');
  private slIn: HTMLInputElement;
  private tpIn: HTMLInputElement;

  constructor(
    readonly id: number,
    a: PanelActions,
    digits: number,
  ) {
    this.slIn = priceInput(digits, 'SL of this ticket only (Enter)', (p) => a.setTicketSL(id, p));
    this.tpIn = priceInput(digits, 'TP of this ticket only (Enter)', (p) => a.setTicketTP(id, p));
    const close = el('button', 'btn close', 'Close');
    close.onclick = () => a.closeTicket(id);
    const edits = el('div', 'edits');
    edits.append(el('span', 'lbl', 'SL'), this.slIn, el('span', 'lbl', 'TP'), this.tpIn, close);
    this.root.append(this.text, edits);
  }

  update(t: TicketView, digits: number) {
    this.text.innerHTML = '';
    this.text.append(el('b', t.dir, t.dir.toUpperCase()), ` #${t.id} ${t.lot.toFixed(2)} @ ${t.openPrice.toFixed(digits)}  `, el('span', t.floating >= 0 ? 'pos' : 'neg', usd(t.floating)));
    setPrice(this.slIn, t.sl, digits);
    setPrice(this.tpIn, t.tp, digits);
  }
}

export class Panel {
  readonly root = el('div', 'panel');
  private body = el('div', 'panel-body');
  private collapseBtn = el('button', 'collapse', '-');
  private lotIn = el('input');
  private buyBtn = el('button', 'btn buy', 'BUY');
  private sellBtn = el('button', 'btn sell', 'SELL');
  private info = el('div', 'line info');
  private acct = el('div', 'line muted-line');
  private total = el('div', 'line total');
  private newLadderBtn = el('button', 'btn new', 'NEW LADDER');
  private closeAllBtn = el('button', 'btn close', 'Close all');
  private warBtn = el('button', 'btn', 'New war account');
  private ladderBox = el('div', 'ladders');
  private unmanagedBox = el('div', 'unmanaged');
  private sections = new Map<number, LadderSection>();
  private rows = new Map<number, UnmanagedRow>();
  private collapsed = false;
  digits = 2;

  constructor(
    host: HTMLElement,
    private a: PanelActions,
    pos: { x: number; y: number; collapsed: boolean } | null,
    lot: number,
    /** war: show "New war account" (simulator only). */
    opts: { war?: boolean } = {},
  ) {
    const head = el('div', 'panel-head');
    head.append(el('span', 'panel-title', 'GOLD LADDER MANAGER'), this.collapseBtn);
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

    this.newLadderBtn.onclick = () => a.newLadder();
    this.closeAllBtn.onclick = () => a.closeAll();
    this.warBtn.onclick = () => a.newWarAccount();
    const globalBtns = el('div', 'row');
    globalBtns.append(this.newLadderBtn, this.closeAllBtn);
    if (opts.war ?? true) globalBtns.append(this.warBtn);

    this.unmanagedBox.append(el('div', 'ladder-title', 'UNMANAGED - opposite to your ladder(s), manage it yourself'));
    this.body.append(orderRow, this.info, this.acct, this.total, globalBtns, this.ladderBox, this.unmanagedBox);
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
        this.root.style.left = `${Math.min(Math.max(0, m.clientX - sx), window.innerWidth - 60)}px`;
        this.root.style.top = `${Math.min(Math.max(0, m.clientY - sy), window.innerHeight - 30)}px`;
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
    const cap = Number.isFinite(s.lotCap) ? `${s.lotCap.toFixed(2)} lot per ladder` : 'none';
    this.info.textContent = `Balance $${s.balance.toFixed(2)}${s.blown ? ' BLOWN' : ''}  |  cap ${cap}  |  ladders ${s.ladderCount} of 3`;
    this.info.classList.toggle('neg', s.blown);
    this.acct.textContent = `Equity ${usd(s.equity)}  |  margin level ${s.marginLevel === null ? '-' : `${s.marginLevel.toFixed(0)}%`}  |  free ${usd(s.freeMargin)}`;
    if (s.totalIfSLHits === null) {
      this.total.textContent = 'TOTAL IF SL HITS:  NO SL - UNLIMITED LOSS';
      this.total.className = 'line total neg';
    } else {
      const r = s.totalIfSLHits;
      const pct = s.balance > 0 ? (r / s.balance) * 100 : 0;
      this.total.textContent = `TOTAL IF SL HITS:  ${money(r)}   (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
      this.total.className = `line total ${r >= 0 ? 'pos' : 'neg'}`;
    }
    if (s.unmanaged.length) this.total.textContent += `  | ${s.unmanaged.length} unmanaged`;
    this.newLadderBtn.classList.toggle('ready', s.canNewLadder);
    this.newLadderBtn.title = s.canNewLadder ? 'Open a new ladder: your next trades join it' : `Refused now: ${s.newLadderWhy}`;
    this.closeAllBtn.disabled = s.ladders.every((l) => l.ticketCount === 0) && s.unmanaged.length === 0 && s.pendingOrders === 0;

    const seen = new Set<number>();
    for (const l of s.ladders) {
      seen.add(l.id);
      let sec = this.sections.get(l.id);
      if (!sec) {
        sec = new LadderSection(l.id, this.a, d);
        this.sections.set(l.id, sec);
        this.ladderBox.append(sec.root);
      }
      sec.update(l, s.ladderCount, d);
    }
    for (const [id, sec] of this.sections) {
      if (!seen.has(id)) {
        sec.root.remove();
        this.sections.delete(id);
      }
    }
    if (s.ladders.length === 0) this.ladderBox.dataset.empty = 'Open a trade to start L1';
    else delete this.ladderBox.dataset.empty;

    const seenT = new Set<number>();
    for (const t of s.unmanaged) {
      seenT.add(t.id);
      let row = this.rows.get(t.id);
      if (!row) {
        row = new UnmanagedRow(t.id, this.a, d);
        this.rows.set(t.id, row);
        this.unmanagedBox.append(row.root);
      }
      row.update(t, d);
    }
    for (const [id, row] of this.rows) {
      if (!seenT.has(id)) {
        row.root.remove();
        this.rows.delete(id);
      }
    }
    this.unmanagedBox.hidden = s.unmanaged.length === 0;
  }
}
