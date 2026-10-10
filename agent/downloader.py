#!/usr/bin/env python3
"""Tapedeck PC downloader (SPEC 8.3, implemented in T1a).

Runs on the owner's Windows PC. It polls the Tapedeck web app for queued
songs, downloads the audio with yt-dlp, converts and tags a clean .m4a,
uploads it to cloud storage and reports the result. YouTube blocks cloud
servers, so yt-dlp only ever runs here, on the owner's home internet
(SPEC sections 3 and 8.3).

Loop (SPEC 8.3): every 20 seconds POST /api/agent/claim, then process the
claimed rows one at a time: yt-dlp download -> ffmpeg convert (only when
the download is not already .m4a) -> ffprobe duration and the 60% preview
check -> mutagen MP4 tags -> presigned PUT -> complete. Any failure calls
/api/agent/fail, which requeues the track on the server while attempts < 3.

One shot commands (SPEC 9.0):
- `--selftest --track <id>` runs the real pipeline (claim, tag, upload
  URL, PUT, complete) for one track but uses the committed test audio
  `web/public/test-audio/test1.m4a` instead of calling yt-dlp. This is how
  the e2e suite makes a song become ready without touching YouTube.
- `--probe <url>` runs `yt-dlp --simulate` with Deno and reports the
  result. From a cloud machine the YouTube bot check is EXPECTED and is
  not a failure; on the owner's PC it verifies the whole chain works.

Only the Python standard library is imported at module level, so --help
works before any pip install. requests, mutagen, dotenv and yt-dlp are
imported inside the functions that use them.

Keep this file Python 3.12 compatible (the downloader targets Python
3.12 on Windows; the build sandbox runs 3.13).
"""

import argparse
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, TypedDict

# --- Constants (SPEC 5.2, 8.3) ---

# SPEC 8.3 step 2: poll every 20 seconds.
DEFAULT_POLL_INTERVAL_SEC = 20

# SPEC 8.3 step 1: log to agent/logs/downloader.log, rotate at 1 MB, keep 3.
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_FILE = LOG_DIR / "downloader.log"
LOG_MAX_BYTES = 1_000_000
LOG_BACKUP_COUNT = 3

# Content type for the upload PUT and the stored audio (SPEC 7.2, 8.3).
AUDIO_CONTENT_TYPE = "audio/mp4"

# Per-request timeouts in seconds: (connect, read). The PUT can move a
# whole song on a slow home line, so its read timeout is generous.
HTTP_TIMEOUT = 30
UPLOAD_TIMEOUT = (10, 600)

# yt-dlp runs unattended; a stuck download must not hang the loop forever.
DOWNLOAD_TIMEOUT_SEC = 30 * 60
# `pip install -U yt-dlp[default]` at every start (SPEC 8.3 step 1).
UPGRADE_TIMEOUT_SEC = 600
# --probe is a single --simulate, metadata only.
PROBE_TIMEOUT_SEC = 10 * 60

# SPEC 8.3 step 2: a real file under 60% of the expected duration means a
# preview was downloaded instead of the full track.
PREVIEW_THRESHOLD = 0.6

# SPEC 8.3: error text stored on the server is truncated to 500 chars.
MAX_ERROR_CHARS = 500


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


class PipelineError(RuntimeError):
    """A pipeline stage failed; the message goes to /api/agent/fail (SPEC 8.3)."""


# --- Pure helpers (unit tested in tests/) ---


def is_preview(real_sec: float | None, expected_sec: int | None) -> bool:
    """SPEC 8.3 step 2: the file is under 60% of the expected duration."""
    if real_sec is None or expected_sec is None:
        return False
    return real_sec < PREVIEW_THRESHOLD * expected_sec


def preview_error_message() -> str:
    """The SPEC 8.3 wording for the preview failure."""
    return "Only a preview was available (SoundCloud Go+ track?)"


