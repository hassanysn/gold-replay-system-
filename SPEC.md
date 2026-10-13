# Gold Replay Simulator — Build Spec

Tick-replay trading simulator for XAUUSD with the user's Ladder/Ticket Manager logic built in.
Purpose: practise the user's discretionary gold scalping system (HTF zone → 1M confirmation → manual ladder → staged management) on real historical ticks, and expose early-closing habits.

Runs locally on a Windows PC. A one-time Python converter prepares data; the simulator is a browser app served from a local folder.

---

## 0. Ground rules for the builder

- Build phase by phase (section 10). Each phase must pass its acceptance checks before the next starts.
- The Ladder Manager (section 6) is a pure, UI-free module with unit tests. It is the heart of the app; correctness beats features.
- Determinism: the same data + same actions must give the same results.
- Gold pip math everywhere: **1 pip = 0.10 price**. 1.00 lot = 100 oz → $10 per pip. 0.10 lot → $1 per pip.
- Never invent trading rules. Anything not in this spec is a question for the user, not a guess.

---

## 1. Tech stack

| Part | Choice |
|---|---|
| Converter | Python 3 (standard library + numpy if needed) |
| Frontend | TypeScript + Vite, no heavy framework needed |
| Charts | TradingView **Lightweight Charts** (latest, Apache-2.0) |
| Tick parsing/replay | Web Worker so the UI never freezes |
| Storage | Local files for data; IndexedDB for drawings, journal, settings |
| Launch | `start.bat` that runs a local server (e.g. `python -m http.server`) and opens the browser |

---

## 2. Data pipeline (converter)

**Input:** MT5 tick export (Symbols window → Ticks tab → XAUUSD → Export). Expected tab-separated columns:
`<DATE> <TIME> <BID> <ASK> <LAST> <VOLUME> <FLAGS>` with dates like `2026.10.12` and times like `14:30:01.123`.

- Bid or Ask can be **blank** on a row when only the other side changed → forward-fill from the previous value.
- Times are **broker server time**. Keep them as-is and store the server UTC offset as a setting (display only).
- **Verify the column layout against a real sample file from the user before finalising the parser.**

**Output:** one compact file per trading day + a manifest.
- `data/XAUUSD/YYYY-MM-DD.bin`: header (symbol, date, digits, tick count) + arrays of time (ms since day start), bid, ask stored as scaled integers (scale from symbol digits).
- `data/XAUUSD/manifest.json`: list of days, tick counts, first/last time, price digits.
- Converter is re-runnable and adds new days without redoing old ones.

**Acceptance:** converting a sample day and reading it back reproduces every bid/ask exactly; a full day loads in the browser in under 2 seconds.

---

## 3. Replay engine

- **Start point:** pick a date and time. Nothing after the current replay time is ever visible.
- **Speeds:** 1x (real time, using real tick gaps), 2x, 5x, 10x, 60x, pause.
- **Step:** +1 M1 candle; jump to next M15 close.
- **Day handling:** continues into the next day's file automatically; weekends are skipped.
- **Candles built live from ticks** (bid-based, MT5 style): M1, M15, M30. The forming candle updates each tick.
- **Auto-pause** (each toggle on/off in settings):
  - price touches a user-drawn zone rectangle
  - a ticket fills
  - SL hit on any ticket
  - a management stage is reached (BE available, stage 2, stage 3)
- **Speed lock (default ON):** while any ladder is open, only 1x and 2x are allowed. Reason: train holding through real-time waiting.

---

## 4. Chart layout and drawing

**Two charts side by side, synced crosshair and time:**
- Left: M15/M30 (switch) for zones, PD arrays and trend.
- Right: M1 with tickets, average entry, SL and TP lines.

**Colours (chart only):** grey/black candles on white background. **No green or red anywhere on the charts.** The panel keeps its own colours (section 7).

**Drawing tools (must be built; the library has none):**
- Rectangle (zones), horizontal line, text label.
- Select, move, resize, delete.
- Drawings made on the HTF chart also show on M1 (same price/time coordinates).
- Saved per day in IndexedDB and restored on reload.

**Trade lines on M1:**
- SL and TP lines draggable. Dragging one ticket's line syncs the whole ladder (section 6).
- Average entry line per ladder.

---

## 5. Order engine and account

**Orders:** manual market tickets only (Buy / Sell buttons + lot input). No pending/limit orders in v1.
- Buy fills at **ask**, sell fills at **bid**. Real spread comes from the data.
- Buy SL/TP trigger on **bid**; sell SL/TP trigger on **ask**.
- Fill price = the first tick at or after the click time.

**Account settings page (all editable):**

| Setting | Default |
|---|---|
| Balance | $50 (one war account) |
| Leverage | 1:3000 |
| Contract size | 100 oz per lot |
| Commission | $0 (user confirmed none) |
| Stop-out level | 50% margin level — **placeholder, user to confirm with broker** |
| SL spread buffer | 1 pip (applied when the manager sets an SL) |

