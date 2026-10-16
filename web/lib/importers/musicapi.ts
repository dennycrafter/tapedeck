/**
 * MusicAPI login importer (V2-PLAN T13, Adapters item 1, "MusicAPI.com login").
 *
 * One log in for Spotify, Apple Music, YouTube Music, Tidal and Deezer through
 * MusicAPI.com's hosted log-in page, then every playlist plus Liked songs on
 * the checklist. Optional: it shows only when MUSICAPI_CLIENT_ID,
 * MUSICAPI_CLIENT_SECRET and MUSICAPI_SLUG are all set (or under
 * TAPEDECK_TEST=1, where a stand-in plays MusicAPI).
 *
 *   start    sends the browser to MusicAPI's page for that one service. The
 *            job id rides along in a signed `state` on the return address
 *            (./musicapi-state.ts), because MusicAPI has no state parameter.
 *   finish   checks the state, reads MusicAPI's `data64` answer and keeps
 *            only MusicAPI's user id for this listener in the job payload
 *            (`musicapiUser`). No music service token is ever stored: MusicAPI
 *            holds and refreshes those.
 *   listing  Liked songs (when the service has it) and all playlists, page by page.
 *   songs    one MusicAPI page per call; its `nextParam` is the core's cursor.
 *
 * The HTTP shape is in ./musicapi-client.ts, the stand-in in ./musicapi-standin.ts.
 * Decisions: docs/DECISIONS.md, "T13 MusicAPI login".
 */

import {
  MUSICAPI_SERVICE,
  decodeCallback,
  explain,
  isMissing,
  liveTransport,
  musicapiClient,
  musicapiConfig,
  musicapiLiveLoginBase,
  musicapiLoginUrl,
  type MusicapiClient,
  type MusicapiTrack,
} from './musicapi-client'
import { STANDIN_LOGIN_PATH, standinTransport } from './musicapi-standin'
import { signState, stateSecret, verifyState } from './musicapi-state'
import { ImportUserError, type ImportPlaylist, type ImportTrack, type Importer, type ImporterJob } from './types'

/** Playlist pages read for one listing (50 each; the core keeps 500 at most). */
export const MAX_PLAYLIST_PAGES = 12

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

/** MusicAPI's service names in plain words, for "you logged in to X". */
const MUSICAPI_LABELS: Readonly<Record<string, string>> = {
  spotify: 'Spotify',
  appleMusic: 'Apple Music',
  youtube: 'YouTube Music',
  tidal: 'Tidal',
  deezer: 'Deezer',
}

function client(): MusicapiClient {
  const config = musicapiConfig()
  if (!config) throw new ImportUserError('Log in with MusicAPI is not set up.')
  return musicapiClient(config.mode === 'live' ? liveTransport(config.clientId, config.clientSecret) : standinTransport)
}

async function secret(): Promise<string> {
  const value = await stateSecret()
  if (!value) throw new ImportUserError('Finish the setup first, then try again.')
  return value
}

/** MusicAPI's user id kept by `finish`, after checking the log in was for this job's service. */
function loggedInUser(job: ImporterJob): string {
  const user = job.payload.musicapiUser
  if (typeof user !== 'string' || !UUID.test(user)) throw new ImportUserError('Log in first.')
  const loggedIn = job.payload.musicapiService
  const wanted = MUSICAPI_SERVICE[job.service]
  if (typeof loggedIn === 'string' && wanted && loggedIn !== wanted) {
    const name = MUSICAPI_LABELS[loggedIn] ?? 'another service'
    throw new ImportUserError(`You logged in to ${name}. Start again and pick ${name} from the list.`)
  }
  return user
}

/** One MusicAPI song as an import song, or null without a title. */
export function toImportTrack(raw: MusicapiTrack, service: ImporterJob['service']): ImportTrack | null {
  const title = typeof raw?.name === 'string' ? raw.name.trim() : ''
  if (!title) return null
  const artist = (raw.artists ?? [])
    .map((entry) => (typeof entry?.name === 'string' ? entry.name.trim() : ''))
    .filter((name) => name !== '')
    .join(', ')
  const id = typeof raw.id === 'string' && raw.id ? raw.id : typeof raw.entryId === 'string' && raw.entryId ? raw.entryId : null
  const track: ImportTrack = {
    // Empty: the core makes a ref up from artist and title.
    ref: id ?? '',
    title,
    artist,
    album: typeof raw.album?.name === 'string' ? raw.album.name : null,
    durationSec: typeof raw.duration === 'number' && raw.duration > 0 ? Math.round(raw.duration / 1000) : null,
    isrc: typeof raw.isrc === 'string' ? raw.isrc : null,
    coverUrl: typeof raw.imageUrl === 'string' ? raw.imageUrl : null,
  }
  // A YouTube Music song is a YouTube video: keep that exact one (the normal YouTube pipeline).
  if (service === 'ytmusic' && id && YOUTUBE_ID.test(id)) track.link = `https://music.youtube.com/watch?v=${id}`
  return track
}

