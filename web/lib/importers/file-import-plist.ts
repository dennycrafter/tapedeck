/**
 * Apple Music `Library.xml` for the file upload importer (V2-PLAN T13,
 * adapter 5). The Music app (and iTunes before it) writes it with File >
 * Library > Export Library; File > Library > Export Playlist writes the same
 * format with one playlist. It is an XML property list: a dict with
 * "Tracks" (a dict of track id to song facts: Name, Artist, Album, Total
 * Time in milliseconds, Persistent ID, Loved or Favorited, ...) and
 * "Playlists" (an array of dicts: Name, Playlist Persistent ID, Playlist
 * Items with one Track ID each).
 *
 * The built-in lists are left out: the whole library (Master), the ones the
 * app keeps itself (Distinguished Kind: Music, Downloaded, Purchased,
 * Podcasts, ...), hidden ones, folders, and iTunes's old ready-made smart
 * playlists. The user's own playlists and smart playlists are offered.
 * Apple's "Favourite Songs" list, or else every song marked Loved or
 * Favourite, becomes the Liked songs entry. Podcasts, films, TV shows and
 * audiobooks are not songs and are skipped.
 */

import { ImportUserError } from './types'
import { cleanText, looksLiked, secondsFromMs, type FilePlaylist, type FileSong } from './file-import-shared'

// ---------------------------------------------------------------------------
// A small XML property list reader (dict, array, key, string, integer, real,
// true, false, date, data). No DTD, no attributes that matter.
// ---------------------------------------------------------------------------

export type PlistValue = string | number | boolean | null | PlistValue[] | PlistDict
export interface PlistDict {
  [key: string]: PlistValue
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[name] ?? whole
  })
}

type Frame = { kind: 'dict'; value: PlistDict; key: string | null } | { kind: 'array'; value: PlistValue[] }

const TAG = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g

/** The value of an XML property list. Throws on a file that is not one. */
export function parsePlist(xml: string): PlistValue {
  const stack: Frame[] = []
  let root: PlistValue | undefined
  let leaf: { tag: string; start: number } | null = null

  const add = (value: PlistValue) => {
    const top = stack[stack.length - 1]
    if (!top) {
      if (root === undefined) root = value
      return
    }
    if (top.kind === 'array') {
      top.value.push(value)
    } else if (top.key !== null) {
      top.value[top.key] = value
      top.key = null
    }
  }
  const setKey = (key: string) => {
    const top = stack[stack.length - 1]
    if (top?.kind === 'dict') top.key = key
  }
  const leafValue = (tag: string, raw: string): PlistValue => {
    const text = decodeEntities(raw)
    if (tag === 'integer') return Number.parseInt(text.trim(), 10)
    if (tag === 'real') return Number.parseFloat(text.trim())
    if (tag === 'string' || tag === 'date' || tag === 'data') return text
    return null
  }

  TAG.lastIndex = 0
  for (let match = TAG.exec(xml); match; match = TAG.exec(xml)) {
    const [whole, close, rawTag, selfClose] = match
    if (rawTag === undefined) continue // <?xml ?>, comments, <!DOCTYPE>
    const tag = rawTag.toLowerCase()
    if (leaf) {
      if (close && tag === leaf.tag) {
        const raw = xml.slice(leaf.start, match.index)
        if (tag === 'key') setKey(decodeEntities(raw))
        else add(leafValue(tag, raw))
        leaf = null
      }
      continue
    }
    if (tag === 'plist') continue
    if (close) {
      if (tag === 'dict' || tag === 'array') {
        const frame = stack.pop()
        if (!frame) throw new Error('plist: unbalanced close tag')
        add(frame.value)
      }
      continue
    }
    if (selfClose) {
      if (tag === 'dict') add(Object.create(null) as PlistDict)
      else if (tag === 'array') add([])
      else if (tag === 'true') add(true)
      else if (tag === 'false') add(false)
      else if (tag === 'key') setKey('')
      else if (tag === 'string') add('')
      else add(null)
      continue
    }
    if (tag === 'dict') stack.push({ kind: 'dict', value: Object.create(null) as PlistDict, key: null })
    else if (tag === 'array') stack.push({ kind: 'array', value: [] })
    else leaf = { tag, start: match.index + whole.length }
  }
  if (root === undefined || stack.length > 0) throw new Error('plist: incomplete')
  return root
}

// ---------------------------------------------------------------------------
// Library.xml to playlists
// ---------------------------------------------------------------------------

/** An XML property list by its first lines: worth handing to readAppleLibrary. */
export function looksLikePlist(text: string): boolean {
  const head = text.slice(0, 2_000)
  return /<!DOCTYPE\s+plist/i.test(head) || /<plist[\s>]/i.test(head)
}

