"""The owner's YouTube login for yt-dlp (ytdlp_cookies.py).

Every step is driven by a fake attempt that answers with yt-dlp's real
error text (recorded on Windows with yt-dlp 2026.10.26), so no browser,
cookie file or network is touched.
"""

import subprocess

import pytest

import finder
import import_listing
import ytdlp_cookies

LOCKED_ERR = "ERROR: Could not copy Chrome cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info"
DPAPI_ERR = "ERROR: Failed to decrypt with DPAPI. See  https://github.com/yt-dlp/yt-dlp/issues/10927  for more info"
NOT_FOUND_ERR = 'ERROR: could not find chrome cookies database in "C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data\\Nope"'
UNSUPPORTED_ERR = 'error: unsupported browser specified for cookies: "chrom". Supported browsers are: brave, chrome'
BAD_FILE_ERR = "ERROR: 'C:/x/cookies.txt' does not look like a Netscape format cookies file"
JSON_FILE_ERR = "ERROR: Cookies file must be Netscape formatted, not JSON. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ"
BOT_ERR = (
    "ERROR: [youtube] LXHzEFR7laU: Sign in to confirm you\u2019re not a bot. This helps protect our community. "
    "Use --cookies-from-browser or --cookies for the authentication."
)
AGE_ERR = "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users."
GONE_ERR = "ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader"


class FakeYtDlp:
    """Answers each attempt by the cookie option it got: browser, file or none."""

    def __init__(self, browser=(0, ""), file=(0, ""), none=(0, "")):
        self.answers = {"--cookies-from-browser": browser, "--cookies": file, None: none}
        self.calls = []

    def __call__(self, cookie_args):
        self.calls.append(cookie_args)
        code, stderr = self.answers[cookie_args[0] if cookie_args else None]
        return code, "", stderr


@pytest.fixture
def cookie_file(tmp_path):
    """A saved cookies.txt at the path the autouse fixture set in COOKIES_FILE."""
    path = tmp_path / "cookies.txt"
    path.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
    return path


class TestSettings:
    def test_default_is_chrome_then_no_cookies(self):
        steps = ytdlp_cookies.sources()
        assert [s.kind for s in steps] == ["browser", "none"]
        assert steps[0].args == ("--cookies-from-browser", "chrome")
        assert steps[1].args == ()

    def test_saved_cookies_txt_comes_second(self, cookie_file):
        steps = ytdlp_cookies.sources()
        assert [s.kind for s in steps] == ["browser", "file", "none"]
        assert steps[1].args == ("--cookies", str(cookie_file))

    @pytest.mark.parametrize("value", ["firefox", "edge", "chrome:Profile 1"])
    def test_browser_is_a_setting(self, monkeypatch, value):
        monkeypatch.setenv("COOKIES_BROWSER", value)
        assert ytdlp_cookies.sources()[0].args == ("--cookies-from-browser", value)

    def test_empty_browser_means_chrome(self, monkeypatch):
        monkeypatch.setenv("COOKIES_BROWSER", "  ")
        assert ytdlp_cookies.browser_setting() == "chrome"

    @pytest.mark.parametrize("value", ["none", "OFF"])
    def test_browser_step_can_be_turned_off(self, monkeypatch, cookie_file, value):
        monkeypatch.setenv("COOKIES_BROWSER", value)
        assert [s.kind for s in ytdlp_cookies.sources()] == ["file", "none"]

    def test_default_file_is_next_to_the_downloader(self, monkeypatch):
        monkeypatch.delenv("COOKIES_FILE")
        assert ytdlp_cookies.cookies_file() == ytdlp_cookies.AGENT_DIR / "cookies.txt"

    def test_relative_file_starts_at_the_agent_folder(self, monkeypatch):
        """The Task Scheduler starts the downloader in another folder."""
        monkeypatch.setenv("COOKIES_FILE", '"my cookies.txt"')
        assert ytdlp_cookies.cookies_file() == ytdlp_cookies.AGENT_DIR / "my cookies.txt"

    def test_browser_names_for_messages(self):
        assert ytdlp_cookies.browser_name("chrome") == "Chrome"
        assert ytdlp_cookies.browser_name("chrome:Profile 1") == "Chrome"
        assert ytdlp_cookies.browser_name("firefox") == "Firefox"
        assert ytdlp_cookies.browser_name("edge+basictext") == "Edge"

    def test_insert_args_goes_after_the_module(self):
        command = ["py", "-m", "yt_dlp", "-J", "url"]
        assert ytdlp_cookies.insert_args(command, ["--cookies", "c.txt"]) == [
            "py", "-m", "yt_dlp", "--cookies", "c.txt", "-J", "url",
        ]
        assert ytdlp_cookies.insert_args(command, []) == command


