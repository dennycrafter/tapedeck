// GET /api/tracks/[id]/lyrics (T16): the song's lyrics for Now Playing,
// looked up on LRCLIB by its title, artist and length and cached
// (lib/lyrics.ts). Always 200 with a LyricsResult for a known song; the
// screen shows "unavailable" as "try again later". Behind the app password
// like every /api route (proxy.ts).
import { isUuid, jsonError } from '../../../agent/requests'
import { sql } from '../../../../../lib/db'
import { getLyrics } from '../../../../../lib/lyrics'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Track id must be a UUID')
  try {
    const rows = await sql`select title, artist, duration_sec from tracks where id = ${id}`
    const row = rows[0]
    if (!row) return jsonError(404, 'Track not found')
    const result = await getLyrics({
      title: String(row.title),
      artist: String(row.artist ?? ''),
      durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
    })
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('[tracks/lyrics] failed:', error)
    return jsonError(500, 'Could not load the lyrics')
  }
}
