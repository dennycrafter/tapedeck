# Tapedeck v2: build plan

Written 15 Oct 2026. This is the build doc for the next round of features (tickets T9 to T14). `SPEC.md` still describes everything that exists and stays unedited; this file adds to it. Where they disagree for the new features, this file wins.

## What Denis asked for

1. **Trim songs.** YouTube uploads often have noise, talking or silence at the start and end. Cut it, automatically where possible, by hand where not.
2. **Import playlists from Spotify, Apple Music, SoundCloud and YouTube** so switching to Tapedeck is easy for him and for a few friends. He wants a checklist of all his playlists to tick, not pasting links one by one.
3. **Search like a real streaming app.** Artists, their albums, full tracklists, from a free catalog. Pressing "Add" makes the PC find the best free copy of that exact song.
4. **Speed and pitch per song**, borrowed from the [untitled] app (sped up / slowed versions).

## Decisions already made (do not reopen)

- **Who uses it:** Denis plus a few friends. Each friend runs **their own copy** (own Vercel, Supabase, R2 and PC downloader). Tapedeck stays single owner per copy. No shared multi-user server: hosting downloaded songs for other people is a copyright risk (see DECISIONS.md, v2 entries).
- **Trim is non-destructive.** The stored file is never cut. The app stores start and end points and the player honors them. Undo is always possible.
- **Catalog:** Deezer's free public API (no key) for search, artists, albums and tracklists. iTunes Search API as the fallback. Never use Spotify's API for search (search is capped at 10 results and needs Premium since Feb 2026).
- **Finding the audio:** done on the PC (YouTube blocks cloud servers, SPEC 3). Order: YouTube Music official audio, then SoundCloud, then regular YouTube. Never use tools that strip DRM from Deezer, Tidal, Spotify or Apple Music streams.
- **Import gets two ways in:** (a) a login button through MusicAPI.com (one login for Spotify, Apple Music, YouTube Music, Tidal, Deezer and more), and (b) paste-a-link (profile or playlist) that needs no login. A file upload (Exportify CSV, Apple Music Library.xml) is a low-priority third way.
- **Speed/pitch:** speed slider plus a "Keep original pitch" switch, using the audio element's `playbackRate` and `preservesPitch`. Pitch shift without changing speed is out of scope: it needs Web Audio, which stops when the iPhone locks.

## Order and parallel waves

```
Wave 0 (one session):     T9  Foundation
Wave 1 (three in parallel): T10 Trim | T11 Catalog search | T12 Best-copy finder
Wave 2 (two in parallel):   T13 Playlist import | T14 Speed and pitch
Later (not scheduled):      T15 One-click "make your own copy" for friends; stem splitting
```

T9 must merge before wave 1 starts. Wave 2 starts when T10, T11 and T12 have merged (T13 reuses the T11 catalog and the T12 finder; T14 shares the player and Edit details with T10).

## Rules for parallel work (every ticket)

1. **Own worktree, own branch, from fresh main.** Example for T10: `git fetch origin` then `git worktree add ../tapedeck-t10 -b t10-trim origin/main`. Run `npm ci` in that worktree's `web/` and set up `agent/.venv` there.
2. **Own e2e ports** (T9 makes them configurable): set `E2E_PORT` and `E2E_PROD_PORT` before running Playwright.

   | Ticket | E2E_PORT | E2E_PROD_PORT |
   |---|---|---|
   | T9 | 3100 | 3102 (defaults) |
   | T10 | 3110 | 3112 |
   | T11 | 3120 | 3122 |
   | T12 | 3130 | 3132 |
   | T13 | 3140 | 3142 |
   | T14 | 3150 | 3152 |
