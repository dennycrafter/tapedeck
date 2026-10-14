/**
 * The exact contents of supabase/schema.sql, embedded as a string.
 *
 * The file lives outside the web/ build root, so it is not bundled to the
 * Vercel lambda that runs Finish setup (SPEC 8.12), so the SQL travels with
 * the route instead. A drift test (schema-sql.test.ts) fails if this copy
 * and the source file diverge; edit supabase/schema.sql and regenerate.
 *
 * Generated from supabase/schema.sql. Do not edit by hand.
 */
export const SCHEMA_SQL = `-- gen_random_uuid() is built into Postgres 13+ and PGlite, no extension needed.

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
`;
