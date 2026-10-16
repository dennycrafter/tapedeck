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
  /** The track id; only needed for findTrackId (T13 import). */
  id?: string
  source: string
  source_id: string
  isrc: string | null
  title: string
  artist: string
  album: string | null
  album_artist: string | null
}

type TrackKey = Pick<CatalogTrack, 'id' | 'isrc' | 'title' | 'artist'>

export interface LibraryIndex {
  hasTrack(track: TrackKey): boolean
  hasAlbum(album: Pick<CatalogAlbum, 'title' | 'artist'>): boolean
  hasArtist(artist: Pick<CatalogArtist, 'name'>): boolean
  /**
   * T13 import: the id of the library song that hasTrack would match, or
   * null. Same rules, in the same order (catalog id, ISRC, title and artist).
   */
  findTrackId(track: TrackKey): string | null
  /** T13 import: the id of the song with this exact source and source id (a pasted link), or null. */
  findBySource(source: string, sourceId: string): string | null
  /** T13 import: count a song added after the index was built. */
  addRow(row: LibraryTrackRow): void
}

/** Both non-empty and one contains the other (the 8.5 artist rule on normalised names). */
function artistsMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}

function addTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  if (!key) return
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** A track id, or '' for rows read without one (they still answer hasTrack). */
const NO_ID = ''

/** Pure: builds the lookup from library rows (exported for the unit tests). */
export function buildLibraryIndex(rows: readonly LibraryTrackRow[]): LibraryIndex {
  const sources = new Map<string, string>()
  const isrcs = new Map<string, string>()
  const titles = new Map<string, { artist: string; id: string }[]>()
  const albums = new Map<string, string[]>()
  const artists = new Set<string>()

  function addRow(row: LibraryTrackRow): void {
    const id = row.id ?? NO_ID
    const sourceKey = `${row.source}:${row.source_id}`
    if (!sources.has(sourceKey)) sources.set(sourceKey, id)
    const isrc = row.isrc?.toUpperCase()
    if (isrc && !isrcs.has(isrc)) isrcs.set(isrc, id)
    const artist = normalizeForMatch(row.artist ?? '')
    addTo(titles, normalizeForMatch(row.title ?? ''), { artist, id })
    if (artist) artists.add(artist)
    if (row.album) {
      const albumArtist = normalizeForMatch(row.album_artist ?? row.artist ?? '')
      addTo(albums, normalizeForMatch(row.album), albumArtist)
      if (albumArtist) artists.add(albumArtist)
    }
  }

  /** The matching row's id ('' when read without ids), or undefined for no match. */
  function find(track: TrackKey): string | undefined {
    const byId = sources.get(`catalog:${track.id}`)
    if (byId !== undefined) return byId
    if (track.isrc) {
      const byIsrc = isrcs.get(track.isrc.toUpperCase())
      if (byIsrc !== undefined) return byIsrc
    }
    const candidates = titles.get(normalizeForMatch(track.title))
    if (!candidates) return undefined
    const artist = normalizeForMatch(track.artist)
    return candidates.find((owned) => artistsMatch(owned.artist, artist))?.id
  }

  for (const row of rows) addRow(row)

  return {
    hasTrack(track) {
      return find(track) !== undefined
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
    findTrackId(track) {
      return find(track) || null
    },
    findBySource(source, sourceId) {
      return sources.get(`${source}:${sourceId}`) || null
    },
    addRow,
  }
}

/** Reads the library once and builds the index. */
export async function loadLibraryIndex(): Promise<LibraryIndex> {
  const rows = (await sql`
    select id, source, source_id, isrc, title, artist, album, album_artist from tracks
  `) as (Row & LibraryTrackRow)[]
  return buildLibraryIndex(rows.map((row) => ({ ...row, id: String(row.id) })))
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
