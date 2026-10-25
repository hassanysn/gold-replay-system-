# Gold Replay Simulator

Tick-replay trading simulator for XAUUSD with the Ladder / Ticket Manager logic built in
(see [SPEC.md](SPEC.md)). Replays real MT5 ticks in the browser, builds M1/M15/M30 candles live,
fills market tickets at the real bid/ask, runs the ladder management stages and journals every
ladder, including how far price ran after you closed.

Runs locally on Windows: a one-time Python converter prepares the data, `start.bat` serves the
app from this folder and opens the browser.

**Live trading:** the same page on your real MT5 account (`start_live.bat`), with the EA as the
ladder manager. See **[LIVE.md](LIVE.md)**. Test it on a demo account first.

## Quick start (Windows)

1. Install **Python 3** (python.org, tick "Add python.exe to PATH"). Node is *not* needed to run
   the app: the built app is committed in `app/`.
2. Export ticks from MT5: Symbols window → Ticks tab → XAUUSD → pick a range → **Export**.
3. Convert: drag the export file(s) onto **`convert.bat`**, or run
   `python converter\convert.py path\to\XAUUSD_ticks.csv`.
   This writes `data\XAUUSD\YYYY-MM-DD.bin` + `manifest.json`. Re-run it with new exports any
   time; days already converted are skipped (`--force` replaces them). Export **whole days**: if a
   day was first converted from a partial export, convert the full-day export with `--force` (the
   converter warns when tick counts differ). Broker suffixes like `XAUUSD.m` are fine; the data is
   stored as `XAUUSD`.
4. Double-click **`start.bat`**. The browser opens at `http://127.0.0.1:8765/`.
5. Pick a start date and time (server time), press **Load**.

No MT5 data yet? Try the synthetic sample (random walk, not market data):

```
python converter\make_sample.py --days 6 --out sample_ticks.csv
python converter\convert.py sample_ticks.csv
```

## Using it

| Area | What it does |
|---|---|
| Toolbar | Date/time + **Load**; **Play/Pause** (Space); speeds 1x 2x 5x 10x 60x; **+1 M1** (→); **Next M15 close** (Shift+→); **✂ Cut** (C); drawing tools; HTF **M15/M30**; **Now** (End) scrolls to the current time |
| Left chart | M15 or M30 for zones, PD arrays, trend. Zoom/scroll is independent of M1; only the replay time (and Now/End) moves both |
| Right chart | M1 like MT5: one grey dashed line per open ticket, the ladder's average line labelled "L1: 4 trades", SL, TP and ask lines, exit markers |
| Panel | The EA panel: movable (drag the title), `-`/`+` collapses it. Lot + SELL/BUY, balance / cap / ladders, TOTAL IF SL HITS, NEW LADDER, Close all, New war account, per ladder the EA's lines + SL/TP + MOVE TO BE + setup tags, unmanaged tickets (no PLAN line: removed from the EA in v3.0-s5) |
| Journal | Every closed ladder, with setup tags, M1 screenshot at close (img), MFE, 4 h post-close run and a "why I closed" note. Also saved to `journal/journal.xlsx` (see below) |
| Stats | Ladder / normal filter, date range, win rate, average R, % of move captured, ladders closed below 1R, CSV export |
| Settings | Account (balance, leverage, contract size, commission, stop-out, stops level), EA inputs, speed lock, sounds on/off, server UTC offset |

- **Nothing after the replay time is ever sent to the page.** The tick data lives in a Web Worker.
- **✂ Cut** (C), like TradingView's replay scissors: hover a candle on either chart (the part that
  will be hidden is shaded), click, and the replay restarts with that candle as the last one shown.
  Your drawings stay. You can only cut back to a finished candle; to jump ahead, pick a date and Load.
- **Orders** fill on the first tick at or after the click: buy at ask, sell at bid. Buy SL/TP trigger
  on bid, sell SL/TP on ask.
- **No auto-pause.** Like a real chart, the replay only pauses when you press Space (or Pause). Fills,
  zone touches, SL hits and stages never stop it.
