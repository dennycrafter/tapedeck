# Test report

One block is appended here after every verifier run: the ticket, the date, tests passed, failed and skipped per project (desktop, iphone, android, unit), and anything logged in BLOCKERS.md (SPEC section 9.0).

Entries are append only; a later run never edits or removes an earlier one, so the file reads as a chronological record of every ticket's checks.

---

## T0 — independent checkpoint verification

- **Ticket:** T0 (independent checkpoint verifier; this run wrote none of the code under test)
- **Date:** 2026-10-10
- **Baseline:** `origin/main` at `5e9f563`, verified with `git fetch` before running; clean branch cut from that commit

### Automated suites

| Suite | Command | Passed | Failed | Skipped |
|---|---|---|---|---|
| Unit (vitest, `/web`) | `npx vitest run` | 193 across 14 files | 0 | 0 |
| E2E desktop | `npx playwright test --grep @T0` | 3 | 0 | 0 |
| E2E iphone | `npx playwright test --grep @T0` | 3 | 0 | 0 |
| E2E android | `npx playwright test --grep @T0` | 3 | 0 | 0 |
| E2E total | — | 9 | 0 | 0 |
| Agent (pytest, `/agent`) | `python3 -m pytest` | 15 | 0 | 0 |

Playwright ran the one @T0 spec (`e2e/t0-smoke.spec.ts`, the three-assertion smoke contract) across all three projects, exit 0. Vitest matched the expected 193/193 across 14 files exactly. Python 3.13.14 (the DECISIONS.md 3.12-semantics note applies).

### By-hand 9.0 behaviors

**(1) Local-storage signed GET with Range 206 — PASS (7/7).** Dev server started with `TAPEDECK_TEST=1`, `TAPEDECK_STORAGE_DIR` pointed at a fresh temp dir, and a known `SESSION_SECRET`; signatures were computed independently (HMAC-SHA256 over `key + exp`):

- PUT through the signed URL → 200; the file is present in the temp storage dir (1000 bytes)
- GET through the signed URL → 200, byte-identical body (sha256 match)
- GET with `Range: bytes=100-299` → 206 with `Content-Range: bytes 100-299/1000` and the exact requested byte slice
- Tampered signature → 403; missing signature → 403; expired signature → 403

**(2) Setup flow on a clean directory — PASS on the API flow; one BLOCKED page check.** `web/.data` fully wiped (no PGlite state, no dev secrets, no storage), dev server without `TAPEDECK_TEST`:

- POST `/api/setup/finish` with a wrong password → 401 `Wrong password.`
- POST with the correct password → 409 `already-finished` with per-service results: database OK (settings table in place), storage OK (local stand-in), soundcloud OK, itunes OK, deezer OK (real network calls), youtube NOT_SET and anthropic NOT_SET (optional, no keys)
- POST again → 409 again (the repeat is rejected)
- Schema verified independently by opening `web/.data/pglite` after stopping the server: `album_favorites`, `play_events`, `playlist_tracks`, `playlists`, `search_cache`, `settings`, `tracks` all present, settings seed row intact
- In development the walk of `/setup` hands off to `/login` by design (stand-ins mean nothing to set up); the schema is applied by the dev bootstrap on the first database contact rather than by the finish route, whose own apply path stays covered by its unit tests
- Production build with zero variables: `GET /` → 307 to `/setup` (correct), but **`/setup` redirects to itself forever** — the checklist bullet asking the page to list every required variable with a red dot and show three 64-character hex values with Copy buttons is therefore BLOCKED, not verified. See BLOCKERS.md.

### Failed or skipped checks (nothing skipped silently)

