/**
 * PUT /api/albums/favorite (SPEC 8.6): the heart on an album page. Real
 * in-memory PGlite (TAPEDECK_TEST=1), one database for this file, wiped
 * before every test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb, sql } from '../../../../lib/db'
import { PUT } from './route'

beforeAll(() => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

afterAll(async () => {
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await sql`truncate album_favorites`
})

function put(body: unknown): Promise<Response> {
  return PUT(
    new Request('http://localhost/api/albums/favorite', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

describe('PUT /api/albums/favorite', () => {
  it('favourites an album once, trimming the names', async () => {
    const first = await put({ album: '  Discovery ', albumArtist: ' Daft Punk ', favorite: true })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })
    expect((await put({ album: 'Discovery', albumArtist: 'Daft Punk', favorite: true })).status).toBe(200)
    expect(await sql`select album, album_artist from album_favorites`).toEqual([
      { album: 'Discovery', album_artist: 'Daft Punk' },
    ])
  })

  it('accepts an empty album artist', async () => {
    expect((await put({ album: 'Mixtape', albumArtist: '', favorite: true })).status).toBe(200)
    expect(await sql`select album, album_artist from album_favorites`).toEqual([{ album: 'Mixtape', album_artist: '' }])
  })

  it('unfavourites an album', async () => {
    await put({ album: 'Discovery', albumArtist: 'Daft Punk', favorite: true })
    expect((await put({ album: 'Discovery', albumArtist: 'Daft Punk', favorite: false })).status).toBe(200)
    expect(await sql`select 1 from album_favorites`).toHaveLength(0)
  })

  it('rejects a missing album, album artist or favorite flag', async () => {
    const bodies: unknown[] = [
      {},
      { album: '   ', albumArtist: 'X', favorite: true },
      { album: 'A', favorite: true },
      { album: 'A', albumArtist: 3, favorite: true },
      { album: 'A', albumArtist: 'X' },
      { album: 'A', albumArtist: 'X', favorite: 'yes' },
      '{oops',
    ]
    for (const body of bodies) {
      const response = await put(body)
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('Expected { album, albumArtist, favorite }')
    }
    expect(await sql`select 1 from album_favorites`).toHaveLength(0)
  })
})
