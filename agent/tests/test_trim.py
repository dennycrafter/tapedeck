"""Automatic trim suggestions (V2-PLAN T10, agent/trim.py).

Fixtures only, no network: tests/fixtures/trim holds SponsorBlock replies
recorded once from sponsor.ajay.app and ffmpeg 9 silencedetect stderr
recorded from generated test files (tone with silence before and after,
tone with leading silence, and the committed test1.m4a with none). The
conftest `no_sponsorblock_network` fixture answers every SponsorBlock call
with a 404 unless a test installs its own reply.
"""

import json
import logging
import shutil
import subprocess
from pathlib import Path

import pytest

import downloader
import trim

from .conftest import TEST_AUDIO, make_track

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "trim"

# Recorded 15 Oct 2026: Lady Gaga "Bad Romance" (qrO4YZeyl0I, 308.381 s),
# an intro at the start and credits at the end.
SB_START_AND_END = json.loads((FIXTURES / "sponsorblock-start-and-end.json").read_text())
# Michael Jackson "Thriller" (sOnqjkJTMaA, 821.901 s): a long intro plus
# two segments in the middle.
SB_INTRO_AND_MIDDLE = json.loads((FIXTURES / "sponsorblock-intro-and-middle.json").read_text())
# A video with no segments: HTTP 404 with this body.
SB_404_BODY = (FIXTURES / "sponsorblock-404-body.txt").read_text()

# 2.4 s silence, 40 s tone, 1.5 s silence, 20 s tone, 3.1 s silence (67.0 s).
SILENCE_BOTH = (FIXTURES / "silencedetect-both-ends.txt").read_text()
# 1.8 s silence, then 95 s of tone (96.8 s).
SILENCE_LEADING = (FIXTURES / "silencedetect-leading-only.txt").read_text()
# web/public/test-audio/test1.m4a (180 s tone): no silence at all.
SILENCE_NONE = (FIXTURES / "silencedetect-none.txt").read_text()


class FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("not JSON")
        return self._payload


@pytest.fixture
def sponsorblock(monkeypatch):
    """Install a canned SponsorBlock reply; returns the recorded calls."""
    calls = []

    def install(response=None, error=None):
        def fake_get(url, params, timeout):
            calls.append({"url": url, "params": dict(params), "timeout": timeout})
            if error is not None:
                raise error
            return response

        monkeypatch.setattr(trim, "http_get", fake_get)
        return calls

    return install


def fake_ffmpeg(monkeypatch, stderr, returncode=0):
    """Make subprocess.run return a recorded silencedetect run."""
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, returncode, stdout="", stderr=stderr)

    monkeypatch.setattr(trim.subprocess, "run", fake_run)
    return calls


class TestYoutubeVideoId:
    @pytest.mark.parametrize(
        "url",
        [
            "https://www.youtube.com/watch?v=qrO4YZeyl0I",
            "https://youtube.com/watch?v=qrO4YZeyl0I&list=RD123&t=4",
            "https://m.youtube.com/watch?v=qrO4YZeyl0I",
            "https://music.youtube.com/watch?v=qrO4YZeyl0I&si=abc",
            "https://youtu.be/qrO4YZeyl0I?t=10",
            "https://www.youtube.com/shorts/qrO4YZeyl0I",
            "https://www.youtube.com/embed/qrO4YZeyl0I",
        ],
    )
    def test_reads_the_id(self, url):
        assert trim.youtube_video_id(url) == "qrO4YZeyl0I"

    @pytest.mark.parametrize(
        "url",
        [
            None,
            "",
            "https://soundcloud.com/artist/song",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/playlist?list=PL123",
            "not a url",
        ],
    )
    def test_other_links_have_none(self, url):
        assert trim.youtube_video_id(url) is None


