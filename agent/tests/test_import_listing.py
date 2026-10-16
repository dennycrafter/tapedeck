"""Playlist listing for imports (V2-PLAN T13, adapter 4), from recorded yt-dlp output only.

The fixtures in tests/fixtures/import_listing/ are real `yt-dlp
--flat-playlist -J` answers (and one SoundCloud details batch), recorded
once on 2026-10-16 with yt-dlp 2026.08.19 and trimmed. yt-dlp never runs here.
"""

import json
from pathlib import Path

import pytest

import downloader
import import_listing
from import_listing import Lister, ListingError

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "import_listing"
E2E_RESULT = Path(__file__).resolve().parents[2] / "web" / "e2e" / "fixtures" / "import-pc-listing" / "soundcloud-profile.json"

FLAT = {
    "https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep": "sc_set_royal_concept_ep.json",
    "https://soundcloud.com/the-concept-band/sets/royal-ep": "sc_set_royal_ep.json",
    "https://soundcloud.com/the-concept-band/sets": "sc_user_sets.json",
    "https://soundcloud.com/the-concept-band/likes": "sc_user_likes.json",
    "https://www.youtube.com/@daftpunk/playlists": "yt_channel_playlists.json",
    "https://www.youtube.com/playlist?list=PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV": "yt_playlist_discovery.json",
    "https://www.youtube.com/playlist?list=FL_kRDKYrUlrbtrSiyu5Tflg": "yt_favorites.json",
}
ERRORS = json.loads((FIXTURES / "errors.json").read_text(encoding="utf-8"))
NETWORK_DOWN = (
    "ERROR: [soundcloud:set] the-concept-band/sets/royal-ep: Unable to download JSON metadata: "
    "<urlopen error [Errno 11001] getaddrinfo failed>"
)


def details_lines() -> dict[str, str]:
    lines = {}
    for line in (FIXTURES / "sc_details.jsonl").read_text(encoding="utf-8").splitlines():
        info = json.loads(line)
        if info:
            lines[info["original_url"]] = line
    return lines


class FixtureRunner:
    """Answers yt-dlp calls from the recordings; anything unknown is yt-dlp's real 404."""

    def __init__(self, overrides=None):
        self.calls = []
        self.overrides = overrides or {}
        self.details = details_lines()

    def __call__(self, args, stdin, timeout):
        self.calls.append({"args": args, "stdin": stdin, "timeout": timeout})
        assert timeout > 0
        if "--batch-file" in args:
            assert args == import_listing.soundcloud_details_args()
            out, err = [], []
            for url in stdin.split():
                if url in self.details:
                    out.append(self.details[url])
                else:
                    out.append("null")
                    err.append(ERRORS["sc_track_404"])
            return (1 if err else 0), "\n".join(out) + "\n", "\n".join(err)
        assert args[:4] == ["--flat-playlist", "-J", "--no-warnings", "--playlist-end"]
        url = args[-1]
        if url in self.overrides:
            return self.overrides[url]
        if url in FLAT:
            return 0, (FIXTURES / FLAT[url]).read_text(encoding="utf-8"), ""
        return 1, "null\n", ERRORS["sc_set_404"]

    def flat_urls(self):
        return [call["args"][-1] for call in self.calls if "--flat-playlist" in call["args"]]


def lister(runner=None, **kwargs):
    return Lister(run=runner or FixtureRunner(), resolve=kwargs.pop("resolve", lambda url: url), **kwargs)


def target(kind, url, link=None):
    return {"kind": kind, "url": url, "link": link or url}


def titles(playlist):
    return [track["title"] for track in playlist["tracks"]]


# --- YouTube ---


