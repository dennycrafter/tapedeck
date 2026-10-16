/**
 * File upload importer (V2-PLAN T13, Adapters item 5): the owner uploads an
 * export file and picks playlists from it.
 *
 * Accepted, recognised by their content (not the file name):
 *   - Exportify CSV (one playlist per file) or Exportify's zip of several
 *     (./file-import-csv.ts).
 *   - TuneMyMusic CSV, one file with a "Playlist name" column, and any other
 *     CSV with title and artist columns (./file-import-csv.ts).
 *   - Apple Music or iTunes `Library.xml` (Export Library or Export
 *     Playlist), user-made playlists only (./file-import-plist.ts).
 *   - A zip of any of these: Exportify's "Export All", or a big Library.xml
 *     zipped to fit the 4 MB upload limit (XML shrinks about tenfold).
 *
 * The upload exists only during `listPlaylists`, so the parsed songs go into
 * the job payload under `fileUpload` in a compact form (each song once, as
 * an array, playlists as lists of song numbers), and `getTracks` pages
 * through that copy.
 */

import { unzipSync } from 'fflate'
import { ImportUserError, type ImportPlaylist, type ImportTrack, type Importer, type ServiceId } from './types'
import { readCsvPlaylists } from './file-import-csv'
import { looksLikePlist, readAppleLibrary } from './file-import-plist'
import type { FilePlaylist, FileSong } from './file-import-shared'

/** Songs per getTracks page. */
export const FILE_PAGE_SIZE = 500
/** Different songs one upload may hold, so the job payload stays a few MB at most. */
export const MAX_FILE_SONGS = 20_000
const MAX_PLAYLISTS = 500
const MAX_SONGS_PER_PLAYLIST = 10_000
const MAX_ZIP_FILES = 500
const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024

export const ACCEPTED_FILES = 'an Exportify CSV or zip, a TuneMyMusic CSV, or a Library.xml from the Music app'
export const UNKNOWN_FILE = `Tapedeck can't read that file. Upload ${ACCEPTED_FILES}.`

// ---------------------------------------------------------------------------
// Reading the upload
// ---------------------------------------------------------------------------

/** UTF-8, or UTF-16 with its byte order mark, or Windows Latin (old Excel files). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6)
}

/** One file's playlists, or null when it is not a format this importer knows. */
function readText(name: string, text: string, service: ServiceId): FilePlaylist[] | null {
  if (looksLikePlist(text)) return readAppleLibrary(text)
  if (text.trimStart().startsWith('<')) return null // some other XML or an HTML page
  return readCsvPlaylists(text, name, service)
}

function readZip(bytes: Uint8Array, service: ServiceId): FilePlaylist[] {
  let files = 0
  let total = 0
  let tooBig = false
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        const base = file.name.split('/').pop() ?? ''
        if (!base || base.startsWith('.') || file.name.startsWith('__MACOSX/')) return false
        if (!/\.(csv|tsv|txt|xml)$/i.test(base)) return false
        files++
        total += file.originalSize
        // Sizes come from the zip's own directory; fflate never writes past them.
        if (files > MAX_ZIP_FILES || total > MAX_UNZIPPED_BYTES) tooBig = true
        return !tooBig
      },
    })
  } catch {
    throw new ImportUserError('That zip file looks damaged. Download it again and upload the new one.')
  }
  if (tooBig) throw new ImportUserError('That zip holds too much to read at once. Upload fewer playlists at a time.')

  const playlists: FilePlaylist[] = []
  let firstError: ImportUserError | null = null
  for (const [name, data] of Object.entries(entries)) {
    try {
      playlists.push(...(readText(name, decodeText(data), service) ?? []))
    } catch (cause) {
      if (!(cause instanceof ImportUserError)) throw cause
      firstError ??= cause
    }
  }
  if (playlists.length === 0) throw firstError ?? new ImportUserError(`That zip has no files Tapedeck can read. Upload ${ACCEPTED_FILES}.`)
  return playlists
}

/** The playlists in an uploaded file. Throws ImportUserError with a plain message. */
export function readUpload(name: string, bytes: Uint8Array, service: ServiceId): FilePlaylist[] {
  if (isZip(bytes)) return readZip(bytes, service)
  const playlists = readText(name, decodeText(bytes), service)
  if (!playlists) throw new ImportUserError(UNKNOWN_FILE)
  return playlists
}

// ---------------------------------------------------------------------------
// The compact copy kept in the job payload
// ---------------------------------------------------------------------------

/** [ref, title, artist, album, seconds, isrc, cover], empty as "" or 0, trailing empties dropped. */
type StoredSong = (string | number)[]

interface StoredPlaylist {
  ref: string
  name: string
  kind: 'playlist' | 'liked'
  /** Places in `songs`, in playlist order. */
  songs: number[]
}

export interface StoredUpload {
  v: 1
  songs: StoredSong[]
  playlists: StoredPlaylist[]
}

