"""Automatic trim suggestions for the PC downloader (V2-PLAN T10).

YouTube uploads often have talking, noise or silence before and after the
song. This module looks at a finished .m4a and suggests where the song
really starts and ends. The audio file itself is never changed: the
suggestion travels to the app as `autoTrimStartSec` / `autoTrimEndSec` on
POST /api/agent/complete, and the player honours it (trim is
non-destructive, V2-PLAN "Decisions already made").

Two sources, combined:

1. SponsorBlock (YouTube copies only): the community marks "music_offtopic"
   segments (the non-music part of a music video). Only a segment that
   starts within 1 second of 0 becomes a start trim, and only one that
   ends within 1 second of the end becomes an end trim. Segments in the
   middle are ignored for now.
2. ffmpeg silencedetect: leading silence from 0 gives a start trim, a
   silence that runs to the end gives an end trim. 0.3 s of the silence is
   kept on each side so the music never starts abruptly.

Combine: start = the larger start suggestion, end = the smaller end
suggestion. The whole suggestion is dropped when it would leave less than
60% of the song or less than 30 seconds. Values are rounded to 0.1 s.

Every failure here is quiet: a trim suggestion is a nicety, so network
errors, a missing ffmpeg or odd output only log and suggest nothing. The
song is still uploaded and marked ready.

Only the standard library is imported at module level (like
downloader.py); requests is imported where it is used.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import parse_qs, urlparse

SPONSORBLOCK_URL = "https://sponsor.ajay.app/api/skipSegments"
SPONSORBLOCK_CATEGORY = "music_offtopic"
SPONSORBLOCK_TIMEOUT = 10

# A segment counts as "at the start" / "at the end" within this distance.
EDGE_TOLERANCE_SEC = 1.0

# silencedetect settings (V2-PLAN T10): -50 dB, at least 0.5 s.
SILENCE_NOISE = "-50dB"
SILENCE_MIN_SEC = 0.5
# How much of the detected silence to keep next to the music.
SILENCE_MARGIN_SEC = 0.3
# A silence_start this close to 0 means the file starts silent.
SILENCE_FROM_ZERO_SEC = 0.05
# A silence_end this close to the file's end means the silence runs to the end
# (the ffmpeg 9 build used for the fixtures prints a last silence_end at the
# end of the file; older builds may print none, which counts the same).
SILENCE_TO_END_SEC = 0.25
SILENCE_TIMEOUT_SEC = 10 * 60

# Never cut away more than this (V2-PLAN T10).
MIN_KEEP_RATIO = 0.6
MIN_KEEP_SEC = 30.0

_YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_SILENCE_START = re.compile(r"silence_start:\s*(-?[0-9.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?[0-9.]+)")

# (url, params, timeout) -> response with .status_code, .json() and .text.
# A module-level hook so tests can replace the network (no network in tests).
HttpGet = Callable[[str, Mapping[str, str], float], Any]


def _requests_get(url: str, params: Mapping[str, str], timeout: float) -> Any:
    import requests

    return requests.get(url, params=params, timeout=timeout)


http_get: HttpGet = _requests_get


@dataclass(frozen=True)
class Edges:
    """A start and/or end suggestion in seconds; None means no cut there."""

    start: float | None = None
    end: float | None = None


# --- SponsorBlock ---


def youtube_video_id(url: str | None) -> str | None:
    """The 11 character video id of a YouTube or YouTube Music link, else None."""
    if not url:
        return None
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    candidate: str | None = None
    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0]
    elif host in ("youtube.com", "m.youtube.com", "music.youtube.com"):
        if parsed.path == "/watch":
            candidate = (parse_qs(parsed.query).get("v") or [None])[0]
        else:
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v"):
                candidate = parts[1]
    if candidate and _YOUTUBE_ID.match(candidate):
        return candidate
    return None


def parse_sponsorblock(payload: Any, duration: float) -> Edges:
    """Turn a skipSegments response into start/end suggestions.

    Only "music_offtopic" skip segments count. A segment starting within
    1 s of 0 suggests a start (its end); one ending within 1 s of the end
    suggests an end (its start). Middle segments are ignored.
    """
    if not isinstance(payload, list):
        return Edges()
    start: float | None = None
    end: float | None = None
    for item in payload:
        if not isinstance(item, dict):
            continue
        if item.get("category") != SPONSORBLOCK_CATEGORY:
            continue
        if item.get("actionType", "skip") != "skip":
            continue
        segment = item.get("segment")
        if not isinstance(segment, list) or len(segment) != 2:
            continue
        try:
            seg_start, seg_end = float(segment[0]), float(segment[1])
        except (TypeError, ValueError):
            continue
        if seg_end <= seg_start:
            continue
        if seg_start <= EDGE_TOLERANCE_SEC:
            start = seg_end if start is None else max(start, seg_end)
        if seg_end >= duration - EDGE_TOLERANCE_SEC:
            end = seg_start if end is None else min(end, seg_start)
    return Edges(start=start, end=end)


def fetch_sponsorblock(logger: logging.Logger, video_id: str, duration: float) -> Edges:
    """Ask SponsorBlock for the video's music_offtopic segments.

    404 means no segments. Any network error or odd reply skips quietly.
    """
    params = {"videoID": video_id, "categories": json.dumps([SPONSORBLOCK_CATEGORY])}
    try:
        response = http_get(SPONSORBLOCK_URL, params, SPONSORBLOCK_TIMEOUT)
    except Exception as exc:  # network trouble must never fail the song
        logger.warning("trim: SponsorBlock lookup skipped (%s).", exc)
        return Edges()
    status = getattr(response, "status_code", None)
    if status == 404:
        logger.info("trim: SponsorBlock has no segments for %s.", video_id)
        return Edges()
    if status != 200:
        logger.warning("trim: SponsorBlock lookup skipped (HTTP %s).", status)
        return Edges()
    try:
        payload = response.json()
    except ValueError:
        logger.warning("trim: SponsorBlock reply was not JSON; skipped.")
        return Edges()
    edges = parse_sponsorblock(payload, duration)
    logger.info("trim: SponsorBlock suggests start=%s end=%s.", edges.start, edges.end)
    return edges


# --- Silence ---


def silencedetect_command(path: str) -> list[str]:
    """ffmpeg -i file -af silencedetect=noise=-50dB:d=0.5 -f null - (V2-PLAN T10)."""
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        path,
        "-af",
        f"silencedetect=noise={SILENCE_NOISE}:d={SILENCE_MIN_SEC}",
        "-f",
        "null",
        "-",
    ]


def parse_silencedetect(stderr: str, duration: float) -> Edges:
    """Turn silencedetect stderr into start/end suggestions.

    Pairs each silence_start with the silence_end after it. Silence from 0
    suggests a start at its end minus the 0.3 s margin; a silence that runs
    to the end (no silence_end, or one at the end of the file) suggests an
    end at its start plus the margin.
    """
    spans: list[tuple[float, float | None]] = []
    open_start: float | None = None
    for line in stderr.splitlines():
        match = _SILENCE_START.search(line)
        if match:
            open_start = max(0.0, float(match.group(1)))
            continue
        match = _SILENCE_END.search(line)
        if match and open_start is not None:
            spans.append((open_start, float(match.group(1))))
            open_start = None
    if open_start is not None:
        spans.append((open_start, None))

    start: float | None = None
    end: float | None = None
    if spans:
        first_start, first_end = spans[0]
        if first_start <= SILENCE_FROM_ZERO_SEC and first_end is not None:
            if first_end < duration - SILENCE_TO_END_SEC:
                start = max(0.0, first_end - SILENCE_MARGIN_SEC)
        last_start, last_end = spans[-1]
        runs_to_end = last_end is None or last_end >= duration - SILENCE_TO_END_SEC
        if runs_to_end and last_start > SILENCE_FROM_ZERO_SEC:
            end = min(duration, last_start + SILENCE_MARGIN_SEC)
    return Edges(start=start, end=end)


def detect_silence(logger: logging.Logger, path: str, duration: float) -> Edges:
    """Run silencedetect on the file. Without ffmpeg, skip (like faststart)."""
    try:
        result = subprocess.run(
            silencedetect_command(path),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SILENCE_TIMEOUT_SEC,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("trim: silence check skipped (%s).", exc)
        return Edges()
    if result.returncode != 0:
        logger.warning("trim: silence check skipped (ffmpeg exit %s).", result.returncode)
        return Edges()
    edges = parse_silencedetect(result.stderr or "", duration)
    logger.info("trim: silence suggests start=%s end=%s.", edges.start, edges.end)
    return edges


# --- Combine ---


def combine(suggestions: list[Edges], duration: float) -> Edges:
    """Merge suggestions: the larger start, the smaller end, then sanity rules.

    Dropped entirely when the result would keep less than 60% of the song
    or less than 30 seconds. Rounded to 0.1 s; a start that rounds to 0 or
    an end that rounds to the full length means no cut on that side.
    """
    starts = [s.start for s in suggestions if s.start is not None]
    ends = [s.end for s in suggestions if s.end is not None]
    start = max(starts) if starts else None
    end = min(ends) if ends else None
    if start is not None:
        start = round(start, 1)
        if start <= 0:
            start = None
    if end is not None:
        end = round(end, 1)
        if end >= duration:
            end = None
    if start is None and end is None:
        return Edges()
    kept = (end if end is not None else duration) - (start if start is not None else 0.0)
    if kept < MIN_KEEP_SEC or kept < duration * MIN_KEEP_RATIO:
        return Edges()
    return Edges(start=start, end=end)


def trim_source_url(track: Mapping[str, Any]) -> str | None:
    """The URL of the copy that was downloaded: the picked copy, else the source.

    For catalog songs the copy the PC chose is `resolved_url` (V2-PLAN T12);
    for pasted links it is `source_url`.
    """
    return track.get("resolved_url") or track.get("source_url") or None


def suggest_trim(
    logger: logging.Logger,
    track: Mapping[str, Any],
    path: Any,
    duration: float | None,
    *,
    use_sponsorblock: bool = True,
) -> dict[str, float]:
    """The complete-call fields for this file: autoTrimStartSec / autoTrimEndSec.

    Returns {} when there is nothing to suggest or anything went wrong.
    """
    try:
        if duration is None or duration <= 0:
            logger.info("trim: skipped (song length unknown).")
            return {}
        suggestions: list[Edges] = []
        video_id = youtube_video_id(trim_source_url(track))
        if use_sponsorblock and video_id:
            suggestions.append(fetch_sponsorblock(logger, video_id, duration))
        suggestions.append(detect_silence(logger, str(path), duration))
        edges = combine(suggestions, duration)
        fields: dict[str, float] = {}
        if edges.start is not None:
            fields["autoTrimStartSec"] = edges.start
        if edges.end is not None:
            fields["autoTrimEndSec"] = edges.end
        if fields:
            logger.info("trim: suggesting %s.", fields)
        else:
            logger.info("trim: no trim suggested.")
        return fields
    except Exception as exc:  # a trim suggestion must never fail the song
        logger.warning("trim: skipped after an unexpected error (%s).", exc)
        return {}
