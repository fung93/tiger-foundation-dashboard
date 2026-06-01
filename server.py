#!/usr/bin/env python3
"""Tiger Foundation Dashboard - serves API and static files."""
import json, os, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

DASH_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(DASH_DIR, "data.json")
HISTORY_FILE = os.path.join(DASH_DIR, "history.json")

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/api/data", "/api/data/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE) as f:
                    self.wfile.write(f.read().encode())
            else:
                self.wfile.write(b'{"error":"no data"}')
            return

        if self.path in ("/api/history", "/api/history/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if os.path.exists(HISTORY_FILE):
                with open(HISTORY_FILE) as f:
                    self.wfile.write(f.read().encode())
            else:
                self.wfile.write(b'{"data":[]}')
            return

        if self.path in ("/", "/dashboard.html", "/dashboard"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            with open(os.path.join(DASH_DIR, "dashboard.html")) as f:
                self.wfile.write(f.read().encode())
            return

        if self.path in ("/local.html", "/local"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            with open(os.path.join(DASH_DIR, "local.html")) as f:
                self.wfile.write(f.read().encode())
            return

        # Serve static files (dashboard.js, etc.)
        if self.path.endswith(".js") or self.path.endswith(".css") or self.path.endswith(".json"):
            filepath = os.path.join(DASH_DIR, self.path.lstrip("/"))
            if os.path.exists(filepath):
                self.send_response(200)
                if self.path.endswith(".js"):
                    self.send_header("Content-Type", "application/javascript")
                elif self.path.endswith(".css"):
                    self.send_header("Content-Type", "text/css")
                else:
                    self.send_header("Content-Type", "application/json")
                self.end_headers()
                with open(filepath) as f:
                    self.wfile.write(f.read().encode())
                return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = HTTPServer(("0.0.0.0", port), Handler)
    print(f"Tiger Foundation Dashboard: http://0.0.0.0:{port}")
    server.serve_forever()
