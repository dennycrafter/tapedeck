"""Apple Music export: folder chain, filename, copy, gating (SPEC 8.11, T6a).

The detection chain is exercised against fake USERPROFILE layouts as
SPEC 9 T6 prescribes: the `Apple Music\\Media\\Automatically Add to
Music` layout, the `iTunes\\iTunes Media\\Automatically Add to iTunes`
layout, and the nothing-found case. HTTP behaviour runs against the
FakeAgentServer, so the real requests client code is exercised.
"""

import shutil
import urllib.parse

import pytest

import apple_music
import downloader

from .conftest import TEST_AUDIO, make_track

# A realistic iTunesPrefs body: UTF-16LE, percent-encoded file URL. The
# real format is undocumented; the parser only needs URL-shaped content.
PREFS_BODY = (
    "HkeyCurrentUser\00".encode("utf-16-le")
    + "iTunesGetAlternateMusicFolder:iTunesGetAlternateMusicFolder:1:"
    "file://localhost/C%3A/Users/Owner/Music/iTunes/iTunes%20Media/\x00".encode("utf-16-le")
)


def make_claim_row(**overrides):
    """The downloader's ClaimedTrack shape (SPEC 8.3), tweakable."""
    row = {"id": "tr1", "title": "Me at the zoo", "artist": "jawed", "apple_music": False}
    row.update(overrides)
    return row


@pytest.fixture
def music_layout(monkeypatch, tmp_path):
    """A fake PC with an Apple Music auto-add folder, wired into the env."""
    userprofile = tmp_path / "home"
    folder = userprofile / "Music" / "Apple Music" / "Media" / "Automatically Add to Music"
    folder.mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(userprofile))
    monkeypatch.setenv("APPDATA", str(userprofile / "AppData" / "Roaming"))
    return folder


class TestExportFilename:
    """SPEC 8.11: `<Artist> - <Title>.m4a` with invalid characters stripped."""

    @pytest.mark.parametrize(
        ("artist", "title", "expected"),
        [
            ("jawed", "Me at the zoo", "jawed - Me at the zoo.m4a"),
            ("AC/DC", "Thunderstruck: live", "ACDC - Thunderstruck live.m4a"),
            ('The Who <greatest>"hits"?', "Song? *remaster", "The Who greatesthits - Song remaster.m4a"),
            ("Artist", "  Trailing.  ", "Artist - Trailing.m4a"),
            ("Artist\x01bad", "Song", "Artistbad - Song.m4a"),
        ],
    )
    def test_strips_invalid_characters(self, artist, title, expected):
        assert apple_music.export_filename(artist, title, "tr1") == expected

    def test_fully_invalid_name_falls_back_to_track_id(self):
        assert apple_music.export_filename("<>", "??", "tr-abc") == "tr-abc.m4a"


class TestParseItunesPrefs:
    def test_utf16_body_yields_media_folder(self):
        parsed = apple_music.parse_itunes_media_folder(PREFS_BODY)
        assert parsed is not None
        assert str(parsed).endswith("iTunes Media")

    def test_utf8_body_is_scanned_too(self):
        body = "file://localhost/C:/Users/Owner/MyMusic/".encode("utf-8")
        parsed = apple_music.parse_itunes_media_folder(body)
        assert parsed is not None
        assert str(parsed).endswith("MyMusic")

    def test_prefers_itunes_media_over_other_urls(self):
        body = (
            "file://localhost/C%3A/Program%20Files/iTunes/\x00"
            "file://localhost/D%3A/Library/iTunes%20Media/\x00"
        ).encode("utf-16-le")
        parsed = apple_music.parse_itunes_media_folder(body)
        assert str(parsed).endswith("Library/iTunes Media")

    @pytest.mark.parametrize("body", [b"", b"\x00\x00\x00", b"no urls here"])
    def test_garbage_yields_none(self, body):
        assert apple_music.parse_itunes_media_folder(body) is None


