"""--probe: yt-dlp --simulate with Deno (SPEC 9.0).

From a cloud machine the YouTube bot check is expected and must not be
treated as a failure; only a missing yt-dlp is a real error.
"""

import subprocess

import downloader


def test_bot_check_is_reported_not_failed(quiet_logger, monkeypatch):
    """The expected cloud outcome: yt-dlp runs, YouTube blocks it, exit 0."""

    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(
            args=command,
            returncode=1,
            stdout="",
            stderr="ERROR: Sign in to confirm you're not a bot.",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert downloader.run_probe(quiet_logger, "https://www.youtube.com/watch?v=jNQXAC9IVRw") == 0


def test_success_is_reported(quiet_logger, monkeypatch):
    """On the owner's PC the probe can actually succeed."""

    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(
            args=command, returncode=0, stdout="[info] video metadata", stderr=""
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert downloader.run_probe(quiet_logger, "https://www.youtube.com/watch?v=jNQXAC9IVRw") == 0


def test_missing_yt_dlp_is_a_real_error(quiet_logger, monkeypatch):
    def raise_not_found(*args, **kwargs):
        raise FileNotFoundError("yt_dlp")

    monkeypatch.setattr(subprocess, "run", raise_not_found)
    assert downloader.run_probe(quiet_logger, "https://www.youtube.com/watch?v=x") == 1


def test_timeout_is_a_real_error(quiet_logger, monkeypatch):
    def raise_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="yt_dlp", timeout=1)

    monkeypatch.setattr(subprocess, "run", raise_timeout)
    assert downloader.run_probe(quiet_logger, "https://www.youtube.com/watch?v=x") == 1
