"""Best-copy finder for catalog songs (V2-PLAN T12).

A catalog song (added from catalog search or a playlist import) has a
clean title, artist, length and often an ISRC, but no link yet. This
module finds the best free copy of exactly that song, on the owner's PC
only (YouTube blocks cloud servers, SPEC 3):

1. Candidates, stopping early once one scores very high:
   a. YouTube Music songs search with ytmusicapi (official album audio,
      the "Topic" uploads),
   b. SoundCloud: `yt-dlp "scsearch5:<artist> <title>" --flat-playlist -J`,
   c. YouTube: `yt-dlp "ytsearch10:<artist> - <title>" --flat-playlist -J`.
   If ytmusicapi errors (or is not installed) the search goes on with
   SoundCloud and YouTube, and the problem is logged.
2. Every candidate is scored against the catalog facts (normalise rules
   ported from SPEC 8.5, see `normalise`): a hard reject when the length
   is off by more than max(5 s, 3%), title and artist token overlap, a
   bonus for official uploads ("Topic", the artist's own channel) and for
   the ISRC in the description, penalties for live, remix, cover, sped up
   and similar versions the catalog title does not ask for, and a small
   bonus per source (YouTube Music > SoundCloud > YouTube).
3. When the top two are close, `yt-dlp -J` on just those two reads the
   audio bitrate (and the full description for the ISRC bonus), and the
   better one wins.

Never strips DRM and never touches paid streaming services (DECISIONS,
v2 plan). Only the standard library is imported at module level, so
`import downloader` keeps working before any pip install; ytmusicapi is
imported inside the search function that uses it.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, replace
from typing import Any, Callable

# --- Constants ---

SOURCE_YTMUSIC = "ytmusic"
SOURCE_SOUNDCLOUD = "soundcloud"
SOURCE_YOUTUBE = "youtube"

# The failure text the app shows (V2-PLAN T12 step 4).
NO_MATCH_MESSAGE = "Couldn't find a matching version"

# A candidate this good ends the search before the next source is asked.
STOP_EARLY_SCORE = 0.95
# Below this nothing is downloaded and the song fails with NO_MATCH_MESSAGE.
MIN_SCORE = 0.7
# The top two within this many points are a tie: the bitrate decides.
TIE_MARGIN = 0.05
# matchInfo keeps the chosen copy plus up to this many runners-up.
MAX_ALTERNATIVES = 5

# Hard length reject: off by more than max(5 s, 3% of the catalog length).
LENGTH_SLACK_SEC = 5.0
LENGTH_SLACK_SHARE = 0.03

# Score weights. A perfect official YouTube Music match lands near 1.1.
WEIGHT_TITLE = 0.5
WEIGHT_ARTIST = 0.3
BONUS_OFFICIAL = 0.15
BONUS_ISRC = 0.15
BONUS_LENGTH = 0.05
SOURCE_BONUS = {SOURCE_YTMUSIC: 0.1, SOURCE_SOUNDCLOUD: 0.05, SOURCE_YOUTUBE: 0.0}
PENALTY_PER_WORD = 0.3
PENALTY_CAP = 0.6
# The catalog knows the length but the candidate does not: a small doubt.
PENALTY_UNKNOWN_LENGTH = 0.1

# Version words that mean "not the album version" unless the catalog title
# has them too. Each entry: (label, pattern on the lowercased title).
PENALTY_WORDS: tuple[tuple[str, str], ...] = (
    ("live", r"\blive\b"),
    ("remix", r"\bremix(?:es|ed)?\b"),
    ("cover", r"\bcover\b"),
    ("karaoke", r"\bkaraoke\b"),
    ("instrumental", r"\binstrumental\b"),
    ("sped up", r"\b(?:sped|speed)\s*up\b"),
    ("slowed", r"\bslowed\b"),
    ("nightcore", r"\bnightcore\b"),
    ("8d", r"\b8d\b"),
    ("reverb", r"\breverb\b"),
    ("extended", r"\bextended\b"),
    ("lyrics", r"\b(?:lyrics?|letra)\b"),
    ("acoustic", r"\bacoustic\b"),
    ("a cappella", r"\ba\s*cap+el+a\b"),
    ("demo", r"\bdemo\b"),
    ("mix", r"\bmix\b"),
    ("edit", r"\bedit\b"),
    ("stripped", r"\bstripped\b"),
    ("flip", r"\bflip\b"),
    ("bass boosted", r"\bbass\s*boost(?:ed)?\b"),
    ("loop", r"\bloop\b"),
)

# Search sizes (V2-PLAN T12 step 1).
YTMUSIC_LIMIT = 10
SOUNDCLOUD_RESULTS = 5
YOUTUBE_RESULTS = 10

# One search or one -J must not hang the downloader loop.
SEARCH_TIMEOUT_SEC = 120

# Text fields stored in matchInfo are cut to keep the row small (8 KB cap).
MAX_TEXT_CHARS = 200

# Runner: takes a command, returns (exit code, stdout, stderr). Tests pass
# a fake that replays recorded output; the real one runs yt-dlp.
Runner = Callable[[list[str]], tuple[int, str, str]]
# YouTube Music search: takes a query, returns ytmusicapi's raw result list.
YtMusicSearch = Callable[[str], list[dict]]


@dataclass(frozen=True)
class CatalogSong:
    """What the catalog says about the song we are looking for."""

    title: str
    artist: str
    duration_sec: float | None = None
    isrc: str | None = None


@dataclass(frozen=True)
class Candidate:
    """One possible copy, as found in a search result."""

    source: str  # SOURCE_YTMUSIC, SOURCE_SOUNDCLOUD or SOURCE_YOUTUBE
    url: str  # what yt-dlp downloads
    title: str  # the title as the site shows it
    uploader: str  # channel, SoundCloud user, or YouTube Music artists
    duration_sec: float | None
    song_title: str  # the title part used for matching
    song_artist: str  # the artist part used for matching
    official: bool = False  # a YouTube Music song or a "Topic" upload
    description: str = ""
    abr: float | None = None  # best audio bitrate (kbps), from -J details
    score: float = 0.0
    rejected: str | None = None  # why it can never win, or None


@dataclass(frozen=True)
class FinderResult:
    """The winner (None when nothing scored high enough) and the ranking."""

    chosen: Candidate | None
    ranked: list[Candidate]

    def match_info(self) -> dict[str, Any]:
        return build_match_info(self.chosen, self.ranked)


class NoMatchError(RuntimeError):
    """Nothing scored high enough; carries matchInfo with the alternatives."""

    def __init__(self, message: str, match_info: dict[str, Any]) -> None:
        super().__init__(message)
        self.match_info = match_info


# --- Normalising and matching (SPEC 8.5 rules, same as web/lib/cover-art.ts) ---

_BRACKET_GROUP = re.compile(r"[(\[{]([^()\[\]{}]*?)[)\]}]")
_FEAT_MARKER = re.compile(r"\b(?:featuring|feat|ft)\b\s*\.?:?\s*", re.IGNORECASE)
_PUNCTUATION = re.compile(r"[^\w\s]|_", re.UNICODE)
_SPACES = re.compile(r"\s+")
# " - ", or an en or em dash with a space on each side (SPEC 8.4).
_ARTIST_TITLE_SEPARATOR = re.compile(r"\s[-\u2013\u2014]\s")
# Uploader suffixes that are not part of the artist name (SPEC 8.4).
_UPLOADER_SUFFIX = re.compile(r"(?:\s+-\s+topic|vevo|\s*official)\s*$", re.IGNORECASE)
# A catalog title suffix like " - 2011 Remaster" names the same recording.
_REMASTER_SUFFIX = re.compile(r"\s+-\s+[^-]*\bremaster(?:ed)?\b[^-]*$", re.IGNORECASE)
_ISRC_PATTERN = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}\d{7}$")


def strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def normalise(text: str) -> str:
    """The SPEC 8.5 normal form (a port of web/lib/cover-art.ts normalizeForMatch).

    Lowercase, "&" becomes "and", accents stripped, bracketed text removed,
    the feat part removed, punctuation removed, spaces collapsed, and a
    leading "the " dropped.
    """
    current = (text or "").lower().replace("&", " and ")
    current = strip_accents(current)
    previous = None
    while current != previous:  # nested brackets: remove until stable
        previous = current
        current = _BRACKET_GROUP.sub(" ", current)
    feat = _FEAT_MARKER.search(current)
    if feat:
        current = current[: feat.start()]
    current = _PUNCTUATION.sub(" ", current)
    current = _SPACES.sub(" ", current).strip()
    if current.startswith("the "):
        current = current[4:]
    return current.strip()


def tokens(text: str) -> set[str]:
    return {token for token in normalise(text).split(" ") if token}


def jaccard(a: set[str], b: set[str]) -> float:
    """Token-set Jaccard overlap (SPEC 8.5)."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def artist_matches(ours: str, theirs: str) -> bool:
    """One normalised artist contains the other's (SPEC 8.5)."""
    a, b = normalise(ours), normalise(theirs)
    if not a or not b:
        return False
    return a in b or b in a