class TestClassify:
    @pytest.mark.parametrize(
        ("output", "problem"),
        [
            (LOCKED_ERR, ytdlp_cookies.LOCKED),
            (DPAPI_ERR, ytdlp_cookies.UNREADABLE),
            (NOT_FOUND_ERR, ytdlp_cookies.NOT_FOUND),
            (UNSUPPORTED_ERR, ytdlp_cookies.NOT_FOUND),
            (BAD_FILE_ERR, ytdlp_cookies.BAD_FILE),
            (JSON_FILE_ERR, ytdlp_cookies.BAD_FILE),
            (BOT_ERR, ytdlp_cookies.BOT_CHECK),
            (AGE_ERR, ytdlp_cookies.BOT_CHECK),
            (GONE_ERR, None),
            ("", None),
        ],
    )
    def test_reads_yt_dlp_errors(self, output, problem):
        assert ytdlp_cookies.classify(output) == problem


class TestRun:
    def test_chrome_works_first_time(self):
        fake = FakeYtDlp(browser=(0, ""))
        result = ytdlp_cookies.run(fake)
        assert result.returncode == 0
        assert fake.calls == [["--cookies-from-browser", "chrome"]]
        assert result.plain_error() is None

    def test_locked_chrome_falls_back_to_cookies_txt(self, cookie_file):
        fake = FakeYtDlp(browser=(1, LOCKED_ERR), file=(0, ""))
        result = ytdlp_cookies.run(fake)
        assert result.returncode == 0
        assert fake.calls == [["--cookies-from-browser", "chrome"], ["--cookies", str(cookie_file)]]

    def test_ends_with_no_cookies_like_before(self):
        """No readable login anywhere: the plain download still gets its chance."""
        fake = FakeYtDlp(browser=(1, DPAPI_ERR), none=(0, ""))
        result = ytdlp_cookies.run(fake)
        assert result.returncode == 0
        assert fake.calls[-1] == []

    def test_other_errors_are_final(self, cookie_file):
        """A removed video is not a login problem: no point trying more cookies."""
        fake = FakeYtDlp(browser=(1, GONE_ERR))
        result = ytdlp_cookies.run(fake)
        assert len(fake.calls) == 1
        assert result.returncode == 1
        assert result.plain_error() is None

    def test_ok_codes_end_the_tries(self):
        """--max-downloads exits with 101 after its one download: a success."""
        fake = FakeYtDlp(browser=(101, ""))
        result = ytdlp_cookies.run(fake, ok_codes=(0, 101))
        assert result.returncode == 101
        assert len(fake.calls) == 1

    def test_unreadable_browser_is_skipped_for_the_rest_of_the_song(self):
        """yt-dlp spends seconds searching every Chrome profile, so one song tries it once."""
        fake = FakeYtDlp(browser=(1, LOCKED_ERR), none=(1, BOT_ERR))
        first = ytdlp_cookies.run(fake)
        second = ytdlp_cookies.run(fake)
        assert fake.calls == [["--cookies-from-browser", "chrome"], [], []]
        assert second.plain_error() == first.plain_error()
        assert second.plain_error().startswith("Close Chrome")

    def test_next_song_tries_the_browser_again(self):
        """After "Close Chrome and hit Retry", the retried song must read Chrome again."""
        fake = FakeYtDlp(browser=(1, LOCKED_ERR), none=(0, ""))
        ytdlp_cookies.run(fake)
        ytdlp_cookies.new_task()
        fake.answers["--cookies-from-browser"] = (0, "")
        ytdlp_cookies.run(fake)
        assert fake.calls[-1] == ["--cookies-from-browser", "chrome"]

    def test_logged_out_browser_is_not_skipped(self):
        """Chrome could be read; a login check there is not a reason to stop asking it."""
        fake = FakeYtDlp(browser=(1, BOT_ERR), none=(1, BOT_ERR))
        ytdlp_cookies.run(fake)
        ytdlp_cookies.run(fake)
        assert fake.calls.count(["--cookies-from-browser", "chrome"]) == 2

    def test_logs_each_step(self, caplog):
        import logging

        with caplog.at_level(logging.INFO):
            ytdlp_cookies.run(FakeYtDlp(browser=(1, LOCKED_ERR), none=(0, "")))
        assert "cookies: chrome did not work (the browser is open and holds its cookies)" in caplog.text
        assert "cookies: used no cookies." in caplog.text


