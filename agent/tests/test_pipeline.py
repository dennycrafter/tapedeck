"""Pipeline stage logic: preview check, file picking, durations, commands.

The ffmpeg conversion subprocess is covered when ffmpeg exists on the
machine (skipped otherwise); everything else runs everywhere, including
the mutagen duration fallback that keeps --selftest working without it.
"""

import shutil
import subprocess

import pytest

import downloader

from .conftest import TEST_AUDIO, make_track


class TestPreviewCheck:
    """SPEC 8.3 step 2: fail when the file is under 60% of the expected duration."""

    @pytest.mark.parametrize(
        ("real_sec", "expected_sec", "expected"),
        [
            (100, 200, True),  # 50% - preview
            (119.9, 200, True),  # just under the line
            (120, 200, False),  # exactly 60% is fine ("under 60%" fails)
            (180.02, 180, False),  # full file, test1.m4a length
            (300, 180, False),  # longer than expected is fine
            (100, None, False),  # unknown expected duration cannot judge
            (None, 200, False),  # unreadable duration cannot judge
            (None, None, False),
        ],
    )
    def test_is_preview(self, real_sec, expected_sec, expected):
        assert downloader.is_preview(real_sec, expected_sec) is expected

    def test_message_uses_spec_wording(self):
        assert downloader.preview_error_message() == (
            "Only a preview was available (SoundCloud Go+ track?)"
        )


class TestFindDownloadedFile:
    def test_prefers_m4a(self, tmp_path):
        (tmp_path / "tr1.webm").write_bytes(b"x")
        (tmp_path / "tr1.m4a").write_bytes(b"x")
        assert downloader.find_downloaded_file(tmp_path, "tr1").name == "tr1.m4a"

    def test_picks_newest_when_no_m4a(self, tmp_path):
        import os

        old = tmp_path / "tr1.opus"
        new = tmp_path / "tr1.webm"
        old.write_bytes(b"x")
        new.write_bytes(b"x")
        os.utime(old, (0, 0))
        assert downloader.find_downloaded_file(tmp_path, "tr1") == new

    def test_ignores_partial_downloads(self, tmp_path):
        (tmp_path / "tr1.webm.part").write_bytes(b"x")
        (tmp_path / "tr1.m4a.ytdl").write_bytes(b"x")
        assert downloader.find_downloaded_file(tmp_path, "tr1") is None

    def test_missing_dir(self, tmp_path):
        assert downloader.find_downloaded_file(tmp_path / "nope", "tr1") is None


class TestCommands:
    def test_yt_dlp_command_matches_spec(self):
        """SPEC 8.3: -f bestaudio[ext=m4a]/bestaudio --no-playlist --js-runtimes deno."""
        command = downloader.build_yt_dlp_command("https://youtu.be/x", "/tmp/tr1.%(ext)s")
        assert command[1:3] == ["-m", "yt_dlp"]
        assert command[3:9] == [
            "-f",
            "bestaudio[ext=m4a]/bestaudio",
            "--no-playlist",
            "--js-runtimes",
            "deno",
            "-o",
        ]
        assert command[-1] == "https://youtu.be/x"

    def test_probe_command_matches_spec(self):
        """SPEC 9.0: yt-dlp --simulate with Deno."""
        command = downloader.build_probe_command("https://youtu.be/x")
        assert command[1:3] == ["-m", "yt_dlp"]
        assert "--simulate" in command
        assert command[command.index("--js-runtimes") + 1] == "deno"
        assert command[-1] == "https://youtu.be/x"


