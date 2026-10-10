"""--selftest: the real pipeline with the committed test audio (SPEC 9.0).

This is the pytest mirror of the @T1 e2e flow: a waiting track is
"claimed" from the stand-in app, the committed tone stands in for the
yt-dlp download, and claim, convert/duration, tags, upload URL, PUT and
complete all run for real. The e2e suite runs the same thing as a child
process; the child-process test here pins that wiring too.
"""

import json
import logging
import os
import subprocess
import sys

import pytest
from mutagen.mp4 import MP4

import downloader

from .conftest import AGENT_DIR, make_track


@pytest.fixture
def claimed_track(fake_server):
    """The fake app has exactly one waiting track."""
    fake_server.respond["/api/agent/claim"] = (200, [make_track()])
    return make_track()


class TestSelftest:
    def test_success_makes_the_track_ready(
        self, fake_server, cfg, quiet_logger, tmp_work, claimed_track
    ):
        assert downloader.run_selftest(quiet_logger, cfg, "tr1") == 0

        put_call = fake_server.calls("/put", "PUT")[0]
        assert put_call["headers"]["Content-Type"] == "audio/mp4"

        # The stored bytes are the test tone carrying the track's tags:
        # this is exactly what the @T1 e2e mutagen check reads back.
        stored = put_call["body"]
        tagged_path = tmp_work / "stored.m4a"
        tagged_path.write_bytes(stored)
        audio = MP4(str(tagged_path))
        assert audio["\xa9nam"] == ["Me at the zoo"]
        assert audio["\xa9ART"] == ["jawed"]
        assert audio.get("covr") is None  # the claimed track has no cover

        complete = json.loads(fake_server.calls("/api/agent/complete", "POST")[0]["body"])
        assert complete["trackId"] == "tr1"
        assert complete["bytes"] == len(stored)
        assert complete["durationSec"] == 180  # test1.m4a is a 180 s tone
        assert complete["key"] == "tracks/tr1.m4a"

        assert fake_server.calls("/api/agent/fail", "POST") == []

    def test_temp_files_are_cleaned_up(
        self, fake_server, cfg, quiet_logger, tmp_work, claimed_track
    ):
        assert downloader.run_selftest(quiet_logger, cfg, "tr1") == 0
        assert not (tmp_work / "tr1").exists()

    def test_track_not_in_claims_fails_without_reporting(
        self, fake_server, cfg, quiet_logger, tmp_work
    ):
        """Claiming another row must not fail a track the app did not send."""
        fake_server.respond["/api/agent/claim"] = (200, [make_track(id="other")])
        assert downloader.run_selftest(quiet_logger, cfg, "tr1") == 1
        assert fake_server.calls("/api/agent/fail", "POST") == []

    def test_pipeline_failure_reports_to_the_app(
        self, fake_server, cfg, quiet_logger, tmp_work, claimed_track
    ):
        fake_server.respond["/api/agent/upload-url"] = (500, {"error": "storage down"})
        assert downloader.run_selftest(quiet_logger, cfg, "tr1") == 1
        fail_call = fake_server.calls("/api/agent/fail", "POST")[0]
        body = json.loads(fail_call["body"])
        assert body["trackId"] == "tr1"
        assert "storage down" in body["error"]

    def test_missing_test_audio_reports_failure(
        self, fake_server, cfg, quiet_logger, tmp_work, claimed_track, monkeypatch
    ):
        def no_audio():
            raise downloader.PipelineError("Test audio not found at ...")

        monkeypatch.setattr(downloader, "find_test_audio", no_audio)
        assert downloader.run_selftest(quiet_logger, cfg, "tr1") == 1
        assert len(fake_server.calls("/api/agent/fail", "POST")) == 1

    def test_child_process_flow(self, fake_server, claimed_track):
        """The e2e wiring: run downloader.py --selftest as a child process.

        Mirrors SPEC 9.0: env APP_URL/AGENT_TOKEN point at the test
        server; the process exits 0 and the track is completed.
        """
        env = dict(os.environ)
        env["APP_URL"] = fake_server.url
        env["AGENT_TOKEN"] = "test-token-123"
        result = subprocess.run(
            [sys.executable, str(AGENT_DIR / "downloader.py"), "--selftest", "--track", "tr1"],
            capture_output=True,
            text=True,
            cwd=str(AGENT_DIR),
            env=env,
            timeout=120,
            check=False,
        )
        assert result.returncode == 0, result.stderr + result.stdout

        put_call = fake_server.calls("/put", "PUT")[0]
        assert put_call["headers"]["Content-Type"] == "audio/mp4"
        complete = json.loads(fake_server.calls("/api/agent/complete", "POST")[0]["body"])
        assert complete["bytes"] == len(put_call["body"])
        assert complete["durationSec"] == 180


class TestLoadEnv:
    def test_reads_agent_env_file(self, quiet_logger, monkeypatch):
        env_file = AGENT_DIR / ".env"
        assert not env_file.exists(), "the real .env must never exist in the repo"
        try:
            env_file.write_text("APP_URL=https://example.app\nAGENT_TOKEN=abc123\n")
            monkeypatch.delenv("APP_URL", raising=False)
            monkeypatch.delenv("AGENT_TOKEN", raising=False)
            downloader.load_env(quiet_logger)
            assert os.environ["APP_URL"] == "https://example.app"
            assert os.environ["AGENT_TOKEN"] == "abc123"
        finally:
            env_file.unlink(missing_ok=True)
            os.environ.pop("APP_URL", None)
            os.environ.pop("AGENT_TOKEN", None)

    def test_missing_env_file_is_fine(self, quiet_logger, caplog):
        caplog.set_level(logging.INFO)
        downloader.load_env(quiet_logger)  # must not raise
        assert any("process environment" in message for message in caplog.messages)

    def test_real_environment_wins_over_env_file(self, quiet_logger, monkeypatch):
        env_file = AGENT_DIR / ".env"
        try:
            env_file.write_text("APP_URL=https://from-file.app\n")
            monkeypatch.setenv("APP_URL", "https://from-env.app")
            downloader.load_env(quiet_logger)
            assert os.environ["APP_URL"] == "https://from-env.app"
        finally:
            env_file.unlink(missing_ok=True)


class TestLoadConfig:
    def test_missing_settings_raise_plain_language_error(self, monkeypatch):
        monkeypatch.delenv("APP_URL", raising=False)
        monkeypatch.delenv("AGENT_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="Downloader setup"):
            downloader.load_config(20)

    def test_strips_trailing_slash_and_reads_optional_folder(self, monkeypatch):
        monkeypatch.setenv("APP_URL", "https://example.app/")
        monkeypatch.setenv("AGENT_TOKEN", "x")
        cfg = downloader.load_config(20)
        assert cfg.app_url == "https://example.app"
        assert cfg.apple_music_folder == ""
