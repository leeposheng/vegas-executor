import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

from vegas_executor import tg


def serve(status, body, extra=None):
    seen = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            seen["body"] = parse_qs(self.rfile.read(n).decode())
            seen["ctype"] = self.headers.get("Content-Type")
            self.send_response(status)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *a):
            pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, seen


def test_form_encoding_and_success():
    srv, seen = serve(200, '{"ok":true}')
    try:
        url = f"http://127.0.0.1:{srv.server_port}/x"
        status, text, _ = tg.urllib_fetch(url, {"method": "post", "contentType": "application/x-www-form-urlencoded",
                                                "payload": {"chat_id": "-100", "text": "中文 emoji 🧪\n第二行", "message_thread_id": "9"}})
    finally:
        srv.shutdown()
    assert status == 200 and json.loads(text)["ok"] is True
    assert seen["ctype"] == "application/x-www-form-urlencoded"
    assert seen["body"] == {"chat_id": ["-100"], "text": ["中文 emoji 🧪\n第二行"], "message_thread_id": ["9"]}


def test_http_error_returns_status_and_headers():
    srv, _ = serve(429, '{"ok":false}', {"Retry-After": "2"})
    try:
        status, text, headers = tg.urllib_fetch(f"http://127.0.0.1:{srv.server_port}/x", {"method": "post", "payload": {"a": "b"}})
    finally:
        srv.shutdown()
    assert status == 429 and headers.get("Retry-After") == "2"
