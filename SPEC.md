# TAPEDECK: Master Build Document

Working name: **Tapedeck**. The owner may rename it later. The name lives in ONE constant, `APP_NAME` in `web/lib/config.ts`, plus the PWA manifest, so a rename is a two-line change.

## 0. Instructions to the builder (fully autonomous build)

You are building **Tapedeck**, a personal, open source music streaming app. The owner pastes a YouTube or SoundCloud link (or searches YouTube inside the app), the song is cleaned up (title, artist, cover art) and added to his library, a small downloader program on his Windows PC grabs the audio and uploads it to cloud storage, and he plays it from a Spotify-style web app on his iPhone (installed to the home screen) and his PC. Audio only, no video anywhere.

**You work alone from the first line to the last. The owner will not answer questions, will not review anything in between, and will only look at the result when every ticket is done.** Follow these rules:

1. **Order.** Build in the ticket order in section 9. After each ticket, run its automated checks (section 9.0 explains the test setup), fix until they pass, commit to `main`, print a one-line result, and move on.
2. **Never ask the owner anything.** If something is unclear, do what this spec says. If the spec is silent, pick the simplest option that fits section 3 and section 10, write it in `docs/DECISIONS.md` (date, ticket, decision, one-line reason), and continue.
3. **Blockers never stop the build.** If a check still fails after 3 honest fix attempts, or needs something only the owner has (a missing secret, his iPhone, his Windows PC), write it in `docs/BLOCKERS.md` (what failed, why, exactly what the owner must do, in plain words), finish everything else in that ticket, and continue with the next ticket. Never fake a pass, never delete a failing test to get green, never weaken a check without logging it.
4. **Regression.** Every ticket's checks also re-run all earlier tickets' tests. A ticket is done only when everything is green or logged in BLOCKERS.md.
5. **Data.** Never pre-fill the app with fake songs. The stand-ins (4.1) start empty. Tests may create data, but must record the id of every row and stored file they create and delete them when finished (test files go under the `test/` prefix), so a real library is never touched when `@live` tests run.
6. **No accounts, no keys.** The owner has NOT created any service accounts yet and will do it after the build (5.3). Build and test everything with the stand-ins in 4.1. Never ask for keys and never treat a missing key as a failure. If any section 5.1 value does exist in your environment, use it and also run the `@live` tests.
7. **Deploying.** If you have GitHub access, create the repo and push after every ticket. If you also have Vercel access, create the project (Root Directory `web`) and deploy; with no keys yet the live URL shows the Setup page (8.12), which is the correct result. If you lack either access, skip it and note it in `docs/HANDOFF.md` steps (not a failure).
8. **Things that need the owner** (creating accounts and going live, the iPhone lock screen, running the downloader on his Windows PC, Apple Music on his PC) are tested with stand-ins during the build (9.0) and listed once, at the end, in the handoff (T8).
9. **Finish with T8.** Its handoff page is the first and only thing the owner reads. Your last printed line is the handoff link.

Do not use em dashes anywhere, including UI text, docs and commit messages. The owner is non-technical: every step he has to do must be short numbered steps in plain language.

**Repository:** create `https://github.com/dennycrafter/tapedeck` (public, default branch `main`, MIT licence). Put this file at the repo root as `SPEC.md` and do not edit it.

**Design skill:** if your environment supports agent skills, install and use Impeccable (`npx -y skills add pbakaus/impeccable --skill impeccable`) for every screen, and run its critique and polish passes in T5. Section 10 rules always win over any skill default.

---

## 1. Mission

