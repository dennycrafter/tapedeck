"""Playlist listing for imports (V2-PLAN T13, adapter 4: SoundCloud and YouTube links).

The web app cannot run yt-dlp (YouTube blocks cloud servers), so when the
owner pastes a SoundCloud profile or a YouTube channel or playlist on the
Import page, the job waits for this PC:

1. POST /api/agent/import/claim with the capability "import-listing". The
   answer holds at most one job: its id, its service and one "target" per
   pasted link (the web app already checked and cleaned the links).
2. For each target, `yt-dlp --flat-playlist -J <url>`:
   - SoundCloud profile: its /sets (each set listed again) and its /likes.
   - SoundCloud /sets, /albums or /likes page, or one set.
   - SoundCloud share link (on.soundcloud.com): followed first.
   - YouTube channel: its /playlists tab (each playlist listed again). A
     public "Favorites" list there is the channel's liked videos.
   - YouTube or YouTube Music playlist.
   SoundCloud's flat lists have no titles for set songs and no artist or
   length for any song, so SoundCloud songs get one more yt-dlp call, in
   batches, that reads only their details (no audio formats).
3. POST /api/agent/import/complete with every playlist and all its songs
   (each song with its own link), or with `error` when yt-dlp or the network
   failed (the app retries up to 3 times).

The whole job is one work unit, capped at MAX_SONGS songs and
JOB_BUDGET_SEC seconds (under the app's 15 minute claim), so the owner sees
real song counts on the checklist and reading the songs never waits again.

Never raises into the downloader loop: `run_once` logs and moves on.
Only the standard library is imported at module level (requests inside).
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlparse

IMPORT_CAPABILITY = "import-listing"
CLAIM_PATH = "/api/agent/import/claim"
COMPLETE_PATH = "/api/agent/import/complete"

HTTP_TIMEOUT = 30
# The result can be a megabyte on a slow home line.
COMPLETE_TIMEOUT = (10, 180)

# One yt-dlp call; a stuck one must not hold the whole job.
CALL_TIMEOUT_SEC = 5 * 60
# The whole job, well under the app's 15 minute claim (PC_CLAIM_STALE_MINUTES).
JOB_BUDGET_SEC = 12 * 60
# Songs in one job, all playlists together (the app keeps at most 5,000 too).
MAX_SONGS = 5000
# Playlists read from one profile or channel.
MAX_PLAYLISTS = 200
# SoundCloud songs per details call.
DETAILS_BATCH = 100

MAX_ERROR_CHARS = 500

SOUNDCLOUD_LIKES_NAME = "Likes"
YOUTUBE_LIKED_NAME = "Liked videos"

# yt-dlp's words for "this link does not work", as opposed to a network or
# yt-dlp problem worth trying again.
_GONE_PATTERNS = (
    "http error 404",
    "http error 400",
    "http error 403",
    "does not exist",
    "not found",
    "private",
    "unavailable",
    "this channel does not have",
    "unsupported url",
    "is not a valid url",
)

_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_SKIPPED_TITLES = {"[deleted video]", "[private video]", "[unavailable video]"}


class ListingError(Exception):
    """One target could not be read.

    `gone` means the link itself does not work (removed, private, wrong):
    the owner is told and the job still completes. Otherwise it is worth
    another try later (network, yt-dlp), and the whole job is retried.
    """

    def __init__(self, message: str, gone: bool) -> None:
        super().__init__(message)
        self.message = message
        self.gone = gone


# A runner takes yt-dlp's arguments (after `python -m yt_dlp`), optional
# stdin text and a timeout; it returns (exit code, stdout, stderr). Tests
# pass one that answers from the recorded fixtures.
Runner = Callable[[list[str], Any, float], tuple[int, str, str]]


def run_yt_dlp(args: list[str], stdin: str | None, timeout: float) -> tuple[int, str, str]:
    """Runs `python -m yt_dlp <args>` (the same interpreter pip installed it into)."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp", *args],
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ListingError("yt-dlp is not installed for this Python. Run install.bat again.", gone=False) from exc
    except subprocess.TimeoutExpired as exc:
        raise ListingError(f"yt-dlp took longer than {int(timeout)} seconds.", gone=False) from exc
    return result.returncode, result.stdout or "", result.stderr or ""


