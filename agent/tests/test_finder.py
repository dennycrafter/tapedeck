"""Best-copy finder (V2-PLAN T12), replayed from recorded real searches.

tests/fixtures/finder/*.json hold ytmusicapi and `yt-dlp -J` output for 14
real songs, recorded once on the owner's PC on 2026-10-15 (thumbnails and
unused fields dropped). Nothing here searches for real: the runner and
the YouTube Music search are fakes that replay those files, and an
unrecorded command fails the test.
"""

import json
import logging
import shutil
from pathlib import Path

import pytest

import downloader
import finder

from .conftest import TEST_AUDIO, make_track

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "finder"
ALL_SONGS = sorted(p.stem for p in FIXTURES.glob("*.json"))


def load(slug: str) -> dict:
    return json.loads((FIXTURES / f"{slug}.json").read_text(encoding="utf-8"))


def song_of(fx: dict, **overrides) -> finder.CatalogSong:
    cat = {**fx["catalog"], **overrides}
    return finder.CatalogSong(cat["title"], cat["artist"], cat["duration_sec"], cat.get("isrc"))


class Replay:
    """Fake runner + YouTube Music search that replay one fixture and log every call."""

    def __init__(self, fx: dict, ytmusic_fails: bool = False) -> None:
        self.fx = fx
        self.ytmusic_fails = ytmusic_fails
        self.commands: list[list[str]] = []
        self.ytmusic_queries: list[str] = []

    def runner(self, command: list[str]) -> tuple[int, str, str]:
        self.commands.append(command)
        target = command[-1]
        if target.startswith("scsearch"):
            return 0, json.dumps(self.fx["soundcloud"]), ""
        if target.startswith("ytsearch"):
            return 0, json.dumps(self.fx["youtube"]), ""
        if target in self.fx["details"]:
            return 0, json.dumps(self.fx["details"][target]), ""
        raise AssertionError(f"not recorded, the finder must not ask for it: {command}")

    def ytmusic(self, query: str) -> list[dict]:
        self.ytmusic_queries.append(query)
        if self.ytmusic_fails:
            raise RuntimeError("simulated ytmusicapi error")
        return self.fx["ytmusic"]

    def searches(self) -> list[str]:
        return [c[-1].split(":", 1)[0] for c in self.commands if "--flat-playlist" in c]

    def detail_urls(self) -> list[str]:
        return [c[-1] for c in self.commands if "--flat-playlist" not in c]


@pytest.fixture
def log():
    return logging.getLogger("test.finder")


def find(log, slug: str, ytmusic_fails: bool = False, **catalog):
    fx = load(slug)
    replay = Replay(fx, ytmusic_fails=ytmusic_fails)
    result = finder.find_best_copy(
        log, song_of(fx, **catalog), runner=replay.runner, ytmusic=replay.ytmusic
    )
    return result, replay


def by_title(
    result: finder.FinderResult, text: str, source: str | None = None, uploader: str | None = None
) -> finder.Candidate:
    for candidate in result.ranked:
        if text.lower() not in candidate.title.lower():
            continue
        if (source is None or candidate.source == source) and (uploader is None or candidate.uploader == uploader):
            return candidate
    raise AssertionError(f"no candidate titled like {text!r}")


# --- The recorded songs: what a human checked as the right copy ---

