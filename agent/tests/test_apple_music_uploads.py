"""Apple Music copies of uploaded songs (T15 follow-up), against a stand-in app."""

import io
import json
import shutil
import wave

import pytest

import apple_music
import apple_music_uploads
import downloader

from .conftest import TEST_AUDIO

COPY_ID = "00000000-0000-4000-8000-000000000001"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def copy_payload(fake_server, **overrides):
    copy = {
        "id": COPY_ID,
        "title": "Song",
        "artist": "Band",
        "album": "Live",
        "albumArtist": None,
        "format": "mp3",
        # Local storage hands out app-relative links.
        "audioUrl": "/files/song",
        "coverUrl": f"{fake_server.url}/files/cover.jpg",
    }
    copy.update(overrides)
    return {"copies": [copy]}


def wav_bytes(seconds: float = 0.5) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(b"\x00\x10" * int(8000 * seconds))
    return out.getvalue()


@pytest.fixture
def setup(fake_server, tmp_path, monkeypatch):
    """The fake app with one copy waiting, an Apple Music folder and a temp area."""
    folder = tmp_path / "Automatically Add to Music"
    folder.mkdir()
    cfg = downloader.DownloaderConfig(
        app_url=fake_server.url, agent_token="test-token-123", apple_music_folder=str(folder)
    )
    work_root = tmp_path / "work"
    monkeypatch.setattr(apple_music_uploads, "work_dir", lambda copy_id: work_root / copy_id)
    fake_server.respond["/files/cover.jpg"] = (200, JPEG)
    return cfg, folder, work_root


def done_calls(fake_server):
    return [json.loads(call["body"]) for call in fake_server.calls("/api/agent/apple-music-done", "POST")]


