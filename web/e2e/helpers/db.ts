import { sql } from '../../lib/db';
import { getStorage } from '../../lib/storage';
import { appEnv } from './env';

/*
 * SPEC 9.0: seeding and cleanup go through the app's own db.ts and
 * storage.ts — the same modules the webServer process runs. The app reads its
 * env lazily (the sql handle forwards to getDb() on first use, getStorage()
 * reads env per call), so applying the test contract here, before any test
 * touches sql or storage, is what puts this worker process in the same
 * stand-in mode the webServer got: TAPEDECK_TEST=1 → in-memory PGlite, local
 * storage rooted in the run's temp dir, throwaway test secrets.
 *
 * In-memory PGlite is per-process (a fresh database per run, SPEC 4.1), so
 * data seeded through this module is visible to the app only against a
 * shared database; stand-in tests drive app-visible data through the API and
 * UI instead. These helpers serve @live runs and in-process probes.
 */
Object.assign(process.env, appEnv());

export type SeedTrackInput = {
  source: 'youtube' | 'soundcloud';
  sourceId: string;
  sourceUrl: string;
  rawTitle: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  status?: 'waiting' | 'downloading' | 'ready' | 'failed';
  storageKey?: string | null;
  durationSec?: number | null;
};

export type SeededTrack = {
  id: string;
  source: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  artist: string;
  status: string;
  storageKey: string | null;
};

function rowToTrack(row: Record<string, unknown>): SeededTrack {
  return {
    id: String(row.id),
    source: String(row.source),
    sourceId: String(row.source_id),
    sourceUrl: String(row.source_url),
    title: String(row.title),
    artist: String(row.artist),
    status: String(row.status),
    storageKey: row.storage_key == null ? null : String(row.storage_key),
  };
}

// Idempotent seed: re-seeding the same (source, source_id) updates in place.
// Columns mirror SPEC section 6.
export async function seedTrack(input: SeedTrackInput): Promise<SeededTrack> {
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title, artist, album, album_artist, status, storage_key, duration_sec)
    values (${input.source}, ${input.sourceId}, ${input.sourceUrl}, ${input.rawTitle}, ${input.title ?? input.rawTitle},
            ${input.artist ?? ''}, ${input.album ?? null}, ${input.albumArtist ?? null}, ${input.status ?? 'waiting'},
            ${input.storageKey ?? null}, ${input.durationSec ?? null})
    on conflict (source, source_id) do update set
      raw_title = excluded.raw_title, title = excluded.title, artist = excluded.artist,
      album = excluded.album, album_artist = excluded.album_artist, status = excluded.status,
      storage_key = excluded.storage_key, duration_sec = excluded.duration_sec, error = ''
    returning id, source, source_id, source_url, title, artist, status, storage_key
  `;
  return rowToTrack(rows[0]);
}

export async function getTrackById(id: string): Promise<SeededTrack | null> {
  const rows = await sql`select id, source, source_id, source_url, title, artist, status, storage_key from tracks where id = ${id}`;
  return rows.length > 0 ? rowToTrack(rows[0]) : null;
}

// One statement, all FK-referenced tables included (plain SQL both PGlite and
// Postgres understand, SPEC 12). settings is left intact.
export async function clearLibraryData(): Promise<void> {
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events, search_cache`;
}

// For the "Downloader online/offline" checks (SPEC 8.3): `secondsAgo = 180`
// makes the header show offline; null clears the row value.
export async function setAgentLastSeen(secondsAgo: number | null): Promise<void> {
  if (secondsAgo === null) {
    await sql`update settings set agent_last_seen = null where id = 1`;
    return;
  }
  await sql`update settings set agent_last_seen = now() - make_interval(secs => ${secondsAgo}) where id = 1`;
}

// SPEC 4.1 storage contract: head(key) surfaces whether the stored file
// exists ("the stored file exists", SPEC 9.0 selftest checks). The driver's
// discriminated result { exists: true; bytes } | { exists: false } is the
// source of truth; driver errors propagate — never swallowed.
export async function trackFileExists(storageKey: string): Promise<boolean> {
  const head = await getStorage().head(storageKey);
  return head.exists;
}