def coerce_optional_str(value: Any) -> str | None:
    """Normalise an optional JSON string field; empty strings mean absent."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def coerce_optional_int(value: Any) -> int | None:
    """Normalise an optional JSON integer field (tolerates float/str)."""
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def coerce_claimed_track(row: Any) -> ClaimedTrack | None:
    """Validate one claim row; None when it is not a usable track."""
    if not isinstance(row, dict):
        return None
    track_id = coerce_optional_str(row.get("id"))
    source_url = coerce_optional_str(row.get("source_url"))
    if not track_id or not source_url:
        return None
    return ClaimedTrack(
        id=track_id,
        source=str(row.get("source") or ""),
        source_url=source_url,
        title=str(row.get("title") or ""),
        artist=str(row.get("artist") or ""),
        album=coerce_optional_str(row.get("album")),
        cover_url=coerce_optional_str(row.get("cover_url")),
        duration_sec=coerce_optional_int(row.get("duration_sec")),
        apple_music=bool(row.get("apple_music")),
    )


def parse_claim_response(payload: Any) -> tuple[list[ClaimedTrack], int]:
    """Parse a POST /api/agent/claim response body into tracks (SPEC 8.3).

    The SPEC says claim "returns them" the rows; this accepts both a bare
    JSON array (the literal reading) and {"tracks": [...]} so the agent API
    can pick either shape without breaking the downloader. Returns the
    usable tracks and how many rows arrived in total, so the caller can
    log malformed rows.
    """
    if isinstance(payload, dict):
        payload = payload.get("tracks")
    if not isinstance(payload, list):
        return [], 0
    tracks = []
    for row in payload:
        track = coerce_claimed_track(row)
        if track is not None:
            tracks.append(track)
    return tracks, len(payload)


def build_yt_dlp_command(source_url: str, output_template: str) -> list[str]:
    """The SPEC 8.3 download command, run via the current interpreter.

    `python -m yt_dlp` pins yt-dlp to the same Python that pip installed
    it into, which avoids PATH problems under the Task Scheduler.
    """
    return [
        sys.executable,
        "-m",
        "yt_dlp",
        "-f",
        "bestaudio[ext=m4a]/bestaudio",
        "--no-playlist",
        "--js-runtimes",
        "deno",
        "-o",
        output_template,
        source_url,
    ]


def build_probe_command(url: str) -> list[str]:
    """The SPEC 9.0 --probe command: metadata only, Deno JS runtime."""
    return [
        sys.executable,
        "-m",
        "yt_dlp",
        "--simulate",
        "--no-playlist",
        "--js-runtimes",
        "deno",
        url,
    ]


def track_tmp_dir(track_id: str) -> Path:
    """Per-track work folder: %TEMP%\\tapedeck\\<id> (SPEC 8.3 step 2)."""
    return Path(tempfile.gettempdir()) / "tapedeck" / track_id


def find_downloaded_file(work_dir: Path, track_id: str) -> Path | None:
    """Pick yt-dlp's output from the work folder.

    yt-dlp names outputs `<id>.<ext>`; `.part`/`.ytdl` sidecars are
    incomplete artifacts, never results. An .m4a wins (no conversion
    needed), otherwise the most recently modified candidate.
    """
    if not work_dir.is_dir():
        return None
    candidates = [
        p
        for p in work_dir.glob(f"{track_id}.*")
        if p.is_file() and not p.name.endswith((".part", ".ytdl", ".tmp"))
    ]
    if not candidates:
        return None
    for candidate in candidates:
        if candidate.suffix.lower() == ".m4a":
            return candidate
    return max(candidates, key=lambda p: p.stat().st_mtime)


def read_duration(path: Path, logger: logging.Logger) -> float | None:
    """Real audio duration in seconds: ffprobe first, mutagen as fallback.

    ffprobe (SPEC 8.3) reads any container mutagen cannot; mutagen keeps
    --selftest working on machines without ffmpeg installed.
    """
    probed = _ffprobe_duration(path, logger)
    if probed is not None:
        return probed
    return _mutagen_duration(path, logger)


def _ffprobe_duration(path: Path, logger: logging.Logger) -> float | None:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except FileNotFoundError:
        logger.warning("ffprobe not found; falling back to mutagen for duration.")
        return None
    except subprocess.TimeoutExpired:
        logger.warning("ffprobe timed out on %s.", path.name)
        return None
    if result.returncode != 0:
        return None
    return _parse_duration_text(result.stdout)


def _mutagen_duration(path: Path, logger: logging.Logger) -> float | None:
    try:
        from mutagen.mp4 import MP4

        return float(MP4(str(path)).info.length)
    except Exception as exc:  # mutagen cannot parse non-MP4 containers either
        logger.warning("Could not read duration from %s: %s", path.name, exc)
        return None


def _parse_duration_text(text: str) -> float | None:
    """Parse ffprobe's `duration=...` output; None when absent/garbage."""
    for line in text.splitlines():
        line = line.strip()
        if line:
            try:
                seconds = float(line)
            except ValueError:
                continue
            if seconds >= 0:
                return seconds
    return None


