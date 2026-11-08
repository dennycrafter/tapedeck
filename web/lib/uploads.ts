/**
 * Upload your own songs (T15), server side. Two steps, so the file itself
 * goes straight from the browser to storage (R2) and never through the app:
 *
 *   1. startUpload: check the file (kind, size, not already uploaded), pick
 *      the new song's id and hand back presigned PUT URLs for the audio and,
 *      when the file has cover art, for the cover.
 *   2. finishUpload: check the audio really arrived, then add the song
 *      ready to play (source 'upload'), with the title, artist and album
 *      read from its tags in the browser. No cover in the file: the same
 *      iTunes/Deezer lookup a pasted link gets (SPEC 8.5).
 *
 * From then on it is an ordinary library song: it plays, queues, goes into
 * playlists and downloads for offline like any other. The PC downloader
 * never downloads it (agent-queue.ts skips uploads); with the "Also add to
 * Apple Music" setting on, the PC copies it into Apple Music
 * (apple-music-uploads.ts), as it does for every new song.
 */
import { randomUUID } from 'node:crypto'
import { lookupCoverArt, type CoverArtMatch } from './cover-art'
import { sql, type Row } from './db'
import { getStorage } from './storage'
import {
  isFingerprint,
  MAX_COVER_BYTES,
  MAX_UPLOAD_BYTES,
  titleFromFileName,
  UPLOAD_FORMATS,
  UPLOAD_MESSAGES,
  uploadAudioKey,
  uploadCoverKey,
  uploadCoverPath,
  uploadExt,
  uploadProblem,
  type UploadExt,
} from './upload-rules'

/** Bounds every text field, like the Edit details route does. */
const MAX_TEXT = 500
/** A song can not be longer than a day (bounds bad input). */
const MAX_DURATION_SEC = 24 * 60 * 60

export type UploadError = { status: 'error'; httpStatus: number; message: string }

export type StartUploadResult =
  | { status: 'already'; trackId: string; message: string }
  | {
      status: 'ready'
      id: string
      contentType: string
      uploadUrl: string
      /** Null when the browser found no cover art in the file. */
      coverUploadUrl: string | null
    }
  | UploadError

export interface UploadedTrack {
  id: string
  source: 'upload'
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  coverUrl: string | null
  durationSec: number | null
  status: string
}

export type FinishUploadResult =
  | { status: 'added'; message: string; track: UploadedTrack }
  | { status: 'already'; trackId: string; message: string }
  | UploadError

