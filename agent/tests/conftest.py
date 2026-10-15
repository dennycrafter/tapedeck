"""Shared pytest setup for the downloader suite (SPEC 9.0).

Run with `pytest` from /agent. The downloader targets Python 3.12 on the
owner's Windows PC; the build sandbox runs 3.13, so the suite is written
to pass on both (see docs/DECISIONS.md).

The FakeAgentServer below stands in for the Tapedeck web app's
/api/agent/* endpoints (SPEC 8.3), so the real `requests` client code is
exercised over real localhost HTTP with no mocking of the transport.
"""

import json
import logging
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENT_DIR.parent
TEST_AUDIO = REPO_ROOT / "web" / "public" / "test-audio" / "test1.m4a"

# Let `import downloader` work no matter where pytest is invoked from.
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


def make_track(**overrides):
    """A valid POST /api/agent/claim row (SPEC 8.3), tweakable per test."""
    row = {
        "id": "tr1",
        "source": "youtube",
        "source_url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        "title": "Me at the zoo",
        "artist": "jawed",
        "album": None,
        "cover_url": None,
        "duration_sec": 180,
        "apple_music": False,
    }
    row.update(overrides)
    return row


class FakeAgentServer:
    """Stands in for the app: claim, upload-url, PUT, complete, fail.

    Default responses are sensible; a test overrides any endpoint by
    assigning `server.respond[path] = (status, payload)` where payload is
    a JSON-serialisable object or raw bytes. Every request is recorded in
    `server.requests` as a dict with method, path, headers and body.
    """

    def __init__(self) -> None:
        self.requests = []
        self.respond = {}
        self._lock = threading.Lock()
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self, method: str) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                record = {
                    "method": method,
                    "path": self.path,
                    "headers": dict(self.headers),
                    "body": body,
                }
                with server._lock:
                    server.requests.append(record)
                status, payload = server._response_for(method, self.path)
                if isinstance(payload, bytes):
                    data, content_type = payload, "application/octet-stream"
                else:
                    data = (json.dumps(payload) + "\n").encode()
                    content_type = "application/json"
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:
                self._handle("POST")

            def do_PUT(self) -> None:
                self._handle("PUT")

            def do_GET(self) -> None:
                # Cover art URLs are fetched with plain GET (SPEC 8.3).
                self._handle("GET")

            def log_message(self, *args) -> None:  # silence the default stderr log
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def _response_for(self, method: str, path: str):
        """Route table: configured override, then the SPEC 8.3 defaults."""
        override = self.respond.get(path)
        if override is not None:
            status, payload = override
            return status, payload
        if path == "/api/agent/claim":
            return 200, []
        if path == "/api/agent/upload-url":
            return 200, {"url": f"{self.url}/put", "key": "tracks/tr1.m4a"}
        if path.startswith("/put"):
            return 200, {}
        if path == "/api/agent/complete":
            return 200, {}
        if path == "/api/agent/fail":
            return 200, {}
        if path == "/api/agent/settings":
            # GET /api/agent/settings: the Apple Music export toggle is
            # off unless a test overrides it (SPEC 8.3, 8.11).
            return 200, {"apple_music_export": False}
        if path == "/api/agent/apple-music-done":
            # POST /api/agent/apple-music-done: recorded, 200 {ok: true}.
            return 200, {"ok": True}
        return 404, {"error": f"no route for {method} {path}"}

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}"

    def calls(self, path: str, method: str | None = None) -> list[dict]:
        with self._lock:
            return [
                r
                for r in self.requests
                if r["path"] == path and (method is None or r["method"] == method)
            ]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@pytest.fixture
def fake_server():
    server = FakeAgentServer()
    yield server
    server.close()


@pytest.fixture
def cfg(fake_server):
    """A DownloaderConfig pointed at the fake app with a known token."""
    import downloader

    return downloader.DownloaderConfig(
        app_url=fake_server.url, agent_token="test-token-123"
    )


@pytest.fixture
def quiet_logger(caplog):
    """A logger wired to caplog so tests can assert on warnings/errors."""
    logger = logging.getLogger("test.downloader")
    return logger


@pytest.fixture
def tmp_work(monkeypatch, tmp_path):
    """Redirect the per-track temp folder into the test's tmp_path."""
    import downloader

    root = tmp_path / "tapedeck"
    monkeypatch.setattr(downloader, "track_tmp_dir", lambda track_id: root / track_id)
    return root


class _NoNetworkResponse:
    """SponsorBlock stand-in reply: 404, the same as "no segments"."""

    status_code = 404
    text = "Not Found"

    def json(self):
        raise ValueError("not JSON")


@pytest.fixture(autouse=True)
def no_sponsorblock_network(monkeypatch):
    """No network in tests (V2-PLAN T10): SponsorBlock answers 404 unless a test overrides it.

    Every request is recorded in the returned list.
    """
    import trim

    seen = []

    def fake_get(url, params, timeout):
        seen.append({"url": url, "params": dict(params), "timeout": timeout})
        return _NoNetworkResponse()

    monkeypatch.setattr(trim, "http_get", fake_get)
    return seen