- Margin, free margin, equity and margin level computed live.
- When margin level ≤ stop-out: close all positions at current price, like a broker. Account is then blown.
- **"New war account" button:** resets balance to the default and keeps the journal.

---

## 6. Ladder Manager (core logic, pure module)

**Ladder = basket of same-direction tickets.**

**Grouping:**
- Every new ticket joins the **active ladder**.
- **"New ladder" button** starts a new ladder. It is enabled only when the previous ladder has reached stage 2 (SL at average +20). Max **3 ladders** open at once.
- **Hard blocks:** no ticket opposite to an open ladder's direction; no 4th ladder.
- **Warning only (not a block):** a ladder's total lot above 0.1 per $50 of balance. Lot size stays the user's decision.

**Per-ladder values:**
- Average entry = lot-weighted average of ticket open prices.
- **R ($)** = loss if all tickets hit the original SL. Frozen at the first SL set. If the SL is widened **before BE**, R increases to the new loss. Never decreases.
- Pips measured from **average entry** (buy: bid − avg; sell: avg − ask), divided by 0.10.

**SL/TP sync:**
- Editing SL or TP on any ticket (line drag or input) applies the same price to every ticket in that ladder.
- If the synced stop is **invalid** for a ticket (wrong side of current price), **skip it and do nothing** for that ticket. Show a small notice.

**Management stages (all measured from average entry):**

| Stage | Trigger | Action |
|---|---|---|
| BE | ≥ +30 pips | **Button becomes available** (user decides when). Sets SL = average +1 pip |
| Stage 2 | ≥ +50 pips | Automatic: SL = average +20 pips |
| Stage 3 | ≥ +100 pips | Automatic: SL = average +50 pips |
| Runner | after stage 3 | No automatic moves. SL fully under user control |

- Automatic moves never move the SL backwards (never loosen it).
- The user may drag the SL anywhere at any time; it still syncs across the ladder.
- "Average +X" means in the profit direction (buy: avg + X×0.10; sell: avg − X×0.10).

**Unit tests must cover:** pip math both directions, lot-weighted average, R freezing and widening before BE, sync with an invalid stop skipped, each stage trigger and SL value, no backwards moves, the new-ladder gate, opposite-direction block, max 3 ladders, stop-out.

---

## 7. Panel (mirrors the user's MT5 Ticket Manager v3)

- **Movable** panel; keeps its own colours (green/red allowed here). Shows the `+/−` at the edge.
- Per ladder section:
  - direction, number of tickets, total lot, average entry
  - SL price, R ($), **loss at SL as % of account** (next to the lot)
  - live **"if closed now" RR**, using the frozen R
  - current stage, and **locked $** at the current SL
  - buttons: BE (enabled from +30), Close ladder
- Global: balance, equity, margin level, New ladder, Close all, New war account.
- **No loss-count display, no weekly loss limit.** The user explicitly does not want them.

---

## 8. Journal and stats

**Logged automatically per ladder:**
- date/time open and close, direction, type (**ladder** or **normal** — normal trades never mix into ladder stats)
- tickets, average entry, total lot, original SL, R $
- highest stage reached, exit reason (SL / stage SL / manual close / stop-out)
- result in $ and in R
- **MFE:** best favourable pips from average while the ladder was open
- **Post-close run:** keep tracking 4 hours after close; record the maximum pips price went in the ladder's direction (shows what early closes cost)
- free-text note ("why I closed")
- auto screenshot of the M1 chart at close

**Stats page:**
- win rate, average R, % of available move captured (result vs MFE + post-close run)
- list of ladders closed below **1R** (the user's minimum)
- filter by type (ladder / normal) and date range

**Export:** CSV of all journal rows.

---

## 9. Out of scope for v1

- Running real `.mq5` EAs (the real EA is tested in MT5 Strategy Tester).
- Zone Marker / automatic PD-array detection.
- Pending/limit orders and the drag-a-box ladder tool.
- Partial closes.

---

## 10. Build phases

1. **Converter** — MT5 tick CSV → daily `.bin` + manifest. Check against a user sample.
2. **Replay engine + charts** — load a day, play/pause/speeds/step, live M1/M15/M30 candles, two synced charts, grey/black theme.
3. **Order engine + account** — market tickets, bid/ask fills, equity/margin, stop-out, settings page.
4. **Ladder Manager + panel** — pure module with full unit tests first, then panel and draggable synced lines.
5. **Drawing tools** — rectangle, line, label, cross-timeframe display, saved per day.
6. **Auto-pause + speed lock.**
7. **Journal + stats + CSV export.**

After each phase: run the app, show it working, and wait for the user's OK.
