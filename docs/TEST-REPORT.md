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
