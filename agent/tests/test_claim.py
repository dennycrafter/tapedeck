"""Claim loop logic: response parsing and POST /api/agent/claim (SPEC 8.3)."""


import downloader

from .conftest import make_track


class TestParseClaimResponse:
    def test_bare_array(self):
        tracks, total = downloader.parse_claim_response([make_track(), make_track(id="tr2")])
        assert total == 2
        assert [t["id"] for t in tracks] == ["tr1", "tr2"]
        assert tracks[0]["title"] == "Me at the zoo"
        assert tracks[0]["duration_sec"] == 180
        assert tracks[0]["apple_music"] is False

    def test_tracks_wrapper_object(self):
        """The agent API may wrap the rows; both shapes must work (SPEC 8.3)."""
        tracks, total = downloader.parse_claim_response({"tracks": [make_track()]})
        assert total == 1
        assert tracks[0]["id"] == "tr1"

    def test_malformed_rows_are_skipped(self):
        rows = [make_track(), {"id": "broken"}, "not a dict", None]
        tracks, total = downloader.parse_claim_response(rows)
        assert total == 4
        assert [t["id"] for t in tracks] == ["tr1"]

    def test_row_without_source_url_is_dropped(self):
        tracks, total = downloader.parse_claim_response([make_track(source_url="")])
        assert total == 1
        assert tracks == []

    def test_optional_fields_coerce(self):
        tracks, _ = downloader.parse_claim_response(
            [make_track(album=" Album ", cover_url=" ", duration_sec="201.9")]
        )
        track = tracks[0]
        assert track["album"] == "Album"  # stripped
        assert track["cover_url"] is None  # blank means absent
        assert track["duration_sec"] == 201

    def test_non_list_payload(self):
        assert downloader.parse_claim_response({"error": "nope"}) == ([], 0)
        assert downloader.parse_claim_response("junk") == ([], 0)
        assert downloader.parse_claim_response(None) == ([], 0)


class TestPollForClaims:
    def test_sends_bearer_token_and_parses_rows(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/claim"] = (200, [make_track()])
        tracks = downloader.poll_for_claims(quiet_logger, cfg)
        assert [t["id"] for t in tracks] == ["tr1"]
        call = fake_server.calls("/api/agent/claim", "POST")[0]
        assert call["headers"]["Authorization"] == "Bearer test-token-123"

    def test_tracks_wrapper_shape(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/claim"] = (200, {"tracks": [make_track()]})
        tracks = downloader.poll_for_claims(quiet_logger, cfg)
        assert [t["id"] for t in tracks] == ["tr1"]

    def test_wrong_token_yields_empty_list(self, fake_server, cfg, quiet_logger, caplog):
        fake_server.respond["/api/agent/claim"] = (401, {"error": "bad token"})
        tracks = downloader.poll_for_claims(quiet_logger, cfg)
        assert tracks == []
        assert any("AGENT_TOKEN" in message for message in caplog.messages)

    def test_server_error_yields_empty_list(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/claim"] = (500, {"error": "boom"})
        assert downloader.poll_for_claims(quiet_logger, cfg) == []

    def test_non_json_body_yields_empty_list(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/claim"] = (200, b"<html>gateway</html>")
        assert downloader.poll_for_claims(quiet_logger, cfg) == []

    def test_connection_error_yields_empty_list(self, quiet_logger):
        """The loop must survive the app being unreachable (SPEC 8.3)."""
        cfg = downloader.DownloaderConfig(app_url="http://127.0.0.1:1", agent_token="x")
        assert downloader.poll_for_claims(quiet_logger, cfg) == []

    def test_app_url_trailing_slash_is_stripped(self, fake_server, quiet_logger):
        cfg = downloader.DownloaderConfig(
            app_url=fake_server.url + "/", agent_token="x"
        )
        downloader.poll_for_claims(quiet_logger, cfg)
        call = fake_server.calls("/api/agent/claim", "POST")[0]
        assert call["path"] == "/api/agent/claim"