class TestFindAppleMusicFolder:
    """The SPEC 8.11 chain: override, Apple Music glob, iTunes locations."""

    def test_env_override_wins(self, tmp_path, quiet_logger):
        target = tmp_path / "custom"
        target.mkdir()
        assert (
            apple_music.find_apple_music_folder(quiet_logger, env_override=str(target))
            == target
        )

    def test_missing_override_falls_through(self, tmp_path, quiet_logger, caplog):
        fake = self.make_apple_music_layout(tmp_path)
        found = apple_music.find_apple_music_folder(
            quiet_logger,
            env_override=str(tmp_path / "nope"),
            userprofile=fake,
        )
        assert found == fake / "Music" / "Apple Music" / "Media" / "Automatically Add to Music"
        assert "does not exist" in caplog.text

    @staticmethod
    def make_apple_music_layout(userprofile):
        folder = userprofile / "Music" / "Apple Music" / "Media" / "Automatically Add to Music"
        folder.mkdir(parents=True)
        return userprofile

    @staticmethod
    def make_itunes_layout(userprofile):
        folder = userprofile / "Music" / "iTunes" / "iTunes Media" / "Automatically Add to iTunes"
        folder.mkdir(parents=True)
        return userprofile

    def test_spec_apple_music_layout_is_found(self, tmp_path, quiet_logger):
        """SPEC 9 T6: Music\\Apple Music\\Media\\Automatically Add to Music."""
        fake = self.make_apple_music_layout(tmp_path)
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=fake) == (
            fake / "Music" / "Apple Music" / "Media" / "Automatically Add to Music"
        )

    def test_depth_three_is_found_and_four_is_not(self, tmp_path, quiet_logger):
        fake = tmp_path
        deep = fake / "Music" / "Apple Music" / "a" / "b" / "Automatically Add to Music"
        deep.mkdir(parents=True)
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=fake) == deep
        beyond = fake / "Music" / "Apple Music" / "x" / "y" / "z" / "Automatically Add to Music"
        beyond.mkdir(parents=True)
        # Still the depth-3 hit; depth 4 is outside the chain.
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=fake) == deep

    def test_shallowest_depth_wins(self, tmp_path, quiet_logger):
        fake = tmp_path
        shallow = fake / "Music" / "Apple Music" / "Automatically Add to Music"
        shallow.mkdir(parents=True)
        deep = fake / "Music" / "Apple Music" / "Media" / "Automatically Add to Music"
        deep.mkdir(parents=True)
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=fake) == shallow

    def test_files_are_not_folders(self, tmp_path, quiet_logger):
        fake = tmp_path
        music = fake / "Music" / "Apple Music"
        (music / "Automatically Add to Music").mkdir(parents=True)
        (music / "Media").mkdir()
        (music / "Media" / "Automatically Add to Music.txt").write_text("a file, not a folder")
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=fake) == (
            music / "Automatically Add to Music"
        )

    def test_itunes_media_layout_is_found(self, tmp_path, quiet_logger):
        """SPEC 9 T6: Music\\iTunes\\iTunes Media\\Automatically Add to iTunes."""
        fake = self.make_itunes_layout(tmp_path)
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=fake) == (
            fake / "Music" / "iTunes" / "iTunes Media" / "Automatically Add to iTunes"
        )

    def test_apple_music_layout_wins_over_itunes(self, tmp_path, quiet_logger):
        fake = self.make_apple_music_layout(tmp_path)
        self.make_itunes_layout(fake)
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=fake) == (
            fake / "Music" / "Apple Music" / "Media" / "Automatically Add to Music"
        )

    def test_moved_library_parsed_from_itunesprefs(self, tmp_path, quiet_logger):
        """A relocated library: iTunesPrefs points at the real media folder."""
        fake = tmp_path
        moved = fake / "D" / "MyLibrary" / "iTunes Media" / "Automatically Add to iTunes"
        moved.mkdir(parents=True)
        media_root = moved.parent
        # Encode the layout's real absolute path into the prefs URL so the
        # test is hermetic on every platform (a "D:/" URL is relative on Linux).
        url = "file://localhost" + urllib.parse.quote(str(media_root)) + "/"
        appdata = fake / "AppData" / "Roaming"
        prefs = appdata / "Apple Computer" / "iTunes" / "iTunesPrefs"
        prefs.parent.mkdir(parents=True)
        prefs.write_bytes((url + "\x00").encode("utf-16-le"))
        assert apple_music.find_apple_music_folder(
            quiet_logger, userprofile=fake, appdata=appdata
        ) == moved

    def test_unreadable_prefs_still_finds_the_default(self, tmp_path, quiet_logger, monkeypatch):
        fake = self.make_itunes_layout(tmp_path)
        appdata = fake / "AppData" / "Roaming"
        prefs = appdata / "Apple Computer" / "iTunes" / "iTunesPrefs"
        prefs.parent.mkdir(parents=True)
        prefs.write_bytes(b"")  # parses to nothing

        def raise_locked(*args, **kwargs):
            raise OSError("prefs locked by iTunes")

        monkeypatch.setattr(apple_music, "parse_itunes_media_folder", raise_locked)
        assert apple_music.find_apple_music_folder(
            quiet_logger, userprofile=fake, appdata=appdata
        ) == fake / "Music" / "iTunes" / "iTunes Media" / "Automatically Add to iTunes"

    def test_nothing_found(self, tmp_path, quiet_logger):
        assert apple_music.find_apple_music_folder(quiet_logger, userprofile=tmp_path) is None


