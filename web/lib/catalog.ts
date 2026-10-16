/**
 * Catalog adapter (V2-PLAN T11): songs, albums and artists from a free
 * public catalog, so Search works like a real streaming app.
 *
 *   - Deezer's public API (no key) is the main provider: /search,
 *     /search/album, /search/artist, /album/:id (+ /tracks), /artist/:id
 *     (+ /top, /albums) and /track/:id for the ISRC.
 *   - The iTunes Search API is the fallback when Deezer errors or takes
 *     longer than 3 seconds. Searches fall back per call; an album or artist
 *     page stays with the provider its id names (the ids do not translate).
 *   - The stand-in (lib/catalog-fixtures.ts) answers from recorded
 *     responses in tests and, on request, in offline development.
 *   - Every answer is cached in `search_cache` under a `catalog:` key for
 *     24 hours. The "In library" flags are never cached; the routes add them
 *     per request (lib/catalog-library.ts).
 *
 * Covers use the 600x600 size (the T3 rule: Deezer's CDN path rewritten from
 * 1000x1000, iTunes' 100x100bb to 600x600bb); lists get a small thumbnail.
 * Every outbound call goes through lib/http.ts so MSW intercepts it in tests.
 */

import { HttpError, httpJson } from './http'
import { deezerBigArtwork, itunesBigArtwork, stripAlbumSuffix } from './cover-art'
import { sql, type Row } from './db'
import { catalogUsesFixtures, fixtureResponse } from './catalog-fixtures'
import {
  splitCatalogId,
  type CatalogAlbum,
  type CatalogArtist,
  type CatalogProviderName,
  type CatalogRecordType,
  type CatalogSearchType,
  type CatalogTrack,
} from './catalog-types'

/** V2-PLAN T11: fall back to iTunes when Deezer takes longer than this. */
export const DEEZER_TIMEOUT_MS = 3_000
export const ITUNES_TIMEOUT_MS = 5_000
/** search_cache keys for the catalog start with this; YouTube keys are the bare query. */
export const CATALOG_CACHE_PREFIX = 'catalog:'

const DEEZER = 'https://api.deezer.com'
const ITUNES = 'https://itunes.apple.com'

export const SEARCH_LIMITS = { tracks: 25, albums: 25, artists: 10 } as const
const ARTIST_TOP_LIMIT = 10
const ARTIST_ALBUMS_LIMIT = 100
const ALBUM_TRACKS_LIMIT = 200

export interface CatalogAlbumDetail {
  album: CatalogAlbum & { durationSec: number | null; label: string | null }
  tracks: CatalogTrack[]
}

export interface CatalogArtistDetail {
  artist: CatalogArtist
  topTracks: CatalogTrack[]
  albums: CatalogAlbum[]
}

export interface CatalogSearchResult {
  tracks: CatalogTrack[]
  albums: CatalogAlbum[]
  artists: CatalogArtist[]
}

/** One interface, two implementations (V2-PLAN T11 item 1). */
export interface CatalogProvider {
  name: CatalogProviderName
  searchTracks(q: string): Promise<CatalogTrack[]>
  searchAlbums(q: string): Promise<CatalogAlbum[]>
  searchArtists(q: string): Promise<CatalogArtist[]>
  /** `rawId` is the provider's own id, without the `deezer:` prefix. */
  getAlbum(rawId: string): Promise<CatalogAlbumDetail>
  getArtist(rawId: string): Promise<CatalogArtistDetail>
}

/** The album or artist does not exist at the provider. */
export class CatalogNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogNotFoundError'
  }
}

/** The provider answered with an error body (Deezer sends those as HTTP 200). */
export class CatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Fetching (stand-in or network)
// ---------------------------------------------------------------------------

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  if (catalogUsesFixtures()) return fixtureResponse(url)
  return httpJson<unknown>(url, { timeoutMs })
}

function query(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
    .join('&')
}

interface DeezerErrorBody {
  error?: { type?: string; message?: string; code?: number }
}

/** Deezer reports failures as an `error` object in a 200 body; code 800 is "no data". */
async function deezerGet<T>(path: string): Promise<T> {
  const body = (await getJson(`${DEEZER}${path}`, DEEZER_TIMEOUT_MS)) as T & DeezerErrorBody
  const error = body && typeof body === 'object' ? body.error : undefined
  if (error) {
    if (error.code === 800) throw new CatalogNotFoundError(`Deezer has nothing at ${path}`)
    throw new CatalogUnavailableError(`Deezer error ${error.code ?? '?'} (${error.message ?? 'no message'}) at ${path}`)
  }
  return body
}

