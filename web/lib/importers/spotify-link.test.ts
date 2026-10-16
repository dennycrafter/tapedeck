/**
 * Spotify link importer (V2-PLAN T13, Adapters item 2): link parsing, the
 * recorded pages (e2e/fixtures/import-spotify-link/pages.json) through the
 * TAPEDECK_TEST stand-in, the live path through lib/http.ts against MSW
 * serving the same recordings (SPOTIFY_SOURCE=live), the plain messages for
 * every failure, and one import through the core. Nothing reaches Spotify.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { resetDb, sql } from '../db'
import { server, startTestMocks, stopTestMocks } from '../../e2e/mocks/server'
import { catalogHandlers } from '../../e2e/mocks/catalog-handlers'
import { createJob } from '../import-jobs'
import { runChunk, runListing, startImport } from '../import-run'
import { connectOptions } from './index'
import {
  loadSpotifyRecordings,
  MISSING_PLAYLIST_PATH,
  recordedPageHtml,
  recordedResponse,
  spotifyUsesFixtures,
  type RecordedPage,
  type SpotifyRecordings,
} from './spotify-fixtures'
import {
  SPOTIFY_CHANGED_MESSAGE,
  SPOTIFY_DOWN_MESSAGE,
  SPOTIFY_LINK_HINT,
  spotifyLinkImporter,
} from './spotify-link'
import { EMBED_SONG_LIMIT, parseEmbedPage, parseProfilePage, parseSpotifyLink, SPOTIFY_USER_AGENT } from './spotify-pages'
import { ImportUserError, isPending, type ImportPlaylist, type ListResult, type TrackPage } from './types'

const ESSENTIALS = '5FPvD2X2jBM782H8zGgjT3' // Daft Punk Essentials, 49 songs
const ALL_OUT_80S = '37i9dQZF1DX4UtSsGT1Sbe' // 150 songs; the embed page shows 100
const TOP_HITS = '37i9dQZF1DXcBWIGoYBM5M' // the first playlist on the "spotify" profile
const ESSENTIALS_LINK = `https://open.spotify.com/playlist/${ESSENTIALS}?si=abc123`
const PROFILE_LINK = 'https://open.spotify.com/user/spotify'

const ctx = { job: { id: 'job-1', service: 'spotify' as const, method: 'link' as const, payload: {} } }

async function list(...links: string[]): Promise<ListResult> {
  const result = await spotifyLinkImporter.listPlaylists({ method: 'link', links }, ctx)
  if (isPending(result)) throw new Error('the Spotify link importer never waits for the PC')
  return result
}

async function tracks(ref: string, name = 'A playlist'): Promise<TrackPage> {
  const page = await spotifyLinkImporter.getTracks({ ref, name }, { ...ctx, cursor: null })
  if (isPending(page)) throw new Error('the Spotify link importer never waits for the PC')
  return page
}

async function listError(...links: string[]): Promise<string> {
  const error = await list(...links).then(
    () => null,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(ImportUserError)
  return (error as ImportUserError).message
}

let recordings: SpotifyRecordings
const requested: { url: string; userAgent: string | null }[] = []

/** MSW answers open.spotify.com from the recordings, like the stand-in does. */
const spotifyHandler = http.get('https://open.spotify.com/*', ({ request }) => {
  const url = new URL(request.url)
  const { status, html } = recordedResponse(recordings, url.pathname)
  return new HttpResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
})

function serve(path: string, page: RecordedPage | string, status = 200) {
  const body = typeof page === 'string' ? page : recordedPageHtml(page)
  server.use(http.get(`https://open.spotify.com/${path}`, () => new HttpResponse(body, { status, headers: { 'content-type': 'text/html' } })))
}

function embedEntity(id: string): Record<string, unknown> {
  const page = recordings.pages[`embed/playlist/${id}`] as { nextData: { props: { pageProps: { state: { data: { entity: Record<string, unknown> } } } } } }
  return structuredClone(page.nextData.props.pageProps.state.data.entity)
}

function embedPage(entity: Record<string, unknown>): RecordedPage {
  return { status: 200, nextData: { props: { pageProps: { state: { data: { entity } } } } } }
}

beforeAll(async () => {
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
  recordings = await loadSpotifyRecordings()
  startTestMocks({ onUnhandledRequest: 'error' })
  server.events.on('request:start', ({ request }) => {
    requested.push({ url: request.url, userAgent: request.headers.get('user-agent') })
  })
})