function isDict(value: PlistValue | undefined): value is PlistDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Built in to the Music app and iTunes, never the owner's own. */
const SYSTEM_NAMES = new Set([
  'library',
  'music',
  'downloaded',
  'downloaded music',
  'purchased',
  'purchased music',
  'movies',
  'tv shows',
  'podcasts',
  'audiobooks',
  'books',
  'music videos',
  'home videos',
  'itunes u',
  'tones',
  'voice memos',
  'genius',
])

/** iTunes's ready-made smart playlists, left out only while they are smart playlists. */
const DEFAULT_SMART_NAMES = new Set([
  "90's music",
  '90’s music',
  'classical music',
  'my top rated',
  'recently added',
  'recently played',
  'top 25 most played',
])

function isBuiltIn(playlist: PlistDict, name: string): boolean {
  const lower = name.toLowerCase()
  if (playlist['Master'] === true || playlist['Visible'] === false || playlist['Folder'] === true) return true
  if (SYSTEM_NAMES.has(lower)) return true
  if (playlist['Smart Info'] !== undefined && DEFAULT_SMART_NAMES.has(lower)) return true
  return playlist['Distinguished Kind'] !== undefined && !looksLiked(name)
}

function isSong(track: PlistDict): boolean {
  if (track['Podcast'] === true || track['Movie'] === true || track['TV Show'] === true) return false
  if (track['Has Video'] === true && track['Music Video'] !== true) return false
  const kind = typeof track['Kind'] === 'string' ? track['Kind'] : ''
  return !/book/i.test(kind)
}

function songFromTrack(track: PlistDict): FileSong | null {
  if (!isSong(track)) return null
  const title = cleanText(track['Name'])
  if (!title) return null
  const persistent = cleanText(track['Persistent ID'])
  const trackId = track['Track ID']
  const ref = persistent ?? (typeof trackId === 'number' ? `track-${trackId}` : null)
  if (!ref) return null
  return {
    ref,
    title,
    artist: cleanText(track['Artist']) ?? cleanText(track['Album Artist']) ?? '',
    album: cleanText(track['Album']),
    durationSec: secondsFromMs(track['Total Time']),
    isrc: null,
    coverUrl: null,
  }
}

const NOT_A_LIBRARY = "That XML file isn't a Music app library. In the Music app on a computer, use File, Library, Export Library."

/**
 * The owner's playlists in an Apple Music or iTunes library export, plus
 * Liked songs. Throws ImportUserError for a plist that is not a library.
 */
export function readAppleLibrary(text: string): FilePlaylist[] {
  let root: PlistValue
  try {
    root = parsePlist(text)
  } catch {
    throw new ImportUserError(NOT_A_LIBRARY)
  }
  if (!isDict(root) || !isDict(root['Tracks'])) throw new ImportUserError(NOT_A_LIBRARY)
  const tracks = root['Tracks']
  const lists = Array.isArray(root['Playlists']) ? root['Playlists'] : []

  const songs = new Map<string, FileSong | null>()
  const songFor = (id: PlistValue | undefined): FileSong | null => {
    if (typeof id !== 'number' && typeof id !== 'string') return null
    const key = String(id)
    if (!songs.has(key)) {
      const track = tracks[key]
      songs.set(key, isDict(track) ? songFromTrack(track) : null)
    }
    return songs.get(key) ?? null
  }

  const playlists: FilePlaylist[] = []
  let hasLiked = false
  for (const playlist of lists) {
    if (!isDict(playlist)) continue
    const name = cleanText(playlist['Name']) ?? 'Untitled playlist'
    if (isBuiltIn(playlist, name)) continue
    const items = Array.isArray(playlist['Playlist Items']) ? playlist['Playlist Items'] : []
    const listSongs = items.map((item) => (isDict(item) ? songFor(item['Track ID']) : null)).filter((song): song is FileSong => song !== null)
    const liked: boolean = !hasLiked && looksLiked(name)
    hasLiked ||= liked
    const id = cleanText(playlist['Playlist Persistent ID']) ?? `id-${String(playlist['Playlist ID'] ?? playlists.length)}`
    playlists.push({ ref: liked ? 'liked' : `apple:${id}`, name, kind: liked ? 'liked' : 'playlist', songs: listSongs })
  }

  if (!hasLiked) {
    // No "Favourite Songs" list: the songs marked Loved (iTunes) or Favourite (Music app), in library order.
    const loved: FileSong[] = []
    for (const key of Object.keys(tracks)) {
      const track = tracks[key]
      if (!isDict(track) || (track['Loved'] !== true && track['Favorited'] !== true)) continue
      const song = songFor(key)
      if (song) loved.push(song)
    }
    if (loved.length > 0) playlists.unshift({ ref: 'liked', name: 'Loved songs', kind: 'liked', songs: loved })
  }

  if (playlists.every((playlist) => playlist.songs.length === 0)) {
    throw new ImportUserError('That library has no playlists of your own yet. Make one in the Music app, then export again.')
  }
  return playlists
}