class TestReadDuration:
    def test_ffprobe_output_parses(self, tmp_path, quiet_logger, monkeypatch):
        def fake_run(*args, **kwargs):
            return subprocess.CompletedProcess(args=[], returncode=0, stdout="123.5\n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert downloader.read_duration(tmp_path / "a.m4a", quiet_logger) == 123.5

    def test_mutagen_fallback_without_ffprobe(self, quiet_logger, monkeypatch):
        """No ffprobe on the machine: mutagen reads the m4a length instead."""
        monkeypatch.setattr(
            downloader, "_ffprobe_duration", lambda path, logger: None
        )
        duration = downloader.read_duration(TEST_AUDIO, quiet_logger)
        assert 180 <= duration <= 181  # test1.m4a is a 180 s tone

    def test_garbage_ffprobe_output_falls_back_to_mutagen(self, quiet_logger, monkeypatch):
        def fake_run(*args, **kwargs):
            return subprocess.CompletedProcess(args=[], returncode=0, stdout="N/A\n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        duration = downloader.read_duration(TEST_AUDIO, quiet_logger)
        assert 180 <= duration <= 181


class TestConvertCheck:
    def test_m4a_passes_through_with_duration(self, tmp_path, quiet_logger, tmp_work):
        """An .m4a download needs no ffmpeg; duration still read and checked."""
        work = tmp_work / "tr1"
        work.mkdir(parents=True)
        target = work / "tr1.m4a"
        shutil.copyfile(TEST_AUDIO, target)
        path, duration = downloader.convert_check(quiet_logger, make_track(), target)
        assert path == target
        assert 180 <= duration <= 181

    def test_preview_raises_with_spec_message(self, tmp_path, quiet_logger, tmp_work):
        """The 180 s tone against a 500 s expectation trips the 60% rule."""
        work = tmp_work / "tr1"
        work.mkdir(parents=True)
        target = work / "tr1.m4a"
        shutil.copyfile(TEST_AUDIO, target)
        with pytest.raises(downloader.PipelineError, match="Only a preview was available"):
            downloader.convert_check(quiet_logger, make_track(duration_sec=500), target)

    def test_m4a_never_fails_when_expected_unknown(self, tmp_path, quiet_logger, tmp_work):
        work = tmp_work / "tr9"
        work.mkdir(parents=True)
        target = work / "tr9.m4a"
        shutil.copyfile(TEST_AUDIO, target)
        _, duration = downloader.convert_check(
            quiet_logger, make_track(id="tr9", duration_sec=None), target
        )
        assert duration is not None

    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
    def test_converts_non_m4a_with_ffmpeg(self, tmp_path, quiet_logger, tmp_work):
        """Real conversion: webm/opus in, aac .m4a out (SPEC 8.3 step 2)."""
        generated = tmp_path / "tr1.webm"
        # Build a real opus/webm file from the committed tone, then feed it
        # through convert_check like a yt-dlp download would deliver it.
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(TEST_AUDIO),
                "-vn",
                "-c:a",
                "libopus",
                str(generated),
            ],
            check=True,
            capture_output=True,
        )
        work = tmp_work / "tr1"
        work.mkdir(parents=True)
        (work / "tr1.webm").write_bytes(generated.read_bytes())
        path, duration = downloader.convert_check(quiet_logger, make_track(), work / "tr1.webm")
        assert path == work / "tr1.m4a"
        assert 175 <= duration <= 185

    def test_missing_ffmpeg_gives_plain_language_error(self, quiet_logger, tmp_work, monkeypatch):
        work = tmp_work / "tr1"
        work.mkdir(parents=True)
        (work / "tr1.webm").write_bytes(b"not really audio")

        def raise_not_found(*args, **kwargs):
            raise FileNotFoundError("ffmpeg")

        monkeypatch.setattr(subprocess, "run", raise_not_found)
        with pytest.raises(downloader.PipelineError, match="winget install --id=Gyan.FFmpeg"):
            downloader.convert_check(quiet_logger, make_track(), work / "tr1.webm")