afterAll(async () => {
  stopTestMocks()
  await resetDb()
  vi.unstubAllEnvs()
})

beforeEach(() => {
  requested.length = 0
  server.use(spotifyHandler, ...catalogHandlers)
})

afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  vi.stubEnv('TAPEDECK_TEST', '1')
  vi.stubEnv('DATABASE_URL', '')
})

describe('links', () => {
  it('reads playlist links in every shape Spotify shares', () => {
    const playlist = { kind: 'playlist', id: ESSENTIALS }
    for (const link of [
      `https://open.spotify.com/playlist/${ESSENTIALS}`,
      `https://open.spotify.com/playlist/${ESSENTIALS}?si=1a2b3c&pi=x`,
      `open.spotify.com/playlist/${ESSENTIALS}`,
      `https://open.spotify.com/intl-de/playlist/${ESSENTIALS}`,
      `https://open.spotify.com/embed/playlist/${ESSENTIALS}?utm_source=generator`,
      `https://open.spotify.com/user/daftpunk/playlist/${ESSENTIALS}`,
      `https://play.spotify.com/playlist/${ESSENTIALS}`,
      `spotify:playlist:${ESSENTIALS}`,
      `spotify:user:daftpunk:playlist:${ESSENTIALS}`,
      `  ${ESSENTIALS_LINK}  `,
    ]) {
      expect(parseSpotifyLink(link), link).toEqual(playlist)
    }
  })

  it('reads profile links', () => {
    expect(parseSpotifyLink(PROFILE_LINK)).toEqual({ kind: 'profile', user: 'spotify' })
    expect(parseSpotifyLink('https://open.spotify.com/user/11182345678?si=x')).toEqual({ kind: 'profile', user: '11182345678' })
    expect(parseSpotifyLink('https://open.spotify.com/intl-fr/user/denis.p/playlists')).toEqual({ kind: 'profile', user: 'denis.p' })
    expect(parseSpotifyLink('https://open.spotify.com/user/caf%C3%A9')).toEqual({ kind: 'profile', user: 'café' })
    expect(parseSpotifyLink('spotify:user:spotify')).toEqual({ kind: 'profile', user: 'spotify' })
  })

  it('names the other kinds of Spotify links, and rejects the rest', () => {
    expect(parseSpotifyLink('https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV')).toEqual({ kind: 'other', what: 'song' })
    expect(parseSpotifyLink('https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc')).toEqual({ kind: 'other', what: 'album' })
    expect(parseSpotifyLink('spotify:artist:4tZwfgrHOc3mvqYlEYSvVi')).toEqual({ kind: 'other', what: 'artist' })
    expect(parseSpotifyLink('https://open.spotify.com/collection/tracks')).toEqual({ kind: 'other', what: 'Liked songs' })
    expect(parseSpotifyLink('spotify:user:denis:collection')).toEqual({ kind: 'other', what: 'Liked songs' })
    expect(parseSpotifyLink('https://spotify.link/AbCdEf123')).toEqual({ kind: 'other', what: 'short link' })
    for (const link of [
      'https://open.spotify.com/playlist/short',
      'https://music.apple.com/us/playlist/x/pl.123',
      'https://example.com/playlist/5FPvD2X2jBM782H8zGgjT3',
      'not a link at all',
      'https://open.spotify.com/',
    ]) {
      expect(parseSpotifyLink(link), link).toEqual({ kind: 'invalid' })
    }
  })
})