3. **Database changes only through your own migration file**, `supabase/migrations/tNN_<name>.sql` (T9 builds the runner). Never edit `supabase/schema.sql` or `SPEC.md`.
4. **New code goes in new files.** Touch the shared hot spots with the smallest hook you can: `agent/downloader.py`, `web/app/components/PlayerProvider.tsx`, `web/app/components/TrackEditDialog.tsx`, `web/app/api/tracks/route.ts`, `web/app/api/agent/*`.
5. **Docs without conflicts:** add decisions only under your own `### TNN` heading in `docs/DECISIONS.md` (newest first, format `- 2026-10-DD (T10): what. Reason: why.`), and replace only your own status line in the v2 section of `docs/build/BUILD-HANDOFF.md`. Add your Denis checks to the handoff list at the end of this file by editing only your ticket's line.
6. **Tests:** Vitest for web logic, pytest (fixtures only) for the downloader, Playwright tagged `@T9` to `@T14`. Add an `e2e:tNN` npm script like the existing ones. Never call YouTube, SoundCloud or yt-dlp from tests or CI: record real responses once into fixture files. Deezer, iTunes, Spotify and Apple pages are also fixtures in tests (the stand-in pattern, SPEC 4.1).
7. **Before the PR:** `git fetch origin && git rebase origin/main`, then run `bash scripts/check-repo.sh`, `npx tsc --noEmit`, `npx eslint`, `npx vitest run`, `python -m pytest -q` (in `agent/`), and your e2e script plus all earlier ones. One PR per ticket. Squash merge only when CI is green.
8. **Commits** are authored `dennycrafter <dennycrafter@gmail.com>`.
9. **No en or em dashes** anywhere (check-repo.sh fails on them).
10. **Never fake a pass.** Stuck items go in `docs/BLOCKERS.md`. Anything that needs Denis's iPhone or PC goes at the end of the PR description as short numbered steps.
11. Read `web/AGENTS.md` before writing Next.js code: this Next version differs from what you know.

---

## T9: Foundation (wave 0)

Small, mechanical, unblocks everything else. Target: one short PR.

1. **Migration runner.** Files in `supabase/migrations/*.sql`, applied in filename order, each once, recorded in a new table `schema_migrations (name text primary key, applied_at timestamptz not null default now())`. Each file runs in a transaction. Run pending migrations: after `schema.sql` in Finish setup, in the PGlite stand-in at startup, and lazily once per server instance on the real database (first DB use; a module-level promise so it runs once). Unit tests against PGlite: fresh DB, already-migrated DB, a failing migration rolls back and is not recorded.
2. **Migration `t09_v2_foundation.sql`** (columns the wave 1 and 2 tickets need):
   - `tracks.source` check gets `'catalog'` added (keep `youtube`, `soundcloud`). Catalog tracks: `source = 'catalog'`, `source_id` = catalog id like `deezer:3135556` (or `import:spotify:<id>` for imported songs with no catalog match), `source_url = ''` until the PC picks a copy.
   - `tracks.isrc text`, `tracks.resolved_url text` (the copy the PC actually downloaded), `tracks.match_info jsonb` (chosen candidate, score, up to 5 alternatives).
   - `tracks.auto_trim_start_sec numeric`, `tracks.auto_trim_end_sec numeric` (suggested by the PC), `tracks.trim_start_sec numeric`, `tracks.trim_end_sec numeric` (set by hand; null means use the auto value). Effective start = `coalesce(trim_start_sec, auto_trim_start_sec, 0)`, effective end = `coalesce(trim_end_sec, auto_trim_end_sec, duration_sec)`.
   - `tracks.playback_rate numeric not null default 1` (check between 0.5 and 1.5), `tracks.preserve_pitch boolean not null default true`.
3. **Shared types and DTOs:** add the new fields to `TrackDto`, the library payload and the offline snapshot, with camelCase names (`trimStartSec`, `autoTrimStartSec`, `playbackRate`, `preservePitch`, `isrc`, `matchInfo`, ...). Offline snapshots saved before v2 must still load (missing fields mean defaults).
4. **Downloader contract (server side only):**
   - `POST /api/agent/claim` accepts an optional body `{ capabilities: string[] }`. Rows with `source = 'catalog'` are only handed to an agent that sends `"catalog"`. Older downloaders keep working and simply never get catalog rows.
   - Claimed rows also return `isrc`, `catalog_id` (= `source_id` for catalog rows) and `duration_sec`.
   - `POST /api/agent/complete` accepts optional `resolvedUrl`, `matchInfo`, `autoTrimStartSec`, `autoTrimEndSec` and stores them (validate: numbers within the real duration, URL is http(s), matchInfo under 8 KB).
   - `POST /api/agent/fail` accepts optional `matchInfo` (so "no good match" can still save the alternatives).
   - Update `agent/tests/test_contract.py` and the web agent API tests.
