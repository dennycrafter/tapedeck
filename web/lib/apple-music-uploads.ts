/**
 * "Add to Apple Music" for uploaded songs (T15 follow-up).
 *
 * A downloaded song goes back to the PC's queue and comes through the
 * downloader again, which copies it into Apple Music (SPEC 8.11). An
 * uploaded song has no link to download again, so the PC fetches the stored
 * file instead: it claims "copies" here (POST /api/agent/apple-music-copies),
 * gets short-lived links to the audio and the cover, makes a file Apple Music
 * takes (agent/apple_music_uploads.py) and reports
 * /api/agent/apple-music-done like any other song.
 *
 * A copy is wanted while the song has apple_music = true and no
 * apple_music_done_at. claimed_at and attempts (unused by ready uploads
 * otherwise) pace the retries: a claim waits COPY_RETRY_SECONDS before it can
 * be claimed again, at most COPY_MAX_ATTEMPTS times. Pressing "Add to Apple
 * Music" again starts over.
 */
import { sql, type Row } from './db'
import { getStorage } from './storage'
import { uploadCoverKey, uploadCoverPath, uploadExt, type UploadExt } from './upload-rules'

export const COPY_CLAIM_LIMIT = 3
/** Longer than a 200 MB download plus a FLAC conversion on a slow line. */
export const COPY_RETRY_SECONDS = 15 * 60
export const COPY_MAX_ATTEMPTS = 3

export interface AppleMusicCopy {
  id: string
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  /** The stored file's format; the PC turns WAV and FLAC into Apple Lossless. */
  format: UploadExt
  /** Short-lived link to the stored file (app-relative with local storage). */
  audioUrl: string
  /** The file's own cover (short-lived link), a looked-up cover, or null. */
  coverUrl: string | null
}

async function coverLink(id: string, coverUrl: unknown): Promise<string | null> {
  if (typeof coverUrl !== 'string' || !coverUrl) return null
  if (coverUrl === uploadCoverPath(id)) return getStorage().downloadUrl(uploadCoverKey(id))
  return /^https?:\/\//.test(coverUrl) ? coverUrl : null
}

/** Claim up to `limit` wanted copies, oldest first, with their links. */
export async function claimAppleMusicCopies(limit: number = COPY_CLAIM_LIMIT): Promise<AppleMusicCopy[]> {
  const rows = (await sql`
    with picked as (
      select id from tracks
      where source = 'upload'
        and status = 'ready'
        and apple_music
        and apple_music_done_at is null
        and storage_key is not null
        and attempts < ${COPY_MAX_ATTEMPTS}
        and (claimed_at is null or claimed_at < now() - make_interval(secs => ${COPY_RETRY_SECONDS}))
      order by created_at
      limit ${limit}
      for update skip locked
    )
    update tracks t
    set claimed_at = now(), attempts = t.attempts + 1
    from picked p
    where t.id = p.id
    returning t.id, t.title, t.artist, t.album, t.album_artist, t.cover_url, t.storage_key, t.created_at
  `) as Row[]
  rows.sort((a, b) => new Date(String(a.created_at)).getTime() - new Date(String(b.created_at)).getTime())

  const storage = getStorage()
  const copies: AppleMusicCopy[] = []
  for (const row of rows) {
    const id = String(row.id)
    const key = String(row.storage_key)
    const format = uploadExt(key)
    if (!format) continue
    copies.push({
      id,
      title: String(row.title),
      artist: String(row.artist ?? ''),
      album: row.album == null ? null : String(row.album),
      albumArtist: row.album_artist == null ? null : String(row.album_artist),
      format,
      audioUrl: await storage.downloadUrl(key),
      coverUrl: await coverLink(id, row.cover_url),
    })
  }
  return copies
}