class TestYoutube:
    def test_playlist_keeps_order_link_artist_and_length(self):
        result = lister().list_job(
            {"targets": [target("youtube-playlist", "https://www.youtube.com/playlist?list=PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV")]}
        )
        assert result["problems"] == [] and result["truncated"] is False
        [playlist] = result["playlists"]
        assert playlist["ref"] == "PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV"
        assert playlist["name"] == "Daft Punk - Discovery (Full Album)"
        assert playlist["kind"] == "playlist"
        assert titles(playlist) == [
            "Daft Punk - One More Time (Official Audio)",
            "Daft Punk - Aerodynamic (Official Audio)",
            "Daft Punk - Digital Love (Official Audio)",
            "Daft Punk - Harder, Better, Faster, Stronger (Official Audio)",
        ]
        first = playlist["tracks"][0]
        assert first == {
            "ref": "A2VpR8HahKc",
            "title": "Daft Punk - One More Time (Official Audio)",
            "artist": "Daft Punk",
            "durationSec": 321,
            "link": "https://www.youtube.com/watch?v=A2VpR8HahKc",
            "coverUrl": "https://i.ytimg.com/vi/A2VpR8HahKc/hqdefault.jpg",
        }
        assert playlist["coverUrl"] == first["coverUrl"]

    def test_channel_lists_each_playlist_and_the_public_favorites_as_liked(self):
        runner = FixtureRunner()
        result = lister(runner).list_job({"targets": [target("youtube-channel", "https://www.youtube.com/@daftpunk")]})
        assert runner.flat_urls() == [
            "https://www.youtube.com/@daftpunk/playlists",
            "https://www.youtube.com/playlist?list=PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV",
            "https://www.youtube.com/playlist?list=FL_kRDKYrUlrbtrSiyu5Tflg",
        ]
        assert [(p["ref"], p["name"], p["kind"], len(p["tracks"])) for p in result["playlists"]] == [
            ("PLSdoVPM5WnndSQEXRz704yQkKwx76GvPV", "Daft Punk - Discovery (Full Album)", "playlist", 4),
            ("FL_kRDKYrUlrbtrSiyu5Tflg", "Liked videos", "liked", 3),
        ]

    def test_deleted_and_private_videos_are_left_out(self):
        assert import_listing.youtube_track({"id": "A2VpR8HahKc", "title": "[Deleted video]"}) is None
        assert import_listing.youtube_track({"id": "A2VpR8HahKc", "title": "[Private video]", "duration": None}) is None
        assert import_listing.youtube_track({"id": "short", "title": "Song"}) is None

    def test_topic_channels_name_the_artist(self):
        track = import_listing.youtube_track({"id": "A2VpR8HahKc", "title": "One More Time", "channel": "Daft Punk - Topic"})
        assert track["artist"] == "Daft Punk"
        assert track["durationSec"] is None


# --- SoundCloud ---


