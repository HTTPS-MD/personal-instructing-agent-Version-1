"""TEST HARNESS ONLY: serves the hardened Worker on loopback so the Edge Function's
handler can call it for real. Usage: serve_harness.py <port> <token>"""
import asyncio, importlib.util, os, sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import stub_workers
stub_workers.install()
spec = importlib.util.spec_from_file_location("entry", os.path.join(HERE, "..", "src", "entry.py"))
entry = importlib.util.module_from_spec(spec); spec.loader.exec_module(entry)
PORT, TOKEN = int(sys.argv[1]), sys.argv[2]
LOG = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode() if n else ""
        if self.path == "/__seen":                      # what the service received
            out, status = json.dumps(LOG), 200
        else:
            LOG.append({"method": self.command, "path": self.path, "body": body,
                        "has_auth": "Authorization" in self.headers})
            w = entry.Default(); w.env = stub_workers.Env(ML_TOKEN=TOKEN, ML_MODEL=stub_workers.FakeKV())
            r = asyncio.run(w.fetch(stub_workers.FakeRequest(self.command, "http://x" + self.path,
                                                              {"Authorization": self.headers.get("Authorization", "")}, body)))
            out, status = r.body, r.status
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(out.encode())
    do_GET = do_POST = do_OPTIONS = do


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