- **Sounds** like MT5 desktop: trade opened, trade closed (SL, TP, manager or you), and an alert when
  price touches a marked zone (the replay keeps running).
- **NEW LADDER** works as soon as every open ladder is at BE: each ticket has an SL and IF SL HITS
  is zero or better (MOVE TO BE, a stage, or your own SL). No stage 2 needed. Max 3 ladders.
- **MOVE TO BE** works whenever price is +30 pips or more from the average: it sets the SL to average
  +1 pip on every ticket. If your SL is already better (moved by you, stage 2 or stage 3) the button
  reads **PULL BACK TO BE** and gives that locked profit back on purpose, to leave room for a
  retracement (for example after an MSS on the lower timeframe). It never goes below average +1 pip,
  so the ladder stays risk-free. Stage 2 does not fire again afterwards; stage 3 still does. The
  journal counts it as an SL edit and marks the ladder "BE pulled back: yes".
- **SL/TP**: type a price in the ladder's SL/TP box and press Enter, or drag the SL/TP line on the M1
  chart. Dragging the average-entry line creates an SL (loss side) or TP (profit side). Like the EA,
  your edit becomes the ladder SL/TP and is copied to every ticket; an edit on the wrong side of price
  is rejected (MT5 would reject it); the ladder SL cannot be removed, only moved.
- **Lot cap**: like the EA, a trade that takes a ladder over 0.10 lot per $100 of balance is closed
  by the manager straight away (you lose the spread). The panel header shows the cap.
- **Setup tags**: each ladder has Session, PD array, HTF trend (rule of 4), Confirmation, Zone size,
  Avg stop and Rule followed. Fill them in the ladder's "Setup tags" box while it is open; whatever is
  still empty is asked once in a small card when the ladder closes; edit them later in the Journal.

### Excel journal

While the simulator runs through `start.bat`, every ladder close, tag/note edit and CSV export
writes the full journal to **`journal/journal.xlsx`** in the simulator folder (one row per ladder:
tags, result $ and R, closed below 1R, highest stage, exit reason, MFE, post-close run, chart image
name, plus the EA journal fields). The M1 screenshots go to `journal/images/`. `journal/journal.json`
holds the same rows and is updated first, so if `journal.xlsx` is open in Excel (locked), no row is
lost: the server keeps retrying every 5 seconds and writes everything once you close Excel. The
browser journal stays as it is.
- **Drawings**: Rect (R), H-line (H), Text (T), Select (Esc). Click a drawing to select it; drag
  to move; drag a corner to resize; Delete removes it; double-click a label to edit it. Rectangles
  extend right by default (toggle "extend"). Drawings are saved per day in IndexedDB and appear on
  both charts.
- **Speed lock** (default on): only 1x and 2x while any ladder is open.

## Project layout

```
converter/      Python converter (stdlib only), sample generator, unittest
  grbin.py        binary day-file format (documented layout)
src/core/       pure TypeScript logic, no DOM: pips, engine (orders + Ladder Manager), replay, candles, stats
src/worker/     simulation Web Worker + message protocol
src/ui/         charts, drawing tools, panel, pages, IndexedDB
tests/          vitest unit tests (+ a fixture written by the Python converter)
app/            built app (committed so start.bat works without Node)
serve.py        local server: app/ at /, data/ at /data/, journal API -> journal/
live/           live MT5 trading: bridge.py (MetaTrader5 package -> 127.0.0.1:8766), mt5_fake.py (tests)
src/live/       live page: MT5 positions + EA state -> the same panel, charts and journal
live.html, start_live.bat
journal_store.py  journal.json + journal.xlsx writer (stdlib only, retries while Excel locks the file)
reference/      the MT5 EA source the Ladder Manager mirrors
start.bat, convert.bat
```

## Development

```
npm install
npm test                               # vitest: engine, ladder manager, replay, stats
python -m unittest discover converter  # converter round-trip tests
python -m unittest discover -s tests -p "test_*.py"  # Excel journal store + live bridge (fake MT5)
python live/bridge.py --fake           # live page against a simulated terminal + EA
npm run dev                            # Vite dev server (serves ./data too)
npm run build                          # typecheck + rebuild app/ (commit app/ afterwards)
```