class TestSoundcloud:
    def test_set_reads_details_for_titles_artists_lengths_and_song_pages(self):
        runner = FixtureRunner()
        result = lister(runner).list_job(
            {"targets": [target("soundcloud-set", "https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep")]}
        )
        [playlist] = result["playlists"]
        assert playlist["ref"] == "2284613"
        assert playlist["name"] == "The Royal Concept EP"
        assert playlist["tracks"] == [
            {
                "ref": "75206121",
                "title": "World On Fire (Re-Mastered)",
                "artist": "The Royal Concept",
                "durationSec": 200,
                "link": "https://soundcloud.com/the-concept-band/world-on-fire-1",
                "coverUrl": "https://i1.sndcdn.com/artworks-acRKqXJcJGVN-0-t500x500.jpg",
            },
            {
                "ref": "47127629",
                "title": "In The End",
                "artist": "The Royal Concept",
                "durationSec": 324,
                "link": "https://soundcloud.com/the-concept-band/in-the-end-mastered",
                "coverUrl": "https://i1.sndcdn.com/artworks-nmfGl00Oy5bQ-0-t500x500.jpg",
            },
            {
                # The flat list only had an API address; the details give the song page.
                "ref": "47127631",
                "title": "Knocked Up",
                "artist": "The Royal Concept",
                "durationSec": 222,
                "link": "https://soundcloud.com/the-concept-band/knocked-up-mastered",
                "coverUrl": "https://i1.sndcdn.com/artworks-000043574646-iq6flj-t500x500.jpg",
            },
        ]
        [details] = [call for call in runner.calls if "--batch-file" in call["args"]]
        assert details["stdin"].split() == [
            "https://soundcloud.com/the-concept-band/world-on-fire-1",
            "https://soundcloud.com/the-concept-band/in-the-end-mastered",
            "https://api-v2.soundcloud.com/tracks/47127631",
        ]

    def test_profile_lists_its_sets_and_its_likes(self):
        runner = FixtureRunner()
        result = lister(runner).list_job({"targets": [target("soundcloud-profile", "https://soundcloud.com/the-concept-band")]})
        assert runner.flat_urls() == [
            "https://soundcloud.com/the-concept-band/sets",
            "https://soundcloud.com/the-concept-band/sets/royal-ep",
            "https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep",
            "https://soundcloud.com/the-concept-band/likes",
        ]
        assert [(p["ref"], p["name"], p["kind"], titles(p)) for p in result["playlists"]] == [
            ("10258832", "Royal EP", "playlist", ["World On Fire (Re-Mastered)", "Shut The World"]),
            ("2284613", "The Royal Concept EP", "playlist", ["World On Fire (Re-Mastered)", "In The End", "Knocked Up"]),
            ("likes:9615865", "Likes", "liked", ["MRTN Feat. Deer - Illusion"]),
        ]
        like = result["playlists"][2]["tracks"][0]
        assert like["artist"] == "MRTN" and like["durationSec"] == 246
        assert result["problems"] == [] and result["truncated"] is False

    def test_the_e2e_fixture_is_what_the_pc_sends_for_this_profile(self):
        """web/e2e/fixtures/import-pc-listing/soundcloud-profile.json is this exact output."""
        result = lister().list_job({"targets": [target("soundcloud-profile", "https://soundcloud.com/the-concept-band")]})
        assert json.loads(E2E_RESULT.read_text(encoding="utf-8")) == result

    def test_a_song_whose_details_failed_keeps_the_flat_title_or_drops_out(self):
        info = json.loads((FIXTURES / "sc_user_likes.json").read_text(encoding="utf-8"))
        playlist = import_listing.soundcloud_playlist(info, {}, liked=True)
        assert titles(playlist) == ["MRTN Feat. Deer - Illusion"]
        assert playlist["tracks"][0]["artist"] == "" and playlist["tracks"][0]["durationSec"] is None
        # A set song with only an API address and no details has no title or page: left out.
        set_info = json.loads((FIXTURES / "sc_set_royal_ep.json").read_text(encoding="utf-8"))
        assert titles(import_listing.soundcloud_playlist(set_info, {}, liked=False)) == []

    def test_liked_sets_in_a_likes_list_are_not_songs(self):
        info = {"id": "1", "entries": [{"_type": "url", "id": "5", "title": "A set", "url": "https://soundcloud.com/x/sets/y"}]}
        assert import_listing.soundcloud_song_urls(info) == []
        assert import_listing.soundcloud_playlist(info, {}, liked=True)["tracks"] == []

    def test_share_link_is_followed_first(self):
        seen = []

        def resolve(url):
            seen.append(url)
            return "https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep"

        result = lister(resolve=resolve).list_job({"targets": [target("soundcloud-short", "https://on.soundcloud.com/AbC123")]})
        assert seen == ["https://on.soundcloud.com/AbC123"]
        assert [p["name"] for p in result["playlists"]] == ["The Royal Concept EP"]

    def test_share_link_to_a_single_song_is_a_problem(self):
        result = lister(resolve=lambda url: "https://soundcloud.com/the-concept-band/world-on-fire-1").list_job(
            {"targets": [target("soundcloud-short", "https://on.soundcloud.com/AbC123")]}
        )
        assert result["playlists"] == []
        assert result["problems"] == [
            "That SoundCloud link doesn't open a profile or playlist: https://on.soundcloud.com/AbC123"
        ]

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("https://soundcloud.com/a", ("soundcloud-profile", "https://soundcloud.com/a")),
            ("https://m.soundcloud.com/a/likes", ("soundcloud-likes", "https://soundcloud.com/a/likes")),
            ("https://soundcloud.com/a/albums", ("soundcloud-sets", "https://soundcloud.com/a/albums")),
            ("https://soundcloud.com/a/sets/b", ("soundcloud-set", "https://soundcloud.com/a/sets/b")),
            ("https://soundcloud.com/a/b", None),
            ("https://example.com/a", None),
        ],
    )
    def test_soundcloud_target(self, url, expected):
        assert import_listing.soundcloud_target(url) == expected


