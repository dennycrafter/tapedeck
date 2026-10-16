/**
 * Reading Spotify's public pages (V2-PLAN T13, Adapters item 2). This is
 * unofficial: Spotify can change these pages at any time, so every guess
 * about their shape lives in this file, and a page that no longer looks the
 * way we expect raises `SpotifyChangedError` (shown as "Spotify changed
 * something, try the login option").
 *
 * What the public pages show (checked live on 2026-10-16, see the
 * "T13 Spotify link" decisions and e2e/fixtures/import-spotify-link/):
 *
 *   - Playlist: the embed page `open.spotify.com/embed/playlist/<id>` carries
 *     a `__NEXT_DATA__` JSON with the playlist's name, cover and its first
 *     100 songs (title, artists as one "A, B" string, length in ms, track
 *     uri). No album, no ISRC, and no way to page past 100 without
 *     Spotify's private API, which needs a session token we do not use.
 *     A missing or private playlist answers HTTP 200 with an error page
 *     (`pageProps.status` 404); a hiccup answers the same way with 500.
 *   - Profile: `open.spotify.com/user/<id>` is a script-only shell for
 *     browsers, but a non-browser user agent gets the server-rendered page,
 *     whose `initialState` (base64 JSON) lists the first 10 public
 *     playlists (name, cover, uri) and the total count. An unknown user
 *     answers HTTP 404.
 *
 * Only the `entities` part of `initialState` and the `entity` part of
 * `__NEXT_DATA__` are read; the session data next to them is ignored.
 * All requests go through lib/http.ts (MSW in unit tests); under
 * TAPEDECK_TEST=1 the recorded pages are served instead (./spotify-fixtures.ts).
 */

import { HttpError, httpResponse } from '../http'

/** Honest, non-browser: Spotify serves the server-rendered profile page to it. */
export const SPOTIFY_USER_AGENT = 'Tapedeck/2 (+https://github.com/dennycrafter/tapedeck)'
export const SPOTIFY_BASE = 'https://open.spotify.com'
export const SPOTIFY_TIMEOUT_MS = 10_000

/** The embed page lists at most this many songs. */
export const EMBED_SONG_LIMIT = 100
/** The profile page lists at most this many public playlists. */
export const PROFILE_PLAYLIST_LIMIT = 10

const ID = /^[A-Za-z0-9]{22}$/

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The page loaded but no longer has the data where we expect it. */
export class SpotifyChangedError extends Error {
  constructor(detail: string) {
    super(`Spotify page changed: ${detail}`)
    this.name = 'SpotifyChangedError'
  }
}

/** The playlist or profile does not exist, or is private. */
export class SpotifyNotFoundError extends Error {
  constructor(what: string) {
    super(`Spotify ${what} not found`)
    this.name = 'SpotifyNotFoundError'
  }
}

/** Spotify did not answer properly (timeout, network, 5xx, or its own "try again later" page). */
export class SpotifyUnavailableError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`Spotify unavailable: ${detail}`, options)
    this.name = 'SpotifyUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type SpotifyLink =
  | { kind: 'playlist'; id: string }
  | { kind: 'profile'; user: string }
  /** A Spotify link of another kind (song, album, artist, podcast, short link). */
  | { kind: 'other'; what: string }
  | { kind: 'invalid' }

const OTHER_KINDS: Record<string, string> = {
  track: 'song',
  album: 'album',
  artist: 'artist',
  episode: 'podcast',
  show: 'podcast',
  collection: 'Liked songs',
}

function playlistOrInvalid(id: string | undefined): SpotifyLink {
  return id && ID.test(id) ? { kind: 'playlist', id } : { kind: 'invalid' }
}

function profile(user: string | undefined): SpotifyLink {
  if (!user) return { kind: 'invalid' }
  let decoded: string
  try {
    decoded = decodeURIComponent(user)
  } catch {
    return { kind: 'invalid' }
  }
  return decoded.trim() ? { kind: 'profile', user: decoded.trim() } : { kind: 'invalid' }
}

/**
 * What a pasted line points at. Accepts `open.spotify.com` links (with or
 * without `intl-xx/`, `embed/`, `?si=`), the old `/user/<u>/playlist/<id>`
 * form, and `spotify:` uris.
 */
