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

## Done since 14 Oct
- **T2** merged (PR #14) after Denis approved the screenshots.
- **T3 leftovers** (branch `t3-leftovers`): cover field in Edit details (Keep / Remove / Paste URL), the missing T3 tests, and fixes to the AI confidence gate, Restore original and the title cleaner. See DECISIONS.md for the details.
- **T3 leftovers** merged (PR #15).
- **T4** (branch `t4-offline`): offline on the phone (service worker, library snapshot, downloads with progress, Downloaded tab, offline plays queue) and Save to Files. The offline checks run on a second e2e server that is a real production build (`web/e2e/prod-server.mjs`).
- **T4** merged (PR #16). The downloader now also moves each song's MP4 index to the front so offline copies start playing right away.
- **T6 app side** merged (PR #17): the profile setting and the "Add to Apple Music" song menu item.
- **T5** (branch `t5-polish`): UI review against SPEC 10 with screenshots (`docs/UI-REVIEW.md`), automated UI checks and Lighthouse.
- **T7** merged (PR #20): README, `scripts/check-repo.sh` (also in CI), every en and em dash removed. Downloaded songs now play through the service worker at `/offline-audio/<id>`.
- **T8** (branch `t8-handoff`): `docs/HANDOFF.md`, Denis's one-page guide. After it merges, every ticket T0 to T8 is done; what is left needs Denis (go live, real iPhone checks, `npm run e2e:live`).
- Leftover: a closed probe branch `debug-webkit-blob` on GitHub can be deleted (the build machine is not allowed to delete branches).
- To check after going live: Deezer covers now ask the CDN for the 600x600 size; confirm one Deezer cover loads.
- To check on the real iPhone (T8 list): download a playlist, turn on airplane mode, open the app from the home screen, play; and Save to Files opens the share sheet.

## Left to build after T2 (in this order)
1. Nothing left from the original spec. Next: go live with Denis (below).

## v2 (started 15 Oct 2026)
New features (trim, catalog search, best-copy finder, playlist import, speed and pitch) are planned as tickets T9 to T14 in [V2-PLAN.md](V2-PLAN.md). Read it before starting any of them; it has the order, the parallel waves and the rules for running several sessions at once.

Status (each ticket replaces only its own line):
- T9 Foundation: done (branch `t9-foundation`). Migration runner (`web/lib/migrations.ts`, files in `supabase/migrations`, `npm run gen:migrations` after adding one), v2 columns, v2 fields in the library payload and the agent contract, `E2E_PORT` / `E2E_PROD_PORT`, `e2e:t9` to `e2e:t14`.
- T10 Trim: done (branch `t10-trim`). PC suggests a trim (`agent/trim.py`: SponsorBlock plus silence), the player plays only the trimmed part (`web/lib/player/trim.ts`), Edit details has a trim editor (`TrimEditor.tsx`), `PATCH /api/tracks/:id` takes `trimStartSec` / `trimEndSec`, e2e `@T10`.
- T11 Catalog search: done (branch `t11-catalog`). Catalog adapter `web/lib/catalog.ts` (Deezer, iTunes fallback, fixture stand-in, 24 h `catalog:` cache), `/api/catalog/search`, `/album/:id`, `/artist/:id` with In library flags, Search tabs (Top, Songs, Artists, Albums, YouTube), `/catalog/artist` and `/catalog/album` pages, `POST /api/tracks { catalog }` (max 50) in `web/lib/catalog-add.ts`, label "Waiting for your PC to find it". No previews, no migration.
- T12 Best-copy finder: done (branch `t12-finder`). `agent/finder.py` finds the best free copy of catalog songs (YouTube Music, then SoundCloud, then YouTube) on the PC; the downloader claims catalog rows, sends `resolvedUrl` and `matchInfo`; "Pick another version" in the song menu (`POST /api/tracks/:id/pick`). Fixtures: 14 real songs in `agent/tests/fixtures/finder`.
- T13 Playlist import: core done (branch `t13-import`). Migration `t13_import.sql` (`import_jobs`, `import_items`), importer interface and registry in `web/lib/importers/` (stand-in `fake.ts`; five adapter stubs, hidden until built), `/api/import/*` routes (jobs, list, start, chunks of 50, Skip, log-in callback), catalog matching (ISRC, then artist + title within 5 s) in `web/lib/import-match.ts`, `/import` page, Import tab in the Add window, "Bring your music" on Home, e2e `@T13`. Adapters not started: MusicAPI login, Spotify link, Apple Music link, PC listing, File upload.
- T14 Speed and pitch: done (branch `t14-speed`). Speed 0.5x to 1.5x and "Keep original pitch" per song (`web/lib/player/speed.ts`), set on the audio element at every track start and reset for the next song; Speed section in Edit details (`SpeedEditor.tsx`), "1.25x" chip on Now Playing and speed text in song lists (`SpeedChip.tsx`); `PATCH /api/tracks/:id` takes `playbackRate` / `preservePitch` (`app/api/tracks/[id]/speed.ts`); player clocks divide by the speed; e2e `@T14`. No migration (T9 columns).

## Then go live (I do this with help)
1. Set up Supabase and Cloudflare R2.
2. Create a new Vercel project with Root Directory `web`.
3. Fill in the env vars.
4. Press "Finish setup" in the app.
5. Run `npm run e2e:live` to test the real services.
6. Optional, the "Log in" import through MusicAPI.com (T13). Without it the import still works by pasting links. Cost first: their sandbox is free, but real use bills at least 500 EUR a month, so only do this if the sandbox lets you log in with your own account.
   1. Go to https://app.musicapi.com/admin and make a free developer account. Business name: Tapedeck. Add a logo (the music services show both on the log-in screen).
   2. Under Integrations, turn on the services you use (Spotify, Apple Music, YouTube Music, Tidal, Deezer) and press "Test" on one to see it work.
   3. Add this return URL to the allowed list: `https://<your app address>/api/import/callback/musicapi`.
   4. Copy the Client ID, the Client Secret and your account slug (the short name in your log-in link, `app.musicapi.com/integrations/<slug>`).
   5. In Vercel, Settings, Environment Variables, add `MUSICAPI_CLIENT_ID`, `MUSICAPI_CLIENT_SECRET` and `MUSICAPI_SLUG`, then redeploy. A "Log in to Spotify" button (and one for each other service) appears under Add, Import.

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