async function itunesGet<T>(path: string): Promise<T> {
  return (await getJson(`${ITUNES}${path}`, ITUNES_TIMEOUT_MS)) as T
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function year(value: unknown): string | null {
  const date = text(value)
  return date && /^\d{4}/.test(date) ? date.slice(0, 4) : null
}

function isrc(value: unknown): string | null {
  const code = text(value)?.toUpperCase()
  return code && /^[A-Z0-9]{12}$/.test(code) ? code : null
}

// ---------------------------------------------------------------------------
// Deezer
// ---------------------------------------------------------------------------

interface DzArtist {
  id?: number
  name?: string
  picture_xl?: string
  picture_medium?: string
  nb_album?: number
}

interface DzAlbum {
  id?: number
  title?: string
  cover_xl?: string
  cover_medium?: string
  release_date?: string
  nb_tracks?: number
  record_type?: string
  explicit_lyrics?: boolean
  duration?: number
  label?: string
  artist?: DzArtist
}

interface DzTrack {
  id?: number
  title?: string
  duration?: number
  isrc?: string
  track_position?: number
  disk_number?: number
  explicit_lyrics?: boolean
  artist?: DzArtist
  album?: DzAlbum
}

interface DzList<T> {
  data?: T[]
}

/** Deezer serves `/images/artist//...` (no image hash) when there is no picture. */
function dzImage(url: string | undefined): string | null {
  if (!url || /\/images\/[a-z]+\/\//.test(url)) return null
  return url
}

function dzCover(url: string | undefined): string | null {
  const image = dzImage(url)
  return image ? deezerBigArtwork(image) : null
}

function dzRecordType(value: unknown): CatalogRecordType {
  return value === 'single' || value === 'ep' || value === 'compile' ? value : 'album'
}

/** One Deezer track; `albumContext` fills album fields for album tracklists, which omit them. */
export function deezerTrack(raw: DzTrack, albumContext?: DzAlbum): CatalogTrack | null {
  const title = text(raw.title)
  if (!raw.id || !title) return null
  const album = albumContext ?? raw.album
  const artist = text(raw.artist?.name) ?? text(albumContext?.artist?.name) ?? ''
  return {
    id: `deezer:${raw.id}`,
    title,
    artist,
    artistId: raw.artist?.id ? `deezer:${raw.artist.id}` : null,
    album: text(album?.title),
    albumId: album?.id ? `deezer:${album.id}` : null,
    albumArtist: text(albumContext?.artist?.name) ?? (artist || null),
    coverUrl: dzCover(album?.cover_xl),
    thumbUrl: dzImage(album?.cover_medium),
    durationSec: positiveInt(raw.duration),
    isrc: isrc(raw.isrc),
    trackNumber: positiveInt(raw.track_position),
    discNumber: positiveInt(raw.disk_number),
    explicit: raw.explicit_lyrics === true,
  }
}

export function deezerAlbum(raw: DzAlbum, artistContext?: DzArtist): CatalogAlbum | null {
  const title = text(raw.title)
  if (!raw.id || !title) return null
  const artist = raw.artist ?? artistContext
  return {
    id: `deezer:${raw.id}`,
    title,
    artist: text(artist?.name) ?? '',
    artistId: artist?.id ? `deezer:${artist.id}` : null,
    coverUrl: dzCover(raw.cover_xl),
    thumbUrl: dzImage(raw.cover_medium),
    year: year(raw.release_date),
    trackCount: positiveInt(raw.nb_tracks),
    recordType: dzRecordType(raw.record_type),
    explicit: raw.explicit_lyrics === true,
  }
}

export function deezerArtist(raw: DzArtist): CatalogArtist | null {
  const name = text(raw.name)
  if (!raw.id || !name) return null
  return {
    id: `deezer:${raw.id}`,
    name,
    pictureUrl: dzCover(raw.picture_xl),
    thumbUrl: dzImage(raw.picture_medium),
    albumCount: positiveInt(raw.nb_album),
  }
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null)
}

export const deezerProvider: CatalogProvider = {
  name: 'deezer',
  async searchTracks(q) {
    const body = await deezerGet<DzList<DzTrack>>(`/search?${query({ q, limit: SEARCH_LIMITS.tracks })}`)
    return compact((body.data ?? []).map((raw) => deezerTrack(raw)))
  },
  async searchAlbums(q) {
    const body = await deezerGet<DzList<DzAlbum>>(`/search/album?${query({ q, limit: SEARCH_LIMITS.albums })}`)
    return compact((body.data ?? []).map((raw) => deezerAlbum(raw)))
  },
  async searchArtists(q) {
    const body = await deezerGet<DzList<DzArtist>>(`/search/artist?${query({ q, limit: SEARCH_LIMITS.artists })}`)
    return compact((body.data ?? []).map(deezerArtist))
  },
  async getAlbum(rawId) {
    const [header, list] = await Promise.all([
      deezerGet<DzAlbum>(`/album/${rawId}`),
      deezerGet<DzList<DzTrack>>(`/album/${rawId}/tracks?${query({ limit: ALBUM_TRACKS_LIMIT })}`),
    ])
    const album = deezerAlbum(header)
    if (!album) throw new CatalogNotFoundError(`Deezer album ${rawId} has no title`)
    return {
      album: { ...album, durationSec: positiveInt(header.duration), label: text(header.label) },
      tracks: compact((list.data ?? []).map((raw) => deezerTrack(raw, header))),
    }
  },
  async getArtist(rawId) {
    const [header, top, albums] = await Promise.all([
      deezerGet<DzArtist>(`/artist/${rawId}`),
      deezerGet<DzList<DzTrack>>(`/artist/${rawId}/top?${query({ limit: ARTIST_TOP_LIMIT })}`),
      deezerGet<DzList<DzAlbum>>(`/artist/${rawId}/albums?${query({ limit: ARTIST_ALBUMS_LIMIT })}`),
    ])
    const artist = deezerArtist(header)
    if (!artist) throw new CatalogNotFoundError(`Deezer artist ${rawId} has no name`)
    return {
      artist,
      topTracks: compact((top.data ?? []).map((raw) => deezerTrack(raw))),
      albums: compact((albums.data ?? []).map((raw) => deezerAlbum(raw, header))),
    }
  },
}

/** The ISRC of one Deezer track (`/track/:id`); search and album lists usually carry it already. */
async function deezerTrackIsrc(rawId: string): Promise<string | null> {
  const body = await deezerGet<DzTrack>(`/track/${rawId}`)
  return isrc(body.isrc)
}

// ---------------------------------------------------------------------------
// iTunes (fallback)
// ---------------------------------------------------------------------------

interface ItResult {
  wrapperType?: string
  kind?: string
  trackId?: number
  trackName?: string
  artistId?: number
  artistName?: string
  collectionId?: number
  collectionName?: string
  collectionArtistName?: string
  artworkUrl100?: string
  trackTimeMillis?: number
  trackNumber?: number
  discNumber?: number
  trackExplicitness?: string
  collectionExplicitness?: string
  releaseDate?: string
  trackCount?: number
  copyright?: string
}

interface ItResponse {
  results?: ItResult[]
}

function itThumb(artworkUrl100: string | undefined): string | null {
  return artworkUrl100 ? artworkUrl100.replace('100x100bb', '250x250bb') : null
}

function itRecordType(raw: ItResult): CatalogRecordType {
  const name = raw.collectionName ?? ''
  if (/\s-\sSingle$/i.test(name)) return 'single'
  if (/\s-\sEP$/i.test(name)) return 'ep'
  if (raw.artistName === 'Various Artists') return 'compile'
  return 'album'
}

export function itunesTrack(raw: ItResult, albumContext?: ItResult): CatalogTrack | null {
  const title = text(raw.trackName)
  if (raw.wrapperType !== 'track' || !raw.trackId || !title) return null
  const album = text(raw.collectionName)
  const artist = text(raw.artistName) ?? ''
  return {
    id: `itunes:${raw.trackId}`,
    title,
    artist,
    artistId: raw.artistId ? `itunes:${raw.artistId}` : null,
    album: album ? stripAlbumSuffix(album) : null,
    albumId: raw.collectionId ? `itunes:${raw.collectionId}` : null,
    albumArtist: text(albumContext?.artistName) ?? text(raw.collectionArtistName) ?? (artist || null),
    coverUrl: raw.artworkUrl100 ? itunesBigArtwork(raw.artworkUrl100) : null,
    thumbUrl: itThumb(raw.artworkUrl100),
    durationSec: positiveInt((raw.trackTimeMillis ?? 0) / 1000),
    isrc: null, // iTunes does not publish ISRCs
    trackNumber: positiveInt(raw.trackNumber),
    discNumber: positiveInt(raw.discNumber),
    explicit: raw.trackExplicitness === 'explicit',
  }
}

export function itunesAlbum(raw: ItResult): CatalogAlbum | null {
  const title = text(raw.collectionName)
  if (raw.wrapperType !== 'collection' || !raw.collectionId || !title) return null
  return {
    id: `itunes:${raw.collectionId}`,
    title: stripAlbumSuffix(title),
    artist: text(raw.artistName) ?? '',
    artistId: raw.artistId ? `itunes:${raw.artistId}` : null,
    coverUrl: raw.artworkUrl100 ? itunesBigArtwork(raw.artworkUrl100) : null,
    thumbUrl: itThumb(raw.artworkUrl100),
    year: year(raw.releaseDate),
    trackCount: positiveInt(raw.trackCount),
    recordType: itRecordType(raw),
    explicit: raw.collectionExplicitness === 'explicit',
  }
}

export function itunesArtist(raw: ItResult): CatalogArtist | null {
  const name = text(raw.artistName)
  if (raw.wrapperType !== 'artist' || !raw.artistId || !name) return null
  // The iTunes Search API has no artist pictures.
  return { id: `itunes:${raw.artistId}`, name, pictureUrl: null, thumbUrl: null, albumCount: null }
}

function itunesSearchPath(q: string, entity: string, limit: number): string {
  return `/search?${query({ term: q, entity, limit, country: 'US' })}`
}

export const itunesProvider: CatalogProvider = {
  name: 'itunes',
  async searchTracks(q) {
    const body = await itunesGet<ItResponse>(itunesSearchPath(q, 'song', SEARCH_LIMITS.tracks))
    return compact((body.results ?? []).map((raw) => itunesTrack(raw)))
  },
  async searchAlbums(q) {
    const body = await itunesGet<ItResponse>(itunesSearchPath(q, 'album', SEARCH_LIMITS.albums))
    return compact((body.results ?? []).map(itunesAlbum))
  },
  async searchArtists(q) {
    const body = await itunesGet<ItResponse>(itunesSearchPath(q, 'musicArtist', SEARCH_LIMITS.artists))
    return compact((body.results ?? []).map(itunesArtist))
  },
  async getAlbum(rawId) {
    const body = await itunesGet<ItResponse>(
      `/lookup?${query({ id: rawId, entity: 'song', limit: ALBUM_TRACKS_LIMIT, country: 'US' })}`,
    )
    const results = body.results ?? []
    const header = results.find((raw) => raw.wrapperType === 'collection')
    const album = header ? itunesAlbum(header) : null
    if (!header || !album) throw new CatalogNotFoundError(`iTunes has no album ${rawId}`)
    const tracks = compact(results.map((raw) => itunesTrack(raw, header)))
    const total = tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0)
    return {
      album: { ...album, durationSec: total > 0 ? total : null, label: text(header.copyright) },
      tracks,
    }
  },
  async getArtist(rawId) {
    const [albumsBody, songsBody] = await Promise.all([
      itunesGet<ItResponse>(`/lookup?${query({ id: rawId, entity: 'album', limit: ARTIST_ALBUMS_LIMIT, country: 'US' })}`),
      itunesGet<ItResponse>(`/lookup?${query({ id: rawId, entity: 'song', limit: ARTIST_TOP_LIMIT, country: 'US' })}`),
    ])
    const header = (albumsBody.results ?? []).find((raw) => raw.wrapperType === 'artist')
    const artist = header ? itunesArtist(header) : null
    if (!artist) throw new CatalogNotFoundError(`iTunes has no artist ${rawId}`)
    return {
      artist,
      topTracks: compact((songsBody.results ?? []).map((raw) => itunesTrack(raw))),
      albums: compact((albumsBody.results ?? []).map(itunesAlbum)),
    }
  },
}

