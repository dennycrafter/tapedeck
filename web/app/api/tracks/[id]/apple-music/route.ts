// POST /api/tracks/[id]/apple-music (SPEC 8.11): the song menu's "Add to
// Apple Music". Sets apple_music = true; a ready song goes back to waiting so
// the downloader processes it again and copies it to Apple Music.
import { isUuid, jsonError } from '../../../agent/requests'
import { addTrackToAppleMusic } from '../../../../../lib/library'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Track id must be a UUID')
  try {
    const track = await addTrackToAppleMusic(id)
    if (!track) return jsonError(404, 'Track not found')
    return Response.json(track)
  } catch (error) {
    console.error('[tracks/apple-music] failed:', error)
    return jsonError(500, 'Could not update the song')
  }
}