export function parseSpotifyLink(raw: string): SpotifyLink {
  const text = raw.trim()
  if (text.toLowerCase().startsWith('spotify:')) {
    const parts = text.split(':').slice(1)
    if (parts[0] === 'playlist') return playlistOrInvalid(parts[1])
    if (parts[0] === 'user' && parts[2] === 'playlist') return playlistOrInvalid(parts[3])
    if (parts[0] === 'user' && parts[2] === 'collection') return { kind: 'other', what: 'Liked songs' }
    if (parts[0] === 'user' && parts.length === 2) return profile(parts[1])
    if (parts[0] && OTHER_KINDS[parts[0]]) return { kind: 'other', what: OTHER_KINDS[parts[0]] }
    return { kind: 'invalid' }
  }

  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { kind: 'invalid' }
  }
  const host = url.hostname.toLowerCase()
  if (host === 'spotify.link' || host === 'spotify.app.link') return { kind: 'other', what: 'short link' }
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return { kind: 'invalid' }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0]?.startsWith('intl-')) segments.shift()
  if (segments[0] === 'embed') segments.shift()
  const [first, second, third, fourth] = segments
  if (first === 'playlist') return playlistOrInvalid(second)
  if (first === 'user' && third === 'playlist') return playlistOrInvalid(fourth)
  if (first === 'user' && third === 'collection') return { kind: 'other', what: 'Liked songs' }
  if (first === 'user' && (third === undefined || third === 'playlists')) return profile(second)
  if (first === 'collection') return { kind: 'other', what: 'Liked songs' }
  if (first && OTHER_KINDS[first]) return { kind: 'other', what: OTHER_KINDS[first] }
  return { kind: 'invalid' }
}

/** The page path (no host) the adapter reads for a playlist or a profile. */
export function embedPath(playlistId: string): string {
  return `embed/playlist/${playlistId}`
}

