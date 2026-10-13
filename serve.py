"""Local server for the Gold Replay Simulator: serves app/ at / and data/ at /data/, opens the browser.

    python serve.py [--port 8765] [--no-browser]
"""

from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app")
DATA = os.path.join(ROOT, "data")


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
    print(f"Gold Replay Simulator running at {url}  (close this window to stop)")
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
