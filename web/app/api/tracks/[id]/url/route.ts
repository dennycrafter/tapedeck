// GET /api/tracks/[id]/url (SPEC 8.8): the player's presigned playback URL
// for a ready track — the browser-side counterpart to the downloader's
// upload-url route. `{ url, expiresAt }` with a six-hour presign
// (storage.ts DOWNLOAD_URL_TTL_SECONDS, local stand-in and R2 alike).
// Session-gated like every /api/tracks route (the proxy's cookie check is
// the guard; this endpoint belongs to the owner's browser, not the
// downloader).
//
// Ownership note (T1d coordination): the playback-URL read side was on
// nobody's T1 brief — T1b shipped the downloader-side upload-url, T1c the
// add pipeline — so the UI tracer ships this thin route. Flagged to the
// coordinator in the task report.
import { isUuid, jsonError } from '../../../agent/requests'
import { trackKey } from '../../../../../lib/agent-queue'
import { sql } from '../../../../../lib/db'
import { DOWNLOAD_URL_TTL_SECONDS, getStorage } from '../../../../../lib/storage'

/** "<Artist> - <Title>.m4a"; just "<Title>.m4a" when the artist is blank. */
function songFileName(artist: string, title: string): string {
  const name = artist.trim() ? `${artist.trim()} - ${title.trim()}` : title.trim()
  return `${name}.m4a`
}

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) {
    return jsonError(400, 'Track id must be a UUID')
  }

  try {
    const rows = await sql`select status, title, artist from tracks where id = ${id}`
    if (rows.length === 0) {
      return jsonError(404, 'Track not found')
    }
    if (rows[0].status !== 'ready') {
      // The player only offers play on ready rows; a non-ready id (race with
      // a retry or delete) has no audio to sign yet.
      return jsonError(409, 'Track is not ready yet')
    }
    // ?download=1 is "Save to Files" on PC (SPEC 8.10): the same presigned
    // GET with an attachment disposition named "<Artist> - <Title>.m4a".
    const download = new URL(request.url).searchParams.get('download') === '1'
    const url = await getStorage().downloadUrl(
      trackKey(id),
      download ? { attachmentName: songFileName(String(rows[0].artist ?? ''), String(rows[0].title)) } : undefined,
    )
    const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString()
    // Presigned URLs expire; no layer may serve a stale one.
    return Response.json({ url, expiresAt }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[tracks/url] failed:', error)
    return jsonError(500, 'Could not create the playback URL')
  }
}
