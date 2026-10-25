"""Local server for the Gold Replay Simulator: serves app/ at / and data/ at /data/, opens the browser,
and keeps the permanent journal copy in journal/ (journal.xlsx, journal.json, images/).

    python serve.py [--port 8765] [--no-browser]
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app")
DATA = os.path.join(ROOT, "data")
JOURNAL = os.path.join(ROOT, "journal")
MAX_BODY = 50 * 1024 * 1024

sys.path.insert(0, ROOT)
from journal_store import JournalStore  # noqa: E402

store = JournalStore(JOURNAL)


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows can map .js to text/plain in the registry; module scripts need a JS type.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".bin": "application/octet-stream",
        ".svg": "image/svg+xml",
    }

    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/data/"):
            base, rel = DATA, clean[len("/data/") :]
        else:
            base, rel = APP, clean.lstrip("/")
        full = os.path.normpath(os.path.join(base, *[p for p in rel.split("/") if p not in ("", ".", "..")]))
        if not full.startswith(base):
            return os.path.join(APP, "index.html")
        return full

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes | None:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            self._json(400, {"error": "bad body size"})
            return None
        return self.rfile.read(n)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api/journal/status":
            return self._json(200, store.status())
        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        # Only the page itself (same origin) may write the journal.
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self._json(403, {"error": "forbidden"})
        if path == "/api/journal":
            body = self._body()
            if body is None:
                return
            try:
                data = json.loads(body)
                st = store.merge(data.get("header") or [], data.get("items") or [])
            except (ValueError, TypeError, AttributeError) as e:
                return self._json(400, {"error": str(e)})
            if st["waiting"]:
                print(f"JOURNAL waiting - close {store.xlsx_path} in Excel ({st['error']})")
            return self._json(200, st)
        if path.startswith("/api/shot/"):
            body = self._body()
            if body is None:
                return
            store.save_image(path[len("/api/shot/") :], body)
            return self._json(200, {"ok": True})
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(os.path.join(APP, "index.html")):
        sys.exit("app/index.html not found - build the app first (npm install && npm run build)")
    if not os.path.exists(os.path.join(DATA, "XAUUSD", "manifest.json")):
        print("NOTE: no data yet. Convert an MT5 tick export first:  python converter\\convert.py <export.csv>")
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
    print(f"Gold Replay Simulator running at {url}  (close this window to stop)")
    print(f"Journal Excel copy: {store.xlsx_path}")
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
