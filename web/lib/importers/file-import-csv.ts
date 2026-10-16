/**
 * CSV song lists for the file upload importer (V2-PLAN T13, adapter 5).
 *
 * Exportify (exportify.net): one CSV per playlist, named after the playlist
 * (lower case, spaces as "_"; "liked.csv" is Liked songs). Its current
 * header starts "Track URI", "Track Name", "Artist URI(s)", "Artist
 * Name(s)", "Album URI", "Album Name", ..., "Album Image URL" (10th),
 * "Track Duration (ms)" (13th), ..., "ISRC" (17th), then "Added By" and
 * "Added At". The header is translated in other languages, but those first
 * 17 columns keep their place (older exports too), so a file whose first
 * column holds `spotify:track:` ids is read by position when the names are
 * not English. Several artists are joined with ", " and a comma inside a
 * name is written "\,".
 *
 * TuneMyMusic ("Export to file"): one CSV for everything, "Track name",
 * "Artist name", "Album", "Playlist name", "Type" (Playlist, Favorite,
 * Album, Track, Artist), "ISRC", then one "<Service> - id" column per
 * service it knows. Favorite rows are the liked list; Artist rows are not
 * songs.
 *
 * Any other CSV with a title and an artist column (and maybe album, length,
 * ISRC, playlist) is read the same way.
 */

import type { ServiceId } from './types'
import {
  cleanText,
  httpsUrl,
  isrcCode,
  looksLiked,
  secondsFromMs,
  songHash,
  type FilePlaylist,
  type FileSong,
} from './file-import-shared'

// ---------------------------------------------------------------------------
// Parsing (RFC 4180, with the separator guessed from the header line)
// ---------------------------------------------------------------------------

function guessSeparator(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (let i = 0; i < text.length && i < 10_000; i++) {
    const char = text[i]
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === '\n' || char === '\r')) break
    else if (!quoted && char in counts) counts[char]++
  }
  let best = ','
  for (const separator of [';', '\t']) if (counts[separator] > counts[best]) best = separator
  return best
}

/** The rows of a CSV text. Quoted fields may hold separators, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const separator = guessSeparator(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else {
        field += char
      }
      i++
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
    } else if (char === separator) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (char === '\r' && text[i + 1] === '\n') i++
    } else {
      field += char
    }
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type Column = 'title' | 'artist' | 'album' | 'durationMs' | 'duration' | 'isrc' | 'spotify' | 'cover' | 'playlist' | 'type'

/** Header names with everything but letters and digits dropped, lower case. */
const ALIASES: Record<Column, readonly string[]> = {
  title: ['trackname', 'title', 'songname', 'song', 'name', 'track', 'tracktitle', 'songtitle'],
  artist: ['artistnames', 'artistname', 'artist', 'artists', 'artistsnames'],
  album: ['albumname', 'album', 'albumtitle'],
  durationMs: ['trackdurationms', 'durationms', 'lengthms'],
  duration: ['duration', 'length', 'time', 'durationseconds'],
  isrc: ['isrc'],
  // Exportify "Track URI" (spotify:track:<id>), older Exportify "Spotify ID", TuneMyMusic "Spotify - id".
  spotify: ['trackuri', 'spotifyuri', 'spotifyid', 'spotifytrackid', 'uri'],
  cover: ['albumimageurl', 'coverurl', 'artworkurl', 'imageurl'],
  playlist: ['playlistname', 'playlist'],
  type: ['type'],
}

/** The id column of the other services TuneMyMusic writes, as normalised header names. */
const SERVICE_ID_COLUMNS: Partial<Record<ServiceId, readonly string[]>> = {
  apple: ['applemusicid', 'appleid', 'itunesid'],
}

