"""Surface tests: stdlib-only import, CLI parsing, SPEC constants (SPEC 9.0).

T0 established the contract that `import downloader` needs no pip install
and --help works before the libraries are present; T1a must keep it.
"""

import subprocess
import sys

import pytest

import downloader


def test_constants_pin_spec_behavior():
    """SPEC 8.3: poll every 20 s; rotate the log at 1 MB, keep 3."""
    assert downloader.DEFAULT_POLL_INTERVAL_SEC == 20
    assert downloader.LOG_MAX_BYTES == 1_000_000
    assert downloader.LOG_BACKUP_COUNT == 3
    assert downloader.AUDIO_CONTENT_TYPE == "audio/mp4"
    assert downloader.MAX_ERROR_CHARS == 500


def test_help_exits_zero():
    with pytest.raises(SystemExit) as excinfo:
        downloader.parse_args(["--help"])
    assert excinfo.value.code == 0


@pytest.mark.parametrize(
    ("argv", "expected_error"),
    [
        (["--selftest"], "--selftest requires --track"),
        (["--track", "abc"], "--track is only valid together with --selftest"),
        (["--poll-interval", "0"], "must be a positive number of seconds"),
        (["--poll-interval", "-5"], "must be a positive number of seconds"),
        (["--probe", "https://x", "--selftest", "--track", "t"], "cannot be combined"),
        (["--probe", "https://x", "--track", "t"], "is only valid together with --selftest"),
    ],
)
def test_cli_rejects_invalid_arguments(argv, expected_error, capsys):
    with pytest.raises(SystemExit) as excinfo:
        downloader.parse_args(argv)
    assert excinfo.value.code == 2  # argparse's exit code for usage errors
    assert expected_error in capsys.readouterr().err


def test_module_imports_on_stdlib_alone():
    """T0 contract: a bare import needs no requests/mutagen/dotenv/yt_dlp.

    Runs in a fresh interpreter so leftover imports from other tests
    cannot mask a regression to module-level third-party imports.
    """
    code = (
        "import sys; import downloader; "
        "leaked = [m for m in ('requests', 'mutagen', 'dotenv', 'yt_dlp') if m in sys.modules]; "
        "assert not leaked, leaked"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(downloader.Path(__file__).resolve().parent.parent),
        check=False,
    )
    assert result.returncode == 0, result.stderr
