"""Gold Replay LIVE: the replay UI on your real MT5 terminal.

    python live/bridge.py [--symbol XAUUSD.m] [--port 8766] [--no-browser] [--fake]

Talks to the MetaTrader 5 terminal that is running and logged in on this PC through the official
`MetaTrader5` Python package (Windows), and serves the live page (app/live.html) on 127.0.0.1 only.

    prices, candles, positions, account   MetaTrader5 package (copy_rates / symbol_info_tick / positions_get)
    BUY / SELL / close / SL / TP          order_send, magic 0 = a manual trade, so the EA manages it
    ladders, stages, NEW LADDER, BE       the GoldLadderManager EA (v3.0-s6) on the XAUUSD chart:
                                          it writes Common\\Files\\GLM_state_<symbol>.json every second
                                          and runs commands from Common\\Files\\GLM_cmd_<symbol>.txt
    journal                               journal_live/journal.xlsx (+ journal.json, images/)

--fake runs a simulated terminal + EA (live/mt5_fake.py) for testing without MT5.
"""

from __future__ import annotations

import argparse
import http.server
import json
import math
import os
import socketserver
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
JOURNAL = os.path.join(ROOT, "journal_live")
MAX_BODY = 50 * 1024 * 1024
STATE_STALE_S = 5.0  # EA state older than this = EA not running
LOT_PER_100 = 0.10  # EA InpLotPer100: 0.10 lot per $100 of balance (0.05 for $50)
DEVIATION = 20  # points of slippage allowed on market orders

sys.path.insert(0, ROOT)
from journal_store import JournalStore  # noqa: E402

mt5 = None  # the MetaTrader5 module (or the fake), set in main()
lock = threading.RLock()  # the MetaTrader5 package is not thread safe
store = JournalStore(JOURNAL)
SYMBOL = ""
TF = {}


class BridgeError(Exception):
    pass


# ------------------------------------------------------------------ helpers


def rows(arr) -> list[dict]:
    """numpy structured array (real package) or list of dicts (fake) -> list of dicts."""
    if arr is None:
        return []
    names = getattr(getattr(arr, "dtype", None), "names", None)
    if names:
        return [{n: r[n].item() if hasattr(r[n], "item") else r[n] for n in names} for r in arr]
    return [dict(r) for r in arr]


