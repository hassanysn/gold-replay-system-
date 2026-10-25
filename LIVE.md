# Gold Replay LIVE: the replay page on your real MT5 account

Same charts, drawings, EA panel, sounds and journal as the simulator, but on your live MT5
terminal. Prices and candles come from MT5. Orders, closes and SL/TP edits go straight to MT5.
The **GoldLadderManager EA stays the ladder manager**: stages 2 and 3, the lot cap, SL/TP sync,
NEW LADDER and MOVE TO BE all run inside MT5, so they keep working even if the page is closed.

```
 browser page  <-->  live/bridge.py (127.0.0.1:8766)  <-->  MT5 terminal (MetaTrader5 package)
                                                             GoldLadderManager s6 on the XAUUSD chart
                                                               writes   Common\Files\GLM_state_<symbol>.json
                                                               reads    Common\Files\GLM_cmd_<symbol>.txt
```

**Test it on your demo account first.** Check every button against what the EA panel on the MT5
chart shows before you use it with real money.

## One-time setup

1. **Update the EA to v3.0-s6.** In MT5: File → Open Data Folder → `MQL5\Experts\`. Replace
   `GoldLadderManager.mq5` and `LadderManager.mqh` with the two files from `reference\`.
   Open MetaEditor (F4), open `GoldLadderManager.mq5`, press **Compile** (F7). It must say
   0 errors. If it shows errors, send me the error lines.
2. **Attach the EA** to the `XAUUSD.m` chart (any timeframe). In its inputs, check that
   **Gold Replay live (s6)** is `true` and **Algo Trading** is allowed (Common tab). The journal
   message in the Experts tab should say `GOLD LADDER MANAGER v3.0-s6 ON XAUUSD.m`.
3. Press **Algo Trading** in the MT5 toolbar (it must be green). MT5 refuses orders from the
   page while it is off.
4. Install **Python 3, 64-bit** (python.org, tick "Add python.exe to PATH"). The simulator
   already needs it.

## Every day

1. Open MT5 and log in (demo or real). The EA must be on the XAUUSD.m chart.
2. Double-click **`start_live.bat`**. The first time it installs the `MetaTrader5` Python package.
   The window prints the account, `DEMO`/`REAL`, and whether it found the EA. The browser opens at
   `http://127.0.0.1:8766/`. Keep that window open while you trade.
3. Check the toolbar: **DEMO** (blue) or **REAL** (red), your login and server, and
   **EA 3.0-s6 running** in green.
4. Tick **LIVE trading** to trade. It is OFF after every page load. On a REAL account it asks
   you to confirm once.

## What each button does

| Button | Goes to | Same rule as |
|---|---|---|
| **BUY / SELL** | MT5 market order, magic 0 (a manual trade, so the EA manages it), 20 points slippage | The page refuses it **before sending** if it would take the ladder over the lot cap: 0.10 lot per $100 of balance (0.05 for $50), rounded down. The EA would close the extra trade anyway, and you would lose the spread. A trade opposite to your open ladder asks first: the EA leaves it unmanaged |
| **SL / TP** box, or dragging the line on M1 | MT5 modify on every ticket of the ladder | "Manual always wins": the EA copies your SL/TP to the ladder. The SL cannot be removed, only moved. An SL/TP on the wrong side of price is refused |
| **MOVE TO BE / PULL BACK TO BE** | Command to the EA (`moveToBE`) | EA s6: from +30 pips, SL = average +1 pip on every ticket. If your SL is already better, it pulls back to BE on purpose (never below average +1). The EA's answer shows as a message |
| **NEW LADDER** | Command to the EA (`newLadder`) | EA s6: allowed when every open ladder is at BE (each ticket has an SL and IF SL HITS ≥ 0). Max 3 ladders |
| **Close ladder / Close / Close all** | MT5 close at market (Close all asks first) | — |
| Stage 2 / stage 3 | Done by the EA on its own | Exactly as before |

The panel lines (avg, pips, BE status, stage, IF SL HITS, IF CLOSED NOW = R) are worked out the
same way as the EA panel, from the EA's state file plus your MT5 positions. IF CLOSED NOW uses
MT5's profit, so swap is included.

**EA not running** (orange "EA not running" in the toolbar): you can still trade and edit SL/TP.
Trades are grouped by direction. MOVE TO BE is done by the page (same rule: from +30 pips, average
+1 pip). There are no automatic stages, no NEW LADDER and no lot-cap closes until the EA is back.

## Journal

Every closed ladder (and every unmanaged ticket) goes to the Journal and Stats pages and to
**`journal_live\journal.xlsx`**, separate from the simulator's `journal\`. It has the same
columns, the setup tags card, and an M1 screenshot in `journal_live\images\`. The results come
from MT5's own deals: real fill prices, commission and swap, and the close reason (SL, TP, you,
or the manager's cap close). The 4-hour post-close run is measured from MT5's M1 candles.

Keep the page open while a ladder closes so it can write the row. If the page was closed at that
moment, the EA's own journal (`Common\Files\LM_journal.csv`) still has that ladder.

## Safety

- The bridge listens on **127.0.0.1 only**. Every trading request must come from the page itself
  (same origin plus a custom header), so no other website can send orders.
- LIVE trading is OFF on every page load, and the toolbar shows DEMO/REAL at all times.
- MT5 has the final say. Orders and edits pass the broker's checks (stops level, margin, market
  closed). The message shows the broker's reason when one is refused.
- The bridge window prints every order, modify, close and EA command with the time.

## Troubleshooting

| Message | Fix |
|---|---|
| `Could not connect to MetaTrader 5` | Open MT5 and log in. If you have several MT5 installs, start the one you trade with first |
| `Symbol XAUUSD.m not found` / wrong symbol | `start_live.bat --symbol XAUUSD` (the name exactly as in Market Watch) |
| Toolbar: `EA not running` | Attach GoldLadderManager **s6** to that symbol's chart, input "Gold Replay live (s6)" = true, Algo Trading on |
| `Algo Trading is OFF in MT5` | Press the Algo Trading button in the MT5 toolbar |
| `MOVE TO BE: the EA did not answer` | The EA was removed or Algo Trading switched off. Check the Experts tab in MT5 |
| `Lost the connection to MT5` | The start_live window was closed, or MT5 was closed. The page reconnects by itself |

## Testing without MT5

`python live\bridge.py --fake` runs a simulated terminal with a random-walk price and a
small stand-in for the EA. It is for checking the page only, not for trading decisions. The tests
use it too: `python -m unittest discover -s tests -p "test_*.py"`.