describe('the importer in the app', () => {
  it('is available without keys, fills the Spotify link slot, and says what it cannot do', () => {
    expect(spotifyLinkImporter.isAvailable({} as NodeJS.ProcessEnv)).toBe(true)
    expect(connectOptions('spotify', { TAPEDECK_TEST: '1' } as unknown as NodeJS.ProcessEnv)).toContainEqual({
      method: 'link',
      importer: 'spotify-link',
      hint: SPOTIFY_LINK_HINT,
    })
    expect(SPOTIFY_LINK_HINT).toContain('Public playlists only')
    expect(SPOTIFY_LINK_HINT).toContain('first 100 songs')
    expect(SPOTIFY_LINK_HINT).toContain('up to 10 playlists')
  })

  it('reads the recordings under TAPEDECK_TEST=1 unless told to go live', () => {
    expect(spotifyUsesFixtures({ TAPEDECK_TEST: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(spotifyUsesFixtures({ TAPEDECK_TEST: '1', SPOTIFY_SOURCE: 'live' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(spotifyUsesFixtures({} as NodeJS.ProcessEnv)).toBe(false)
  })
})

// The same checks run twice: on the stand-in, and through lib/http.ts + MSW.
describe.each([
  { path: 'the recorded pages (stand-in)', live: false },
  { path: 'the network path (MSW)', live: true },
])('reading Spotify through $path', ({ live }) => {
  beforeEach(() => {
    if (live) vi.stubEnv('SPOTIFY_SOURCE', 'live')
  })

  afterEach(() => {
    if (live) {
      expect(requested.length).toBeGreaterThan(0)
      for (const request of requested) {
        expect(request.url.startsWith('https://open.spotify.com/')).toBe(true)
        expect(request.userAgent).toBe(SPOTIFY_USER_AGENT)
      }
    } else {
      expect(requested).toEqual([])
    }
  })

  it('a playlist link lists that playlist with its cover and song count', async () => {
    const { playlists } = await list(ESSENTIALS_LINK)
    expect(playlists).toEqual([
      {
        ref: ESSENTIALS,
        name: 'Daft Punk Essentials',
        coverUrl: 'https://image-cdn-ak.spotifycdn.com/image/ab67706c0000da84e7ca9ca9e0336b3382e1556d',
        trackCount: 49,
        kind: 'playlist',
      },
    ])
  })

  it('a profile link lists its first 10 public playlists, in order', async () => {
    const { playlists } = await list(PROFILE_LINK)
    expect(playlists).toHaveLength(10)
    expect(playlists.slice(0, 3).map((p) => [p.ref, p.name])).toEqual([
      [TOP_HITS, 'Today’s Top Hits'],
      ['37i9dQZF1DX0XUsuxWHRQd', 'RapCaviar'],
      ['37i9dQZF1DX1lVhptIYRda', 'Hot Country'],
    ])
    expect(playlists[0]).toMatchObject({ trackCount: null, kind: 'playlist', coverUrl: expect.stringMatching(/^https:\/\/i\.scdn\.co\/image\//) })
  })

  it('several links list together, each playlist once', async () => {
    const { playlists } = await list(PROFILE_LINK, ESSENTIALS_LINK, `https://open.spotify.com/playlist/${TOP_HITS}`, `spotify:playlist:${ESSENTIALS}`)
    expect(playlists.map((p) => p.ref)).toHaveLength(11)
    expect(playlists[0].ref).toBe(TOP_HITS)
    expect(playlists[10]).toMatchObject({ ref: ESSENTIALS, name: 'Daft Punk Essentials' })
  })

  it('a playlist gives its songs in order, with artists and length, on one page', async () => {
    const page = await tracks(ESSENTIALS, 'Daft Punk Essentials')
    expect(page.next).toBeNull()
    expect(page.tracks).toHaveLength(49)
    expect(page.tracks.slice(0, 2)).toEqual([
      { ref: '0DiWol3AO6WpXZgp0goxAV', title: 'One More Time', artist: 'Daft Punk', durationSec: 320 },
      { ref: '2LD2gT7gwAurzdQDQtILds', title: 'Veridis Quo', artist: 'Daft Punk', durationSec: 345 },
    ])
    expect(page.tracks[4]).toMatchObject({ title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', artist: 'Daft Punk, Pharrell Williams, Nile Rodgers' })
    for (const track of page.tracks) expect(track.isrc ?? null).toBeNull()
  })

  it('a long playlist brings its first 100 songs (all the public page shows)', async () => {
    const { playlists } = await list(`https://open.spotify.com/playlist/${ALL_OUT_80S}`)
    expect(playlists[0]).toMatchObject({ name: 'All Out 80s', trackCount: EMBED_SONG_LIMIT })
    const page = await tracks(ALL_OUT_80S, 'All Out 80s')
    expect(page.tracks).toHaveLength(EMBED_SONG_LIMIT)
    expect(page.next).toBeNull()
  })

  it('a playlist that is gone or private says so, naming the link', async () => {
    const link = 'https://open.spotify.com/playlist/0000000000000000000000'
    expect(await listError(ESSENTIALS_LINK, link)).toBe(
      `Couldn't open this playlist. Check the link, and that the playlist is public: ${link}`,
    )
    await expect(tracks('0000000000000000000000', 'Old mix')).rejects.toThrow(
      `Couldn't open "Old mix" on Spotify. Check that it is still public.`,
    )
  })

  it('a profile that does not exist says so', async () => {
    const link = 'https://open.spotify.com/user/0000notarealuser0000'
    expect(await listError(link)).toBe(`Couldn't find this Spotify profile: ${link}`)
  })
})

describe('plain messages before Spotify is asked', () => {
  it('checks every line first and names the problem', async () => {
    expect(await listError(ESSENTIALS_LINK, 'https://music.apple.com/us/playlist/x/pl.123')).toBe(
      'This is not a Spotify playlist or profile link: https://music.apple.com/us/playlist/x/pl.123',
    )
    expect(await listError('https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc')).toBe(
      'This is a Spotify album link. Paste a playlist or profile link instead: https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc',
    )
    expect(await listError('https://open.spotify.com/collection/tracks')).toContain('Spotify keeps Liked songs private')
    expect(await listError('https://spotify.link/AbCdEf123')).toContain('starts with open.spotify.com')
    expect(await listError('   ')).toBe('Paste a Spotify playlist or profile link.')
    expect(requested).toEqual([])
  })

  it('shortens a very long link in the message', async () => {
    const message = await listError(`https://example.com/${'x'.repeat(200)}`)
    expect(message.length).toBeLessThan(140)
    expect(message.endsWith('...')).toBe(true)
  })

  it('only takes pasted links', async () => {
    await expect(spotifyLinkImporter.listPlaylists({ method: 'login' }, ctx)).rejects.toThrow('Paste a Spotify link.')
  })
})

describe('when Spotify changes or stumbles (live path)', () => {
  beforeEach(() => {
    vi.stubEnv('SPOTIFY_SOURCE', 'live')
  })

  it('a page without the expected data asks for the login option', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    serve(`embed/playlist/${ESSENTIALS}`, '<html><body>A brand new page</body></html>')
    expect(await listError(ESSENTIALS_LINK)).toBe(SPOTIFY_CHANGED_MESSAGE)
    await expect(tracks(ESSENTIALS)).rejects.toThrow(SPOTIFY_CHANGED_MESSAGE)

    serve('user/spotify', '<html><script id="initialState" type="text/plain">not base64 json</script></html>')
    expect(await listError(PROFILE_LINK)).toBe(SPOTIFY_CHANGED_MESSAGE)

    serve('user/spotify', { status: 200, initialState: { entities: { items: { 'spotify:user:spotify': { __typename: 'User', name: 'Spotify' } } } } })
    expect(await listError(PROFILE_LINK)).toBe(SPOTIFY_CHANGED_MESSAGE)

    // The songs moved to another key: every song unreadable is a change, not an empty playlist.
    const entity = embedEntity(ESSENTIALS)
    entity.trackList = (entity.trackList as Record<string, unknown>[]).map(({ title, ...rest }) => ({ ...rest, name: title }))
    serve(`embed/playlist/${ESSENTIALS}`, embedPage(entity))
    expect(await listError(ESSENTIALS_LINK)).toBe(SPOTIFY_CHANGED_MESSAGE)
    // The log says what moved, for whoever fixes the parser.
    expect(errors.mock.calls.map((call) => String(call[1]))).toEqual(expect.arrayContaining([expect.stringContaining('Spotify page changed')]))
    errors.mockRestore()
  })

  it('Spotify being down asks to try again (a timeout is the same HttpError path)', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Spotify's own "Page not available" embed page, recorded while recording.
    serve(`embed/playlist/${ESSENTIALS}`, recordings.unavailable)
    expect(await listError(ESSENTIALS_LINK)).toBe(SPOTIFY_DOWN_MESSAGE)
    serve('user/spotify', 'busy', 503)
    expect(await listError(PROFILE_LINK)).toBe(SPOTIFY_DOWN_MESSAGE)
    server.use(http.get(`https://open.spotify.com/embed/playlist/${ESSENTIALS}`, () => HttpResponse.error()))
    await expect(tracks(ESSENTIALS)).rejects.toThrow(SPOTIFY_DOWN_MESSAGE)
    warnings.mockRestore()
  })
})

describe('parsing details', () => {
  it('skips podcast episodes and keeps local files', () => {
    const entity = embedEntity(ESSENTIALS)
    const list = entity.trackList as Record<string, unknown>[]
    list.splice(1, 0, { ...list[1], uri: 'spotify:episode:4rOoJ6Egrf8K2IrywzwOMk', entityType: 'episode', title: 'A podcast' })
    list.splice(2, 0, { ...list[1], uri: 'spotify:local:Artist:Album:My+Demo:200', entityType: 'track', title: 'My Demo', duration: 200_000 })
    const html = recordedPageHtml(embedPage(entity))
    const songs = parseEmbedPage(html, ESSENTIALS).songs
    expect(songs).toHaveLength(50)
    expect(songs.map((song) => song.title)).not.toContain('A podcast')
    expect(songs[1]).toEqual({ ref: 'local:Artist:Album:My+Demo:200', title: 'My Demo', artist: 'Daft Punk', durationSec: 200 })
  })

  it('a profile with no public playlists lists none (the core then says so)', () => {
    const page = structuredClone(recordings.pages['user/spotify']) as { initialState: { entities: { items: Record<string, { publicPlaylistsV2: { items: unknown[]; totalCount: number } }> } } }
    page.initialState.entities.items['spotify:user:spotify'].publicPlaylistsV2 = { items: [], totalCount: 0 }
    const profile = parseProfilePage(recordedPageHtml(page as unknown as RecordedPage), 'spotify')
    expect(profile).toMatchObject({ name: 'Spotify', playlists: [], totalCount: 0 })
  })

  it('the recorded profile shows 10 of its public playlists, and the stand-in knows the missing pages', () => {
    const profile = parseProfilePage(recordedPageHtml(recordings.pages['user/spotify']), 'spotify')
    expect(profile.playlists).toHaveLength(10)
    expect(profile.totalCount).toBeGreaterThan(10)
    expect(recordedResponse(recordings, `/embed/playlist/1234567890123456789012`)).toEqual(recordedResponse(recordings, MISSING_PLAYLIST_PATH))
    expect(recordedResponse(recordings, 'user/someone-else').status).toBe(404)
  })

  it('the recordings hold no session data', () => {
    const text = JSON.stringify(recordings)
    expect(text).not.toMatch(/accessToken|clientId|"session"/i)
  })
})

describe('through the core', () => {
  beforeEach(async () => {
    await sql`truncate import_items, import_jobs, tracks, playlists, playlist_tracks, album_favorites, play_events`
  })

  it('lists a pasted link, imports the playlist in order, and matches what the catalog knows', async () => {
    const links = [ESSENTIALS_LINK]
    const created = await createJob({ service: 'spotify', importer: 'spotify-link', method: 'link', payload: { links } })
    const listed = await runListing(created, spotifyLinkImporter, { method: 'link', links })
    expect(listed.status).toBe('listed')
    expect(listed.playlists?.map((p: ImportPlaylist) => [p.ref, p.name, p.trackCount])).toEqual([[ESSENTIALS, 'Daft Punk Essentials', 49]])

    const started = await startImport(listed.id, [ESSENTIALS])
    expect('job' in started).toBe(true)
    for (let requests = 0; requests < 20; requests++) {
      const outcome = await runChunk(listed.id, spotifyLinkImporter)
      if (outcome?.done) break
    }
    const rows = (await sql`
      select t.source_id, t.title, t.duration_sec from playlist_tracks pt
      join tracks t on t.id = pt.track_id
      join playlists p on p.id = pt.playlist_id
      where p.name = 'Daft Punk Essentials' order by pt.position`) as { source_id: string; title: string; duration_sec: number }[]
    // 49 songs, 47 rows: the core's "already in your library" rule ignores
    // brackets, so "Contact (Drumless Edition)" and "Give Life Back to Music
    // (Drumless Edition)" join their album versions, already in this playlist.
    expect(rows).toHaveLength(47)
    expect(rows.map((row) => row.title)).not.toContain('Contact (Drumless Edition)')
    // The recorded Deezer answers: matched by artist + title + length.
    expect(rows[0]).toMatchObject({ source_id: 'deezer:3135553', title: 'One More Time' })
    expect(rows[1]).toMatchObject({ source_id: 'deezer:3135563', title: 'Veridis Quo' })
    expect(rows[24]).toMatchObject({ source_id: 'deezer:3135561', title: 'Something About Us' })
    // No match: kept with Spotify's own names and length.
    expect(rows[3]).toMatchObject({ source_id: 'import:spotify:5W3cjX2J3tjhG8zb6u0qHn', title: 'Harder, Better, Faster, Stronger', duration_sec: 226 })
  })
})
