"""Simulated MetaTrader 5 terminal + GoldLadderManager EA for testing Gold Replay LIVE without MT5.

    python live/bridge.py --fake

Implements the part of the `MetaTrader5` package the bridge uses (same function names, constants and
return shapes: namedtuples, list-of-dict rates/ticks). Prices are a random walk (server time = UTC+2).
A small EA stand-in groups trades into ladders, copies SL/TP edits, runs stages 2/3, MOVE TO BE and
NEW LADDER, and writes the same GLM_state_<symbol>.json as the real EA s6. It is NOT the EA: the real
logic lives in reference/LadderManager.mqh. Test on a demo account before trading real money.
"""

from __future__ import annotations

import collections
import json
import math
import os
import random
import threading
import time

IS_FAKE = True

TIMEFRAME_M1, TIMEFRAME_M15, TIMEFRAME_M30 = 1, 15, 30
POSITION_TYPE_BUY, POSITION_TYPE_SELL = 0, 1
ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
DEAL_TYPE_BUY, DEAL_TYPE_SELL = 0, 1
DEAL_ENTRY_IN, DEAL_ENTRY_OUT = 0, 1
DEAL_REASON_CLIENT, DEAL_REASON_EXPERT, DEAL_REASON_SL, DEAL_REASON_TP, DEAL_REASON_SO = 0, 3, 4, 5, 6
TRADE_ACTION_DEAL, TRADE_ACTION_SLTP = 1, 6
ORDER_TIME_GTC = 0
ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE, TRADE_RETCODE_DONE_PARTIAL = 10008, 10009, 10010
TRADE_RETCODE_INVALID_STOPS, TRADE_RETCODE_NO_CHANGES, TRADE_RETCODE_INVALID_FILL = 10016, 10025, 10030
TRADE_RETCODE_NO_MONEY = 10019
COPY_TICKS_INFO = 1
ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2

SYMBOL = "XAUUSD.m"
DIGITS = 2
CONTRACT = 100.0
PIP = 0.10
SERVER_OFFSET_MS = 2 * 3600 * 1000

Tick = collections.namedtuple("Tick", "time bid ask last volume time_msc flags volume_real")
Pos = collections.namedtuple("Pos", "ticket time time_msc type magic volume price_open sl tp price_current swap profit symbol comment")
Deal = collections.namedtuple(
    "Deal", "ticket order time time_msc type entry magic position_id reason volume price commission swap profit fee symbol comment"
)
Res = collections.namedtuple("Res", "retcode deal order volume price bid ask comment request_id")

_lock = threading.RLock()
_S: dict = {}


def _now_ms() -> int:
    return int(time.time() * 1000) + SERVER_OFFSET_MS


