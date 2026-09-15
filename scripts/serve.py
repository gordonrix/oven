#!/usr/bin/env python3
"""
Static server for the demo pages in media/.

    python3 scripts/serve.py [port]

Identical to `python3 -m http.server` except that it makes the browser
revalidate. The bundles are large and keep the same URL across edits, and
http.server sends a Last-Modified with no Cache-Control -- so a browser applies
heuristic freshness and can go on running a copy of media/index.umd.js from
before your change without ever asking. That failure is silent and very
confusing: the file on disk, the file the server returns, and the file the page
is executing all differ, and only the last one matters.

`no-cache` rather than `no-store`: the copy is still kept, so an unchanged
bundle comes back as a 304 instead of 7MB. no-store re-downloads it on every
page load, which is slow enough to make the browser suites time out.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass          # the demos pull megabytes; the access log drowns output


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8742
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