5. **E2E ports from env:** `web/e2e/helpers/env.ts` reads `E2E_PORT` and `E2E_PROD_PORT` (defaults 3100 and 3102), and the prod-server build dir includes the port (for example `.next-e2e-3102`) so two worktrees never share a build folder. Check nothing else hardcodes 3100 or 3102.
6. **npm scripts** `e2e:t9` to `e2e:t14`, each running its own tag plus every earlier tag (same pattern as `e2e:t8`).
7. Done when: all existing tests still pass, new tests pass, CI green, merged.

---

## T10: Trim (wave 1)

**Downloader, new module `agent/trim.py`**, hooked into the pipeline after convert and faststart, before upload. The audio file is not changed.
1. **SponsorBlock** (YouTube sources and catalog tracks whose chosen copy is YouTube): `GET https://sponsor.ajay.app/api/skipSegments?videoID=<id>&categories=["music_offtopic"]`. 404 means no segments. Only a segment that starts within 1 second of 0 becomes a start trim, and only one that ends within 1 second of the end becomes an end trim. Segments in the middle are ignored for now (log a DECISIONS line). Network errors: skip quietly, log.
2. **Silence:** `ffmpeg -i file -af silencedetect=noise=-50dB:d=0.5 -f null -` and parse `silence_start` / `silence_end` from stderr. Leading silence from 0 gives a start trim; a silence that runs to the end gives an end trim. Keep 0.3 s of margin on each side.
3. **Combine:** start = the larger of the two start suggestions, end = the smaller end suggestion. Throw the whole suggestion away if it would leave less than 60% of the song or less than 30 seconds. Round to 0.1 s.
4. Send them as `autoTrimStartSec` / `autoTrimEndSec` on `complete`. Without ffmpeg, skip silence detection (same as faststart today).
5. pytest with recorded silencedetect stderr samples and recorded SponsorBlock JSON. No network in tests.

**Player** (`PlayerProvider.tsx` hook plus a new `web/lib/player/trim.ts` for the math):
1. On track start, seek to the effective start before playing (for blobs and presigned URLs alike).
2. When `currentTime >= effective end`, treat it exactly like `ended` (same synchronous next-track rule as SPEC 8.8, prefetch included). Repeat one restarts at the trim start.
3. The scrubber, elapsed and total times, Media Session `setPositionState` and `seekto` all use the trimmed range (0 to end minus start). Seeks outside the range are clamped.
4. The 30 second play rule counts listened seconds, unchanged.

**Edit details** (new component `TrimEditor.tsx`, mounted in `TrackEditDialog.tsx`; ready songs only):
1. A bar the length of the song with two drag handles (touch friendly, 44 px targets) and mm:ss.s fields under it for precision.
2. "Play from start" (plays from the start handle) and "Hear the ending" (plays the last 5 s before the end handle), through the main player. Restore the previous player state after preview if it is simple to do; otherwise log the decision.
3. "Reset to automatic" clears the manual values. "Don't trim" sets start 0 and end = duration.
4. Show "Trimmed automatically" or "Trimmed" with the cut amounts so Denis can see what happened.
5. `PATCH /api/tracks/:id` accepts `trimStartSec` and `trimEndSec` (numbers or null). Validate 0 <= start < end <= duration and end minus start >= 10 s.
6. A small waveform is a nice extra, not required. If added, compute it on the PC instead of decoding audio on the iPhone (memory).

**E2E `@T10`:** set a trim in Edit details, play, check the position starts at the trim start and the next song starts at the trim end (iphone project, as with the other playback checks). Plus the reset and validation messages.

---

## T11: Catalog search (wave 1)

1. **Adapter `web/lib/catalog.ts`** with one interface and two implementations plus a stand-in:
   - `searchTracks(q)`, `searchAlbums(q)`, `searchArtists(q)`, `getAlbum(id)` (with the full tracklist), `getArtist(id)` (top tracks and albums).
   - Deezer: `https://api.deezer.com/search`, `/search/album`, `/search/artist`, `/album/:id`, `/artist/:id`, `/artist/:id/top`, `/artist/:id/albums`, `/track/:id` (has `isrc`). No key. Covers use the 600x600 CDN size (same rule as T3).
   - iTunes Search API as the fallback when Deezer errors or times out (3 s).
   - Stand-in with fixture JSON for tests and for offline dev (SPEC 4.1 pattern).
   - Cache responses in `search_cache` with keys prefixed `catalog:` for 24 hours.