class TestParseSponsorblock:
    def test_start_and_end_segments(self):
        edges = trim.parse_sponsorblock(SB_START_AND_END, 308.381)
        assert edges == trim.Edges(start=13.223, end=296.69)

    def test_middle_segments_are_ignored(self):
        edges = trim.parse_sponsorblock(SB_INTRO_AND_MIDDLE, 821.901)
        assert edges == trim.Edges(start=253.179, end=None)

    def test_edges_allow_one_second(self):
        payload = [
            {"category": "music_offtopic", "actionType": "skip", "segment": [0.9, 10.0]},
            {"category": "music_offtopic", "actionType": "skip", "segment": [190.0, 199.1]},
        ]
        assert trim.parse_sponsorblock(payload, 200.0) == trim.Edges(start=10.0, end=190.0)

    def test_segments_just_past_the_tolerance_do_not_count(self):
        payload = [
            {"category": "music_offtopic", "actionType": "skip", "segment": [1.2, 10.0]},
            {"category": "music_offtopic", "actionType": "skip", "segment": [190.0, 198.8]},
        ]
        assert trim.parse_sponsorblock(payload, 200.0) == trim.Edges()

    def test_other_categories_and_actions_are_ignored(self):
        payload = [
            {"category": "sponsor", "actionType": "skip", "segment": [0, 10.0]},
            {"category": "music_offtopic", "actionType": "mute", "segment": [0, 12.0]},
            {"category": "music_offtopic", "segment": "garbage"},
            "garbage",
        ]
        assert trim.parse_sponsorblock(payload, 200.0) == trim.Edges()

    def test_not_a_list(self):
        assert trim.parse_sponsorblock({"error": "x"}, 200.0) == trim.Edges()


class TestFetchSponsorblock:
    def test_asks_for_music_offtopic_only(self, sponsorblock, quiet_logger):
        calls = sponsorblock(FakeResponse(200, SB_START_AND_END))
        edges = trim.fetch_sponsorblock(quiet_logger, "qrO4YZeyl0I", 308.381)
        assert edges == trim.Edges(start=13.223, end=296.69)
        assert calls == [
            {
                "url": "https://sponsor.ajay.app/api/skipSegments",
                "params": {"videoID": "qrO4YZeyl0I", "categories": '["music_offtopic"]'},
                "timeout": trim.SPONSORBLOCK_TIMEOUT,
            }
        ]

    def test_404_means_no_segments(self, sponsorblock, quiet_logger):
        sponsorblock(FakeResponse(404, None, SB_404_BODY))
        assert trim.fetch_sponsorblock(quiet_logger, "dQw4w9WgXcQ", 212.0) == trim.Edges()

    def test_network_error_skips_quietly(self, sponsorblock, quiet_logger, caplog):
        sponsorblock(error=OSError("no route to host"))
        with caplog.at_level(logging.WARNING):
            assert trim.fetch_sponsorblock(quiet_logger, "qrO4YZeyl0I", 308.0) == trim.Edges()
        assert "SponsorBlock lookup skipped" in caplog.text

    def test_server_error_skips_quietly(self, sponsorblock, quiet_logger):
        sponsorblock(FakeResponse(500, None, "oops"))
        assert trim.fetch_sponsorblock(quiet_logger, "qrO4YZeyl0I", 308.0) == trim.Edges()

    def test_non_json_reply_skips_quietly(self, sponsorblock, quiet_logger):
        sponsorblock(FakeResponse(200, None, "<html>"))
        assert trim.fetch_sponsorblock(quiet_logger, "qrO4YZeyl0I", 308.0) == trim.Edges()


class TestParseSilencedetect:
    def test_command_matches_the_plan(self):
        assert trim.silencedetect_command("song.m4a") == [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            "song.m4a",
            "-af",
            "silencedetect=noise=-50dB:d=0.5",
            "-f",
            "null",
            "-",
        ]

    def test_silence_at_both_ends_keeps_the_margin(self):
        edges = trim.parse_silencedetect(SILENCE_BOTH, 67.0)
        assert edges.start == pytest.approx(2.400023 - 0.3)
        assert edges.end == pytest.approx(63.9 + 0.3)

    def test_leading_silence_only(self):
        edges = trim.parse_silencedetect(SILENCE_LEADING, 96.8)
        assert edges.start == pytest.approx(1.800045 - 0.3)
        assert edges.end is None

    def test_no_silence(self):
        assert trim.parse_silencedetect(SILENCE_NONE, 180.0) == trim.Edges()

    def test_crlf_output_parses_the_same(self):
        edges = trim.parse_silencedetect(SILENCE_BOTH.replace("\n", "\r\n"), 67.0)
        assert edges.end == pytest.approx(64.2)

    def test_older_ffmpeg_without_a_final_silence_end(self):
        # Older ffmpeg builds print no silence_end when the file ends in
        # silence. Same recording with that last line removed.
        lines = SILENCE_BOTH.splitlines()
        last_end = max(i for i, line in enumerate(lines) if "silence_end" in line)
        older = "\n".join(lines[:last_end] + lines[last_end + 1 :])
        edges = trim.parse_silencedetect(older, 67.0)
        assert edges.start == pytest.approx(2.100023)
        assert edges.end == pytest.approx(64.2)

    def test_a_silent_file_suggests_nothing(self):
        stderr = (
            "[Parsed_silencedetect_0 @ 0] silence_start: 0\n"
            "[Parsed_silencedetect_0 @ 0] silence_end: 60 | silence_duration: 60\n"
        )
        assert trim.parse_silencedetect(stderr, 60.0) == trim.Edges()

    def test_middle_silence_is_not_a_trim(self):
        stderr = (
            "[Parsed_silencedetect_0 @ 0] silence_start: 30.2\n"
            "[Parsed_silencedetect_0 @ 0] silence_end: 31.9 | silence_duration: 1.7\n"
        )
        assert trim.parse_silencedetect(stderr, 180.0) == trim.Edges()