def find_test_audio() -> Path:
    """The committed stand-in audio (SPEC 9.0): web/public/test-audio/test1.m4a."""
    repo_root = Path(__file__).resolve().parents[1]
    path = repo_root / "web" / "public" / "test-audio" / "test1.m4a"
    if not path.is_file():
        raise PipelineError(
            f"Test audio not found at {path}. Run --selftest from a full checkout "
            "of the repository."
        )
    return path


# --- Logging ---


def setup_logging() -> logging.Logger:
    """Structured, stage tagged logging with rotation (SPEC 8.3 step 1).

    Appends to agent/logs/downloader.log, rotating at 1 MB and keeping 3
    old files. Pipeline stages log through child loggers such as
    "downloader.download" so the owner can tell the stages apart. A
    console mirror is attached only when stderr exists (pythonw.exe,
    which the Task Scheduler uses, has none).
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("downloader")
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        formatter = logging.Formatter("%(asctime)s %(levelname)-5s [%(name)s] %(message)s")
        file_handler = RotatingFileHandler(
            LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
        if sys.stderr is not None:
            stream_handler = logging.StreamHandler(sys.stderr)
            stream_handler.setFormatter(formatter)
            logger.addHandler(stream_handler)
    return logger


# --- Startup steps (SPEC 8.3 step 1) ---


def load_env(logger: logging.Logger) -> None:
    """Read agent/.env into the environment with python-dotenv (SPEC 8.3 step 1).

    A missing .env is fine: the e2e suite passes APP_URL and AGENT_TOKEN
    as process environment variables instead. Real environment variables
    win over .env values (python-dotenv's default, override=False).
    """
    try:
        from dotenv import load_dotenv
    except ImportError as exc:
        raise PipelineError(
            "python-dotenv is not installed. Run install.bat again, or: "
            "py -3.12 -m pip install -r requirements.txt"
        ) from exc
    env_file = Path(__file__).resolve().parent / ".env"
    loaded = load_dotenv(env_file, override=False)
    if loaded:
        logger.info("Loaded settings from %s.", env_file)
    else:
        logger.info("No agent/.env file found; using process environment variables.")


def upgrade_yt_dlp(logger: logging.Logger) -> None:
    """Run pip install -U "yt-dlp[default]" at every start (SPEC 8.3 step 1, 7.7).

    Failures are logged and ignored (the downloader can still work),
    because YouTube breaks older yt-dlp versions often.
    """
    command = [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp[default]"]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=UPGRADE_TIMEOUT_SEC,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        logger.warning("yt-dlp self-update could not run: %s", exc)
        return
    if result.returncode == 0:
        logger.info("yt-dlp is up to date.")
    else:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-3:]
        logger.warning("yt-dlp self-update failed (continuing anyway): %s", " | ".join(tail))


def load_config(poll_interval_sec: int) -> DownloaderConfig:
    """Build the config from environment variables (SPEC 5.2).

    load_env runs first so agent/.env values are in the environment.
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


# --- HTTP helpers (SPEC 8.3 endpoints) ---


def make_session(cfg: DownloaderConfig):
    """A requests session with the Bearer token every /api/agent call needs."""
    import requests

    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {cfg.agent_token}"
    return session


def require_ok(response, what: str) -> None:
    """Turn a non-2xx API response into a reportable PipelineError."""
    if response.status_code // 100 != 2:
        body = (response.text or "").strip()[:200]
        raise PipelineError(f"{what} failed: HTTP {response.status_code}{': ' + body if body else ''}")


def require_json(response, what: str) -> Any:
    """Parse a JSON body, naming the endpoint when it is not JSON."""
    try:
        return response.json()
    except ValueError as exc:
        raise PipelineError(f"{what} did not return JSON: {response.text[:200]}") from exc


# --- Pipeline stages (SPEC 8.3 step 2) ---


def poll_for_claims(logger: logging.Logger, cfg: DownloaderConfig) -> list[ClaimedTrack]:
    """Claim waiting tracks from the web app (SPEC 8.3, POST /api/agent/claim).

    Sends Bearer agent_token and receives up to 3 waiting rows, oldest
    first. The app also treats this call as the downloader heartbeat
    (settings.agent_last_seen). Never raises: a network problem or a
    rejected token just yields an empty list so the loop keeps running.
    """
    import requests

    try:
        with make_session(cfg) as session:
            response = session.post(
                f"{cfg.app_url}/api/agent/claim", json={}, timeout=HTTP_TIMEOUT
            )
    except requests.RequestException as exc:
        logger.warning("Claim poll failed (will retry): %s", exc)
        return []
    if response.status_code == 401:
        logger.error(
            "The app rejected the AGENT_TOKEN (401). Copy it again from the app: "
            "Profile > Downloader setup."
        )
        return []
    if response.status_code // 100 != 2:
        logger.warning(
            "Claim poll returned HTTP %s (will retry): %s",
            response.status_code,
            response.text[:200],
        )
        return []
    try:
        payload = require_json(response, "Claim poll")
    except PipelineError as exc:
        logger.warning("Claim poll returned an unreadable body (will retry): %s", exc)
        return []
    tracks, total_rows = parse_claim_response(payload)
    if total_rows > len(tracks):
        logger.warning("Skipped %s malformed claim row(s).", total_rows - len(tracks))
    return tracks


def download_track(logger: logging.Logger, cfg: DownloaderConfig, track: ClaimedTrack) -> Path:
    """Download one track with yt-dlp to the temp folder (SPEC 8.3 step 2, 7.7).

    Target: %TEMP%\\tapedeck\\<id>. Never run yt-dlp in the cloud (SPEC 3).
    """
    work_dir = track_tmp_dir(track["id"])
    work_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(work_dir / f"{track['id']}.%(ext)s")
    command = build_yt_dlp_command(track["source_url"], output_template)
    logger.info("download: running yt-dlp for %s", track["source_url"])
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=DOWNLOAD_TIMEOUT_SEC,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PipelineError(
            "yt-dlp is not installed for this Python. Run install.bat again, or: "
            'py -3.12 -m pip install -r requirements.txt ("yt-dlp[default]" is in it).'
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise PipelineError(
            f"yt-dlp timed out after {DOWNLOAD_TIMEOUT_SEC // 60} minutes."
        ) from exc
    if result.returncode != 0:
        tail = ((result.stderr or "") + (result.stdout or "")).strip().splitlines()[-5:]
        raise PipelineError("yt-dlp failed: " + " | ".join(tail))
    downloaded = find_downloaded_file(work_dir, track["id"])
    if downloaded is None:
        raise PipelineError("yt-dlp reported success but no audio file was found.")
    logger.info("download: saved %s", downloaded.name)
    return downloaded


def convert_check(
    logger: logging.Logger, track: ClaimedTrack, path: Path
) -> tuple[Path, float | None]:
    """Convert non-m4a audio to .m4a and check the real duration (SPEC 8.3 step 2).

    ffmpeg -vn -c:a aac -b:a 160k when the file is not already .m4a, then
    ffprobe: if the expected duration is known and the file is under 60%
    of it, fail with "Only a preview was available (SoundCloud Go+ track?)".
    Returns the finished path and the measured duration in seconds
    (None when it could not be read; the complete call then reports null).
    """
    if path.suffix.lower() != ".m4a":
        target = path.with_suffix(".m4a")
        logger.info("convert: %s is not m4a, converting with ffmpeg.", path.name)
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(path),
                    "-vn",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                    str(target),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=DOWNLOAD_TIMEOUT_SEC,
                check=False,
            )
        except FileNotFoundError as exc:
            raise PipelineError(
                "ffmpeg was not found. Install it once with: "
                "winget install --id=Gyan.FFmpeg -e (then restart the PC)."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise PipelineError("ffmpeg conversion timed out.") from exc
        if result.returncode != 0 or not target.exists():
            tail = (result.stderr or result.stdout or "").strip().splitlines()[-5:]
            raise PipelineError("ffmpeg conversion failed: " + " | ".join(tail))
        path = target

    duration = read_duration(path, logger)
    if is_preview(duration, track["duration_sec"]):
        raise PipelineError(preview_error_message())
    return path, duration


def download_cover(logger: logging.Logger, cover_url: str | None) -> tuple[bytes, str] | None:
    """Fetch the cover art bytes; (data, 'jpeg'|'png') or None (SPEC 8.3).

    A missing or broken cover never fails the track: the app already
    shows a blank placeholder when no cover was stored.
    """
    import requests

    if not cover_url:
        return None
    try:
        response = requests.get(cover_url, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        logger.warning("Cover download failed (tagging without cover): %s", exc)
        return None
    if response.status_code // 100 != 2 or not response.content:
        logger.warning(
            "Cover download returned HTTP %s (tagging without cover).",
            response.status_code,
        )
        return None
    data = response.content
    if data.startswith(b"\xff\xd8\xff"):
        return data, "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data, "png"
    logger.warning("Cover at %s is not JPEG or PNG (tagging without cover).", cover_url)
    return None


def tag_track(logger: logging.Logger, track: ClaimedTrack, path: Path) -> Path:
    """Write title, artist, album, album artist and cover tags (SPEC 8.3 step 2).

    mutagen MP4 tags: title, artist, album (if any), album artist (if
    any) and cover image downloaded from cover_url (skipped when null).
    Returns the tagged path.

    The claim row (SPEC 8.3) has no album_artist field, so the album
    artist falls back to the track artist whenever an album is set —
    the standard single-artist tagging practice.
    """
    from mutagen.mp4 import MP4, MP4Cover

    audio = MP4(str(path))
    audio["\xa9nam"] = [track["title"]]
    audio["\xa9ART"] = [track["artist"]]
    if track["album"]:
        audio["\xa9alb"] = [track["album"]]
        audio["aART"] = [track["artist"]]

    cover = download_cover(logger, track["cover_url"])
    if cover is not None:
        data, image_format = cover
        fmt = MP4Cover.FORMAT_PNG if image_format == "png" else MP4Cover.FORMAT_JPEG
        audio["covr"] = [MP4Cover(data, imageformat=fmt)]
    audio.save()
    logger.info("tag: wrote tags to %s", path.name)
    return path


def upload_track(
    logger: logging.Logger,
    cfg: DownloaderConfig,
    track: ClaimedTrack,
    path: Path,
    duration_sec: float | None = None,
) -> None:
    """Upload the finished .m4a and mark it ready (SPEC 8.3 step 2, 7.2).

    POST /api/agent/upload-url for a presigned PUT (15 min), PUT the file
    with Content-Type: audio/mp4 (the body is the exact byte count the
    complete call reports), then POST /api/agent/complete.
    """
    import requests

    with make_session(cfg) as session:
        response = session.post(
            f"{cfg.app_url}/api/agent/upload-url",
            json={"trackId": track["id"]},
            timeout=HTTP_TIMEOUT,
        )
        require_ok(response, "Getting the upload URL")
        payload = require_json(response, "Getting the upload URL")
        url, key = payload.get("url"), payload.get("key")
        if not url or not key:
            raise PipelineError("The app returned an upload URL response without url/key.")

        data = path.read_bytes()
        try:
            put_response = requests.put(
                url,
                data=data,
                headers={"Content-Type": AUDIO_CONTENT_TYPE},
                timeout=UPLOAD_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise PipelineError(f"Uploading the audio file failed: {exc}") from exc
        require_ok(put_response, "Uploading the audio file")

        complete_body = {
            "trackId": track["id"],
            "key": key,
            "bytes": len(data),
            "durationSec": round(duration_sec) if duration_sec is not None else None,
        }
        complete_response = session.post(
            f"{cfg.app_url}/api/agent/complete", json=complete_body, timeout=HTTP_TIMEOUT
        )
        require_ok(complete_response, "Marking the song ready")
    logger.info("upload: %s stored (%s bytes) and marked ready.", path.name, len(data))


def report_result(
    logger: logging.Logger, cfg: DownloaderConfig, track: ClaimedTrack, error: str
) -> None:
    """Report a failed attempt to the app (SPEC 8.3, POST /api/agent/fail).

    The app requeues the track while attempts < 3, then marks it failed.
    Never raises: a failure to report a failure is only logged, so one
    dead endpoint cannot take the whole loop down. Success reporting
    happens in upload_track (complete); the Apple Music copy calls
    /api/agent/apple-music-done and lands with T6 (SPEC 8.11).
    """
    import requests

    try:
        with make_session(cfg) as session:
            response = session.post(
                f"{cfg.app_url}/api/agent/fail",
                json={"trackId": track["id"], "error": error[:MAX_ERROR_CHARS]},
                timeout=HTTP_TIMEOUT,
            )
        if response.status_code // 100 != 2:
            logger.warning(
                "Reporting the failure returned HTTP %s: %s",
                response.status_code,
                response.text[:200],
            )
    except requests.RequestException as exc:
        logger.warning("Reporting the failure failed: %s", exc)


def cleanup_tmp(logger: logging.Logger, track_id: str) -> None:
    """Delete the per-track temp folder (SPEC 8.3 step 2: delete temp files)."""
    shutil.rmtree(track_tmp_dir(track_id), ignore_errors=True)
    logger.info("cleanup: removed temp files for %s.", track_id)


# --- Main loop (SPEC 8.3) ---


def run_loop(logger: logging.Logger, cfg: DownloaderConfig) -> None:
    """Main polling loop (SPEC 8.3).

    Wires the startup steps and pipeline stages together. Every 20
    seconds (configurable with --poll-interval) it claims up to 3
    waiting rows and processes them one at a time; any stage failure is
    reported to the app and the loop moves on.

    The optional Apple Music copy (SPEC 8.11) and its apple-music-done
    call hook in after a successful upload and land with T6.
    """
    # Startup (SPEC 8.3 step 1): read agent/.env, refresh yt-dlp.
    load_env(logger)
    upgrade_yt_dlp(logger)

    logger.info("Downloader started; polling %s every %s s.", cfg.app_url, cfg.poll_interval_sec)
    while True:
        for track in poll_for_claims(logger, cfg):
            logger.info("claim: track %s (%s)", track["id"], track["title"] or "untitled")
            try:
                path = download_track(logger, cfg, track)
                path, duration = convert_check(logger, track, path)
                path = tag_track(logger, track, path)
                upload_track(logger, cfg, track, path, duration)
                # SPEC 8.3 step 2 also says "Delete temp files" after the
                # track is handled, success or failure.
            except Exception as exc:  # SPEC 8.3 step 2: report every failure to the app.
                logger.error("track %s failed: %s", track["id"], exc)
                report_result(logger, cfg, track, error=str(exc))
            finally:
                cleanup_tmp(logger, track["id"])
        time.sleep(cfg.poll_interval_sec)


# --- One shot commands (SPEC 9.0) ---


def run_selftest(logger: logging.Logger, cfg: DownloaderConfig, track_id: str) -> int:
    """Run the real pipeline for one track without yt-dlp (SPEC 9.0).

    Claims like the real loop does (which also sets the online
    heartbeat), picks the row matching --track, then uses the committed
    test audio web/public/test-audio/test1.m4a instead of a download:
    convert/duration/preview checks, mutagen tags, upload URL, PUT and
    complete all run for real. Returns 0 when the track is ready.
    """
    claimed = poll_for_claims(logger, cfg)
    track = next((t for t in claimed if t["id"] == track_id), None)
    if track is None:
        claimed_ids = ", ".join(t["id"] for t in claimed) or "none"
        logger.error(
            "Selftest: track %s was not among the claimed rows (%s). Seed it as "
            "waiting first, then run --selftest --track <id>.",
            track_id,
            claimed_ids,
        )
        return 1
    logger.info("selftest: processing track %s with the committed test audio.", track_id)

    work_dir = track_tmp_dir(track_id)
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        stand_in = work_dir / find_test_audio().name
        shutil.copyfile(find_test_audio(), stand_in)
        path, duration = convert_check(logger, track, stand_in)
        path = tag_track(logger, track, path)
        upload_track(logger, cfg, track, path, duration)
        return 0
    except Exception as exc:  # same error path as the real loop
        logger.error("selftest: track %s failed: %s", track_id, exc)
        report_result(logger, cfg, track, error=str(exc))
        return 1
    finally:
        cleanup_tmp(logger, track_id)


def run_probe(logger: logging.Logger, url: str) -> int:
    """Run yt-dlp --simulate with Deno against a URL (SPEC 9.0).

    A bot check error from a cloud machine is expected and is only
    recorded in the test report, never a failure (SPEC 9.0, 12): the
    exit code is 0 whenever yt-dlp itself could run. Only a missing
    yt-dlp installation is a real error (exit 1).
    """
    command = build_probe_command(url)
    logger.info("probe: running yt-dlp --simulate for %s", url)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_SEC,
            check=False,
        )
    except FileNotFoundError:
        logger.error(
            "yt-dlp is not installed for this Python. Run install.bat again, or: "
            'py -3.12 -m pip install -r requirements.txt ("yt-dlp[default]" is in it).'
        )
        return 1
    except subprocess.TimeoutExpired:
        logger.error("probe: yt-dlp --simulate timed out after %s s.", PROBE_TIMEOUT_SEC)
        return 1

    output = ((result.stdout or "") + (result.stderr or "")).strip()
    if output:
        for line in output.splitlines()[-10:]:
            logger.info("probe: %s", line)
    if result.returncode == 0:
        logger.info("probe: SUCCESS — yt-dlp could read the URL (works on a home PC).")
    else:
        logger.info(
            "probe: BLOCKED — exit %s. From a cloud machine this is the expected "
            "YouTube bot check (SPEC 9.0); record it in the test report, not a failure.",
            result.returncode,
        )
    return 0


# --- Command line interface ---


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse arguments (SPEC 9.0: --selftest and --probe)."""
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
    if args.probe and (args.selftest or args.track):
        parser.error("--probe cannot be combined with --selftest/--track.")
    return args


def main(argv: list[str] | None = None) -> int:
    """Wire argument parsing to the loop and the one shot commands."""
    args = parse_args(argv)
    logger = setup_logging()
    try:
        if args.selftest:
            load_env(logger)
            return run_selftest(logger, load_config(args.poll_interval), args.track)
        if args.probe:
            return run_probe(logger, args.probe)
        run_loop(logger, load_config(args.poll_interval))
        return 0
    except RuntimeError as exc:
        # Config errors carry plain language messages for the owner; log
        # them instead of tracebacking (the Task Scheduler shows no console).
        logger.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        logger.info("Stopped by user.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
