#!/usr/bin/env python3
"""Serve the SidClock web remote (../web) over HTTPS for testing.

Web Bluetooth only exists in a *secure context*: `https`, or `http` on
`localhost` itself. A phone testing against this computer over Wi-Fi is
neither, so this wraps Python's stock HTTP server in TLS with a
self-signed certificate that is generated on first run. Browsers warn
once per device - accept the warning ("Advanced" -> "Proceed") and the
page gets a usable secure context.

No certificate warning at all: serve `web/` itself with
`python3 -m http.server 8000 --directory web` and put a quick tunnel in
front of it, `cloudflared tunnel --url http://localhost:8000` (the tunnel
URL then serves the page at its root - see docs/development.md).

    python3 tools/serve_web.py            # open https://<this-computer>:8443/
    python3 tools/serve_web.py 9443       # another port
    python3 tools/serve_web.py -v         # log every request (with its User-Agent)

Logging is quiet by default: only server-side errors are printed, so
stray background probes (a `/health` poller, for example) stay out of
the way; `-v` shows them with the client's User-Agent to identify them.

The certificate (tools/.devcert.pem, tools/.devkey.pem) is gitignored.
"""

import argparse
import http.server
import os
import socket
import ssl
import subprocess
import sys
from functools import partial

TOOLS = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.normpath(os.path.join(TOOLS, os.pardir, "web"))
CERT = os.path.join(TOOLS, ".devcert.pem")
KEY = os.path.join(TOOLS, ".devkey.pem")


def say(*parts):
    """print() that survives redirection (no buffering surprises)."""
    print(*parts, flush=True)


def lan_addresses():
    """Every IPv4 address this computer is reachable at, best effort."""
    addrs = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None,
                                       socket.AF_INET):
            addrs.add(info[4][0])
    except socket.gaierror:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # picks the default interface; no packet
        addrs.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(addrs)


def ensure_cert():
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    san = [f"IP:{a}" for a in lan_addresses()]
    san += ["DNS:localhost", "IP:::1"]
    say(f"creating a self-signed certificate for {', '.join(san)}")
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY, "-out", CERT, "-days", "825",
        "-subj", "/CN=sidclock-dev",
        "-addext", "subjectAltName=" + ",".join(san),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError:
        sys.exit("openssl not found - install it, or use a quick tunnel:\n"
                 "  python3 -m http.server 8000 --directory web\n"
                 "  cloudflared tunnel --url http://localhost:8000")
    except subprocess.CalledProcessError as e:
        sys.exit("openssl failed:\n" + e.stderr.decode(errors="replace"))


class Handler(http.server.SimpleHTTPRequestHandler):
    verbose = False

    def log_message(self, fmt, *args):
        pass  # replaced by log_request

    def log_request(self, code="-", size="-"):
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        if not self.verbose and status < 500:
            return
        line = f'{self.address_string()} {self.requestline} -> {code}'
        if self.verbose:
            line += f' [{self.headers.get("User-Agent", "?")}]'
        say(line)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser(
        description="Serve web/ over https for local testing")
    ap.add_argument("port", nargs="?", type=int, default=8443)
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="log every request with its User-Agent")
    args = ap.parse_args()

    if not os.path.isdir(WEB_ROOT):
        sys.exit(f"{WEB_ROOT} not found - run this from a repository checkout")

    ensure_cert()
    Handler.verbose = args.verbose

    try:
        httpd = http.server.ThreadingHTTPServer(
            ("0.0.0.0", args.port), partial(Handler, directory=WEB_ROOT))
    except OSError as e:
        sys.exit(f"cannot listen on port {args.port}: {e}")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    say("serving the SidClock web remote over https:")
    for a in lan_addresses():
        say(f"  https://{a}:{args.port}/")
    say("accept the certificate warning once per device "
        "(Advanced -> Proceed); Ctrl-C stops the server.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        say()


if __name__ == "__main__":
    main()
