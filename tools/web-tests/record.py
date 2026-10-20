#!/usr/bin/env python3
"""Serve the repository and record browser-test results.

    python3 tools/web-tests/record.py &
    google-chrome --headless=new --disable-gpu \\
        "http://127.0.0.1:8901/tools/web-tests/index.html?record&live"

The test page (with ?record) POSTs its output to /__result__ after every
test and once more with ?done=1 when it is finished; this script prints
the output as it arrives and exits:

    0  the last report has no failures
    1  the last report has failures
    2  no finished report arrived within --timeout seconds

It is only for automated runs; opening index.html in a browser works on
its own.
"""

import argparse
import http.server
import socketserver
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[2]


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = 'sidclock-test/1.0'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != '/__result__':
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8', 'replace')
        self.send_response(204)
        self.end_headers()
        server = self.server
        # per-test reports are not awaited by the page: a straggler can
        # arrive after the ?done=1 report, so latch the finished one
        if 'done' in parse_qs(url.query):
            server.result = body
            server.done.set()
        elif not server.done.is_set():
            server.result = body

    def log_message(self, *args):
        pass  # keep the output clean; results are printed by main()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8901)
    ap.add_argument('--timeout', type=float, default=300.0,
                    help='give up after this many seconds')
    ap.add_argument('--out', type=Path, default=None,
                    help='also write the final report to this file')
    args = ap.parse_args()

    with Server(('127.0.0.1', args.port), Handler) as server:
        server.result = ''
        server.done = threading.Event()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        print(f'serving {ROOT} on http://127.0.0.1:{args.port}/ '
              f'(waiting for a finished report)', flush=True)
        finished = server.done.wait(timeout=args.timeout)
        server.shutdown()
        if not finished:
            print('timed out waiting for the test page', file=sys.stderr)
            if server.result:
                print(server.result, file=sys.stderr)
            return 2

    text = server.result
    if args.out:
        args.out.write_text(text, encoding='utf-8')
    print(text, end='')
    return 1 if 'FAILED' in text else 0


if __name__ == '__main__':
    sys.exit(main())
