"""Apple Music copies of uploaded songs (T15 follow-up).

Songs the owner uploaded from a phone or PC (T15) never pass through this
downloader: there is no link to download again. When "Add to Apple Music"
is pressed on one (or "Also add to Apple Music" was on when it was
uploaded), the app queues an Apple Music copy instead:

1. POST /api/agent/apple-music-copies: at most 3 copies, each with the
   song's details, its format and short-lived links to the stored file and
   its cover (an app without uploads answers 404: nothing to do).
2. Download the file. MP3 and M4A stay as they are; WAV and FLAC become
   Apple Lossless (ALAC) .m4a with ffmpeg, since Apple Music for Windows
   cannot play FLAC and WAV files cannot hold tags. Nothing is lost.
3. Write the app's title, artist, album and cover into the file (the owner
   may have edited them in the app), copy it into the Apple Music auto-add
   folder (apple_music.py) and report POST /api/agent/apple-music-done.

A copy that fails is only logged: the app hands it out again 15 minutes
later, at most 3 times in all. `run_once` never raises into the downloader
loop. Only the standard library is imported at module level.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import apple_music

COPIES_PATH = "/api/agent/apple-music-copies"
DONE_PATH = "/api/agent/apple-music-done"
HTTP_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 600
CONVERT_TIMEOUT = 600
CHUNK_BYTES = 1024 * 1024

# Formats Apple Music for Windows takes as they are; the rest become ALAC.
KEEP_AS_IS = {"mp3", "m4a"}
CONVERT_TO_ALAC = {"wav", "flac"}


class CopyError(RuntimeError):
    """One copy failed; the app hands it out again later."""


def work_dir(copy_id: str) -> Path:
    """Per-copy temp folder (tests point it elsewhere)."""
    return Path(tempfile.gettempdir()) / "tapedeck" / f"apple-{copy_id}"


def absolute(cfg: Any, url: str) -> str:
    """Local storage hands out app-relative links; R2's are absolute."""
    return url if url.startswith(("http://", "https://")) else f"{cfg.app_url}{url}"


def _session(cfg: Any):
    import requests

    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {cfg.agent_token}"
    return session


def parse_copies(payload: Any) -> list[dict]:
    """The usable copies in a claim answer; anything malformed is dropped."""
    copies = payload.get("copies") if isinstance(payload, dict) else None
    if not isinstance(copies, list):
        return []
    usable = []
    for copy in copies:
        if not isinstance(copy, dict):
            continue
        if not all(isinstance(copy.get(key), str) and copy.get(key) for key in ("id", "title", "format", "audioUrl")):
            continue
        if copy["format"] not in KEEP_AS_IS | CONVERT_TO_ALAC:
            continue
        usable.append(
            {
                "id": copy["id"],
                "title": copy["title"],
                "artist": copy.get("artist") if isinstance(copy.get("artist"), str) else "",
                "album": copy.get("album") if isinstance(copy.get("album"), str) and copy.get("album") else None,
                "albumArtist": copy.get("albumArtist") if isinstance(copy.get("albumArtist"), str) and copy.get("albumArtist") else None,
                "format": copy["format"],
                "audioUrl": copy["audioUrl"],
                "coverUrl": copy.get("coverUrl") if isinstance(copy.get("coverUrl"), str) and copy.get("coverUrl") else None,
            }
        )
    return usable


