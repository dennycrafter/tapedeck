/**
 * Catalog search shapes (V2-PLAN T11), shared by the server (web/lib/catalog.ts,
 * the /api/catalog routes, the catalog add in POST /api/tracks) and the
 * browser (search page, catalog artist and album pages). No server imports
 * here, so client components can use these types.
 *
 * Ids carry their provider: `deezer:3135556` or `itunes:617154241`. A
 * catalog song added to the library keeps its id as `tracks.source_id`.
 */

export type CatalogProviderName = 'deezer' | 'itunes'

/** One song in the catalog. Also the item shape POST /api/tracks takes as `catalog`. */
export interface CatalogTrack {
  /** `deezer:<id>` or `itunes:<id>`. */
  id: string
  title: string
  artist: string
  artistId: string | null
  album: string | null
  albumId: string | null
  albumArtist: string | null
  /** The 600x600 cover stored on the track (same size rule as T3). */
  coverUrl: string | null
  /** A small cover for result lists; never stored. */
  thumbUrl: string | null
  durationSec: number | null
  isrc: string | null
  trackNumber: number | null
  discNumber: number | null
  explicit: boolean
}

/** `album`, `single`, `ep` or `compile` (Deezer's record types; iTunes is mapped onto them). */
export type CatalogRecordType = 'album' | 'single' | 'ep' | 'compile'

export interface CatalogAlbum {
  id: string
  title: string
  artist: string
  artistId: string | null
  coverUrl: string | null
  thumbUrl: string | null
  /** Release year, for example "2013". */
  year: string | null
  trackCount: number | null
  recordType: CatalogRecordType
  explicit: boolean
}

export interface CatalogArtist {
  id: string
  name: string
  pictureUrl: string | null
  thumbUrl: string | null
  albumCount: number | null
}

/** Every result the routes return carries this flag (V2-PLAN T11 item 2). */
export interface InLibraryFlag {
  inLibrary: boolean
}

export type CatalogTrackResult = CatalogTrack & InLibraryFlag
export type CatalogAlbumResult = CatalogAlbum & InLibraryFlag
export type CatalogArtistResult = CatalogArtist & InLibraryFlag

/** GET /api/catalog/search?q=&type= */
export interface CatalogSearchResponse {
  tracks: CatalogTrackResult[]
  albums: CatalogAlbumResult[]
  artists: CatalogArtistResult[]
}

/** GET /api/catalog/album/:id */
export interface CatalogAlbumResponse {
  album: CatalogAlbumResult & { durationSec: number | null; label: string | null }
  tracks: CatalogTrackResult[]
}

/** GET /api/catalog/artist/:id */
export interface CatalogArtistResponse {
  artist: CatalogArtistResult
  topTracks: CatalogTrackResult[]
  albums: CatalogAlbumResult[]
}

export type CatalogSearchType = 'all' | 'tracks' | 'albums' | 'artists'

/** `deezer:123` or `itunes:123` (digits only, so the id is safe in a URL path). */
export const CATALOG_ID_PATTERN = /^(deezer|itunes):\d{1,20}$/

export function isCatalogId(value: unknown): value is string {
  return typeof value === 'string' && CATALOG_ID_PATTERN.test(value)
}

/** Splits `deezer:123` into its provider and the provider's own id. */
export function splitCatalogId(id: string): { provider: CatalogProviderName; rawId: string } | null {
  const match = CATALOG_ID_PATTERN.exec(id)
  if (!match) return null
  return { provider: match[1] as CatalogProviderName, rawId: id.slice(match[1].length + 1) }
}
