/**
 * The stand-in importer (SPEC 4.1 pattern, V2-PLAN T13): fixture playlists
 * for the "Test music service", so the whole import flow runs in tests with
 * no network. Available only under TAPEDECK_TEST=1 (every e2e and unit test
 * run); a real deploy never shows it.
 *
 * It fills all three connect slots:
 *   - Log in: "logs in" by sending the browser straight back to the callback.
 *   - Paste a link: any link lists the fixture playlists. A link containing
 *     "broken" fails with a plain message; one containing "waiting-for-pc"
 *     waits for the PC until the job payload has `pcListed: true` (what a
 *     PC adapter's complete endpoint would store through releasePcJob).
 *   - File: any file lists the fixture playlists.
 *
 * The songs cover each matching path against the recorded Deezer fixtures
 * (e2e/fixtures/import-deezer.json): an ISRC match, artist + title search
 * matches, a song the catalog does not have, a length that is too far off
 * (so it is not matched), the same song in two playlists, and a direct
 * SoundCloud link that keeps its link.
 */

import { ImportUserError, PENDING, type ImportPlaylist, type ImportTrack, type Importer } from './types'

interface FakePlaylist extends ImportPlaylist {
  tracks: ImportTrack[]
}

const HARDER: ImportTrack = {
  ref: 'fake-1',
  title: 'Harder, Better, Faster, Stronger',
  artist: 'Daft Punk',
  album: 'Discovery',
  durationSec: 226,
  isrc: 'GBDUW0000059',
}

export const FAKE_PLAYLISTS: readonly FakePlaylist[] = [
  {
    ref: 'liked',
    name: 'Liked songs',
    kind: 'liked',
    coverUrl: null,
    trackCount: 3,
    tracks: [
      HARDER,
      { ref: 'fake-2', title: 'Something About Us', artist: 'Daft Punk', durationSec: 232 },
      { ref: 'fake-3', title: 'Paper Lanterns', artist: 'The Fixture Band', album: 'Stand-in Songs', durationSec: 201 },
    ],
  },
  {
    ref: 'pl-road-trip',
    name: 'Road trip',
    kind: 'playlist',
    coverUrl: null,
    trackCount: 4,
    tracks: [
      { ref: 'fake-4', title: 'Veridis Quo', artist: 'Daft Punk', durationSec: 345 },
      HARDER,
      // A long DJ edit: the catalog's One More Time is 320 s, too far off to be this one.
      { ref: 'fake-5', title: 'One More Time', artist: 'Daft Punk', durationSec: 600 },
      {
        ref: 'fake-6',
        title: 'Night Drive (Official Audio)',
        artist: 'fixture-sounds',
        durationSec: 187,
        link: 'https://soundcloud.com/fixture-sounds/night-drive',
      },
    ],
  },
  {
    ref: 'pl-chill',
    name: 'Chill',
    kind: 'playlist',
    coverUrl: null,
    trackCount: 1,
    tracks: [{ ref: 'fake-7', title: 'Slow Morning', artist: 'The Fixture Band', durationSec: 240 }],
  },
]

/** Songs per getTracks page, small so the cursor is exercised. */
export const FAKE_PAGE_SIZE = 3

function listing(): { playlists: ImportPlaylist[] } {
  return {
    playlists: FAKE_PLAYLISTS.map((playlist) => ({
      ref: playlist.ref,
      name: playlist.name,
      kind: playlist.kind,
      coverUrl: playlist.coverUrl,
      trackCount: playlist.trackCount,
    })),
  }
}

export const fakeImporter: Importer = {
  id: 'fake',
  label: 'Test music service (stand-in)',
  services: ['test'],
  methods: ['login', 'link', 'file'],
  isAvailable: (env = process.env) => env.TAPEDECK_TEST === '1',
  hints: {
    login: 'Log in to the test service.',
    link: 'Any link works here. This service only exists in tests.',
    file: 'Any file works here.',
  },
  fileAccept: '.csv,.txt,.xml,.json',

  async listPlaylists(input, ctx) {
    if (input.method === 'link') {
      if (input.links.some((link) => link.includes('broken'))) {
        throw new ImportUserError("That link didn't work. Check it and try again.")
      }
      if (input.links.some((link) => link.includes('waiting-for-pc')) && ctx.job.payload.pcListed !== true) {
        return PENDING
      }
    }
    if (input.method === 'login' && typeof ctx.job.payload.userId !== 'string') {
      throw new ImportUserError('Log in first.')
    }
    return listing()
  },

  async getTracks(playlist, ctx) {
    const found = FAKE_PLAYLISTS.find((candidate) => candidate.ref === playlist.ref)
    if (!found) throw new ImportUserError(`The playlist "${playlist.name}" is gone.`)
    const start = ctx.cursor ? Number(ctx.cursor) : 0
    const end = start + FAKE_PAGE_SIZE
    return { tracks: found.tracks.slice(start, end), next: end < found.tracks.length ? String(end) : null }
  },

  login: {
    async start({ jobId, callbackUrl }) {
      const url = new URL(callbackUrl)
      url.searchParams.set('state', jobId)
      url.searchParams.set('code', 'test-code')
      return { redirectUrl: url.toString() }
    },
    async finish(params) {
      const jobId = params.get('state') ?? ''
      if (params.get('error') || !params.get('code')) throw new ImportUserError('The log in was cancelled.')
      return { jobId, payload: { userId: 'test-user' } }
    },
  },
}