# With YouTube Music working: always the official album audio.
EXPECTED_WITH_YTMUSIC = {
    "arctic-monkeys-i-wanna-be-yours": "https://www.youtube.com/watch?v=nyuo9-OjNNg",
    "avicii-levels": "https://www.youtube.com/watch?v=xAgv1mAyxr8",
    "calvin-harris-this-is-what-you-came-for": "https://www.youtube.com/watch?v=inCm3ByI17o",
    "daft-punk-harder": "https://www.youtube.com/watch?v=JhulBGMA7G4",
    "eagles-hotel-california": "https://www.youtube.com/watch?v=BciS5krYL80",
    "glass-animals-heat-waves": "https://www.youtube.com/watch?v=XDjB9E3YtUE",
    "kendrick-not-like-us": "https://www.youtube.com/watch?v=phLb_SoPBlA",
    "lady-gaga-bloody-mary": "https://www.youtube.com/watch?v=llGFrHB1neU",
    "queen-bohemian-rhapsody": "https://www.youtube.com/watch?v=0TF3hFevWE8",
    "radiohead-creep": "https://www.youtube.com/watch?v=9RfVp-GhKfs",
    "rosalia-despecha": "https://www.youtube.com/watch?v=dN3y8kVNplA",
    "sc-only-ptk-not-like-us": (
        "https://soundcloud.com/part-time-killer/"
        "kendrick-lamar-not-like-us-part-time-killer-extended-remix-free-dl"
    ),
    "tones-and-i-dance-monkey": "https://www.youtube.com/watch?v=Hx4nWW9z0ig",
    "weeknd-blinding-lights": "https://www.youtube.com/watch?v=H64a2ggVIWc",
}

# With ytmusicapi failing: the artist's own SoundCloud or YouTube upload,
# or a faithful re-upload when the artist has none in the results.
EXPECTED_WITHOUT_YTMUSIC = {
    "arctic-monkeys-i-wanna-be-yours": "https://www.youtube.com/watch?v=nyuo9-OjNNg",  # their own channel
    "avicii-levels": "https://www.youtube.com/watch?v=_ovdm2yX4MA",  # Avicii's channel, radio edit length
    "calvin-harris-this-is-what-you-came-for": "https://www.youtube.com/watch?v=K14MkwIsR9U",  # audio re-upload
    "daft-punk-harder": "https://soundcloud.com/daftpunkofficialmusic/harder-better-faster",
    "eagles-hotel-california": "https://www.youtube.com/watch?v=dLl4PZtxia8",  # Official Audio
    "glass-animals-heat-waves": "https://soundcloud.com/glassanimals/heat-waves",
    "kendrick-not-like-us": "https://soundcloud.com/kendrick-lamar-music/not-like-us",
    "lady-gaga-bloody-mary": "https://www.youtube.com/watch?v=df1f4wJpoEQ",  # TRINIX's own upload
    "queen-bohemian-rhapsody": "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",  # Queen Official
    "radiohead-creep": "https://www.youtube.com/watch?v=XFkzRNyygfk",
    "rosalia-despecha": "https://soundcloud.com/rosaliaofficial/despecha",
    "sc-only-ptk-not-like-us": EXPECTED_WITH_YTMUSIC["sc-only-ptk-not-like-us"],
    "tones-and-i-dance-monkey": "https://soundcloud.com/tonesandi-music/dance-monkey",
    "weeknd-blinding-lights": "https://soundcloud.com/theweeknd/blinding-lights",
}


def test_every_fixture_has_an_expectation():
    assert len(ALL_SONGS) >= 10
    assert set(ALL_SONGS) == set(EXPECTED_WITH_YTMUSIC) == set(EXPECTED_WITHOUT_YTMUSIC)


@pytest.mark.parametrize("slug", ALL_SONGS)
def test_picks_the_album_version(log, slug):
    result, _ = find(log, slug)
    assert result.chosen is not None
    assert result.chosen.url == EXPECTED_WITH_YTMUSIC[slug]
    assert result.chosen.score >= finder.MIN_SCORE


@pytest.mark.parametrize("slug", ALL_SONGS)
def test_ytmusic_error_falls_back_to_soundcloud_and_youtube(log, slug, caplog):
    result, replay = find(log, slug, ytmusic_fails=True)
    assert result.chosen is not None
    assert result.chosen.url == EXPECTED_WITHOUT_YTMUSIC[slug]
    assert "YouTube Music search failed, falling back to YouTube" in caplog.text
    assert replay.searches()[0] == "scsearch5"


def test_ytmusicapi_missing_counts_as_an_error(log, caplog):
    def not_installed(query):
        raise ModuleNotFoundError("No module named 'ytmusicapi'")

    fx = load("eagles-hotel-california")
    replay = Replay(fx)
    result = finder.find_best_copy(log, song_of(fx), runner=replay.runner, ytmusic=not_installed)
    assert result.chosen.url == EXPECTED_WITHOUT_YTMUSIC["eagles-hotel-california"]
    assert "falling back" in caplog.text