def nt(obj) -> dict:
    """namedtuple (real package) or dict (fake) -> dict."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return dict(obj)
    return obj._asdict()


def last_error() -> str:
    try:
        code, text = mt5.last_error()
        return f"{text} ({code})"
    except Exception:  # noqa: BLE001
        return "unknown error"


def find_symbol(wanted: str) -> str:
    if wanted:
        if mt5.symbol_info(wanted) is None:
            raise SystemExit(f"Symbol {wanted} not found in MT5. Check the name in Market Watch.")
        return wanted
    for name in ("XAUUSD.m", "XAUUSD"):
        if mt5.symbol_info(name) is not None:
            return name
    for s in mt5.symbols_get() or ():
        if "XAUUSD" in nt(s)["name"].upper():
            return nt(s)["name"]
    raise SystemExit("No XAUUSD symbol found in MT5. Start with --symbol <name> (as shown in Market Watch).")


def sym() -> dict:
    s = nt(mt5.symbol_info(SYMBOL))
    if not s:
        raise BridgeError(f"symbol_info failed: {last_error()}")
    return s


def tick() -> dict:
    t = nt(mt5.symbol_info_tick(SYMBOL))
    if not t:
        raise BridgeError(f"no price for {SYMBOL}: {last_error()}")
    return t


def account() -> dict:
    a = nt(mt5.account_info())
    if not a:
        raise BridgeError(f"account_info failed - is MT5 logged in? {last_error()}")
    return a


def lot_cap(balance: float) -> float:
    return math.floor(balance / 100.0 * LOT_PER_100 * 100 + 1e-7) / 100


def bars(tf: str, count: int) -> list[dict]:
    r = rows(mt5.copy_rates_from_pos(SYMBOL, TF[tf], 0, count))
    return [{"time": int(b["time"]), "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"]} for b in r]


def positions() -> list[dict]:
    out = []
    for p in mt5.positions_get(symbol=SYMBOL) or ():
        p = nt(p)
        out.append(
            {
                "ticket": int(p["ticket"]),
                "dir": "buy" if p["type"] == mt5.POSITION_TYPE_BUY else "sell",
                "lot": p["volume"],
                "openPrice": p["price_open"],
                "openTime": int(p.get("time_msc") or p["time"] * 1000),
                "sl": p["sl"] or None,
                "tp": p["tp"] or None,
                "profit": round(p["profit"] + p.get("swap", 0.0), 2),
                "magic": int(p.get("magic", 0)),
            }
        )
    return out


def common_files() -> str:
    return os.path.join(nt(mt5.terminal_info())["commondata_path"], "Files")


def ea_state() -> dict | None:
    path = os.path.join(common_files(), f"GLM_state_{SYMBOL}.json")
    try:
        age = time.time() - os.path.getmtime(path)
        with open(path, encoding="ascii", errors="replace") as f:
            st = json.load(f)
    except (OSError, ValueError):  # missing, or being replaced by the EA right now
        return ea_state.last if ea_state.last and time.time() - ea_state.last_read < 2 else None
    st["age"] = round(age, 1)
    st["running"] = age < STATE_STALE_S
    ea_state.last, ea_state.last_read = st, time.time()
    return st


ea_state.last = None
ea_state.last_read = 0.0


def filling_modes(s: dict) -> list[int]:
    fm = s.get("filling_mode", 0)
    modes = []
    if fm & 1:
        modes.append(mt5.ORDER_FILLING_FOK)
    if fm & 2:
        modes.append(mt5.ORDER_FILLING_IOC)
    modes.append(mt5.ORDER_FILLING_RETURN)
    return modes


def send(req: dict, s: dict) -> dict:
    """order_send, trying the symbol's filling modes; returns {ok, retcode, comment, ...}."""
    res = None
    for fill in filling_modes(s):
        res = nt(mt5.order_send({**req, "type_filling": fill}))
        if not res:
            return {"ok": False, "retcode": -1, "comment": f"order_send failed: {last_error()}"}
        if res["retcode"] != mt5.TRADE_RETCODE_INVALID_FILL:
            break
    ok = res["retcode"] in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL)
    return {"ok": ok, "retcode": res["retcode"], "comment": res.get("comment", ""), "order": res.get("order", 0), "price": res.get("price", 0)}


# ------------------------------------------------------------------ API


def api_init() -> dict:
    s, a, t = sym(), account(), tick()
    term = nt(mt5.terminal_info())
    return {
        "symbol": SYMBOL,
        "digits": s["digits"],
        "point": s["point"],
        "contractSize": s["trade_contract_size"],
        "stopsLevel": s.get("trade_stops_level", 0),
        "volumeMin": s.get("volume_min", 0.01),
        "volumeStep": s.get("volume_step", 0.01),
        "account": {
            "login": a["login"],
            "server": a["server"],
            "name": a.get("name", ""),
            "currency": a["currency"],
            "mode": {mt5.ACCOUNT_TRADE_MODE_DEMO: "DEMO", mt5.ACCOUNT_TRADE_MODE_CONTEST: "CONTEST"}.get(a["trade_mode"], "REAL"),
            "leverage": a.get("leverage", 0),
        },
        "tradeAllowed": bool(term.get("trade_allowed", True)),
        "commonFiles": common_files(),
        "fake": getattr(mt5, "IS_FAKE", False),
        "time": int(t["time_msc"]),
    }


def api_rates(q: dict) -> dict:
    tf = q.get("tf", "M1")
    if tf not in TF:
        raise BridgeError(f"unknown timeframe {tf}")
    return {"tf": tf, "bars": bars(tf, max(10, min(int(q.get("count", 1500)), 20000)))}


