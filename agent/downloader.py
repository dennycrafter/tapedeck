#!/usr/bin/env python3
"""Tapedeck PC downloader: skeleton (T0, ticket T0a-w3).

Runs on the owner's Windows PC. It polls the Tapedeck web app for queued
songs, downloads the audio with yt-dlp, converts and tags a clean .m4a,
uploads it to cloud storage and reports the result. YouTube blocks cloud
servers, so yt-dlp only ever runs here, on the owner's home internet
(SPEC sections 3 and 8.3).

This T0 file is a skeleton. The startup steps and the pipeline stages
(poll, download, convert-check, tag, upload, report) are clearly
separated functions that raise NotImplementedError with a SPEC
reference. T1a fills them in. No polling, yt-dlp or upload logic yet.

Only the Python standard library is imported at module level, so --help
works before any pip install. The T1a implementations import requests,
mutagen, dotenv and yt-dlp inside the functions that use them.

Keep this file Python 3.12 compatible (the downloader targets Python
3.12 on Windows; the build sandbox runs 3.13).
"""

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TypedDict

# --- Constants (SPEC 5.2, 8.3) ---

# SPEC 8.3 step 2: poll every 20 seconds.
DEFAULT_POLL_INTERVAL_SEC = 20

# SPEC 8.3 step 1: log to agent/logs/downloader.log, rotate at 1 MB, keep 3.
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_FILE = LOG_DIR / "downloader.log"
LOG_MAX_BYTES = 1_000_000
LOG_BACKUP_COUNT = 3


class ClaimedTrack(TypedDict):
    """One row returned by POST /api/agent/claim (SPEC 8.3)."""

    id: str
    source: str  # "youtube" or "soundcloud"
    source_url: str
    title: str
    artist: str
    album: str | None
    cover_url: str | None
    duration_sec: int | None
    apple_music: bool


@dataclass(frozen=True)
class DownloaderConfig:
    """Runtime settings, built from agent/.env and the command line (SPEC 5.2)."""

    app_url: str  # The deployed app URL, no trailing slash
    agent_token: str  # Bearer token for /api/agent/*
    poll_interval_sec: int = DEFAULT_POLL_INTERVAL_SEC
    apple_music_folder: str = ""  # SPEC 5.2, 8.11: empty means auto-detect


# --- Logging ---


