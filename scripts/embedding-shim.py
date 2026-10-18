#!/usr/bin/env python3
"""llama.cpp-compatible embedding server backed by Ollama.

Atomic Agent's managed llama.cpp backend has no darwin-x64 build, so the
embedding daemon can never start on this Intel Mac. bootstrap.ts only needs
GET /health to answer and POST /embedding to return {"embedding": [...]} with
dim floats — this shim provides exactly that from Ollama's nomic-embed-text.

ponytail: single hard-coded model, one request at a time, no auth. Fine for a
173-note corpus on localhost; add batching/auth if a second consumer appears.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OLLAMA_URL = "http://127.0.0.1:11434/api/embed"
OLLAMA_MODEL = "nomic-embed-text"
EXPECTED_DIM = 768
PORT = 19092


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path.rstrip("/") in ("/health", ""):
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path.rstrip("/") != "/embedding":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "bad json"})
            return

        content = payload.get("content")
        if isinstance(content, list):
            content = content[0] if content else ""
        text = content if isinstance(content, str) else ""
        if not text:
            self._json(400, {"error": "content required"})
            return

        req = urllib.request.Request(
            OLLAMA_URL,
            data=json.dumps({"model": OLLAMA_MODEL, "input": text}).encode(),
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                vector = json.load(res)["embeddings"][0]
        except Exception as exc:  # transport/shape failure -> backend is unhealthy
            self._json(503, {"error": f"ollama: {exc}"})
            return

        if len(vector) != EXPECTED_DIM:
            self._json(503, {"error": f"dim {len(vector)} != {EXPECTED_DIM}"})
            return
        self._json(200, {"embedding": vector})

    def log_message(self, *args) -> None:
        pass


def selftest() -> int:
    """Runnable check: /health answers and /embedding returns EXPECTED_DIM."""
    import threading
    import time

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as r:
            assert json.load(r)["status"] == "ok", "health body"
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/embedding",
            data=json.dumps({"content": "hello"}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            vec = json.load(r)["embedding"]
        assert len(vec) == EXPECTED_DIM, f"dim {len(vec)}"
        print(f"selftest ok: /health + /embedding {len(vec)} dims")
        return 0
    finally:
        server.shutdown()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    # The TUI's reconcileHybridRecallFromDaemon() reads this pid file to decide
    # whether the embedding daemon is running; without it hybrid recall is
    # switched off at every boot even when this shim is healthy. It resolves
    # dataDir as cfg.paths.localModelsDataDir (<state>/models), so write both.
    pid = str(os.getpid())
    for path in (
        os.path.expanduser("~/.atomic-agent/llama-embed.pid"),
        os.path.expanduser("~/.atomic-agent/models/llama-embed.pid"),
    ):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(pid)
    print(f"embedding shim on :{PORT} -> {OLLAMA_URL} ({OLLAMA_MODEL}, {EXPECTED_DIM}d)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