def api_poll(q: dict) -> dict:
    since = int(q.get("since", 0) or 0)
    t = tick()
    out = {
        "quote": {"time": int(t["time_msc"]), "bid": t["bid"], "ask": t["ask"]},
        "bars": {tf: bars(tf, 2) for tf in TF},
        "positions": positions(),
        "ea": ea_state(),
        "tradeAllowed": bool(nt(mt5.terminal_info()).get("trade_allowed", True)),
    }
    a = account()
    out["account"] = {k: a.get(k) for k in ("balance", "equity", "margin", "margin_free", "margin_level", "profit")}
    out["lotCap"] = lot_cap(a["balance"])
    # bid range of every tick since the last poll (zone alerts must not miss a quick touch)
    if since:
        tk = rows(mt5.copy_ticks_from(SYMBOL, int(since / 1000) - 1, 5000, mt5.COPY_TICKS_INFO))
        bids = [x["bid"] for x in tk if int(x["time_msc"]) > since and x["bid"] > 0]
        if bids:
            out["range"] = [min(bids), max(bids)]
    return out


def ladder_lots(st: dict | None, pos: list[dict], d: str) -> float:
    """Lots already in the ladder a new `d` trade would join (the EA's current ladder)."""
    if st and st.get("running"):
        cur = next((l for l in st["ladders"] if l.get("current")), None)
        if cur is None:
            return 0.0
        side = "buy" if cur["side"] == 0 else "sell" if cur["side"] == 1 else None
        if side not in (None, d):
            return 0.0  # opposite trade: unmanaged, the cap does not apply
        ids = set(cur["tickets"])
        return sum(p["lot"] for p in pos if p["ticket"] in ids)
    return sum(p["lot"] for p in pos if p["dir"] == d)


def api_order(b: dict) -> dict:
    d = b.get("dir")
    lot = round(float(b.get("lot", 0)), 2)
    if d not in ("buy", "sell") or lot <= 0:
        raise BridgeError("bad order")
    s, a, t = sym(), account(), tick()
    st = ea_state()
    cap = lot_cap(a["balance"])
    have = ladder_lots(st, positions(), d)
    if have + lot > cap + 1e-9:
        return {
            "ok": False,
            "comment": f"LOT CAP: {have:.2f} + {lot:.2f} lot is over the cap of {cap:.2f} lot per ladder "
            f"(0.10 lot per $100 of ${a['balance']:.2f}). Not sent.",
        }
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": SYMBOL,
        "volume": lot,
        "type": mt5.ORDER_TYPE_BUY if d == "buy" else mt5.ORDER_TYPE_SELL,
        "price": t["ask"] if d == "buy" else t["bid"],
        "deviation": DEVIATION,
        "magic": 0,
        "comment": "Gold Replay live",
        "type_time": mt5.ORDER_TIME_GTC,
    }
    return send(req, s)


def api_close(b: dict) -> dict:
    s = sym()
    want = {int(x) for x in b.get("tickets", [])}
    results = []
    for p in positions():
        if p["ticket"] not in want:
            continue
        t = tick()
        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": SYMBOL,
            "position": p["ticket"],
            "volume": p["lot"],
            "type": mt5.ORDER_TYPE_SELL if p["dir"] == "buy" else mt5.ORDER_TYPE_BUY,
            "price": t["bid"] if p["dir"] == "buy" else t["ask"],
            "deviation": DEVIATION,
            "magic": 0,
            "comment": "Gold Replay live close",
            "type_time": mt5.ORDER_TIME_GTC,
        }
        results.append({"ticket": p["ticket"], **send(req, s)})
    return {"ok": bool(results) and all(r["ok"] for r in results), "results": results}


def api_modify(b: dict) -> dict:
    """items: [{ticket, sl, tp}] - sl/tp null or 0 = none; a missing key keeps the current value."""
    cur = {p["ticket"]: p for p in positions()}
    results = []
    for it in b.get("items", []):
        p = cur.get(int(it.get("ticket", 0)))
        if not p:
            results.append({"ticket": it.get("ticket"), "ok": False, "comment": "position not open"})
            continue
        sl = it["sl"] if "sl" in it else p["sl"]
        tp = it["tp"] if "tp" in it else p["tp"]
        req = {"action": mt5.TRADE_ACTION_SLTP, "symbol": SYMBOL, "position": p["ticket"], "sl": float(sl or 0), "tp": float(tp or 0)}
        res = nt(mt5.order_send(req))
        if not res:
            results.append({"ticket": p["ticket"], "ok": False, "comment": f"order_send failed: {last_error()}"})
            continue
        ok = res["retcode"] in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_NO_CHANGES)
        results.append({"ticket": p["ticket"], "ok": ok, "retcode": res["retcode"], "comment": res.get("comment", "")})
    return {"ok": bool(results) and all(r["ok"] for r in results), "results": results}


