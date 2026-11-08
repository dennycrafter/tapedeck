/**
 * Upload your own songs (T15): the rules both sides share. The browser
 * checks a file before it sends anything, and the server checks again,
 * so the messages here are the ones the owner sees. No Node imports: the
 * Add window imports this file too.
 *
 * Storage layout: the song goes to `tracks/<id>.<ext>` (next to the
 * downloader's `tracks/<id>.m4a`), its cover art to `covers/<id>.jpg`.
 */

/** The four formats the iPhone and Chrome both play, and their content types. */
export const UPLOAD_FORMATS = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
} as const

export type UploadExt = keyof typeof UPLOAD_FORMATS

/**
 * 200 MB per file: room for a long WAV or FLAC (a 4 minute song is about
 * 40 MB as WAV, 25 MB as FLAC, 8 MB as MP3), while one file can never eat a
 * big share of the free 10 GB.
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
export const MAX_UPLOAD_MB = 200

/** Cover art is shrunk to a JPEG in the browser first; this only bounds it. */
export const MAX_COVER_BYTES = 2 * 1024 * 1024
/** Longest side of the stored cover, in pixels (covers show at most ~300px). */
export const COVER_SIZE_PX = 600

/** What the file picker offers: the extensions plus the audio types. */
export const UPLOAD_ACCEPT = '.mp3,.m4a,.wav,.flac,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/flac,audio/x-flac'

export const UPLOAD_MESSAGES = {
  notAudio: 'Not a song file. Upload MP3, M4A, WAV or FLAC.',
  tooBig: `Too big. Songs can be up to ${MAX_UPLOAD_MB} MB.`,
  empty: 'This file is empty.',
  unreadable: "This file doesn't look like a song. Upload MP3, M4A, WAV or FLAC.",
  already: 'Already in your library',
  added: 'Added',
} as const

/** "song.Final.MP3" → "mp3"; null when there is no extension. */
export function fileExtension(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())
  return match ? match[1]!.toLowerCase() : null
}

export function uploadExt(fileName: string): UploadExt | null {
  const ext = fileExtension(fileName)
  return ext && Object.hasOwn(UPLOAD_FORMATS, ext) ? (ext as UploadExt) : null
}

/**
 * The first check, before any bytes move: the right kind of file and a
 * sensible size. Returns the message to show, or null when it may go up.
 */
export function uploadProblem(file: { name: string; size: number }): string | null {
  if (!uploadExt(file.name)) return UPLOAD_MESSAGES.notAudio
  if (file.size <= 0) return UPLOAD_MESSAGES.empty
  if (file.size > MAX_UPLOAD_BYTES) return UPLOAD_MESSAGES.tooBig
  return null
}

/** "03 My Song.mp3" → "03 My Song": the title when the file has no tags. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.trim().replace(/\.[A-Za-z0-9]+$/, '').trim()
  return base || 'Untitled'
}

/** The audio key for an uploaded song. */
export function uploadAudioKey(trackId: string, ext: UploadExt): string {
  return `tracks/${trackId}.${ext}`
}

/** The cover key for an uploaded song's embedded cover art. */
export function uploadCoverKey(trackId: string): string {
  return `covers/${trackId}.jpg`
}

/** Where the app serves an uploaded cover (same origin, so it works offline too). */
export function uploadCoverPath(trackId: string): string {
  return `/covers/${trackId}`
}

/** A file fingerprint: lowercase SHA-256 hex (see app/lib/upload.ts). */
export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