2. **Routes** (session gated like all of `/api`): `GET /api/catalog/search?q=&type=all|tracks|albums|artists`, `GET /api/catalog/album/:id`, `GET /api/catalog/artist/:id`. Each result carries an `inLibrary` flag (same catalog id or ISRC already in `tracks`, or the same normalised title and artist from the SPEC 8.5 rules).
3. **Search page:** typing searches the catalog (debounced 300 ms, it is free) and still filters your own library on top. Result tabs: Top, Songs, Artists, Albums. The old YouTube search stays as a "YouTube" tab for remixes, live versions and anything not in the catalog (still Enter or button only, quota note kept).
4. **Catalog artist page** (`/catalog/artist?id=`) and **catalog album page** (`/catalog/album?id=`): cover, name, tracklist with durations, "Add" per song, "Add album" for all songs not yet in the library. Existing library album and artist pages are unchanged.
5. **Adding:** `POST /api/tracks` accepts `{ catalog: CatalogTrack[] }` (max 50 per request) next to the existing `{ urls }`. Each becomes a row with `source = 'catalog'`, `status = 'waiting'`, clean `title`, `artist`, `album`, `album_artist`, `cover_url`, `duration_sec`, `isrc` straight from the catalog. No AI cleanup and no cover lookup (the data is already clean); `raw_title` and `raw_artist` copy the catalog values. "Already in your library" rules as in SPEC 8.2.
6. Until T12 merges, catalog songs simply wait (old downloaders never claim them, T9). The waiting label for catalog songs: "Waiting for your PC to find it".
7. Previews (30 s clips) are optional. If built, they must pause the main player and not create a second always-mounted audio element (SPEC 8.8); log the approach.
8. **E2E `@T11`:** search (fixtures), open an artist, open an album, Add one song, Add album, "In library" flags, YouTube tab still works.

---

## T12: Best-copy finder (wave 1)

**Downloader, new module `agent/finder.py`**, used when a claimed row has `source = 'catalog'`, or a `retry` asks for a new pick. The downloader now sends `capabilities: ["catalog"]` on claim.
1. **Candidates** (stop early once one scores very high):
   1. YouTube Music songs search with `ytmusicapi` (unauthenticated, `filter="songs"`): official album audio ("Topic" uploads).
   2. SoundCloud: `yt-dlp "scsearch5:<artist> <title>" --flat-playlist -J`.
   3. YouTube: `yt-dlp "ytsearch10:<artist> - <title>" --flat-playlist -J`.
   If `ytmusicapi` errors, fall back to the YouTube search and log it. Add `ytmusicapi` to `agent/requirements.txt`.
2. **Score** each candidate (port the SPEC 8.5 normalise rules to Python):
   - Hard reject when the length is off by more than max(5 s, 3%) of the catalog length.
   - Title and artist match (token overlap), bonus for "Topic" or the artist's own channel, bonus when the ISRC appears in the description.
   - Penalty for live, remix, cover, karaoke, instrumental, sped up, slowed, nightcore, 8D, reverb, extended, lyrics, unless the catalog title has that word too.
   - Source bonus: YouTube Music > SoundCloud > YouTube.
   - Tie break on audio bitrate from `yt-dlp -J` of the top 2 only (keeps it fast).
3. Download the winner with the existing pipeline (the SoundCloud DRM fallback still applies). On `complete` send `resolvedUrl` and `matchInfo` (chosen, score, top 5 alternatives with title, uploader, length, url, score).
4. Nothing above the threshold: `fail` with "Couldn't find a matching version" and send `matchInfo` with the alternatives.
5. **"Pick another version"** (small web part): song menu item for catalog songs. Shows the saved alternatives (title, uploader, length, source) plus "Search again". Picking one sets `resolved_url`, sets `status = 'waiting'`, and the downloader downloads exactly that URL (claim returns `resolved_url`; the finder skips searching when it is set and the row was re-queued by a pick). Route: `POST /api/tracks/:id/pick { url }` (url must be one of the saved alternatives or a YouTube/SoundCloud link that parses with `parse-source-url`).
6. pytest with recorded `ytmusicapi` and `yt-dlp -J` outputs for at least 10 real songs, including traps: a live version longer than the album version, a sped-up edit, a lyric video with a 20 s intro, a song only on SoundCloud. Never search for real in tests.
7. **E2E `@T12`:** a catalog song completed through the agent API with matchInfo shows as ready; "Pick another version" lists alternatives and re-queues.

