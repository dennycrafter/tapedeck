/**
 * T11 routes against the catalog stand-in (recorded Deezer responses, the
 * test-mode default) and a real in-memory PGlite: the three /api/catalog
 * routes with their inLibrary flags, and POST /api/tracks with
 * `{ catalog }` (V2-PLAN T11 items 2 and 5). Any network call fails the
 * test (MSW onUnhandledRequest: 'error').
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { resetDb, sql } from '../../../lib/db'
import { startTestMocks, stopTestMocks } from '../../../e2e/mocks/server'
import { GET as searchGET } from './search/route'
import { GET as albumGET } from './album/[id]/route'
import { GET as artistGET } from './artist/[id]/route'
import { POST as tracksPOST } from '../tracks/route'
import { MAX_CATALOG_ADD } from '../../../lib/catalog-add'
import type {
  CatalogAlbumResponse,
  CatalogArtistResponse,
  CatalogSearchResponse,
  CatalogTrack,
} from '../../../lib/catalog-types'

startTestMocks({ onUnhandledRequest: 'error' })

beforeEach(async () => {
  await resetDb()
  delete process.env.CATALOG_SOURCE
})

afterAll(async () => {
  await resetDb()
  stopTestMocks()
})

function search(q: string, type?: string): Promise<Response> {
  const params = new URLSearchParams({ q, ...(type ? { type } : {}) })
  return searchGET(new Request(`http://localhost/api/catalog/search?${params}`))
}

function album(id: string): Promise<Response> {
  return albumGET(new Request('http://localhost/api/catalog/album/x'), { params: Promise.resolve({ id }) })
}

function artist(id: string): Promise<Response> {
  return artistGET(new Request('http://localhost/api/catalog/artist/x'), { params: Promise.resolve({ id }) })
}

function add(catalog: unknown): Promise<Response> {
  return tracksPOST(
    new Request('http://localhost/api/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalog }),
    }),
  )
}

interface AddBody {
  results: { index: number; line: string; status: string; message: string; track?: { id: string; source: string } }[]
  error?: string
}

async function albumTracks(): Promise<CatalogTrack[]> {
  return ((await (await album('deezer:6575789')).json()) as CatalogAlbumResponse).tracks
}

describe('GET /api/catalog/search', () => {
  it('validates the query and the type', async () => {
    expect((await search('d')).status).toBe(400)
    expect((await search('daft punk', 'videos')).status).toBe(400)
    expect((await search('x'.repeat(201))).status).toBe(400)
  })

  it('returns songs, albums and artists with inLibrary flags', async () => {
    const response = await search('Daft Punk')
    expect(response.status).toBe(200)
    const body = (await response.json()) as CatalogSearchResponse
    expect(body.tracks).toHaveLength(25)
    expect(body.albums.length).toBeGreaterThan(0)
    expect(body.artists[0].name).toBe('Daft Punk')
    expect(body.tracks.every((track) => track.inLibrary === false)).toBe(true)
    expect(body.artists.every((a) => a.inLibrary === false)).toBe(true)
  })

  it('a type returns only that kind', async () => {
    const body = (await (await search('daft punk', 'albums')).json()) as CatalogSearchResponse
    expect(body.tracks).toEqual([])
    expect(body.artists).toEqual([])
    expect(body.albums.length).toBeGreaterThan(0)
  })

  it('flags songs, albums and artists already in the library', async () => {
    await sql`
      insert into tracks (source, source_id, source_url, raw_title, title, artist, album, album_artist)
      values ('youtube', 'abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk', 'x',
              'One More Time (Official Video)', 'Daft Punk', 'Discovery', 'Daft Punk')
    `
    const body = (await (await search('daft punk')).json()) as CatalogSearchResponse
    expect(body.tracks.find((t) => t.id === 'deezer:3135553')?.inLibrary).toBe(true) // One More Time
    expect(body.tracks.find((t) => t.id === 'deezer:3135556')?.inLibrary).toBe(false)
    expect(body.albums.find((a) => a.id === 'deezer:302127')?.inLibrary).toBe(true) // Discovery
    expect(body.albums.find((a) => a.id === 'deezer:301775')?.inLibrary).toBe(false) // Homework
    expect(body.artists.find((a) => a.id === 'deezer:27')?.inLibrary).toBe(true)
  })
})

describe('GET /api/catalog/album/:id and /artist/:id', () => {
  it('rejects ids that are not catalog ids', async () => {
    expect((await album('6575789')).status).toBe(400)
    expect((await album('spotify:1')).status).toBe(400)
    expect((await artist('deezer:abc')).status).toBe(400)
  })

  it('answers 404 for an id the catalog does not know', async () => {
    const response = await album('deezer:999')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toBe("This album isn't in the catalog.")
    expect((await artist('deezer:999')).status).toBe(404)
  })

  it('accepts the id URL-encoded', async () => {
    expect((await album('deezer%3A6575789')).status).toBe(200)
  })

  it('returns the album with its tracklist', async () => {
    const body = (await (await album('deezer:6575789')).json()) as CatalogAlbumResponse
    expect(body.album).toMatchObject({ title: 'Random Access Memories', artist: 'Daft Punk', inLibrary: false })
    expect(body.tracks).toHaveLength(13)
    expect(body.tracks.every((t) => t.inLibrary === false)).toBe(true)
  })

  it('returns the artist with top songs and albums', async () => {
    const body = (await (await artist('deezer:27')).json()) as CatalogArtistResponse
    expect(body.artist).toMatchObject({ name: 'Daft Punk', inLibrary: false })
    expect(body.topTracks).toHaveLength(10)
    expect(body.albums).toHaveLength(38)
  })
})

describe('POST /api/tracks { catalog } (V2-PLAN T11 item 5)', () => {
  it(`validates the shape: a list of 1 to ${MAX_CATALOG_ADD}`, async () => {
    expect((await add('nope')).status).toBe(400)
    expect((await add([])).status).toBe(400)
    const tracks = await albumTracks()
    const tooMany = Array.from({ length: MAX_CATALOG_ADD + 1 }, (_, i) => ({ ...tracks[0], id: `deezer:${i + 1}` }))
    expect((await add(tooMany)).status).toBe(400)
  })

  it('adds a catalog song as a waiting catalog row with the catalog values', async () => {
    const [first] = await albumTracks()
    const response = await add([first])
    expect(response.status).toBe(200)
    const body = (await response.json()) as AddBody
    expect(body.results).toEqual([
      expect.objectContaining({ index: 0, line: 'deezer:67238728', status: 'added', message: 'Added' }),
    ])
    const rows = await sql`select * from tracks`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'catalog',
      source_id: 'deezer:67238728',
      source_url: '',
      status: 'waiting',
      raw_title: 'Give Life Back to Music',
      raw_artist: 'Daft Punk',
      title: 'Give Life Back to Music',
      artist: 'Daft Punk',
      album: 'Random Access Memories',
      album_artist: 'Daft Punk',
      duration_sec: 274,
      isrc: 'USQX91300101',
      ai_cleaned: false,
    })
    expect(String(rows[0].cover_url)).toMatch(/\/600x600-/)

    // The album page now flags it.
    const after = await albumTracks()
    expect(after.find((t) => t.id === first.id)).toMatchObject({ inLibrary: true })
  })

  it('answers "Already in your library" for the same id, the same ISRC, or a repeat in one request', async () => {
    const tracks = await albumTracks()
    await add([tracks[0]])
    const body = (await (
      await add([tracks[0], { ...tracks[1], id: 'deezer:1' }, { ...tracks[1], id: 'deezer:2' }, tracks[2], tracks[2]])
    ).json()) as AddBody
    expect(body.results.map((r) => r.status)).toEqual(['already', 'added', 'already', 'added', 'already'])
    expect(body.results[0].message).toBe('Already in your library')
    expect(Number((await sql`select count(*) as n from tracks`)[0].n)).toBe(3)
  })

  it('adds a whole album (Add album) in one request', async () => {
    const tracks = await albumTracks()
    const body = (await (await add(tracks)).json()) as AddBody
    expect(body.results.filter((r) => r.status === 'added')).toHaveLength(13)
    const albumBody = (await (await album('deezer:6575789')).json()) as CatalogAlbumResponse
    expect(albumBody.album.inLibrary).toBe(true)
  })

  it('fills a missing Deezer ISRC from /track/:id', async () => {
    const top = ((await (await artist('deezer:27')).json()) as CatalogArtistResponse).topTracks
    const hbfs = top.find((t) => t.id === 'deezer:3135556')
    expect(hbfs?.isrc).toBeNull() // artist top lists carry no ISRC
    await add([hbfs])
    const rows = await sql`select isrc from tracks where source_id = 'deezer:3135556'`
    expect(rows[0].isrc).toBe('GBDUW0000059')
  })

  it('reports bad items one by one and keeps the good ones', async () => {
    const [first] = await albumTracks()
    const body = (await (
      await add([{ id: 'youtube:abc', title: 'x' }, { ...first, title: '   ' }, 'text', { ...first, coverUrl: 'javascript:alert(1)' }])
    ).json()) as AddBody
    expect(body.results.map((r) => r.status)).toEqual(['error', 'error', 'error', 'added'])
    expect(body.results[0].message).toBe('Not a catalog song.')
    expect(body.results[1].message).toBe('That song has no title.')
    const rows = await sql`select cover_url from tracks`
    expect(rows).toEqual([{ cover_url: null }])
  })

  it('still adds pasted links through { urls } (unchanged path)', async () => {
    const response = await tracksPOST(
      new Request('http://localhost/api/tracks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['not a link'] }),
      }),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as AddBody).results[0].status).toBe('error')
  })
})
