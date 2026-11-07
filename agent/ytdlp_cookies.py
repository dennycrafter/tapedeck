"""The owner's YouTube login for every yt-dlp call (YouTube's bot check).

YouTube sometimes answers this PC with "Sign in to confirm you're not a
bot". yt-dlp gets past it with the owner's YouTube login cookies. Every
yt-dlp call (download, --probe, the finder's searches, playlist listing)
goes through run(), which tries these in order:

1. The browser named by COOKIES_BROWSER in agent/.env (default chrome),
   passed as --cookies-from-browser. yt-dlp's BROWSER[:PROFILE] form
   works too, for example "chrome:Profile 1"; "none" turns this step off.
2. The cookies.txt file at COOKIES_FILE (default agent/cookies.txt),
   passed as --cookies, only when the file exists (yt-dlp would create
   an empty one otherwise).
3. No cookies, how the downloader worked before: most songs still download.

It moves on only when the cookies could not be read or YouTube still asked
to sign in; any other result (success, a removed video, a network error)
is final. When the sign in check stopped every step, plain_error() gives
one short line for the app telling the owner what to do.

Chrome and Edge on Windows lock their cookie file while they are open, and
since Chrome 127 they encrypt it in a way yt-dlp cannot read even when
closed ("app-bound encryption"). On most Windows PCs step 2 is therefore
the one that works; Firefox's cookies stay readable while it runs.
"""

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

AGENT_DIR = Path(__file__).resolve().parent
DEFAULT_BROWSER = "chrome"
DEFAULT_COOKIES_FILE = AGENT_DIR / "cookies.txt"
# COOKIES_BROWSER values that turn the browser step off (empty means chrome).
BROWSER_OFF = {"none", "off"}

# Why a step did not get past YouTube, read from yt-dlp's own messages.
LOCKED = "the browser is open and holds its cookies"
UNREADABLE = "the browser's cookie encryption can't be read"
NOT_FOUND = "that browser or profile is not on this PC"
BAD_FILE = "cookies.txt is not a Netscape format cookies file"
BOT_CHECK = "YouTube asked to sign in"

# Lowercase pieces of yt-dlp's error text, checked in this order.
_PROBLEMS = (
    (LOCKED, ("could not copy chrome cookie database",)),
    (UNREADABLE, ("failed to decrypt with dpapi", "cannot decrypt v1")),
    (NOT_FOUND, ("cookies database", "unsupported browser specified for cookies")),
    (BAD_FILE, ("netscape format cookies file", "netscape formatted")),
    # "...you're not a bot" and "...your age": both need a logged in account.
    (BOT_CHECK, ("sign in to confirm",)),
)

_BROWSER_NAMES = {
    "brave": "Brave",
    "chrome": "Chrome",
    "chromium": "Chromium",
    "edge": "Edge",
    "firefox": "Firefox",
    "opera": "Opera",
    "safari": "Safari",
    "vivaldi": "Vivaldi",
    "whale": "Whale",
}

# Takes the cookie options to add; returns (exit code, stdout, stderr).
Attempt = Callable[[list[str]], tuple[int, str, str]]

# Browsers whose cookies could not be read during the current song or
# import job. Each try costs seconds (yt-dlp searches every browser
# profile), so the job's later calls skip them; new_task() starts over,
# so the next song or a Retry tries the browser again.
_unreadable: dict[str, str] = {}
_UNREADABLE_PROBLEMS = (LOCKED, UNREADABLE, NOT_FOUND)


@dataclass(frozen=True)
class Source:
    """One way of handing yt-dlp the login."""

    kind: str  # "browser", "file" or "none"
    label: str  # for the log, for example "chrome" or "cookies.txt"
    args: tuple[str, ...]


