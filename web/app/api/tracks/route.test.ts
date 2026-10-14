/**
 * POST /api/tracks integration tests (SPEC 8.2): real in-memory PGlite (fresh
 * per test via resetDb) plus the MSW fixture handlers for outbound metadata.
 * Drives the route handler directly, exactly as middleware-authenticated
 * requests would reach it.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { HttpResponse, http } from 'msw'

import { resetDb, sql } from '../../../lib/db'
import { server, startTestMocks, stopTestMocks } from '../../../e2e/mocks/server'
import { POST } from './route'
import { NOT_A_SONG_LINK_MESSAGE, SOUNDCLOUD_SETS_MESSAGE } from '../../../lib/parse-source-url'

startTestMocks({ onUnhandledRequest: 'error' })

const ZOO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'

function post(urls: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    }),
  )
}

async function json(response: Response): Promise<{ results?: unknown; error?: string }> {
  return (await response.json()) as { results?: unknown; error?: string }
}

function soundcloudOembedHandler(title = 'Flickermood', uploader = 'Forss') {
  return http.get('https://soundcloud.com/oembed', () => HttpResponse.json({ title, author_name: uploader }))
}

beforeEach(async () => {
  await resetDb()
})

afterAll(async () => {
  await resetDb()
  stopTestMocks()
})

describe('request validation (SPEC 8.2: max 25 per request)', () => {
  it('rejects a non-array urls field', async () => {
    const response = await post('not-an-array')
    expect(response.status).toBe(400)
    expect((await json(response)).error).toBeTruthy()
  })

  it('rejects an empty array', async () => {
    const response = await post([])
    expect(response.status).toBe(400)
  })

  it('rejects more than 25 urls', async () => {
    const response = await post(Array.from({ length: 26 }, () => ZOO_URL))
    expect(response.status).toBe(400)
  })

  it('rejects non-string entries', async () => {
    const response = await post([42])
    expect(response.status).toBe(400)
  })
})

describe('adding YouTube links (8.2 steps 1, 3, 5)', () => {
  it('adds a track with cleaned metadata and status waiting', async () => {
    const response = await post([ZOO_URL])
    expect(response.status).toBe(200)
    const body = await json(response)
    const results = body.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      index: 0,
      line: ZOO_URL,
      status: 'added',
      message: 'Added',
    })
    expect(results[0].track).toMatchObject({
      source: 'youtube',
      sourceId: 'jNQXAC9IVRw',
      sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      title: 'Me at the zoo',
      artist: 'jawed',
      status: 'waiting',
    })

    const rows = (await sql`select source, source_id, source_url, title, artist, status from tracks`) as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'youtube', source_id: 'jNQXAC9IVRw', status: 'waiting' })
  })

  it('canonicalizes every accepted form to one source_url', async () => {
    const response = await post([
      ZOO_URL,
      'https://youtu.be/jNQXAC9IVRw?si=share',
      'https://music.youtube.com/watch?v=jNQXAC9IVRw&list=PLx',
      'https://www.youtube.com/shorts/jNQXAC9IVRw',
    ])
    const body = await json(response)
    const results = body.results as Array<{ status: string; track?: { sourceUrl: string } }>
    // First is added; the rest dedupe against it within the same paste.
    expect(results.map((r) => r.status)).toEqual(['added', 'already', 'already', 'already'])
    expect(results[0].track?.sourceUrl).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw')
  })

  it('reports the SPEC per-line error for non-links without blocking other lines', async () => {
    const response = await post(['hello world', ZOO_URL])
    const body = await json(response)
    const results = body.results as Array<{ status: string; message: string }>
    expect(results[0]).toMatchObject({ index: 0, status: 'error', message: NOT_A_SONG_LINK_MESSAGE })
    expect(results[1]).toMatchObject({ index: 1, status: 'added' })
  })

  it('dedupes against the library on a second request', async () => {
    await post([ZOO_URL])
    const second = await post([ZOO_URL])
    const body = await json(second)
    const results = body.results as Array<{ status: string; message: string }>
    expect(results[0]).toMatchObject({ status: 'already', message: 'Already in your library' })
    const rows = (await sql`select id from tracks`) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
  })

  it('surfaces a per-line error for a video that does not exist', async () => {
    const response = await post(['https://youtu.be/zzzzzzzzz99'])
    const body = await json(response)
    const results = body.results as Array<{ status: string; message: string }>
    expect(results[0].status).toBe('error')
    expect(results[0].message).toContain('zzzzzzzzz99')
  })
})

describe('adding SoundCloud links (8.2, 7.4)', () => {
  it('adds a track with the oEmbed uploader as artist', async () => {
    server.use(soundcloudOembedHandler())
    const response = await post(['https://soundcloud.com/forss/flickermood?in=x'])
    const body = await json(response)
    const results = body.results as Array<{ status: string; track?: { source: string; sourceId: string } }>
    expect(results[0].status).toBe('added')
    expect(results[0].track).toMatchObject({ source: 'soundcloud', sourceId: 'forss/flickermood' })
  })

  it('rejects sets with the exact message (7.4)', async () => {
    const response = await post(['https://soundcloud.com/forss/sets/moves'])
    const body = await json(response)
    const results = body.results as Array<{ status: string; message: string }>
    expect(results[0]).toMatchObject({ status: 'error', message: SOUNDCLOUD_SETS_MESSAGE })
  })

  it('resolves on.soundcloud.com short links server-side before parsing', async () => {
    server.use(
      http.get('https://on.soundcloud.com/abc123', () =>
        new HttpResponse(null, { status: 302, headers: { location: 'https://soundcloud.com/forss/flickermood' } }),
      ),
      // MSW sees the followed request too, so the redirect target needs a handler.
      http.get('https://soundcloud.com/forss/flickermood', () => HttpResponse.json({}, { status: 200 })),
      soundcloudOembedHandler(),
    )
    const response = await post(['https://on.soundcloud.com/abc123'])
    const body = await json(response)
    const results = body.results as Array<{ status: string; track?: { sourceId: string } }>
    expect(results[0].status).toBe('added')
    expect(results[0].track?.sourceId).toBe('forss/flickermood')
  })

  it('reports a per-line error when the short link is dead', async () => {
    server.use(http.get('https://on.soundcloud.com/deadlink', () => new HttpResponse(null, { status: 404 })))
    const response = await post(['https://on.soundcloud.com/deadlink'])
    const body = await json(response)
    const results = body.results as Array<{ status: string; message: string }>
    expect(results[0]).toMatchObject({ status: 'error', message: 'That SoundCloud link does not exist.' })
  })
})

describe('metadata path selection (7.3)', () => {
  it('uses the batched Data API when YOUTUBE_API_KEY is set (duration present)', async () => {
    const previous = process.env.YOUTUBE_API_KEY
    process.env.YOUTUBE_API_KEY = 'test-key'
    try {
      const response = await post([ZOO_URL])
      const body = await json(response)
      const results = body.results as Array<{ status: string; track?: { durationSec: number | null } }>
      expect(results[0].status).toBe('added')
      // PT19S: only videos.list carries durations.
      expect(results[0].track?.durationSec).toBe(19)
    } finally {
      if (previous === undefined) delete process.env.YOUTUBE_API_KEY
      else process.env.YOUTUBE_API_KEY = previous
    }
  })

  it('leaves the duration null on the oEmbed fallback', async () => {
    const response = await post([ZOO_URL])
    const body = await json(response)
    const results = body.results as Array<{ track?: { durationSec: number | null } }>
    expect(results[0].track?.durationSec).toBeNull()
  })
})