# --- Order and stopping early ---


def test_stops_after_youtube_music_when_it_scores_very_high(log):
    result, replay = find(log, "daft-punk-harder")
    assert result.chosen.source == finder.SOURCE_YTMUSIC
    assert result.chosen.score >= finder.STOP_EARLY_SCORE
    assert replay.searches() == []  # neither SoundCloud nor YouTube was asked
    assert replay.ytmusic_queries == ["Daft Punk Harder, Better, Faster, Stronger"]


def test_stops_after_soundcloud_when_it_scores_very_high(log):
    result, replay = find(log, "glass-animals-heat-waves", ytmusic_fails=True)
    assert result.chosen.source == finder.SOURCE_SOUNDCLOUD
    assert replay.searches() == ["scsearch5"]


def test_search_order_and_queries(log):
    _, replay = find(log, "eagles-hotel-california", ytmusic_fails=True)
    queries = [c[-1] for c in replay.commands if "--flat-playlist" in c]
    assert queries == [
        "scsearch5:Eagles Hotel California (2013 Remaster)",
        "ytsearch10:Eagles - Hotel California (2013 Remaster)",
    ]


# --- The traps from the plan ---


def test_trap_live_version_longer_than_the_album_version(log):
    """Eagles: the 1977 live video (405 s) against the 391 s album track."""
    result, _ = find(log, "eagles-hotel-california", ytmusic_fails=True)
    live = by_title(result, "Hotel California (Live 1977)")
    assert live.duration_sec == 405
    assert live.rejected == "length"
    assert result.chosen.title == "Eagles - Hotel California (Official Audio)"


def test_trap_sped_up_edits(log):
    """Arctic Monkeys: YouTube Music lists sped up and slowed edits as songs."""
    result, _ = find(log, "arctic-monkeys-i-wanna-be-yours")
    sped = by_title(result, "i wanna be yours (sped up)")
    assert sped.rejected == "length"  # 151 s against 183 s
    assert finder.penalty_words(sped.title, "I Wanna Be Yours") == ["sped up"]
    assert result.chosen.title == "I Wanna Be Yours"
    assert result.chosen.uploader == "Arctic Monkeys"


def test_trap_music_and_lyric_videos_with_an_intro(log):
    """Calvin Harris: the official video runs 240 s (an 18 s intro) against 222 s."""
    result, _ = find(log, "calvin-harris-this-is-what-you-came-for", ytmusic_fails=True)
    video = by_title(result, "This Is What You Came For (Official Video)")
    assert video.rejected == "length"
    lyric = by_title(result, "This Is What You Came For (Lyrics)", uploader="Dan Music")
    assert lyric.rejected == "length"  # 230 s, 8 s over the tolerance
    # A lyric video at the right length still loses to a plain upload.
    same_length = by_title(result, "(Lyrics) ft. Rihanna", uploader="7clouds")
    assert same_length.rejected is None
    assert "lyrics" in finder.penalty_words(same_length.title, "This Is What You Came For")
    assert same_length.score < result.chosen.score


def test_trap_song_only_on_soundcloud(log):
    """A SoundCloud-only fan edit: YouTube Music only has the original (275 s)."""
    result, replay = find(log, "sc-only-ptk-not-like-us")
    assert result.chosen.source == finder.SOURCE_SOUNDCLOUD
    assert result.chosen.uploader == "Part Time Killer"
    original = by_title(result, "Not Like Us", source=finder.SOURCE_YTMUSIC)
    assert original.rejected == "length"
    assert replay.searches() == ["scsearch5"]  # found there, YouTube never asked


def test_soundcloud_go_plus_previews_are_never_picked(log):
    """Label uploads come back as 30 s previews; the length check drops them."""
    result, _ = find(log, "queen-bohemian-rhapsody", ytmusic_fails=True)
    previews = [c for c in result.ranked if c.source == finder.SOURCE_SOUNDCLOUD and c.duration_sec == 30.0]
    assert previews
    assert all(c.rejected == "length" for c in previews)


