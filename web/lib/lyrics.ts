/**
 * Lyrics (T16), server side: find a song's lyrics on LRCLIB (lrclib.net, free,
 * no account) and remember the answer.
 *
 *   1. /api/get with the title, artist and the file's length (LRCLIB matches
 *      lengths within 2 s). The album is left out: titles cleaned from a
 *      YouTube video often carry no album or another one.
 *   2. Not found: /api/search with the title and artist, keeping only
 *      results that are the same song, the best first (timed lyrics of the
 *      same length, then any timed lyrics, then words only).
 *   3. Still nothing and the title has a "(...)" or "[...]" part ("Song
 *      (Remastered 2011)"): both again without it.
 *
 * Timed lines are used only when the found song's length is within
 * SYNC_TOLERANCE_SEC of the file's, otherwise its words are shown untimed.
 * Answers are cached in `search_cache` under `lyrics:` keys: found ones for
 * 30 days, "none" for a day (LRCLIB adds missing songs over time). A failed
 * or rate-limited lookup is not cached. LRCLIB asks clients to say who they
 * are (User-Agent) and to honour Retry-After; a 429 simply answers
 * "unavailable" until a later try.
 */
import { sql, type Row } from './db'
import { fixtureLyricsResponse, lyricsUseFixtures } from './lyrics-fixtures'
import { SYNC_TOLERANCE_SEC, type LyricLine, type LyricsResult } from './lyrics-types'

export const LRCLIB_BASE = 'https://lrclib.net'
export const LRCLIB_USER_AGENT = 'Tapedeck (https://github.com/dennycrafter/tapedeck)'
const FETCH_TIMEOUT_MS = 8000
const CACHE_PREFIX = 'lyrics:'
const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000
const NONE_TTL_MS = 24 * 60 * 60 * 1000

/** The fields Tapedeck reads from an LRCLIB lyrics record. */
export interface LrclibRecord {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string | null
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

export interface LyricsQuery {
  title: string
  artist: string
  /** The file's length in seconds; null when unknown. */
  durationSec: number | null
}

export type LrclibFetch = (url: string) => Promise<{ status: number; body: unknown }>

class LyricsUnavailable extends Error {}

// ---------------------------------------------------------------------------
// LRC parsing
// ---------------------------------------------------------------------------

const LINE_TIMES = /^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+)(.*)$/
const ONE_TIME = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_TIMES = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g
const OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]$/i

/**
 * LRC text to timed lines, in time order. Lines may carry several times
 * ("[00:12.00][01:30.00] chorus"); tags like "[ar: ...]" are skipped;
 * "[offset: +250]" moves every line 0.25 s earlier, as the LRC format says;
 * word times ("<00:12.50>") are dropped. Empty lines stay as breaks.
 */
export function parseLrc(text: string): LyricLine[] {
  let offsetSec = 0
  const lines: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const offset = OFFSET.exec(line)
    if (offset) {
      offsetSec = Number(offset[1]) / 1000
      continue
    }
    const match = LINE_TIMES.exec(line)
    if (!match) continue
    const words = match[2]!.replace(WORD_TIMES, '').replace(/\s+/g, ' ').trim()
    for (const time of match[1]!.matchAll(ONE_TIME)) {
      const fraction = time[3] ? Number(`0.${time[3]}`) : 0
      lines.push({ time: Number(time[1]) * 60 + Number(time[2]) + fraction, text: words })
    }
  }
  return lines
    .map((line) => ({ ...line, time: Math.max(0, Math.round((line.time - offsetSec) * 1000) / 1000) }))
    .sort((a, b) => a.time - b.time)
}

// ---------------------------------------------------------------------------
// Picking a record
// ---------------------------------------------------------------------------

/** "Señor (Live)" and "senor" compare equal; brackets and punctuation go. */
export function songKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function sameText(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  return short.length >= 3 && long.includes(short)
}

/** A search result that is the same song (title, and artist when known). */
export function sameSong(record: LrclibRecord, query: LyricsQuery): boolean {
  if (!sameText(songKey(record.trackName ?? ''), songKey(query.title))) return false
  const artist = songKey(query.artist)
  return !artist || sameText(songKey(record.artistName ?? ''), artist)
}

function lengthFits(record: LrclibRecord, durationSec: number | null): boolean {
  return durationSec === null || typeof record.duration !== 'number' || Math.abs(record.duration - durationSec) <= SYNC_TOLERANCE_SEC
}

/** What one record means for this copy of the song. */
export function resultFromRecord(record: LrclibRecord, durationSec: number | null): LyricsResult {
  if (record.instrumental) return { status: 'instrumental' }
  const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : []
  if (synced.some((line) => line.text) && lengthFits(record, durationSec)) return { status: 'synced', lines: synced }
  const plain =
    record.plainLyrics?.trim() ||
    synced
      .map((line) => line.text)
      .filter(Boolean)
      .join('\n')
  return plain ? { status: 'plain', text: plain } : { status: 'none' }
}

function rank(record: LrclibRecord, durationSec: number | null): number {
  const hasSynced = Boolean(record.syncedLyrics?.trim())
  if (hasSynced && lengthFits(record, durationSec)) return 0
  if (hasSynced) return 1
  if (record.plainLyrics?.trim()) return 2
  return record.instrumental ? 3 : 4
}

