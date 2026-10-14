# Tapedeck Handoff

Updated 14 Oct 2026. Pick up from here.

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
- **PR #12:** fixed the `LayoutProps` type error, fixed a flaky library test, added the GitHub CI check.
- **PR #13 (T2 checkpoint, first half of T2):** see below. CI fully green before merge.

## Commits
- Always author commits as `dennycrafter <dennycrafter@gmail.com>` (`git config user.name dennycrafter` and `git config user.email dennycrafter@gmail.com` in the repo). Squash merges on GitHub show as Denis Popov.

## T2: built, in PR from `t2-ui` (waiting for Denis to look at screenshots)
Rule for UI work: Denis decides by seeing it. Send desktop and phone screenshots with made-up data, merge only after he says "ship it".

What T2 added on top of PR #13:
- Screens: Home (`/`: greeting, downloader status, Recently played, Favourite albums, Your playlists, Recently added), `/library` tabs (Songs with remembered sort, Liked songs, Playlists, Albums, Artists, Recently played), `/playlist?id=` (drag to reorder, rename, delete), `/album?name=&artist=` (favourite heart, Play, Shuffle), `/artist?name=`, `/search` (library filter plus YouTube search), profile stats strip and top 5 artists with editable name.
- Song "..." menu, desktop sidebar, phone tab bar (Home, Search, Library, Add), full player bar (shuffle, previous, play, next, repeat, progress, queue, volume on desktop only), Now playing sheet (swipe down closes), queue panel with drag reorder, keyboard shortcuts (Space, Shift+Left/Right, `/`).
- `LibraryProvider` loads and polls `/api/library` and gives every screen the albums, artists, playlists and liked songs (pure helpers in `web/app/lib/library-view.ts`).
- Saira is self-hosted via `@fontsource/saira`.
- Tests: 609 unit tests; `web/e2e/t2-library.spec.ts` has the T2 checks. Playback checks are iphone only (Chromium in Playwright has no AAC).
- Fixed: `POST /api/plays` no longer accepts null or empty `seconds`.
- Not in T2 (later tickets): the "Downloaded" sidebar item and Download / Save to Files menu items (T4), Add to Apple Music (T6), cover field in Edit details (T3 leftover).

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