class TestDetectSilence:
    def test_runs_ffmpeg_and_parses(self, monkeypatch, quiet_logger):
        calls = fake_ffmpeg(monkeypatch, SILENCE_LEADING)
        edges = trim.detect_silence(quiet_logger, "song.m4a", 96.8)
        assert calls == [trim.silencedetect_command("song.m4a")]
        assert edges.start == pytest.approx(1.500045)

    def test_without_ffmpeg_skips(self, monkeypatch, quiet_logger, caplog):
        def missing(*args, **kwargs):
            raise FileNotFoundError("ffmpeg")

        monkeypatch.setattr(trim.subprocess, "run", missing)
        with caplog.at_level(logging.WARNING):
            assert trim.detect_silence(quiet_logger, "song.m4a", 96.8) == trim.Edges()
        assert "silence check skipped" in caplog.text

    def test_ffmpeg_failure_skips(self, monkeypatch, quiet_logger):
        fake_ffmpeg(monkeypatch, "garbage", returncode=1)
        assert trim.detect_silence(quiet_logger, "song.m4a", 96.8) == trim.Edges()

    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
    def test_real_ffmpeg_on_the_test_tone(self, quiet_logger):
        assert trim.detect_silence(quiet_logger, str(TEST_AUDIO), 180.0) == trim.Edges()


class TestCombine:
    def test_larger_start_and_smaller_end_win(self):
        edges = trim.combine(
            [trim.Edges(start=13.223, end=296.69), trim.Edges(start=2.1, end=300.0)], 308.4
        )
        assert edges == trim.Edges(start=13.2, end=296.7)

    def test_rounds_to_a_tenth(self):
        assert trim.combine([trim.Edges(start=2.149, end=64.25)], 67.0) == trim.Edges(start=2.1, end=64.2)

    def test_tiny_or_full_length_cuts_mean_no_cut(self):
        assert trim.combine([trim.Edges(start=0.04, end=180.0)], 180.0) == trim.Edges()

    def test_drops_everything_under_60_percent(self):
        assert trim.combine([trim.Edges(start=41.0)], 100.0) == trim.Edges()
        assert trim.combine([trim.Edges(start=40.0)], 100.0) == trim.Edges(start=40.0)

    def test_drops_everything_under_30_seconds(self):
        assert trim.combine([trim.Edges(start=11.0)], 40.0) == trim.Edges()
        assert trim.combine([trim.Edges(start=10.0)], 40.0) == trim.Edges(start=10.0)

    def test_nothing_in_nothing_out(self):
        assert trim.combine([trim.Edges(), trim.Edges()], 200.0) == trim.Edges()