function normalise(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

type Columns = Partial<Record<Column, number>>

function namedColumns(header: readonly string[]): Columns {
  const names = header.map(normalise)
  const columns: Columns = {}
  for (const column of Object.keys(ALIASES) as Column[]) {
    for (const alias of ALIASES[column]) {
      const index = names.indexOf(alias)
      if (index >= 0) {
        columns[column] = index
        break
      }
    }
  }
  return columns
}

const SPOTIFY_URI = /^spotify:(track|local|episode):/

/** Exportify's fixed places, for a header in another language. */
const EXPORTIFY_PLACES: Columns = { spotify: 0, title: 1, artist: 3, album: 5, cover: 9, durationMs: 12, isrc: 16 }

function columnsFor(header: readonly string[], firstRow: readonly string[] | undefined): Columns | null {
  const named = namedColumns(header)
  if (named.title !== undefined && named.artist !== undefined) return named
  if (header.length >= 17 && firstRow && SPOTIFY_URI.test(firstRow[0]?.trim() ?? '')) return EXPORTIFY_PLACES
  return null
}

// ---------------------------------------------------------------------------
// Rows to songs
// ---------------------------------------------------------------------------

/** A Spotify track id from "spotify:track:<id>", an open.spotify.com link or a bare id. */
function spotifyId(value: string): string | null {
  const trimmed = value.trim()
  const match =
    /^spotify:track:([A-Za-z0-9]{22})$/.exec(trimmed) ??
    /open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/.exec(trimmed) ??
    /^([A-Za-z0-9]{22})$/.exec(trimmed)
  return match ? match[1] : null
}

/** "3:45", "225" (seconds) or "225000" (milliseconds). */
function looseSeconds(value: string): number | null {
  const trimmed = value.trim()
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (clock) {
    const total = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
    return total > 0 ? total : null
  }
  const n = Number(trimmed)
  if (!trimmed || !Number.isFinite(n) || n <= 0) return null
  return n > 10_000 ? secondsFromMs(n) : Math.round(n)
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? '' : (row[index] ?? '')
}

function songFromRow(row: readonly string[], columns: Columns, ownIdColumn: number | undefined): FileSong | null {
  const spotifyCell = cell(row, columns.spotify).trim()
  if (spotifyCell.startsWith('spotify:episode:')) return null // a podcast episode, not a song
  const title = cleanText(cell(row, columns.title))
  if (!title) return null
  const artist = cleanText(cell(row, columns.artist).replace(/\\,/g, ',')) ?? ''
  const album = cleanText(cell(row, columns.album))
  const durationSec =
    columns.durationMs !== undefined ? secondsFromMs(cell(row, columns.durationMs)) : looseSeconds(cell(row, columns.duration))
  const isrc = isrcCode(cell(row, columns.isrc))
  const ownId = cleanText(cell(row, ownIdColumn))
  const ref = ownId ?? spotifyId(spotifyCell) ?? songHash([artist, title, album, durationSec])
  return { ref, title, artist, album, durationSec, isrc, coverUrl: httpsUrl(cell(row, columns.cover)) }
}

/** "road_trip (1).csv" becomes "Road trip (1)". */
export function nameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '')
  const spaced = stem.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!spaced) return 'Imported playlist'
  return spaced === spaced.toLowerCase() ? spaced[0].toUpperCase() + spaced.slice(1) : spaced
}

function slug(name: string): string {
  const text = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return text || 'playlist'
}

function playlistRef(name: string, kind: FilePlaylist['kind']): string {
  return kind === 'liked' ? 'liked' : `file:${slug(name)}`
}

function rowKind(type: string, name: string): FilePlaylist['kind'] {
  return /^(favou?rites?|liked?|loved)$/i.test(type.trim()) || looksLiked(name) ? 'liked' : 'playlist'
}

const DEFAULT_NAMES: Record<string, string> = { album: 'Saved albums', track: 'Saved songs' }

/**
 * The playlists in one CSV file, or null when it is not a song list this
 * reader knows (no title and artist columns).
 */
export function readCsvPlaylists(text: string, fileName: string, service: ServiceId): FilePlaylist[] | null {
  const rows = parseCsv(text)
  if (rows.length === 0) return null
  const [header, ...body] = rows
  const columns = columnsFor(header, body[0])
  if (!columns) return null
  const names = header.map(normalise)
  const ownIdColumn = (SERVICE_ID_COLUMNS[service] ?? []).map((alias) => names.indexOf(alias)).find((index) => index >= 0)
  const fallbackName = nameFromFile(fileName)

  const playlists = new Map<string, FilePlaylist>()
  for (const row of body) {
    const type = cell(row, columns.type).trim()
    if (/^artists?$/i.test(type)) continue // a followed artist, not a song
    const song = songFromRow(row, columns, ownIdColumn)
    if (!song) continue
    const listed = cleanText(cell(row, columns.playlist))
    const name = listed ?? (columns.playlist !== undefined ? DEFAULT_NAMES[type.toLowerCase()] : undefined) ?? fallbackName
    const kind = rowKind(type, name)
    const ref = playlistRef(name, kind)
    let playlist = playlists.get(ref)
    if (!playlist) {
      // Exportify's liked list is "liked.csv".
      playlist = { ref, name: kind === 'liked' && /^liked$/i.test(name) ? 'Liked songs' : name, kind, songs: [] }
      playlists.set(ref, playlist)
    }
    playlist.songs.push(song)
  }
  return [...playlists.values()]
}
