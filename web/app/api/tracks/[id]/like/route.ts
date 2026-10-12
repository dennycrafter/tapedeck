// PUT /api/tracks/[id]/like { liked } (SPEC 8.6): the heart on any song.
// Liking sets liked_at (Liked songs are newest first); unliking clears it.
import { isUuid, jsonError, readJsonObject } from '../../../agent/requests'
import { setLiked } from '../../../../../lib/library'

type RouteContext = { params: Promise<{ id: string }> }

export async function PUT(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Track id must be a UUID')
  const body = await readJsonObject(request)
  if (!body || typeof body.liked !== 'boolean') return jsonError(400, 'Expected { liked: boolean }')
  try {
    const track = await setLiked(id, body.liked)
    if (!track) return jsonError(404, 'Track not found')
    return Response.json(track)
  } catch (error) {
    console.error('[tracks/like] failed:', error)
    return jsonError(500, 'Could not update the song')
  }
}