The owner wants to stop paying for music subscriptions. Tapedeck gives him one library for music he finds on YouTube and SoundCloud, with his own playlists, liked songs and favourite albums, that plays in the background on his locked iPhone, works offline for songs he chooses, and has no ads (audio is downloaded, never streamed through YouTube's player).

Core loop in one sentence: **paste a link, the song appears in the library as "Waiting", the PC downloader turns it into a clean .m4a in the cloud, and it plays anywhere.**

Single user only. No sign-up, no multiple accounts. Open source so others can run their own copy.

---

## 2. Definition of done

- [ ] Runs locally with zero accounts or keys (`npm run dev`, stand-ins from 4.1) and every automated test passes that way
- [ ] Ready for Vercel Hobby (free) as a NEW project in the owner's existing account (do not touch his other projects); deployed if the builder has access, showing the Setup page (8.12) until the owner goes live
- [ ] Going live needs only environment variables and the "Finish setup" button, no code changes
- [ ] Every page and API route requires the app password, except: `/login`, `/api/login`, `/setup` and `/api/setup/*` (8.12), `/api/cron/keepalive`, `/api/local-storage/*` (checks its own signature), `/api/agent/*` (uses its own bearer token), PWA files (`/manifest.webmanifest`, `/sw.js`, icons) and static assets
- [ ] Installs to the iPhone home screen; the WebKit iPhone stand-in tests (9.0) pass for playback, auto-advance, Media Session and offline; the real lock screen checks are listed in the handoff for the owner
- [ ] Paste a YouTube or SoundCloud link, or search YouTube in the app, and the song is added with cleaned title, artist, album and cover art (or blank cover if not sure)
- [ ] PC downloader installs with one script and starts with Windows; its full pipeline passes `--selftest` in the build; the real YouTube download is checked by the owner after handoff
- [ ] Library: songs, liked songs, playlists, albums (with favourite albums), artists, recently played, profile with stats
- [ ] Player: queue, play next, shuffle, repeat, seek, mini player, full now playing screen
- [ ] Offline: download any song, playlist, album or liked songs to the phone; plays in airplane mode, including opening the app offline
- [ ] "Save to Files" on any ready song (iPhone share sheet, normal download on PC)
- [ ] Optional setting "Also add to Apple Music on my PC" works (T6)
- [ ] README with plain-language setup steps, `.env.example` files committed, real `.env` files git-ignored, no audio files ever committed
- [ ] Monthly cost: $0 apart from tiny Anthropic API usage the owner pays from existing credits
- [ ] `docs/HANDOFF.md`, `docs/TEST-REPORT.md`, `docs/DECISIONS.md`, `docs/BLOCKERS.md` and `docs/screenshots/` exist and are up to date

---

## 3. Hard constraints

- **No accounts exist yet.** The build must run and pass all tests with zero secrets. Real services plug in later through environment variables only.
- **Cost:** free tiers only. Vercel Hobby, Supabase Free, Cloudflare R2 free tier, YouTube Data API (free, quota based). Anthropic API is the only paid service (owner has credits).
- **YouTube blocks cloud servers.** Downloading (yt-dlp) runs ONLY on the owner's Windows PC (home internet). Never call yt-dlp from Vercel or any cloud machine.
- **The owner's PC is usually off.** Adding songs must work with the PC off (they wait in a queue). Playback must never depend on the PC.
- **Device:** iPhone, using the web app added to the home screen (no App Store app). PC: Windows, Chrome.
- **Vercel Hobby** has no built-in password protection on production: build our own password screen (8.1).
- **Supabase Free** pauses after 7 days with no database requests: daily keepalive cron.
- **R2 free tier:** 10 GB storage, 1 million Class A and 10 million Class B operations per month, free egress. At about 1 MB per minute of audio that is roughly 2,500 songs.
- **YouTube Data API:** default 10,000 units per day; `search.list` costs 100 units, so about 100 searches per day. `videos.list` costs 1 unit.
- **Timezone:** `America/Chicago` for "today", "this month" and dates shown.
- **Personal use only.** The app ships no music. The README says users are responsible for following the terms of the sites they download from.

---

## 4. Stack and architecture

```
 iPhone home screen app / PC Chrome            Vercel (Next.js, Hobby)                 Supabase (Postgres)
  - Spotify-style UI, one <audio> element  -->  pages + /api/* routes  --server only-->  tables (section 6)
  - Media Session (lock screen)                 - metadata (YouTube API, SoundCloud oEmbed)
  - IndexedDB offline songs                     - AI cleanup (Anthropic)              --> Anthropic
  - service worker (offline app shell)          - cover lookup (iTunes, Deezer)        --> iTunes / Deezer
        |                                       - presigned R2 URLs                    --> Cloudflare R2 (audio)
        | plays audio straight from R2  <------------------------------------------------'
        |
 Owner's Windows PC: "downloader" (Python, starts at log on)
  - polls /api/agent/claim every 20 s  -->  yt-dlp + Deno + ffmpeg  -->  tag .m4a  -->  PUT to R2 (presigned)
  - optional: copy .m4a into Apple Music's auto-add folder (T6)
```

- **Repo layout (monorepo):**
  - `/web`: Next.js 15+ App Router, TypeScript, Tailwind CSS. Vercel Root Directory = `web`.
  - `/agent`: Python 3.12 downloader for Windows. `agent/downloader.py`, `agent/requirements.txt`, `agent/install.bat`, `agent/.env.example`.
  - `/supabase/schema.sql`.
- **Database access:** ONLY from Next.js server code through `web/lib/db.ts` (4.1). The browser never talks to the database.
- **Storage access:** through `web/lib/storage.ts` (4.1). Real driver: R2 via the S3 API (`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, endpoint `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region `auto`). R2 keys live only in Vercel. The browser and the PC downloader only ever get short-lived signed URLs.
- **Object key:** `tracks/<track_id>.m4a`.
- **Source of truth:** the database for everything; the phone's IndexedDB holds offline audio copies and the last library snapshot.

### 4.1 Stand-ins (how the app runs with no accounts)

The app is written against small adapters, so it runs, and passes every test, with zero secrets. Real services plug in later by setting environment variables only.

| Piece | Real service (when env is set) | Stand-in (when env is missing, development and tests only) |
|---|---|---|
| Database, `web/lib/db.ts` | Postgres on Supabase via `DATABASE_URL` (transaction pooler), `postgres` npm package with `prepare: false` | PGlite (`@electric-sql/pglite`), data in `web/.data/pglite`. Tests use an in-memory PGlite per run |
| Audio storage, `web/lib/storage.ts` | Cloudflare R2 via the S3 API, presigned URLs | `local` driver: files in `web/.data/storage`; "presigned" URLs are `/api/local-storage/<key>?exp=<unix>&sig=<HMAC-SHA256(key+exp, SESSION_SECRET)>`, served by a route that supports GET with `Range` (206) and PUT, and rejects bad or expired signatures |
| YouTube metadata | YouTube Data API `videos.list` (7.3) | YouTube oEmbed (no key, 7.3). In tests: recorded fixtures |
| YouTube search | YouTube Data API `search.list` | Search box shows "Add a YouTube key to turn on search". In tests: recorded fixtures |
| Title cleanup AI | Anthropic (7.5) | Rule cleaner only (8.4 step 1). In tests: recorded fixture responses |
| Cover art | iTunes and Deezer (7.6, no keys) | Same live calls; if the network is unreachable, cover stays blank |
| Secrets | Vercel env vars | In development: `APP_PASSWORD` defaults to `tapedeck-dev`; `SESSION_SECRET`, `AGENT_TOKEN`, `CRON_SECRET` are generated once into `web/.data/dev-secrets.json` (git-ignored) |

- `storage.ts` interface: `uploadUrl(key)`, `downloadUrl(key, { attachmentName? })`, `head(key)`, `delete(key)`, `setCors()` (no-op for local).
- `db.ts` exposes one `sql` tagged-template function used everywhere; on first start it runs `supabase/schema.sql` if the `settings` table is missing (dev and PGlite). In production the schema runs from "Finish setup" (8.12).
- All external HTTP goes through `web/lib/http.ts` so tests can intercept it with MSW.
- In a production build, the local stand-ins for database and storage are disabled; missing variables show the Setup page (8.12) instead.

---

## 5. Environment variables

### 5.1 Vercel (`web/.env.example`, empty values)

None of these exist during the build. All are added by the owner when going live (5.3).

| Name | What it is | Where to get it | Format |
|---|---|---|---|
| `APP_PASSWORD` | The password the owner types | Owner chooses it | any string, 12+ chars |
| `SESSION_SECRET` | Signs the login cookie and local storage URLs | Copied from the Setup page (8.12) | 64 hex chars |
| `DATABASE_URL` | Postgres connection | Supabase > Connect > Transaction pooler > URI, database password filled in (5.3) | `postgresql://...:6543/postgres` |
| `R2_ACCOUNT_ID` | Cloudflare account ID | Cloudflare dashboard > R2 > right side panel | 32 hex chars |
| `R2_ACCESS_KEY_ID` | R2 API token key ID | R2 > Manage API tokens > Create (Admin Read & Write, so "Finish setup" can set CORS) | string |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | same screen, shown once | string |
| `R2_BUCKET` | Bucket name | fixed value | `tapedeck-audio` |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key | console.cloud.google.com > new project > enable "YouTube Data API v3" > Credentials > API key | starts with `AIza` |
| `ANTHROPIC_API_KEY` | AI title cleanup | console.anthropic.com > API Keys | starts with `sk-ant-` |
| `AGENT_TOKEN` | Lets the PC downloader talk to the app | Copied from the Setup page (8.12) | 64 hex chars |
| `CRON_SECRET` | Protects the keepalive cron | Copied from the Setup page (8.12) | 64 hex chars |

### 5.2 PC downloader (`agent/.env.example`)

| Name | What it is | Format |
|---|---|---|
| `APP_URL` | The deployed app URL | `https://tapedeck-xxxx.vercel.app` (no trailing slash) |
| `AGENT_TOKEN` | Same value as in Vercel | 64 hex chars |
| `APPLE_MUSIC_FOLDER` | Optional override for the Apple Music auto-add folder (T6) | Windows path, or empty for auto-detect |

### 5.3 Go live (the owner does this AFTER the build, following `docs/HANDOFF.md`)

The build needs none of this. The app runs and passes its tests on local stand-ins (4.1). When the owner is ready, he creates the accounts below, pastes the values into Vercel, and the same code switches to the real services. About 20 minutes.

1. **Supabase.** supabase.com > sign in with GitHub > "New project", name `tapedeck`, choose a database password (save it), region "East US", Create, wait about 2 minutes. Click "Connect" at the top > "Transaction pooler" > copy the URI and put your database password where it says `[YOUR-PASSWORD]`. This is `DATABASE_URL`.
2. **Cloudflare R2.** dash.cloudflare.com > sign up > R2 Object Storage. It asks for a card: add it (it stays free under 10 GB). "Create bucket", name `tapedeck-audio`. Back on the R2 page: "Manage API tokens" > "Create API token" > permission **Admin Read & Write** > Create. Copy Access Key ID (`R2_ACCESS_KEY_ID`), Secret Access Key (`R2_SECRET_ACCESS_KEY`) and the Account ID on the R2 page (`R2_ACCOUNT_ID`).
3. **YouTube key (optional, turns on search).** console.cloud.google.com > "Select a project" > "New project" `tapedeck` > search "YouTube Data API v3" > Enable > "Credentials" > "Create credentials" > "API key". This is `YOUTUBE_API_KEY`.
4. **Anthropic key (optional, smarter title cleanup).** console.anthropic.com > API Keys > Create key. This is `ANTHROPIC_API_KEY`.
5. **Vercel.** If the builder already created the Vercel project, open it; otherwise vercel.com > "Add New" > Project > import `dennycrafter/tapedeck` > Root Directory `web` > Deploy. Then Settings > Environment Variables: add `DATABASE_URL`, the three R2 values, `R2_BUCKET` = `tapedeck-audio`, the optional keys, and `APP_PASSWORD` (your own password, 12+ characters). Open the app: the Setup page (8.12) shows three generated secrets with Copy buttons; add them as `SESSION_SECRET`, `AGENT_TOKEN`, `CRON_SECRET`. Deployments > "..." > Redeploy.
6. Open the app again, type your password on the Setup page and press "Finish setup". It creates the database tables and the storage settings by itself, then takes you to the login screen.

---

## 6. Database schema

Run in Supabase > SQL Editor as one script. Save as `supabase/schema.sql`.

```sql
-- gen_random_uuid() is built into Postgres 13+ and PGlite, no extension needed.

create table settings (
  id int primary key default 1 check (id = 1),
  display_name text not null default 'Denis',
  apple_music_export boolean not null default false,
  agent_last_seen timestamptz,
  agent_version text not null default ''
);
insert into settings (id) values (1) on conflict do nothing;

create table tracks (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('youtube','soundcloud')),
  source_id text not null,                 -- YouTube video id, or SoundCloud "user/track" path
  source_url text not null,                -- canonical URL handed to yt-dlp
  raw_title text not null,
  raw_artist text not null default '',     -- YouTube channel / SoundCloud uploader
  raw_thumbnail_url text,
  title text not null,
  artist text not null default '',
  album text,
  album_artist text,
  cover_url text,                          -- null = blank cover
  duration_sec int,                        -- expected length from metadata
  ai_cleaned boolean not null default false,
  ai_confidence numeric,
  status text not null default 'waiting' check (status in ('waiting','downloading','ready','failed')),
  attempts int not null default 0,
  error text not null default '',
  claimed_at timestamptz,
  storage_key text,
  bytes bigint,
  liked boolean not null default false,
  liked_at timestamptz,
  apple_music boolean not null default false,   -- per-song "add to Apple Music" (T6)
  apple_music_done_at timestamptz,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (source, source_id)
);
create index tracks_status_idx on tracks (status, created_at);

create table playlists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table playlist_tracks (
  playlist_id uuid not null references playlists(id) on delete cascade,
  track_id uuid not null references tracks(id) on delete cascade,
  position int not null default 0,
  added_at timestamptz not null default now(),
  primary key (playlist_id, track_id)
);

create table album_favorites (
  id uuid primary key default gen_random_uuid(),
  album text not null,
  album_artist text not null,
  created_at timestamptz not null default now(),
  unique (album, album_artist)
);

create table play_events (
  id uuid primary key default gen_random_uuid(),
  track_id uuid references tracks(id) on delete set null,
  seconds_listened int not null,
  played_at timestamptz not null default now()
);

create table search_cache (
  q text primary key,                      -- lowercased, trimmed query
  results jsonb not null,
  created_at timestamptz not null default now()
);

-- RLS on, no policies: Supabase's public Data API sees nothing. The app connects as the
-- table owner through DATABASE_URL, which RLS does not restrict.
-- The grant only runs where the service_role role exists (Supabase), not in PGlite.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on table %I to service_role', t);
    end if;
  end loop;
end $$;
```

---

## 7. External services

Details from provider documentation as of 9 Oct 2026. T0 must make one real call to each and print OK or the error. Items marked "check in T0" were not live-tested while writing this spec; if T0 shows a different shape, update the code and note it in the README.

### 7.1 Supabase
- Connect with the `postgres` npm package: `postgres(DATABASE_URL, { prepare: false, max: 1 })` (transaction pooler, port 6543, serverless friendly). Server only.
- Free plan pauses after 7 days with no database requests (cron in 7.8 prevents it).
- The schema is applied by "Finish setup" (8.12). It is safe to run more than once only through that button's check (it skips when `settings` exists).

### 7.2 Cloudflare R2
- Free tier: 10 GB-month storage, 1M Class A ops, 10M Class B ops per month, egress free.
- Enabling R2 asks for a payment method on file even on the free tier. Nothing is charged below the free limits. The README must say this plainly.
- Bucket: `tapedeck-audio`, private (no public access, no r2.dev URL).
- CORS policy, set by "Finish setup" (8.12) with the S3 `PutBucketCors` call (the owner pastes nothing). `AllowedOrigins` = the production app URL and `http://localhost:3000`:
```json
[{"AllowedOrigins":["https://YOUR-APP.vercel.app"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Length","Content-Range","Accept-Ranges","ETag"],"MaxAgeSeconds":3600}]
```
- Presigned GET for playback: expires in 6 hours. Presigned GET for "Save to Files" on PC: add `ResponseContentDisposition: attachment; filename="<Artist> - <Title>.m4a"` (ASCII-safe filename, non-ASCII replaced with `_`). Presigned PUT for the downloader: expires in 15 minutes, `ContentType: audio/mp4`.
- Delete object when a track is deleted.

### 7.3 YouTube Data API v3 (server only)
- Quota: 10,000 units/day default. `search.list` = 100 units, `videos.list` = 1 unit.
- No key set: get metadata from oEmbed instead, `GET https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<ID>&format=json` (no key). Use `title`, `author_name`, `thumbnail_url`. No description or duration: send an empty description to the cleaner and leave `duration_sec` null until the downloader reports it. Search is off (4.1).
- Video details: `GET https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=<ids comma separated, max 50>&key=YOUTUBE_API_KEY`. Use `items[].snippet.title`, `snippet.channelTitle`, `snippet.description` (first 300 chars), `snippet.thumbnails.high.url`, `contentDetails.duration` (ISO 8601, e.g. `PT3M45S`).
- Search: `GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=<query>&key=YOUTUBE_API_KEY`, then one `videos.list` call for the 10 ids to get durations. Cache the merged result in `search_cache` for 24 hours.
- Quota error: HTTP 403 with reason `quotaExceeded`. Show: "Search limit reached for today. Paste a link instead, or try again tomorrow."

### 7.4 SoundCloud (server only, no key)
- `GET https://soundcloud.com/oembed?format=json&url=<track url>`. Use `title` (format is usually "Track by Artist"), `author_name`, `thumbnail_url`. Duration is not provided; leave `duration_sec` null until the downloader reports it. Check in T0.
- Accepted URL: `https://soundcloud.com/<user>/<track>` (strip query strings). `source_id` = `<user>/<track>`. Short links `on.soundcloud.com/...`: follow the redirect server-side first. Sets (`/sets/`) are out of scope: reject with "Playlists from SoundCloud are not supported yet. Paste single songs."

### 7.5 Anthropic (server only)
- `POST https://api.anthropic.com/v1/messages`
- Headers: `x-api-key: ${ANTHROPIC_API_KEY}`, `anthropic-version: 2023-06-01`, `content-type: application/json`
- Body: `{ "model": "claude-haiku-5-5", "max_tokens": 300, "temperature": 0, "system": <8.4 system prompt>, "messages": [{"role":"user","content": <JSON of raw_title, raw_artist, description_300>}] }`
- Useful value: `content[0].text` (JSON string; strip code fences before parsing).

### 7.6 Cover art lookups (server only, no keys)
- **iTunes Search API (first):** `GET https://itunes.apple.com/search?term=<artist title, URL-encoded>&entity=song&limit=5&country=US`. Fields: `results[].trackName`, `artistName`, `collectionName`, `artworkUrl100`. Big cover: replace `100x100bb` with `600x600bb` in `artworkUrl100`. Roughly 20 calls per minute allowed; one call per added song is fine. Check in T0.
- **Deezer (fallback):** `GET https://api.deezer.com/search?q=artist:"<artist>" track:"<title>"&limit=5`. Fields: `data[].title`, `data[].artist.name`, `data[].album.title`, `data[].album.cover_xl`. Check in T0.

### 7.7 yt-dlp on the PC (downloader only)
- Install with `pip install -U "yt-dlp[default]"` (the `default` extra includes `yt-dlp-ejs`).
- Since yt-dlp 2025.11.12, full YouTube support needs an external JavaScript runtime plus `yt-dlp-ejs`. Deno is the recommended runtime: `winget install --id=DenoLand.Deno`.
- ffmpeg: `winget install --id=Gyan.FFmpeg`.
- YouTube breaks yt-dlp often. The downloader runs `pip install -U "yt-dlp[default]"` once at every start.

### 7.8 Vercel
- New project, Root Directory `web`, framework Next.js.
- `web/vercel.json`: `{ "crons": [{ "path": "/api/cron/keepalive", "schedule": "0 12 * * *" }] }`. Vercel sends `Authorization: Bearer ${CRON_SECRET}`; reject anything else with 401. The route runs one `select` on `settings`.

---

## 8. Business logic

### 8.1 Password screen
- `/login`: one password field, button "Unlock".
- `POST /api/login` compares with `APP_PASSWORD` (constant-time). On match set cookie `tapedeck_session` = `<expiryUnix>.<HMAC-SHA256(expiryUnix, SESSION_SECRET) hex>`, `HttpOnly`, `Secure`, `SameSite=Lax`, 180-day expiry.
- `middleware.ts` checks the cookie on everything except the exclusions in section 2. Pages redirect to `/login`; API routes return 401. In production, if required variables are missing, it sends everything to `/setup` first (8.12).
- 5 wrong attempts within 10 minutes from one IP: 429 for 10 minutes (in-memory counter is fine).
- Profile menu item "Lock" clears the cookie.

### 8.2 Adding songs (works with the PC off)
- "Add" opens a floating window with a multi-line box: "Paste YouTube or SoundCloud links, one per line." Button "Add".
- `POST /api/tracks { urls: string[] }` (max 25 per request). For each line:
  1. Parse. YouTube: accept `youtube.com/watch?v=ID`, `youtu.be/ID`, `music.youtube.com/watch?v=ID`, `youtube.com/shorts/ID`; ignore `list=` and `t=` params; `source_url` = `https://www.youtube.com/watch?v=ID`. SoundCloud: see 7.4. Anything else: per-line error "Not a YouTube or SoundCloud song link".
  2. If `(source, source_id)` exists: per-line result "Already in your library".
  3. Fetch raw metadata (7.3 `videos.list` batched, or 7.4 oEmbed).
  4. Clean the title (8.4), look up cover art and album (8.5).
  5. Insert with `status = 'waiting'`.
- Response lists each line's result. The window shows a summary toast ("3 added, 1 already in library") and stays open only if every line failed.
- Search results (8.7) use the same pipeline with one URL.

### 8.3 Download queue (PC downloader)
- Statuses: `waiting` (amber dot, "Waiting for your PC"), `downloading` (blue dot, "Downloading"), `ready` (no dot), `failed` (red dot, "Failed" + Retry).
- `POST /api/agent/claim` (Bearer `AGENT_TOKEN`, constant-time compare): first resets any `downloading` row with `claimed_at` older than 15 minutes back to `waiting`; then atomically claims up to 3 `waiting` rows (oldest first) by setting `status='downloading'`, `claimed_at=now()`, `attempts = attempts + 1`, and returns them (`id, source, source_url, title, artist, album, cover_url, duration_sec, apple_music`). Also updates `settings.agent_last_seen`. Use a Postgres function with `for update skip locked` for the atomic claim.
- `POST /api/agent/upload-url { trackId }` → `{ url, key }` (presigned PUT, 15 min).
- `POST /api/agent/complete { trackId, key, bytes, durationSec }` → `status='ready'`, `storage_key`, `bytes`, `duration_sec = durationSec`, `ready_at=now()`, `error=''`.
- `POST /api/agent/fail { trackId, error }` → if `attempts < 3` set `status='waiting'`, else `status='failed'`; store `error` (first 500 chars).
- `GET /api/agent/settings` → `{ apple_music_export }`.
- `POST /api/agent/apple-music-done { trackId }` → sets `apple_music_done_at=now()` (T6).
- UI "Retry" on a failed track: `POST /api/tracks/:id/retry` → `status='waiting'`, `attempts=0`, `error=''`.
- Downloader status in the profile and the library header: "Downloader online" (green dot) if `agent_last_seen` is within 2 minutes, else "Downloader offline, last seen <relative time>" (muted). If any songs are waiting: "N songs waiting for your PC".

**Downloader loop (`agent/downloader.py`):**
1. On start: `pip install -U "yt-dlp[default]"` (ignore failure, log it). Read `agent/.env`. Write logs to `agent/logs/downloader.log` (rotate at 1 MB, keep 3).
2. Every 20 seconds: `POST /api/agent/claim`. For each claimed track, one at a time:
   - Download to `%TEMP%\tapedeck\<id>`: `yt-dlp -f "bestaudio[ext=m4a]/bestaudio" --no-playlist --js-runtimes deno -o "<tmp>/<id>.%(ext)s" <source_url>`.
   - If the file is not `.m4a`, convert: `ffmpeg -i in -vn -c:a aac -b:a 160k out.m4a`.
   - Read real duration with `ffprobe`. If `duration_sec` from metadata is known and the file is under 60% of it, fail with "Only a preview was available (SoundCloud Go+ track?)".
   - Tag with `mutagen` (MP4): `\xa9nam` title, `\xa9ART` artist, `\xa9alb` album (if any), `aART` album artist (if any), `covr` = cover JPEG downloaded from `cover_url` (skip if null).
   - Get upload URL, `PUT` the file with header `Content-Type: audio/mp4`, call `complete`.
   - If `apple_music_export` is on (fetched once per loop) or the track's `apple_music` is true: copy the file into the Apple Music folder (8.11), then call `apple-music-done`.
   - Delete temp files. On any exception call `fail` with the message.
3. Python libraries: `requests`, `mutagen`, `python-dotenv`, `yt-dlp[default]`.

`agent/install.bat` (owner double-clicks it once):
1. `winget install --id=Python.Python.3.12 -e`, `winget install --id=DenoLand.Deno -e`, `winget install --id=Gyan.FFmpeg -e` (each skipped if already installed).
2. `py -3.12 -m pip install -r requirements.txt`.
3. Copy `.env.example` to `.env` if missing and open it in Notepad with a message: "Open the app > Profile > Downloader setup, copy APP_URL and AGENT_TOKEN here, save, close."
4. Register a Task Scheduler task "Tapedeck Downloader": trigger "At log on" of the current user, action `pythonw.exe "<repo>\agent\downloader.py"` (no console window), "Run only when user is logged on".
5. Start it now and print "Downloader installed. It will start every time you log in."

### 8.4 Title cleanup
**Step 1, rules (always run, also the fallback if AI fails or the key is missing):**
- Remove (case-insensitive) bracketed or trailing marketing text: `Official Video`, `Official Music Video`, `Official Audio`, `Official Lyric Video`, `Lyric Video`, `Lyrics`, `Audio`, `Visualizer`, `Visualiser`, `HD`, `HQ`, `4K`, `MV`, `M/V`, `Music Video`, `Clip Officiel`, `Explicit`, and empty brackets left behind.
- If the title contains ` - ` (also the Unicode dash characters U+2013 or U+2014 with a space on each side): left side = artist, right side = title.
- Else artist = channel name with suffixes removed: ` - Topic`, `VEVO`, ` Official`, `Official`.
- SoundCloud: if title is "X by Y" from oEmbed, title = X, artist = Y.
- Featured artists: `ft.`, `ft`, `feat`, `featuring` in title or artist are normalised to `(feat. Name)` at the end of the title.

**Step 2, AI (if `ANTHROPIC_API_KEY` is set):** send the raw title, raw artist and first 300 chars of description. System prompt (use exactly):

```
You clean music metadata for a personal music library. You get a raw video or track title, the uploader name and part of the description. Reply with only a JSON object, no other text:
{"title": string, "artist": string, "is_music": boolean, "confidence": number}
Rules:
- title is the song name only. Remove marketing words like Official Video, Official Audio, Lyrics, Visualizer, HD, 4K, MV.
- Keep real version info in the title in parentheses: (Remix), (X Remix), (Live), (Acoustic), (Sped Up), (Slowed), (Instrumental), (Extended Mix).
- Featured artists go at the end of the title as (feat. Name, Name).
- artist is the main artist or artists, joined with " & ". Uploader names ending in " - Topic" or "VEVO" are the artist without that suffix.
- If the uploader is a label or channel that is not the artist, take the artist from the title.
- is_music is false for podcasts, interviews, tutorials and anything that is not a song.
- confidence is 0 to 1: how sure you are that title and artist are correct.
```
- If the response parses and `confidence >= 0.5`: use AI title and artist, `ai_cleaned = true`, `ai_confidence = confidence`. Else keep the rule result.
- `is_music = false` does not block adding; it only skips cover lookup.

**Undo:** each song's menu has "Edit details" (title, artist, album, cover: keep / remove / paste image URL) and "Restore original" (title = `raw_title`, artist = `raw_artist` with " - Topic"/"VEVO" stripped, album null, cover null, `ai_cleaned=false`).

### 8.5 Cover art and album
- Skip if `is_music` is false.
- Normalise strings for matching: lowercase, strip accents, remove anything in brackets, remove `feat.`/`ft.` parts, remove punctuation, collapse spaces.
- A candidate matches when normalised artist of one contains the other's AND title token overlap (Jaccard) is `>= 0.8`.
- Try iTunes (7.6) first, then Deezer. First matching candidate wins: `cover_url` = big artwork URL, `album` = collection or album title, `album_artist` = candidate artist.
- No match: `cover_url = null`, `album = null` (UI shows the blank cover placeholder). Never use the YouTube thumbnail as a cover.
- If the album title ends with ` - Single` or ` - EP` (iTunes style), strip that suffix for display but keep grouping by the stripped name.

### 8.6 Library and profile
- **Songs:** every track, newest first; sortable by Recently added, Title, Artist (choice remembered per device).
- **Liked songs:** heart on any track; `liked_at` sets order (newest first).
- **Playlists:** create, rename, delete (confirm), add/remove songs, drag to reorder (`@dnd-kit`), playlist cover = 2x2 grid of the first 4 distinct covers (or blank placeholder).
- **Albums:** tracks grouped by `album` + `album_artist` (album not null). Album page: cover, name, artist, tracks in added order, "Favourite album" toggle (heart), Play, Shuffle, Download. Library "Albums" tab shows favourite albums first, then all others.
- **Artists:** grouped by `artist` (exact string). Artist page lists their songs and albums.
- **Recently played:** last 20 distinct tracks from `play_events`.
- A play is recorded once per track start, when 30 seconds have been listened or the track ends (whichever comes first): `POST /api/plays { trackId, seconds }`. Offline plays queue in IndexedDB and flush when back online.
- **Profile page:** display name (editable), stats strip: Songs, Hours listened (all time), Plays this month, Storage used ("3.2 of 10 GB", amber dot at 8 GB or more). Top 5 artists this month by plays. Downloader status. "Downloader setup" panel: shows `APP_URL` (the app's own URL) and `AGENT_TOKEN`, each with a Copy button (page is password protected; never write the token into the repo or docs). Settings: "Also add to Apple Music on my PC" (T6). Offline storage used on this device + "Remove all downloads".
- **Delete song:** confirm; deletes the stored audio file, the row, and the local offline copy.

### 8.7 Search (YouTube)
- `GET /api/search?q=` (min 2 chars). Runs only when the owner presses Enter or the Search button, never while typing, to save quota. Returns 10 results: thumbnail, raw title, channel, duration, and `inLibrary` flag.
- Each result: "Add" button (runs 8.2) and "Open on YouTube" text link. Results already in the library show "In library".
- Note under the search box: "Search uses YouTube's free daily limit (about 100 searches a day)."

### 8.8 Player
- One `<audio>` element for the whole app, mounted once in the root layout (never re-created). `preload="auto"`, `playsinline`.
- Source: offline blob URL if the song is downloaded on this device, else `GET /api/tracks/:id/url` → `{ url, expiresAt }` (fetch fresh right before each track starts).
- Queue: playing from a list (songs, playlist, album, artist, liked songs) sets the queue to that list starting at the tapped song. "Play next" inserts after current; "Add to queue" appends. Queue view: reorder by drag, remove.
- Shuffle: shuffles the remaining queue, current song stays first. Repeat: off / all / one.
- On `ended`: immediately (synchronously in the handler, no awaits before `play()` if the next source is already known) set the next `src` and call `play()`. Pre-fetch the next track's presigned URL as soon as the current track starts, so the `ended` handler has it ready.
- Search results are not playable until added. Only `ready` songs are playable; waiting/failed songs are skipped in the queue and greyed out in lists.
- **Media Session:** on every track change set `navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork: [{ src: cover_url, sizes: '600x600', type: 'image/jpeg' }] })` (artwork omitted when no cover). Handlers: `play`, `pause`, `previoustrack`, `nexttrack`, `seekto`, `seekbackward` (10 s), `seekforward` (10 s). Update `setPositionState` on `timeupdate` (throttled to 1/s).
- Previous: if more than 3 s in, restart the song; else go to previous.
- Remember per device in localStorage (try/catch): current queue ids, index, position (saved every 5 s), shuffle, repeat, volume. On reopen, restore paused at that point.
- Volume slider only on desktop (iPhone ignores `audio.volume`).

### 8.9 Offline on the phone
- **App shell offline:** service worker via `@serwist/next`. Precache the app shell, fonts, icons. Navigation fallback to the cached shell. API calls are network-only.
- **Library snapshot:** after every successful `GET /api/library`, save the JSON in IndexedDB (`tapedeck-offline` database, store `library`). When offline, the UI renders from it and shows a muted "Offline" pill in the top bar.
- **Download a song:** fetch the presigned URL, fetch the whole file (as Blob), store in IndexedDB store `audio` keyed by track id `{ blob, bytes, savedAt }`. Show progress on the row. Download buttons on: song menu, playlist, album, artist, Liked songs ("Download all"). A small down-arrow icon marks downloaded songs. Library filter "Downloaded".
- **Remove download:** song menu, or "Remove all downloads" in profile.
- On first download call `navigator.storage.persist()`.
- Offline playback uses `URL.createObjectURL(blob)`; revoke the previous object URL on track change.

### 8.10 Save to Files
- Song menu item "Save to Files" (ready songs only).
- iPhone: get the Blob (offline copy if present, else fetch it), build `new File([blob], "<Artist> - <Title>.m4a", { type: 'audio/mp4' })`; if `navigator.canShare({ files: [file] })` call `navigator.share({ files: [file] })` (the owner picks "Save to Files").
- Otherwise (PC): open the presigned URL with `?download=1` (attachment disposition, 7.2).
- The file already carries title, artist, album and cover tags from the downloader.

### 8.11 Apple Music export (T6, off by default)
- Profile setting "Also add to Apple Music on my PC" sets `settings.apple_music_export`. Song menu item "Add to Apple Music" sets that track's `apple_music = true` (for single songs when the setting is off). If the song is already ready, set it back to `waiting` so the downloader re-processes it (cheap and simple); the downloader then copies the file and calls `apple-music-done`.
- Folder detection in the downloader (first that exists): `APPLE_MUSIC_FOLDER` from `.env`; any folder whose name starts with `Automatically Add` within 3 levels under `%USERPROFILE%\Music\Apple Music`; `%USERPROFILE%\Music\iTunes\iTunes Media\Automatically Add to iTunes`. If none found, log it and fail the Apple Music step only (song stays ready), with the error "Apple Music folder not found. Open Apple Music on your PC once, or set APPLE_MUSIC_FOLDER."
- Copy as `<Artist> - <Title>.m4a`. Apple Music imports and removes files from that folder by itself.
- Getting songs onto the iPhone this way needs a cable or Wi-Fi sync from the Apple Devices app on the PC (owner has no Apple Music subscription). Explain in the README; the app does not automate it.

### 8.12 Setup page (before the owner goes live)
- Only in production builds. In development and tests the stand-ins in 4.1 are used and this page never shows.
- Required for production: `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `APP_PASSWORD`, `SESSION_SECRET`, `AGENT_TOKEN`, `CRON_SECRET`. Optional: `YOUTUBE_API_KEY` (search), `ANTHROPIC_API_KEY` (AI cleanup).
- If any required variable is missing, middleware sends every request (except PWA files, static assets and `/api/setup/*`) to `/setup`. No password is needed to view it, because it only shows variable NAMES and never values.
- `/setup` shows: "Almost ready" title, a list with a green dot for each variable that is set and a red dot for each missing one (optional ones amber, with one line on what they turn on), the go-live steps from 5.3 in short form, and three freshly generated random values (`crypto.getRandomValues`, 32 bytes hex) labelled `SESSION_SECRET`, `AGENT_TOKEN`, `CRON_SECRET`, each with a Copy button.
- When every required variable is set, the page shows a password box and "Finish setup". `POST /api/setup/finish` (checks `APP_PASSWORD`, constant-time) runs `supabase/schema.sql` if the `settings` table does not exist, applies the R2 CORS rules (7.2) with `PutBucketCors`, checks every service like `/api/health`, and returns the results. All OK: redirect to `/login`. Anything failing: show the service name and the error in plain words, stay on the page.
- After setup is finished and every required variable is set, `/setup` redirects to `/login`.

---

## 9. Build order (tickets)

### 9.0 How you test (set up in T0, used by every ticket)

- **Unit tests:** Vitest in `/web` (`npm run test`), pytest in `/agent` (`pytest`).
- **End-to-end tests:** Playwright in `/web/e2e` (`npm run e2e`), three projects: `desktop` (Chromium 1440x900), `iphone` (WebKit, `devices['iPhone 13']`), `android` (Chromium, `devices['Pixel 7']`). Playwright starts the app itself with the 4.1 stand-ins (`TAPEDECK_TEST=1`: in-memory PGlite, local storage in a temp folder, MSW intercepting YouTube Data API and Anthropic with recorded fixtures in `web/e2e/fixtures/`). Tests log in with the dev password. No secrets are needed for any test except the `@live` ones. Each test is tagged with its ticket (`@T0` ... `@T8`); a ticket runs its own tag plus every earlier tag.
- **Test data helpers:** `web/e2e/helpers/db.ts` seeds and cleans up through the app's own `db.ts` and `storage.ts`.
- **Network tags:** `@net` tests make real calls that need no key (YouTube oEmbed, SoundCloud oEmbed, iTunes, Deezer). If the build machine has no internet access they are skipped and noted in TEST-REPORT.md, not failed. `@live` tests use real accounts and only run when the 5.1 variables are present; otherwise they are skipped and listed in the handoff as "runs after you go live" (`npm run e2e:live`).
- **Downloader stand-in:** `python agent/downloader.py --selftest --track <id>` runs the real pipeline (tag, upload URL, PUT to R2, complete) for one track, but uses `web/public/test-audio/test1.m4a` instead of calling yt-dlp. E2E tests seed a waiting track, run this command as a child process (with env `APP_URL` = the test server URL and `AGENT_TOKEN` = the test server's token), then assert the track is ready. This is how every "song becomes ready" check works in the build, because YouTube blocks cloud machines.
- **Real yt-dlp probe:** `python agent/downloader.py --probe https://www.youtube.com/watch?v=jNQXAC9IVRw` runs `yt-dlp --simulate` with Deno. From a cloud machine a "not a bot" error is EXPECTED: record the result in `docs/TEST-REPORT.md` and do not treat it as a failure. The real download is verified on the owner's PC after the build (T8 handoff).
- **iPhone stand-in:** the `iphone` project (WebKit with iPhone viewport, touch and user agent) checks player logic, Media Session metadata, offline mode (`context.setOffline(true)`) and IndexedDB. It cannot lock a real phone, so the lock screen checks go in the handoff.
- **Results:** after every ticket append to `docs/TEST-REPORT.md`: ticket, date, tests passed/failed/skipped per project, anything logged in BLOCKERS.md.

### T0: Scaffold, connectivity, audio stand-in
Blocked by: none, start immediately
Steps:
1. Monorepo `/web` (Next.js, TS, Tailwind), `/agent` (Python skeleton with `--selftest` and `--probe` flags stubbed), `/supabase/schema.sql`, `/docs` (DECISIONS.md, BLOCKERS.md, TEST-REPORT.md), MIT `LICENSE`.
2. `.gitignore`: `.env*` except `.env.example`, `node_modules`, `.next`, `agent/logs/`, `test-results/`, `playwright-report/`, and `*.m4a`, `*.mp3`, `*.webm`, `*.opus`, `*.wav` except `web/public/test-audio/*`.
3. `db.ts` and `storage.ts` with both drivers (4.1), `http.ts`, dev secrets file, and the Setup page with "Finish setup" (8.12).
4. `/api/local-storage/[...key]` route (signed GET with Range, signed PUT).
5. Password screen and middleware (8.1). PWA manifest (`name` Tapedeck, `display: standalone`, `background_color` and `theme_color` `#0b0b0d`, icons 192, 512, maskable 512, `apple-touch-icon` 180) and `@serwist/next` service worker.
6. `/api/health` (password protected), each value `OK`, `STAND-IN` (local driver in use) or the error: `database` (select settings), `storage` (HeadBucket on R2, or a write/read/delete of a tiny local file), `youtube` (`videos.list` for id `jNQXAC9IVRw`, 1 unit), `soundcloud` (oEmbed for a public track URL you find), `anthropic` (`GET https://api.anthropic.com/v1/models` with 7.5 headers, or `NOT_SET`), `itunes` and `deezer` (one search each for "daft punk get lucky"). Keys that are not set return `NOT_SET`.
7. `/api/cron/keepalive` + `vercel.json` cron.
8. `/test-audio` page (password protected): two 3-minute test tones generated with ffmpeg (`ffmpeg -f lavfi -i "sine=frequency=440:duration=180" -c:a aac -b:a 128k test1.m4a`, 660 Hz for `test2.m4a`), committed in `web/public/test-audio/`. Buttons: Play (test1 then test2 automatically, Media Session titles "Test tone 1" and "Test tone 2"), "Save test1 offline" (Blob into IndexedDB), "Play offline copy". This page stays in the app for the owner's own iPhone check.
9. Playwright, Vitest and pytest set up as in 9.0.
Automated checks (@T0):
- [ ] `/` redirects to `/login`; wrong password shows an error and stays; right password reaches Home
- [ ] `/api/health` without cookie = 401; with cookie `database` and `storage` are `STAND-IN` and their checks pass; network services are `OK` or skipped (`@net`)
- [ ] A production build started with no variables sends `/` to `/setup`, which lists every required variable with a red dot and shows three 64-character hex values with Copy buttons; `/setup` shows no values of any variable
- [ ] `/api/local-storage` rejects a missing, wrong or expired signature (403) and serves a valid one with Range (206)
- [ ] `/api/cron/keepalive` without bearer = 401, with bearer = 200
- [ ] `/manifest.webmanifest` and `/sw.js` load without a cookie; manifest `display` is `standalone`
- [ ] `iphone` project on `/test-audio`: press Play, jump test1 to 1 second before its end, within 2 seconds test2 is playing (`currentTime` rising) and `navigator.mediaSession.metadata.title` is "Test tone 2"
- [ ] `iphone` project: "Save test1 offline", `setOffline(true)`, reload the page (served by the service worker), "Play offline copy": `currentTime` rises
- [ ] `@live` only: "Finish setup" creates the tables and R2 `GetBucketCors` returns the 7.2 rules

### T1: Tracer bullet (CHECKPOINT)
Blocked by: T0
Steps: Add window (8.2) for YouTube links with rule-based cleanup only (8.4 step 1); tracks list with status dots; the full downloader (8.3) including `install.bat`, `--selftest` and `--probe`; agent API routes; presigned playback URL; basic player bar (play/pause, seek) with Media Session; "Downloader setup" panel on the profile page (8.6).
Automated checks (@T1):
- [ ] Through the UI (`iphone` project), paste `https://youtu.be/jNQXAC9IVRw`: a row appears with status "Waiting for your PC" with title and channel from the YouTube fixture (and, `@net`, from live oEmbed in a second test)
- [ ] Pasting the same link again shows "Already in your library"
- [ ] `--selftest` on that track (downloader pointed at the local test server): status becomes `ready`, `bytes` and `storage_key` set, the stored file exists
- [ ] `GET /api/tracks/:id/url` returns a URL; fetching it with `Range: bytes=0-1023` returns 206 and `audio/mp4`
- [ ] Pressing play in the UI: `currentTime` rises, Media Session title matches the track title
- [ ] Downloading the stored file and reading it with mutagen (pytest helper) shows the track's title and artist tags
- [ ] After selftest, header shows "Downloader online"; setting `agent_last_seen` to 3 minutes ago in the database shows "Downloader offline"
- [ ] Atomic claim: two `POST /api/agent/claim` calls at the same time never return the same track
- [ ] `--probe` result recorded in TEST-REPORT.md (blocked from cloud is fine)
- [ ] Unit: URL parsing for every format in 8.2 and the rule cleaner pass

### T2: Library, playlists, albums, full player
Blocked by: T1
Delivers 8.6 and 8.8 fully, plays, profile stats, delete.
Automated checks (@T2), using seeded ready tracks (selftest) with made-up titles:
- [ ] Create a playlist, add 3 songs, drag to reorder, reload: order persists
- [ ] Like a song: it is first in Liked songs
- [ ] Two tracks with the same album and album artist show as one album; favouriting moves it first in Albums
- [ ] Unit: queue logic (play next, add to queue, shuffle keeps current first, repeat off/all/one, previous after 3 seconds restarts)
- [ ] `iphone` project: at the end of a track the next one starts and Media Session metadata updates; `nexttrack` and `previoustrack` handlers exist and work when called
- [ ] Reload mid-song: same song, same position (within 5 seconds), paused
- [ ] Listening 30 seconds creates one `play_events` row; profile stats equal the database counts
- [ ] Delete a song: row gone, stored file gone (`head` returns not found)

### T3: AI cleanup, cover art, editing, search, SoundCloud
Blocked by: T1
Delivers 8.4 step 2, 8.5, Edit details / Restore original, 8.7, SoundCloud links (7.4).
Automated checks (@T3):
- [ ] Unit: rule cleaner on at least 15 realistic title fixtures you write (marketing words, " - Topic", VEVO, feat. variants, remixes, "X by Y")
- [ ] Unit: matching (normalise + Jaccard) accepts true matches and rejects 5 near-miss fixtures
- [ ] Pick 5 well-known official music videos on YouTube and record their raw titles and channels as fixtures, with a fixture AI reply for each: adding each gives a clean title and artist; `@net`: at least 4 of 5 get a 600x600 cover from live iTunes or Deezer
- [ ] One clearly non-music video (fixture of a talk or tutorial) gets `cover_url = null`
- [ ] With no Anthropic key (the default stand-in), adding still works using the rule cleaner; with the fixture AI reply, the AI result is used when `confidence >= 0.5`
- [ ] "Restore original" brings back the raw title; "Edit details" saves changes
- [ ] With a fixture YouTube key set, search "get lucky" returns 10 fixture results with durations; the same search again within 24 hours is served from `search_cache` (MSW request count stays the same); with no key the search box shows "Add a YouTube key to turn on search"
- [ ] A public SoundCloud track link (oEmbed fixture, plus `@net` live) is added with clean title and artist; `--selftest` makes it playable; a SoundCloud `/sets/` link shows the "not supported yet" message

### T4: Offline and Save to Files
Blocked by: T2
Delivers 8.9 and 8.10.
Automated checks (@T4), `iphone` project:
- [ ] "Download" on a playlist of 3 ready songs stores 3 blobs in IndexedDB and shows the downloaded icon on each
- [ ] `setOffline(true)`, reload: the app opens from the service worker, the library renders from the snapshot, the "Offline" pill shows, all 3 songs play, and auto-advance works
- [ ] While offline, non-downloaded songs are greyed and not playable
- [ ] A play made offline is saved in IndexedDB and appears in `play_events` after `setOffline(false)`
- [ ] Unit: "Save to Files" builds a File named `<Artist> - <Title>.m4a` with type `audio/mp4` and calls `navigator.share` when `canShare` is true (mocked in the unit test)
- [ ] `desktop` project: "Save to Files" response has `Content-Disposition: attachment; filename="<Artist> - <Title>.m4a"`

### T5: UI polish (self-reviewed, no owner approval needed)
Blocked by: T2, T3, T4
Delivers every section 10 rule on every screen. Run Impeccable critique and polish if available.
Steps:
1. Seed made-up data (12 tracks with invented titles and artists, 2 playlists, 1 favourite album; covers from the blank placeholder or simple generated SVG art) tagged for cleanup.
2. Screenshot at 1440px (`desktop`) and 390px (`iphone`): Home, Search, Library (each tab), Playlist, Album, Artist, Now playing, Queue, Add window, Profile, Login. Save to `docs/screenshots/`.
3. Review every screenshot yourself against each section 10 rule and write the result per screen in `docs/UI-REVIEW.md` (rule, pass or fixed). Fix, re-shoot, repeat until every rule passes.
4. Delete the seeded data.
Automated checks (@T5):
- [ ] On every page at 390px: `document.documentElement.scrollWidth <= window.innerWidth`
- [ ] No rendered text on any page contains the characters U+2013 or U+2014
- [ ] At most one visible element per page uses `--accent` as its background colour
- [ ] No console errors on any page
- [ ] Lighthouse accessibility score of 90 or more on Home and Library (`npx lighthouse --only-categories=accessibility`)
- [ ] `docs/UI-REVIEW.md` lists every screen with every rule passing

### T6: Apple Music export
Blocked by: T2
Delivers 8.11.
Automated checks (@T6):
- [ ] pytest: with a fake `USERPROFILE` containing `Music\Apple Music\Media\Automatically Add to Music`, a processed track is copied there as `<Artist> - <Title>.m4a` and `apple-music-done` is called
- [ ] pytest: the `iTunes\iTunes Media\Automatically Add to iTunes` layout is also found
- [ ] pytest: with no folder, the song stays `ready` and the error text is the one in 8.11
- [ ] e2e: the setting toggle and the per-song "Add to Apple Music" item update the database as in 8.11

### T7: README and open source hygiene
Blocked by: T5
Delivers section 11.
Automated checks (@T7):
- [ ] `scripts/check-repo.sh` passes: no tracked file contains `sk-ant-`, `AIza`, a 64-character hex string outside `.env.example` files, or the R2 key values; no audio files tracked except the two test tones; `LICENSE` exists; README has all 7 sections from section 11; no U+2013 or U+2014 characters in any tracked text file
- [ ] Repo is public on GitHub with the MIT licence

### T8: Handoff (the owner's first look)
Blocked by: T0 to T7
Steps:
1. Run every test in every project one final time and update `docs/TEST-REPORT.md`.
2. Write `docs/HANDOFF.md`, plain language, in this order:
   - What was built (5 lines) and the live app URL
   - Ticket table: ticket, status (done / done with blockers), tests passed / total
   - Screenshots: Home, Now playing and Library at phone width, Home at desktop width (embedded from `docs/screenshots/`)
   - **Your steps**, numbered:
     0. Go live: the 6 steps from SPEC.md section 5.3, copied here in full (with the live Vercel URL filled in if it was deployed). After "Finish setup" works, ask Claude or Obvious to run `npm run e2e:live` to test the real services.
     1. On your PC: download the repo (green "Code" button > Download ZIP), unzip to `Documents\tapedeck`, double-click `agent\install.bat`, then open the app > Profile > "Downloader setup" and copy the two values into the Notepad window it opens.
     2. On your iPhone: open the app URL in Safari > Share > Add to Home Screen > open it from the home screen and log in.
     3. On your iPhone, check: open `/test-audio`, press Play, lock the phone (keeps playing, next tone starts by itself, lock screen shows the title); then add one real song, wait for "Ready", play it locked; download it, airplane mode, play it again.
   - What to do if a step fails (copy the matching lines from README "Not working?")
   - Decisions made without you (short list from DECISIONS.md)
   - Anything that needs you (from BLOCKERS.md), each with exact steps
3. Pin `docs/HANDOFF.md` as the first link in the README.
Automated checks (@T8):
- [ ] All tests green or logged in BLOCKERS.md
- [ ] `HANDOFF.md` exists with every part above and working image links
- [ ] Last printed line: the GitHub link to `docs/HANDOFF.md`

---

## 10. UI spec

### Design rules (owner's standing preferences, follow exactly)
- Dark only. Tokens:
```css
:root {
  color-scheme: dark;
  --bg: #0b0b0d; --surface: #121215; --surface-2: #1c1c20; --line: #2a2a30;
  --fg: #f2f2f4; --muted: #9a9aa3; --silver: #e8e8ea;
  --accent: #ff7a1a; --accent-ink: #ff9a4d;
  --ok: #34d65c; --warn: #ffb547; --bad: #ff6f66; --info: #6ab8ff;
  --r: 8px;
}
```
- Corners: boxes and cover art 8px, buttons and inputs 6px. Pills only for status (Offline, Downloader online).
- Four greys only (bg, surface, surface-2, line). Inputs sit on `--bg`.
- Accent colour only on the ONE main action per screen: the big Play button on playlist/album/artist pages, the play/pause button in the player, "Add" in the Add window, "Unlock" on login. Active nav item uses `--fg` with a 2px underline or left bar, not accent.
- System font (-apple-system, Segoe UI, Inter fallback) for all text. Display font **Saira** (Google Fonts) only for big numbers (profile stats, time in now playing).
- Pop-ups and menus: `--surface-2`, 1px `--line` outline, shadow `0 6px 16px rgba(0,0,0,.3)`.
- Lists like an inbox: rows in one box with thin dividers. Row: 44px cover, title (bold) over "Artist · Album" (muted, plain text joined with dots), duration right, "..." menu. Status as a small coloured dot plus muted text, no chip.
- Blank cover placeholder: `--surface-2` square with a simple music-note icon in `--muted`.
- No video, no visualiser, no animated backgrounds. Now playing may use a very subtle blurred version of the cover as background (opacity 0.15), nothing that moves.
- Add actions open a floating window (click outside, X or Escape closes; closes on success with a toast; stays open on error).
- Max width 1760px, gutter `clamp(16px, 2.6vw, 40px)`. No sideways scroll on phones. Respect iPhone safe areas (`env(safe-area-inset-*)`).
- Visible focus outlines, aria labels on icon buttons, Escape closes every modal, keyboard shortcuts on desktop: Space play/pause, Shift+Right/Left next/previous, `/` focus search.
- No em dashes in any UI text.
- Remember per-device choices in localStorage wrapped in try/catch.

### Layout
- **Desktop:** left sidebar (Home, Search, Library: Liked songs, Playlists, Albums, Artists, Downloaded; "New playlist"), main content, bottom player bar (cover, title/artist, previous/play/next, shuffle, repeat, progress with times, queue button, volume). "Add" button top right of the main area; profile circle top right.
- **Phone:** bottom tab bar (Home, Search, Library, Add); mini player above the tab bar (cover, title/artist, play/pause, thin progress line); tap opens full Now playing sheet (big cover, title, artist, album link, progress, previous/play/next, shuffle, repeat, heart, queue, "..." menu). Swipe down closes it.
- **Home:** greeting "Hey {display_name}", status line (downloader status + "N songs waiting" if any), Recently played (horizontal row of covers), Favourite albums, Your playlists, Recently added.
- **Song "..." menu:** Play next, Add to queue, Add to playlist, Like/Unlike, Go to album, Go to artist, Download / Remove download, Save to Files, Edit details, Restore original, Add to Apple Music (T6), Retry (failed only), Delete.

---

## 11. Deliverables

- `README.md`, short numbered steps for a non-technical Windows + iPhone user:
  1. What Tapedeck is (3 lines) and a personal-use note: "Tapedeck ships no music. You are responsible for following the terms of the sites you use."
  2. One-time setup (go live): the 6 steps of SPEC.md section 5.3, written out in full. Also: "Try it on your computer first: `cd web`, `npm install`, `npm run dev`, open http://localhost:3000, password `tapedeck-dev`"; the generated secrets are created by the builder; for people running their own copy, give a copy-paste command for Windows Command Prompt: `py -c "import secrets;print(secrets.token_hex(32))"`.
  3. PC downloader: download the repo as ZIP or clone into `C:\Users\<you>\Documents\tapedeck`, double-click `agent\install.bat`, then copy `APP_URL` and `AGENT_TOKEN` from the app's Profile > Downloader setup into the Notepad window.
  4. iPhone: open the app URL in Safari > Share > Add to Home Screen > open it from the home screen and log in there (the home screen app has its own login).
  5. Daily use: add songs anywhere; they download next time your PC is on; download playlists before flights.
  6. Apple Music (optional): turn on the setting, keep Apple Music open on the PC, sync your iPhone with the Apple Devices app.
  7. Not working? Songs stuck on Waiting: is the PC on and logged in, check `agent\logs\downloader.log`; downloads failing after working before: YouTube changed something, restart the PC so the downloader updates yt-dlp; "Search limit reached": YouTube's daily limit, paste links instead; data gone: Supabase project paused, restore it in Supabase; audio stops when locked: reopen the app from the home screen, not Safari.
- `web/.env.example`, `agent/.env.example`, `supabase/schema.sql`, `LICENSE` (MIT).

---

## 12. Known gotchas

- **Never run yt-dlp in the cloud.** Vercel and most servers get "Sign in to confirm you're not a bot" from YouTube. Only the PC downloader uses yt-dlp.
- **yt-dlp needs Deno and yt-dlp-ejs** for YouTube since 2025.11.12. Install `yt-dlp[default]` and Deno. Update yt-dlp at every downloader start.
- **SoundCloud Go+ tracks** may only download a 30-second preview. The 60% duration check fails them with a clear message.
- **iPhone home screen apps keep their own cookies**, separate from Safari. The owner must log in inside the home screen app. Use the 180-day cookie.
- **iPhone ignores `audio.volume`.** Hide the volume slider on touch devices.
- **One `<audio>` element only.** Creating new elements or awaiting network calls in `ended` can stop background auto-advance on iPhone. Pre-fetch the next URL.
- **Presigned URLs expire (6 h).** Fetch a fresh one right before each track starts; on a 403 during playback, refetch once and resume at the same position.
- **R2 CORS** must allow GET and HEAD from the app origin and expose `Content-Range` and `Accept-Ranges`, or offline downloads and seeking break.
- **R2 asks for a payment method** when enabled, even for the free tier.
- **Media Session artwork** must be an absolute https URL. iTunes and Deezer cover URLs are fine.
- **IndexedDB on iPhone can be cleared** when the phone is very low on space or the home screen app is deleted. Call `navigator.storage.persist()`; the library snapshot and downloads are re-fetchable.
- **Middleware must not block** the service worker, manifest, icons, `/api/agent/*` or the cron route, or the PWA and downloader break.
- **YouTube search quota** is about 100 searches a day. Cache results 24 h. `videos.list` (1 unit) is used for pasted links, so adding by link never runs out in practice.
- **Supabase grants:** the section 6 loop grants `service_role` only where that role exists, so the same file runs on PGlite.
- **PGlite vs Postgres:** write plain SQL both understand. No extensions, no `listen/notify`. `for update skip locked` works in both.
- **Serverless Postgres:** use the Supabase transaction pooler URL (port 6543) with `prepare: false`, or connections run out on Vercel.
- **Local storage is development only.** Production builds never fall back to it; they show the Setup page.
- **Atomic claim:** use `for update skip locked` so a restarted downloader never processes the same song twice.
- **Windows paths:** the downloader must handle spaces in paths (the owner's user folder contains a space). Quote every path.
- **"Today" and "this month" use America/Chicago**, not UTC.
- **No audio in the repo** except the two generated test tones.
- **Playwright WebKit is not a real iPhone.** It cannot lock the screen or prove background audio. Treat the `iphone` project as a stand-in and keep the real-device checks in the handoff.
- **yt-dlp from the build machine** will usually hit YouTube's bot check. That is expected: use `--selftest` for pipeline checks and only record the `--probe` result.
- **`@live` tests touch real services.** They must clean up everything they create, even when they fail (`afterAll` plus `scripts/cleanup-test-data.ts`).

---

## 13. Out of scope (possible next steps)

- Multiple users, sign-up, sharing
- Importing whole YouTube or SoundCloud playlists (YouTube `playlistItems.list` costs 1 unit per 50 songs, a good next step)
- SoundCloud search
- Always-on downloader on a Raspberry Pi (the downloader is plain Python and should run there unchanged later)
- Lyrics, video, visualisers, equaliser, crossfade
- Automatic Apple Music sync to the iPhone (needs a paid Apple Music subscription)
- App Store or native iOS app
- Recommendations or radio
