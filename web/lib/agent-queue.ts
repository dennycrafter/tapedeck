/**
 * Download-queue mechanics (SPEC 8.3): the state machine the PC downloader
 * drives through /api/agent/* and the library UI drives through the retry
 * route. Pure database logic, no HTTP: routes stay thin and the mechanics
 * are unit-testable against the real adapter (in-memory PGlite, SPEC 4.1).
 *
 * Concurrency: the claim is one data-modifying CTE whose inner
 * `for update skip locked` makes two parallel claims disjoint: a claimer
 * skips rows another claimer currently holds, so the same track is never
 * handed out twice. The stale-claim reset runs as its own statement BEFORE
 * the claim CTE (not a sibling CTE) because Postgres CTEs share one
 * snapshot: a row reset by a sibling CTE would not be visible to the
 * claiming part until the next poll. Sequence it instead and a recovered
 * track is re-claimable immediately.
 */

import { sql, type Row } from './db'
import type { MatchInfo } from './track-v2'

/** The one storage key layout (SPEC 4): `tracks/<track_id>.m4a`. */
export function trackKey(trackId: string): string {
  return `tracks/${trackId}.m4a`
}

/**
 * A row as POST /api/agent/claim returns it to the downloader (SPEC 8.3).
 * Keys are the database columns on purpose: SPEC 8.3 names this exact
 * field list (snake_case), and agent/downloader.py's ClaimedTrack maps it.
 */
export interface ClaimedTrack {
  id: string
  source: 'youtube' | 'soundcloud' | 'catalog'
  source_url: string
  title: string
  artist: string
  album: string | null
  cover_url: string | null
  duration_sec: number | null
  apple_music: boolean
  /** v2 (V2-PLAN T9): catalog ISRC, when known. */
  isrc: string | null
  /** v2: `source_id` for catalog rows (for example `deezer:3135556`), else null. */
  catalog_id: string | null
  /** v2: a copy already chosen (T12 "Pick another version"); download exactly this. */
  resolved_url: string | null
}

/**
 * What a downloader says it can do on claim (V2-PLAN T9). `catalog`: it can
 * find a copy for catalog songs (T12). Older downloaders send nothing and are
 * never handed catalog rows.
 */
export type AgentCapability = 'catalog' | (string & {})

/** SPEC 8.3: a downloading row claimed longer ago than this is stale. */
export const STALE_CLAIM_SECONDS = 15 * 60
/** SPEC 8.3: claim up to this many waiting tracks per poll, oldest first. */
export const CLAIM_BATCH = 3
/** SPEC 8.3: after this many attempts a failed track stays failed. */
export const MAX_ATTEMPTS = 3

/**
 * Reset stale claims: any `downloading` row whose claim is older than 15
 * minutes goes back to `waiting` (the downloader died mid-job). Returns the
 * number of rows recovered.
 */
export async function resetStaleClaims(): Promise<number> {
  const rows = await sql`
    update tracks
    set status = 'waiting'
    where status = 'downloading'
      and claimed_at < now() - make_interval(secs => ${STALE_CLAIM_SECONDS})
    returning id`
  return rows.length
}

function toClaimedTrack(row: Row): ClaimedTrack {
  return {
    id: String(row.id),
    source: row.source === 'soundcloud' || row.source === 'catalog' ? row.source : 'youtube',
    source_url: String(row.source_url),
    title: String(row.title),
    artist: String(row.artist),
    album: (row.album as string | null) ?? null,
    cover_url: (row.cover_url as string | null) ?? null,
    duration_sec: (row.duration_sec as number | null) ?? null,
    apple_music: row.apple_music === true,
    isrc: (row.isrc as string | null) ?? null,
    catalog_id: row.source === 'catalog' ? String(row.source_id) : null,
    resolved_url: (row.resolved_url as string | null) || null,
  }
}

/**
 * Atomically claim up to `limit` waiting tracks, oldest first (SPEC 8.3):
 * reset stale claims, then set status='downloading', claimed_at=now() and
 * attempts = attempts + 1 on up to `limit` waiting rows and return them.
 */
export async function claimTracks(
  limit: number = CLAIM_BATCH,
  capabilities: readonly AgentCapability[] = [],
): Promise<ClaimedTrack[]> {
  await resetStaleClaims()
  const takesCatalog = capabilities.includes('catalog')

  const rows = await sql`
    with picked as (
      select id from tracks
      where status = 'waiting'
        and (source <> 'catalog' or ${takesCatalog})
      order by created_at
      limit ${limit}
      for update skip locked
    ),
    claimed as (
      update tracks t
      set status = 'downloading', claimed_at = now(), attempts = t.attempts + 1
      from picked p
      where t.id = p.id
      returning t.id, t.source, t.source_id, t.source_url, t.title, t.artist, t.album,
                t.cover_url, t.duration_sec, t.apple_music, t.isrc, t.resolved_url, t.created_at
    )
    select id, source, source_id, source_url, title, artist, album, cover_url, duration_sec,
           apple_music, isrc, resolved_url
    from claimed
    order by created_at`
  return rows.map(toClaimedTrack)
}