def claim_copies(logger: logging.Logger, cfg: Any) -> list[dict]:
    """Claims copies; an empty list on any problem."""
    import requests

    try:
        with _session(cfg) as session:
            response = session.post(f"{cfg.app_url}{COPIES_PATH}", json={}, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        logger.warning("Apple Music copies: claim failed (will retry): %s", exc)
        return []
    if response.status_code == 404:
        return []  # an app without uploads
    if response.status_code // 100 != 2:
        logger.warning("Apple Music copies: claim returned HTTP %s: %s", response.status_code, response.text[:200])
        return []
    try:
        return parse_copies(response.json())
    except ValueError:
        logger.warning("Apple Music copies: claim returned an unreadable body.")
        return []


def download(cfg: Any, url: str, target: Path) -> Path:
    """Stream a stored file to `target`."""
    import requests

    try:
        with requests.get(absolute(cfg, url), stream=True, timeout=DOWNLOAD_TIMEOUT) as response:
            if response.status_code // 100 != 2:
                raise CopyError(f"downloading the song failed: HTTP {response.status_code}")
            with target.open("wb") as out:
                for chunk in response.iter_content(CHUNK_BYTES):
                    out.write(chunk)
    except requests.RequestException as exc:
        raise CopyError(f"downloading the song failed: {exc}") from exc
    if target.stat().st_size == 0:
        raise CopyError("downloading the song failed: the file was empty")
    return target


def fetch_cover(logger: logging.Logger, cfg: Any, url: str | None) -> tuple[bytes, str] | None:
    """The cover's bytes and 'jpeg' or 'png'; None when there is none or it fails."""
    import requests

    if not url:
        return None
    try:
        response = requests.get(absolute(cfg, url), timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        logger.warning("Apple Music copies: cover download failed (no cover): %s", exc)
        return None
    data = response.content if response.status_code // 100 == 2 else b""
    if data.startswith(b"\xff\xd8\xff"):
        return data, "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data, "png"
    logger.warning("Apple Music copies: the cover was not a JPEG or PNG (no cover).")
    return None


def to_alac(source: Path) -> Path:
    """WAV or FLAC to Apple Lossless .m4a, audio only (cover art goes in as a tag)."""
    target = source.with_name("apple.m4a")
    command = ["ffmpeg", "-y", "-v", "error", "-i", str(source), "-map", "0:a:0", "-c:a", "alac", str(target)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=CONVERT_TIMEOUT)
    except FileNotFoundError as exc:
        raise CopyError("ffmpeg was not found. Install it once with: winget install Gyan.FFmpeg") from exc
    except subprocess.TimeoutExpired as exc:
        raise CopyError("converting to Apple Lossless timed out") from exc
    if result.returncode != 0 or not target.exists():
        tail = " | ".join((result.stderr or "").strip().splitlines()[-3:])
        raise CopyError(f"converting to Apple Lossless failed: {tail}")
    return target


def tag_m4a(path: Path, copy: dict, cover: tuple[bytes, str] | None) -> None:
    from mutagen.mp4 import MP4, MP4Cover

    audio = MP4(str(path))
    if audio.tags is None:
        audio.add_tags()
    audio["\xa9nam"] = [copy["title"]]
    audio["\xa9ART"] = [copy["artist"]]
    if copy["album"]:
        audio["\xa9alb"] = [copy["album"]]
        audio["aART"] = [copy["albumArtist"] or copy["artist"]]
    if cover is not None:
        data, image_format = cover
        fmt = MP4Cover.FORMAT_PNG if image_format == "png" else MP4Cover.FORMAT_JPEG
        audio["covr"] = [MP4Cover(data, imageformat=fmt)]
    audio.save()


def tag_mp3(path: Path, copy: dict, cover: tuple[bytes, str] | None) -> None:
    from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, TPE2, ID3NoHeaderError

    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        tags = ID3()
    tags.setall("TIT2", [TIT2(encoding=3, text=[copy["title"]])])
    tags.setall("TPE1", [TPE1(encoding=3, text=[copy["artist"]])])
    if copy["album"]:
        tags.setall("TALB", [TALB(encoding=3, text=[copy["album"]])])
        tags.setall("TPE2", [TPE2(encoding=3, text=[copy["albumArtist"] or copy["artist"]])])
    if cover is not None:
        data, image_format = cover
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=f"image/{image_format}", type=3, desc="Cover", data=data))
    # ID3v2.3: the version Apple Music reads best.
    tags.save(str(path), v2_version=3)


def report_done(logger: logging.Logger, cfg: Any, copy_id: str) -> None:
    import requests

    try:
        with _session(cfg) as session:
            response = session.post(f"{cfg.app_url}{DONE_PATH}", json={"trackId": copy_id}, timeout=HTTP_TIMEOUT)
        if response.status_code // 100 != 2:
            logger.warning("apple-music-done returned HTTP %s: %s", response.status_code, response.text[:200])
    except requests.RequestException as exc:
        logger.warning("apple-music-done failed: %s", exc)


def process_copy(logger: logging.Logger, cfg: Any, copy: dict, folder: Path) -> bool:
    """One copy: download, convert if needed, tag, copy in, report. Never raises."""
    work = work_dir(copy["id"])
    try:
        work.mkdir(parents=True, exist_ok=True)
        path = download(cfg, copy["audioUrl"], work / f"source.{copy['format']}")
        if copy["format"] in CONVERT_TO_ALAC:
            path = to_alac(path)
        cover = fetch_cover(logger, cfg, copy["coverUrl"])
        if path.suffix == ".mp3":
            tag_mp3(path, copy, cover)
        else:
            tag_m4a(path, copy, cover)
        apple_music.copy_into_folder(logger, folder, copy, path)
    except Exception as exc:  # noqa: BLE001 - one copy failing never stops the others
        logger.error("Apple Music copy of %s failed (the app tries again later): %s", copy["title"], exc)
        return False
    finally:
        shutil.rmtree(work, ignore_errors=True)
    report_done(logger, cfg, copy["id"])
    return True


def run_once(logger: logging.Logger, cfg: Any) -> int:
    """One poll: claim copies and make them. Never raises. Returns the copies made."""
    done = 0
    try:
        copies = claim_copies(logger, cfg)
        if not copies:
            return 0
        folder = apple_music.find_apple_music_folder(logger, env_override=cfg.apple_music_folder)
        if folder is None:
            logger.error(apple_music.FOLDER_NOT_FOUND_ERROR)
            return 0
        for copy in copies:
            if process_copy(logger, cfg, copy, folder):
                done += 1
    except Exception:  # noqa: BLE001 - the downloader loop must keep running
        logger.exception("Apple Music copies crashed; the app hands them out again later")
    return done