def flat_listing_args(url: str, limit: int) -> list[str]:
    """The listing command (V2-PLAN T13): metadata only, no songs resolved."""
    return ["--flat-playlist", "-J", "--no-warnings", "--playlist-end", str(max(1, limit)), url]


def soundcloud_details_args() -> list[str]:
    """Reads the song URLs from stdin and prints each song's details, one JSON per line.

    `soundcloud:formats=none` skips the audio formats (one request per song
    instead of several), and --ignore-no-formats-error keeps the details of
    songs SoundCloud protects (DRM): the downloader finds those on YouTube.
    """
    return [
        "-J",
        "--ignore-errors",
        "--no-warnings",
        "--ignore-no-formats-error",
        "--extractor-args",
        "soundcloud:formats=none",
        "--batch-file",
        "-",
    ]


def _error_tail(stderr: str) -> str:
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("ERROR")]
    return (errors or lines or ["no output"])[-1][:300]


def is_gone(stderr: str) -> bool:
    """True when yt-dlp says the link itself does not work."""
    text = _error_tail(stderr).lower()
    return any(pattern in text for pattern in _GONE_PATTERNS)


# --- Building songs and playlists from yt-dlp's JSON (pure, fixture tested) ---


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", value).strip() if isinstance(value, str) else ""


