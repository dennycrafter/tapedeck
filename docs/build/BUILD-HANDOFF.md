# Tapedeck Handoff

Updated 12 Oct 2026, 5 pm. Pick up from here.

## What it is
My personal Spotify replacement. Paste a YouTube or SoundCloud link (or search YouTube). The title, artist and cover get cleaned up, and the song lands in the library as "Waiting". A Python downloader on my Windows PC grabs the audio with yt-dlp and uploads it to Cloudflare R2. Then it plays on my iPhone (home screen app) and in PC Chrome.

- Repo: `github.com/dennycrafter/tapedeck`
- Full spec: `SPEC.md` in the repo. Read it before working and don't edit it.
- Originally built with Obvious. Continued in Claude from 12 Oct.

## Done (merged to main)
- **T0:** scaffold, password screen, setup page, keepalive cron.
- **T1:** the core loop works end to end: paste link, queue, PC downloader, playback. Fully verified.
- **Most of T3:** AI title cleanup, cover art, edit/restore, YouTube search, SoundCloud links.
- **Downloader half of T6:** copies finished songs into Apple Music's auto-add folder.

## Waiting for me to merge
- **PR #12** (`fix/layout-props-and-ci`): fixes the `LayoutProps` type error, fixes a flaky library test, and adds a CI check on GitHub. CI is fully green (all 3 Playwright projects, including iPhone). Claude was not allowed to merge it by itself. To merge: open github.com/dennycrafter/tapedeck/pull/12, press "Squash and merge", then "Confirm".

## In progress: T2 (branch `t2-library-player`, pushed, NOT merged)
Built and unit tested (459 of 459 unit tests pass, tsc and lint clean):
- `web/lib/player/queue.ts`: play next, add to queue, shuffle (current song stays first), repeat off/all/one, previous after 3 s restarts, remove, drag reorder. 31 tests.
- `web/lib/player/store.ts`: player now uses the queue, remembers shuffle/repeat/volume, counts a play after 30 s or when the song ends, can drop a deleted song, refreshes queued songs after edits.
- `web/lib/library.ts`: data layer for likes, delete song (file then row), playlists (create, rename, delete, add, remove, reorder), favourite albums, plays, profile stats (Chicago month), top 5 artists, display name.
- API routes: `/api/library` (full snapshot: tracks, playlists, favourite albums, recently played, display name), `/api/tracks/[id]/like`, `DELETE /api/tracks/[id]`, `/api/playlists`, `/api/playlists/[id]`, `/api/playlists/[id]/tracks`, `/api/playlists/[id]/tracks/[trackId]`, `/api/albums/favorite`, `/api/plays`, `/api/profile`.
- `/api/test/seed`: test-only route (404 unless `TAPEDECK_TEST=1` and not production) to create made-up songs and read raw DB counts for e2e.
- Installed `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.

Still to do for T2:
1. Unit tests for `web/lib/library.ts` and the new routes (PGlite, like `app/api/library/route.test.ts`).
2. Update `web/app/lib/api.ts` types and clients for the new routes.
3. UI: a LibraryProvider (load + poll `/api/library`), Home at `/` (greeting, status line, recently played, favourite albums, playlists, recently added as track rows), `/library` tabs (songs with sort, liked, playlists, albums, artists, recently played), playlist page with dnd-kit reorder, album page (favourite heart, play, shuffle), artist page, `/search` page, song "..." menu, desktop sidebar, phone tab bar (Home, Search, Library, Add), full player bar (prev/next, shuffle, repeat, volume on desktop, queue), Now playing sheet and queue view, keyboard shortcuts, profile stats and editable name.
4. e2e `web/e2e/t2-library.spec.ts` for the 8 T2 checks. Keep T1 and T3 working: `/` must still show `library-empty`, `track-row`, `downloader-status` and `add-open`. Every T2 test must clean up its songs, playlists and favourites, because all three projects share one in-memory database and T1 (iPhone) expects an empty library.
5. Make seeded songs ready through the agent API (upload-url, PUT a test tone, complete), not `--selftest`, to avoid the claim race noted in the T3 spec.
6. Log the seed route and agent-API readiness in `docs/DECISIONS.md`, append results to `docs/TEST-REPORT.md`, PR, merge when CI is green.

## Left to build after T2 (in this order)
1. **T3 leftovers:** Edit details still has no cover field (keep / remove / paste URL); check the rest of the T3 checklist.
2. **T4:** offline on the phone, plus Save to Files.
3. **T6 app side:** the Apple Music setting and the "Add to Apple Music" song menu item.
4. **T5:** UI polish against the SPEC section 10 design rules, with screenshots.
5. **T7:** README, plus the repo hygiene check script. Note: older docs (DECISIONS, TEST-REPORT, BLOCKERS) written by Obvious contain em dashes, and the T7 check fails on them. Clean them up then.
6. **T8:** `docs/HANDOFF.md` with my steps.

## Then go live (I do this with help)
1. Set up Supabase and Cloudflare R2.
2. Create a new Vercel project with Root Directory `web`.
3. Fill in the env vars.
4. Press "Finish setup" in the app.
5. Run `npm run e2e:live` to test the real services.

## How to work
- Do one ticket at a time: branch, build, test, PR, then merge when CI is green.
- CI (`.github/workflows/ci.yml`) runs tsc, eslint, Vitest, pytest and Playwright on desktop, iphone and android for every PR. Trust it for the iPhone checks.
- Claude's cloud workspace cannot download Playwright's WebKit, so the iphone project only runs on CI. Locally it can run desktop and android by linking the preinstalled Chromium in `/opt/pw-browsers` into the folder names Playwright 1.64 expects (`chromium-1248/chrome-linux64`, `chromium_headless_shell-1248/chrome-headless-shell-linux64` with a `chrome-headless-shell` link to `headless_shell`).
- Each ticket runs its own tests plus all earlier ones. Tests are Vitest in `web/`, pytest in `agent/` (use `agent/.venv`), and Playwright e2e tagged `@T0` to `@T8`.
- The e2e server makes real network calls (MSW is only used inside unit tests), and all three projects share one in-memory database, run in order desktop, iphone, android.
- Log decisions in `docs/DECISIONS.md` and anything stuck in `docs/BLOCKERS.md`. Never fake a pass.
- Everything runs with stand-ins (no accounts needed). The dev password is `tapedeck-dev`.
- Never run yt-dlp in the cloud. YouTube blocks it, so downloading only happens on my PC.
- Anything that needs my phone or PC goes at the end as short numbered steps.
- No em dashes anywhere.
