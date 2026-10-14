"""The MP4 index goes in front of the audio (offline playback on the phone, SPEC 8.9)."""
import logging
import shutil
import subprocess
from pathlib import Path

import pytest

import downloader

REPO = Path(__file__).resolve().parents[2]
TONE = REPO / "web" / "public" / "test-audio" / "test1.m4a"
LOG = logging.getLogger("test")


def box(name: str, payload: bytes = b"") -> bytes:
    return (8 + len(payload)).to_bytes(4, "big") + name.encode("latin-1") + payload


def write(tmp_path: Path, *boxes: bytes) -> Path:
    path = tmp_path / "song.m4a"
    path.write_bytes(b"".join(boxes))
    return path


def test_reads_top_level_boxes_in_order(tmp_path):
    path = write(tmp_path, box("ftyp", b"M4A "), box("mdat", b"x" * 20), box("moov", b"y" * 4))
    assert downloader.top_level_atoms(path) == ["ftyp", "mdat", "moov"]


def test_index_after_audio_needs_faststart(tmp_path):
    assert downloader.needs_faststart(write(tmp_path, box("ftyp"), box("mdat", b"a"), box("moov")))


def test_index_first_or_no_index_needs_nothing(tmp_path):
    assert not downloader.needs_faststart(write(tmp_path, box("ftyp"), box("moov"), box("mdat", b"a")))
    assert not downloader.needs_faststart(write(tmp_path, box("ftyp"), box("mdat", b"a")))


def test_committed_test_tones_have_the_index_first():
    for name in ("test1.m4a", "test2.m4a"):
        assert not downloader.needs_faststart(TONE.parent / name), name


def test_ensure_faststart_keeps_a_file_that_is_already_fine(tmp_path):
    path = write(tmp_path, box("ftyp"), box("moov"), box("mdat", b"a"))
    assert downloader.ensure_faststart(LOG, path) == path


def test_ensure_faststart_keeps_the_original_without_ffmpeg(tmp_path, monkeypatch):
    path = write(tmp_path, box("ftyp"), box("mdat", b"a"), box("moov"))

    def missing(*_args, **_kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(downloader.subprocess, "run", missing)
    assert downloader.ensure_faststart(LOG, path) == path


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_ensure_faststart_moves_the_index_without_changing_the_audio(tmp_path):
    slow = tmp_path / "slow.m4a"
    # Re-mux the tone with the index at the end (ffmpeg's default).
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(TONE), "-c", "copy", str(slow)],
        check=True,
    )
    assert downloader.needs_faststart(slow)
    fixed = downloader.ensure_faststart(LOG, slow)
    assert fixed != slow
    assert not downloader.needs_faststart(fixed)
    assert downloader.read_duration(fixed, LOG) == pytest.approx(180, abs=0.5)


def test_conversion_writes_the_index_first():
    source = Path(downloader.__file__).read_text(encoding="utf-8")
    start = source.index("def convert_check")
    assert '"+faststart"' in source[start : source.index("def top_level_atoms")]
