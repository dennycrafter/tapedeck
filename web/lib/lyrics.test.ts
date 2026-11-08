/**
 * Lyrics (T16): LRC parsing, picking a record, the LRCLIB calls (fake fetch),
 * the cache, and the route. Every lyric line here is made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from './db'
import {
  findLyrics,
  getLyrics,
  LRCLIB_USER_AGENT,
  lyricsCacheKey,
  parseLrc,
  pickRecord,
  resultFromRecord,
  sameSong,
  type LrclibFetch,
  type LrclibRecord,
} from './lyrics'
import { activeLineIndex, isLyricsResult } from './lyrics-types'
import { lyricsUseFixtures } from './lyrics-fixtures'
import { GET as lyricsRoute } from '../app/api/tracks/[id]/lyrics/route'

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await sql`truncate tracks, search_cache cascade`
})

const SYNCED = '[00:01.00] One\n[00:02.50] Two\n[00:04.00] Three\n'

function record(overrides: Partial<LrclibRecord> = {}): LrclibRecord {
  return { id: 1, trackName: 'Night Drive', artistName: 'The Made Ups', duration: 200, instrumental: false, plainLyrics: 'One\nTwo\nThree', syncedLyrics: SYNCED, ...overrides }
}

/** A fake LRCLIB: answers per path, records every URL asked. */
function fakeLrclib(answers: Record<string, { status: number; body: unknown }>) {
  const urls: string[] = []
  const fetchJson: LrclibFetch = async (url) => {
    urls.push(url)
    const path = new URL(url).pathname
    return answers[path] ?? { status: 404, body: {} }
  }
  return { urls, fetchJson }
}

describe('parseLrc', () => {
  it('reads timed lines in order, with several times per line, and skips tags', () => {
    expect(parseLrc('[ar: Someone]\n[00:12.50] B\n[00:01.2]A\n[01:02.345][00:20.00] Chorus\nnot timed\n[00:30.00]\n')).toEqual([
      { time: 1.2, text: 'A' },
      { time: 12.5, text: 'B' },
      { time: 20, text: 'Chorus' },
      { time: 30, text: '' },
      { time: 62.345, text: 'Chorus' },
    ])
  })

  it('applies [offset] and drops word times', () => {
    expect(parseLrc('[offset: +500]\n[00:02.00] <00:02.00>Hello <00:02.40>there\n')).toEqual([{ time: 1.5, text: 'Hello there' }])
    expect(parseLrc('[offset:-1000]\n[00:00.00] Start\n[00:00.50] x\n')[0]).toEqual({ time: 1, text: 'Start' })
  })
})

describe('activeLineIndex', () => {
  const lines = parseLrc(SYNCED)
  it('is the last line that has started', () => {
    expect(activeLineIndex(lines, 0.5)).toBe(-1)
    expect(activeLineIndex(lines, 1)).toBe(0)
    expect(activeLineIndex(lines, 3)).toBe(1)
    expect(activeLineIndex(lines, 99)).toBe(2)
    expect(activeLineIndex([], 5)).toBe(-1)
  })
})

describe('resultFromRecord and pickRecord', () => {
  it('uses timed lines only when the lengths fit', () => {
    expect(resultFromRecord(record(), 201)).toMatchObject({ status: 'synced', lines: [{ time: 1, text: 'One' }, {}, {}] })
    expect(resultFromRecord(record(), null)).toMatchObject({ status: 'synced' })
    expect(resultFromRecord(record(), 230)).toEqual({ status: 'plain', text: 'One\nTwo\nThree' })
    expect(resultFromRecord(record({ plainLyrics: null }), 230)).toEqual({ status: 'plain', text: 'One\nTwo\nThree' })
    expect(resultFromRecord(record({ instrumental: true, plainLyrics: null, syncedLyrics: null }), 200)).toEqual({ status: 'instrumental' })
    expect(resultFromRecord(record({ plainLyrics: '', syncedLyrics: null }), 200)).toEqual({ status: 'none' })
  })

  it('keeps only the same song and prefers timed lyrics of the same length', () => {
    const query = { title: 'Night Drive (Remastered)', artist: 'The Made Ups', durationSec: 200 }
    expect(sameSong(record({ trackName: 'Night Drive' }), query)).toBe(true)
    expect(sameSong(record({ trackName: 'Day Drive' }), query)).toBe(false)
    expect(sameSong(record({ artistName: 'Other Band' }), query)).toBe(false)
    expect(sameSong(record({ artistName: 'The Made Ups feat. Guest' }), query)).toBe(true)

    const plainOnly = record({ id: 2, syncedLyrics: null })
    const otherLength = record({ id: 3, duration: 260 })
    const close = record({ id: 4, duration: 202 })
    const closest = record({ id: 5, duration: 199 })
    const wrong = record({ id: 6, trackName: 'Something Else' })
    expect(pickRecord([plainOnly, otherLength, wrong, close, closest], query)?.id).toBe(5)
    expect(pickRecord([plainOnly, otherLength], query)?.id).toBe(3)
    expect(pickRecord([wrong], query)).toBeNull()
  })
})

