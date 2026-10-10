"""Apple Music auto-add folder export (SPEC 8.11, implemented in T6a).

When the profile setting "Also add to Apple Music on my PC" is on, or a
single song carries the per-track Apple Music flag, the downloader copies
the finished .m4a into Apple Music's "Automatically Add" folder on the
PC. Apple Music watches that folder, imports the file and removes it by
itself; getting the songs onto the iPhone then needs a cable or Wi-Fi
sync from the Apple Devices app (the owner has no Apple Music
subscription) — the app does not automate that part (SPEC 8.11).

This module holds the filesystem side of that step and is deliberately
HTTP-free: the /api/agent settings fetch and the apple-music-done report
live in downloader.py next to the other endpoint helpers. Only the
Python standard library is imported at module level, so `--help` keeps
working before any pip install.

Folder detection chain (SPEC 8.11, first that exists):
1. the `APPLE_MUSIC_FOLDER` override from agent/.env,
2. any folder whose name starts with "Automatically Add" within 3 levels
   under `%USERPROFILE%\\Music\\Apple Music`,
3. the iTunes media folder's "Automatically Add to iTunes" — parsed
   best-effort from iTunesPrefs (a moved library) when available, with
   the default `%USERPROFILE%\\Music\\iTunes\\iTunes Media` location as
   the backstop.
"""

import logging
import os
import re
import shutil
import urllib.parse
from pathlib import Path

# SPEC 8.11 error text, used when no auto-add folder is found. The song
# stays ready; only the Apple Music step fails.
FOLDER_NOT_FOUND_ERROR = (
    "Apple Music folder not found. Open Apple Music on your PC once, "
    "or set APPLE_MUSIC_FOLDER."
)

# An auto-add folder is any directory whose name starts with this prefix
# (Apple names it "Automatically Add to Music"/"...to iTunes" by locale).
AUTO_ADD_PREFIX = "Automatically Add"

# How deep under Music\\Apple Music the chain looks (SPEC 8.11).
MAX_AUTO_ADD_DEPTH = 3

# Windows-invalid filename characters plus ASCII control characters,
# stripped from the exported filename (SPEC 8.11).
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Media folder URLs inside iTunesPrefs, percent-encoded and undelimited;
# matching stops at whitespace/control characters and quote-like delims.
_FILE_URL = re.compile(r"file://localhost/([^\x00-\x1f\s\"'<>|*?\\]+)", re.IGNORECASE)


# --- Pure helpers (unit tested in tests/test_apple_music.py) ---


def export_filename(artist: str, title: str, track_id: str) -> str:
    """SPEC 8.11 target name: `<Artist> - <Title>.m4a`.

    Windows-invalid characters are stripped (removed, not replaced) and
    trailing dots/spaces go too, so the file lands on NTFS unchanged.
    Each part is sanitised on its own so an empty part cannot leave a
    stray separator, and a name that sanitises away completely falls
    back to the track id, which is always a safe UUID.
    """
    parts = [
        part
        for part in (INVALID_FILENAME_CHARS.sub("", text).strip(" .") for text in (artist, title))
        if part
    ]
    return f"{' - '.join(parts)}.m4a" if parts else f"{track_id}.m4a"


def parse_itunes_media_folder(data: bytes) -> Path | None:
    """Best-effort iTunes media folder path from iTunesPrefs bytes.

    Apple does not document the prefs format and the parse must never be
    load-bearing: on a real installation the media folder shows up
    inside the file as a percent-encoded `file://localhost/...` URL
    (UTF-16LE on Windows), so scan both UTF-16LE and UTF-8 decodings and
    prefer a URL that decodes to the standard "iTunes Media" name. None
    when nothing URL-shaped is found.

    Windows URLs carry the drive (`file://localhost/C%3A/...`) and are
    absolute once decoded; every other URL is treated as rooted at the
    filesystem root, since the slash after the host is the path's own
    leading slash.
    """
    for encoding in ("utf-16-le", "utf-8"):
        text = data.decode(encoding, errors="ignore")
        urls = [urllib.parse.unquote(url).strip() for url in _FILE_URL.findall(text)]
        if not urls:
            continue
        paths = [
            Path(u) if re.match(r"^[A-Za-z]:/", u) else Path("/" + u.lstrip("/")) for u in urls
        ]
        media = [p for p in paths if "itunes media" in str(p).lower()]
        return (media or paths)[-1]
    return None


