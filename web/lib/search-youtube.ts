/**
 * YouTube search (SPEC 7.3 line 287, 8.7) — the one surface with a real
 * quota, so it is guarded three ways: it only runs when the owner presses
 * Enter or the Search button (the Add window's job), the raw YouTube result
 * is cached in `search_cache` for 24 hours, and a quota error surfaces the
 * SPEC message instead of a raw failure. One `search.list` call plus one
 * `videos.list` call per fresh query; the inLibrary flag is merged per
 * request so the cache never goes stale on it.
 *
 * Without YOUTUBE_API_KEY search is off (SPEC 4.1): the caller gets the
 * stand-in message, never a failure. Every outbound call goes through
 * lib/http.ts (4.1) so MSW intercepts everything in tests.
 */

import { HttpError, httpJson } from './http'
import { parseIsoDuration } from './metadata'
import { sql, type Row } from './db'

export interface SearchResult {
  videoId: string
  /** Raw YouTube title — cleanup happens when the result is added (8.2). */
  title: string
  channel: string
  thumbnailUrl: string | null
  durationSec: number | null
  inLibrary: boolean
}

/** SPEC 4.1: "Search box shows 'Add a YouTube key to turn on search'." */
export const SEARCH_OFF_MESSAGE = 'Add a YouTube key to turn on search'

/** SPEC 7.3: "Search limit reached for today. Paste a link instead, or try again tomorrow." */
export const SEARCH_QUOTA_MESSAGE =
  'Search limit reached for today. Paste a link instead, or try again tomorrow.'

/** The search.list call was refused for quota (HTTP 403, reason quotaExceeded). */
export class SearchQuotaError extends Error {
  constructor() {
    super('YouTube search quota exceeded')
    this.name = 'SearchQuotaError'
  }
}

interface SearchListResponse {
  items?: {
    id?: { videoId?: string }
    snippet?: { title?: string; channelTitle?: string; thumbnails?: { high?: { url?: string } } }
  }[]
}

interface VideosListResponse {
  items?: { id?: string; contentDetails?: { duration?: string } }[]
}

/** The part of a cached/merged result that comes from YouTube itself. */
interface CachedHit {
  videoId: string
  title: string
  channel: string
  thumbnailUrl: string | null
  durationSec: number | null
}

/** The watch URL a result's "Open on YouTube" link and "Add" button use. */
export function resultUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
}

/** `search_cache.q` normalization (SPEC 6: lowercased, trimmed query). */
export function searchCacheKey(query: string): string {
  return query.trim().toLowerCase()
}

/** search.list items → hits in returned order; items without an id or title are dropped. */
export function parseSearchList(body: SearchListResponse): CachedHit[] {
  const hits: CachedHit[] = []
  for (const item of body.items ?? []) {
    const videoId = item.id?.videoId
    const title = item.snippet?.title
    if (!videoId || !title) continue
    hits.push({
      videoId,
      title,
      channel: item.snippet?.channelTitle ?? '',
      thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? null,
      durationSec: null,
    })
  }
  return hits
}

/** videos.list items → videoId → duration in seconds (SPEC 7.3). */
export function parseVideoDurations(body: VideosListResponse): Map<string, number | null> {
  const durations = new Map<string, number | null>()
  for (const item of body.items ?? []) {
    if (item.id) durations.set(item.id, item.contentDetails ? parseIsoDuration(item.contentDetails.duration ?? '') : null)
  }
  return durations
}

function quotaError(cause: unknown): boolean {
  if (!(cause instanceof HttpError)) return false
  if (cause.status !== 403) return false
  return cause.bodyExcerpt?.includes('quotaExceeded') ?? false
}

const CACHE_TTL_SQL = "interval '24 hours'"

async function readCache(key: string): Promise<CachedHit[] | null> {
  const rows = (await sql`
    select results from search_cache
    where q = ${key} and created_at > now() - ${sql.raw(CACHE_TTL_SQL)}
  `) as (Row & { results: unknown })[]
  const results = rows[0]?.results
  return Array.isArray(results) ? (results as CachedHit[]) : null
}

async function writeCache(key: string, hits: CachedHit[]): Promise<void> {
  await sql`
    insert into search_cache (q, results) values (${key}, ${JSON.stringify(hits)}::jsonb)
    on conflict (q) do update set results = excluded.results, created_at = now()
  `
}

/** Flip inLibrary on the hits that are already tracks (source 'youtube', matching source_id). */
async function markInLibrary(hits: CachedHit[]): Promise<SearchResult[]> {
  if (hits.length === 0) return []
  const params = hits.map((hit) => hit.videoId)
  const list = params.map((_, index) => `$${index + 1}`).join(', ')
  const rows = (await sql.unsafe(
    `select source_id from tracks where source = 'youtube' and source_id in (${list})`,
    params,
  )) as (Row & { source_id: string })[]
  const owned = new Set(rows.map((row) => row.source_id))
  return hits.map((hit) => ({ ...hit, inLibrary: owned.has(hit.videoId) }))
}

/**
 * One search round trip (8.7): cache hit → merge inLibrary and return; miss
 * → search.list, one videos.list for durations, store the cache, merge.
 * Without an API key: `{ results: [], message: SEARCH_OFF_MESSAGE }`.
 * Quota exhaustion throws `SearchQuotaError`; the route maps it to the SPEC
 * message. Never throws for anything else except programming errors —
 * network failures bubble as HttpError for the route's 502.
 */
export async function searchYoutube(
  query: string,
  apiKey: string | undefined,
): Promise<{ results: SearchResult[]; message?: string }> {
  if (!apiKey) return { results: [], message: SEARCH_OFF_MESSAGE }

  const key = searchCacheKey(query)
  const cached = await readCache(key)
  let hits = cached
  if (!hits) {
    const searchUrl =
      'https://www.googleapis.com/youtube/v3/search' +
      '?part=snippet&type=video&videoCategoryId=10&maxResults=10' +
      `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`
    let searchBody: SearchListResponse
    try {
      searchBody = await httpJson<SearchListResponse>(searchUrl)
    } catch (cause) {
      if (quotaError(cause)) throw new SearchQuotaError()
      throw cause
    }
    hits = parseSearchList(searchBody)

    if (hits.length > 0) {
      const ids = hits.map((hit) => hit.videoId)
      const videosUrl =
        'https://www.googleapis.com/youtube/v3/videos' +
        `?part=contentDetails&id=${ids.map(encodeURIComponent).join(',')}` +
        `&key=${encodeURIComponent(apiKey)}`
      const durations = parseVideoDurations(await httpJson<VideosListResponse>(videosUrl))
      hits = hits.map((hit) => ({ ...hit, durationSec: durations.get(hit.videoId) ?? null }))
      await writeCache(key, hits)
    }
  }
  return { results: await markInLibrary(hits) }
}