export function profilePath(user: string): string {
  return `user/${encodeURIComponent(user)}`
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Reads one page: the network through lib/http.ts, or the recorded pages in tests. */
export type PageFetcher = (path: string) => Promise<string>

/** The live fetcher. HTTP 404 becomes SpotifyNotFoundError, other failures SpotifyUnavailableError. */
export const fetchSpotifyPage: PageFetcher = async (path) => {
  const url = `${SPOTIFY_BASE}/${path}`
  try {
    const response = await httpResponse(url, {
      timeoutMs: SPOTIFY_TIMEOUT_MS,
      headers: { 'user-agent': SPOTIFY_USER_AGENT, 'accept-language': 'en' },
    })
    return await response.text()
  } catch (cause) {
    if (cause instanceof HttpError && cause.status === 404) throw new SpotifyNotFoundError(path)
    if (cause instanceof HttpError) throw new SpotifyUnavailableError(`${cause.kind} ${cause.status ?? ''} for ${path}`.trim(), { cause })
    throw cause
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** A name with plain spaces: Spotify joins artists with a comma and a no-break space (U+00A0), which `\s` matches. */
function name(value: unknown): string | null {
  const text = str(value)?.replace(/\s+/g, ' ').trim()
  return text ? text : null
}

function scriptBody(html: string, id: string): string | null {
  const pattern = new RegExp(`<script[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</script>`)
  return pattern.exec(html)?.[1] ?? null
}

/** The largest image of a `sources` list. */
function bestImage(sources: unknown): string | null {
  if (!Array.isArray(sources)) return null
  let best: { url: string; size: number } | null = null
  for (const source of sources) {
    if (!isObject(source)) continue
    const url = str(source.url)
    if (!url) continue
    const size = typeof source.width === 'number' ? source.width : 0
    if (!best || size > best.size) best = { url, size }
  }
  return best?.url ?? null
}

export interface EmbedSong {
  /** The track id, or the uri after `spotify:` for local files. */
  ref: string
  title: string
  artist: string
  durationSec: number | null
}

export interface EmbedPlaylist {
  id: string
  name: string
  coverUrl: string | null
  songs: EmbedSong[]
}

function songRef(uri: string): string | null {
  const match = /^spotify:track:([A-Za-z0-9]{22})$/.exec(uri)
  if (match) return match[1]
  if (uri.startsWith('spotify:local:')) return uri.slice('spotify:'.length)
  return null
}

/** The playlist on an embed page. Throws SpotifyNotFoundError, SpotifyUnavailableError or SpotifyChangedError. */
export function parseEmbedPage(html: string, id: string): EmbedPlaylist {
  const body = scriptBody(html, '__NEXT_DATA__')
  if (body === null) throw new SpotifyChangedError('no __NEXT_DATA__ on the embed page')
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new SpotifyChangedError('__NEXT_DATA__ is not JSON')
  }
  const pageProps = isObject(data) && isObject(data.props) && isObject(data.props.pageProps) ? data.props.pageProps : null
  if (!pageProps) throw new SpotifyChangedError('no pageProps on the embed page')

  const state = isObject(pageProps.state) ? pageProps.state : null
  const entity = state && isObject(state.data) && isObject(state.data.entity) ? state.data.entity : null
  if (!entity) {
    // The error page: { status, title, description } instead of the state.
    if (pageProps.status === 404) throw new SpotifyNotFoundError(`playlist ${id}`)
    if (typeof pageProps.status === 'number' && pageProps.status >= 500) {
      throw new SpotifyUnavailableError(`embed error page ${pageProps.status} for ${id}`)
    }
    throw new SpotifyChangedError('no entity on the embed page')
  }
  if (entity.type !== 'playlist' || !Array.isArray(entity.trackList)) {
    throw new SpotifyChangedError('the embed entity is not a playlist with a trackList')
  }

  const songs: EmbedSong[] = []
  for (const item of entity.trackList) {
    if (!isObject(item)) continue
    // Podcast episodes can sit in a playlist; Tapedeck is for music.
    if (item.entityType !== undefined && item.entityType !== 'track') continue
    const uri = str(item.uri)
    const title = name(item.title)
    const ref = uri ? songRef(uri) : null
    if (!ref || !title) continue
    const ms = typeof item.duration === 'number' && item.duration > 0 ? item.duration : null
    songs.push({ ref, title, artist: name(item.subtitle) ?? '', durationSec: ms === null ? null : Math.round(ms / 1000) })
  }
  if (entity.trackList.length > 0 && songs.length === 0 && !entity.trackList.some((item) => isObject(item) && item.entityType === 'episode')) {
    throw new SpotifyChangedError('no song on the embed page could be read')
  }

  const playlistName = name(entity.name) ?? name(entity.title)
  if (!playlistName) throw new SpotifyChangedError('the embed playlist has no name')
  const cover = isObject(entity.coverArt) ? bestImage(entity.coverArt.sources) : null
  return { id: str(entity.id) ?? id, name: playlistName, coverUrl: cover, songs }
}

export interface ProfilePlaylist {
  id: string
  name: string
  coverUrl: string | null
}

export interface SpotifyProfile {
  name: string
  playlists: ProfilePlaylist[]
  /** Every public playlist the profile has; the page shows only the first 10. */
  totalCount: number | null
}

/** The public playlists on a server-rendered profile page. Throws SpotifyChangedError. */
export function parseProfilePage(html: string, user: string): SpotifyProfile {
  const body = scriptBody(html, 'initialState')
  if (body === null) throw new SpotifyChangedError('no initialState on the profile page')
  let state: unknown
  try {
    state = JSON.parse(Buffer.from(body.trim(), 'base64').toString('utf8'))
  } catch {
    throw new SpotifyChangedError('initialState is not base64 JSON')
  }
  const items = isObject(state) && isObject(state.entities) && isObject(state.entities.items) ? state.entities.items : null
  if (!items) throw new SpotifyChangedError('no entities on the profile page')
  const wanted = `spotify:user:${user}`.toLowerCase()
  const users = Object.entries(items).filter(([, item]) => isObject(item) && item.__typename === 'User')
  const found = users.find(([uri]) => uri.toLowerCase() === wanted) ?? users[0]
  const entry = found?.[1]
  if (!isObject(entry)) throw new SpotifyChangedError('no user on the profile page')
  const lists = entry.publicPlaylistsV2
  if (!isObject(lists) || !Array.isArray(lists.items)) throw new SpotifyChangedError('no publicPlaylistsV2 on the profile page')

  const playlists: ProfilePlaylist[] = []
  for (const wrapper of lists.items) {
    if (!isObject(wrapper) || !isObject(wrapper.data)) continue
    const data = wrapper.data
    if (data.__typename !== undefined && data.__typename !== 'Playlist') continue
    const uri = str(data.uri) ?? str(wrapper._uri)
    const id = uri?.startsWith('spotify:playlist:') ? uri.slice('spotify:playlist:'.length) : null
    const playlistName = name(data.name)
    if (!id || !ID.test(id) || !playlistName) continue
    const images = isObject(data.images) && Array.isArray(data.images.items) ? data.images.items : []
    const first = images.find(isObject)
    playlists.push({ id, name: playlistName, coverUrl: first ? bestImage(first.sources) : null })
  }
  if (lists.items.length > 0 && playlists.length === 0) throw new SpotifyChangedError('no playlist on the profile page could be read')
  return {
    name: name(entry.name) ?? user,
    playlists,
    totalCount: typeof lists.totalCount === 'number' ? lists.totalCount : null,
  }
}