def setup_logging() -> logging.Logger:
    """Structured, stage tagged logging with rotation (SPEC 8.3 step 1).

    Appends to agent/logs/downloader.log, rotating at 1 MB and keeping 3
    old files. Pipeline stages log through child loggers such as
    "downloader.download" so the owner can tell the stages apart.
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("downloader")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        handler = RotatingFileHandler(
            LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-5s [%(name)s] %(message)s")
        )
        logger.addHandler(handler)
    return logger


# --- Startup steps (SPEC 8.3 step 1, T1a fills these in) ---


def load_env(logger: logging.Logger) -> None:
    """Read agent/.env into the environment with python-dotenv (SPEC 8.3 step 1)."""
    raise NotImplementedError("load_env: implement in T1a (SPEC 8.3 step 1, python-dotenv)")


def upgrade_yt_dlp(logger: logging.Logger) -> None:
    """Run pip install -U "yt-dlp[default]" at every start (SPEC 8.3 step 1, 7.7).

    Failures are logged and ignored (the downloader can still work),
    because YouTube breaks older yt-dlp versions often.
    """
    raise NotImplementedError("upgrade_yt_dlp: implement in T1a (SPEC 8.3 step 1, 7.7)")


def load_config(poll_interval_sec: int) -> DownloaderConfig:
    """Build the config from environment variables (SPEC 5.2).

    T1a calls load_env first so agent/.env values are in the environment.
    Missing required variables raise a plain language error for the owner.
    """
    missing = [name for name in ("APP_URL", "AGENT_TOKEN") if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            "Missing setting(s): "
            + ", ".join(missing)
            + ". Open the Tapedeck app, go to Profile, then Downloader setup, "
            "and copy the values into the agent/.env file (see the README)."
        )
    return DownloaderConfig(
        app_url=os.environ["APP_URL"].rstrip("/"),  # SPEC 5.2: no trailing slash
        agent_token=os.environ["AGENT_TOKEN"],
        poll_interval_sec=poll_interval_sec,
        apple_music_folder=os.environ.get("APPLE_MUSIC_FOLDER", ""),
    )


# --- Pipeline stages (SPEC 8.3, T1a fills these in) ---


def poll_for_claims(logger: logging.Logger, cfg: DownloaderConfig) -> list[ClaimedTrack]:
    """Claim waiting tracks from the web app (SPEC 8.3, POST /api/agent/claim).

    Sends Bearer agent_token and receives up to 3 waiting rows, oldest
    first. The app also treats this call as the downloader heartbeat
    (settings.agent_last_seen).
    """
    raise NotImplementedError("poll_for_claims: implement in T1a (SPEC 8.3, POST /api/agent/claim)")


def download_track(logger: logging.Logger, cfg: DownloaderConfig, track: ClaimedTrack) -> Path:
    """Download one track with yt-dlp to the temp folder (SPEC 8.3 step 2, 7.7).

    Target: %TEMP%\\tapedeck\\<id>. Never run yt-dlp in the cloud (SPEC 3).
    """
    raise NotImplementedError("download_track: implement in T1a (SPEC 8.3 step 2, 7.7)")


def convert_check(logger: logging.Logger, track: ClaimedTrack, path: Path) -> Path:
    """Convert non-m4a audio to .m4a and check the real duration (SPEC 8.3 step 2).

    ffmpeg -vn -c:a aac -b:a 160k when the file is not already .m4a, then
    ffprobe: if the expected duration is known and the file is under 60%
    of it, fail with "Only a preview was available (SoundCloud Go+ track?)".
    """
    raise NotImplementedError("convert_check: implement in T1a (SPEC 8.3 step 2, ffmpeg and ffprobe)")


def tag_track(logger: logging.Logger, track: ClaimedTrack, path: Path) -> Path:
    """Write title, artist, album, album artist and cover tags (SPEC 8.3 step 2).

    mutagen MP4 tags: title, artist, album (if any), album artist (if
    any) and cover JPEG downloaded from cover_url (skipped when null).
    Returns the tagged path.
    """
    raise NotImplementedError("tag_track: implement in T1a (SPEC 8.3 step 2, mutagen MP4 tags)")


def upload_track(
    logger: logging.Logger, cfg: DownloaderConfig, track: ClaimedTrack, path: Path
) -> None:
    """Upload the finished .m4a and mark it ready (SPEC 8.3 step 2, 7.2).

    POST /api/agent/upload-url for a presigned PUT (15 min), PUT the file
    with Content-Type: audio/mp4, then POST /api/agent/complete.
    """
    raise NotImplementedError("upload_track: implement in T1a (SPEC 8.3 step 2, 7.2)")


def report_result(
    logger: logging.Logger, cfg: DownloaderConfig, track: ClaimedTrack, error: str
) -> None:
    """Report a failed attempt to the app (SPEC 8.3, POST /api/agent/fail).

    The app requeues the track while attempts < 3, then marks it failed.
    Success reporting happens in upload_track (complete); the optional
    Apple Music copy calls /api/agent/apple-music-done (SPEC 8.11, T6).
    """
    raise NotImplementedError("report_result: implement in T1a (SPEC 8.3, POST /api/agent/fail)")


# --- Main loop (SPEC 8.3) ---


def run_loop(logger: logging.Logger, cfg: DownloaderConfig) -> None:
    """Main polling loop (SPEC 8.3).

    Wires the startup steps and pipeline stages together. Every stage is
    a stub until T1a fills it in, so the first call raises
    NotImplementedError with its SPEC reference.
    """
    # Startup (SPEC 8.3 step 1): read agent/.env, refresh yt-dlp.
    load_env(logger)
    upgrade_yt_dlp(logger)

    while True:
        # SPEC 8.3 step 2: claim up to 3 rows, oldest first, one at a time.
        for track in poll_for_claims(logger, cfg):
            logger.info("claim: track %s", track["id"])
            try:
                path = download_track(logger, cfg, track)
                path = convert_check(logger, track, path)
                path = tag_track(logger, track, path)
                upload_track(logger, cfg, track, path)
                # SPEC 8.3 step 2 also says "Delete temp files": T1a must
                # remove the downloaded/converted intermediates after upload
                # (and in the failure path) so the work dir cannot grow.
                # Optional Apple Music copy lands with T6 (SPEC 8.11).
            except Exception as exc:  # SPEC 8.3 step 2: report every failure to the app.
                logger.error("track %s failed: %s", track["id"], exc)
                report_result(logger, cfg, track, error=str(exc))
        time.sleep(cfg.poll_interval_sec)


# --- One shot commands (SPEC 9.0, stubbed in T0) ---


def run_selftest(logger: logging.Logger, cfg: DownloaderConfig, track_id: str) -> int:
    """Run the real pipeline for one track without yt-dlp (SPEC 9.0).

    Uses web/public/test-audio/test1.m4a instead of a download, then
    tags, uploads and completes the track like a real one.
    """
    raise NotImplementedError("run_selftest: implement in T1a (SPEC 9.0, --selftest --track)")


def run_probe(logger: logging.Logger, url: str) -> int:
    """Run yt-dlp --simulate with Deno against a URL (SPEC 9.0).

    A bot check error from a cloud machine is expected and is only
    recorded in the test report, never a failure (SPEC 9.0, 12).
    """
    raise NotImplementedError("run_probe: implement in T1a (SPEC 9.0, --probe)")


# --- Command line interface ---


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse arguments (SPEC T0 step 1: --selftest and --probe stubbed)."""
    parser = argparse.ArgumentParser(
        prog="downloader",
        description=(
            "Tapedeck PC downloader: grabs queued songs from the Tapedeck web app, "
            "downloads the audio with yt-dlp and uploads a clean, tagged .m4a (SPEC 8.3)."
        ),
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL_SEC,
        metavar="SECONDS",
        help="Seconds between claim polls, default: %(default)s (SPEC 8.3).",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help=(
            "Run the pipeline for one track using the committed test audio "
            "instead of yt-dlp (SPEC 9.0)."
        ),
    )
    parser.add_argument(
        "--track",
        metavar="TRACK_ID",
        help="Track id used with --selftest (SPEC 9.0).",
    )
    parser.add_argument(
        "--probe",
        metavar="URL",
        help="Run yt-dlp --simulate with Deno against a URL and exit (SPEC 9.0).",
    )
    args = parser.parse_args(argv)
    if args.poll_interval <= 0:
        parser.error("--poll-interval must be a positive number of seconds.")
    if args.selftest and not args.track:
        parser.error("--selftest requires --track TRACK_ID (SPEC 9.0).")
    if args.track and not args.selftest:
        parser.error("--track is only valid together with --selftest (SPEC 9.0).")
    return args


def main(argv: list[str] | None = None) -> int:
    """Wire argument parsing to the loop and the one shot commands."""
    args = parse_args(argv)
    logger = setup_logging()
    try:
        if args.selftest:
            return run_selftest(logger, load_config(args.poll_interval), args.track)
        if args.probe:
            return run_probe(logger, args.probe)
        run_loop(logger, load_config(args.poll_interval))
        return 0
    except KeyboardInterrupt:
        logger.info("Stopped by user.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