/**
 * Mark the downloader as seen (SPEC 8.3: "Also updates settings.agent_last_seen").
 * A non-empty `version` is stored as agent_version (recorded on the agent's
 * first run and whenever it upgrades); null/undefined keeps the stored one.
 */
export async function recordAgentSeen(version?: string | null): Promise<void> {
  await sql`
    update settings
    set agent_last_seen = now(), agent_version = coalesce(${version ?? null}, agent_version)
    where id = 1`
}

export interface CompleteInput {
  trackId: string
  key: string
  bytes: number
  /** Real duration from ffprobe; omitted/null leaves the stored value. */
  durationSec?: number | null
  /** v2 (V2-PLAN T9): the copy that was downloaded (T12). Omitted keeps the stored value. */
  resolvedUrl?: string | null
  /** v2: how the copy was chosen (T12). Omitted keeps the stored value. */
  matchInfo?: MatchInfo | null
  /** v2: trim suggested by the PC (T10). Omitted keeps the stored value. */
  autoTrimStartSec?: number | null
  autoTrimEndSec?: number | null
}

/**
 * Complete a download (SPEC 8.3): status='ready' with the storage key,
 * byte size and duration, ready_at=now(), error cleared. Returns false when
 * the track does not exist (it may have been deleted mid-download).
 */
export async function completeTrack(input: CompleteInput): Promise<boolean> {
  const durationSec =
    input.durationSec == null ? null : Math.round(input.durationSec)
  const matchInfo = input.matchInfo == null ? null : JSON.stringify(input.matchInfo)
  const rows = await sql`
    update tracks
    set status = 'ready',
        storage_key = ${input.key},
        bytes = ${input.bytes},
        duration_sec = coalesce(${durationSec}, duration_sec),
        resolved_url = coalesce(${input.resolvedUrl ?? null}, resolved_url),
        match_info = coalesce(${matchInfo}::jsonb, match_info),
        auto_trim_start_sec = coalesce(${input.autoTrimStartSec ?? null}::numeric, auto_trim_start_sec),
        auto_trim_end_sec = coalesce(${input.autoTrimEndSec ?? null}::numeric, auto_trim_end_sec),
        ready_at = now(),
        error = ''
    where id = ${input.trackId}
    returning id`
  return rows.length > 0
}

/**
 * Report a failed download (SPEC 8.3): back to `waiting` while attempts
 * allow another try, `failed` afterwards. Stores the first 500 characters
 * of the error. Returns the new status, or null for an unknown track.
 */
export async function failTrack(
  trackId: string,
  error: string,
  /** v2 (V2-PLAN T9): "no good match" still saves the alternatives (T12). */
  matchInfo?: MatchInfo | null,
): Promise<'waiting' | 'failed' | null> {
  const matchJson = matchInfo == null ? null : JSON.stringify(matchInfo)
  const rows = await sql`
    update tracks
    set status = case when attempts < ${MAX_ATTEMPTS} then 'waiting' else 'failed' end,
        error = left(${error}, 500),
        match_info = coalesce(${matchJson}::jsonb, match_info)
    where id = ${trackId}
    returning status`
  const status = rows[0]?.status
  return status === 'failed' ? 'failed' : status === 'waiting' ? 'waiting' : null
}

/** The stored length of a track in seconds, or null when unknown or the track is gone. */
export async function storedDurationSec(trackId: string): Promise<number | null> {
  const rows = await sql`select duration_sec from tracks where id = ${trackId}`
  const value = rows[0]?.duration_sec
  return value == null ? null : Number(value)
}

/**
 * UI "Retry" on a failed track (SPEC 8.3): status='waiting', attempts=0,
 * error cleared. Returns false when the track does not exist.
 */
export async function retryTrack(trackId: string): Promise<boolean> {
  const rows = await sql`
    update tracks
    set status = 'waiting', attempts = 0, error = ''
    where id = ${trackId}
    returning id`
  return rows.length > 0
}

/**
 * Downloader reports the Apple Music copy step done (SPEC 8.3, used by T6).
 * Returns false when the track does not exist.
 */
export async function markAppleMusicDone(trackId: string): Promise<boolean> {
  const rows = await sql`
    update tracks
    set apple_music_done_at = now()
    where id = ${trackId}
    returning id`
  return rows.length > 0
}
