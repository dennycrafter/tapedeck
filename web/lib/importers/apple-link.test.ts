/**
 * Apple Music link importer (V2-PLAN T13, Adapters item 3): link parsing,
 * the page reader against the pages recorded on 2026-10-16
 * (e2e/fixtures/import-apple-link/), the plain messages for wrong links,
 * missing playlists and a changed page, the live path through MSW (the same
 * recordings, served as Apple would), and a whole import over in-memory
 * PGlite with the recorded Deezer answers. Nothing reaches the network.
 */

process.env.TAPEDECK_TEST = '1'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { resetDb, sql } from '../db'
import { server, startTestMocks, stopTestMocks } from '../../e2e/mocks/server'
import { createJob } from '../import-jobs'
import { runChunk, runListing, startImport } from '../import-run'
import { APPLE_CHANGED, APPLE_UNREACHABLE, appleLinkImporter } from './apple-link'
import { ApplePageError, APPLE_PAGE_SONG_LIMIT, appleArtworkUrl, parseAppleLink, parseApplePlaylistPage } from './apple-page'
import { appleUsesFixtures, fetchApplePlaylistPage, fixturePage } from './apple-source'
import { ImportUserError, isPending, type ImportPlaylist, type ImporterJob, type ListResult, type TrackPage } from './types'

const DAFT_PUNK = 'pl.74657640b88c4587a426160f7441de46'
const USER_PLAYLIST = 'pl.u-11zB9vyskDZ1AX'
const TEN_YEARS = 'pl.c125e4b2998a4015abbe6b9ae90d5479'
const CHANGED = 'pl.u-tapedeckchanged'
const DAFT_PUNK_LINK = `https://music.apple.com/us/playlist/daft-punk-essentials/${DAFT_PUNK}`
const USER_LINK = `https://music.apple.com/gb/playlist/track-star/${USER_PLAYLIST}`

startTestMocks({ onUnhandledRequest: 'error' })

const requested: string[] = []
server.events.on('request:start', ({ request }) => {
  requested.push(request.url)
})

beforeAll(() => {
  vi.stubEnv('DATABASE_URL', '')
})

beforeEach(() => {
  requested.length = 0
})

afterEach(() => {
  server.resetHandlers()
  delete process.env.APPLE_SOURCE
  vi.restoreAllMocks()
})

afterAll(async () => {
  stopTestMocks()
  await resetDb()
  vi.unstubAllEnvs()
})

function job(payload: Record<string, unknown> = {}): ImporterJob {
  return { id: 'job-1', service: 'apple', method: 'link', payload }
}

async function list(links: string[]): Promise<ListResult> {
  const result = await appleLinkImporter.listPlaylists({ method: 'link', links }, { job: job({ links }) })
  if (isPending(result)) throw new Error('the Apple importer never waits for the PC')
  return result
}

async function tracks(playlist: ImportPlaylist, payload: Record<string, unknown> = {}): Promise<TrackPage> {
  const page = await appleLinkImporter.getTracks(playlist, { job: job(payload), cursor: null })
  if (isPending(page)) throw new Error('the Apple importer never waits for the PC')
  return page
}

