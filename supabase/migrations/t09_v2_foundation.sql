-- T9 (V2-PLAN.md): the columns the v2 tickets (T10 to T14) build on.

-- Catalog songs (T11): source = 'catalog', source_id = 'deezer:<id>' (or
-- 'import:<service>:<id>' for imported songs with no catalog match),
-- source_url = '' until the PC picks a copy.
alter table tracks drop constraint if exists tracks_source_check;
alter table tracks add constraint tracks_source_check
  check (source in ('youtube','soundcloud','catalog'));

alter table tracks
  add column isrc text,
  add column resolved_url text,              -- the copy the PC actually downloaded (T12)
  add column match_info jsonb,               -- chosen candidate, score, up to 5 alternatives (T12)
  add column auto_trim_start_sec numeric,    -- suggested by the PC (T10)
  add column auto_trim_end_sec numeric,
  add column trim_start_sec numeric,         -- set by hand; null means use the auto value (T10)
  add column trim_end_sec numeric,
  add column playback_rate numeric not null default 1
    constraint tracks_playback_rate_check check (playback_rate between 0.5 and 1.5),
  add column preserve_pitch boolean not null default true;

create index tracks_isrc_idx on tracks (isrc) where isrc is not null;
