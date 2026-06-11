#!/usr/bin/env python3
"""
ClientIQ local dev server
- Serves index.html as a static file
- Proxies POST /api/messages → https://api.anthropic.com/v1/messages
  so the browser never hits Anthropic directly (avoids CORS entirely)

Usage:
    python3 server.py
    Then open http://localhost:8743
"""
import http.server
import json
import os
import urllib.error
import urllib.request

PORT = 8743
DIR  = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    # ── silence the default per-request stdout noise ──────────────────────────
    def log_message(self, fmt, *args):
        status = args[1] if len(args) > 1 else '?'
        path   = args[0] if args else self.path
        print(f"  [{status}] {path}")

    # ── CORS preflight ─────────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(200)
        self._add_cors()
        self.send_header(
            'Access-Control-Allow-Headers',
            'Content-Type, x-api-key, anthropic-version'
        )
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()

    # ── POST → only /api/messages is handled, everything else → 404 ───────────
    def do_POST(self):
        if self.path == '/api/messages':
            self._proxy()
        elif self.path == '/api/screen':
            self._proxy_screen()
        else:
            self.send_error(404, 'Not found')

    # ── /api/screen → deployed Vercel function (no key needed; the sanctions
    #    list logic lives in api/screen.js and isn't duplicated here) ──────────
    def _proxy_screen(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            req = urllib.request.Request(
                'https://tryclientiq.vercel.app/api/screen',
                data=body,
                headers={'content-type': 'application/json'},
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                self._respond(resp.status, raw=resp.read())
        except urllib.error.HTTPError as e:
            self._respond(e.code, raw=e.read())
        except Exception as e:
            print(f'  [screen proxy error] {e}')
            self._respond(502, {'error': {'message': str(e)}})

    # ── proxy logic ────────────────────────────────────────────────────────────
    def _proxy(self):
        try:
            length  = int(self.headers.get('Content-Length', 0))
            body    = self.rfile.read(length)
            api_key = self.headers.get('x-api-key', '').strip()

            if not api_key:
                return self._respond(400, {'error': {'message': 'x-api-key header is missing'}})

            req = urllib.request.Request(
                'https://api.anthropic.com/v1/messages',
                data    = body,
                headers = {
                    'x-api-key':          api_key,
                    'anthropic-version':  '2023-06-01',
                    'content-type':       'application/json',
                },
                method  = 'POST',
            )

            with urllib.request.urlopen(req, timeout=300) as resp:
                self._respond(resp.status, raw=resp.read())

        except urllib.error.HTTPError as e:
            self._respond(e.code, raw=e.read())
        except urllib.error.URLError as e:
            msg = f'Proxy could not reach api.anthropic.com: {e.reason}'
            print(f'  [proxy error] {msg}')
            self._respond(502, {'error': {'message': msg}})
        except Exception as e:
            print(f'  [proxy error] {e}')
            self._respond(500, {'error': {'message': str(e)}})

    # ── helpers ────────────────────────────────────────────────────────────────
    def _add_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')

    def _respond(self, code, body=None, raw=None):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self._add_cors()
        self.end_headers()
        if raw is not None:
            self.wfile.write(raw)
        elif body is not None:
            self.wfile.write(json.dumps(body).encode())


if __name__ == '__main__':
    server = http.server.HTTPServer(('', PORT), Handler)
    print(f'\n  ✦ ClientIQ  →  http://localhost:{PORT}')
    print(f'    static dir : {DIR}')
    print(f'    API proxy  : POST /api/messages  →  api.anthropic.com\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')
