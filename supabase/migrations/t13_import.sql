-- T13 (V2-PLAN.md): playlist import. One row per import (import_jobs) and
-- one row per song of every ticked playlist (import_items). RLS and the
-- service_role grant are applied by the migration runner (web/lib/migrations.ts).
--
-- Job status, in the order a job usually moves:
--   login       waiting for the owner to come back from a log-in page
--   new         ready to list the playlists (also after the PC finished listing)
--   waiting_pc  the PC has work to do for this job (SoundCloud and YouTube
--               listing needs yt-dlp); the downloader claims it (claimed_at,
--               attempts) and hands the result back
--   listed      the checklist is ready
--   importing   the browser is driving the import, 50 songs per request
--   done        every ticked song is in the library (the PC may still be downloading)
--   failed      listing failed for good; `error` says why in plain words
create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  service text not null,                    -- the music service, e.g. 'spotify', 'apple', 'soundcloud'
  importer text not null,                   -- the adapter in web/lib/importers, e.g. 'spotify-link'
  method text not null check (method in ('login','link','file')),
  status text not null default 'new'
    check (status in ('login','new','waiting_pc','listed','importing','done','failed')),
  error text not null default '',
  payload jsonb not null default '{}'::jsonb,   -- the adapter's own data: pasted links, provider user id, PC results
  playlists jsonb,                          -- the checklist once listed: [{ ref, name, coverUrl, trackCount, kind }]
  selected jsonb not null default '[]'::jsonb,  -- ticked playlists: [{ ref, name, playlistId, cursor, fetched }]
  attempts int not null default 0,          -- PC claims so far (waiting_pc)
  claimed_at timestamptz,                   -- when the PC took it; stale claims are taken again
  locked_until timestamptz,                 -- one import request at a time per job
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index import_jobs_status_idx on import_jobs (status, created_at);
create index import_jobs_service_idx on import_jobs (service, created_at);

-- Item status: pending (not matched yet), added (a new song), already (the
-- song was in the library), skipped (the owner pressed Skip), error.
-- playlist_id and track_id are plain ids, not foreign keys: a song or
-- playlist deleted later simply stops counting, and tables that tests and
-- the app truncate or delete from (tracks, playlists) gain no new references.
create table import_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references import_jobs(id) on delete cascade,
  playlist_ref text not null,               -- the source's own playlist id ('liked' for liked songs)
  playlist_name text not null,
  playlist_id uuid,                         -- the Tapedeck playlist it goes into
  position int not null,                    -- order inside the source playlist, from 0
  title text not null,
  artist text not null default '',
  album text,
  duration_sec int,
  isrc text,
  cover_url text,                           -- the source's own cover, used when the catalog has no match
  source_ref text not null default '',      -- the source's own song id (import:<service>:<source_ref> when unmatched)
  link text,                                -- a direct YouTube or SoundCloud song link: the song keeps it
  status text not null default 'pending'
    check (status in ('pending','added','already','skipped','error')),
  match text,                               -- how it was matched: isrc, search, none or link
  error text not null default '',
  track_id uuid,                            -- the library song, once added
  created_at timestamptz not null default now()
);
create index import_items_job_idx on import_items (job_id, status, playlist_ref, position);
create index import_items_track_idx on import_items (track_id) where track_id is not null;
