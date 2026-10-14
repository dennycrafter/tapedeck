/**
 * POST (add songs) and PUT (reorder) /api/playlists/[id]/tracks (SPEC 8.6).
 * Real in-memory PGlite (TAPEDECK_TEST=1), one database for this file,
 * wiped before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../../lib/db'
import { POST, PUT } from './route'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
let counter = 0

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
  counter += 1
  const sourceId = `plt${String(counter).padStart(8, '0')}`
  const rows = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title)
    values ('youtube', ${sourceId}, ${`https://www.youtube.com/watch?v=${sourceId}`}, 'Song', 'Song')
    returning id
  `
  return String(rows[0].id)
}

async function insertPlaylist(): Promise<string> {
  const rows = await sql`insert into playlists (name) values ('Mix') returning id`
  return String(rows[0].id)
}

async function order(playlistId: string): Promise<string[]> {
  const rows = await sql`
    select track_id from playlist_tracks where playlist_id = ${playlistId} order by position asc, added_at asc
  `
  return rows.map((row) => String(row.track_id))
}

function call(handler: typeof POST, id: string, body: unknown): Promise<Response> {
  return handler(
    new Request('http://localhost/api/playlists/x/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ctx(id),
  )
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

describe('POST /api/playlists/[id]/tracks', () => {
  it('appends songs in order and reports how many were added', async () => {
    const playlist = await insertPlaylist()
    const [a, b, c] = [await insertTrack(), await insertTrack(), await insertTrack()]
    const first = await call(POST, playlist, { trackIds: [b, a] })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ added: 2 })
    expect(await (await call(POST, playlist, { trackIds: [a, c] })).json()).toEqual({ added: 1 })
    expect(await order(playlist)).toEqual([b, a, c])
  })

  it('rejects a non-UUID playlist id', async () => {
    const response = await call(POST, 'nope', { trackIds: [UNKNOWN_ID] })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('Playlist id must be a UUID')
  })

  it('rejects missing, empty, non-UUID or oversized trackIds', async () => {
    const playlist = await insertPlaylist()
    const tooMany = Array.from({ length: 1001 }, () => UNKNOWN_ID)
    for (const body of [{}, { trackIds: [] }, { trackIds: ['nope'] }, { trackIds: UNKNOWN_ID }, { trackIds: tooMany }, '{oops']) {
      const response = await call(POST, playlist, body)
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('Expected { trackIds: uuid[] }')
    }
  })

  it('answers 404 for an unknown playlist', async () => {
    const a = await insertTrack()
    const response = await call(POST, UNKNOWN_ID, { trackIds: [a] })
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Playlist not found')
  })
})

describe('PUT /api/playlists/[id]/tracks', () => {
  async function setup(): Promise<{ playlist: string; ids: string[] }> {
    const playlist = await insertPlaylist()
    const ids = [await insertTrack(), await insertTrack(), await insertTrack()]
    await call(POST, playlist, { trackIds: ids })
    return { playlist, ids }
  }

  it('saves the new full order', async () => {
    const { playlist, ids } = await setup()
    const [a, b, c] = ids
    const response = await call(PUT, playlist, { trackIds: [c, a, b] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await order(playlist)).toEqual([c, a, b])
  })

  it('accepts an empty order for an empty playlist', async () => {
    const playlist = await insertPlaylist()
    expect((await call(PUT, playlist, { trackIds: [] })).status).toBe(200)
  })

  it('answers 409 when the order does not match the playlist, and keeps the old order', async () => {
    const { playlist, ids } = await setup()
    const [a, b, c] = ids
    const outside = await insertTrack()
    for (const trackIds of [[a, b], [a, b, c, outside], [a, b, outside], [a, a, b], [c, c, b, a]]) {
      const response = await call(PUT, playlist, { trackIds })
      expect(response.status).toBe(409)
      expect(await errorOf(response)).toBe('The playlist changed. Reload and try again.')
    }
    expect(await order(playlist)).toEqual([a, b, c])
  })

  it('rejects bad ids and bodies, and 404s an unknown playlist', async () => {
    const playlist = await insertPlaylist()
    expect((await call(PUT, 'nope', { trackIds: [] })).status).toBe(400)
    expect((await call(PUT, playlist, { trackIds: ['nope'] })).status).toBe(400)
    expect((await call(PUT, playlist, {})).status).toBe(400)
    const response = await call(PUT, UNKNOWN_ID, { trackIds: [] })
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Playlist not found')
  })
})