class TestPlainError:
    """The one line the app shows under a failed song when YouTube wants a login."""

    def message(self, **answers):
        return ytdlp_cookies.run(FakeYtDlp(**answers)).plain_error()

    def test_chrome_open(self):
        assert self.message(browser=(1, LOCKED_ERR), none=(1, BOT_ERR)).startswith("Close Chrome and hit Retry")

    def test_chrome_cookies_unreadable(self):
        message = self.message(browser=(1, DPAPI_ERR), none=(1, BOT_ERR))
        assert message.startswith("Save a cookies.txt and hit Retry")
        assert "Chrome won't share your YouTube login" in message

    def test_browser_not_installed(self, monkeypatch):
        monkeypatch.setenv("COOKIES_BROWSER", "firefox")
        message = self.message(browser=(1, NOT_FOUND_ERR), none=(1, BOT_ERR))
        assert "Firefox wasn't found on this PC" in message

    def test_logged_out_of_youtube(self):
        message = self.message(browser=(1, BOT_ERR), none=(1, BOT_ERR))
        assert message.startswith("Log in to YouTube in Chrome and hit Retry")

    def test_saved_file_expired(self, cookie_file):
        message = self.message(browser=(1, LOCKED_ERR), file=(1, BOT_ERR), none=(1, BOT_ERR))
        assert message.startswith("Save a fresh cookies.txt and hit Retry")

    def test_saved_file_wrong_format(self, cookie_file):
        message = self.message(browser=(1, LOCKED_ERR), file=(1, JSON_FILE_ERR), none=(1, BOT_ERR))
        assert message.startswith("Save cookies.txt again and hit Retry")

    def test_browser_turned_off_and_no_file(self, monkeypatch):
        monkeypatch.setenv("COOKIES_BROWSER", "none")
        assert self.message(none=(1, BOT_ERR)).startswith("Save a cookies.txt and hit Retry")

    def test_age_check_counts_too(self):
        assert self.message(browser=(1, LOCKED_ERR), none=(1, AGE_ERR)).startswith("Close Chrome")

    def test_messages_are_short_and_plain(self, tmp_path):
        messages = [
            self.message(browser=(1, LOCKED_ERR), none=(1, BOT_ERR)),
            self.message(browser=(1, DPAPI_ERR), none=(1, BOT_ERR)),
            self.message(browser=(1, NOT_FOUND_ERR), none=(1, BOT_ERR)),
            self.message(browser=(1, BOT_ERR), none=(1, BOT_ERR)),
        ]
        (tmp_path / "cookies.txt").write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
        messages += [
            self.message(browser=(1, LOCKED_ERR), file=(1, BOT_ERR), none=(1, BOT_ERR)),
            self.message(browser=(1, LOCKED_ERR), file=(1, BAD_FILE_ERR), none=(1, BOT_ERR)),
        ]
        for message in messages:
            assert message and len(message) <= 120
            assert "\u2014" not in message and "yt-dlp" not in message


class TestCallers:
    """The finder and the playlist importer use the same steps as a download."""

    def test_finder_search_passes_the_cookies(self, monkeypatch):
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, stdout="{}", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        code, stdout, _ = finder.run_command(finder.ytdlp_search_command("ytsearch10:a - b"))
        assert (code, stdout) == (0, "{}")
        assert calls[0][3:5] == ["--cookies-from-browser", "chrome"]
        assert calls[0][-1] == "ytsearch10:a - b"

    def test_import_listing_shows_the_plain_error(self, monkeypatch):
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            stderr = LOCKED_ERR if "--cookies-from-browser" in command else BOT_ERR
            return subprocess.CompletedProcess(command, 1, stdout="", stderr=stderr)

        monkeypatch.setattr(subprocess, "run", fake_run)
        code, _, stderr = import_listing.run_yt_dlp(["-J", "https://youtube.com/@x"], None, 30)
        assert code == 1
        assert len(calls) == 2
        assert import_listing._error_tail(stderr).startswith("ERROR: Close Chrome and hit Retry")
