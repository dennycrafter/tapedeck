"""The downloader setup code (T17): decoding it and writing agent/.env."""

import setup_code

TOKEN = "ab" * 32
# The same code web/lib/setup-code.test.ts encodes: both sides agree.
SAMPLE = (
    "tapedeck1:eyJ1IjoiaHR0cHM6Ly9teS10YXBlZGVjay52ZXJjZWwuYXBwIiwidCI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJh"
    "YmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIifQ"
)
EXAMPLE = "# Tapedeck settings\nAPP_URL=\n\n# Same value as AGENT_TOKEN in Vercel.\nAGENT_TOKEN=\nCOOKIES_BROWSER=chrome\n"


def files(tmp_path, env=None):
    env_file, example = tmp_path / ".env", tmp_path / ".env.example"
    example.write_text(EXAMPLE, encoding="utf-8")
    if env is not None:
        env_file.write_text(env, encoding="utf-8")
    return env_file, example


class TestDecode:
    def test_reads_the_code_the_app_makes(self):
        assert setup_code.decode(f"  {SAMPLE}\n") == ("https://my-tapedeck.vercel.app", TOKEN)

    def test_refuses_anything_else(self):
        assert setup_code.decode("hello") is None
        assert setup_code.decode("tapedeck1:!!!") is None
        assert setup_code.decode("tapedeck1:e30") is None  # {} has no url or token
        assert setup_code.decode(TOKEN) is None


class TestRun:
    def test_a_fresh_install_gets_both_values_and_keeps_the_rest(self, tmp_path, capsys):
        env_file, example = files(tmp_path)
        assert setup_code.run(None, env_file, example, ask=lambda prompt: SAMPLE) == 0
        text = env_file.read_text(encoding="utf-8")
        assert "APP_URL=https://my-tapedeck.vercel.app\n" in text
        assert f"AGENT_TOKEN={TOKEN}\n" in text
        assert "COOKIES_BROWSER=chrome" in text
        assert "# Same value as AGENT_TOKEN in Vercel." in text
        assert "Done. The downloader will use https://my-tapedeck.vercel.app." in capsys.readouterr().out

    def test_enter_keeps_an_existing_setup(self, tmp_path, capsys):
        env_file, example = files(tmp_path, "APP_URL=https://old.vercel.app\nAGENT_TOKEN=old\nCOOKIES_BROWSER=firefox\n")
        assert setup_code.run(None, env_file, example, ask=lambda prompt: "") == 0
        assert env_file.read_text(encoding="utf-8") == "APP_URL=https://old.vercel.app\nAGENT_TOKEN=old\nCOOKIES_BROWSER=firefox\n"
        assert "set up for https://old.vercel.app" in capsys.readouterr().out

    def test_a_new_code_replaces_the_old_values_in_place(self, tmp_path):
        env_file, example = files(tmp_path, "APP_URL=https://old.vercel.app\nAGENT_TOKEN=old\nCOOKIES_BROWSER=firefox\n")
        assert setup_code.run(SAMPLE, env_file, example) == 0
        assert env_file.read_text(encoding="utf-8") == (
            f"APP_URL=https://my-tapedeck.vercel.app\nAGENT_TOKEN={TOKEN}\nCOOKIES_BROWSER=firefox\n"
        )

    def test_enter_without_a_setup_says_so(self, tmp_path):
        env_file, example = files(tmp_path)
        assert setup_code.run(None, env_file, example, ask=lambda prompt: "") == 1
        assert not env_file.exists()

    def test_a_wrong_code_changes_nothing(self, tmp_path, capsys):
        env_file, example = files(tmp_path, "APP_URL=https://old.vercel.app\nAGENT_TOKEN=old\n")
        assert setup_code.run("not a code", env_file, example) == 1
        assert env_file.read_text(encoding="utf-8") == "APP_URL=https://old.vercel.app\nAGENT_TOKEN=old\n"
        assert "not a Tapedeck setup code" in capsys.readouterr().out

    def test_no_keyboard_is_like_enter(self, tmp_path):
        env_file, example = files(tmp_path)

        def closed(prompt):
            raise EOFError

        assert setup_code.run(None, env_file, example, ask=closed) == 1
