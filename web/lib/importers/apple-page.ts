/**
 * Reading Apple Music's public pages (V2-PLAN T13, Adapters item 3). This is
 * the unofficial part of the Apple Music link importer, kept in one file so a
 * change on Apple's side is fixed here only.
 *
 * What the public playlist page exposes (checked live on 2026-10-16, see
 * e2e/fixtures/import-apple-link/README.md):
 *   - `<script type="application/json" id="serialized-server-data">` holds
 *     the page as JSON: `data[0].data.sections`.
 *   - The `containerDetailHeaderLockup` section has the playlist's title,
 *     owner (`subtitleLinks`), artwork and `trackCount`.
 *   - The `trackLockup` section has the songs in playlist order: `title`,
 *     `artistName`, the album (`tertiaryLinks[0].title`), `duration` in
 *     milliseconds, Apple's song id (`contentDescriptor.identifiers.storeAdamID`)
 *     and artwork. No ISRC.
 *   - At most 300 songs. A longer playlist also has `nextIntent`, which points
 *     at Apple's API; that needs the web player's token, so it is not used.
 * Library links (`/library/playlist/p.xxx`) open a page with no songs for
 * anyone but the logged in owner, so they are turned away by `parseAppleLink`.
 */

import type { ImportTrack } from './types'

/** The most songs Apple's public page lists for one playlist. */
export const APPLE_PAGE_SONG_LIMIT = 300

/** Cover size asked for in Apple's artwork address template. */
const COVER_SIZE = 600

export type AppleLink =
  | { kind: 'playlist'; storefront: string; id: string }
  /** A playlist in someone's own library: only they can open it. */
  | { kind: 'library' }
  /** A profile: Apple has no public list of a profile's playlists. */
  | { kind: 'profile' }
  /** Another Apple Music page (album, song, artist, ...). */
  | { kind: 'other' }
  | { kind: 'not-apple' }

const PLAYLIST_ID = /^pl\.[A-Za-z0-9-]{1,100}$/
const STOREFRONT = /^[a-z]{2}$/

function isAppleHost(host: string): boolean {
  return host === 'music.apple.com' || host.endsWith('.music.apple.com') || host === 'itunes.apple.com'
}

/** What one pasted line points at. */
export function parseAppleLink(raw: string): AppleLink {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return { kind: 'not-apple' }
  }
  if (!isAppleHost(url.hostname.toLowerCase())) return { kind: 'not-apple' }
  const parts = url.pathname.split('/').filter(Boolean)
  const lower = parts.map((part) => part.toLowerCase())
  if (lower.includes('library')) return lower.includes('playlist') ? { kind: 'library' } : { kind: 'other' }
  if (lower.includes('profile')) return { kind: 'profile' }
  const at = lower.indexOf('playlist')
  if (at === -1) return { kind: 'other' }
  const id = parts.slice(at + 1).find((part) => PLAYLIST_ID.test(part))
  if (!id) return { kind: 'other' }
  const storefront = STOREFRONT.test(lower[0] ?? '') ? lower[0] : 'us'
  return { kind: 'playlist', storefront, id }
}

/** The page's layout is not what this file knows: Apple changed something. */
export class ApplePageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApplePageError'
  }
}

export interface ApplePlaylistPage {
  id: string
  name: string
  /** The playlist's owner or curator, for example "Apple Music". */
  owner: string | null
  coverUrl: string | null
  /** What the page says; Apple caps it at 300 like the song list. */
  trackCount: number
  tracks: ImportTrack[]
  /** The playlist has more songs than the page lists (the 300 cap). */
  hasMore: boolean
}

type Json = Record<string, unknown>

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Apple's artwork addresses are templates: `.../{w}x{h}bb.{f}`. */
export function appleArtworkUrl(artwork: unknown): string | null {
  const template = str(obj(obj(artwork)?.dictionary)?.url)
  if (!template || !template.startsWith('https://')) return null
  return template.replace('{w}', String(COVER_SIZE)).replace('{h}', String(COVER_SIZE)).replace('{f}', 'jpg')
}

const SERVER_DATA = /<script[^>]*\bid="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/

function serverData(html: string): Json {
  const match = SERVER_DATA.exec(html)
  if (!match) throw new ApplePageError('no serialized-server-data script')
  try {
    const parsed = obj(JSON.parse(match[1]))
    if (!parsed) throw new ApplePageError('serialized-server-data is not an object')
    return parsed
  } catch (cause) {
    if (cause instanceof ApplePageError) throw cause
    throw new ApplePageError('serialized-server-data is not JSON')
  }
}

function songOf(item: unknown): ImportTrack | null {
  const song = obj(item)
  const title = str(song?.title)
  if (!song || !title) return null
  const descriptor = obj(song.contentDescriptor)
  const songId = str(obj(descriptor?.identifiers)?.storeAdamID)
  const artist =
    str(song.artistName) ??
    list(song.subtitleLinks)
      .map((link) => str(obj(link)?.title))
      .filter((name): name is string => name !== null)
      .join(', ')
  const duration = typeof song.duration === 'number' && song.duration > 0 ? Math.round(song.duration / 1000) : null
  return {
    // Apple's own song id; without one the core makes a ref from artist and title.
    ref: songId ?? '',
    title,
    artist,
    album: str(obj(list(song.tertiaryLinks)[0])?.title),
    durationSec: duration,
    isrc: null,
    coverUrl: appleArtworkUrl(song.artwork),
  }
}

/** The playlist on a public playlist page. Throws ApplePageError when the layout is unknown. */
export function parseApplePlaylistPage(html: string): ApplePlaylistPage {
  const root = serverData(html)
  const entry = obj(list(root.data)[0])
  const page = obj(entry?.data)
  if (!entry || !page) throw new ApplePageError('no page data')
  const intent = obj(entry.intent)
  if (intent?.$kind === 'LibraryPlaylistPageIntent') throw new ApplePageError('a library page')

  const sections = list(page.sections).map(obj).filter((section): section is Json => section !== null)
  const header = obj(list(sections.find((section) => section.itemKind === 'containerDetailHeaderLockup')?.items)[0])
  const name = str(header?.title)
  if (!header || !name) throw new ApplePageError('no playlist header')

  const id =
    str(obj(obj(header.contentDescriptor)?.identifiers)?.storeAdamID) ??
    str(obj(obj(intent?.contentDescriptor)?.identifiers)?.storeAdamID)
  if (!id) throw new ApplePageError('no playlist id')

  // An empty playlist has no song section at all.
  const items = list(sections.find((section) => section.itemKind === 'trackLockup')?.items)
  const tracks = items.map(songOf).filter((track): track is ImportTrack => track !== null)
  if (items.length > 0 && tracks.length === 0) throw new ApplePageError('songs without titles')

  const owner = str(obj(list(header.subtitleLinks)[0])?.title)
  const count = typeof header.trackCount === 'number' && header.trackCount >= 0 ? header.trackCount : tracks.length
  return {
    id,
    name,
    owner,
    coverUrl: appleArtworkUrl(header.artwork),
    trackCount: Math.max(count, tracks.length),
    tracks,
    hasMore: page.nextIntent !== undefined && page.nextIntent !== null,
  }
}
