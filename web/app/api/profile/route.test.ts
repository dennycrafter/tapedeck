/**
 * GET and PATCH /api/profile (SPEC 8.6): name, stats strip and top artists.
 * Real in-memory PGlite (TAPEDECK_TEST=1), one database for this file, wiped
 * before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../lib/db'
import { GET, PATCH } from './route'

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
  await sql`update settings set display_name = 'Denis' where id = 1`
})

function patch(body: unknown): Promise<Response> {
  return PATCH(
    new Request('http://localhost/api/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

interface ProfileBody {
  displayName: string
  stats: { songs: number; secondsListened: number; playsThisMonth: number; storageBytes: number }
  topArtists: { artist: string; plays: number }[]
}

describe('GET /api/profile', () => {
  it('returns the profile with no-store caching', async () => {
    const rows = await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, artist, bytes) values
        ('youtube', 'prof0000001', 'https://www.youtube.com/watch?v=prof0000001', 'A', 'A', 'Band', 2000),
        ('youtube', 'prof0000002', 'https://www.youtube.com/watch?v=prof0000002', 'B', 'B', 'Band', 500)
      returning id
    `
    await sql`insert into play_events (track_id, seconds_listened) values (${rows[0].id}, 120), (${rows[1].id}, 60)`

    const response = await GET(new Request('http://localhost/api/profile'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = (await response.json()) as ProfileBody
    expect(body).toEqual({
      displayName: 'Denis',
      stats: { songs: 2, secondsListened: 180, playsThisMonth: 2, storageBytes: 2500 },
      topArtists: [{ artist: 'Band', plays: 2 }],
    })
  })
})

describe('PATCH /api/profile', () => {
  it('saves a cleaned display name', async () => {
    const response = await patch({ displayName: '  Dee   P ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ displayName: 'Dee P' })
    const profile = (await (await GET(new Request('http://localhost/api/profile'))).json()) as ProfileBody
    expect(profile.displayName).toBe('Dee P')
  })

  it('rejects a missing, blank or non-string name and a bad body', async () => {
    for (const body of [{}, { displayName: '   ' }, { displayName: 9 }, '{oops']) {
      const response = await patch(body)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('Name must not be empty')
    }
    expect(await sql`select display_name from settings`).toEqual([{ display_name: 'Denis' }])
  })
})
