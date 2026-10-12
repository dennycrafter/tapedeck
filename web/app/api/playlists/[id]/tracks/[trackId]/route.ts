// DELETE /api/playlists/[id]/tracks/[trackId]: remove one song from a
// playlist (the song stays in the library).
import { isUuid, jsonError } from '../../../../agent/requests'
import { removeFromPlaylist } from '../../../../../../lib/library'

type RouteContext = { params: Promise<{ id: string; trackId: string }> }

export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id, trackId } = await ctx.params
  if (!isUuid(id) || !isUuid(trackId)) return jsonError(400, 'Ids must be UUIDs')
  try {
    const removed = await removeFromPlaylist(id, trackId)
    return removed ? Response.json({ ok: true }) : jsonError(404, 'Song not in this playlist')
  } catch (error) {
    console.error('[playlists/remove] failed:', error)
    return jsonError(500, 'Could not remove the song')
  }
}