---

## T13: Playlist import (wave 2)

**Flow** (new "Import" tab in the Add window, and a "Bring your music" card on Home while the library is empty):
1. Pick a service: Spotify, Apple Music, YouTube Music, SoundCloud, YouTube, Tidal, Deezer (the list depends on what is configured).
2. Connect: "Log in" (MusicAPI, when configured) or "Paste a link" (profile or playlist links, several allowed, one per line).
3. **Checklist** of every playlist found: cover, name, song count, Select all, plus "Liked songs" when the source has it. Already imported playlists are marked.
4. Import: each ticked playlist becomes a Tapedeck playlist with the same name and order. Each song becomes a catalog row (T11 shape). Songs from SoundCloud or YouTube sources keep their direct link (`source = 'soundcloud' | 'youtube'`, the normal pipeline).
5. **Progress screen:** "142 of 150 ready, 6 waiting, 2 need a look", live from the database. "Need a look" opens "Pick another version" (T12) or "Skip".

**Matching to the catalog** (enrichment for cover and album, best effort): ISRC first (`https://api.deezer.com/track/isrc:<ISRC>`), otherwise Deezer search by artist + title with the length within 5 s. No match: still import as `source_id = import:<service>:<id>` with the source's own metadata. The PC finder (T12) works from title, artist and length either way.

**Adapters** (`web/lib/importers/<name>.ts`, one interface: `listPlaylists(input)` and `getTracks(playlistRef)`; each one independent, ideal for parallel subagents once the core lands):
1. **MusicAPI.com login** (`musicapi.ts`). First read their docs and pricing, then log in DECISIONS what the free or sandbox tier allows. OAuth through their unified flow; env vars `MUSICAPI_CLIENT_ID` and `MUSICAPI_CLIENT_SECRET` (optional; the login button hides when unset; add them to `.env.example` and the HANDOFF go-live steps as optional). Store their user id per import job only. Stand-in provider for tests.
2. **Spotify link** (`spotify-link.ts`): profile link lists the public playlists; playlist link gives the tracks. Read Spotify's public web or embed pages server side (unofficial, so isolate it in this file, keep fixtures, and show "Spotify changed something, try the login option" when parsing fails). Public playlists only; say so in the UI.
3. **Apple Music link** (`apple-link.ts`): shared playlist links (`music.apple.com/.../playlist/...`) from the public page. Profiles cannot be listed: the UI asks for playlist links, several at once.
4. **SoundCloud and YouTube links** (`pc-listing.ts`): listing needs yt-dlp, so it runs on the PC. The web app creates an import job, the downloader claims it (new capability `"import-listing"`, endpoints `POST /api/agent/import/claim` and `POST /api/agent/import/complete`), runs `yt-dlp --flat-playlist -J <url>` on the profile's playlists or likes, and sends back the list. The UI shows "Waiting for your PC" until then.
5. **File upload** (`file-import.ts`, low priority, last): Exportify CSV or zip, Apple Music `Library.xml`, TuneMyMusic CSV.

**Database:** `supabase/migrations/t13_import.sql` with `import_jobs` (id, service, method, status, error, created_at, payload jsonb) and `import_items` (job_id, playlist_name, position, title, artist, album, duration_sec, isrc, source_ref, status, track_id). Write in chunks of 50 so each request stays well inside Vercel's function time limit (the browser drives the chunks).

**E2E `@T13`:** with stand-ins: login flow (fake provider), paste a Spotify link (fixture), checklist, import two playlists, progress screen, a "need a look" song resolved with Pick another version.

---

## T14: Speed and pitch (wave 2)

1. Per song: **Speed** 0.5x to 1.5x in 0.05 steps, presets "Slowed" (0.85x), "Normal", "Sped up" (1.25x), and a **"Keep original pitch"** switch (on = same pitch, off = the classic sped up / slowed sound). Stored in `playback_rate` and `preserve_pitch` (T9). `PATCH /api/tracks/:id` accepts both.
2. Player: on every track start set `audio.playbackRate`, `audio.preservesPitch` and `audio.webkitPreservesPitch` (where present) from the song. Reset for the next song. Media Session `playbackRate` in `setPositionState`. Shown durations divide by the speed. Trim (T10) is in media time and needs no change.
3. UI: a "Speed" section in Edit details, and a small "1.25x" chip on Now Playing that opens the presets. A song with a non-normal speed shows the chip in lists.
4. Check in WebKit on CI whether `preservesPitch = false` and `playbackRate` survive a track change; add a real-iPhone check to the handoff list: speed and pitch stay right with the screen locked.
5. **E2E `@T14`:** set Sped up with pitch off, play, check `playbackRate` and `preservesPitch` on the audio element, next song plays at 1x.