- **FAILED (page blocked) — @T0: "A production build started with no variables sends `/` to `/setup`, which lists every required variable with a red dot and shows three 64-character hex values with Copy buttons."** The first half holds (`/` → 307 `/setup`); the second half fails: `/setup` returns 307 → `/setup` in an endless loop (curl chain still 307 after 8 redirects; Chromium gives up with `net::ERR_TOO_MANY_REDIRECTS`). Root cause: `isSetupModeExempt` in `web/proxy.ts` exempts `/api/setup*` but not the `/setup` page. Logged in BLOCKERS.md.
- **SKIPPED — @live finish check** ("Finish setup creates the tables and R2 `GetBucketCors` returns the 7.2 rules"): no live Supabase/R2 credentials in the build environment; per SPEC 9.0 this runs after you go live (`npm run e2e:live`).
- **NOTE — `/sw.js` is 404 under `next dev` by design:** Serwist writes `public/sw.js` after `next build` (`serwist.config.mjs`). Verified served without a cookie from a production build (HTTP 200, `application/javascript`). `/manifest.webmanifest` verified in both modes: 200, `display: standalone`, icons 192 / 512 / maskable 512.
- **NOTE — `/api/cron/keepalive` re-verified against a live dev server:** no bearer → 401, wrong bearer → 401, correct bearer → 200.
- **NOTE — dev stand-in robustness (not a check failure):** on a wiped `.data`, the first database contact returns a retryable 200 `ok:false` with a raw `ENOENT … mkdir 'web/.data/pglite'` until some route creates `.data` (the login route does, by persisting `.data/dev-secrets.json`). Unreachable through the UI in development (`/setup` redirects to `/login` there, and login creates the directory first); production uses Postgres and never touches PGlite. No owner action needed.
- **NOTE — accepted deviations, not re-reported as findings:** `vercel.json` lives at `web/vercel.json`; `CRON_SECRET` resolves from `process.env` only; vitest `testTimeout` is 20000; Python 3.12-semantics tested on 3.13.14 (DECISIONS.md); the 2.92 MB test tones are not precached by Serwist.
- **NOTE — iphone playback coverage:** the @T0 `/test-audio` Play-advance and offline-copy behaviors are covered at logic level by `app/test-audio/tones.test.ts` (auto-advance via `nextIndex`; Media Session payload titles "Test tone 1" / "Test tone 2"); the browser-level smoke asserts the gated page and its controls on all three projects.

---

## T0 recheck — setup-page fix verification (BLOCKERS.md entry resolved)

