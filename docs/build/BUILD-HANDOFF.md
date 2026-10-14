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
- Leftover: a closed probe branch `debug-webkit-blob` on GitHub can be deleted (the build machine is not allowed to delete branches).
- To check after going live: Deezer covers now ask the CDN for the 600x600 size; confirm one Deezer cover loads.
- To check on the real iPhone (T8 list): download a playlist, turn on airplane mode, open the app from the home screen, play; and Save to Files opens the share sheet.

## Left to build after T2 (in this order)
1. **T7:** README, plus the repo hygiene check script. Note: older docs (DECISIONS, TEST-REPORT, BLOCKERS) written by Obvious contain em dashes, and the T7 check fails on them. Clean them up then.
2. **T8:** `docs/HANDOFF.md` with my steps.

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