def test_covers_on_youtube_music_lose_to_the_artist(log):
    result, _ = find(log, "eagles-hotel-california")
    cover = by_title(result, "Hotel California", source=finder.SOURCE_YTMUSIC)
    assert cover.uploader == "Eagles"
    masters = next(c for c in result.ranked if c.uploader == "Masters of Rock")
    assert masters.score < finder.MIN_SCORE  # same title and length, wrong artist


# --- Tie break on bitrate ---


def test_near_tie_reads_the_bitrate_of_the_top_two_only(log):
    """Calvin Harris: YouTube Music lists the song twice (222 s and 223 s)."""
    result, replay = find(log, "calvin-harris-this-is-what-you-came-for")
    assert len(replay.detail_urls()) == 2
    assert set(replay.detail_urls()) == {
        "https://www.youtube.com/watch?v=inCm3ByI17o",
        "https://www.youtube.com/watch?v=zCh4jIWOKrI",
    }
    assert result.chosen.url == "https://www.youtube.com/watch?v=inCm3ByI17o"
    assert result.chosen.abr == pytest.approx(130.307)
    assert result.ranked[1].abr is not None and result.ranked[1].abr < result.chosen.abr


def test_no_tie_reads_no_details(log):
    _, replay = find(log, "eagles-hotel-california")
    assert replay.detail_urls() == []


def test_details_command_failure_keeps_the_ranking(log, caplog):
    fx = load("weeknd-blinding-lights")
    replay = Replay(fx)

    def runner(command):
        if "--flat-playlist" not in command:
            return 1, "", "ERROR: Sign in to confirm you're not a bot"
        return replay.runner(command)

    result = finder.find_best_copy(log, song_of(fx), runner=runner, ytmusic=replay.ytmusic)
    assert result.chosen is not None and result.chosen.source == finder.SOURCE_YTMUSIC
    assert "details for" in caplog.text


def test_bitrate_from_details():
    fx = load("queen-bohemian-rhapsody")
    abr, description = finder.details_from_ytdlp(
        fx["details"]["https://soundcloud.com/rizky-rilos/queen-bohemian-rhapsody"]
    )
    assert abr == 160.0
    assert finder.details_from_ytdlp(None) == (None, "")
    assert finder.details_from_ytdlp({"formats": [{"acodec": "none", "vcodec": "avc1", "tbr": 900}]}) == (None, "")


# --- No match ---


def test_nothing_close_enough_fails_with_the_alternatives(log):
    """The recorded Eagles results against a catalog length nothing matches."""
    result, _ = find(log, "eagles-hotel-california", duration_sec=100)
    assert result.chosen is None
    info = result.match_info()
    assert info["chosen"] is None and info["score"] is None
    assert 1 <= len(info["alternatives"]) <= finder.MAX_ALTERNATIVES
    assert all(alt["score"] == 0.0 for alt in info["alternatives"])  # all the wrong length


def test_resolve_raises_no_match_with_match_info(log):
    fx = load("eagles-hotel-california")
    replay = Replay(fx)
    track = make_track(source="catalog", source_url="", title="Hotel California", artist="Eagles", duration_sec=100)
    with pytest.raises(finder.NoMatchError) as excinfo:
        finder.resolve_catalog_track(log, track, runner=replay.runner, ytmusic=replay.ytmusic)
    assert str(excinfo.value) == "Couldn't find a matching version"
    assert excinfo.value.match_info["alternatives"]


def test_empty_results_fail_cleanly(log):
    empty = {"ytmusic": [], "soundcloud": {"entries": []}, "youtube": {"entries": []}, "details": {}}
    replay = Replay(empty)
    result = finder.find_best_copy(
        log, finder.CatalogSong("Nothing", "Nobody", 200), runner=replay.runner, ytmusic=replay.ytmusic
    )
    assert result.chosen is None
    assert result.match_info() == {"chosen": None, "score": None, "alternatives": []}


def test_search_command_failure_is_survivable(log, caplog):
    def broken(command):
        return 1, "", "ERROR: network unreachable"

    fx = load("daft-punk-harder")
    result = finder.find_best_copy(log, song_of(fx), runner=broken, ytmusic=lambda q: [])
    assert result.chosen is None
    assert "soundcloud search failed" in caplog.text


