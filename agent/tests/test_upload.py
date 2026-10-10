"""Upload and failure reporting against a stand-in app (SPEC 8.3 step 2, 7.2)."""

import json

import pytest

import downloader

from .conftest import TEST_AUDIO, make_track


@pytest.fixture
def audio_file(tmp_path):
    target = tmp_path / "tr1.m4a"
    target.write_bytes(TEST_AUDIO.read_bytes())
    return target


class TestUploadTrack:
    def test_full_flow_calls_upload_url_put_and_complete(
        self, fake_server, cfg, audio_file, quiet_logger
    ):
        downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, 180.4)

        url_call = fake_server.calls("/api/agent/upload-url", "POST")[0]
        assert url_call["headers"]["Authorization"] == "Bearer test-token-123"
        assert json.loads(url_call["body"]) == {"trackId": "tr1"}

        put_call = fake_server.calls("/put", "PUT")[0]
        assert put_call["body"] == audio_file.read_bytes()
        assert put_call["headers"]["Content-Type"] == "audio/mp4"
        assert int(put_call["headers"]["Content-Length"]) == len(audio_file.read_bytes())

        complete_call = fake_server.calls("/api/agent/complete", "POST")[0]
        assert json.loads(complete_call["body"]) == {
            "trackId": "tr1",
            "key": "tracks/tr1.m4a",
            "bytes": len(audio_file.read_bytes()),
            "durationSec": 180,  # rounded to the nearest second
        }

    def test_unknown_duration_reports_null(self, fake_server, cfg, audio_file, quiet_logger):
        downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, None)
        body = json.loads(fake_server.calls("/api/agent/complete", "POST")[0]["body"])
        assert body["durationSec"] is None

    def test_upload_url_failure_raises_pipeline_error(self, fake_server, cfg, audio_file, quiet_logger):
        fake_server.respond["/api/agent/upload-url"] = (500, {"error": "storage down"})
        with pytest.raises(downloader.PipelineError, match="upload URL"):
            downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, None)
        assert fake_server.calls("/api/agent/complete", "POST") == []

    def test_put_failure_raises_pipeline_error(self, fake_server, cfg, audio_file, quiet_logger):
        fake_server.respond["/put"] = (403, b"forbidden")
        with pytest.raises(downloader.PipelineError, match="Uploading the audio file"):
            downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, None)

    def test_complete_failure_raises_pipeline_error(self, fake_server, cfg, audio_file, quiet_logger):
        fake_server.respond["/api/agent/complete"] = (500, {"error": "db down"})
        with pytest.raises(downloader.PipelineError, match="Marking the song ready"):
            downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, None)

    def test_upload_url_response_without_key_raises(self, fake_server, cfg, audio_file, quiet_logger):
        fake_server.respond["/api/agent/upload-url"] = (200, {"url": "http://x/put"})
        with pytest.raises(downloader.PipelineError, match="url/key"):
            downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, None)

    def test_app_relative_upload_url_is_joined_to_app(self, fake_server, cfg, audio_file, quiet_logger):
        """Local-storage mode returns app-relative presigned URLs (SPEC 9.1)."""
        relative = "/api/local-storage/tracks/tr1.m4a?exp=123&sig=abc"
        fake_server.respond["/api/agent/upload-url"] = (200, {"url": relative, "key": "tracks/tr1.m4a"})
        fake_server.respond[relative] = (200, {})

        downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, 180.4)

        put_calls = fake_server.calls(relative, "PUT")
        assert len(put_calls) == 1
        assert put_calls[0]["body"] == audio_file.read_bytes()
        assert put_calls[0]["headers"]["Content-Type"] == "audio/mp4"

    def test_absolute_upload_url_passes_through_untouched(self, fake_server, cfg, audio_file, quiet_logger):
        absolute_path = "/put?exp=123&sig=abc"
        fake_server.respond["/api/agent/upload-url"] = (
            200,
            {"url": f"{fake_server.url}{absolute_path}", "key": "tracks/tr1.m4a"},
        )

        downloader.upload_track(quiet_logger, cfg, make_track(), audio_file, None)

        put_calls = fake_server.calls(absolute_path, "PUT")
        assert len(put_calls) == 1
        assert put_calls[0]["body"] == audio_file.read_bytes()


class TestReportResult:
    def test_posts_track_id_and_error(self, fake_server, cfg, quiet_logger):
        downloader.report_result(quiet_logger, cfg, make_track(), error="yt-dlp exploded")
        call = fake_server.calls("/api/agent/fail", "POST")[0]
        assert json.loads(call["body"]) == {"trackId": "tr1", "error": "yt-dlp exploded"}

    def test_truncates_error_to_500_chars(self, fake_server, cfg, quiet_logger):
        downloader.report_result(quiet_logger, cfg, make_track(), error="x" * 900)
        body = json.loads(fake_server.calls("/api/agent/fail", "POST")[0]["body"])
        assert len(body["error"]) == 500

    def test_server_error_never_raises(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/fail"] = (500, {"error": "boom"})
        downloader.report_result(quiet_logger, cfg, make_track(), error="x")  # must not raise

    def test_unreachable_app_never_raises(self, quiet_logger):
        """A dead endpoint must not take the loop down (SPEC 8.3)."""
        cfg = downloader.DownloaderConfig(app_url="http://127.0.0.1:1", agent_token="x")
        downloader.report_result(quiet_logger, cfg, make_track(), error="x")  # must not raise
