// POST /api/tracks/[id]/restore: the song menu's "Restore original". Puts
// the track back on its stored raw metadata: title = raw_title, artist =
// raw_artist with " - Topic"/"VEVO" stripped, album and cover cleared, AI
// flags reset. The raw columns are never edited afterwards, so restore is
// repeatable. The strip rule runs in TypeScript (lib/clean-title owns it):
// read the raw row first, then update. Session-gated like every /api/tracks
// route (the proxy's cookie check is the guard; no bearer here, as this
// endpoint belongs to the owner's browser, not the downloader).

import { isUuid, jsonError } from '../../../agent/requests'
import { restoreOriginalArtist } from '../../../../../lib/clean-title'
import { sql, type Row } from '../../../../../lib/db'

type RouteContext = { params: Promise<{ id: string }> }

interface TrackRow extends Row {
  id: string
  source: string
  source_id: string
  source_url: string
  title: string
  artist: string
  album: string | null
  album_artist: string | null
  cover_url: string | null
  duration_sec: number | null
  status: string
}

export async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) {
    return jsonError(400, 'Track id must be a UUID')
  }

  try {
    const raw = (await sql`select raw_title, raw_artist from tracks where id = ${id}`) as {
      raw_title: string
      raw_artist: string
    }[]
    if (!raw[0]) {
      return jsonError(404, 'Track not found')
    }
    const updated = (await sql`
      update tracks set
        title = ${raw[0].raw_title},
        artist = ${restoreOriginalArtist(raw[0].raw_artist)},
        album = null,
        album_artist = null,
        cover_url = null,
        ai_cleaned = false,
        ai_confidence = null
      where id = ${id}
      returning id, source, source_id, source_url, title, artist, album, album_artist, cover_url, duration_sec, status
    `) as TrackRow[]
    const row = updated[0]
    return Response.json({
      id: row.id,
      source: row.source,
      sourceId: row.source_id,
      sourceUrl: row.source_url,
      title: row.title,
      artist: row.artist,
      album: row.album,
      albumArtist: row.album_artist,
      coverUrl: row.cover_url,
      durationSec: row.duration_sec,
      status: row.status,
    })
  } catch (error) {
    console.error('[tracks/restore] failed:', error)
    return jsonError(500, 'Could not restore the track')
  }
}
