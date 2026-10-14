/**
 * DELETE /api/playlists/[id]/tracks/[trackId]: remove one song from a
 * playlist. Real in-memory PGlite (TAPEDECK_TEST=1), one database for this
 * file, wiped before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../../../lib/db'
import { DELETE } from './route'

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'
const ctx = (id: string, trackId: string) => ({ params: Promise.resolve({ id, trackId }) })

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

async function setup(): Promise<{ playlist: string; a: string; b: string }> {
  const tracks = await sql`
    insert into tracks (source, source_id, source_url, raw_title, title) values
      ('youtube', 'rm000000001', 'https://www.youtube.com/watch?v=rm000000001', 'A', 'A'),
      ('youtube', 'rm000000002', 'https://www.youtube.com/watch?v=rm000000002', 'B', 'B')
    returning id
  `
  const playlists = await sql`insert into playlists (name) values ('Mix') returning id`
  const playlist = String(playlists[0].id)
  const [a, b] = tracks.map((row) => String(row.id))
  await sql`insert into playlist_tracks (playlist_id, track_id, position) values (${playlist}, ${a}, 0), (${playlist}, ${b}, 1)`
  return { playlist, a, b }
}

function del(id: string, trackId: string): Promise<Response> {
  return DELETE(new Request('http://localhost/api/playlists/x/tracks/y', { method: 'DELETE' }), ctx(id, trackId))
}

describe('DELETE /api/playlists/[id]/tracks/[trackId]', () => {
  it('removes the song from the playlist and keeps it in the library', async () => {
    const { playlist, a, b } = await setup()
    const response = await del(playlist, a)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await sql`select track_id from playlist_tracks`).toEqual([{ track_id: b }])
    expect(await sql`select 1 from tracks`).toHaveLength(2)
  })

  it('rejects non-UUID ids', async () => {
    const { playlist, a } = await setup()
    for (const [id, trackId] of [['nope', a], [playlist, 'nope']]) {
      const response = await del(id, trackId)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('Ids must be UUIDs')
    }
  })

  it('answers 404 when the song is not in the playlist or the playlist is unknown', async () => {
    const { playlist, a } = await setup()
    await del(playlist, a)
    const again = await del(playlist, a)
    expect(again.status).toBe(404)
    expect(((await again.json()) as { error: string }).error).toBe('Song not in this playlist')
    expect((await del(UNKNOWN_ID, a)).status).toBe(404)
    expect((await del(playlist, UNKNOWN_ID)).status).toBe(404)
  })
})