class TestDownloadTrack:
    def test_returns_downloaded_file(self, quiet_logger, tmp_work, monkeypatch):
        work = tmp_work / "tr1"

        def fake_run(command, **kwargs):
            work.mkdir(parents=True, exist_ok=True)
            (work / "tr1.webm").write_bytes(b"audio")
            return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        path = downloader.download_track(quiet_logger, None, make_track())
        assert path == work / "tr1.webm"

    def test_failure_raises_with_output_tail(self, quiet_logger, tmp_work, monkeypatch):
        def fake_run(command, **kwargs):
            return subprocess.CompletedProcess(
                args=command,
                returncode=1,
                stdout="",
                stderr="ERROR: Sign in to confirm you're not a bot",
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        with pytest.raises(downloader.PipelineError, match="not a bot"):
            downloader.download_track(quiet_logger, None, make_track())

    def test_success_without_file_raises(self, quiet_logger, tmp_work, monkeypatch):
        def fake_run(command, **kwargs):
            return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        with pytest.raises(downloader.PipelineError, match="no audio file"):
            downloader.download_track(quiet_logger, None, make_track())

    def test_missing_binary_gives_plain_language_error(self, quiet_logger, monkeypatch):
        def raise_not_found(*args, **kwargs):
            raise FileNotFoundError("yt_dlp")

        monkeypatch.setattr(subprocess, "run", raise_not_found)
        with pytest.raises(downloader.PipelineError, match="pip install"):
            downloader.download_track(quiet_logger, None, make_track())


class TestUpgradeYtDlp:
    def test_runs_pip_upgrade_and_ignores_failure(self, quiet_logger, monkeypatch):
        """SPEC 8.3 step 1: upgrade at every start; failures are logged, not raised."""
        seen = {}

        def fake_run(command, **kwargs):
            seen["command"] = command
            return subprocess.CompletedProcess(args=command, returncode=1, stdout="", stderr="no net")

        monkeypatch.setattr(subprocess, "run", fake_run)
        downloader.upgrade_yt_dlp(quiet_logger)
        assert "yt-dlp[default]" in seen["command"]
        assert "--upgrade" in seen["command"]

    def test_missing_pip_does_not_raise(self, quiet_logger, monkeypatch):
        def raise_not_found(*args, **kwargs):
            raise FileNotFoundError("pip")

        monkeypatch.setattr(subprocess, "run", raise_not_found)
        downloader.upgrade_yt_dlp(quiet_logger)  # must not raise


DRM_STDERR = "ERROR: [soundcloud] 2411589765: This video is DRM protected"


class TestSoundCloudDrmFallback:
    """A DRM protected SoundCloud link falls back to the same song on YouTube."""

    def sc_track(self, **overrides):
        fields = {
            "source": "soundcloud",
            "source_url": "https://soundcloud.com/octobersveryown/solar-eclipse",
            "title": "Solar Eclipse",
            "artist": "Drake",
            "duration_sec": 200,
        }
        fields.update(overrides)
        return make_track(**fields)

    def test_detects_drm_error(self):
        assert downloader.is_drm_error(DRM_STDERR)
        assert not downloader.is_drm_error("ERROR: Sign in to confirm you're not a bot")
        assert not downloader.is_drm_error("")

    def test_search_query(self):
        assert downloader.youtube_search_query(self.sc_track()) == "Drake Solar Eclipse"
        assert downloader.youtube_search_query(self.sc_track(artist="", title="  ")) is None

    def test_duration_filter(self):
        assert downloader.duration_match_filter(200) == "duration >= 160 & duration <= 240"
        # Short songs get at least 20 seconds of slack either way.
        assert downloader.duration_match_filter(60) == "duration >= 40 & duration <= 80"
        assert downloader.duration_match_filter(None) is None
        assert downloader.duration_match_filter(0) is None

    def test_fallback_command(self):
        cmd = downloader.build_youtube_fallback_command(self.sc_track(), "out.%(ext)s")
        assert cmd[-1] == "ytsearch5:Drake Solar Eclipse"
        assert cmd[cmd.index("--max-downloads") + 1] == "1"
        assert cmd[cmd.index("--match-filter") + 1] == "duration >= 160 & duration <= 240"
        assert "--no-playlist" not in cmd  # a search result list is a playlist
        no_len = downloader.build_youtube_fallback_command(
            self.sc_track(duration_sec=None), "out.%(ext)s"
        )
        assert "--match-filter" not in no_len

    def test_drm_falls_back_to_youtube(self, quiet_logger, tmp_work, monkeypatch):
        work = tmp_work / "tr1"
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            if len(calls) == 1:
                return subprocess.CompletedProcess(command, 1, stdout="", stderr=DRM_STDERR)
            work.mkdir(parents=True, exist_ok=True)
            (work / "tr1.m4a").write_bytes(b"audio")
            # --max-downloads makes yt-dlp exit with 101 after the one download.
            return subprocess.CompletedProcess(command, 101, stdout="", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        path = downloader.download_track(quiet_logger, None, self.sc_track())
        assert path == work / "tr1.m4a"
        assert calls[1][-1] == "ytsearch5:Drake Solar Eclipse"

    def test_no_youtube_match_gives_friendly_error(self, quiet_logger, tmp_work, monkeypatch):
        def fake_run(command, **kwargs):
            if "soundcloud.com" in command[-1]:
                return subprocess.CompletedProcess(command, 1, stdout="", stderr=DRM_STDERR)
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        with pytest.raises(downloader.PipelineError) as err:
            downloader.download_track(quiet_logger, None, self.sc_track())
        assert str(err.value) == downloader.DRM_ERROR_MESSAGE
        assert "Paste a YouTube link" in str(err.value)
        assert len(str(err.value)) <= downloader.MAX_ERROR_CHARS

    def test_no_title_skips_search(self, quiet_logger, tmp_work, monkeypatch):
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 1, stdout="", stderr=DRM_STDERR)

        monkeypatch.setattr(subprocess, "run", fake_run)
        with pytest.raises(downloader.PipelineError, match="protected"):
            downloader.download_track(quiet_logger, None, self.sc_track(artist="", title=""))
        assert len(calls) == 1
