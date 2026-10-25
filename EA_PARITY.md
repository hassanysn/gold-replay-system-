# EA parity: GoldLadderManager v3.0 vs the simulator

Source of truth: `reference/LadderManager.mqh` and `reference/GoldLadderManager.mq5`, version **3.0-s5**.

**s5 check (2026-10-25):** compared line by line with 3.0-s4. The only changes are the version string and
the removal of the PLAN line from the panel (inputs, edit boxes, `PlanText`, its saved values). The ladder
logic in `LadderManager.mqh` is unchanged, so every row below still holds; the simulator dropped the PLAN
line to match (row 31).
The simulator's Ladder Manager (`src/core/engine.ts`) is now a port of the EA's `Run()` pass:
`AssignNew` → per ladder: closed? → `EnforceCap` → `Sync` → stage 2 → stage 3 → retry pending → `Track`.
All defaults are the EA's input defaults.

"Before" = the simulator as built from SPEC.md. "Now" = after this change.

## Differences found and how they were resolved

| # | Topic | EA behaviour | Simulator before | Simulator now |
|---|---|---|---|---|
| 1 | Stage 2 SL level | avg **+20** pips exactly (`S2LockPips`), no buffer | avg +20 − 1 pip "SL spread buffer" = **+19** | avg +20 exactly |
| 2 | Stage 3 SL level | **anchor** +50 pips exactly | live avg +50 − 1 = **+49** | anchor +50 exactly |
| 3 | Average after stage 2 | **Frozen** at stage 2 (`anchor`); stage 3 trigger and lock use it; panel pips use it (`StageAvg`) | Live average always (adding a ticket moved stage 3) | Frozen anchor, like the EA |
| 4 | Stage 3 trigger after a settings change | `next` recomputed from the anchor every pass (follows a panel change) | Fixed constants | Same as EA |
| 5 | BE level | avg **+1 pip** (`BEBufferPips` is added in the profit direction) | avg +1 − 1 buffer = **avg exactly** | avg +1 pip |
| 6 | BE availability | **Live** check at the moment you press: price must be ≥ +30 from the **live** average now | Stayed available once +30 had been reached | Live check, like the EA (refused "TOO EARLY" with the BE price) |
| 7 | BE when SL already better | Refused: "already at or past breakeven - nothing changed" | Same idea (button disabled) | **Deliberate difference (your rule, 2026-10-25):** allowed from +30; pulls the SL back to average +1 pip ("PULL BACK TO BE"), never below it; stage unchanged (no stage 2 re-fire, stage 3 still fires); journal `be_pulled_back`. Update the EA to match if you want the real chart to behave the same |
| 8 | BE and "stage 1" | Not a stored stage; counts as an SL edit (`jSlEdits++`) | Stage 1 stored as "BE available" | Not a stage; counts as SL edit (a pull-back too) |
| 9 | "Manual always wins" | EA moves the SL only at its own events (stage 2, stage 3, BE button) and only if its level is **better** than your SL; otherwise logs "not applied - your SL is already better" | Never-backwards check per ticket | Compared with the ladder SL, same log line |
| 10 | Your SL edit vs a waiting auto SL | Your edit **cancels** a pending auto SL ("your edit wins") | No pending concept | Same as EA |
| 11 | Auto SL too close to price (stops level) | Steps back by the **spread** up to 5 times, sets the looser SL, keeps the target **pending** and tightens later; retry after `RetryCooldownSec` | Invalid stop skipped, never retried | Same as EA; broker stops level is a new setting (default 0 points) |
| 12 | Sync: invalid SL/TP for a ticket | Ticket **waits** ("cannot take ... yet (too close to price). Waiting.") and gets it when valid, retry after 5 s cooldown | Skipped for that ticket, forgotten | Waits and retries, like the EA |
| 13 | Sync: your own edit on the wrong side of price | MT5 itself rejects the modification | Applied to valid tickets, skipped on the rest | Rejected ("the broker rejects this edit") |
| 14 | Removing the ladder SL | Not possible: an SL of 0 is not taken as an edit and the ladder SL is pushed back | Allowed (empty input removed SL) | Refused with a message; TP removal (TP 0 = none) is copied, like the EA |
| 15 | New ticket joining a ladder | Takes the ladder SL/TP ("new trade #x got ladder SL"); after stage 2 "TRADE ADDED after stage 2 ... it takes the ladder SL" | Inherited if valid, else none | Same as EA (waits if not valid yet) |
| 16 | Opposite-direction trade | **Not blocked** (MT5 cannot block manual trades): opened, logged "opposite to your open ladder(s) - NOT managed. Manage it yourself.", counted as unmanaged | **Hard block** (SPEC §6) | Not blocked: opened as an **unmanaged** ticket with its own SL/TP/Close in the panel; journaled as type **normal** |
| 17 | Left-over opposite trade after the ladders close | Adopted into a new ladder on the next pass (`AssignNew` picks up unowned tickets) | n/a | Adopted, like the EA |
| 18 | Current ladder closed while others are open | New trades join the **newest open** ladder (`NewestActive`) | Started a new ladder | Joins the newest open ladder |
| 19 | NEW LADDER gate | Refused if: current ladder has no trades ("use it first"); **every** open ladder not at stage 2; 3 ladders open; any ladder has a ticket with **no SL**; any ladder **still at risk** (IF SL HITS < 0) | Only the active ladder at stage 2 + max 3 | **Deliberate difference (your rule, 2026-10-25):** stage 2 is not required; every open ladder must be at BE (all tickets have an SL and IF SL HITS ≥ 0). The other EA checks stay (max 3, no SL, still at risk, current ladder empty) |
| 20 | NEW LADDER result | Creates an **empty ladder** immediately (counts toward the 3); no cancel; log lists "L1 locked +$x" | "Armed" flag, cancellable | Empty ladder, no cancel, same log |
| 21 | Max ladders | 3 (`LM_MAX`), empty ladder included | 3 | 3, empty included |
| 22 | Lot cap | **Hard cap** per ladder: balance/100 × `LotPer100` (0.10), rounded **down** to 0.01; recomputed from the current balance every pass; tickets (oldest first) that take a ladder over the cap are **closed by the manager** | Warning only at 0.1 lot per **$50** (twice the EA's size) | EA cap enforced; closes are logged "CAP ... CLOSED" and journaled as closed by manager |
| 23 | Lot cap changes | Only while no trade is open ("Lot cap change IGNORED while trades are open") | n/a | Same as EA |
| 24 | R (1R on the panel) | **Worst IF SL HITS seen** over the ladder's life (`jRiskMax`), measured only when every ticket has an SL. Grows when tickets are added or the SL is widened, never shrinks, no "before BE" condition | Frozen at the first SL; grew only on widening before BE; added tickets ignored | Same as EA |
| 25 | R in the journal | `net_R` = net / `risk_at_first_sl` (different from the panel's 1R) | Single R | Journal R = risk at first SL; `risk_max` stored too |
| 26 | IF CLOSED NOW | $ of open tickets at current price, `= x.xxR (1R = $y)`, "below 1R"; "(R unknown - no SL set yet)" | Same $ but with the frozen R | Same as EA |
| 27 | IF SL HITS / locked $ | Sum at each ticket's SL; **any ticket without SL → "NO SL - UNLIMITED LOSS"**; `= x% of balance` when negative, `(locked)` when ≥ 0 | Summed only tickets with SL | Same as EA |
| 28 | TOTAL IF SL HITS | Over all managed tickets, % of balance, "N unmanaged" | Not shown | Shown |
| 29 | Loss-at-SL % | −IF SL HITS / balance × 100 | Same formula on partial sums | Same as EA |
| 30 | Panel lines | Balance / cap / ladders; per ladder: side, tickets, lots, **worst entry**; SL, TP, avg, pips, BE status (`BE done` / `BE allowed` / `BE from <price>`); stage line with "locks $"; IF SL HITS; IF CLOSED NOW | Different fields (stage label, locked $, floating) | Same lines as EA. All ladders shown at once instead of `<` `>` pages; one MOVE TO BE per ladder instead of "the ladder on the page" |
| 31 | PLAN line | Not in v3.0-s5 (v3.0-s4 had avg stop pips + lot → loss at SL) | Not present | Not present (matches s5) |
| 32 | Stage/BE settings | Editable on the panel with order check: BE buffer < S2 lock < S2 trigger, S2 lock < S3 lock < S3 trigger, S2 trigger < S3 trigger; BE buffer < BE min | Constants | Settings page with the same check |
| 33 | Exit counting | closed_by SL / TP / manager / you / other (`DEAL_REASON`) | Single exit reason | Exit reason kept + closed_by counts |
| 34 | Journal fields | worst entry, first/final SL, SL edits, SL widened, risk at first SL, risk max, lots max, balance before/after, stage 2 time, MFE/MAE from **worst** entry in $ of price, exit giveback, auto SL refused | Spec fields only | EA fields added (spec MFE pips and 4 h post-close run kept) |
| 35 | Ladder numbering | L1..L3 by age among open ladders (renumbers when one closes) | Internal id | Rank like the EA |
| 36 | Ladder type toggle | No such thing | "ladder / normal" toggle per ladder | Removed; "normal" = unmanaged opposite tickets |

## Same in both (checked)

- Pips measured from the average: buy `(bid − avg) / 0.10`, sell `(avg − ask) / 0.10`.
- Stage 2 trigger at avg +50 (live average), stage 3 at +100 from the frozen average, runner after stage 3 (no more automatic moves).
- Stage 2 and stage 3 can fire on the same tick if price jumps.
- SL/TP sync copies your edit to every ticket of the ladder; TP 0 = none is copied.
- Buy SL/TP on bid, sell on ask (broker side).

## Not mirrored (and why)

| EA feature | Reason |
|---|---|
| Pending (limit/stop) orders and `EnforcePendingCap` | No pending orders in v1 (SPEC §9) |
| `MagicFilter`, `SyncSL`/`SyncTP` off | The simulator has only your manual tickets and always syncs (EA defaults) |
| State saved in terminal global variables / restart handling | A replay session is not resumed after a page reload |
| Broker rejections other than stops level, partial modifies | No broker server in the simulator |
| `LM_journal.csv` file format | The simulator exports its own CSV that includes the EA's fields |
| Panel pages `<` `>`, A-/A+ size | All ladders are shown at once; the panel is movable and collapsible |

## Simulator-only training features (not in the EA)

Speed lock, sounds (zone touch is an alert only; there is no auto-pause, like a real chart), setup tags, Excel journal, 4 h post-close run,
% of move captured, M1 screenshot at close, notes, stats page.