# --- Problems, retries and limits ---


class TestProblemsAndLimits:
    def test_a_link_that_does_not_work_is_a_problem_and_the_rest_still_lists(self):
        result = lister().list_job(
            {
                "targets": [
                    target("soundcloud-set", "https://soundcloud.com/the-concept-band/sets/nope-not-here-xyz"),
                    target("soundcloud-set", "https://soundcloud.com/the-concept-band/sets/royal-ep"),
                ]
            }
        )
        assert [p["name"] for p in result["playlists"]] == ["Royal EP"]
        assert result["problems"] == [
            "Couldn't open https://soundcloud.com/the-concept-band/sets/nope-not-here-xyz. Check that it exists and is public."
        ]

    def test_youtube_bad_request_is_a_problem(self):
        runner = FixtureRunner({"https://www.youtube.com/playlist?list=PLnotreal": (1, "null\n", ERRORS["yt_playlist_400"])})
        result = lister(runner).list_job({"targets": [target("youtube-playlist", "https://www.youtube.com/playlist?list=PLnotreal")]})
        assert result["playlists"] == [] and len(result["problems"]) == 1

    def test_a_network_failure_is_retried_not_reported_as_a_bad_link(self):
        runner = FixtureRunner({"https://soundcloud.com/the-concept-band/sets/royal-ep": (1, "", NETWORK_DOWN)})
        with pytest.raises(ListingError) as caught:
            lister(runner).list_job({"targets": [target("soundcloud-set", "https://soundcloud.com/the-concept-band/sets/royal-ep")]})
        assert caught.value.gone is False
        assert "getaddrinfo failed" in caught.value.message

    def test_one_broken_set_of_a_profile_is_skipped(self):
        runner = FixtureRunner({"https://soundcloud.com/the-concept-band/sets/royal-ep": (1, "null\n", ERRORS["sc_set_404"])})
        result = lister(runner).list_job({"targets": [target("soundcloud-profile", "https://soundcloud.com/the-concept-band")]})
        assert [p["name"] for p in result["playlists"]] == ["The Royal Concept EP", "Likes"]
        assert result["problems"] == []

    def test_song_cap_stops_early_and_says_so(self):
        runner = FixtureRunner()
        result = lister(runner, max_songs=5).list_job(
            {"targets": [target("soundcloud-profile", "https://soundcloud.com/the-concept-band")]}
        )
        assert [len(p["tracks"]) for p in result["playlists"]] == [2, 3]
        assert result["truncated"] is True
        # The cap reaches yt-dlp too: the second set asks for at most 3 songs, and the likes are not read.
        flat = [call["args"] for call in runner.calls if "--flat-playlist" in call["args"]]
        assert [(args[-1].rsplit("/", 1)[-1], args[4]) for args in flat] == [
            ("sets", "200"),
            ("royal-ep", "5"),
            ("the-royal-concept-ep", "3"),
        ]

    def test_time_budget_stops_early(self):
        now = [0.0]

        class SlowRunner(FixtureRunner):
            def __call__(self, args, stdin, timeout):
                now[0] += 200  # each call takes 200 s of the 720 s budget
                return super().__call__(args, stdin, timeout)

        result = lister(SlowRunner(), clock=lambda: now[0]).list_job(
            {"targets": [target("soundcloud-profile", "https://soundcloud.com/the-concept-band")]}
        )
        assert result["truncated"] is True
        assert [p["name"] for p in result["playlists"]] == ["Royal EP"]

    def test_is_gone(self):
        assert import_listing.is_gone(ERRORS["sc_set_404"])
        assert import_listing.is_gone(ERRORS["yt_playlist_400"])
        assert import_listing.is_gone(ERRORS["yt_liked_missing"])
        assert not import_listing.is_gone(NETWORK_DOWN)
        assert not import_listing.is_gone("ERROR: [youtube] Sign in to confirm you're not a bot")