Open the app with `?debug` to get `window.__gr` (chart views, drawing store) in the console.

## Build phases (SPEC §10)

| Phase | Status | Acceptance check |
|---|---|---|
| 1. Converter | done | Read-back of every written day is compared with the input. Verified on your real `XAUUSD.m` export (13 Oct 2026, 10:00–16:05): all 81,484 quotes reproduced exactly, 96 ask forward-fills, 26,970 trade-only rows (flags 96, no bid/ask) skipped, 0.9 s to convert. An excerpt is kept as a regression test |
| 2. Replay + charts | done | Synthetic 6-day set: 6 day files (≈286k ticks each) load in 0.3–1.1 s in Chromium (target < 2 s). Speeds, steps, day rollover, weekend skip covered by tests |
| 3. Orders + account | done | Bid/ask fills, margin/equity/margin level, margin rejection, stop-out → blown → New war account, settings page |
| 4. Ladder Manager + panel | done | Port of the MT5 EA v3.0; 32 engine tests for the EA rules (stages, frozen average, BE, cap, gate, sync/wait, R); panel checked in the browser |
| 5. Drawing tools | done | Rect/H-line/Text, select/move/resize/delete, HTF↔M1, saved per day, restored on reload |
| 6. Auto-pause + speed lock | changed | Auto-pause removed at your request (2026-10-25): only Space pauses; zone touch plays an alert. Speed lock 1x/2x kept |
| 7. Journal + stats + CSV | done | Auto-journal, MFE, 4 h post-close run (finished from data if you leave the session early), screenshot, note, stats, CSV |

## Ladder Manager = the MT5 EA

The ladder logic is a port of your EA (`reference/LadderManager.mqh` / `reference/GoldLadderManager.mq5` v3.0-s6), so the
simulator does what the EA does on a real chart: stages 2/3 from the average (frozen at stage 2),
MOVE TO BE at average +1 pip from +30 (with the pull-back), "manual always wins", the NEW LADDER gate (every ladder at BE), the hard lot cap
(0.10 lot per $100 per ladder, excess closed), SL/TP sync with waiting/retry, opposite trades left
unmanaged, R = worst IF SL HITS seen. Every difference that existed and how it was resolved is in
**[EA_PARITY.md](EA_PARITY.md)**. EA inputs are on the Settings page.

## Decisions that need your confirmation

1. **MT5 export format** (verified): your export is UTF-8, tab separated, `<DATE> <TIME> <BID> <ASK>
   <LAST> <VOLUME> <FLAGS>`. Rows with neither bid nor ask (MT5 flags 96, trade-only ticks) carry no
   quote and are skipped; bid-only rows (flags 98) keep the previous ask.
2. **Stop-out level** 50% is still the placeholder; confirm with your broker.
3. **Broker stops level** defaults to 0 points. If your broker has one, set it in Settings: the EA's
   step-back/waiting logic then behaves as on your account.
4. **SPEC vs EA**: where they disagreed the EA wins (opposite trades are not blocked, the lot cap is
   enforced, no ladder-type toggle). Unmanaged opposite tickets are journaled as type "normal".
5. **Zone touch**: the bid enters a rectangle that is live at that time (extend-right rectangles stay
   live). It re-arms after price leaves the box.
6. **Post-close run** is measured from the average entry (same baseline as the spec MFE).
   "% captured" = result pips / max(MFE, post-close run); losing trades give a negative value.
7. **Closed below 1R** lists every ladder with net R < 1, losers included (net R = EA `net_R`).
8. **Manual close** fills at the current quote immediately (opens use the next tick, per the spec).
9. **Gaps without ticks longer than 30 minutes** are skipped at every speed (day breaks, weekends).
10. **Margin** uses each ticket's open price.
11. **Server UTC offset** defaults to +2 (display only; set yours in Settings).
