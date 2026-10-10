/**
 * YouTube search (SPEC 7.3 line 287, 8.7) tests: the pure parsers, the
 * no-key stand-in, the 24 h search_cache round trip, the inLibrary merge
 * and the quota mapping. Real in-memory PGlite (fresh per test via
 * resetDb) plus the MSW fixture handlers ("get lucky" fixture: 10 results
 * with video-list durations).
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { HttpResponse, http } from 'msw'

import { resetDb, sql, type Row } from './db'
import searchFixture from '../e2e/fixtures/youtube-search.json'
import { server, startTestMocks, stopTestMocks } from '../e2e/mocks/server'
import {
  SEARCH_OFF_MESSAGE,
  SearchQuotaError,
  parseSearchList,
  parseVideoDurations,
  resultUrl,
  searchCacheKey,
  searchYoutube,
} from './search-youtube'

startTestMocks({ onUnhandledRequest: 'error' })

const QUERY = 'Get Lucky'

beforeEach(async () => {
  await resetDb()
  delete process.env.YOUTUBE_API_KEY
})

afterAll(async () => {
  await resetDb()
  delete process.env.YOUTUBE_API_KEY
  stopTestMocks()
})

describe('pure helpers', () => {
  it('normalizes cache keys: trimmed and lowercased', () => {
    expect(searchCacheKey('  Get Lucky  ')).toBe('get lucky')
  })

  it('builds the watch URL for a result', () => {
    expect(resultUrl('jNQXAC9IVRw')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw')
  })

  it('drops search.list items without a video id or title', () => {
    const hits = parseSearchList({
      items: [
        { id: { videoId: 'a1' }, snippet: { title: 'Song A', channelTitle: 'Chan' } },
        { id: { videoId: 'b2' } },
        { snippet: { title: 'No id' } },
        { id: {}, snippet: { title: 'Empty id' } },
      ],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ videoId: 'a1', title: 'Song A', channel: 'Chan' })
  })

  it('maps video durations and leaves unknowns null', () => {
    const durations = parseVideoDurations({
      items: [
        { id: 'x1', contentDetails: { duration: 'PT4M8S' } },
        { id: 'x2' },
        { id: 'x3', contentDetails: { duration: 'bogus' } },
      ],
    })
    expect(durations.get('x1')).toBe(248)
    expect(durations.get('x2')).toBeNull()
    expect(durations.get('x3')).toBeNull()
  })
})

describe('searchYoutube (8.7)', () => {
  it('turns search off without a key: the SPEC message, no traffic, no cache write', async () => {
    const { results, message } = await searchYoutube(QUERY, undefined)
    expect(results).toEqual([])
    expect(message).toBe(SEARCH_OFF_MESSAGE)
    const rows = (await sql`select count(*)::int as n from search_cache`) as { n: number }[]
    expect(rows[0].n).toBe(0)
  })

  it('runs the fresh search: 10 results in order with durations from one videos.list call', async () => {
    const { results, message } = await searchYoutube(QUERY, 'test-key')
    expect(message).toBeUndefined()
    expect(results).toHaveLength(10)
    expect(results[0]).toMatchObject({
      videoId: 'GetLuckyF01',
      title: 'Daft Punk - Get Lucky (Official Radio Edit) ft. Pharrell Williams and Nile Rodgers',
      channel: 'Daft Punk',
      durationSec: 248,
      inLibrary: false,
    })
    const rows = (await sql`select q, results from search_cache`) as { q: string; results: unknown }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].q).toBe('get lucky')
  })

  it('serves the same search within 24 hours from search_cache: one network call across two searches', async () => {
    // Counting wrapper serving the recorded "get lucky" body: the second
    // search must not reach it (SPEC 9 T3: MSW request count stays the same).
    let searchCalls = 0
    const searchBody = (searchFixture as { queries: Record<string, { kind: string; etag: string; items: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }[] }> }).queries['get lucky']
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/search', () => {
        searchCalls++
        return HttpResponse.json(searchBody)
      }),
    )
    try {
      const first = await searchYoutube(QUERY, 'test-key')
      const second = await searchYoutube(QUERY, 'test-key')
      expect(searchCalls).toBe(1)
      expect(second.results).toEqual(first.results)
    } finally {
      server.resetHandlers()
    }
  })

  it('serves a seeded fresh cache hit without the network', async () => {
    const seeded = [
      { videoId: 'seed1', title: 'Seeded Song', channel: 'Seeds', thumbnailUrl: null, durationSec: 90 },
    ]
    await sql`insert into search_cache (q, results) values ('get lucky', ${JSON.stringify(seeded)}::jsonb)`
    const { results, message } = await searchYoutube('  GET LUCKY ', 'test-key')
    expect(message).toBeUndefined()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ videoId: 'seed1', title: 'Seeded Song', durationSec: 90, inLibrary: false })
  })

  it('ignores a cache row older than 24 hours', async () => {
    await sql`
      insert into search_cache (q, results, created_at)
      values ('get lucky', '[]'::jsonb, now() - ${sql.raw("interval '25 hours'")})
    `
    const { results } = await searchYoutube(QUERY, 'test-key')
    expect(results).toHaveLength(10)
    expect(results[0].videoId).toBe('GetLuckyF01')
  })

  it('flags results already in the library and leaves the rest alone', async () => {
    const inserted = (await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, artist)
      values ('youtube', 'GetLuckyF03', 'https://www.youtube.com/watch?v=GetLuckyF03', 'raw', 'Live at The River Seine', 'Daft Punk')
      returning id
    `) as (Row & { id: string })[]
    expect(inserted[0].id).toBeTruthy()
    const { results } = await searchYoutube(QUERY, 'test-key')
    const flags = results.map((r) => r.inLibrary)
    expect(flags.filter(Boolean)).toHaveLength(1)
    expect(results[2]).toMatchObject({ videoId: 'GetLuckyF03', inLibrary: true })
    expect(results[0].inLibrary).toBe(false)
  })

  it('maps the quota error to SearchQuotaError', async () => {
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/search', () =>
        HttpResponse.json(
          { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } },
          { status: 403 },
        ),
      ),
    )
    await expect(searchYoutube(QUERY, 'test-key')).rejects.toBeInstanceOf(SearchQuotaError)
    server.resetHandlers()
  })

  it('surfaces other HTTP failures as-is', async () => {
    server.use(
      http.get('https://www.googleapis.com/youtube/v3/search', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    await expect(searchYoutube(QUERY, 'test-key')).rejects.toMatchObject({ status: 500 })
    server.resetHandlers()
  })
})
