/**
 * POST /api/plays (SPEC 8.6, 8.9): one play, optionally with the real time
 * of an offline play. Real in-memory PGlite (TAPEDECK_TEST=1), one database
 * for this file, wiped before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../lib/db'
import { MAX_PLAY_SECONDS } from '../../../lib/library'
import { POST } from './route'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events`
})

async function insertTrack(): Promise<string> {
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title)
    values ('youtube', 'play0000001', 'https://www.youtube.com/watch?v=play0000001', 'Song', 'Song')
    returning id
  `
  return String(rows[0].id)
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/plays', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

describe('POST /api/plays', () => {
  it('records a play now and answers 201', async () => {
    const trackId = await insertTrack()
    const response = await post({ trackId, seconds: 45.4 })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ recorded: true })
    const [row] = await sql`select track_id, seconds_listened, played_at from play_events`
    expect(row.track_id).toBe(trackId)
    expect(row.seconds_listened).toBe(45)
    expect(Math.abs(new Date(row.played_at as string).getTime() - Date.now())).toBeLessThan(60_000)
  })

  it('accepts seconds as a numeric string and clamps very long plays', async () => {
    const trackId = await insertTrack()
    expect((await post({ trackId, seconds: '30' })).status).toBe(201)
    expect((await post({ trackId, seconds: MAX_PLAY_SECONDS * 2 })).status).toBe(201)
    const rows = await sql`select seconds_listened from play_events order by seconds_listened`
    expect(rows.map((r) => r.seconds_listened)).toEqual([30, MAX_PLAY_SECONDS])
  })

  it('keeps the real time of an offline play', async () => {
    const trackId = await insertTrack()
    const playedAt = '2025-06-01T10:00:00.000Z'
    expect((await post({ trackId, seconds: 60, playedAt })).status).toBe(201)
    const [row] = await sql`select played_at from play_events`
    expect(new Date(row.played_at as string).toISOString()).toBe(playedAt)
  })

  it('answers 200 with recorded false for a song that no longer exists', async () => {
    const response = await post({ trackId: UNKNOWN_ID, seconds: 30 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ recorded: false })
    expect(await sql`select 1 from play_events`).toHaveLength(0)
  })

  it('rejects a missing or non-UUID trackId and a bad body', async () => {
    for (const body of [{}, { trackId: 'nope', seconds: 30 }, { seconds: 30 }, '{oops']) {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('Expected { trackId, seconds }')
    }
  })

  it('rejects negative or non-numeric seconds', async () => {
    const trackId = await insertTrack()
    for (const seconds of [-1, 'abc', undefined, {}]) {
      const response = await post({ trackId, seconds })
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('seconds must be 0 or more')
    }
  })

  // Known bug: Number(null), Number(''), Number(false) and Number([]) are all
  // 0, so these non-numbers pass validation and are recorded as 0 s plays.
  it('rejects null, empty-string, boolean and array seconds', async () => {
    const trackId = await insertTrack()
    for (const seconds of [null, '', false, []]) {
      const response = await post({ trackId, seconds })
      expect(response.status).toBe(400)
    }
  })

  it('rejects a playedAt that is unparseable, not a string, or in the future', async () => {
    const trackId = await insertTrack()
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    for (const playedAt of ['yesterday-ish', 1700000000000, future]) {
      const response = await post({ trackId, seconds: 30, playedAt })
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('playedAt must be a past date')
    }
    expect(await sql`select 1 from play_events`).toHaveLength(0)
  })
})