---

## Later (not scheduled)

- **T15 Make your own copy (for friends):** a "Deploy to Vercel" button in the README, a guided first-run wizard that creates the Supabase and R2 pieces with as few copy-paste steps as possible, and a friend-friendly installer for the PC downloader.
- **Stem splitting** (the other [untitled] feature): heavy (needs a model on the PC). Revisit after T15.

## Handoff list for Denis (fill in as tickets merge)

Things only Denis can check, numbered, added by each ticket's PR:

1. (T10) On the PC: restart the downloader, add a YouTube music video that has a talking intro; after it is ready, check it starts at the music and its Edit details says "Trimmed automatically". On the iPhone: play a trimmed song with the phone locked and check the next song starts when the trimmed part ends.
2. (T11) After going live, on the iPhone: search an artist, open one of their albums, check the covers load, press Add album, check the songs show "Waiting for your PC to find it".
2. (T12) On the PC: run `agent\install.bat` again (or `py -3.12 -m pip install -r requirements.txt` in `agent`) so `ytmusicapi` is installed. Add a song from catalog search; check the version it picked is the album version (song menu, Pick another version shows it as Current). Then pick another version and check the PC downloads that one.
3. (T13 core) After going live, on the iPhone: press Add and check the window has two tabs, "Paste links" and "Import", and that pasting a link still adds the song. Until the first import adapter is merged, the Import tab says "No imports are set up yet." and Home shows no "Bring your music" card.
3. (T13 MusicAPI login) Optional, only if you want the "Log in" import. First read the cost: MusicAPI's sandbox is free, real use bills at least 500 EUR a month. If you go ahead, follow go-live step 6 in BUILD-HANDOFF.md (account, return URL, three keys in Vercel). Then on the iPhone: Add, Import, Spotify, "Log in to Spotify", log in on MusicAPI's page, check you come back to a checklist with "Liked songs" and your playlists, import one small playlist and check its songs show up in the same order. If MusicAPI's page says the return address is not allowed, tell Claude (the app adds `?state=...` to it).
3. (T13 Spotify link) Added by the Spotify link PR.
3. (T13 Apple Music link) After going live, on the iPhone: in Apple Music open one of your playlists, tap the three dots, then Share Playlist, then Copy. In Tapedeck press Add, Import, Apple Music, paste the link and press Find playlists. Check the playlist shows with its cover and song count, import it, and check the songs come over in the same order. Also paste a playlist link copied from music.apple.com in a computer browser while logged in (it has `/library/` in it) and check the message says to use Share Playlist instead.
3. (T13 PC listing) Added by the PC listing PR.
3. (T13 File upload) After going live, try one file of each kind (Add, Import, Spotify or Apple Music, Upload a file). **Exportify** (Spotify): on a computer open exportify.net, log in with Spotify, press "Export" next to one playlist (a CSV) or "Export All" (a zip), and upload that file. **TuneMyMusic** (Spotify): on tunemymusic.com pick Spotify as the source, log in, choose playlists, pick "Export to file" as the destination, save the CSV and upload it. **Apple Music** (on a Mac or Windows PC with the Music or iTunes app): File, Library, Export Library, save `Library.xml` and upload it; if it says the file is too big, right-click it and pick "Compress" (Mac) or "Send to, Compressed (zipped) folder" (Windows) and upload the zip, or export single playlists with File, Library, Export Playlist. Each time check the checklist shows your own playlists (no "Library", "Music", "Downloaded" or "Purchased"), import one, and check its songs are in the same order. On the iPhone: upload a CSV from the Files app once.
3. (T14) On the iPhone: set a song to Sped up with "Keep original pitch" off (song menu, Edit details, Speed). Play it with the next song at normal speed, lock the phone, and check it sounds sped up and higher, then the next song plays at normal speed and pitch. Pause and play from the lock screen once and check the speed stays.