class TestRunOnce:
    def test_mp3_is_tagged_and_copied_as_mp3(self, fake_server, setup, quiet_logger):
        cfg, folder, work_root = setup
        fake_server.respond["/api/agent/apple-music-copies"] = (200, copy_payload(fake_server))
        fake_server.respond["/files/song"] = (200, b"\xff\xfb\x90\x00" + b"\x00" * 400)

        assert apple_music_uploads.run_once(quiet_logger, cfg) == 1

        claim = fake_server.calls("/api/agent/apple-music-copies", "POST")[0]
        assert claim["headers"]["Authorization"] == "Bearer test-token-123"
        target = folder / "Band - Song.mp3"
        assert target.exists()
        from mutagen.id3 import ID3

        tags = ID3(str(target))
        assert str(tags["TIT2"]) == "Song"
        assert str(tags["TPE1"]) == "Band"
        assert str(tags["TALB"]) == "Live"
        assert str(tags["TPE2"]) == "Band"  # album artist falls back to the artist
        assert tags.getall("APIC")[0].data == JPEG
        assert tags.version[:2] == (2, 3)
        assert done_calls(fake_server) == [{"trackId": COPY_ID}]
        assert not (work_root / COPY_ID).exists()

    def test_m4a_keeps_its_audio_and_gets_the_app_details(self, fake_server, setup, quiet_logger):
        cfg, folder, _ = setup
        payload = copy_payload(fake_server, format="m4a", album=None, coverUrl=None, title="Edited Title")
        fake_server.respond["/api/agent/apple-music-copies"] = (200, payload)
        fake_server.respond["/files/song"] = (200, TEST_AUDIO.read_bytes())

        assert apple_music_uploads.run_once(quiet_logger, cfg) == 1

        from mutagen.mp4 import MP4

        audio = MP4(str(folder / "Band - Edited Title.m4a"))
        assert audio["\xa9nam"] == ["Edited Title"]
        assert audio["\xa9ART"] == ["Band"]
        assert "\xa9alb" not in audio
        assert "covr" not in audio
        assert done_calls(fake_server) == [{"trackId": COPY_ID}]

    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
    def test_wav_becomes_apple_lossless(self, fake_server, setup, quiet_logger):
        cfg, folder, _ = setup
        fake_server.respond["/api/agent/apple-music-copies"] = (200, copy_payload(fake_server, format="wav"))
        fake_server.respond["/files/song"] = (200, wav_bytes())

        assert apple_music_uploads.run_once(quiet_logger, cfg) == 1

        from mutagen.mp4 import MP4

        audio = MP4(str(folder / "Band - Song.m4a"))
        assert audio.info.codec == "alac"
        assert audio["\xa9nam"] == ["Song"]
        assert audio["covr"][0] == JPEG
        assert list(folder.iterdir()) == [folder / "Band - Song.m4a"]

    def test_a_failed_download_is_not_reported_done(self, fake_server, setup, quiet_logger, caplog):
        cfg, folder, work_root = setup
        fake_server.respond["/api/agent/apple-music-copies"] = (200, copy_payload(fake_server))
        fake_server.respond["/files/song"] = (404, {"error": "gone"})

        assert apple_music_uploads.run_once(quiet_logger, cfg) == 0

        assert "Apple Music copy of Song failed" in caplog.text
        assert "HTTP 404" in caplog.text
        assert list(folder.iterdir()) == []
        assert done_calls(fake_server) == []
        assert not (work_root / COPY_ID).exists()

    def test_no_apple_music_folder_downloads_nothing(self, fake_server, setup, quiet_logger, caplog, monkeypatch):
        cfg, _, _ = setup
        fake_server.respond["/api/agent/apple-music-copies"] = (200, copy_payload(fake_server))
        monkeypatch.setattr(apple_music, "find_apple_music_folder", lambda logger, env_override="": None)

        assert apple_music_uploads.run_once(quiet_logger, cfg) == 0

        assert apple_music.FOLDER_NOT_FOUND_ERROR in caplog.text
        assert fake_server.calls("/files/song") == []
        assert done_calls(fake_server) == []

    def test_an_app_without_uploads_means_nothing_to_do(self, fake_server, setup, quiet_logger, caplog):
        cfg, _, _ = setup
        # The stand-in answers 404 for routes it does not know, like an older app.
        assert apple_music_uploads.run_once(quiet_logger, cfg) == 0
        assert caplog.text == ""

    def test_an_unreachable_app_never_raises(self, quiet_logger, tmp_path):
        cfg = downloader.DownloaderConfig(app_url="http://127.0.0.1:9", agent_token="t", apple_music_folder=str(tmp_path))
        assert apple_music_uploads.run_once(quiet_logger, cfg) == 0


class TestParseCopies:
    def test_keeps_good_copies_and_drops_the_rest(self):
        good = {"id": "a", "title": "T", "artist": "A", "format": "flac", "audioUrl": "/x", "album": "", "coverUrl": None}
        payload = {
            "copies": [
                good,
                {"id": "b", "title": "T", "format": "ogg", "audioUrl": "/x"},  # not a format Tapedeck stores
                {"id": "c", "title": "", "format": "mp3", "audioUrl": "/x"},  # no title
                {"title": "T", "format": "mp3", "audioUrl": "/x"},  # no id
                "junk",
            ]
        }
        assert apple_music_uploads.parse_copies(payload) == [
            {"id": "a", "title": "T", "artist": "A", "album": None, "albumArtist": None, "format": "flac", "audioUrl": "/x", "coverUrl": None}
        ]
        assert apple_music_uploads.parse_copies([]) == []
        assert apple_music_uploads.parse_copies({"copies": None}) == []


def test_export_filename_keeps_an_mp3_ending():
    assert apple_music.export_filename("Band", "Song", "id1", ".mp3") == "Band - Song.mp3"
    assert apple_music.export_filename("", "", "id1", ".mp3") == "id1.mp3"
    assert apple_music.export_filename("Band", "Song", "id1") == "Band - Song.m4a"