/** Liked songs as a checklist entry, or null when this service has no such list. */
async function likedEntry(api: MusicapiClient, user: string): Promise<ImportPlaylist | null> {
  try {
    const page = await api.likedTracks(user, null, 1)
    return { ref: 'liked', name: 'Liked songs', kind: 'liked', coverUrl: null, trackCount: page.totalItems ?? null }
  } catch (cause) {
    if (isMissing(cause)) return null
    throw cause
  }
}

async function listAll(api: MusicapiClient, user: string): Promise<ImportPlaylist[]> {
  const playlists: ImportPlaylist[] = []
  const liked = await likedEntry(api, user)
  if (liked) playlists.push(liked)
  let next: string | null = null
  for (let page = 0; page < MAX_PLAYLIST_PAGES; page++) {
    const result = await api.playlists(user, next)
    for (const playlist of result.results) {
      if (typeof playlist?.id !== 'string' || !playlist.id) continue
      playlists.push({
        ref: playlist.id,
        name: playlist.name,
        kind: 'playlist',
        coverUrl: playlist.imageUrl ?? null,
        trackCount: playlist.totalItems ?? null,
      })
    }
    if (!result.nextParam || result.nextParam === next) break
    next = result.nextParam
  }
  return playlists
}

export const musicapiImporter: Importer = {
  id: 'musicapi',
  label: 'MusicAPI login',
  services: ['spotify', 'apple', 'ytmusic', 'tidal', 'deezer'],
  methods: ['login'],
  isAvailable: (env = process.env) => musicapiConfig(env) !== null,
  hints: {
    login: 'Log in and pick from all your playlists and liked songs.',
  },

  async listPlaylists(_input, ctx) {
    const user = loggedInUser(ctx.job)
    try {
      return { playlists: await listAll(client(), user) }
    } catch (cause) {
      throw explain(cause)
    }
  },

  async getTracks(playlist, ctx) {
    const user = loggedInUser(ctx.job)
    const api = client()
    try {
      const page =
        playlist.ref === 'liked'
          ? await api.likedTracks(user, ctx.cursor)
          : await api.playlistItems(user, playlist.ref, ctx.cursor)
      const tracks = page.results
        .map((raw) => toImportTrack(raw, ctx.job.service))
        .filter((track): track is ImportTrack => track !== null)
      return { tracks, next: page.nextParam ?? null }
    } catch (cause) {
      if (isMissing(cause)) throw new ImportUserError(`The playlist "${playlist.name}" is gone.`)
      throw explain(cause)
    }
  },

  login: {
    async start({ jobId, service, callbackUrl }) {
      const config = musicapiConfig()
      const ms = MUSICAPI_SERVICE[service]
      if (!config || !ms) throw new ImportUserError('Log in with MusicAPI is not set up for this service.')
      const returnUrl = new URL(callbackUrl)
      returnUrl.searchParams.set('state', signState(jobId, await secret()))
      const base =
        config.mode === 'live' ? musicapiLiveLoginBase(config.slug) : new URL(STANDIN_LOGIN_PATH, callbackUrl).toString()
      return { redirectUrl: musicapiLoginUrl(base, returnUrl.toString(), ms) }
    },

    async finish(params) {
      const jobId = verifyState(params.get('state'), await secret())
      if (!jobId) throw new ImportUserError('That log in has expired. Start again.')
      const data = decodeCallback(params.get('data64'))
      const user = data?.integrationUserUUID
      if (!data || data.authModel?.status !== 'success' || typeof user !== 'string' || !UUID.test(user)) {
        throw new ImportUserError('The log in was cancelled or did not work. Try again.')
      }
      const service = typeof data.integration?.type === 'string' ? data.integration.type : null
      return { jobId, payload: { musicapiUser: user.toLowerCase(), musicapiService: service } }
    },
  },
}