class TestCopyIntoFolder:
    def test_copies_as_artist_title_m4a(self, tmp_path, quiet_logger):
        source = tmp_path / "tr1.m4a"
        source.write_bytes(b"audio")
        folder = tmp_path / "Automatically Add to Music"
        folder.mkdir()
        target = apple_music.copy_into_folder(quiet_logger, folder, make_claim_row(), source)
        assert target == folder / "jawed - Me at the zoo.m4a"
        assert target.read_bytes() == b"audio"
        assert source.exists()  # a copy, never a move

    def test_reprocessing_overwrites_dedup(self, tmp_path, quiet_logger):
        source = tmp_path / "tr1.m4a"
        source.write_bytes(b"audio")
        folder = tmp_path / "Automatically Add to Music"
        folder.mkdir()
        apple_music.copy_into_folder(quiet_logger, folder, make_claim_row(), source)
        apple_music.copy_into_folder(quiet_logger, folder, make_claim_row(), source)
        assert len(list(folder.iterdir())) == 1


class TestMaybeExportToAppleMusic:
    """The gated step: setting or flag on, copy + done; failures stay ready."""

    def test_setting_on_copies_and_calls_done(self, fake_server, cfg, quiet_logger, music_layout):
        source = TEST_AUDIO
        downloader.maybe_export_to_apple_music(
            quiet_logger, cfg, make_claim_row(), source, setting_on=True
        )
        assert (music_layout / "jawed - Me at the zoo.m4a").exists()
        done = fake_server.calls("/api/agent/apple-music-done", method="POST")
        assert len(done) == 1
        assert done[0]["headers"]["Authorization"] == "Bearer test-token-123"

    def test_per_song_flag_without_setting(self, fake_server, cfg, quiet_logger, music_layout):
        source = TEST_AUDIO
        downloader.maybe_export_to_apple_music(
            quiet_logger, cfg, make_claim_row(apple_music=True), source, setting_on=False
        )
        assert (music_layout / "jawed - Me at the zoo.m4a").exists()

    def test_setting_off_and_flag_off_copies_nothing(
        self, fake_server, cfg, quiet_logger, music_layout
    ):
        downloader.maybe_export_to_apple_music(
            quiet_logger, cfg, make_claim_row(), TEST_AUDIO, setting_on=False
        )
        assert list(music_layout.iterdir()) == []  # nothing was copied
        assert fake_server.calls("/api/agent/apple-music-done") == []

    def test_no_folder_logs_spec_error_and_song_stays_ready(
        self, fake_server, cfg, quiet_logger, monkeypatch, caplog, tmp_path
    ):
        """SPEC 9 T6: no folder -> the song stays ready, error text from 8.11."""
        empty_home = tmp_path / "home"
        empty_home.mkdir()
        monkeypatch.setenv("USERPROFILE", str(empty_home))
        monkeypatch.setenv("APPDATA", str(empty_home / "AppData" / "Roaming"))
        downloader.maybe_export_to_apple_music(
            quiet_logger, cfg, make_claim_row(), TEST_AUDIO, setting_on=True
        )
        assert apple_music.FOLDER_NOT_FOUND_ERROR in caplog.text
        assert fake_server.calls("/api/agent/apple-music-done") == []
        assert fake_server.calls("/api/agent/fail") == []

    def test_failed_copy_stays_ready_and_skips_done(
        self, fake_server, cfg, quiet_logger, monkeypatch, caplog, music_layout
    ):
        monkeypatch.setattr(
            apple_music.shutil, "copy2", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full"))
        )
        downloader.maybe_export_to_apple_music(
            quiet_logger, cfg, make_claim_row(), TEST_AUDIO, setting_on=True
        )
        assert "Apple Music export failed" in caplog.text
        assert fake_server.calls("/api/agent/apple-music-done") == []
        assert fake_server.calls("/api/agent/fail") == []

    def test_done_endpoint_error_is_only_logged(
        self, fake_server, cfg, quiet_logger, music_layout, caplog
    ):
        fake_server.respond["/api/agent/apple-music-done"] = (500, {"error": "boom"})
        downloader.maybe_export_to_apple_music(
            quiet_logger, cfg, make_claim_row(), TEST_AUDIO, setting_on=True
        )
        assert (music_layout / "jawed - Me at the zoo.m4a").exists()  # the copy succeeded
        assert "apple-music-done returned HTTP 500" in caplog.text


