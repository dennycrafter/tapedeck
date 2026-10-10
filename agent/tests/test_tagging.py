"""Mutagen MP4 tagging (SPEC 8.3 step 2) against the committed test tone.

The @T1 e2e check "reading the stored file with mutagen shows the track's
title and artist tags" depends on exactly these tags being written.
"""

import shutil

import pytest
from mutagen.mp4 import MP4, MP4Cover

import downloader

from .conftest import TEST_AUDIO, FakeAgentServer, make_track

JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"fake-jpeg-body" * 8
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"fake-png-body" * 8


@pytest.fixture
def audio_file(tmp_path):
    """A fresh copy of the committed tone, as the pipeline works on it."""
    target = tmp_path / "tr1.m4a"
    shutil.copyfile(TEST_AUDIO, target)
    return target


def read_tags(path):
    audio = MP4(str(path))
    return {key: audio.get(key) for key in ("\xa9nam", "\xa9ART", "\xa9alb", "aART", "covr")}


class TestTagTrack:
    def test_writes_title_artist_album(self, audio_file, quiet_logger):
        track = make_track(album="Lord of the Rings: The Two Towers")
        downloader.tag_track(quiet_logger, track, audio_file)
        tags = read_tags(audio_file)
        assert tags["\xa9nam"] == ["Me at the zoo"]
        assert tags["\xa9ART"] == ["jawed"]
        assert tags["\xa9alb"] == ["Lord of the Rings: The Two Towers"]

    def test_album_set_also_writes_album_artist(self, audio_file, quiet_logger):
        """The claim row has no album_artist, so the artist fills aART."""
        downloader.tag_track(quiet_logger, make_track(album="An Album"), audio_file)
        tags = read_tags(audio_file)
        assert tags["aART"] == ["jawed"]

    def test_no_album_omits_album_tags(self, audio_file, quiet_logger):
        downloader.tag_track(quiet_logger, make_track(album=None), audio_file)
        tags = read_tags(audio_file)
        assert tags["\xa9alb"] is None
        assert tags["aART"] is None

    def test_no_cover_url_omits_covr(self, audio_file, quiet_logger):
        downloader.tag_track(quiet_logger, make_track(cover_url=None), audio_file)
        assert read_tags(audio_file)["covr"] is None

    def test_jpeg_cover_is_embedded(self, audio_file, quiet_logger):
        server = FakeAgentServer()
        try:
            server.respond["/cover.jpg"] = (200, JPEG_BYTES)
            track = make_track(cover_url=f"{server.url}/cover.jpg")
            downloader.tag_track(quiet_logger, track, audio_file)
            tags = read_tags(audio_file)
            assert tags["covr"] is not None
            cover = tags["covr"][0]
            assert bytes(cover) == JPEG_BYTES
            assert cover.imageformat == MP4Cover.FORMAT_JPEG
        finally:
            server.close()

    def test_png_cover_is_embedded_as_png(self, audio_file, quiet_logger):
        server = FakeAgentServer()
        try:
            server.respond["/cover.png"] = (200, PNG_BYTES)
            track = make_track(cover_url=f"{server.url}/cover.png")
            downloader.tag_track(quiet_logger, track, audio_file)
            cover = read_tags(audio_file)["covr"][0]
            assert bytes(cover) == PNG_BYTES
            assert cover.imageformat == MP4Cover.FORMAT_PNG
        finally:
            server.close()

    def test_failed_cover_download_never_fails_the_track(self, audio_file, quiet_logger):
        """A broken cover URL is logged and skipped; the song still gets tags."""
        server = FakeAgentServer()
        try:
            server.respond["/cover.jpg"] = (404, {"error": "gone"})
            track = make_track(cover_url=f"{server.url}/cover.jpg")
            result = downloader.tag_track(quiet_logger, track, audio_file)
            assert result == audio_file
            tags = read_tags(audio_file)
            assert tags["covr"] is None
            assert tags["\xa9nam"] == ["Me at the zoo"]
        finally:
            server.close()

    def test_non_image_cover_bytes_are_skipped(self, audio_file, quiet_logger):
        server = FakeAgentServer()
        try:
            server.respond["/cover"] = (200, b"<html>not an image</html>")
            track = make_track(cover_url=f"{server.url}/cover")
            downloader.tag_track(quiet_logger, track, audio_file)
            assert read_tags(audio_file)["covr"] is None
        finally:
            server.close()

    def test_unreachable_cover_host_is_skipped(self, audio_file, quiet_logger):
        track = make_track(cover_url="http://127.0.0.1:1/cover.jpg")
        result = downloader.tag_track(quiet_logger, track, audio_file)
        assert result == audio_file
        assert read_tags(audio_file)["covr"] is None
