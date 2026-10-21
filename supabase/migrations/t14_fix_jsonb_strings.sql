-- T14: repair jsonb written as a JSON string. Before this fix the app wrote
-- `${JSON.stringify(value)}::jsonb`, and the `postgres` driver stringified the
-- string again, so Postgres stored "[{...}]" (a string) instead of [{...}].
-- Reading `selected` with jsonb_array_elements then failed ("cannot extract
-- elements from a scalar") and every new import stopped with "Could not start
-- the import". Each statement only touches rows still stored as strings.

update import_jobs set selected = (selected #>> '{}')::jsonb
where jsonb_typeof(selected) = 'string';

update import_jobs set playlists = (playlists #>> '{}')::jsonb
where playlists is not null and jsonb_typeof(playlists) = 'string';

update import_jobs set payload = (payload #>> '{}')::jsonb
where jsonb_typeof(payload) = 'string';

-- `payload || <string>` on a string payload made an array of strings: merge
-- them back into one object, later writes winning, as `||` meant to.
update import_jobs j set payload = coalesce((
  select jsonb_object_agg(kv.key, kv.value order by e.n)
  from jsonb_array_elements(j.payload) with ordinality as e(value, n)
  cross join lateral (
    select case when jsonb_typeof(e.value) = 'string' then (e.value #>> '{}')::jsonb else e.value end as obj
  ) parsed
  cross join lateral jsonb_each(case when jsonb_typeof(parsed.obj) = 'object' then parsed.obj else '{}'::jsonb end) as kv
), '{}'::jsonb)
where jsonb_typeof(payload) = 'array';

-- These must be arrays (or null for playlists); anything else left is reset.
update import_jobs set selected = '[]'::jsonb where jsonb_typeof(selected) <> 'array';
update import_jobs set playlists = null where playlists is not null and jsonb_typeof(playlists) <> 'array';
update import_jobs set payload = '{}'::jsonb where jsonb_typeof(payload) <> 'object';

update tracks set match_info = (match_info #>> '{}')::jsonb
where match_info is not null and jsonb_typeof(match_info) = 'string';

-- Cached searches are rebuilt on the next search.
delete from search_cache where jsonb_typeof(results) = 'string';
