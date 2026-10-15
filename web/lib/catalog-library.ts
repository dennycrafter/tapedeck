/**
 * "In library" flags for catalog results (V2-PLAN T11 item 2). A catalog
 * song is in the library when a track has the same catalog id, the same
 * ISRC, or the same normalised title with a matching artist (the SPEC 8.5
 * rules: normalizeForMatch on both sides, one artist contains the other).
 * An album is in the library when an album with the same normalised name
 * by a matching artist is; an artist when a song or album by exactly that
 * normalised name is.
 *
 * The flags are computed per request from one small query over `tracks`
 * (a personal library), never cached with the catalog answers.
 */

import { normalizeForMatch } from './cover-art'
import { sql, type Row } from './db'
import type { CatalogAlbum, CatalogArtist, CatalogTrack, InLibraryFlag } from './catalog-types'

export interface LibraryTrackRow {
  source: string
  source_id: string
  isrc: string | null
  title: string
  artist: string
  album: string | null
  album_artist: string | null
}

export interface LibraryIndex {
  hasTrack(track: Pick<CatalogTrack, 'id' | 'isrc' | 'title' | 'artist'>): boolean
  hasAlbum(album: Pick<CatalogAlbum, 'title' | 'artist'>): boolean
  hasArtist(artist: Pick<CatalogArtist, 'name'>): boolean
}

/** Both non-empty and one contains the other (the 8.5 artist rule on normalised names). */
function artistsMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

function addTo(map: Map<string, string[]>, key: string, value: string): void {
  if (!key) return
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Pure: builds the lookup from library rows (exported for the unit tests). */
export function buildLibraryIndex(rows: readonly LibraryTrackRow[]): LibraryIndex {
  const catalogIds = new Set<string>()
  const isrcs = new Set<string>()
  const titles = new Map<string, string[]>()
  const albums = new Map<string, string[]>()
  const artists = new Set<string>()

  for (const row of rows) {
    if (row.source === 'catalog') catalogIds.add(row.source_id)
    if (row.isrc) isrcs.add(row.isrc.toUpperCase())
    const artist = normalizeForMatch(row.artist ?? '')
    addTo(titles, normalizeForMatch(row.title ?? ''), artist)
    if (artist) artists.add(artist)
    if (row.album) {
      const albumArtist = normalizeForMatch(row.album_artist ?? row.artist ?? '')
      addTo(albums, normalizeForMatch(row.album), albumArtist)
      if (albumArtist) artists.add(albumArtist)
    }
  }

  return {
    hasTrack(track) {
      if (catalogIds.has(track.id)) return true
      if (track.isrc && isrcs.has(track.isrc.toUpperCase())) return true
      const candidates = titles.get(normalizeForMatch(track.title))
      if (!candidates) return false
      const artist = normalizeForMatch(track.artist)
      return candidates.some((owned) => artistsMatch(owned, artist))
    },
    hasAlbum(album) {
      const candidates = albums.get(normalizeForMatch(album.title))
      if (!candidates) return false
      const artist = normalizeForMatch(album.artist)
      return candidates.some((owned) => artistsMatch(owned, artist))
    },
    hasArtist(artist) {
      const name = normalizeForMatch(artist.name)
      return name !== '' && artists.has(name)
    },
  }
}

/** Reads the library once and builds the index. */
export async function loadLibraryIndex(): Promise<LibraryIndex> {
  const rows = (await sql`
    select source, source_id, isrc, title, artist, album, album_artist from tracks
  `) as (Row & LibraryTrackRow)[]
  return buildLibraryIndex(rows)
}

export function markTracks<T extends CatalogTrack>(tracks: readonly T[], index: LibraryIndex): (T & InLibraryFlag)[] {
  return tracks.map((track) => ({ ...track, inLibrary: index.hasTrack(track) }))
}

export function markAlbums<T extends CatalogAlbum>(albums: readonly T[], index: LibraryIndex): (T & InLibraryFlag)[] {
  return albums.map((album) => ({ ...album, inLibrary: index.hasAlbum(album) }))
}

export function markArtists<T extends CatalogArtist>(artists: readonly T[], index: LibraryIndex): (T & InLibraryFlag)[] {
  return artists.map((artist) => ({ ...artist, inLibrary: index.hasArtist(artist) }))
}
