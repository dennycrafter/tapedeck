/**
 * Test-only seeding route (SPEC 9.0): 404 unless TAPEDECK_TEST=1 outside
 * production; POST inserts waiting tracks, GET reports raw counts. Real
 * in-memory PGlite, one database for this file, wiped before every test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../lib/db'
import { GET, POST } from './route'

const MINUTE = 60_000

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('NODE_ENV', 'test')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await sql`truncate tracks, playlists, playlist_tracks, album_favorites, play_events`
})

afterEach(() => {
  // Undo per-test env flips but keep the file-wide test database settings.
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('NODE_ENV', 'test')
})

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/test/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

function get(query = ''): Promise<Response> {
  return GET(new Request(`http://localhost/api/test/seed${query}`))
}

/** Midnight on the 1st of the current month, Chicago time, as a UTC instant. */
function chicagoMonthStart(now = new Date()): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const part = (date: Date, type: string): string => fmt.formatToParts(date).find((p) => p.type === type)?.value ?? ''
  const year = Number(part(now, 'year'))
  const month = Number(part(now, 'month'))
  for (const offset of [5, 6]) {
    const candidate = new Date(Date.UTC(year, month - 1, 1, offset))
    if (part(candidate, 'day') === '01' && part(candidate, 'hour') === '00') return candidate
  }
  throw new Error('Could not find the Chicago month start')
}

describe('availability', () => {
  it('answers 404 when TAPEDECK_TEST is not 1', async () => {
    vi.stubEnv('TAPEDECK_TEST', '')
    expect((await post({ tracks: [{ title: 'x' }] })).status).toBe(404)
    expect((await get()).status).toBe(404)
  })

  it('answers 404 in a production build even with TAPEDECK_TEST=1', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect((await post({ tracks: [{ title: 'x' }] })).status).toBe(404)
    expect((await get()).status).toBe(404)
    vi.stubEnv('NODE_ENV', 'test')
    expect(await sql`select 1 from tracks`).toHaveLength(0)
  })
})

describe('POST /api/test/seed', () => {
  it('creates waiting tracks with the given details', async () => {
    const response = await post({
      tracks: [
        { title: '  Made Up Song ', artist: 'Fake Band', album: 'Fake LP', albumArtist: 'Fake Band', durationSec: 201.6 },
        { title: 'Second', durationSec: -5 },
      ],
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { tracks: { id: string; title: string }[] }
    expect(body.tracks.map((t) => t.title)).toEqual(['Made Up Song', 'Second'])

    const rows = await sql`
      select id, source, source_id, source_url, raw_title, title, artist, album, album_artist, duration_sec, status
      from tracks order by title
    `
    const made = rows.find((r) => r.title === 'Made Up Song')
    expect(made).toMatchObject({
      id: body.tracks[0].id,
      source: 'youtube',
      raw_title: 'Made Up Song',
      artist: 'Fake Band',
      album: 'Fake LP',
      album_artist: 'Fake Band',
      duration_sec: 202,
      status: 'waiting',
    })
    expect(String(made?.source_id)).toMatch(/^T[A-Za-z0-9_-]{10}$/)
    expect(made?.source_url).toBe(`https://www.youtube.com/watch?v=${String(made?.source_id)}`)
    const second = rows.find((r) => r.title === 'Second')
    expect(second).toMatchObject({ artist: '', album: null, album_artist: null, duration_sec: null, status: 'waiting' })
  })

  it('rejects a missing, empty or oversized list', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ title: `S${i}` }))
    for (const body of [{}, { tracks: [] }, { tracks: 'x' }, { tracks: tooMany }, '{oops']) {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('Expected { tracks: [...] } (1 to 50)')
    }
  })

  it('rejects a track without a title', async () => {
    for (const tracks of [[{}], [{ title: '  ' }], [null]]) {
      const response = await post({ tracks })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('Every seeded track needs a title')
    }
    expect(await sql`select 1 from tracks`).toHaveLength(0)
  })
})

describe('GET /api/test/seed', () => {
  it('reports zeros for an empty database', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tracks: 0,
      storageBytes: 0,
      playEvents: 0,
      secondsListened: 0,
      playsThisMonth: 0,
      playEventsForTrack: 0,
    })
  })

  it('counts tracks, bytes, plays, this month in Chicago time, and plays for one track', async () => {
    const created = (await (await post({ tracks: [{ title: 'A' }, { title: 'B' }] })).json()) as {
      tracks: { id: string }[]
    }
    const [a, b] = created.tracks.map((t) => t.id)
    await sql`update tracks set bytes = 1000 where id = ${a}`
    await sql`update tracks set bytes = 234 where id = ${b}`
    const start = chicagoMonthStart()
    const before = new Date(start.getTime() - MINUTE).toISOString()
    const after = new Date(start.getTime() + MINUTE).toISOString()
    await sql`
      insert into play_events (track_id, seconds_listened, played_at) values
        (${a}, 30, ${before}::timestamptz),
        (${a}, 40, ${after}::timestamptz),
        (${b}, 50, ${after}::timestamptz)
    `

    const response = await get(`?trackId=${a}`)
    expect(await response.json()).toEqual({
      tracks: 2,
      storageBytes: 1234,
      playEvents: 3,
      secondsListened: 120,
      playsThisMonth: 2,
      playEventsForTrack: 2,
    })
    const noTrack = (await (await get('?trackId=nope')).json()) as { playEventsForTrack: number }
    expect(noTrack.playEventsForTrack).toBe(0)
  })
})
