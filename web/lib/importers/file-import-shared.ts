/**
 * Shapes and small helpers shared by the file upload readers (V2-PLAN T13,
 * adapter 5): ./file-import-csv.ts (Exportify, TuneMyMusic and other song
 * lists) and ./file-import-plist.ts (Apple Music Library.xml). The importer
 * itself is ./file-import.ts.
 */

/** One song as read from a file. */
export interface FileSong {
  /** Stable per service: the source's own id when the file has one, else a hash of the song's facts. */
  ref: string
  title: string
  artist: string
  album: string | null
  durationSec: number | null
  isrc: string | null
  coverUrl: string | null
}

/** One playlist as read from a file. `ref` is made unique per upload by the importer. */
export interface FilePlaylist {
  ref: string
  name: string
  kind: 'playlist' | 'liked'
  songs: FileSong[]
}

const MAX_TEXT = 300

/** Trimmed, single spaced, at most 300 characters, or null when empty. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null
}

/** Seconds from a number of milliseconds, or null. */
export function secondsFromMs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return null
  const seconds = Math.round(n / 1000)
  return seconds > 0 && seconds <= 24 * 60 * 60 ? seconds : null
}

export function isrcCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return /^[A-Z0-9]{12}$/.test(code) ? code : null
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1_000) return null
  const trimmed = value.trim()
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null
}

/** FNV-1a over the string with the given seed, as an unsigned 32-bit number. */
function fnv(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * A short stable id for a song the file gives no id for, from its artist,
 * title, album and length. Two 32-bit hashes in base 36: short, and never a
 * long hex string.
 */
export function songHash(parts: readonly (string | number | null)[]): string {
  const text = parts.map((part) => (part === null ? '' : String(part).toLowerCase().trim())).join('\u0001')
  return `h${fnv(text, 0x811c9dc5).toString(36)}${fnv(text, 0x050c5d1f).toString(36)}`
}

/** "Liked", "Liked Songs", "Favorite Songs", "Favourites", ...: the source's liked list. */
export function looksLiked(name: string): boolean {
  return /^(liked|liked songs|loved|loved songs|favou?rites?|favou?rite songs|favou?rite tracks|my favou?rite songs)$/i.test(name.trim())
}