@dataclass(frozen=True)
class CookieRun:
    """The final yt-dlp result and what each step ran into, in order."""

    returncode: int
    stdout: str
    stderr: str
    tried: list[tuple[Source, str | None]] = field(default_factory=list)

    def plain_error(self) -> str | None:
        """One line for the app when YouTube's sign in check stopped every step.

        It leads with what to do, because the app shows only the start of
        the error under the song. None when the run ended any other way.
        """
        if not self.tried or self.tried[-1][1] != BOT_CHECK:
            return None
        steps = {source.kind: (source, problem) for source, problem in self.tried}
        if "file" in steps:
            if steps["file"][1] == BAD_FILE:
                return "Save cookies.txt again and hit Retry: the saved file is in the wrong format (see the README)."
            return "Save a fresh cookies.txt and hit Retry: YouTube no longer accepts the saved one (see the README)."
        if "browser" not in steps:
            return "Save a cookies.txt and hit Retry: YouTube wants your login (see the README)."
        source, problem = steps["browser"]
        name = browser_name(source.label)
        if problem == LOCKED:
            return f"Close {name} and hit Retry, or save a cookies.txt (see the README): YouTube wants your login."
        if problem == BOT_CHECK:
            return f"Log in to YouTube in {name} and hit Retry: YouTube wants your login."
        if problem == UNREADABLE:
            return f"Save a cookies.txt and hit Retry: {name} won't share your YouTube login (see the README)."
        return f"Save a cookies.txt and hit Retry: {name} wasn't found on this PC (see the README)."


def browser_setting() -> str | None:
    """COOKIES_BROWSER, default chrome; None when it is turned off."""
    value = os.environ.get("COOKIES_BROWSER", "").strip() or DEFAULT_BROWSER
    return None if value.lower() in BROWSER_OFF else value


def browser_name(setting: str) -> str:
    """'chrome:Profile 1' -> 'Chrome', for the messages."""
    key = setting.split(":", 1)[0].split("+", 1)[0].strip().lower()
    return _BROWSER_NAMES.get(key, key.capitalize() or "your browser")


def cookies_file() -> Path:
    """COOKIES_FILE, default agent/cookies.txt; relative paths start at agent/."""
    value = os.environ.get("COOKIES_FILE", "").strip().strip('"')
    if not value:
        return DEFAULT_COOKIES_FILE
    path = Path(value).expanduser()
    return path if path.is_absolute() else AGENT_DIR / path


def sources() -> list[Source]:
    """The steps to try, read from the environment at call time."""
    steps = []
    browser = browser_setting()
    if browser:
        steps.append(Source("browser", browser, ("--cookies-from-browser", browser)))
    path = cookies_file()
    if path.is_file():
        steps.append(Source("file", path.name, ("--cookies", str(path))))
    steps.append(Source("none", "no cookies", ()))
    return steps


def classify(output: str) -> str | None:
    """The cookie or sign in problem in yt-dlp's output, or None."""
    text = output.lower()
    for problem, pieces in _PROBLEMS:
        if any(piece in text for piece in pieces):
            return problem
    return None


def insert_args(command: list[str], cookie_args: list[str]) -> list[str]:
    """Put the cookie options right after `python -m yt_dlp` in a command."""
    return command[:3] + cookie_args + command[3:]


def new_task() -> None:
    """A new song or import job begins: try the browser again."""
    _unreadable.clear()


def run(attempt: Attempt, logger: logging.Logger | None = None, ok_codes: tuple[int, ...] = (0,)) -> CookieRun:
    """Run one yt-dlp call through the steps until one gets past YouTube.

    An exit code in `ok_codes` is always final; any other is final unless
    the output shows a cookie or sign in problem.
    """
    logger = logger or logging.getLogger("downloader.cookies")
    steps = sources()
    tried: list[tuple[Source, str | None]] = []
    code, stdout, stderr = 1, "", ""
    for source in steps:
        if source.kind == "browser" and source.label in _unreadable:
            tried.append((source, _unreadable[source.label]))
            continue
        code, stdout, stderr = attempt(list(source.args))
        problem = None if code in ok_codes else classify(stderr + "\n" + stdout)
        if source.kind == "browser" and problem in _UNREADABLE_PROBLEMS:
            _unreadable[source.label] = problem
        tried.append((source, problem))
        if problem is None:
            if len(tried) > 1:
                logger.info("cookies: used %s.", source.label)
            break
        if source is not steps[-1]:
            logger.info("cookies: %s did not work (%s); trying the next way.", source.label, problem)
    return CookieRun(code, stdout, stderr, tried)