- **Ticket:** T0 (independent checkpoint verifier, recheck round)
- **Date:** 2026-10-10
- **Baseline:** `origin/main` at `542bc87` (PR #2: exempt the `/setup` page from the setup-mode gate), branch `t0/checkpoint-t0-recheck`

### Previously failed check — now PASSING

Production build with zero variables (`npm run build` exit 0, `next start` with no env vars set):

- `GET /` → 307 to `/setup`
- `GET /setup` → **200** (no redirect; the loop is gone)
- The page renders all nine required variables with a red dot and "not set yet" (DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, APP_PASSWORD, SESSION_SECRET, AGENT_TOKEN, CRON_SECRET) plus the two optional variables with amber dots (YOUTUBE_API_KEY, ANTHROPIC_API_KEY)
- "Three fresh secrets for step 5": three 64-character lowercase-hex values (SESSION_SECRET, AGENT_TOKEN, CRON_SECRET), each with a Copy button
- No variable values shown: the only 64-hex strings on the page are the three generated secrets; no "tapedeck-dev" or any other variable value appears
- Verified twice: in the server HTML (curl: 9 red-dot spans, 9 "not set yet", 3 Copy buttons) and in a real Chromium run with 7/7 assertions passing (URL stays on /setup, h1 "Almost ready", 9 red dots, 3 Copy buttons, three 64-hex values, exactly 3 hex strings in the text, no leaks)
- PWA files in the same production build: `/sw.js` → 200 `application/javascript` and `/manifest.webmanifest` → 200, both without a cookie

### Spot re-confirmation suites

| Suite | Command | Passed | Failed | Skipped |
|---|---|---|---|---|
| Unit (vitest, `/web`) | `npx vitest run` | 194 across 14 files (was 193; PR #2 added the no-self-redirect regression case) | 0 | 0 |
| E2E desktop | `npx playwright test --grep @T0` | 3 | 0 | 0 |
| E2E iphone | `npx playwright test --grep @T0` | 3 | 0 | 0 |
| E2E android | `npx playwright test --grep @T0` | 3 | 0 | 0 |
| E2E total | — | 9 | 0 | 0 |
| Agent (pytest, `/agent`) | `python3 -m pytest` | 15 | 0 | 0 |

No new failed or skipped checks in this round. The BLOCKERS.md entry "The setup page never opens on a fresh deployment" is marked resolved 2026-10-10 (fixed by `542bc87`). The @live finish check stays deferred until go-live credentials exist, unchanged from the T0 block above.

---

## T1 checkpoint verification (independent verifier)

- **Ticket:** T1 (independent checkpoint verifier — an agent that did not write T1 code)
- **Date:** 2026-10-10
- **Baseline:** `origin/main` at `d8737b6` (PRs #1–#8 merged: T0 scaffold, T1a downloader/installer, T1b agent API, T1c add pipeline, T1d UI tracer, and the app-relative upload URL fix), branch `t1/checkpoint-t1-verify`

### Environment

- Node v20.20.2 (non-fatal engine warning for the transitive `chalk@6.0.1`, which wants Node 22), Python 3.13.14 (the DECISIONS.md deviation already noted above), ffmpeg absent, no `YOUTUBE_API_KEY` / `ANTHROPIC_API_KEY` (optional services)
- Fresh `npm ci` in `web/`; Playwright Chromium + WebKit with their system dependencies; the agent's virtual environment at `agent/.venv` (pytest, python-dotenv, mutagen)
- Dev HTTPS certificates for the by-hand browser checks (dev server on `:3300` with `--experimental-https` so the Secure session cookie behaves as in production)

### Automated suites

| Suite | Command | Passed | Failed | Skipped |
|---|---|---|---|---|
| Unit (vitest, `/web`) | `npx vitest run` | 356 across 23 files | 0 | 0 |
| E2E desktop | `npm run e2e:t1` (`--grep "@T0\|@T1"`) | 10 | 0 | 2 (iphone-only tags) |
| E2E iphone | `npm run e2e:t1` | 10 | 0 | 2 (the iphone-only tags run in this project) |
| E2E android | `npm run e2e:t1` | 10 | 0 | 2 (iphone-only tags) |
| E2E total | — | 30 | 0 | 6 |
| Agent (pytest, `/agent`) | `agent/.venv/bin/python -m pytest` | 86 | 0 | 1 (ffmpeg conversion, `tests/test_pipeline.py:147`) |

- **Harness note (not a product failure):** the first Playwright run had 1 failed of 12 because the test server spawned the system Python, which lacked `python-dotenv`; rerun with `E2E_PYTHON=agent/.venv/bin/python` — the same interpreter the agent suite uses — passes cleanly. Product code was not involved.
- The single pytest skip is the standing ffmpeg-dependent conversion test (`tests/test_pipeline.py:147`): ffmpeg is not installed in this environment. Same skip as on main before T1.

### SPEC 9 T1 automated checks — verdicts

| # | Check | Verdict |
|---|---|---|
| 1 | Through the UI (`iphone` project), paste `https://youtu.be/jNQXAC9IVRw`: a row appears with "Waiting for your PC" and title/channel from the YouTube fixture | **PASS** — the `t1-add-play` flow adds the fixture link and shows the expected title/channel |
| 2 | Pasting the same link again shows "Already in your library" | **PASS** — in the e2e flow and re-verified by hand through `POST /api/tracks` |
| 3 | `--selftest` on that track: status `ready`, `bytes` and `storage_key` set, stored file exists | **PASS** — selftest uploaded a 2,918,889-byte tagged file; the track reads `ready` over the API and the stored file is present |
| 4 | `GET /api/tracks/:id/url` returns a URL; `Range: bytes=0-1023` → 206 and `audio/mp4` | **PASS** — also verified: ~six-hour validity and the exact 1,024-byte slice |
| 5 | Play in the UI: `currentTime` rises, Media Session title matches | **PASS** — playback advances and the Media Session title is set in the e2e run |
| 6 | Stored file read with mutagen shows the track's title and artist tags | **PASS** — tagger output verified by reading the stored file back |
| 7 | After selftest the header shows "Downloader online"; `agent_last_seen` 3 minutes ago shows "Downloader offline" | **PASS** — online in the e2e run after selftest; offline verified by hand (below) |
| 8 | Atomic claim: two concurrent `POST /api/agent/claim` calls never return the same track | **PASS** — three concurrent claims distributed six waiting tracks with no duplicate IDs |
| 9 | `--probe` result recorded in TEST-REPORT.md (blocked from cloud is fine) | **PASS (recorded)** — see the probe note below |
| 10 | Unit: URL parsing for every format in 8.2 and the rule cleaner pass | **PASS** — parser 17 tests, cleaner 27 tests, inside the 356 |

### By-hand T1 behaviors

**(1) Add via API dedupes against live metadata.** Against a temporary test-mode server with a session cookie: `POST /api/tracks` with the fixture link hit live YouTube oEmbed ("Me at the zoo" / "jawed") and returned `added`; a second POST of the same link returned `already` — "Already in your library".

**(2) Claim → fail → complete ladder and retry from zero.** Three concurrent claims returned six distinct waiting tracks (no duplicates). Driving the failure ladder ended the track `failed`; a retry requeued it with its attempt counter back at zero; upload + completion then made it `ready`.

**(3) Presigned playback URL.** A URL request for a `waiting` track → 409. After the track was `ready`, `GET /api/tracks/:id/url` returned a URL valid for about six hours; `GET` with `Range: bytes=0-1023` → 206 `audio/mp4` carrying the exact requested byte slice.

**(4) Profile setup panel route data.** The profile downloader endpoint returned the expected origin, the agent token, a fresh last-seen value, and the queued-track count.

**(5) Rendered header flips to "Downloader offline" (SPEC 9 T1, item 7, by hand).** Dev server (pglite-file mode, HTTPS, no `TAPEDECK_TEST`): login → `GET /api/library` reports `{"lastSeenAt":null,"waitingCount":0}`. Server stopped; `settings.agent_last_seen` backdated 3 minutes by opening `web/.data/pglite` directly (before: `null`, after: `2026-10-10T06:35:33.405Z`). Restart: the value survives the restart (file-backed persistence) and the reported age is 183 s — past the 120 s online window. A real Chromium session then renders the library header pill **"Downloader offline, last seen 2 minutes ago"** (screenshot verified). Setup for the run: `web/.data/pglite` pre-created because PGlite cannot create the parent directory itself (same ENOENT note as the T0 block).

**(6) `--probe` result (recorded, per item 9).** `python tapedeck.py --probe youtube` for the fixture ID: yt-dlp is **blocked from the cloud by YouTube's bot check** ("Sign in to confirm you're not a bot"). Blocked-from-cloud is explicitly allowed by the SPEC. Environment note: yt-dlp also warns that Deno is unavailable here. `--selftest` (item 3) is the check that exercises the local end-to-end path and passes.

**(7) `@net` coverage note.** No `@net`-tagged e2e test is present on main; the live-oEmbed behavior the checklist parenthetical asks for was verified by hand in (1), where the real YouTube oEmbed request succeeded.

### Failed or skipped checks (nothing skipped silently)

- **SKIPPED — @live finish check** ("Finish setup creates the tables and R2 `GetBucketCors` returns the 7.2 rules"): no live Supabase/R2 credentials in the build environment; per SPEC 9.0 this runs after you go live (`npm run e2e:live`). Logged in BLOCKERS.md with the owner steps.
- **DEFERRED (not a T1 check) — cover-art lookup** (SPEC 8.5): owned by T3; the downloader tags title/artist, and cover art arrives with T3's art fetcher. Logged here so the absence is not silent.
- **NOTE — one mis-targeted check in my own verification script** (not a product failure): a raw test-tone upload that intentionally bypasses the downloader's tagging step of course has no tags; the tag check is only meaningful for downloader-completed tracks, where it passes (item 6).
- **NOTE — no failed checks this round.** The BLOCKERS.md addition below is the standing owner-only @live item, not a new failure; the resolved T0 setup-page entry stays as is.


## T2: Library, playlists, albums, full player (14 Oct 2026)

Run in Claude's cloud workspace. Unit tests run here; e2e runs `desktop` and `android` here, and all three projects (including `iphone`, WebKit) on GitHub's CI for the PR.

**Unit (Vitest):** 609 of 609 pass (42 files). New this ticket: `lib/library.test.ts` (50), `app/lib/library-view.test.ts` (24), `app/lib/api.test.ts` (24), and route tests for like, delete, playlists, playlist tracks, album favourite, plays, profile and the test seed route (52). Queue logic (`lib/player/queue.test.ts`, 31) covers play next, add to queue, shuffle keeps the current song first, repeat off/all/one and previous after 3 seconds restarts. tsc and eslint clean.

**Bug found by the new tests and fixed:** `POST /api/plays` accepted `seconds: null`, `""`, `false` or `[]` as a 0-second play (`Number(null)` is 0). It now answers 400.

**e2e @T2 checks (`web/e2e/t2-library.spec.ts`):**

| # | Check | desktop | android | iphone |
|---|---|---|---|---|
| 1 | Playlist: create, add 3 songs, drag to reorder, reload, order persists | PASS | PASS | CI |
| 2 | Like a song: it is first in Liked songs | PASS | PASS | CI |
| 3 | Same album + album artist show as one album; favouriting moves it first | PASS | PASS | CI |
| 4 | Unit: queue logic | PASS (Vitest) | | |
| 5 | End of a track starts the next and updates Media Session; nexttrack and previoustrack work | skipped (no AAC) | skipped (no AAC) | CI |
| 6 | Reload mid-song: same song, same position within 5 s, paused | skipped (no AAC) | skipped (no AAC) | CI |
| 7 | 30 seconds listened creates one play; profile stats equal the database | skipped (no AAC) | skipped (no AAC) | CI |
| 8 | Delete a song: row gone, stored file gone | PASS | PASS | CI |

Earlier tickets on `desktop` and `android` here: T0, T1 and T3 all pass or skip as before (T1 and T3 UI checks are iphone only). The iphone column is filled from the PR's CI run.

**Screens checked by eye** with made-up songs at desktop (1440x900) and phone (Pixel 7) width: Home, Library tabs, album, playlist with the song menu open, queue, Now playing, search and profile.


## T3 leftovers (14 Oct 2026)

An audit of the 8 T3 checks found four only partly tested and three small bugs. All fixed on branch `t3-leftovers`.

**Unit:** Vitest 660 of 660 (44 files), pytest 125 of 125. New: `app/api/tracks/route.ai.test.ts` (5 music videos with the fixture AI replies store the clean title, artist, `ai_cleaned` and `ai_confidence`; "Me at the zoo" is added with `cover_url` and `album` null and no YouTube thumbnail; a non-music reply at 0.6 uses the AI title and makes no iTunes or Deezer request; the 0.3 "mystery upload" keeps the rule result; SoundCloud fixture gives "Blinding Lights" by "The Weeknd"), the AI system prompt equals the SPEC text exactly, 23 realistic rule cleaner fixtures (was 15), Deezer 600x600 cover, the pasted cover link check, and a SoundCloud `--selftest`.

**e2e:** new `t3-cover-edit.spec.ts` (paste a cover link, Keep leaves it, Remove clears it; refuses a link that is not http(s)) passes on desktop and android here and runs on iphone in CI. `t3-covers-search.spec.ts` now asks for at least 4 of 5 covers (SPEC wording), checks iTunes covers are the 600x600 size, and checks that typing "get lucky" sends no search request until the button is pressed. T0, T1, T2 still pass.

| T3 check | Status |
|---|---|
| Rule cleaner, 15+ fixtures | PASS (23) |
| Matching accepts true matches, rejects 5 near misses | PASS |
| 5 music videos clean with fixture AI replies; `@net` 4 of 5 get a 600x600 cover | PASS (unit); `@net` part in CI |
| Non-music video gets `cover_url = null` | PASS |
| No key uses the rule cleaner; AI used at confidence 0.5 or more | PASS |
| Restore original and Edit details | PASS (cover field added) |
| Search: 10 results, 24 h cache, no-key message | PASS |
| SoundCloud link, `--selftest`, `/sets/` rejected | PASS |


## T4: Offline and Save to Files (14 Oct 2026)

**Unit:** Vitest 667 of 667 (45 files). New: Save to Files builds `<Artist> - <Title>.m4a` as `audio/mp4` and calls `navigator.share` when `canShare` is true (mocked), falls back to the download when it can not share, never shares on a PC, treats closing the sheet as a quiet cancel. Seed route and setup-mode tests updated for the test switch.

**e2e (`web/e2e/t4-offline.spec.ts`)**, offline tests on the production e2e server:

| # | Check | desktop | android | iphone |
|---|---|---|---|---|
| 1 | "Download" on a playlist of 3 ready songs stores 3 blobs and marks each song | PASS | PASS | CI |
| 2 | Offline reload opens from the service worker, library from the snapshot, "Offline" pill shows | PASS | PASS | CI |
| 2b | All 3 songs play offline and auto advance works | skipped (no AAC) | skipped (no AAC) | CI |
| 3 | Offline, songs not downloaded are greyed and not playable | PASS | PASS | CI |
| 4 | A play made offline is kept in IndexedDB and reaches `play_events` once back online | skipped (no AAC) | skipped (no AAC) | CI |
| 5 | Unit: Save to Files File name, type and share | PASS (Vitest) | | |
| 6 | Save to Files on desktop: `Content-Disposition: attachment; filename="<Artist> - <Title>.m4a"` and the browser download name | PASS | | |
| extra | Remove download from the song menu and "Remove all downloads" in the profile | PASS | PASS | CI |

T0 to T3 still pass on desktop and android here.