def api_ea(b: dict) -> dict:
    action = b.get("action")
    if action not in ("newLadder", "moveToBE"):
        raise BridgeError("unknown EA command")
    st = ea_state()
    if not st or not st.get("running"):
        return {"ok": False, "comment": "The EA is not running: attach GoldLadderManager (v3.0-s6) to the "
                f"{SYMBOL} chart with Algo Trading on."}
    seq = int(time.time() * 1000)
    folder = common_files()
    tmp = os.path.join(folder, f"GLM_cmd_{SYMBOL}.tmp")
    with open(tmp, "w", encoding="ascii") as f:
        f.write(f"{seq}|{action}|{int(b.get('ladderId', 0))}")
    os.replace(tmp, os.path.join(folder, f"GLM_cmd_{SYMBOL}.txt"))
    return {"ok": True, "seq": seq}


def api_deals(b: dict) -> dict:
    """Deals of the given position tickets (journal of a closed ladder)."""
    out = []
    for tk in b.get("tickets", []):
        for d in mt5.history_deals_get(position=int(tk)) or ():
            d = nt(d)
            out.append(
                {
                    "ticket": int(d["ticket"]),
                    "position": int(d["position_id"]),
                    "time": int(d.get("time_msc") or d["time"] * 1000),
                    "entry": {mt5.DEAL_ENTRY_IN: "in", mt5.DEAL_ENTRY_OUT: "out"}.get(d["entry"], "inout"),
                    "dir": "buy" if d["type"] == mt5.DEAL_TYPE_BUY else "sell",
                    "lot": d["volume"],
                    "price": d["price"],
                    "profit": d["profit"],
                    "commission": d.get("commission", 0.0),
                    "swap": d.get("swap", 0.0),
                    "fee": d.get("fee", 0.0),
                    "reason": int(d.get("reason", 0)),
                }
            )
    out.sort(key=lambda x: x["time"])
    return {"deals": out}


def api_range(q: dict) -> dict:
    """High / low of M1 bars between two times (ms): MFE/MAE and the 4 h post-close run."""
    f, t = int(q["from"]) // 1000, int(q["to"]) // 1000
    r = rows(mt5.copy_rates_range(SYMBOL, TF["M1"], f - 60, t))
    r = [b for b in r if f - 60 < int(b["time"]) <= t]
    if not r:
        return {"high": None, "low": None, "last": None}
    return {"high": max(b["high"] for b in r), "low": min(b["low"] for b in r), "last": int(r[-1]["time"]) * 1000 + 60_000}