def setup(common_dir: str, balance: float = 50.0, price: float = 2650.0, speed: float = 1.0, ea: bool = True) -> None:
    """common_dir plays the terminals' Common folder (the EA files go to <common_dir>/Files)."""
    os.makedirs(os.path.join(common_dir, "Files"), exist_ok=True)
    _S.update(
        common=common_dir,
        balance=balance,
        bid=price,
        spread=0.20,
        ticks=collections.deque(maxlen=20000),
        m1={},  # bar time (s) -> [o, h, l, c]
        positions={},
        deals=[],
        next_ticket=1000,
        speed=speed,
        started=False,
        ea=_EA(),
        ea_on=ea,
    )
    # 3 days of M1 history (bars only), ending at the current minute
    rnd = random.Random(7)
    now_s = _now_ms() // 1000
    t0 = (now_s // 60 - 3 * 1440) * 60
    p = price - 25
    for t in range(t0, (now_s // 60) * 60, 60):
        o = p
        hi = lo = o
        for _ in range(6):
            p += rnd.gauss(0, 0.35)
            hi, lo = max(hi, p), min(lo, p)
        _S["m1"][t] = [round(o, 2), round(hi, 2), round(lo, 2), round(p, 2)]
    _S["bid"] = round(p, 2)
    _push_tick(_S["bid"])


def _tick_loop() -> None:
    rnd = random.Random()
    while True:
        time.sleep(0.12 / _S["speed"])
        with _lock:
            _S["bid"] = round(_S["bid"] + rnd.gauss(0, 0.09), 2)
            _push_tick(_S["bid"])
            _check_stops()
        if _S["ea_on"]:
            _S["ea"].run()


def _push_tick(bid: float) -> None:
    ms = _now_ms()
    ask = round(bid + _S["spread"], 2)
    _S["ticks"].append(Tick(ms // 1000, bid, ask, 0.0, 0, ms, 6, 0.0))
    t = (ms // 60000) * 60
    b = _S["m1"].get(t)
    if b is None:
        _S["m1"][t] = [bid, bid, bid, bid]
    else:
        b[1], b[2], b[3] = max(b[1], bid), min(b[2], bid), bid


def _check_stops() -> None:
    bid = _S["bid"]
    ask = round(bid + _S["spread"], 2)
    for p in list(_S["positions"].values()):
        buy = p["type"] == POSITION_TYPE_BUY
        px = bid if buy else ask
        if p["sl"] and (px <= p["sl"] if buy else px >= p["sl"]):
            _close(p, p["sl"], DEAL_REASON_SL)
        elif p["tp"] and (px >= p["tp"] if buy else px <= p["tp"]):
            _close(p, p["tp"], DEAL_REASON_TP)


def _profit(p: dict, price: float) -> float:
    d = 1 if p["type"] == POSITION_TYPE_BUY else -1
    return round(d * (price - p["price_open"]) * p["volume"] * CONTRACT, 2)


def _deal(p: dict, entry: int, price: float, reason: int, profit: float) -> None:
    ms = _now_ms()
    typ = p["type"] if entry == DEAL_ENTRY_IN else 1 - p["type"]
    _S["next_ticket"] += 1
    _S["deals"].append(
        Deal(_S["next_ticket"], _S["next_ticket"], ms // 1000, ms, typ, entry, 0, p["ticket"], reason, p["volume"], price,
             -0.0, 0.0, profit, 0.0, SYMBOL, "")
    )


def _close(p: dict, price: float, reason: int) -> None:
    pr = _profit(p, price)
    _S["balance"] = round(_S["balance"] + pr, 2)
    _deal(p, DEAL_ENTRY_OUT, price, reason, pr)
    del _S["positions"][p["ticket"]]


def nudge(by: float) -> None:
    """Test hook (bridge --fake only): jump the price by `by`."""
    with _lock:
        _S["bid"] = round(_S["bid"] + by, 2)
        _push_tick(_S["bid"])
        _check_stops()


# ------------------------------------------------------------------ package API


def initialize(*a, **k) -> bool:
    if not _S:
        setup(os.path.join(os.getcwd(), "fake_common"))
    if not _S["started"]:
        _S["started"] = True
        if _S["ea_on"]:
            _S["ea"].run()  # state file before the first tick, like an EA already on the chart
        threading.Thread(target=_tick_loop, daemon=True).start()
    return True


def shutdown() -> None:
    pass


def last_error():
    return (1, "Success")


def terminal_info():
    return collections.namedtuple("T", "commondata_path trade_allowed connected")(_S["common"], True, True)


def account_info():
    with _lock:
        eq = _S["balance"] + sum(_profit(p, _px_close(p)) for p in _S["positions"].values())
        margin = sum(p["volume"] * CONTRACT * p["price_open"] / 500 for p in _S["positions"].values())
        return collections.namedtuple("A", "login server name currency trade_mode leverage balance equity margin margin_free margin_level profit")(
            5550001, "FakeBroker-Demo", "Test", "USD", ACCOUNT_TRADE_MODE_DEMO, 500, _S["balance"], round(eq, 2),
            round(margin, 2), round(eq - margin, 2), round(eq / margin * 100, 2) if margin else 0.0, round(eq - _S["balance"], 2)
        )


def _px_close(p: dict) -> float:
    return _S["bid"] if p["type"] == POSITION_TYPE_BUY else round(_S["bid"] + _S["spread"], 2)


def symbol_info(name: str):
    if name != SYMBOL:
        return None
    return collections.namedtuple("S", "name digits point trade_contract_size trade_stops_level filling_mode volume_min volume_step volume_max visible")(
        SYMBOL, DIGITS, 0.01, CONTRACT, 0, 2, 0.01, 0.01, 100.0, True
    )


def symbols_get():
    return (symbol_info(SYMBOL),)


def symbol_select(name: str, enable: bool = True) -> bool:
    return name == SYMBOL


def symbol_info_tick(name: str):
    with _lock:
        return _S["ticks"][-1] if _S["ticks"] else None


def copy_ticks_from(name: str, date_from, count: int, flags: int):
    f = int(date_from) * 1000
    with _lock:
        return [t._asdict() for t in _S["ticks"] if t.time_msc >= f][:count]


def _bars(tf: int) -> list[dict]:
    with _lock:
        items = sorted(_S["m1"].items())
    if tf == TIMEFRAME_M1:
        return [{"time": t, "open": o, "high": h, "low": lo, "close": c, "tick_volume": 0, "spread": 20, "real_volume": 0} for t, (o, h, lo, c) in items]
    out: dict[int, dict] = {}
    for t, (o, h, lo, c) in items:
        k = t - t % (tf * 60)
        b = out.get(k)
        if b is None:
            out[k] = {"time": k, "open": o, "high": h, "low": lo, "close": c, "tick_volume": 0, "spread": 20, "real_volume": 0}
        else:
            b["high"], b["low"], b["close"] = max(b["high"], h), min(b["low"], lo), c
    return list(out.values())


def copy_rates_from_pos(name: str, tf: int, start: int, count: int):
    b = _bars(tf)
    return b[max(0, len(b) - start - count) : len(b) - start]


def copy_rates_range(name: str, tf: int, date_from, date_to):
    return [b for b in _bars(tf) if int(date_from) <= b["time"] <= int(date_to)]


def positions_get(symbol: str | None = None):
    with _lock:
        out = []
        for p in _S["positions"].values():
            px = _px_close(p)
            out.append(Pos(p["ticket"], p["time_msc"] // 1000, p["time_msc"], p["type"], 0, p["volume"], p["price_open"], p["sl"], p["tp"], px, 0.0, _profit(p, px), SYMBOL, ""))
        return tuple(out)


def history_deals_get(*a, position: int | None = None, **k):
    with _lock:
        return tuple(d for d in _S["deals"] if position is None or d.position_id == position)


def _res(code: int, comment: str, price: float = 0.0, order: int = 0):
    return Res(code, order, order, 0.0, price, _S["bid"], round(_S["bid"] + _S["spread"], 2), comment, 1)


def order_send(req: dict):
    with _lock:
        bid = _S["bid"]
        ask = round(bid + _S["spread"], 2)
        if req["action"] == TRADE_ACTION_DEAL:
            if req.get("type_filling") == ORDER_FILLING_FOK:
                return _res(TRADE_RETCODE_INVALID_FILL, "Unsupported filling mode")
            pos = req.get("position")
            if pos:
                p = _S["positions"].get(pos)
                if not p:
                    return _res(10036, "Position doesn't exist")
                _close(p, _px_close(p), DEAL_REASON_CLIENT)
                return _res(TRADE_RETCODE_DONE, "Request executed", _px_close(p), pos)
            buy = req["type"] == ORDER_TYPE_BUY
            _S["next_ticket"] += 1
            t = _S["next_ticket"]
            p = {"ticket": t, "time_msc": _now_ms(), "type": POSITION_TYPE_BUY if buy else POSITION_TYPE_SELL, "volume": req["volume"],
                 "price_open": ask if buy else bid, "sl": 0.0, "tp": 0.0}
            _S["positions"][t] = p
            _deal(p, DEAL_ENTRY_IN, p["price_open"], DEAL_REASON_CLIENT, 0.0)
            return _res(TRADE_RETCODE_DONE, "Request executed", p["price_open"], t)
        if req["action"] == TRADE_ACTION_SLTP:
            p = _S["positions"].get(req["position"])
            if not p:
                return _res(10036, "Position doesn't exist")
            sl, tp = round(req["sl"], 2), round(req["tp"], 2)
            buy = p["type"] == POSITION_TYPE_BUY
            if (sl and (sl >= bid if buy else sl <= ask)) or (tp and (tp <= bid if buy else tp >= ask)):
                return _res(TRADE_RETCODE_INVALID_STOPS, "Invalid stops")
            if sl == p["sl"] and tp == p["tp"]:
                return _res(TRADE_RETCODE_NO_CHANGES, "No changes")
            p["sl"], p["tp"] = sl, tp
            return _res(TRADE_RETCODE_DONE, "Request executed")
        return _res(10013, "Invalid request")


# ------------------------------------------------------------------ EA stand-in


class _EA:
    """Tiny stand-in for GoldLadderManager s6 so the live page can be tested. Not the EA."""

    def __init__(self) -> None:
        self.ladders: list[dict] = []
        self.counter = 0
        self.cur: int | None = None  # id of the ladder receiving new trades
        self.known: dict[int, tuple[float, float]] = {}
        self.cmd = {"seq": 0, "ok": False, "msg": ""}
        self.last_write = 0.0

    def _L(self, lid):
        return next((l for l in self.ladders if l["id"] == lid), None)

    def _new(self) -> dict:
        self.counter += 1
        L = {"id": self.counter, "side": -1, "stage": 0, "anchor": 0.0, "next": 0.0, "pending": 0.0, "sl": 0.0, "tp": 0.0,
             "riskSeen": False, "riskMax": 0.0, "firstSL": 0.0, "risk1": 0.0, "bePulled": False, "start": int(time.time()),
             "tickets": [], "had": False}
        self.ladders.append(L)
        self.cur = L["id"]
        return L

    def _pos(self, L) -> list[dict]:
        return [_S["positions"][t] for t in L["tickets"] if t in _S["positions"]]

    @staticmethod
    def _avg(ps) -> float:
        v = sum(p["volume"] for p in ps)
        return sum(p["price_open"] * p["volume"] for p in ps) / v if v else 0.0

    @staticmethod
    def _risk(ps):
        if any(not p["sl"] for p in ps):
            return None
        return sum(_profit(p, p["sl"]) for p in ps)

    def _modify(self, ps, sl=None, tp=None) -> None:
        for p in ps:
            if sl is not None:
                p["sl"] = sl
            if tp is not None:
                p["tp"] = tp
            self.known[p["ticket"]] = (p["sl"], p["tp"])

    def gate(self) -> str:
        cur = self._L(self.cur)
        if cur and not self._pos(cur):
            return f"L{self.rank(cur)} has no trades yet - use it first"
        if len(self.ladders) >= 3:
            return "maximum 3 ladders are open"
        for L in self.ladders:
            r = self._risk(self._pos(L))
            if r is None:
                return f"L{self.rank(L)} has a ticket with NO SL"
            if r < -0.005:
                return f"L{self.rank(L)} is not at BE yet (-${-r:.2f} if SL hits)"
        return ""

    def rank(self, L) -> int:
        return sorted(self.ladders, key=lambda x: x["id"]).index(L) + 1

    def command(self, line: str) -> None:
        parts = line.strip().split("|")
        if len(parts) < 2 or int(parts[0]) <= self.cmd["seq"]:
            return
        ok, msg = False, ""
        if parts[1] == "newLadder":
            why = self.gate()
            if why:
                msg = why
            else:
                L = self._new()
                ok, msg = True, f"L{self.rank(L)} opened | your next trades join L{self.rank(L)}"
        elif parts[1] == "moveToBE":
            L = self._L(int(parts[2]) if len(parts) > 2 else 0)
            ps = self._pos(L) if L else []
            if not ps:
                msg = "ladder not found"
            else:
                d = 1 if L["side"] == 0 else -1
                avg = self._avg(ps)
                bid = _S["bid"]
                px = bid if d > 0 else bid + _S["spread"]
                pips = d * (px - avg) / PIP
                be = round(avg + d * PIP, 2)
                if pips < 30 - 1e-6:
                    msg = f"L{self.rank(L)} TOO EARLY | price {pips:+.1f} pips from average {avg:.2f} | BE allowed from +30 pips"
                else:
                    pull = bool(L["sl"]) and d * (L["sl"] - be) > 1e-9
                    self._modify(ps, sl=be)
                    L["sl"] = be
                    if pull:
                        L["bePulled"], L["pending"] = True, 0.0
                    ok, msg = True, f"L{self.rank(L)} {'BE PULL-BACK' if pull else 'STAGE 1'} | SL -> {be:.2f} (average {avg:.2f} +1 pip)"
        else:
            msg = "unknown command"
        self.cmd = {"seq": int(parts[0]), "ok": ok, "msg": msg}

    def run(self) -> None:
        files = os.path.join(_S["common"], "Files")
        cmd = os.path.join(files, f"GLM_cmd_{SYMBOL}.txt")
        with _lock:
            if os.path.exists(cmd):
                with open(cmd, encoding="ascii") as f:
                    line = f.read()
                os.remove(cmd)
                self.command(line)
            owned = {t for L in self.ladders for t in L["tickets"]}
            for t, p in sorted(_S["positions"].items()):
                if t in owned:
                    continue
                cur = self._L(self.cur)
                if cur is None:
                    cur = self._new()
                if cur["side"] not in (-1, p["type"]):
                    continue  # opposite: unmanaged
                cur["side"] = p["type"]
                cur["tickets"].append(t)
                cur["had"] = True
                if cur["sl"] or cur["tp"]:
                    self._modify([p], sl=cur["sl"] or None, tp=cur["tp"] or None)
                else:
                    self.known[t] = (p["sl"], p["tp"])
            for L in list(self.ladders):
                ps = self._pos(L)
                if not ps:
                    if L["had"]:
                        self.ladders.remove(L)
                        if self.cur == L["id"]:
                            self.cur = self.ladders[-1]["id"] if self.ladders else None
                    continue
                # your edit on one ticket is copied to the ladder (manual always wins)
                for p in ps:
                    k = self.known.get(p["ticket"])
                    if k and (p["sl"], p["tp"]) != k:
                        if p["sl"] != k[0] and p["sl"]:
                            L["sl"], L["pending"] = p["sl"], 0.0
                        if p["tp"] != k[1]:
                            L["tp"] = p["tp"]
                        self._modify(ps, sl=L["sl"] or None, tp=L["tp"])
                        break
                d = 1 if L["side"] == 0 else -1
                px = _S["bid"] if d > 0 else _S["bid"] + _S["spread"]
                avg = self._avg(ps)
                better = lambda a, b: not b or d * (a - b) > 1e-9  # noqa: E731
                if L["stage"] == 0 and d * (px - avg) >= 50 * PIP - 1e-9:
                    L["stage"], L["anchor"], L["next"] = 2, avg, round(avg + d * 100 * PIP, 2)
                    tgt = round(avg + d * 20 * PIP, 2)
                    if better(tgt, L["sl"]):
                        L["sl"] = tgt
                        self._modify(ps, sl=tgt)
                if L["stage"] == 2 and d * (px - L["next"]) >= -1e-9:
                    L["stage"] = 3
                    tgt = round(L["anchor"] + d * 50 * PIP, 2)
                    if better(tgt, L["sl"]):
                        L["sl"] = tgt
                        self._modify(ps, sl=tgt)
                r = self._risk(ps)
                if r is not None:
                    if not L["riskSeen"]:
                        L["riskSeen"], L["firstSL"], L["risk1"], L["riskMax"] = True, L["sl"], r, r
                    L["riskMax"] = min(L["riskMax"], r)
            if time.time() - self.last_write >= 0.25:
                self.last_write = time.time()
                self.write(files)

    def write(self, files: str) -> None:
        why = self.gate()
        cap = math.floor(_S["balance"] / 100 * 0.10 * 100 + 1e-7) / 100
        st = {
            "version": "3.0-s6 (fake)", "symbol": SYMBOL, "time": _now_ms() // 1000, "lotCap": cap,
            "canNewLadder": why == "", "newLadderWhy": why, "cmd": self.cmd,
            "settings": {"beMin": 30, "beBuf": 1, "s2t": 50, "s2l": 20, "s3t": 100, "s3l": 50, "pip": PIP},
            "ladders": [
                {**{k: v for k, v in L.items() if k != "had"}, "rank": self.rank(L), "current": L["id"] == self.cur,
                 "tickets": [t for t in L["tickets"] if t in _S["positions"]]}
                for L in self.ladders
            ],
        }
        tmp = os.path.join(files, f"GLM_state_{SYMBOL}.tmp")
        with open(tmp, "w", encoding="ascii") as f:
            json.dump(st, f)
        os.replace(tmp, os.path.join(files, f"GLM_state_{SYMBOL}.json"))