def _seconds(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(round(value)) if 0 < value <= 24 * 3600 else None


def youtube_track(entry: Any) -> dict | None:
    """One YouTube video of a flat playlist, or None for a deleted or private one."""
    if not isinstance(entry, dict):
        return None
    video_id = entry.get("id")
    title = _text(entry.get("title"))
    if not isinstance(video_id, str) or not _VIDEO_ID.match(video_id) or not title:
        return None
    if title.lower() in _SKIPPED_TITLES:
        return None
    artist = _text(entry.get("channel")) or _text(entry.get("uploader"))
    if artist.endswith(" - Topic"):
        artist = artist[: -len(" - Topic")]
    return {
        "ref": video_id,
        "title": title,
        "artist": artist,
        "durationSec": _seconds(entry.get("duration")),
        "link": f"https://www.youtube.com/watch?v={video_id}",
        "coverUrl": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    }


def is_youtube_liked(playlist_id: str) -> bool:
    """A channel's liked videos: "LL" (new) or "FL" (the public Favorites) plus the channel id."""
    return len(playlist_id) > 2 and playlist_id[:2] in ("LL", "FL")


def youtube_playlist(info: dict) -> dict:
    """One YouTube playlist (flat listing) with its videos."""
    playlist_id = str(info.get("id") or "")
    tracks = [track for track in map(youtube_track, info.get("entries") or []) if track]
    liked = is_youtube_liked(playlist_id)
    return {
        "ref": playlist_id,
        "name": YOUTUBE_LIKED_NAME if liked else (_text(info.get("title")) or "YouTube playlist"),
        "kind": "liked" if liked else "playlist",
        "coverUrl": tracks[0]["coverUrl"] if tracks else None,
        "tracks": tracks,
    }


def soundcloud_track_url(url: Any) -> bool:
    """True for a song page, soundcloud.com/<user>/<song> (not a set, not the API)."""
    if not isinstance(url, str):
        return False
    parsed = urlparse(url)
    if parsed.hostname not in ("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"):
        return False
    parts = [part for part in parsed.path.split("/") if part]
    return len(parts) == 2 and parts[1] not in ("sets", "likes", "albums", "tracks", "reposts")


def soundcloud_cover(url: Any) -> str | None:
    """The 500 px artwork instead of the original (which can be huge)."""
    if not isinstance(url, str) or not url.startswith("https://"):
        return None
    return re.sub(r"-original\.(jpg|png)$", r"-t500x500.\1", url)


def soundcloud_song_urls(info: dict) -> list[str]:
    """The URLs of a flat SoundCloud list's songs, liked sets left out.

    Set songs past the first few come as api-v2.soundcloud.com/tracks/<id>
    addresses; the details call turns those into song pages.
    """
    urls = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
            continue
        url = entry["url"]
        if soundcloud_track_url(url) or "api-v2.soundcloud.com/tracks/" in url or "api.soundcloud.com/tracks/" in url:
            urls.append(url)
    return urls


def soundcloud_track(entry: dict, details: dict | None) -> dict | None:
    """One SoundCloud song from its flat entry and its details (either may be thin)."""
    info = details or {}
    link = info.get("webpage_url") if soundcloud_track_url(info.get("webpage_url")) else entry.get("url")
    if not soundcloud_track_url(link):
        return None
    title = _text(info.get("title")) or _text(entry.get("title"))
    if not title:
        return None
    artists = info.get("artists")
    artist = _text(info.get("uploader"))
    if isinstance(artists, list) and artists and isinstance(artists[0], str):
        artist = _text(", ".join(a for a in artists if isinstance(a, str)))
    ref = str(info.get("id") or entry.get("id") or "") or link.split("soundcloud.com/", 1)[1]
    return {
        "ref": ref,
        "title": title,
        "artist": artist,
        "durationSec": _seconds(info.get("duration")),
        "link": link.split("?", 1)[0],
        "coverUrl": soundcloud_cover(info.get("thumbnail")),
    }


def soundcloud_playlist(info: dict, details: dict[str, dict], *, liked: bool) -> dict:
    """One SoundCloud set or likes list, its songs in order."""
    tracks = []
    for entry in info.get("entries") or []:
        # Liked sets and songs whose details failed (an API address, no title) drop out here.
        track = soundcloud_track(entry, details.get(entry.get("url"))) if isinstance(entry, dict) else None
        if track:
            tracks.append(track)
    playlist_id = str(info.get("id") or "")
    return {
        # A set's own id; a likes list is the profile's likes (the user id).
        "ref": f"likes:{playlist_id}" if liked else playlist_id,
        "name": SOUNDCLOUD_LIKES_NAME if liked else (_text(info.get("title")) or "SoundCloud playlist"),
        "kind": "liked" if liked else "playlist",
        "coverUrl": tracks[0]["coverUrl"] if tracks else None,
        "tracks": tracks,
    }


def parse_details(stdout: str) -> dict[str, dict]:
    """The details call's output: one JSON per line (null for a song that failed), by the URL asked for."""
    found: dict[str, dict] = {}
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            info = json.loads(line)
        except ValueError:
            continue
        if isinstance(info, dict) and isinstance(info.get("original_url"), str):
            found[info["original_url"]] = info
    return found


def soundcloud_target(url: str) -> tuple[str, str] | None:
    """(kind, url) for a SoundCloud page a share link led to, like the web app's check."""
    parsed = urlparse(url)
    if parsed.hostname not in ("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"):
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        return None
    profile = f"https://soundcloud.com/{parts[0]}"
    if len(parts) == 1:
        return "soundcloud-profile", profile
    if len(parts) == 2 and parts[1] == "likes":
        return "soundcloud-likes", f"{profile}/likes"
    if len(parts) == 2 and parts[1] in ("sets", "albums"):
        return "soundcloud-sets", f"{profile}/{parts[1]}"
    if len(parts) == 3 and parts[1] == "sets":
        return "soundcloud-set", f"{profile}/sets/{parts[2]}"
    return None


def resolve_short_link(url: str) -> str:
    """Follows an on.soundcloud.com share link to the page it opens."""
    import requests

    try:
        response = requests.get(url, allow_redirects=True, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise ListingError(f"Could not open {url}: {exc}", gone=False) from exc
    if response.status_code == 404:
        raise ListingError(f"That SoundCloud link doesn't work any more: {url}", gone=True)
    return response.url.split("?", 1)[0]


# --- Listing one job ---


@dataclass
class Lister:
    """Lists every target of one job within the song and time budget."""

    # None means the real yt-dlp and the real share link lookup.
    run: Runner | None = None
    resolve: Callable[[str], str] | None = None
    clock: Callable[[], float] = time.monotonic
    max_songs: int = MAX_SONGS
    budget_sec: float = JOB_BUDGET_SEC
    logger: logging.Logger = field(default_factory=lambda: logging.getLogger("tapedeck.import"))

    def __post_init__(self) -> None:
        self.run = self.run or run_yt_dlp
        self.resolve = self.resolve or resolve_short_link
        self.deadline = self.clock() + self.budget_sec
        self.songs = 0
        self.truncated = False
        self.playlists: list[dict] = []
        self.problems: list[str] = []
        self._refs: set[str] = set()

    # -- budget --

    def _room(self) -> int:
        return self.max_songs - self.songs

    def _time_left(self) -> float:
        return self.deadline - self.clock()

    def _out_of_budget(self) -> bool:
        if self._room() <= 0 or self._time_left() <= 5:
            self.truncated = True
            return True
        return False

    # -- yt-dlp --

    def _flat(self, url: str, limit: int) -> dict:
        code, stdout, stderr = self.run(flat_listing_args(url, limit), None, min(CALL_TIMEOUT_SEC, max(5, self._time_left())))
        info = None
        if stdout.strip():
            try:
                info = json.loads(stdout)
            except ValueError:
                info = None
        if isinstance(info, dict) and info:
            return info
        if code != 0 and is_gone(stderr):
            raise ListingError(f"Couldn't open {url}. Check that it exists and is public.", gone=True)
        raise ListingError(f"yt-dlp could not read {url}: {_error_tail(stderr)}", gone=False)

    def _soundcloud_details(self, urls: list[str]) -> dict[str, dict]:
        found: dict[str, dict] = {}
        for start in range(0, len(urls), DETAILS_BATCH):
            if self._time_left() <= 5:
                self.truncated = True
                break
            batch = urls[start : start + DETAILS_BATCH]
            code, stdout, stderr = self.run(
                soundcloud_details_args(), "\n".join(batch) + "\n", min(CALL_TIMEOUT_SEC, max(5, self._time_left()))
            )
            details = parse_details(stdout)
            if not details and code != 0 and not is_gone(stderr):
                raise ListingError(f"yt-dlp could not read the SoundCloud songs: {_error_tail(stderr)}", gone=False)
            found.update(details)
        return found

    # -- results --

    def _add(self, playlist: dict) -> None:
        if not playlist["ref"] or playlist["ref"] in self._refs or not playlist["tracks"]:
            return
        room = self._room()
        if len(playlist["tracks"]) > room:
            playlist["tracks"] = playlist["tracks"][:room]
            self.truncated = True
        if not playlist["tracks"]:
            return
        self._refs.add(playlist["ref"])
        self.songs += len(playlist["tracks"])
        self.playlists.append(playlist)

    # -- targets --

    def _soundcloud_list(self, url: str, *, liked: bool) -> None:
        info = self._flat(url, self._room())
        urls = soundcloud_song_urls(info)
        details = self._soundcloud_details(urls) if urls else {}
        self._add(soundcloud_playlist(info, details, liked=liked))

    def _soundcloud_sets(self, url: str) -> None:
        info = self._flat(url, MAX_PLAYLISTS)
        for entry in info.get("entries") or []:
            if self._out_of_budget():
                return
            set_url = entry.get("url") if isinstance(entry, dict) else None
            if not isinstance(set_url, str) or "/sets/" not in set_url:
                continue
            try:
                self._soundcloud_list(set_url, liked=False)
            except ListingError as exc:
                if not exc.gone:
                    raise
                self.logger.info("import: skipped a set: %s", exc.message)

    def _soundcloud_profile(self, url: str) -> None:
        self._soundcloud_sets(f"{url}/sets")
        if self._out_of_budget():
            return
        try:
            self._soundcloud_list(f"{url}/likes", liked=True)
        except ListingError as exc:
            if not exc.gone:
                raise
            self.logger.info("import: no likes: %s", exc.message)

    def _youtube_channel(self, url: str) -> None:
        info = self._flat(f"{url}/playlists", MAX_PLAYLISTS)
        for entry in info.get("entries") or []:
            if self._out_of_budget():
                return
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                continue
            try:
                self._youtube_playlist(f"https://www.youtube.com/playlist?list={entry['id']}")
            except ListingError as exc:
                if not exc.gone:
                    raise
                self.logger.info("import: skipped a playlist: %s", exc.message)

    def _youtube_playlist(self, url: str) -> None:
        self._add(youtube_playlist(self._flat(url, self._room())))

    def list_target(self, target: dict) -> None:
        kind = target.get("kind")
        url = target.get("url")
        if not isinstance(url, str):
            return
        if kind == "soundcloud-short":
            resolved = soundcloud_target(self.resolve(url))
            if not resolved:
                raise ListingError(f"That SoundCloud link doesn't open a profile or playlist: {target.get('link') or url}", gone=True)
            kind, url = resolved
        if kind == "soundcloud-profile":
            self._soundcloud_profile(url)
        elif kind == "soundcloud-sets":
            self._soundcloud_sets(url)
        elif kind == "soundcloud-likes":
            self._soundcloud_list(url, liked=True)
        elif kind == "soundcloud-set":
            self._soundcloud_list(url, liked=False)
        elif kind == "youtube-channel":
            self._youtube_channel(url)
        elif kind == "youtube-playlist":
            self._youtube_playlist(url)
        else:
            self.logger.warning("import: unknown link kind %r, skipped", kind)

    def list_job(self, job: dict) -> dict:
        """Every playlist of the job's targets: the complete body (without jobId).

        A link that does not work becomes a problem; anything worth another
        try raises ListingError(gone=False).
        """
        for target in job.get("targets") or []:
            if not isinstance(target, dict):
                continue
            if self._out_of_budget():
                break
            try:
                self.list_target(target)
            except ListingError as exc:
                if not exc.gone:
                    raise
                self.problems.append(exc.message)
        if self.truncated:
            self.logger.info("import: stopped early at %s songs", self.songs)
        return {"playlists": self.playlists, "problems": self.problems, "truncated": self.truncated}


# --- Talking to the app ---


def _session(cfg: Any):
    import requests

    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {cfg.agent_token}"
    return session


def claim_jobs(logger: logging.Logger, cfg: Any) -> list[dict]:
    """Claims listing jobs; an empty list on any problem (an older app answers 404)."""
    import requests

    try:
        with _session(cfg) as session:
            response = session.post(
                f"{cfg.app_url}{CLAIM_PATH}", json={"capabilities": [IMPORT_CAPABILITY]}, timeout=HTTP_TIMEOUT
            )
    except requests.RequestException as exc:
        logger.warning("Import claim failed (will retry): %s", exc)
        return []
    if response.status_code == 404:
        return []  # an app without playlist import
    if response.status_code // 100 != 2:
        logger.warning("Import claim returned HTTP %s: %s", response.status_code, response.text[:200])
        return []
    try:
        payload = response.json()
    except ValueError:
        logger.warning("Import claim returned an unreadable body.")
        return []
    jobs = payload.get("jobs") if isinstance(payload, dict) else None
    if not isinstance(jobs, list):
        return []
    return [job for job in jobs if isinstance(job, dict) and isinstance(job.get("id"), str)]


def send_complete(logger: logging.Logger, cfg: Any, body: dict) -> bool:
    import requests

    try:
        with _session(cfg) as session:
            response = session.post(f"{cfg.app_url}{COMPLETE_PATH}", json=body, timeout=COMPLETE_TIMEOUT)
    except requests.RequestException as exc:
        logger.warning("Import complete failed: %s", exc)
        return False
    if response.status_code // 100 != 2:
        logger.warning("Import complete returned HTTP %s: %s", response.status_code, response.text[:200])
        return False
    return True


def process_job(logger: logging.Logger, cfg: Any, job: dict, lister: Lister | None = None) -> bool:
    """Lists one claimed job and reports it. True when the app took the result."""
    lister = lister or Lister(logger=logger)
    job_id = job["id"]
    logger.info("import: listing %s link(s) for job %s", len(job.get("targets") or []), job_id)
    try:
        result = lister.list_job(job)
    except ListingError as exc:
        logger.warning("import: job %s failed (will retry): %s", job_id, exc.message)
        return send_complete(logger, cfg, {"jobId": job_id, "error": exc.message[:MAX_ERROR_CHARS]})
    songs = sum(len(playlist["tracks"]) for playlist in result["playlists"])
    logger.info("import: job %s found %s playlist(s), %s song(s)", job_id, len(result["playlists"]), songs)
    return send_complete(logger, cfg, {"jobId": job_id, **result})


def run_once(logger: logging.Logger, cfg: Any) -> int:
    """One poll: claim listing jobs and do them. Never raises. Returns the jobs done."""
    done = 0
    try:
        for job in claim_jobs(logger, cfg):
            if process_job(logger, cfg, job):
                done += 1
    except Exception:  # noqa: BLE001 - the downloader loop must keep running
        logger.exception("import: listing crashed; the app retries the job later")
    return done