describe('findLyrics', () => {
  const query = { title: 'Night Drive', artist: 'The Made Ups', durationSec: 200.4 }

  it('asks /api/get with the title, artist and rounded length', async () => {
    const lrclib = fakeLrclib({ '/api/get': { status: 200, body: record() } })
    expect(await findLyrics(query, lrclib.fetchJson)).toMatchObject({ status: 'synced' })
    expect(lrclib.urls).toHaveLength(1)
    const url = new URL(lrclib.urls[0]!)
    expect(url.origin).toBe('https://lrclib.net')
    expect(Object.fromEntries(url.searchParams)).toEqual({ track_name: 'Night Drive', artist_name: 'The Made Ups', duration: '200' })
  })

  it('searches when /api/get finds nothing, and tries again without "(...)"', async () => {
    const searched = fakeLrclib({ '/api/search': { status: 200, body: [record({ trackName: 'Other' }), record({ duration: 199 })] } })
    expect(await findLyrics(query, searched.fetchJson)).toMatchObject({ status: 'synced' })
    expect(searched.urls.map((url) => new URL(url).pathname)).toEqual(['/api/get', '/api/search'])

    const urls: string[] = []
    const bareOnly: LrclibFetch = async (url) => {
      urls.push(url)
      const asked = new URL(url).searchParams.get('track_name')
      return asked === 'Night Drive' && new URL(url).pathname === '/api/get' ? { status: 200, body: record() } : { status: 404, body: {} }
    }
    expect(await findLyrics({ ...query, title: 'Night Drive (Live at Home)' }, bareOnly)).toMatchObject({ status: 'synced' })
    expect(urls.map((url) => new URL(url).searchParams.get('track_name'))).toEqual(['Night Drive (Live at Home)', 'Night Drive (Live at Home)', 'Night Drive'])
  })

  it('without an artist only searches; nothing found is "none"', async () => {
    const lrclib = fakeLrclib({ '/api/search': { status: 200, body: [] } })
    expect(await findLyrics({ title: 'Untitled Jam', artist: '', durationSec: null }, lrclib.fetchJson)).toEqual({ status: 'none' })
    expect(lrclib.urls.map((url) => new URL(url).pathname)).toEqual(['/api/search'])
    expect(await findLyrics({ title: '  ', artist: 'X', durationSec: null }, lrclib.fetchJson)).toEqual({ status: 'none' })
  })

  it('is "unavailable" when LRCLIB is busy or unreachable', async () => {
    expect(await findLyrics(query, fakeLrclib({ '/api/get': { status: 429, body: {} } }).fetchJson)).toEqual({ status: 'unavailable' })
    expect(await findLyrics(query, fakeLrclib({ '/api/get': { status: 503, body: {} } }).fetchJson)).toEqual({ status: 'unavailable' })
    const down: LrclibFetch = async () => {
      throw new Error('ENOTFOUND')
    }
    expect(await findLyrics(query, down)).toEqual({ status: 'unavailable' })
  })

  it('names itself to LRCLIB', () => {
    expect(LRCLIB_USER_AGENT).toBe('Tapedeck (https://github.com/dennycrafter/tapedeck)')
  })
})

describe('getLyrics (cache)', () => {
  const query = { title: 'Night Drive', artist: 'The Made Ups', durationSec: 200 }

  it('remembers an answer and does not ask again', async () => {
    const lrclib = fakeLrclib({ '/api/get': { status: 200, body: record() } })
    expect((await getLyrics(query, lrclib.fetchJson)).status).toBe('synced')
    expect((await getLyrics(query, lrclib.fetchJson)).status).toBe('synced')
    expect(lrclib.urls).toHaveLength(1)
    expect(lyricsCacheKey(query)).toBe('lyrics:night drive|the made ups|200')
  })

  it('remembers "none" for a day and never remembers "unavailable"', async () => {
    const nothing = fakeLrclib({})
    expect(await getLyrics(query, nothing.fetchJson)).toEqual({ status: 'none' })
    expect(await getLyrics(query, nothing.fetchJson)).toEqual({ status: 'none' })
    expect(nothing.urls).toHaveLength(2) // get + search, once
    await sql`update search_cache set created_at = now() - interval '25 hours'`
    await getLyrics(query, nothing.fetchJson)
    expect(nothing.urls).toHaveLength(4)

    await sql`truncate search_cache`
    const busy = fakeLrclib({ '/api/get': { status: 429, body: {} } })
    expect(await getLyrics(query, busy.fetchJson)).toEqual({ status: 'unavailable' })
    expect(await sql`select 1 from search_cache`).toHaveLength(0)
  })
})

describe('GET /api/tracks/[id]/lyrics', () => {
  async function song(title: string, durationSec: number) {
    const rows = await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, artist, status, duration_sec)
      values ('youtube', ${title}, 'https://youtu.be/x', ${title}, ${title}, 'The Made Ups', 'ready', ${durationSec})
      returning id`
    return String(rows[0]!.id)
  }
  const get = (id: string) => lyricsRoute(new Request(`http://localhost/api/tracks/${id}/lyrics`), { params: Promise.resolve({ id }) })

  it('answers from the stand-in in tests', async () => {
    expect(lyricsUseFixtures()).toBe(true)
    const synced = await (await get(await song('Paper Lanterns x1', 180))).json()
    expect(isLyricsResult(synced)).toBe(true)
    expect(synced).toMatchObject({ status: 'synced', lines: [{ time: 0.4, text: 'Paper lanterns on the water' }, {}, {}, {}] })
    expect(await (await get(await song('Radio Edit x1', 180))).json()).toEqual({ status: 'plain', text: 'Short and sweet\nCut for the radio' })
    expect(await (await get(await song('Quiet Piece x1', 180))).json()).toEqual({ status: 'instrumental' })
    expect(await (await get(await song('Nobody Wrote This', 180))).json()).toEqual({ status: 'none' })
  })

  it('400 for a bad id, 404 for an unknown song', async () => {
    expect((await get('nope')).status).toBe(400)
    expect((await get('00000000-0000-4000-8000-000000000000')).status).toBe(404)
  })
})