class TestSuggestTrim:
    def test_youtube_uses_sponsorblock_and_silence(self, sponsorblock, monkeypatch, quiet_logger):
        calls = sponsorblock(FakeResponse(200, SB_START_AND_END))
        fake_ffmpeg(monkeypatch, SILENCE_NONE)
        track = make_track(source_url="https://www.youtube.com/watch?v=qrO4YZeyl0I")
        fields = trim.suggest_trim(quiet_logger, track, "song.m4a", 308.381)
        assert fields == {"autoTrimStartSec": 13.2, "autoTrimEndSec": 296.7}
        assert len(calls) == 1

    def test_catalog_song_uses_the_picked_copy(self, sponsorblock, monkeypatch, quiet_logger):
        calls = sponsorblock(FakeResponse(200, SB_START_AND_END))
        fake_ffmpeg(monkeypatch, SILENCE_NONE)
        track = make_track(
            source="catalog",
            source_url="",
            resolved_url="https://music.youtube.com/watch?v=qrO4YZeyl0I",
        )
        assert trim.suggest_trim(quiet_logger, track, "song.m4a", 308.381) == {
            "autoTrimStartSec": 13.2,
            "autoTrimEndSec": 296.7,
        }
        assert calls[0]["params"]["videoID"] == "qrO4YZeyl0I"

    def test_soundcloud_uses_silence_only(self, no_sponsorblock_network, monkeypatch, quiet_logger):
        fake_ffmpeg(monkeypatch, SILENCE_BOTH)
        track = make_track(source="soundcloud", source_url="https://soundcloud.com/a/b")
        assert trim.suggest_trim(quiet_logger, track, "song.m4a", 67.0) == {
            "autoTrimStartSec": 2.1,
            "autoTrimEndSec": 64.2,
        }
        assert no_sponsorblock_network == []

    def test_selftest_mode_never_calls_sponsorblock(self, no_sponsorblock_network, monkeypatch, quiet_logger):
        fake_ffmpeg(monkeypatch, SILENCE_LEADING)
        fields = trim.suggest_trim(quiet_logger, make_track(), "song.m4a", 96.8, use_sponsorblock=False)
        assert fields == {"autoTrimStartSec": 1.5}
        assert no_sponsorblock_network == []

    def test_unknown_length_suggests_nothing(self, monkeypatch, quiet_logger):
        calls = fake_ffmpeg(monkeypatch, SILENCE_BOTH)
        assert trim.suggest_trim(quiet_logger, make_track(), "song.m4a", None) == {}
        assert calls == []

    def test_never_raises(self, sponsorblock, monkeypatch, quiet_logger):
        sponsorblock(error=RuntimeError("boom"))

        def broken(*args, **kwargs):
            raise RuntimeError("worse")

        monkeypatch.setattr(trim, "detect_silence", broken)
        assert trim.suggest_trim(quiet_logger, make_track(), "song.m4a", 200.0) == {}


class TestPipeline:
    """The trim suggestion rides the real pipeline into the complete call."""

    @pytest.fixture
    def pipeline_track(self, tmp_work, monkeypatch):
        work = tmp_work / "tr1"
        work.mkdir(parents=True)
        stand_in = work / "tr1.m4a"
        shutil.copyfile(TEST_AUDIO, stand_in)
        monkeypatch.setattr(downloader, "download_track", lambda *a, **k: stand_in)
        return stand_in

    def test_complete_carries_the_suggestion(
        self, fake_server, cfg, quiet_logger, sponsorblock, monkeypatch, pipeline_track
    ):
        sponsorblock(FakeResponse(200, SB_START_AND_END))
        fake_ffmpeg(monkeypatch, SILENCE_NONE)
        track = make_track(source_url="https://www.youtube.com/watch?v=qrO4YZeyl0I")
        downloader.process_one_track(quiet_logger, cfg, track, export_enabled=False)
        complete = json.loads(fake_server.calls("/api/agent/complete", "POST")[0]["body"])
        # The tone is 180 s, so only Bad Romance's intro segment lands on an edge.
        assert complete["autoTrimStartSec"] == 13.2
        assert "autoTrimEndSec" not in complete
        assert complete["durationSec"] == 180
        assert not fake_server.calls("/api/agent/fail")

    def test_no_suggestion_sends_no_fields(
        self, fake_server, cfg, quiet_logger, no_sponsorblock_network, pipeline_track
    ):
        downloader.process_one_track(quiet_logger, cfg, make_track(), export_enabled=False)
        complete = json.loads(fake_server.calls("/api/agent/complete", "POST")[0]["body"])
        assert "autoTrimStartSec" not in complete
        assert "autoTrimEndSec" not in complete

    def test_selftest_skips_sponsorblock(self, fake_server, cfg, quiet_logger, tmp_work, no_sponsorblock_network):
        fake_server.respond["/api/agent/claim"] = (200, [make_track()])
        assert downloader.run_selftest(quiet_logger, cfg, "tr1") == 0
        assert no_sponsorblock_network == []
        complete = json.loads(fake_server.calls("/api/agent/complete", "POST")[0]["body"])
        assert "autoTrimStartSec" not in complete
