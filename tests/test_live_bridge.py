"""Gold Replay LIVE bridge against the fake MT5 terminal (no MetaTrader 5 needed).

    python -m unittest discover -s tests -p "test_*.py"
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "live"))
sys.path.insert(0, ROOT)

import bridge  # noqa: E402
import mt5_fake  # noqa: E402


class LiveBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        mt5_fake.setup(os.path.join(cls.tmp.name, "common"), balance=50.0)
        bridge.mt5 = mt5_fake
        bridge.store = bridge.JournalStore(os.path.join(cls.tmp.name, "journal_live"))
        mt5_fake.initialize()
        bridge.TF = {"M1": mt5_fake.TIMEFRAME_M1, "M15": mt5_fake.TIMEFRAME_M15, "M30": mt5_fake.TIMEFRAME_M30}
        bridge.SYMBOL = bridge.find_symbol("")
        cls.httpd = bridge.Server(("127.0.0.1", 0), bridge.Handler)
        cls.port = cls.httpd.server_port
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        time.sleep(0.5)  # first EA state file

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def req(self, path, body=None, header=True, origin=None):
        h = {"Content-Type": "application/json"}
        if header:
            h["X-Gold-Replay"] = "live"
        if origin:
            h["Origin"] = origin
        data = None if body is None else json.dumps(body).encode()
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=5) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def positions(self):
        return self.req("/api/live/poll?since=0")[1]["positions"]

    def close_all(self):
        self.req("/api/live/close", {"tickets": [p["ticket"] for p in self.positions()]})
        time.sleep(0.4)

    def test_requests_without_the_page_header_or_from_another_site_are_refused(self):
        self.assertEqual(self.req("/api/live/init", header=False)[0], 403)
        self.assertEqual(self.req("/api/live/order", {"dir": "buy", "lot": 0.01}, header=False)[0], 403)
        self.assertEqual(self.req("/api/live/order", {"dir": "buy", "lot": 0.01}, origin="http://evil.example")[0], 403)
        # journal upload (shared with the simulator page) needs only the same origin
        self.assertEqual(self.req("/api/journal", {"header": ["id"], "items": []}, header=False)[0], 200)
        self.assertEqual(self.req("/api/journal", {"header": ["id"], "items": []}, header=False, origin="http://evil.example")[0], 403)
        self.assertEqual(self.positions(), [])

    def test_init_poll_and_rates(self):
        code, info = self.req("/api/live/init")
        self.assertEqual(code, 200)
        self.assertEqual((info["symbol"], info["digits"], info["contractSize"], info["account"]["mode"]), ("XAUUSD.m", 2, 100.0, "DEMO"))
        p = self.req("/api/live/poll?since=0")[1]
        self.assertEqual(set(p["bars"]), {"M1", "M15", "M30"})
        self.assertEqual(p["lotCap"], 0.05)
        self.assertTrue(p["ea"]["running"])
        bars = self.req("/api/live/rates?tf=M15&count=50")[1]["bars"]
        self.assertEqual(len(bars), 50)
        self.assertTrue(all(b["time"] % 900 == 0 for b in bars))

    def test_order_cap_modify_ea_close_and_deals(self):
        ok = self.req("/api/live/order", {"dir": "buy", "lot": 0.03})[1]
        self.assertTrue(ok["ok"], ok)  # FOK refused by the fake broker -> retried with IOC
        time.sleep(0.4)  # the EA puts it into L1
        over = self.req("/api/live/order", {"dir": "buy", "lot": 0.03})[1]
        self.assertFalse(over["ok"])
        self.assertIn("LOT CAP", over["comment"])
        (p,) = self.positions()
        sl = round(p["openPrice"] - 2, 2)
        m = self.req("/api/live/modify", {"items": [{"ticket": p["ticket"], "sl": sl}]})[1]
        self.assertTrue(m["ok"], m)
        self.assertEqual(self.positions()[0]["sl"], sl)
        wrong = self.req("/api/live/modify", {"items": [{"ticket": p["ticket"], "sl": round(p["openPrice"] + 50, 2)}]})[1]
        self.assertFalse(wrong["ok"])
        cmd = self.req("/api/live/ea", {"action": "newLadder"})[1]
        self.assertTrue(cmd["ok"])
        time.sleep(0.6)
        st = self.req("/api/live/poll?since=0")[1]["ea"]
        self.assertEqual(st["cmd"]["seq"], cmd["seq"])
        self.assertFalse(st["cmd"]["ok"])  # L1 is not at BE yet
        self.assertIn("not at BE", st["cmd"]["msg"])
        c = self.req("/api/live/close", {"tickets": [p["ticket"]]})[1]
        self.assertTrue(c["ok"], c)
        deals = self.req("/api/live/deals", {"tickets": [p["ticket"]]})[1]["deals"]
        self.assertEqual([d["entry"] for d in deals], ["in", "out"])
        self.assertEqual(deals[1]["reason"], 0)

    def test_unknown_ea_command_is_rejected(self):
        self.assertEqual(self.req("/api/live/ea", {"action": "deleteEverything"})[0], 502)

    def tearDown(self):
        self.close_all()


if __name__ == "__main__":
    unittest.main()
