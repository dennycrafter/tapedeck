"""Smoke tests for the T0 downloader skeleton (SPEC 9.0).

The pipeline stages are NotImplementedError stubs until T1a. These tests
pin the surface T1a must keep: the module imports on the standard library
alone, the CLI parses and validates its arguments, and every stub fails
loudly with its SPEC reference instead of doing nothing.
"""

import inspect

import pytest

import downloader


# Every stage and one-shot command that T1a is expected to implement.
STUB_STAGES = (
    "load_env",
    "upgrade_yt_dlp",
    "poll_for_claims",
    "download_track",
    "convert_check",
    "tag_track",
    "upload_track",
    "report_result",
    "run_selftest",
    "run_probe",
)


def test_skeleton_contract():
    """The bare `import downloader` above must need no pip install (T0
    contract), and the constants pin the SPEC 8.3 logging/polling behavior."""
    assert downloader.DEFAULT_POLL_INTERVAL_SEC == 20
    assert downloader.LOG_MAX_BYTES == 1_000_000
    assert downloader.LOG_BACKUP_COUNT == 3


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
    ],
)
def test_cli_rejects_invalid_arguments(argv, expected_error, capsys):
    with pytest.raises(SystemExit) as excinfo:
        downloader.parse_args(argv)
    assert excinfo.value.code == 2  # argparse's exit code for usage errors
    assert expected_error in capsys.readouterr().err


@pytest.mark.parametrize("stage_name", STUB_STAGES)
def test_stub_stages_raise_not_implemented(stage_name):
    """T0 contract: every stub fails loudly, naming its SPEC reference.

    Arguments are placeholders; a stub must raise before using any of them.
    """
    stage = getattr(downloader, stage_name)
    arity = len(inspect.signature(stage).parameters)
    with pytest.raises(NotImplementedError, match="SPEC"):
        stage(*([None] * arity))