# ------------------------------------------------------------------ HTTP


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean in ("", "/"):
            clean = "/live.html"
        rel = [p for p in clean.split("/") if p not in ("", ".", "..")]
        full = os.path.normpath(os.path.join(APP, *rel))
        return full if full.startswith(APP) else os.path.join(APP, "live.html")

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _trusted(self, trading: bool = True) -> bool:
        # Only this page may use the API: right Host (no DNS rebinding), same Origin, and for anything that
        # touches the terminal a custom header (a page on another site cannot send it without a CORS
        # preflight, which is never answered). The journal upload (shared with the simulator) needs no header.
        host = self.headers.get("Host", "")
        if host not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"):
            return False
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{host}":
            return False
        return not trading or self.headers.get("X-Gold-Replay") == "live"

    def _query(self) -> dict:
        from urllib.parse import parse_qsl, urlsplit

        return dict(parse_qsl(urlsplit(self.path).query))

    def _call(self, fn, arg) -> None:
        try:
            with lock:
                res = fn(arg) if arg is not None else fn()
            self._json(200, res)
        except BridgeError as e:
            self._json(502, {"error": str(e)})
        except (KeyError, ValueError, TypeError) as e:
            self._json(400, {"error": f"{type(e).__name__}: {e}"})

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            if not self._trusted(trading=path.startswith("/api/live/")):
                return self._json(403, {"error": "forbidden"})
            if path == "/api/live/init":
                return self._call(api_init, None)
            if path == "/api/live/poll":
                return self._call(api_poll, self._query())
            if path == "/api/live/rates":
                return self._call(api_rates, self._query())
            if path == "/api/live/range":
                return self._call(api_range, self._query())
            if path == "/api/journal/status":
                return self._json(200, store.status())
            return self._json(404, {"error": "not found"})
        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if not self._trusted(trading=not (path == "/api/journal" or path.startswith("/api/shot/"))):
            return self._json(403, {"error": "forbidden"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._json(400, {"error": "bad body size"})
        raw = self.rfile.read(n)
        if path.startswith("/api/shot/"):
            store.save_image(path[len("/api/shot/") :], raw)
            return self._json(200, {"ok": True})
        try:
            body = json.loads(raw)
        except ValueError:
            return self._json(400, {"error": "bad json"})
        routes = {"/api/live/order": api_order, "/api/live/close": api_close, "/api/live/modify": api_modify,
                  "/api/live/ea": api_ea, "/api/live/deals": api_deals}
        if path in routes:
            if path != "/api/live/deals":
                print(f"{time.strftime('%H:%M:%S')} {path[10:].upper()} {json.dumps(body)}")
            return self._call(routes[path], body)
        if path == "/api/fake/nudge" and getattr(mt5, "IS_FAKE", False):
            mt5.nudge(float(body.get("by", 0)))
            return self._json(200, {"ok": True})
        if path == "/api/journal":
            try:
                st = store.merge(body.get("header") or [], body.get("items") or [])
            except (TypeError, AttributeError) as e:
                return self._json(400, {"error": str(e)})
            if st["waiting"]:
                print(f"JOURNAL waiting - close {store.xlsx_path} in Excel ({st['error']})")
            return self._json(200, st)
        self._json(404, {"error": "not found"})

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # quiet
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    global mt5, SYMBOL, TF
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="", help="MT5 symbol (default: XAUUSD.m, XAUUSD or the first XAUUSD* symbol)")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--fake", action="store_true", help="simulated terminal + EA, no MT5 needed (testing)")
    ap.add_argument("--fake-dir", default="", help="--fake: folder used as the terminals' Common folder")
    ap.add_argument("--fake-no-ea", action="store_true", help="--fake: no EA on the chart")
    a = ap.parse_args()

    if a.fake:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import mt5_fake

        mt5_fake.setup(a.fake_dir or os.path.join(ROOT, "journal_live", "fake_common"), ea=not a.fake_no_ea)
        mt5 = mt5_fake
    else:
        try:
            import MetaTrader5  # noqa: N813
        except ImportError:
            sys.exit("The MetaTrader5 package is missing. Run:  python -m pip install MetaTrader5")
        mt5 = MetaTrader5
    if not mt5.initialize():
        sys.exit(f"Could not connect to MetaTrader 5 ({last_error()}). Start MT5, log in to your account, and try again.")
    TF = {"M1": mt5.TIMEFRAME_M1, "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30}
    SYMBOL = find_symbol(a.symbol)
    mt5.symbol_select(SYMBOL, True)
    if not os.path.exists(os.path.join(APP, "live.html")):
        sys.exit("app/live.html not found - build the app first (npm install && npm run build)")

    info = api_init()
    acc = info["account"]
    port = a.port
    for _ in range(20):
        try:
            httpd = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.exit("no free port found")
    url = f"http://127.0.0.1:{port}/"
    store.start_retry_thread()
    print(f"Gold Replay LIVE on {SYMBOL} | account {acc['login']} {acc['server']} | {acc['mode']} | {acc['currency']}")
    if not info["tradeAllowed"]:
        print("WARNING: Algo Trading is OFF in MT5 - orders from this page will be refused. Turn it on (toolbar button).")
    st = ea_state()
    print("EA state: " + (f"v{st.get('version')} running" if st and st.get("running") else
                          f"NOT FOUND - attach GoldLadderManager v3.0-s6 to the {SYMBOL} chart (looked in {info['commonFiles']})"))
    print(f"Open {url}   (close this window to stop)   journal: {store.xlsx_path}")
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