function fail(httpStatus: number, message: string): UploadError {
  return { status: 'error', httpStatus, message }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

async function existingUpload(fingerprint: string): Promise<string | null> {
  const rows = await sql`select id from tracks where source = 'upload' and source_id = ${fingerprint}`
  return rows[0] ? String(rows[0].id) : null
}

/** Step 1. `body` is the request JSON: { fileName, bytes, fingerprint, coverBytes? }. */
export async function startUpload(body: Record<string, unknown>): Promise<StartUploadResult> {
  const fileName = text(body.fileName)
  const bytes = positiveInt(body.bytes)
  if (!fileName) return fail(400, 'fileName is required')
  if (bytes === null) return fail(400, 'bytes must be a positive whole number')
  const problem = uploadProblem({ name: fileName, size: bytes })
  if (problem) return fail(400, problem)
  if (!isFingerprint(body.fingerprint)) return fail(400, 'fingerprint must be a SHA-256 hex digest')
  const coverBytes = body.coverBytes == null ? null : positiveInt(body.coverBytes)
  if (body.coverBytes != null && (coverBytes === null || coverBytes > MAX_COVER_BYTES)) {
    return fail(400, 'coverBytes is out of range')
  }

  const already = await existingUpload(body.fingerprint)
  if (already) return { status: 'already', trackId: already, message: UPLOAD_MESSAGES.already }

  const ext = uploadExt(fileName) as UploadExt // uploadProblem checked it
  const id = randomUUID()
  const storage = getStorage()
  const contentType = UPLOAD_FORMATS[ext]
  const uploadUrl = await storage.uploadUrl(uploadAudioKey(id, ext), { contentType, bytes })
  const coverUploadUrl =
    coverBytes === null ? null : await storage.uploadUrl(uploadCoverKey(id), { contentType: 'image/jpeg', bytes: coverBytes })
  return { status: 'ready', id, contentType, uploadUrl, coverUploadUrl }
}

/** Remove what a failed or duplicate upload left in storage. Never throws. */
async function removeObjects(keys: string[]): Promise<void> {
  const storage = getStorage()
  for (const key of keys) {
    try {
      await storage.delete(key)
    } catch (error) {
      console.error('[uploads] could not remove', key, error)
    }
  }
}

/** Dependencies finishUpload reaches outside the database for (tests swap them). */
export interface FinishDeps {
  lookupCover(title: string, artist: string): Promise<CoverArtMatch | null>
}

const DEFAULT_DEPS: FinishDeps = { lookupCover: lookupCoverArt }

/**
 * Step 2. `body`: { fileName, fingerprint, title?, artist?, album?,
 * albumArtist?, durationSec?, cover? }. Tags are optional: a file without
 * a title tag is named after the file.
 */
export async function finishUpload(
  id: string,
  body: Record<string, unknown>,
  deps: FinishDeps = DEFAULT_DEPS,
): Promise<FinishUploadResult> {
  const fileName = text(body.fileName)
  const ext = fileName ? uploadExt(fileName) : null
  if (!fileName || !ext) return fail(400, UPLOAD_MESSAGES.notAudio)
  if (!isFingerprint(body.fingerprint)) return fail(400, 'fingerprint must be a SHA-256 hex digest')
  const fingerprint = body.fingerprint

  const audioKey = uploadAudioKey(id, ext)
  const coverKey = uploadCoverKey(id)
  const storage = getStorage()
  const audio = await storage.head(audioKey)
  if (!audio.exists) return fail(409, 'The file did not finish uploading. Try again.')
  if (audio.bytes > MAX_UPLOAD_BYTES) {
    await removeObjects([audioKey, coverKey])
    return fail(400, UPLOAD_MESSAGES.tooBig)
  }

  const already = await existingUpload(fingerprint)
  if (already) {
    // Uploaded twice at once (two tabs): keep the first, drop this copy.
    await removeObjects([audioKey, coverKey])
    return { status: 'already', trackId: already, message: UPLOAD_MESSAGES.already }
  }

  const title = text(body.title) ?? titleFromFileName(fileName)
  const artist = text(body.artist) ?? ''
  let album = text(body.album)
  let albumArtist = album ? (text(body.albumArtist) ?? (artist || null)) : null
  const duration = typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) ? body.durationSec : null
  const durationSec = duration !== null && duration > 0 ? Math.min(MAX_DURATION_SEC, Math.round(duration)) : null

  // The file's own cover art when it had one; otherwise the lookup a pasted
  // link gets (8.5), which may also fill in a missing album.
  let coverUrl: string | null = null
  let embeddedCover: string | null = null
  if (body.cover === true && (await storage.head(coverKey)).exists) {
    embeddedCover = uploadCoverPath(id)
    coverUrl = embeddedCover
  } else if (artist) {
    const match = await deps.lookupCover(title, artist)
    if (match) {
      coverUrl = match.coverUrl
      if (!album) {
        album = match.album
        albumArtist = match.albumArtist
      }
    }
  }

  const rows = (await sql`
    insert into tracks (id, source, source_id, source_url, raw_title, raw_artist, raw_thumbnail_url,
                        title, artist, album, album_artist, cover_url, duration_sec,
                        status, storage_key, bytes, ready_at, apple_music)
    values (${id}, 'upload', ${fingerprint}, '', ${title}, ${artist}, ${embeddedCover},
            ${title}, ${artist}, ${album}, ${albumArtist}, ${coverUrl}, ${durationSec},
            'ready', ${audioKey}, ${audio.bytes}, now(),
            coalesce((select apple_music_export from settings where id = 1), false))
    on conflict do nothing
    returning id, title, artist, album, album_artist, cover_url, duration_sec, status
  `) as Row[]
  const row = rows[0]
  if (!row) {
    await removeObjects([audioKey, coverKey])
    const winner = await existingUpload(fingerprint)
    if (winner) return { status: 'already', trackId: winner, message: UPLOAD_MESSAGES.already }
    return fail(409, 'Could not add this song. Try again.')
  }
  return {
    status: 'added',
    message: UPLOAD_MESSAGES.added,
    track: {
      id: String(row.id),
      source: 'upload',
      title: String(row.title),
      artist: String(row.artist ?? ''),
      album: row.album == null ? null : String(row.album),
      albumArtist: row.album_artist == null ? null : String(row.album_artist),
      coverUrl: row.cover_url == null ? null : String(row.cover_url),
      durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
      status: String(row.status),
    },
  }
}

// ---------------------------------------------------------------------------
// R2 CORS for browser uploads
// ---------------------------------------------------------------------------

const corsApplied = new Map<string, Promise<void>>()

/**
 * Browser PUTs to R2 need the bucket's CORS rules to allow PUT from the
 * app's address (storage.ts r2CorsRules). "Finish setup" applies them, but
 * apps set up before uploads existed only allow GET, so the first upload on
 * each server instance re-applies them, including the address this request
 * came from. Failure is logged, not fatal: the rules may already be there.
 */
export async function ensureUploadCors(requestOrigin: string | null): Promise<void> {
  const storage = getStorage()
  if (storage.driverName !== 'r2') return
  const key = requestOrigin ?? ''
  let pending = corsApplied.get(key)
  if (!pending) {
    pending = storage.setCors(requestOrigin ? [requestOrigin] : []).catch((error: unknown) => {
      corsApplied.delete(key)
      console.error('[uploads] could not apply the R2 CORS rules:', error)
    })
    corsApplied.set(key, pending)
  }
  await pending
}