const PROVIDERS: Record<CatalogProviderName, CatalogProvider> = {
  deezer: deezerProvider,
  itunes: itunesProvider,
}

// ---------------------------------------------------------------------------
// Cache (search_cache, `catalog:` keys, 24 hours)
// ---------------------------------------------------------------------------

const CACHE_TTL_SQL = "interval '24 hours'"

/** Lowercased, trimmed, spaces collapsed: "Daft  Punk " and "daft punk" share one entry. */
export function normalizeCatalogQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function readCache(key: string): Promise<unknown> {
  const rows = (await sql`
    select results from search_cache
    where q = ${key} and created_at > now() - ${sql.raw(CACHE_TTL_SQL)}
  `) as (Row & { results: unknown })[]
  const results = rows[0]?.results
  if (typeof results === 'string') return JSON.parse(results) as unknown
  return results ?? null
}

async function writeCache(key: string, value: unknown): Promise<void> {
  await sql`
    insert into search_cache (q, results) values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (q) do update set results = excluded.results, created_at = now()
  `
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const fullKey = `${CATALOG_CACHE_PREFIX}${key}`
  const hit = await readCache(fullKey)
  if (hit !== null) return hit as T
  const value = await load()
  try {
    await writeCache(fullKey, value)
  } catch (cause) {
    // A cache write never fails the answer the owner is waiting for.
    console.warn('[catalog] cache write failed:', cause)
  }
  return value
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

function fallbackWorthy(cause: unknown): boolean {
  return cause instanceof HttpError || cause instanceof CatalogUnavailableError
}

function describe(cause: unknown): string {
  if (cause instanceof HttpError) return `${cause.kind} ${cause.status ?? ''} ${cause.url}`.trim()
  return cause instanceof Error ? cause.message : String(cause)
}

/** Deezer first; iTunes when Deezer errors or times out (3 s). */
async function withFallback<T>(run: (provider: CatalogProvider) => Promise<T>): Promise<T> {
  try {
    return await run(deezerProvider)
  } catch (cause) {
    if (!fallbackWorthy(cause)) throw cause
    console.warn('[catalog] Deezer failed, using iTunes:', describe(cause))
    return run(itunesProvider)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function searchTracks(q: string): Promise<CatalogTrack[]> {
  return cached(`search:tracks:${normalizeCatalogQuery(q)}`, () => withFallback((p) => p.searchTracks(q)))
}

export function searchAlbums(q: string): Promise<CatalogAlbum[]> {
  return cached(`search:albums:${normalizeCatalogQuery(q)}`, () => withFallback((p) => p.searchAlbums(q)))
}

export function searchArtists(q: string): Promise<CatalogArtist[]> {
  return cached(`search:artists:${normalizeCatalogQuery(q)}`, () => withFallback((p) => p.searchArtists(q)))
}

/** The kinds a search type asks for, run in parallel; the others come back empty. */
export async function searchCatalog(q: string, type: CatalogSearchType): Promise<CatalogSearchResult> {
  const wants = (kind: Exclude<CatalogSearchType, 'all'>) => type === 'all' || type === kind
  const [tracks, albums, artists] = await Promise.all([
    wants('tracks') ? searchTracks(q) : Promise.resolve([]),
    wants('albums') ? searchAlbums(q) : Promise.resolve([]),
    wants('artists') ? searchArtists(q) : Promise.resolve([]),
  ])
  return { tracks, albums, artists }
}

function providerFor(id: string): { provider: CatalogProvider; rawId: string } {
  const parts = splitCatalogId(id)
  if (!parts) throw new CatalogNotFoundError(`Not a catalog id: ${id}`)
  return { provider: PROVIDERS[parts.provider], rawId: parts.rawId }
}

/** An album with its full tracklist. Throws CatalogNotFoundError for unknown ids. */
export function getAlbum(id: string): Promise<CatalogAlbumDetail> {
  const { provider, rawId } = providerFor(id)
  return cached(`album:${id}`, () => provider.getAlbum(rawId))
}

/** An artist with top tracks and albums. Throws CatalogNotFoundError for unknown ids. */
export function getArtist(id: string): Promise<CatalogArtistDetail> {
  const { provider, rawId } = providerFor(id)
  return cached(`artist:${id}`, () => provider.getArtist(rawId))
}

/**
 * The ISRC for a catalog song id, or null (iTunes ids, unknown songs, a
 * Deezer error). Never throws: a missing ISRC never blocks an add.
 */
export async function lookupIsrc(id: string): Promise<string | null> {
  const parts = splitCatalogId(id)
  if (!parts || parts.provider !== 'deezer') return null
  try {
    const found = await cached(`track-isrc:${id}`, async () => ({ isrc: await deezerTrackIsrc(parts.rawId) }))
    return found.isrc
  } catch (cause) {
    console.warn('[catalog] ISRC lookup failed:', describe(cause))
    return null
  }
}

/**
 * The catalog song with this ISRC (Deezer `/track/isrc:<ISRC>`; V2-PLAN T13
 * import matching), or null when Deezer has none. Cached like every catalog
 * answer. Other Deezer errors throw, so the caller can tell "no such song"
 * from "Deezer is down".
 */
export async function findTrackByIsrc(code: string): Promise<CatalogTrack | null> {
  const clean = isrc(code)
  if (!clean) return null
  const found = await cached(`isrc:${clean}`, async () => {
    try {
      return { track: deezerTrack(await deezerGet<DzTrack>(`/track/isrc:${clean}`)) }
    } catch (cause) {
      if (cause instanceof CatalogNotFoundError) return { track: null }
      throw cause
    }
  })
  return found.track
}