def clean_uploader(name: str) -> str:
    """Channel name without " - Topic", "VEVO" or "Official" (SPEC 8.4)."""
    return _UPLOADER_SUFFIX.sub("", (name or "").strip()).strip()


def split_artist_title(raw_title: str, uploader: str) -> tuple[str, str]:
    """(artist, title) from a video title, SPEC 8.4 style.

    "Artist - Title" splits on the first separator; otherwise the artist
    is the uploader without its suffixes and the title is the whole text.
    """
    parts = _ARTIST_TITLE_SEPARATOR.split(raw_title or "", maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    return clean_uploader(uploader), (raw_title or "").strip()


def catalog_title_for_matching(title: str) -> str:
    """Drop a " - 2011 Remaster" style suffix: it names the same recording."""
    return _REMASTER_SUFFIX.sub("", title or "").strip()


def length_tolerance(catalog_sec: float) -> float:
    return max(LENGTH_SLACK_SEC, LENGTH_SLACK_SHARE * catalog_sec)


def length_ok(candidate_sec: float | None, catalog_sec: float | None) -> bool:
    """False only when both lengths are known and too far apart."""
    if candidate_sec is None or not catalog_sec:
        return True
    return abs(candidate_sec - catalog_sec) <= length_tolerance(catalog_sec)


def penalty_words(candidate_title: str, catalog_title: str, catalog_artist: str = "") -> list[str]:
    """Version words in the candidate title that the catalog song lacks.

    The catalog artist counts too: catalogs sometimes file a remix under
    an artist like "Trinix Remix".
    """
    theirs = strip_accents((candidate_title or "").lower())
    ours = strip_accents(f"{catalog_title or ''} {catalog_artist or ''}".lower())
    found = []
    for label, pattern in PENALTY_WORDS:
        if re.search(pattern, theirs) and not re.search(pattern, ours):
            found.append(label)
    return found


def isrc_in(description: str, isrc: str | None) -> bool:
    """The catalog ISRC appears in the description (dashes and spaces ignored)."""
    if not isrc or not description:
        return False
    wanted = re.sub(r"[\s-]", "", isrc).upper()
    if not _ISRC_PATTERN.match(wanted):
        return False
    return wanted in re.sub(r"[\s-]", "", description).upper()


def title_similarity(song: CatalogSong, candidate: Candidate) -> float:
    """Token overlap of the titles, also trying the full text minus the artist.

    Covers uploads that put the artist in the title without a " - "
    ("Daft Punk Harder Better Faster Stronger").
    """
    ours = tokens(catalog_title_for_matching(song.title))
    best = jaccard(ours, tokens(candidate.song_title))
    full = tokens(candidate.title) - tokens(song.artist)
    return max(best, jaccard(ours, full))


def artist_similarity(song: CatalogSong, candidate: Candidate) -> float:
    if artist_matches(song.artist, candidate.song_artist) or artist_matches(
        song.artist, clean_uploader(candidate.uploader)
    ):
        return 1.0
    ours = tokens(song.artist)
    theirs = tokens(candidate.song_artist) | tokens(candidate.uploader) | tokens(candidate.title)
    if not ours:
        return 0.0
    # Share of the catalog artist's words found anywhere in the result.
    return len(ours & theirs) / len(ours)


def is_official(song: CatalogSong, candidate: Candidate) -> bool:
    """An official upload of this artist.

    A YouTube Music song or a "Topic" upload whose artist matches, or a
    channel that is the artist's own (its name is the artist once the
    words "official", "VEVO" and "Topic" and the spaces are left out).
    YouTube Music also lists covers by other artists as songs, so the
    artist must match.
    """
    if candidate.official or re.search(r"\s-\s+topic$", candidate.uploader or "", re.IGNORECASE):
        return artist_matches(song.artist, candidate.song_artist) or artist_matches(
            song.artist, clean_uploader(candidate.uploader)
        )
    channel = re.sub(r"\b(?:official|vevo|topic)\b", " ", normalise(candidate.uploader))
    # "VEVO" may be glued on: "ArcticMonkeysVEVO".
    channel = re.sub(r"vevo$", "", channel.replace(" ", ""))
    return bool(channel) and channel == normalise(song.artist).replace(" ", "")


def score_candidate(song: CatalogSong, candidate: Candidate) -> Candidate:
    """Score one candidate; a wrong length marks it rejected (score kept for ranking)."""
    rejected = None
    if not length_ok(candidate.duration_sec, song.duration_sec):
        rejected = "length"
    score = WEIGHT_TITLE * title_similarity(song, candidate)
    score += WEIGHT_ARTIST * artist_similarity(song, candidate)
    if is_official(song, candidate):
        score += BONUS_OFFICIAL
    if isrc_in(candidate.description, song.isrc):
        score += BONUS_ISRC
    score += SOURCE_BONUS.get(candidate.source, 0.0)
    if song.duration_sec and candidate.duration_sec is not None and rejected is None:
        diff = abs(candidate.duration_sec - song.duration_sec)
        score += BONUS_LENGTH * (1 - diff / length_tolerance(song.duration_sec))
    elif song.duration_sec and candidate.duration_sec is None:
        score -= PENALTY_UNKNOWN_LENGTH
    words = penalty_words(candidate.title, song.title, song.artist)
    score -= min(PENALTY_CAP, PENALTY_PER_WORD * len(words))
    return replace(candidate, score=round(score, 4), rejected=rejected)


# --- Reading search results ---


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _duration_from_text(text: Any) -> float | None:
    """"3:45" or "1:02:03" to seconds."""
    if not isinstance(text, str) or not re.fullmatch(r"\d+(?::\d{1,2}){1,2}", text.strip()):
        return None
    seconds = 0
    for part in text.strip().split(":"):
        seconds = seconds * 60 + int(part)
    return float(seconds) or None


def youtube_watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def candidates_from_ytmusic(results: Any) -> list[Candidate]:
    """ytmusicapi `search(filter="songs")` results to candidates."""
    found: list[Candidate] = []
    if not isinstance(results, list):
        return found
    for item in results:
        if not isinstance(item, dict) or not item.get("videoId"):
            continue
        if item.get("resultType") not in (None, "song"):
            continue
        artists = [
            str(a.get("name")) for a in item.get("artists") or [] if isinstance(a, dict) and a.get("name")
        ]
        artist = ", ".join(artists)
        title = str(item.get("title") or "")
        duration = _number(item.get("duration_seconds")) or _duration_from_text(item.get("duration"))
        found.append(
            Candidate(
                source=SOURCE_YTMUSIC,
                url=youtube_watch_url(str(item["videoId"])),
                title=title,
                uploader=artist,
                duration_sec=duration,
                song_title=title,
                song_artist=artist,
                official=True,
            )
        )
    return found


def _entry_url(entry: dict, source: str) -> str | None:
    if source == SOURCE_YOUTUBE:
        video_id = entry.get("id")
        if isinstance(video_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            return youtube_watch_url(video_id)
        return None
    for key in ("webpage_url", "url", "original_url"):
        value = entry.get(key)
        if isinstance(value, str) and re.match(r"https://(?:www\.|m\.)?soundcloud\.com/[^/]+/[^/?#]+", value):
            return value.split("?")[0].replace("://m.", "://").replace("://www.", "://")
    return None


def candidates_from_ytdlp(payload: Any, source: str) -> list[Candidate]:
    """`yt-dlp <scsearch|ytsearch> --flat-playlist -J` output to candidates."""
    found: list[Candidate] = []
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return found
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = _entry_url(entry, source)
        if not url:
            continue
        title = str(entry.get("title") or "")
        uploader = str(entry.get("channel") or entry.get("uploader") or "")
        song_artist, song_title = split_artist_title(title, uploader)
        found.append(
            Candidate(
                source=source,
                url=url,
                title=title,
                uploader=uploader,
                duration_sec=_number(entry.get("duration")),
                song_title=song_title,
                song_artist=song_artist,
                description=str(entry.get("description") or ""),
            )
        )
    return found


def details_from_ytdlp(payload: Any) -> tuple[float | None, str]:
    """(best audio bitrate in kbps, full description) from `yt-dlp -J <url>`."""
    if not isinstance(payload, dict):
        return None, ""
    best: float | None = None
    for fmt in payload.get("formats") or []:
        if not isinstance(fmt, dict):
            continue
        if fmt.get("acodec") in (None, "none"):
            continue
        abr = _number(fmt.get("abr"))
        if abr is None and fmt.get("vcodec") in (None, "none"):
            abr = _number(fmt.get("tbr"))
        if abr is not None and (best is None or abr > best):
            best = abr
    if best is None:
        best = _number(payload.get("abr"))
    return best, str(payload.get("description") or "")


# --- Talking to the outside world (real runs only; tests inject fakes) ---


def run_command(command: list[str]) -> tuple[int, str, str]:
    """Run one yt-dlp command with a timeout; (exit code, stdout, stderr)."""
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SEARCH_TIMEOUT_SEC,
            check=False,
        )
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {SEARCH_TIMEOUT_SEC} s"
    return result.returncode, result.stdout or "", result.stderr or ""


def search_ytmusic(query: str) -> list[dict]:
    """YouTube Music songs search, unauthenticated (ytmusicapi)."""
    from ytmusicapi import YTMusic  # imported here: the downloader must load without it

    return YTMusic().search(query, filter="songs", limit=YTMUSIC_LIMIT)


def ytdlp_search_command(search: str) -> list[str]:
    """`yt-dlp "<scsearch5:...|ytsearch10:...>" --flat-playlist -J`, via this Python."""
    return [sys.executable, "-m", "yt_dlp", "--flat-playlist", "-J", "--no-warnings", search]


def ytdlp_details_command(url: str) -> list[str]:
    """`yt-dlp -J <url>`: formats (bitrate) and the full description."""
    return [
        sys.executable,
        "-m",
        "yt_dlp",
        "-J",
        "--no-playlist",
        "--no-warnings",
        "--js-runtimes",
        "deno",
        url,
    ]


def soundcloud_query(song: CatalogSong) -> str:
    return f"scsearch{SOUNDCLOUD_RESULTS}:{song.artist} {song.title}".strip()


def youtube_query(song: CatalogSong) -> str:
    return f"ytsearch{YOUTUBE_RESULTS}:{song.artist} - {song.title}".strip()


def ytmusic_query(song: CatalogSong) -> str:
    return f"{song.artist} {song.title}".strip()


def _run_json(logger: logging.Logger, runner: Runner, command: list[str], what: str) -> Any:
    code, stdout, stderr = runner(command)
    if code != 0:
        tail = " | ".join((stderr or stdout or "").strip().splitlines()[-3:])
        logger.warning("finder: %s failed (exit %s): %s", what, code, tail)
        return None
    try:
        return json.loads(stdout)
    except ValueError:
        logger.warning("finder: %s did not return JSON.", what)
        return None


# --- Ranking ---


def _rank_key(candidate: Candidate) -> tuple[int, float]:
    return (0 if candidate.rejected is None else 1, -candidate.score)


def rank(candidates: list[Candidate]) -> list[Candidate]:
    """Accepted ones first, best score first; one entry per URL."""
    seen: set[str] = set()
    ranked = []
    for candidate in sorted(candidates, key=_rank_key):
        if candidate.url in seen:
            continue
        seen.add(candidate.url)
        ranked.append(candidate)
    return ranked


def _best_score(candidates: list[Candidate]) -> float:
    return max((c.score for c in candidates if c.rejected is None), default=0.0)


def break_tie(
    logger: logging.Logger, song: CatalogSong, ranked: list[Candidate], runner: Runner
) -> list[Candidate]:
    """When the top two accepted ones are within TIE_MARGIN, ask yt-dlp -J about both.

    The details add the full description (ISRC bonus) and the audio
    bitrate. After rescoring, a remaining tie goes to the higher bitrate.
    Only the top two are looked up, which keeps it fast.
    """
    accepted = [c for c in ranked if c.rejected is None]
    if len(accepted) < 2 or accepted[0].score - accepted[1].score > TIE_MARGIN:
        return ranked
    top = []
    for candidate in accepted[:2]:
        payload = _run_json(logger, runner, ytdlp_details_command(candidate.url), f"details for {candidate.url}")
        abr, description = details_from_ytdlp(payload)
        detailed = replace(candidate, abr=abr, description=description or candidate.description)
        top.append(score_candidate(song, detailed))
    first, second = top
    if abs(first.score - second.score) <= TIE_MARGIN:
        if (second.abr or 0) > (first.abr or 0):
            first, second = second, first
        logger.info(
            "finder: near tie, bitrate decides (%s kbps vs %s kbps).", first.abr, second.abr
        )
    elif second.score > first.score:
        first, second = second, first
    rest = [c for c in ranked if c.url not in (first.url, second.url)]
    return [first, second] + rest


def find_best_copy(
    logger: logging.Logger,
    song: CatalogSong,
    runner: Runner | None = None,
    ytmusic: YtMusicSearch | None = None,
) -> FinderResult:
    """Search the three sources in order and pick the best copy (V2-PLAN T12).

    `runner` and `ytmusic` default to the real yt-dlp and ytmusicapi calls,
    looked up when called so tests can swap them for recorded output.
    """
    runner = runner or run_command
    ytmusic = ytmusic or search_ytmusic
    found: list[Candidate] = []

    try:
        results = ytmusic(ytmusic_query(song))
        found += [score_candidate(song, c) for c in candidates_from_ytmusic(results)]
    except Exception as exc:  # any ytmusicapi problem: go on with the other sources
        logger.warning("finder: YouTube Music search failed, falling back to YouTube: %s", exc)

    for source, query in ((SOURCE_SOUNDCLOUD, soundcloud_query(song)), (SOURCE_YOUTUBE, youtube_query(song))):
        if _best_score(found) >= STOP_EARLY_SCORE:
            break
        payload = _run_json(logger, runner, ytdlp_search_command(query), f"{source} search")
        found += [score_candidate(song, c) for c in candidates_from_ytdlp(payload, source)]

    ranked = break_tie(logger, song, rank(found), runner)
    winner = ranked[0] if ranked and ranked[0].rejected is None and ranked[0].score >= MIN_SCORE else None
    if winner:
        logger.info("finder: picked %s (%s, score %.2f).", winner.url, winner.source, winner.score)
    else:
        logger.info("finder: no copy scored %.2f or more (%s candidates).", MIN_SCORE, len(ranked))
    return FinderResult(chosen=winner, ranked=ranked)


# --- matchInfo (web/lib/track-v2.ts MatchInfo shape) ---


def candidate_to_json(candidate: Candidate) -> dict[str, Any]:
    """A MatchCandidate: title, uploader, durationSec, url, score, source."""
    return {
        "title": candidate.title[:MAX_TEXT_CHARS],
        "uploader": candidate.uploader[:MAX_TEXT_CHARS],
        "durationSec": round(candidate.duration_sec) if candidate.duration_sec else None,
        "url": candidate.url,
        # A copy with the wrong length can still be picked by hand, but never scores.
        "score": 0.0 if candidate.rejected else round(max(candidate.score, 0.0), 2),
        "source": candidate.source,
    }


def build_match_info(chosen: Candidate | None, ranked: list[Candidate]) -> dict[str, Any]:
    """{ chosen, score, alternatives } with up to MAX_ALTERNATIVES runners-up."""
    alternatives = [c for c in ranked if chosen is None or c.url != chosen.url][:MAX_ALTERNATIVES]
    return {
        "chosen": candidate_to_json(chosen) if chosen else None,
        "score": round(chosen.score, 2) if chosen else None,
        "alternatives": [candidate_to_json(c) for c in alternatives],
    }


# --- The downloader hook ---


def source_of_url(url: str) -> str:
    return SOURCE_SOUNDCLOUD if re.match(r"https?://(?:[a-z]+\.)?soundcloud\.com/", url or "") else SOURCE_YOUTUBE


def resolve_catalog_track(
    logger: logging.Logger,
    track: dict,
    runner: Runner | None = None,
    ytmusic: YtMusicSearch | None = None,
) -> tuple[dict, dict[str, Any]]:
    """Turn a claimed catalog row into a normal row with a link to download.

    Returns (track copy with source, source_url and resolved_url set, extra fields for
    /api/agent/complete). A row re-queued by "Pick another version" has
    resolved_url set: that exact copy is downloaded, no search. Raises
    NoMatchError (with matchInfo) when nothing scores high enough.
    """
    picked = track.get("resolved_url")
    if picked:
        logger.info("finder: downloading the version picked in the app: %s", picked)
        picked_track = {**track, "source": source_of_url(picked), "source_url": picked, "resolved_url": picked}
        return picked_track, {"resolvedUrl": picked}

    song = CatalogSong(
        title=str(track.get("title") or ""),
        artist=str(track.get("artist") or ""),
        duration_sec=float(track["duration_sec"]) if track.get("duration_sec") else None,
        isrc=track.get("isrc") or None,
    )
    logger.info("finder: looking for %s - %s (%s s).", song.artist, song.title, song.duration_sec)
    result = find_best_copy(logger, song, runner=runner, ytmusic=ytmusic)
    info = result.match_info()
    if result.chosen is None:
        raise NoMatchError(NO_MATCH_MESSAGE, info)
    url = result.chosen.url
    return (
        # resolved_url too, so the trim step (T10) asks SponsorBlock about this copy.
        {**track, "source": source_of_url(url), "source_url": url, "resolved_url": url},
        {"resolvedUrl": url, "matchInfo": info},
    )