# --- matchInfo (web/lib/track-v2.ts MatchInfo) ---


@pytest.mark.parametrize("slug", ALL_SONGS)
def test_match_info_shape_and_size(log, slug):
    result, _ = find(log, slug)
    info = result.match_info()
    assert set(info) == {"chosen", "score", "alternatives"}
    keys = {"title", "uploader", "durationSec", "url", "score", "source"}
    assert set(info["chosen"]) == keys
    assert info["chosen"]["url"] == result.chosen.url
    assert len(info["alternatives"]) <= finder.MAX_ALTERNATIVES
    assert all(set(alt) == keys for alt in info["alternatives"])
    assert result.chosen.url not in [alt["url"] for alt in info["alternatives"]]
    assert all(alt["source"] in ("ytmusic", "soundcloud", "youtube") for alt in info["alternatives"])
    # The app stores at most 8 KB (web/app/api/agent/v2-fields.ts).
    assert len(json.dumps(info).encode("utf-8")) < 8 * 1024


def test_alternatives_are_unique_by_url(log):
    result, _ = find(log, "arctic-monkeys-i-wanna-be-yours")
    urls = [c.url for c in result.ranked]
    assert len(urls) == len(set(urls))


# --- Matching rules ---


class TestNormalise:
    """Same results as web/lib/cover-art.ts normalizeForMatch (SPEC 8.5)."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Harder, Better, Faster, Stronger", "harder better faster stronger"),
            ("DESPECHÁ", "despecha"),
            ("Beyoncé", "beyonce"),
            ("This Is What You Came For (feat. Rihanna)", "this is what you came for"),
            ("Song ft. Somebody Else", "song"),
            ("Simon & Garfunkel", "simon and garfunkel"),
            ("The Weeknd", "weeknd"),
            ("Levels [Radio Edit] (Remastered (2011))", "levels"),
            ("  lots   of   space ", "lots of space"),
            ("", ""),
        ],
    )
    def test_cases(self, raw, expected):
        assert finder.normalise(raw) == expected

    def test_jaccard(self):
        assert finder.jaccard({"a", "b"}, {"a", "b"}) == 1.0
        assert finder.jaccard({"a", "b"}, {"b", "c"}) == pytest.approx(1 / 3)
        assert finder.jaccard(set(), {"a"}) == 0.0


class TestLength:
    @pytest.mark.parametrize(
        ("candidate", "catalog", "ok"),
        [
            (155, 150, True),  # 5 s is the floor for short songs
            (155.5, 150, False),
            (206, 200, True),  # 3% of 200 s is 6 s
            (206.5, 200, False),
            (391 + 11.7, 391, True),  # 3% of 391 s is 11.73 s
            (391 + 11.8, 391, False),
            (None, 200, True),  # unknown length cannot be judged
            (200, None, True),
        ],
    )
    def test_tolerance(self, candidate, catalog, ok):
        assert finder.length_ok(candidate, catalog) is ok


class TestPenaltyWords:
    @pytest.mark.parametrize(
        ("candidate", "catalog", "words"),
        [
            ("Song (Live at Wembley)", "Song", ["live"]),
            ("Song (Live)", "Song (Live)", []),  # the catalog asks for it
            ("Alive", "Alive", []),
            ("Song - Sped Up", "Song", ["sped up"]),
            ("song (slowed + reverb)", "Song", ["slowed", "reverb"]),
            ("Song (Nightcore)", "Song", ["nightcore"]),
            ("Song (8D Audio)", "Song", ["8d"]),
            ("Song (Extended Mix)", "Song", ["extended", "mix"]),
            ("Song (Karaoke Version)", "Song", ["karaoke"]),
            ("Song [Instrumental]", "Song", ["instrumental"]),
            ("Song (Cover)", "Song", ["cover"]),
            ("Song (Official Lyric Video)", "Song", ["lyrics"]),
            ("Song (Letra)", "Song", ["lyrics"]),
            ("Song (Remix)", "Song", ["remix"]),
            ("Song (Acoustic)", "Song", ["acoustic"]),
            ("Song (Official Audio)", "Song", []),
            ("Song (Remastered 2011)", "Song", []),
        ],
    )
    def test_cases(self, candidate, catalog, words):
        assert finder.penalty_words(candidate, catalog) == words

    def test_catalog_artist_counts_as_asked_for(self):
        assert finder.penalty_words("Bloody Mary (Trinix Remix)", "Bloody Mary", "Trinix Remix") == []


class TestIsrc:
    def test_found_with_dashes_and_spaces(self):
        assert finder.isrc_in("Provided to YouTube\nISRC: GB-DUW-00-00059", "GBDUW0000059")
        assert finder.isrc_in("isrc gbduw0000059", "GBDUW0000059")

    def test_absent_or_invalid(self):
        assert not finder.isrc_in("nothing here", "GBDUW0000059")
        assert not finder.isrc_in("GBDUW0000059", None)
        assert not finder.isrc_in("", "GBDUW0000059")
        assert not finder.isrc_in("XX", "XX")  # not an ISRC shape

    def test_isrc_bonus_is_added(self):
        song = finder.CatalogSong("Harder, Better, Faster, Stronger", "Daft Punk", 226, "GBDUW0000059")
        base = finder.Candidate(
            source="youtube",
            url="https://www.youtube.com/watch?v=yydNF8tuVmU",
            title="Daft Punk - Harder, Better, Faster, Stronger (Official Audio)",
            uploader="Some Channel",
            duration_sec=225,
            song_title="Harder, Better, Faster, Stronger (Official Audio)",
            song_artist="Daft Punk",
        )
        plain = finder.score_candidate(song, base)
        with_isrc = finder.score_candidate(song, finder.replace(base, description="ISRC: GBDUW0000059"))
        assert with_isrc.score - plain.score == pytest.approx(finder.BONUS_ISRC)


class TestSplitAndOfficial:
    def test_split_on_hyphen_and_dashes(self):
        assert finder.split_artist_title("Queen - Bohemian Rhapsody", "x") == ("Queen", "Bohemian Rhapsody")
        assert finder.split_artist_title("Queen – Bohemian Rhapsody", "x") == ("Queen", "Bohemian Rhapsody")
        assert finder.split_artist_title("Creep", "Radiohead - Topic") == ("Radiohead", "Creep")

    def test_official_channels(self):
        song = finder.CatalogSong("I Wanna Be Yours", "Arctic Monkeys", 183)

        def cand(uploader, official=False, song_artist=""):
            return finder.Candidate("youtube", "u", "t", uploader, 183, "t", song_artist, official=official)

        assert finder.is_official(song, cand("Official Arctic Monkeys"))
        assert finder.is_official(song, cand("ArcticMonkeysVEVO"))
        assert not finder.is_official(song, cand("BBCRadio1VEVO"))
        assert finder.is_official(song, cand("Arctic Monkeys - Topic"))
        assert not finder.is_official(song, cand("LatinHype"))
        assert not finder.is_official(song, cand("Piano Dreamers", official=True, song_artist="Piano Dreamers"))


# --- The downloader hook ---


def test_resolved_url_skips_the_search(log):
    def never(*args, **kwargs):
        raise AssertionError("must not search when a version was picked in the app")

    track = make_track(
        source="catalog", source_url="", resolved_url="https://soundcloud.com/a/b", isrc=None, catalog_id="deezer:1"
    )
    resolved, extra = finder.resolve_catalog_track(log, track, runner=never, ytmusic=never)
    assert resolved["source_url"] == "https://soundcloud.com/a/b"
    assert resolved["source"] == "soundcloud"  # so the DRM fallback still applies
    assert extra == {"resolvedUrl": "https://soundcloud.com/a/b"}  # matchInfo is kept as stored
    assert resolved["resolved_url"] == "https://soundcloud.com/a/b"


def test_resolve_sets_the_download_link(log):
    fx = load("daft-punk-harder")
    replay = Replay(fx)
    track = make_track(source="catalog", source_url="", title=fx["catalog"]["title"], artist="Daft Punk",
                       duration_sec=226, isrc="GBDUW0000059")
    resolved, extra = finder.resolve_catalog_track(log, track, runner=replay.runner, ytmusic=replay.ytmusic)
    assert resolved["source"] == "youtube"
    assert resolved["source_url"] == "https://www.youtube.com/watch?v=JhulBGMA7G4"
    assert extra["resolvedUrl"] == resolved["source_url"]
    assert extra["matchInfo"]["chosen"]["source"] == "ytmusic"
    assert track["source_url"] == ""  # the claimed row itself is not changed


class TestDownloaderIntegration:
    """process_one_track with a catalog row, over real localhost HTTP (conftest FakeAgentServer)."""

    @pytest.fixture
    def replay_daft_punk(self, monkeypatch):
        replay = Replay(load("daft-punk-harder"))
        monkeypatch.setattr(finder, "run_command", replay.runner)
        monkeypatch.setattr(finder, "search_ytmusic", replay.ytmusic)
        return replay

    @pytest.fixture
    def downloads(self, tmp_work, monkeypatch):
        seen = []

        def fake_download(logger, cfg, track):
            seen.append(dict(track))
            work = tmp_work / track["id"]
            work.mkdir(parents=True, exist_ok=True)
            target = work / f"{track['id']}.m4a"
            shutil.copyfile(TEST_AUDIO, target)
            return target

        monkeypatch.setattr(downloader, "download_track", fake_download)
        return seen

    def catalog_row(self, **overrides):
        row = make_track(
            source="catalog",
            source_url="",
            title="Harder, Better, Faster, Stronger",
            artist="Daft Punk",
            duration_sec=180,  # the test tone's length, so the preview check passes
            isrc="GBDUW0000059",
            catalog_id="deezer:3135556",
            resolved_url=None,
        )
        row.update(overrides)
        return downloader.coerce_claimed_track(row)

    def test_claim_sends_the_catalog_capability(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/claim"] = (200, [make_track(source="catalog", source_url="")])
        tracks = downloader.poll_for_claims(quiet_logger, cfg)
        assert [t["id"] for t in tracks] == ["tr1"]  # a catalog row without a link is kept
        body = json.loads(fake_server.calls("/api/agent/claim")[0]["body"])
        assert body == {"capabilities": ["catalog"]}

    def test_catalog_row_downloads_the_winner_and_reports_it(
        self, fake_server, cfg, quiet_logger, replay_daft_punk, downloads, monkeypatch
    ):
        # The tone is 180 s; the catalog length is the real 226 s for the search.
        monkeypatch.setattr(downloader, "is_preview", lambda real, expected: False)
        track = self.catalog_row(duration_sec=226)
        downloader.process_one_track(quiet_logger, cfg, track, export_enabled=False)
        assert downloads[0]["source_url"] == "https://www.youtube.com/watch?v=JhulBGMA7G4"
        assert downloads[0]["source"] == "youtube"
        assert not fake_server.calls("/api/agent/fail")
        complete = json.loads(fake_server.calls("/api/agent/complete")[0]["body"])
        assert complete["resolvedUrl"] == "https://www.youtube.com/watch?v=JhulBGMA7G4"
        assert complete["matchInfo"]["chosen"]["url"] == complete["resolvedUrl"]
        assert complete["trackId"] == "tr1" and complete["key"]

    def test_trim_asks_sponsorblock_about_the_chosen_copy(
        self, fake_server, cfg, quiet_logger, replay_daft_punk, downloads, monkeypatch, no_sponsorblock_network
    ):
        """V2-PLAN T10 reads resolved_url, so the finder sets it before the trim step."""
        monkeypatch.setattr(downloader, "is_preview", lambda real, expected: False)
        downloader.process_one_track(quiet_logger, cfg, self.catalog_row(duration_sec=226), export_enabled=False)
        assert downloads[0]["resolved_url"] == "https://www.youtube.com/watch?v=JhulBGMA7G4"
        asked = [r["params"].get("videoID") for r in no_sponsorblock_network]
        assert asked == ["JhulBGMA7G4"]

    def test_trim_and_finder_fields_both_reach_complete(
        self, fake_server, cfg, quiet_logger, replay_daft_punk, downloads, monkeypatch
    ):
        import trim

        monkeypatch.setattr(downloader, "is_preview", lambda real, expected: False)
        monkeypatch.setattr(
            trim, "suggest_trim", lambda *a, **k: {"autoTrimStartSec": 1.5, "autoTrimEndSec": 170.0}
        )
        downloader.process_one_track(quiet_logger, cfg, self.catalog_row(duration_sec=226), export_enabled=False)
        complete = json.loads(fake_server.calls("/api/agent/complete")[0]["body"])
        assert complete["autoTrimStartSec"] == 1.5 and complete["autoTrimEndSec"] == 170.0
        assert complete["resolvedUrl"] == "https://www.youtube.com/watch?v=JhulBGMA7G4"
        assert complete["matchInfo"]["chosen"]["url"] == complete["resolvedUrl"]

    def test_no_match_fails_with_the_alternatives(
        self, fake_server, cfg, quiet_logger, replay_daft_punk, downloads
    ):
        track = self.catalog_row(duration_sec=30)
        downloader.process_one_track(quiet_logger, cfg, track, export_enabled=False)
        assert downloads == []
        assert not fake_server.calls("/api/agent/complete")
        fail = json.loads(fake_server.calls("/api/agent/fail")[0]["body"])
        assert fail["error"] == "Couldn't find a matching version"
        assert fail["matchInfo"]["chosen"] is None
        assert fail["matchInfo"]["alternatives"]

    def test_a_picked_version_is_downloaded_without_searching(
        self, fake_server, cfg, quiet_logger, downloads, monkeypatch
    ):
        def never(*args):
            raise AssertionError("searched although a version was picked")

        monkeypatch.setattr(finder, "run_command", never)
        monkeypatch.setattr(finder, "search_ytmusic", never)
        track = self.catalog_row(resolved_url="https://www.youtube.com/watch?v=dLl4PZtxia8")
        downloader.process_one_track(quiet_logger, cfg, track, export_enabled=False)
        assert downloads[0]["source_url"] == "https://www.youtube.com/watch?v=dLl4PZtxia8"
        complete = json.loads(fake_server.calls("/api/agent/complete")[0]["body"])
        assert complete["resolvedUrl"] == "https://www.youtube.com/watch?v=dLl4PZtxia8"
        assert "matchInfo" not in complete

    def test_download_failure_still_saves_the_alternatives(
        self, fake_server, cfg, quiet_logger, replay_daft_punk, monkeypatch
    ):
        def broken(logger, cfg, track):
            raise downloader.PipelineError("yt-dlp failed: Video unavailable")

        monkeypatch.setattr(downloader, "download_track", broken)
        downloader.process_one_track(quiet_logger, cfg, self.catalog_row(duration_sec=226), export_enabled=False)
        fail = json.loads(fake_server.calls("/api/agent/fail")[0]["body"])
        assert fail["error"] == "yt-dlp failed: Video unavailable"
        assert fail["matchInfo"]["chosen"]["url"] == "https://www.youtube.com/watch?v=JhulBGMA7G4"

    def test_normal_rows_never_touch_the_finder(self, fake_server, cfg, quiet_logger, downloads, monkeypatch):
        def never(*args, **kwargs):
            raise AssertionError("the finder ran for a YouTube row")

        monkeypatch.setattr(finder, "resolve_catalog_track", never)
        downloader.process_one_track(quiet_logger, cfg, downloader.coerce_claimed_track(make_track()), False)
        complete = json.loads(fake_server.calls("/api/agent/complete")[0]["body"])
        assert "resolvedUrl" not in complete and "matchInfo" not in complete
        fail_calls = fake_server.calls("/api/agent/fail")
        assert fail_calls == []


def test_importing_the_downloader_does_not_load_ytmusicapi():
    """The T0 contract (tests/test_contract.py) also covers the finder module."""
    import subprocess
    import sys

    code = "import sys; import downloader, finder; assert 'ytmusicapi' not in sys.modules"
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parent.parent),
        check=False,
    )
    assert result.returncode == 0, result.stderr
