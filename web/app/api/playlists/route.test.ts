/**
 * POST /api/playlists (SPEC 8.6): create a playlist. Real in-memory PGlite
 * (TAPEDECK_TEST=1), one database for this file, wiped before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../lib/db'
import { POST } from './route'

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

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/playlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

interface PlaylistBody {
  id: string
  name: string
  description: string
  position: number
  trackIds: string[]
}

describe('POST /api/playlists', () => {
  it('creates a playlist with a cleaned name and trimmed description', async () => {
    const response = await post({ name: '  Road   trip ', description: '  for the drive  ' })
    expect(response.status).toBe(201)
    const playlist = (await response.json()) as PlaylistBody
    expect(playlist).toMatchObject({ name: 'Road trip', description: 'for the drive', position: 0, trackIds: [] })
    expect(await sql`select name from playlists where id = ${playlist.id}`).toEqual([{ name: 'Road trip' }])
  })

  it('gives later playlists the next position and defaults the description', async () => {
    await post({ name: 'One' })
    const second = (await (await post({ name: 'Two', description: 42 })).json()) as PlaylistBody
    expect(second.position).toBe(1)
    expect(second.description).toBe('')
  })

  it('rejects a missing, blank or non-string name and a bad body', async () => {
    for (const body of [{}, { name: '   ' }, { name: 7 }, '{oops', [{ name: 'x' }]]) {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('Give the playlist a name')
    }
    expect(await sql`select 1 from playlists`).toHaveLength(0)
  })
})