def find_apple_music_folder(
    logger: logging.Logger,
    env_override: str = "",
    userprofile: Path | str | None = None,
    appdata: Path | str | None = None,
) -> Path | None:
    """The first existing auto-add folder from the SPEC 8.11 chain, or None.

    `userprofile`/`appdata` default to the environment (a real PC always
    sets USERPROFILE and APPDATA); tests pass fake layouts explicitly.
    An override that points nowhere falls through to auto-detection
    (SPEC 8.11: "first that exists") with a warning so a broken setting
    is visible in the log.
    """
    userprofile = Path(userprofile or os.environ.get("USERPROFILE") or Path.home())
    appdata = Path(appdata) if appdata else None

    override = env_override.strip()
    if override:
        override_path = Path(override)
        if override_path.is_dir():
            return override_path
        logger.warning(
            "APPLE_MUSIC_FOLDER is set to %s but that folder does not exist; "
            "trying automatic detection.",
            override,
        )

    # 2. Any "Automatically Add*" directory within 3 levels under
    # Music\\Apple Music — the folder itself sits at relative depth
    # 1..3, shallowest first for determinism.
    music_root = userprofile / "Music" / "Apple Music"
    if music_root.is_dir():
        for depth in range(1, MAX_AUTO_ADD_DEPTH + 1):
            pattern = "/".join(["*"] * (depth - 1) + [AUTO_ADD_PREFIX + "*"])
            hits = sorted(p for p in music_root.glob(pattern) if p.is_dir())
            if hits:
                return hits[0]

    # 3. The iTunes media folder's auto-add folder: the path parsed from
    # iTunesPrefs (covers a moved library), then the default location.
    for media_root in _itunes_media_roots(logger, userprofile, appdata):
        candidate = media_root / "Automatically Add to iTunes"
        if candidate.is_dir():
            return candidate
    return None


def _itunes_prefs_path(userprofile: Path, appdata: Path | None) -> Path:
    """iTunesPrefs' standard Windows location: %APPDATA%\\Apple Computer\\iTunes."""
    base = appdata or userprofile / "AppData" / "Roaming"
    return base / "Apple Computer" / "iTunes" / "iTunesPrefs"


def _itunes_media_roots(
    logger: logging.Logger, userprofile: Path, appdata: Path | None
) -> list[Path]:
    """Candidate iTunes media folders, parsed prefs first, default second."""
    roots = []
    prefs = _itunes_prefs_path(userprofile, appdata)
    try:
        if prefs.is_file():
            parsed = parse_itunes_media_folder(prefs.read_bytes())
            if parsed is not None:
                roots.append(parsed)
    except OSError as exc:  # unreadable prefs must never fail the chain
        logger.warning("Could not read %s: %s", prefs, exc)
    roots.append(userprofile / "Music" / "iTunes" / "iTunes Media")
    return roots


# --- Copy stage (SPEC 8.11) ---


def copy_into_folder(
    logger: logging.Logger,
    folder: Path,
    track: dict,
    path: Path,
) -> Path:
    """Copy the finished file into the auto-add folder, return the target.

    A copy, never a move: Apple Music imports and removes the files from
    that folder by itself (SPEC 8.11). An identical target (the same song
    processed twice) is overwritten — that is the wanted dedup, since a
    re-export of one song should not pile up duplicates.
    """
    target = folder / export_filename(track["artist"], track["title"], track["id"])
    shutil.copy2(path, target)
    logger.info("apple-music: copied %s into %s.", target.name, folder)
    return target
