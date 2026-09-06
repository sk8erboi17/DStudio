"""Model-free HTTP fixture: accept a workflow, then stay running until cancelled."""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
args, _ = parser.parse_known_args()


class Handler(BaseHTTPRequestHandler):
    def reply(self, value):
        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.reply({"fixture": {"status": {"status_str": "running", "completed": False}}}
                   if self.path.startswith("/history/") else {})

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.reply({"prompt_id": "fixture"})


server = HTTPServer(("127.0.0.1", args.port), Handler)
Path("fixture.pid").write_text(str(os.getpid()))
server.serve_forever()
