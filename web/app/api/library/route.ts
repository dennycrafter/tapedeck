// GET /api/library (SPEC 8.8 basics, 8.3 header): the library page's read
// side — every track newest first, plus the downloader snapshot the header
// needs ("Downloader online/offline" and the waiting count).
//
// Ownership note (T1d coordination): no T1 brief covered the library
// listing — T1c shipped POST /api/tracks, T1b the agent routes — so the UI
// tracer ships this thin read route. Session-gated by the proxy like every
// non-agent /api route.
import { sql, type Row } from '../../../lib/db'
import { jsonError } from '../agent/requests'

type TrackRow = Row & {
  id: string
  source: string
  source_url: string
  title: string
  artist: string
  album: string | null
  cover_url: string | null
  duration_sec: number | null
  status: string
  error: string
  created_at: Row['created_at']
}

function toIso(value: Row['created_at'] | Row['agent_last_seen']): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

export async function GET(request: Request): Promise<Response> {
  // Per-request like every stateful GET in this app (see /api/health):
  // reading the request keeps Cache Components from freezing this handler at
  // build time — the snapshot (last seen, waiting count) is only valid right
  // now. Unknown query params (the page's poll cache-buster) are ignored.
  new URL(request.url)
  try {
    const trackRows = (await sql`
      select id, source, source_url, title, artist, album, cover_url,
             duration_sec, status, error, created_at
      from tracks
      order by created_at desc, id desc
    `) as TrackRow[]
    const settingsRows = (await sql`
      select agent_last_seen from settings where id = 1
    `) as { agent_last_seen: Row['agent_last_seen'] }[]
    const waitingRows = (await sql`
      select count(*) as count from tracks where status = 'waiting'
    `) as { count: string | number }[]
    return Response.json(
      {
        tracks: trackRows.map((row) => ({
          id: row.id,
          source: row.source === 'soundcloud' ? 'soundcloud' : 'youtube',
          sourceUrl: row.source_url,
          title: row.title,
          artist: row.artist,
          album: row.album,
          coverUrl: row.cover_url,
          durationSec: row.duration_sec,
          status: row.status,
          error: row.error,
          createdAt: toIso(row.created_at),
        })),
        downloader: {
          lastSeenAt: toIso(settingsRows[0]?.agent_last_seen),
          waitingCount: Number(waitingRows[0]?.count ?? 0),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    console.error('[library] failed:', error)
    return jsonError(500, 'Library unavailable')
  }
}