async function listError(links: string[]): Promise<string> {
  const error = await list(links).then(
    () => null,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(ImportUserError)
  return (error as ImportUserError).message
}

/** Serves the recordings at music.apple.com, as Apple would. */
function serveRecordings(): void {
  server.use(
    http.get('https://music.apple.com/:storefront/playlist/:id', async ({ params }) => {
      const page = await fixturePage(String(params.id))
      return new HttpResponse(page.html, { status: page.status, headers: { 'content-type': 'text/html' } })
    }),
  )
}

describe('parseAppleLink', () => {
  it.each([
    [DAFT_PUNK_LINK, { kind: 'playlist', storefront: 'us', id: DAFT_PUNK }],
    [USER_LINK, { kind: 'playlist', storefront: 'gb', id: USER_PLAYLIST }],
    [`https://music.apple.com/ru/playlist/daft-punk-essentials/${DAFT_PUNK}?l=en-GB`, { kind: 'playlist', storefront: 'ru', id: DAFT_PUNK }],
    [`music.apple.com/us/playlist/${USER_PLAYLIST}`, { kind: 'playlist', storefront: 'us', id: USER_PLAYLIST }],
    [`https://embed.music.apple.com/de/playlist/x/${DAFT_PUNK}`, { kind: 'playlist', storefront: 'de', id: DAFT_PUNK }],
    [`https://music.apple.com/playlist/x/${DAFT_PUNK}`, { kind: 'playlist', storefront: 'us', id: DAFT_PUNK }],
    ['  https://MUSIC.apple.com/US/playlist/x/pl.u-abc123  ', { kind: 'playlist', storefront: 'us', id: 'pl.u-abc123' }],
    ['https://music.apple.com/us/library/playlist/p.ZOAXxZ7HKKK6NP', { kind: 'library' }],
    ['https://music.apple.com/library/playlist/p.ZOAXxZ7HKKK6NP?l=en-US', { kind: 'library' }],
    ['https://music.apple.com/profile/someone', { kind: 'profile' }],
    ['https://music.apple.com/us/album/expectations/6822390423?i=6822390426', { kind: 'other' }],
    ['https://music.apple.com/us/playlist/no-id-here', { kind: 'other' }],
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', { kind: 'not-apple' }],
    ['https://music.apple.com.example.com/us/playlist/x/pl.u-abc', { kind: 'not-apple' }],
    ['not a link at all', { kind: 'not-apple' }],
  ])('%s', (link, expected) => {
    expect(parseAppleLink(link)).toEqual(expected)
  })
})

describe('reading the recorded pages', () => {
  it('reads a curated playlist: name, owner, cover, songs in order with album and length', async () => {
    const page = parseApplePlaylistPage((await fixturePage(DAFT_PUNK)).html)
    expect(page).toMatchObject({ id: DAFT_PUNK, name: 'Daft Punk Essentials', owner: 'Apple Music Electronic', trackCount: 16, hasMore: false })
    expect(page.coverUrl).toMatch(/^https:\/\/is1-ssl\.mzstatic\.com\/image\/thumb\/.+\/600x600[^/]*\.jpg/)
    expect(page.tracks).toHaveLength(16)
    expect(page.tracks.map((track) => track.title).slice(0, 4)).toEqual(['Instant Crush', 'Veridis Quo', 'Around the World', 'One More Time'])
    const veridis = page.tracks[1]
    expect(veridis).toMatchObject({ title: 'Veridis Quo', artist: 'Daft Punk', durationSec: 345, isrc: null })
    expect(veridis.ref).toMatch(/^\d+$/)
    expect(veridis.album).toBeTruthy()
    expect(veridis.coverUrl).toMatch(/600x600.*\.jpg$/)
    expect(page.tracks[0].artist).toBe('Daft Punk & Julian Casablancas')
    expect(new Set(page.tracks.map((track) => track.ref)).size).toBe(16)
  })

  it('reads a playlist a person shared (pl.u- id)', async () => {
    const page = parseApplePlaylistPage((await fixturePage(USER_PLAYLIST)).html)
    expect(page).toMatchObject({ id: USER_PLAYLIST, owner: 'Playlist Owner', trackCount: 21, hasMore: false })
    expect(page.name.startsWith('Track Star')).toBe(true)
    expect(page.tracks).toHaveLength(21)
    expect(page.tracks[0]).toMatchObject({ title: 'Edge of Seventeen', artist: 'Wuki', durationSec: 164 })
  })

  it('reads the first 300 songs of a longer playlist and says there are more', async () => {
    const page = parseApplePlaylistPage((await fixturePage(TEN_YEARS)).html)
    expect(page.tracks).toHaveLength(APPLE_PAGE_SONG_LIMIT)
    expect(page).toMatchObject({ trackCount: 300, hasMore: true })
    expect(page.tracks[0]).toMatchObject({ title: 'Shape of You', artist: 'Ed Sheeran', durationSec: 234 })
  })

  it('fills in the artwork template', () => {
    expect(appleArtworkUrl({ dictionary: { url: 'https://is1-ssl.mzstatic.com/a/{w}x{h}bb.{f}' } })).toBe('https://is1-ssl.mzstatic.com/a/600x600bb.jpg')
    expect(appleArtworkUrl({ dictionary: { url: 'http://elsewhere/{w}x{h}.{f}' } })).toBeNull()
    expect(appleArtworkUrl(null)).toBeNull()
  })

  it.each([
    ['a page without the data script', async () => (await fixturePage(CHANGED)).html],
    ['broken JSON', async () => '<script type="application/json" id="serialized-server-data">{"data":[</script>'],
    ['no playlist header', async () => '<script type="application/json" id="serialized-server-data">{"data":[{"data":{"sections":[]}}]}</script>'],
    [
      'songs without titles',
      async () =>
        `<script type="application/json" id="serialized-server-data">${JSON.stringify({
          data: [
            {
              intent: {},
              data: {
                sections: [
                  { itemKind: 'containerDetailHeaderLockup', items: [{ title: 'X', contentDescriptor: { identifiers: { storeAdamID: 'pl.x' } } }] },
                  { itemKind: 'trackLockup', items: [{ name: 'renamed field' }] },
                ],
              },
            },
          ],
        })}</script>`,
    ],
    [
      'a library page',
      async () =>
        '<script type="application/json" id="serialized-server-data">{"data":[{"intent":{"$kind":"LibraryPlaylistPageIntent"},"data":{"sections":[]}}]}</script>',
    ],
  ])('throws ApplePageError for %s', async (_name, html) => {
    const text = await html()
    expect(() => parseApplePlaylistPage(text)).toThrow(ApplePageError)
  })

  it('reads an empty playlist as no songs', () => {
    const html = `<script type="application/json" id="serialized-server-data">${JSON.stringify({
      data: [{ data: { sections: [{ itemKind: 'containerDetailHeaderLockup', items: [{ title: 'Empty', contentDescriptor: { identifiers: { storeAdamID: 'pl.u-empty' } } }] }] } }],
    })}</script>`
    expect(parseApplePlaylistPage(html)).toMatchObject({ id: 'pl.u-empty', name: 'Empty', trackCount: 0, tracks: [] })
  })
})

describe('the importer', () => {
  it('is available with no setup, for Apple Music links, and says how to get a link', () => {
    expect(appleLinkImporter.isAvailable({} as NodeJS.ProcessEnv)).toBe(true)
    expect(appleLinkImporter.isAvailable({ TAPEDECK_TEST: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(appleLinkImporter.services).toEqual(['apple'])
    expect(appleLinkImporter.methods).toEqual(['link'])
    expect(appleLinkImporter.hints?.link).toContain('Share Playlist')
    expect(appleLinkImporter.hints?.link).toContain('300 songs')
  })

  it('reads the recordings under TAPEDECK_TEST=1, and the network otherwise', () => {
    expect(appleUsesFixtures({ TAPEDECK_TEST: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(appleUsesFixtures({ TAPEDECK_TEST: '1', APPLE_SOURCE: 'live' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(appleUsesFixtures({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('lists several playlists in the pasted order, once each, and keeps their country', async () => {
    const result = await list([DAFT_PUNK_LINK, '', USER_LINK, `https://music.apple.com/us/playlist/again/${DAFT_PUNK}`])
    expect(result.playlists.map((p) => [p.ref, p.name.slice(0, 20), p.trackCount, p.kind])).toEqual([
      [DAFT_PUNK, 'Daft Punk Essentials', 16, 'playlist'],
      [USER_PLAYLIST, 'Track Star \u{1F45F}✨\u{1F308}', 21, 'playlist'],
    ])
    expect(result.playlists[0].coverUrl).toMatch(/600x600/)
    expect(result.payload).toEqual({ appleStorefronts: { [DAFT_PUNK]: 'us', [USER_PLAYLIST]: 'gb' } })
    expect(requested).toEqual([])
  })

  it('logs the 300 song limit when a playlist has more', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = await list([`https://music.apple.com/us/playlist/ten/${TEN_YEARS}`])
    expect(result.playlists[0]).toMatchObject({ ref: TEN_YEARS, trackCount: 300 })
    expect(info).toHaveBeenCalledWith(expect.stringContaining('only the first 300 come over'))
  })

  it.each([
    [['https://music.apple.com/us/library/playlist/p.ZOAXxZ7HKKK6NP'], 'That link is to a playlist in your own library, which only you can open. In Apple Music, open the playlist, tap the three dots, then Share Playlist, then Copy, and paste that link here.'],
    [[DAFT_PUNK_LINK, 'https://music.apple.com/profile/someone'], "The link on line 2 is to a profile. Apple doesn't let apps list a profile's playlists, so paste a link to each playlist instead."],
    [['https://music.apple.com/us/album/expectations/6822390423'], 'That link is not to a playlist. Paste playlist links, one per line.'],
    [[DAFT_PUNK_LINK, USER_LINK, 'https://open.spotify.com/playlist/abc'], 'The link on line 3 is not an Apple Music link.'],
    [['https://music.apple.com/us/playlist/pl.u-zzzzzzzzzzzzzz'], "Apple Music couldn't find that playlist. Check the link, and that the playlist is shared."],
    [[DAFT_PUNK_LINK, 'https://music.apple.com/us/playlist/gone/pl.u-zzzzzzzzzzzzzz'], "Apple Music couldn't find the playlist on line 2. Check the link, and that the playlist is shared."],
  ])('turns away %j with a plain message', async (links, message) => {
    expect(await listError(links)).toBe(message)
  })

  it('says Apple Music changed something when the page cannot be read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await listError([`https://music.apple.com/us/playlist/x/${CHANGED}`])).toBe(APPLE_CHANGED)
    expect(APPLE_CHANGED.startsWith('Apple Music changed something')).toBe(true)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('no serialized-server-data'))
  })

  it('gives every song of a playlist in one page, read from its country', async () => {
    process.env.APPLE_SOURCE = 'live'
    serveRecordings()
    const page = await tracks({ ref: USER_PLAYLIST, name: 'Track Star' }, { appleStorefronts: { [USER_PLAYLIST]: 'gb' } })
    expect(page.tracks).toHaveLength(21)
    expect(page.next).toBeNull()
    expect(requested).toEqual([`https://music.apple.com/gb/playlist/${USER_PLAYLIST}`])
  })

  it('says plainly when a playlist is gone by the time its songs are read', async () => {
    await expect(tracks({ ref: 'pl.u-zzzzzzzzzzzzzz', name: 'Old one' })).rejects.toThrow(
      new ImportUserError(`Apple Music couldn't find "Old one" any more. Check that it is still shared.`),
    )
    await expect(tracks({ ref: '../../etc', name: 'Odd' })).rejects.toThrow(ImportUserError)
  })
})

describe('the live path (MSW serves the recordings)', () => {
  beforeEach(() => {
    process.env.APPLE_SOURCE = 'live'
  })

  it('reads the page built from the playlist id, never the pasted address', async () => {
    serveRecordings()
    const result = await list([`https://music.apple.com/us/playlist/daft-punk-essentials/${DAFT_PUNK}?l=en-GB&evil=1`, USER_LINK])
    expect(result.playlists.map((p) => p.ref)).toEqual([DAFT_PUNK, USER_PLAYLIST])
    expect(requested.sort()).toEqual([`https://music.apple.com/gb/playlist/${USER_PLAYLIST}`, `https://music.apple.com/us/playlist/${DAFT_PUNK}`])
  })

  it('treats a 404 as a missing playlist', async () => {
    serveRecordings()
    const page = await fetchApplePlaylistPage('us', 'pl.u-zzzzzzzzzzzzzz')
    expect(page.status).toBe(404)
    expect(await listError(['https://music.apple.com/us/playlist/pl.u-zzzzzzzzzzzzzz'])).toContain("couldn't find that playlist")
  })

  it('says Apple Music could not be reached on a server error or a dropped connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(http.get('https://music.apple.com/*', () => new HttpResponse('busy', { status: 503 })))
    expect(await listError([DAFT_PUNK_LINK])).toBe(APPLE_UNREACHABLE)
    server.use(http.get('https://music.apple.com/*', () => HttpResponse.error()))
    expect(await listError([DAFT_PUNK_LINK])).toBe(APPLE_UNREACHABLE)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('a whole import (PGlite, recorded Deezer answers)', () => {
  beforeEach(async () => {
    await sql`truncate import_items, import_jobs, tracks, playlists, playlist_tracks, album_favorites, play_events`
  })

  it('imports a shared playlist in order, matching songs the catalog knows', async () => {
    const links = [DAFT_PUNK_LINK]
    const created = await createJob({ service: 'apple', importer: 'apple-link', method: 'link', payload: { links } })
    const listed = await runListing(created, appleLinkImporter, { method: 'link', links })
    expect(listed).toMatchObject({ status: 'listed', error: '' })
    expect(listed.payload.appleStorefronts).toEqual({ [DAFT_PUNK]: 'us' })

    const started = await startImport(listed.id, [DAFT_PUNK])
    if (!('job' in started)) throw new Error(started.error)
    let done = false
    for (let request = 0; request < 20 && !done; request++) {
      const outcome = await runChunk(listed.id, appleLinkImporter)
      done = outcome?.done ?? true
    }
    expect(done).toBe(true)

    const playlistId = started.job.selected[0].playlistId
    const songs = (await sql`
      select t.title, t.source, t.source_id from playlist_tracks pt join tracks t on t.id = pt.track_id
      where pt.playlist_id = ${playlistId} order by pt.position`) as { title: string; source: string; source_id: string }[]
    expect(songs).toHaveLength(16)
    expect(songs.slice(0, 4).map((song) => song.title)).toEqual(['Instant Crush', 'Veridis Quo', 'Around the World', 'One More Time'])
    expect(songs.every((song) => song.source === 'catalog')).toBe(true)
    // Recorded in import-deezer.json: matched to the catalog by artist, title and length.
    const matched = songs.filter((song) => !song.source_id.startsWith('import:'))
    expect(matched.map((song) => song.title).sort()).toEqual(['One More Time', 'Something About Us', 'Veridis Quo'])
    // Everything else keeps Apple's own song id.
    expect(songs.find((song) => song.title === 'Instant Crush')?.source_id).toMatch(/^import:apple:\d+$/)
  })
})