# --- Talking to the app ---


class TestAppCalls:
    JOB = {
        "id": "8d6f8a40-3f0b-4b7e-9d43-6a4d1f0c2b11",
        "service": "soundcloud",
        "targets": [target("soundcloud-set", "https://soundcloud.com/the-concept-band/sets/royal-ep")],
        "maxSongs": 5000,
    }

    def test_claim_sends_the_capability_and_reads_the_jobs(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/import/claim"] = (200, {"jobs": [self.JOB, {"no": "id"}]})
        jobs = import_listing.claim_jobs(quiet_logger, cfg)
        assert [job["id"] for job in jobs] == [self.JOB["id"]]
        [call] = fake_server.calls("/api/agent/import/claim", "POST")
        assert json.loads(call["body"]) == {"capabilities": ["import-listing"]}
        assert call["headers"]["Authorization"] == "Bearer test-token-123"

    def test_an_app_without_import_answers_404_and_nothing_happens(self, fake_server, cfg, quiet_logger):
        assert import_listing.claim_jobs(quiet_logger, cfg) == []

    def test_process_job_sends_the_playlists(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/import/complete"] = (200, {"ok": True})
        assert import_listing.process_job(quiet_logger, cfg, self.JOB, lister()) is True
        body = json.loads(fake_server.calls("/api/agent/import/complete")[0]["body"])
        assert body["jobId"] == self.JOB["id"]
        assert [p["name"] for p in body["playlists"]] == ["Royal EP"]
        assert body["problems"] == [] and body["truncated"] is False

    def test_process_job_reports_a_failure_for_a_retry(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/import/complete"] = (200, {"ok": True})
        runner = FixtureRunner({"https://soundcloud.com/the-concept-band/sets/royal-ep": (1, "", NETWORK_DOWN)})
        assert import_listing.process_job(quiet_logger, cfg, self.JOB, lister(runner)) is True
        body = json.loads(fake_server.calls("/api/agent/import/complete")[0]["body"])
        assert set(body) == {"jobId", "error"}
        assert "getaddrinfo failed" in body["error"]

    def test_run_once_never_raises(self, fake_server, cfg, quiet_logger, monkeypatch):
        fake_server.respond["/api/agent/import/claim"] = (200, {"jobs": [self.JOB]})

        def boom(*args, **kwargs):
            raise RuntimeError("unexpected")

        monkeypatch.setattr(import_listing, "process_job", boom)
        assert import_listing.run_once(quiet_logger, cfg) == 0

    def test_run_once_does_the_claimed_job(self, fake_server, cfg, quiet_logger, monkeypatch):
        fake_server.respond["/api/agent/import/claim"] = (200, {"jobs": [self.JOB]})
        fake_server.respond["/api/agent/import/complete"] = (200, {"ok": True})
        monkeypatch.setattr(import_listing, "run_yt_dlp", FixtureRunner())
        assert import_listing.run_once(quiet_logger, cfg) == 1
        assert len(fake_server.calls("/api/agent/import/complete")) == 1


def test_the_downloader_loop_lists_imports_before_claiming_songs(monkeypatch, cfg, quiet_logger):
    order = []

    class Stop(Exception):
        pass

    monkeypatch.setattr(downloader, "upgrade_yt_dlp", lambda logger: None)
    monkeypatch.setattr(downloader, "fetch_apple_music_export", lambda logger, cfg: False)
    monkeypatch.setattr(import_listing, "run_once", lambda logger, cfg: order.append("import"))
    monkeypatch.setattr(downloader, "poll_for_claims", lambda logger, cfg: order.append("tracks") or [])

    def stop(seconds):
        raise Stop

    monkeypatch.setattr(downloader.time, "sleep", stop)
    with pytest.raises(Stop):
        downloader.run_loop(quiet_logger, cfg)
    assert order == ["import", "tracks"]