class TestFetchAppleMusicExport:
    """GET /api/agent/settings, once per loop; failures mean off (SPEC 8.3)."""

    def test_reads_the_toggle(self, fake_server, cfg, quiet_logger):
        fake_server.respond["/api/agent/settings"] = (200, {"apple_music_export": True})
        assert downloader.fetch_apple_music_export(quiet_logger, cfg) is True
        fake_server.respond["/api/agent/settings"] = (200, {"apple_music_export": False})
        assert downloader.fetch_apple_music_export(quiet_logger, cfg) is False

    def test_http_error_means_off(self, fake_server, cfg, quiet_logger, caplog):
        fake_server.respond["/api/agent/settings"] = (500, {"error": "boom"})
        assert downloader.fetch_apple_music_export(quiet_logger, cfg) is False
        assert "HTTP 500" in caplog.text

    def test_unreachable_app_means_off(self, quiet_logger):
        from downloader import DownloaderConfig

        cfg = DownloaderConfig(app_url="http://127.0.0.1:1", agent_token="x")
        assert downloader.fetch_apple_music_export(quiet_logger, cfg) is False


class TestProcessOneTrackIntegration:
    """SPEC 9 T6: the exported copy rides the real pipeline; failures stay ready."""

    @pytest.fixture
    def pipeline_track(self, tmp_work, monkeypatch):
        """download_track hands over the committed tone; everything else runs."""
        work = tmp_work / "tr1"
        work.mkdir(parents=True)
        stand_in = work / "tr1.m4a"
        shutil.copyfile(TEST_AUDIO, stand_in)
        monkeypatch.setattr(downloader, "download_track", lambda *a, **k: stand_in)
        return stand_in

    def test_export_rides_a_successful_pipeline(
        self, fake_server, cfg, quiet_logger, music_layout, pipeline_track
    ):
        downloader.process_one_track(quiet_logger, cfg, make_track(), export_enabled=True)
        assert fake_server.calls("/api/agent/complete")
        assert not fake_server.calls("/api/agent/fail")
        assert fake_server.calls("/api/agent/apple-music-done", method="POST")

    def test_no_folder_keeps_the_song_ready(
        self, fake_server, cfg, quiet_logger, monkeypatch, caplog, pipeline_track, tmp_path
    ):
        empty_home = tmp_path / "home"
        empty_home.mkdir()
        monkeypatch.setenv("USERPROFILE", str(empty_home))
        monkeypatch.setenv("APPDATA", str(empty_home / "AppData" / "Roaming"))
        downloader.process_one_track(quiet_logger, cfg, make_track(), export_enabled=True)
        assert fake_server.calls("/api/agent/complete")  # the song is ready
        assert not fake_server.calls("/api/agent/fail")  # and stays ready
        assert apple_music.FOLDER_NOT_FOUND_ERROR in caplog.text

    def test_settings_are_not_refetched_per_track(self, fake_server, cfg, quiet_logger, pipeline_track):
        downloader.process_one_track(quiet_logger, cfg, make_track(), export_enabled=False)
        assert fake_server.calls("/api/agent/settings") == []  # fetched once per loop, not here
