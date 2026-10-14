/**
 * PATCH and DELETE /api/playlists/[id] (SPEC 8.6): rename and delete. Real
 * in-memory PGlite (TAPEDECK_TEST=1), one database for this file, wiped
 * before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../lib/db'
import { DELETE, PATCH } from './route'

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

async function insertPlaylist(name = 'Old', description = 'desc'): Promise<string> {
  const rows = await sql`insert into playlists (name, description) values (${name}, ${description}) returning id`
  return String(rows[0].id)
}

function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request('http://localhost/api/playlists/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ctx(id),
  )
}

function del(id: string): Promise<Response> {
  return DELETE(new Request('http://localhost/api/playlists/x', { method: 'DELETE' }), ctx(id))
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

describe('PATCH /api/playlists/[id]', () => {
  it('renames with a cleaned name and keeps the description', async () => {
    const id = await insertPlaylist()
    const response = await patch(id, { name: '  New   name ' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await sql`select name, description from playlists where id = ${id}`).toEqual([
      { name: 'New name', description: 'desc' },
    ])
  })

  it('updates only the description (trimmed)', async () => {
    const id = await insertPlaylist()
    expect((await patch(id, { description: '  fresh  ' })).status).toBe(200)
    expect(await sql`select name, description from playlists where id = ${id}`).toEqual([
      { name: 'Old', description: 'fresh' },
    ])
  })

  it('rejects a non-UUID id', async () => {
    const response = await patch('nope', { name: 'x' })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('Playlist id must be a UUID')
  })

  it('rejects a bad body, a blank name and an empty update', async () => {
    const id = await insertPlaylist()
    const bad = await patch(id, '{oops')
    expect(bad.status).toBe(400)
    expect(await errorOf(bad)).toBe('Expected a JSON object')

    const blank = await patch(id, { name: '   ' })
    expect(blank.status).toBe(400)
    expect(await errorOf(blank)).toBe('Give the playlist a name')

    const nothing = await patch(id, { description: 5 })
    expect(nothing.status).toBe(400)
    expect(await errorOf(nothing)).toBe('Nothing to update')
    expect(await sql`select name from playlists where id = ${id}`).toEqual([{ name: 'Old' }])
  })

  it('answers 404 for an unknown playlist', async () => {
    const response = await patch(UNKNOWN_ID, { name: 'x' })
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Playlist not found')
  })
})

describe('DELETE /api/playlists/[id]', () => {
  it('deletes the playlist and keeps its songs', async () => {
    const id = await insertPlaylist()
    const track = await sql`
      insert into tracks (source, source_id, source_url, raw_title, title)
      values ('youtube', 'pl000000001', 'https://www.youtube.com/watch?v=pl000000001', 'Song', 'Song')
      returning id
    `
    await sql`insert into playlist_tracks (playlist_id, track_id) values (${id}, ${track[0].id})`
    const response = await del(id)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(await sql`select 1 from playlists`).toHaveLength(0)
    expect(await sql`select 1 from playlist_tracks`).toHaveLength(0)
    expect(await sql`select 1 from tracks`).toHaveLength(1)
  })

  it('rejects a non-UUID id and 404s an unknown playlist', async () => {
    expect((await del('nope')).status).toBe(400)
    const response = await del(UNKNOWN_ID)
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Playlist not found')
  })
})