function packSong(song: FileSong): StoredSong {
  const packed: StoredSong = [
    song.ref,
    song.title,
    song.artist,
    song.album ?? '',
    song.durationSec ?? 0,
    song.isrc ?? '',
    song.coverUrl ?? '',
  ]
  while (packed.length > 3 && (packed[packed.length - 1] === '' || packed[packed.length - 1] === 0)) packed.pop()
  return packed
}

function unpackSong(packed: StoredSong | undefined): ImportTrack | null {
  if (!Array.isArray(packed)) return null
  const [ref, title, artist, album, seconds, isrc, cover] = packed
  if (typeof ref !== 'string' || typeof title !== 'string') return null
  const textOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)
  return {
    ref,
    title,
    artist: typeof artist === 'string' ? artist : '',
    album: textOrNull(album),
    durationSec: typeof seconds === 'number' && seconds > 0 ? seconds : null,
    isrc: textOrNull(isrc),
    coverUrl: textOrNull(cover),
  }
}

/** Each song once, playlist refs unique, empty playlists dropped. Throws when the file holds too many songs. */
export function packUpload(playlists: readonly FilePlaylist[]): StoredUpload {
  const songs: StoredSong[] = []
  const songIndex = new Map<string, number>()
  const refs = new Set<string>()
  const stored: StoredPlaylist[] = []
  for (const playlist of playlists) {
    if (playlist.songs.length === 0) continue
    if (stored.length >= MAX_PLAYLISTS) break
    let ref = playlist.ref
    let kind = playlist.kind
    for (let n = 2; refs.has(ref); n++) {
      ref = `${playlist.ref === 'liked' ? 'file:liked' : playlist.ref}-${n}`
      kind = 'playlist' // one Liked songs per upload
    }
    refs.add(ref)
    const places: number[] = []
    for (const song of playlist.songs.slice(0, MAX_SONGS_PER_PLAYLIST)) {
      let place = songIndex.get(song.ref)
      if (place === undefined) {
        place = songs.length
        songIndex.set(song.ref, place)
        songs.push(packSong(song))
        if (songs.length > MAX_FILE_SONGS) {
          throw new ImportUserError(
            `That file has more than ${MAX_FILE_SONGS.toLocaleString('en-US')} songs. Export fewer playlists at a time.`,
          )
        }
      }
      places.push(place)
    }
    stored.push({ ref, name: playlist.name, kind, songs: places })
  }
  if (stored.length === 0) throw new ImportUserError('No songs found in that file.')
  return { v: 1, songs, playlists: stored }
}

function storedUpload(payload: Record<string, unknown>): StoredUpload | null {
  const value = payload.fileUpload as StoredUpload | undefined
  if (!value || value.v !== 1 || !Array.isArray(value.songs) || !Array.isArray(value.playlists)) return null
  return value
}

function listing(stored: StoredUpload): ImportPlaylist[] {
  return stored.playlists.map((playlist) => {
    const cover = playlist.songs.map((place) => unpackSong(stored.songs[place])?.coverUrl).find((url) => url)
    return { ref: playlist.ref, name: playlist.name, kind: playlist.kind, trackCount: playlist.songs.length, coverUrl: cover ?? null }
  })
}

const UPLOAD_AGAIN = 'This upload has expired. Upload the file again.'

export const fileImporter: Importer = {
  id: 'file-import',
  label: 'File upload',
  services: ['spotify', 'apple'],
  methods: ['file'],
  isAvailable: () => true,
  hints: {
    file: 'An Exportify CSV or zip, a TuneMyMusic CSV, or Library.xml from the Music app on a computer. A big Library.xml? Zip it first.',
  },
  fileAccept: '.csv,.zip,.xml,text/csv,application/zip,text/xml,application/xml',

  async listPlaylists(input, ctx) {
    if (input.method !== 'file') throw new ImportUserError('Upload a file to import.')
    if (input.file) {
      const stored = packUpload(readUpload(input.file.name, await input.file.bytes(), ctx.job.service))
      return { playlists: listing(stored), payload: { fileUpload: stored } }
    }
    const stored = storedUpload(ctx.job.payload)
    if (!stored) throw new ImportUserError(UPLOAD_AGAIN)
    return { playlists: listing(stored) }
  },

  async getTracks(playlist, ctx) {
    const stored = storedUpload(ctx.job.payload)
    if (!stored) throw new ImportUserError(UPLOAD_AGAIN)
    const found = stored.playlists.find((candidate) => candidate.ref === playlist.ref)
    if (!found) throw new ImportUserError(`The playlist "${playlist.name}" is not in that file.`)
    const start = ctx.cursor && /^\d+$/.test(ctx.cursor) ? Number(ctx.cursor) : 0
    const end = start + FILE_PAGE_SIZE
    const tracks = found.songs
      .slice(start, end)
      .map((place) => unpackSong(stored.songs[place]))
      .filter((track): track is ImportTrack => track !== null)
    return { tracks, next: end < found.songs.length ? String(end) : null }
  },
}
