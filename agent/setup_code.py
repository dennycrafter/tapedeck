"""Set up the downloader with the setup code from the app (T17).

The app's Profile > Downloader setup shows one "setup code" holding APP_URL
and AGENT_TOKEN ("tapedeck1:" then base64url of {"u": url, "t": token}, see
web/lib/setup-code.ts). install.bat runs this script, which asks for the code
and writes both values into agent\\.env, keeping every other line as it is.
Pressing Enter without a code keeps the file unchanged (install.bat then opens
Notepad for setting it up by hand).

    py -3.12 setup_code.py                 asks for the code
    py -3.12 setup_code.py --code <code>   no question

Exit code 0 when .env holds an APP_URL and AGENT_TOKEN afterwards, 1 when
not (no code given and nothing set up yet, or a code that is not valid).
Only the standard library: it runs before anything else is installed.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
from pathlib import Path

PREFIX = "tapedeck1:"
AGENT_DIR = Path(__file__).resolve().parent
ENV_FILE = AGENT_DIR / ".env"
ENV_EXAMPLE = AGENT_DIR / ".env.example"


def decode(code: str) -> tuple[str, str] | None:
    """(app_url, agent_token) from a setup code, or None when it is not one."""
    code = code.strip()
    if not code.startswith(PREFIX):
        return None
    body = code[len(PREFIX):]
    try:
        raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        data = json.loads(raw.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    url, token = data.get("u"), data.get("t")
    if not isinstance(url, str) or not re.fullmatch(r"https?://\S+", url):
        return None
    if not isinstance(token, str) or not token:
        return None
    return url.rstrip("/"), token


def read_values(text: str) -> dict[str, str]:
    """KEY=value lines of a .env text (comments and blanks skipped)."""
    values = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def with_values(text: str, updates: dict[str, str]) -> str:
    """The .env text with `updates` set: existing KEY= lines replaced in place, new keys added at the end."""
    lines = text.splitlines()
    done = set()
    for index, line in enumerate(lines):
        key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
        if key in updates:
            lines[index] = f"{key}={updates[key]}"
            done.add(key)
    lines += [f"{key}={value}" for key, value in updates.items() if key not in done]
    return "\n".join(lines) + "\n"


def current_text(env_file: Path, example: Path) -> str:
    if env_file.exists():
        return env_file.read_text(encoding="utf-8")
    if example.exists():
        return example.read_text(encoding="utf-8")
    return ""


def is_set_up(text: str) -> bool:
    values = read_values(text)
    return bool(values.get("APP_URL")) and bool(values.get("AGENT_TOKEN"))


def run(code: str | None, env_file: Path = ENV_FILE, example: Path = ENV_EXAMPLE, ask=input) -> int:
    text = current_text(env_file, example)
    if code is None:
        values = read_values(text)
        if is_set_up(text):
            print(f"The downloader is set up for {values['APP_URL']}.")
            print("Paste a new setup code to change it, or press Enter to keep it.")
        else:
            print("Open the Tapedeck app, go to Profile, then Downloader setup, and copy the setup code.")
            print("Paste it here (right-click pastes in this window) and press Enter.")
        try:
            code = ask("Setup code: ")
        except EOFError:
            code = ""
    if not code.strip():
        return 0 if is_set_up(text) else 1
    decoded = decode(code)
    if decoded is None:
        print("That is not a Tapedeck setup code. Copy it again from Profile > Downloader setup.")
        return 1
    app_url, token = decoded
    env_file.write_text(with_values(text, {"APP_URL": app_url, "AGENT_TOKEN": token}), encoding="utf-8")
    print(f"Done. The downloader will use {app_url}.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Set up the Tapedeck downloader with the setup code from the app.")
    parser.add_argument("--code", help="the setup code from Profile > Downloader setup")
    args = parser.parse_args(argv)
    return run(args.code)


if __name__ == "__main__":
    sys.exit(main())
