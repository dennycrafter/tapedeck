/**
 * Catalog adapter tests (V2-PLAN T11): Deezer parsing from recorded
 * responses, the 600x600 cover rule, the iTunes fallback on an error, an
 * error body and a timeout, the `catalog:` cache in search_cache, and the
 * fixture stand-in. The live path runs against MSW serving the same
 * recorded files (CATALOG_SOURCE=live); nothing reaches the network.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { delay, http, HttpResponse } from 'msw'

import { resetDb, sql } from './db'
import { server, startTestMocks, stopTestMocks } from '../e2e/mocks/server'
import { catalogHandlers } from '../e2e/mocks/catalog-handlers'
import {
  CatalogNotFoundError,
  DEEZER_TIMEOUT_MS,
  getAlbum,
  getArtist,
  lookupIsrc,
  searchCatalog,
} from './catalog'
import { catalogUsesFixtures, fixtureKey } from './catalog-fixtures'
import { isCatalogId, splitCatalogId } from './catalog-types'

startTestMocks({ onUnhandledRequest: 'error' })

const requested: string[] = []
server.events.on('request:start', ({ request }) => {
  requested.push(request.url)
})

beforeEach(async () => {
  await resetDb()
  requested.length = 0
  process.env.CATALOG_SOURCE = 'live'
  server.use(...catalogHandlers)
})

afterEach(() => {
  server.resetHandlers()
  delete process.env.CATALOG_SOURCE
})

afterAll(async () => {
  await resetDb()
  stopTestMocks()
})

const deezerDown = http.get('https://api.deezer.com/*', () => new HttpResponse('down', { status: 500 }))

describe('ids', () => {
  it('accepts provider-prefixed numeric ids only', () => {
    expect(isCatalogId('deezer:3135556')).toBe(true)
    expect(isCatalogId('itunes:617154241')).toBe(true)
    expect(isCatalogId('spotify:1')).toBe(false)
    expect(isCatalogId('deezer:12a')).toBe(false)
    expect(isCatalogId('deezer:')).toBe(false)
    expect(splitCatalogId('deezer:27')).toEqual({ provider: 'deezer', rawId: '27' })
  })
})

describe('fixture keys and stand-in switch', () => {
  it('sorts the query and normalises the search text', () => {
    expect(fixtureKey('https://api.deezer.com/search?q=Daft%20%20Punk%20&limit=25')).toBe('/search?limit=25&q=daft punk')
    expect(fixtureKey('https://itunes.apple.com/lookup?id=5&entity=song')).toBe('/lookup?entity=song&id=5')
    expect(fixtureKey('https://api.deezer.com/artist/27')).toBe('/artist/27')
  })

  it('uses fixtures in test mode, never in a real production deploy', () => {
    expect(catalogUsesFixtures({ TAPEDECK_TEST: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(catalogUsesFixtures({ TAPEDECK_TEST: '1', CATALOG_SOURCE: 'live' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(catalogUsesFixtures({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false)
    expect(catalogUsesFixtures({ NODE_ENV: 'development', CATALOG_SOURCE: 'fixtures' } as NodeJS.ProcessEnv)).toBe(true)
    expect(catalogUsesFixtures({ NODE_ENV: 'production', CATALOG_SOURCE: 'fixtures' } as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe('Deezer (recorded responses)', () => {
  it('searches songs, albums and artists with 600x600 covers and ISRCs', async () => {
    const result = await searchCatalog('Daft Punk', 'all')
    expect(result.tracks).toHaveLength(25)
    expect(result.albums.length).toBeGreaterThan(5)
    expect(result.artists[0]).toMatchObject({ id: 'deezer:27', name: 'Daft Punk' })

    const getLucky = result.tracks.find((track) => track.id === 'deezer:67238735')
    expect(getLucky).toMatchObject({
      title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
      artist: 'Daft Punk',
      artistId: 'deezer:27',
      album: 'Random Access Memories',
      albumId: 'deezer:6575789',
      durationSec: 367,
      isrc: 'USQX91300108',
    })
    expect(getLucky?.coverUrl).toMatch(/\/600x600-/)
    expect(getLucky?.thumbUrl).toMatch(/\/250x250-/)

    const discovery = result.albums.find((album) => album.id === 'deezer:302127')
    expect(discovery).toMatchObject({ title: 'Discovery', artist: 'Daft Punk', recordType: 'album', trackCount: 14 })
    expect(requested.every((url) => url.startsWith('https://api.deezer.com/'))).toBe(true)
  })

  it('only runs the kinds a search type asks for', async () => {
    const result = await searchCatalog('daft punk', 'artists')
    expect(result.tracks).toEqual([])
    expect(result.albums).toEqual([])
    expect(result.artists.length).toBeGreaterThan(0)
    expect(requested).toHaveLength(1)
  })

  it('gets an album with its full tracklist and the album artist', async () => {
    const detail = await getAlbum('deezer:6575789')
    expect(detail.album).toMatchObject({ title: 'Random Access Memories', artist: 'Daft Punk', year: '2013', label: 'Columbia' })
    expect(detail.album.coverUrl).toMatch(/\/600x600-/)
    expect(detail.tracks).toHaveLength(13)
    expect(detail.tracks[0]).toMatchObject({
      id: 'deezer:67238728',
      title: 'Give Life Back to Music',
      album: 'Random Access Memories',
      albumArtist: 'Daft Punk',
      trackNumber: 1,
      isrc: 'USQX91300101',
    })
    expect(detail.tracks.every((track) => track.coverUrl === detail.album.coverUrl)).toBe(true)
  })

  it('gets an artist with top songs and every album', async () => {
    const detail = await getArtist('deezer:27')
    expect(detail.artist).toMatchObject({ id: 'deezer:27', name: 'Daft Punk', albumCount: 38 })
    expect(detail.artist.pictureUrl).toMatch(/\/600x600-/)
    expect(detail.topTracks).toHaveLength(10)
    expect(detail.albums).toHaveLength(38)
    expect(detail.albums.every((album) => album.artist === 'Daft Punk')).toBe(true)
    expect(new Set(detail.albums.map((album) => album.recordType))).toEqual(new Set(['album', 'ep', 'single']))
  })

  it('throws CatalogNotFoundError for an unknown album (Deezer "no data" body)', async () => {
    await expect(getAlbum('deezer:999')).rejects.toBeInstanceOf(CatalogNotFoundError)
  })

  it('looks up a missing ISRC through /track/:id and never throws', async () => {
    expect(await lookupIsrc('deezer:3135556')).toBe('GBDUW0000059')
    expect(await lookupIsrc('itunes:1')).toBeNull()
    expect(await lookupIsrc('deezer:999')).toBeNull()
  })
})

describe('cache (search_cache, catalog: keys, 24 hours)', () => {
  it('serves a repeat search from the cache without calling Deezer', async () => {
    await searchCatalog('Daft Punk', 'tracks')
    expect(requested).toHaveLength(1)
    await searchCatalog('  daft   punk ', 'tracks')
    expect(requested).toHaveLength(1)
    const rows = await sql`select q from search_cache order by q`
    expect(rows.map((row) => row.q)).toEqual(['catalog:search:tracks:daft punk'])
  })

  it('calls again once the entry is older than 24 hours', async () => {
    await getAlbum('deezer:302127')
    const first = requested.length
    await sql`update search_cache set created_at = now() - interval '25 hours'`
    await getAlbum('deezer:302127')
    expect(requested.length).toBe(first * 2)
  })
})

describe('iTunes fallback', () => {
  it('falls back to iTunes when Deezer answers with an HTTP error', async () => {
    server.use(deezerDown)
    const result = await searchCatalog('Daft Punk', 'all')
    expect(result.tracks.length).toBeGreaterThan(0)
    expect(result.tracks.every((track) => track.id.startsWith('itunes:'))).toBe(true)
    expect(result.tracks[0].coverUrl).toMatch(/600x600bb/)
    expect(result.tracks[0].isrc).toBeNull()
    expect(result.artists[0]).toMatchObject({ id: 'itunes:5468295', name: 'Daft Punk', pictureUrl: null })
    expect(result.albums.length).toBeGreaterThan(0)
  })

  it('falls back when Deezer sends an error body (quota)', async () => {
    server.use(
      http.get('https://api.deezer.com/*', () =>
        HttpResponse.json({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }),
      ),
    )
    const result = await searchCatalog('Daft Punk', 'tracks')
    expect(result.tracks[0].id).toMatch(/^itunes:/)
  })

  it(`falls back when Deezer takes longer than ${DEEZER_TIMEOUT_MS} ms`, async () => {
    server.use(
      http.get('https://api.deezer.com/*', async () => {
        await delay(DEEZER_TIMEOUT_MS + 6_000)
        return HttpResponse.json({ data: [], total: 0 })
      }),
    )
    await sql`select 1` // boot the test database before timing
    const started = Date.now()
    const result = await searchCatalog('Daft Punk', 'tracks')
    expect(result.tracks[0].id).toMatch(/^itunes:/)
    expect(Date.now() - started).toBeLessThan(DEEZER_TIMEOUT_MS + 3_000)
  })

  it('reads iTunes albums and artists for itunes: ids', async () => {
    const album = await getAlbum('itunes:617154241')
    expect(album.album.title).toBe('Random Access Memories')
    expect(album.tracks.length).toBeGreaterThanOrEqual(13)
    expect(album.tracks[0]).toMatchObject({ albumId: 'itunes:617154241', albumArtist: 'Daft Punk', trackNumber: 1 })
    const artist = await getArtist('itunes:5468295')
    expect(artist.artist.name).toBe('Daft Punk')
    expect(artist.albums.length).toBeGreaterThan(5)
    expect(artist.topTracks.length).toBeGreaterThan(0)
  })

  it('keeps a deezer: album page with Deezer (no iTunes fallback for ids)', async () => {
    server.use(deezerDown)
    await expect(getAlbum('deezer:6575789')).rejects.toThrow()
    expect(requested.some((url) => url.includes('itunes.apple.com'))).toBe(false)
  })
})

describe('stand-in (fixtures, the test-mode default)', () => {
  it('answers from the recorded files without any network call', async () => {
    delete process.env.CATALOG_SOURCE
    server.resetHandlers() // no catalog handlers: a network call would hit onUnhandledRequest: 'error'
    const result = await searchCatalog('Daft Punk', 'all')
    expect(result.tracks).toHaveLength(25)
    const album = await getAlbum('deezer:6575789')
    expect(album.tracks).toHaveLength(13)
    expect((await searchCatalog('nothing recorded for this', 'all')).tracks).toEqual([])
    await expect(getArtist('deezer:999')).rejects.toBeInstanceOf(CatalogNotFoundError)
    expect(requested).toEqual([])
  })
})
