# E2E tests (SPEC 9.0)

Playwright runs the whole app by itself, with the 4.1 stand-ins: the config
starts `next dev` on port 3100 over https (a throwaway self-signed cert is
generated per run, since SPEC 8.1 marks the session cookie Secure, and WebKit
rejects Secure cookies on plain http) with `TAPEDECK_TEST=1` (in-memory
PGlite, local storage in a temp folder) and the MSW fixtures under
`fixtures/` answer every external call. Tests log in with the dev password
(`tapedeck-dev`). No secrets are needed for any test except the `@live`
ones.

## Running

```bash
npm run e2e          # everything except @live
npm run e2e:desktop  # one project (also: e2e:iphone, e2e:android)
npm run e2e:t2       # ticket T2's tag plus every earlier tag (@T0|@T1|@T2)
npm run e2e:live     # @live only; runs after you go live (5.1 variables set)
```

## Tags (in test titles)

- `@T0` ... `@T8`: the ticket a test belongs to. A ticket runs its own tag
  plus every earlier tag (`e2e:tN` scripts above).
- `@net`: makes real no-key network calls (YouTube oEmbed, SoundCloud
  oEmbed, iTunes, Deezer). Skipped, not failed, when the machine has no
  internet; note it in `docs/TEST-REPORT.md`.
- `@live`: real accounts. Skipped unless the 5.1 variables exist; run only
  via `npm run e2e:live`.

## Helpers (`helpers/`)

- `login.ts`: logs a page in with the dev password; throws if the
  `tapedeck_session` cookie (SPEC 8.1) is not set.
- `db.ts`: seeds and cleans up through the app's own `web/lib/db.ts` and
  `web/lib/storage.ts` (SPEC 9.0): `seedTrack`, `getTrackById`,
  `clearLibraryData`, `setAgentLastSeen`, `trackFileExists`. It imports the
  real modules, so the suite typechecks against the actual adapters.
- `agent.ts`: `runSelftest(trackId)` spawns `python agent/downloader.py
  --selftest --track <id>` with `APP_URL` = the test server and `AGENT_TOKEN` =
  the test server's token (SPEC 9.0); `agentApi(path)` calls the agent
  endpoints with the same bearer token.
- `net.ts`: `skipWithoutNet()` / `skipWithoutLive()` guards and
  `forbidNonLocalRequests()`, a tripwire that aborts and fails any browser
  request leaving localhost.
- `env.ts`: the single source of the test-mode environment (`TAPEDECK_TEST=1`,
  throwaway 64-hex test secrets, per-run temp data dir) shared by the config,
  the db helper and the agent helper.

## Layout

- `playwright.config.ts` lives at `web/playwright.config.ts` (projects:
  `desktop` Chromium 1440x900, `iphone` WebKit iPhone 13, `android` Chromium
  Pixel 7).
- `fixtures/` and `mocks/` (MSW handlers, gated by `TAPEDECK_TEST=1`) are
  covered in `fixtures/README.md`.
- This directory is excluded from the vitest run (`vitest.config.ts` include
  list) and included in tsc, so helpers typecheck with the app.
