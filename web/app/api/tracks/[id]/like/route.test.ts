/**
 * PUT /api/tracks/[id]/like (SPEC 8.6): the heart on any song. Real
 * in-memory PGlite (TAPEDECK_TEST=1), one database for this file, wiped
 * before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../../lib/db'
import { PUT } from './route'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

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
    insert into tracks (source, source_id, source_url, raw_title, title, artist, status)
    values ('youtube', 'like0000001', 'https://www.youtube.com/watch?v=like0000001', 'Song', 'Song', 'Band', 'ready')
    returning id
  `
  return String(rows[0].id)
}

function put(id: string, body: unknown): Promise<Response> {
  return PUT(
    new Request('http://localhost/api/tracks/x/like', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ctx(id),
  )
}

describe('PUT /api/tracks/[id]/like', () => {
  it('likes a song and returns the track with likedAt', async () => {
    const id = await insertTrack()
    const response = await put(id, { liked: true })
    expect(response.status).toBe(200)
    const track = (await response.json()) as { id: string; liked: boolean; likedAt: string | null }
    expect(track.id).toBe(id)
    expect(track.liked).toBe(true)
    expect(track.likedAt).not.toBeNull()
  })

  it('unlikes a song and clears likedAt', async () => {
    const id = await insertTrack()
    await put(id, { liked: true })
    const response = await put(id, { liked: false })
    expect(response.status).toBe(200)
    const track = (await response.json()) as { liked: boolean; likedAt: string | null }
    expect(track).toMatchObject({ liked: false, likedAt: null })
  })

  it('rejects a non-UUID id', async () => {
    const response = await put('not-a-uuid', { liked: true })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('Track id must be a UUID')
  })

  it('rejects a missing or non-boolean liked, and a bad body', async () => {
    const id = await insertTrack()
    expect((await put(id, {})).status).toBe(400)
    expect((await put(id, { liked: 'yes' })).status).toBe(400)
    expect((await put(id, [true])).status).toBe(400)
    expect((await put(id, '{not json')).status).toBe(400)
  })

  it('answers 404 for an unknown track', async () => {
    const response = await put(UNKNOWN_ID, { liked: true })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toBe('Track not found')
  })
})