/** The best search result for this song, or null. */
export function pickRecord(records: LrclibRecord[], query: LyricsQuery): LrclibRecord | null {
  const candidates = records.filter((record) => sameSong(record, query) && rank(record, query.durationSec) < 4)
  candidates.sort((a, b) => {
    const byRank = rank(a, query.durationSec) - rank(b, query.durationSec)
    if (byRank !== 0 || query.durationSec === null) return byRank
    return Math.abs((a.duration ?? 0) - query.durationSec) - Math.abs((b.duration ?? 0) - query.durationSec)
  })
  return candidates[0] ?? null
}

// ---------------------------------------------------------------------------
// Looking up
// ---------------------------------------------------------------------------

const liveFetch: LrclibFetch = async (url) => {
  const response = await fetch(url, {
    headers: { 'User-Agent': LRCLIB_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

function defaultFetch(): LrclibFetch {
  return lyricsUseFixtures() ? async (url) => fixtureLyricsResponse(url) : liveFetch
}

function lrclibUrl(path: string, params: Record<string, string>): string {
  return `${LRCLIB_BASE}${path}?${new URLSearchParams(params).toString()}`
}

async function call(fetchJson: LrclibFetch, url: string): Promise<{ status: number; body: unknown }> {
  let answer: { status: number; body: unknown }
  try {
    answer = await fetchJson(url)
  } catch (error) {
    throw new LyricsUnavailable(String(error))
  }
  // 404 is "not found"; 429 (slow down) and 5xx are "try later".
  if (answer.status === 404 || (answer.status >= 200 && answer.status < 300)) return answer
  throw new LyricsUnavailable(`LRCLIB answered ${answer.status}`)
}

async function lookOnce(query: LyricsQuery, fetchJson: LrclibFetch): Promise<LyricsResult | null> {
  if (query.artist) {
    const params: Record<string, string> = { track_name: query.title, artist_name: query.artist }
    if (query.durationSec !== null && query.durationSec >= 1 && query.durationSec <= 3600) {
      params.duration = String(Math.round(query.durationSec))
    }
    const got = await call(fetchJson, lrclibUrl('/api/get', params))
    if (got.status !== 404 && got.body && typeof got.body === 'object') {
      return resultFromRecord(got.body as LrclibRecord, query.durationSec)
    }
  }
  const params: Record<string, string> = { track_name: query.title }
  if (query.artist) params.artist_name = query.artist
  const found = await call(fetchJson, lrclibUrl('/api/search', params))
  const records = Array.isArray(found.body) ? (found.body as LrclibRecord[]) : []
  const best = pickRecord(records, query)
  return best ? resultFromRecord(best, query.durationSec) : null
}

/** Ask LRCLIB (no cache). "unavailable" when it could not answer. */
export async function findLyrics(query: LyricsQuery, fetchJson: LrclibFetch = defaultFetch()): Promise<LyricsResult> {
  const title = query.title.trim()
  if (!title) return { status: 'none' }
  const clean = { ...query, title, artist: query.artist.trim() }
  try {
    const first = await lookOnce(clean, fetchJson)
    if (first && first.status !== 'none') return first
    const bare = title.replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim()
    if (bare && bare !== title) {
      const second = await lookOnce({ ...clean, title: bare }, fetchJson)
      if (second) return second
    }
    return first ?? { status: 'none' }
  } catch (error) {
    if (error instanceof LyricsUnavailable) {
      console.warn('[lyrics] LRCLIB unavailable:', error.message)
      return { status: 'unavailable' }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Cache (search_cache, `lyrics:` keys)
// ---------------------------------------------------------------------------

export function lyricsCacheKey(query: LyricsQuery): string {
  const length = query.durationSec === null ? '' : String(Math.round(query.durationSec))
  return `${CACHE_PREFIX}${songKey(query.title)}|${songKey(query.artist)}|${length}`
}

async function readCache(key: string): Promise<LyricsResult | null> {
  const rows = (await sql`select results, created_at from search_cache where q = ${key}`) as Row[]
  const row = rows[0]
  if (!row) return null
  const value = (typeof row.results === 'string' ? JSON.parse(row.results) : row.results) as LyricsResult | null
  if (!value || typeof value !== 'object') return null
  const age = Date.now() - new Date(String(row.created_at)).getTime()
  return age < (value.status === 'none' ? NONE_TTL_MS : FOUND_TTL_MS) ? value : null
}

async function writeCache(key: string, value: LyricsResult): Promise<void> {
  await sql`
    insert into search_cache (q, results) values (${key}, ${JSON.stringify(value)}::text::jsonb)
    on conflict (q) do update set results = excluded.results, created_at = now()
  `
}

/** Cached lyrics for a song, looked up when missing or stale. */
export async function getLyrics(query: LyricsQuery, fetchJson?: LrclibFetch): Promise<LyricsResult> {
  const key = lyricsCacheKey(query)
  const cached = await readCache(key)
  if (cached) return cached
  const result = await findLyrics(query, fetchJson)
  if (result.status !== 'unavailable') await writeCache(key, result)
  return result
}
