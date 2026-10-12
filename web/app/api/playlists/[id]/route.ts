// PATCH /api/playlists/[id] { name?, description? }: rename.
// DELETE /api/playlists/[id]: delete (the UI confirms first, SPEC 8.6).
// The songs themselves stay in the library; only the list goes.
import { isUuid, jsonError, readJsonObject } from '../../agent/requests'
import { cleanName, deletePlaylist, updatePlaylist } from '../../../../lib/library'

type RouteContext = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Playlist id must be a UUID')
  const body = await readJsonObject(request)
  if (!body) return jsonError(400, 'Expected a JSON object')
  const name = body.name === undefined ? undefined : cleanName(body.name)
  if (name === null) return jsonError(400, 'Give the playlist a name')
  const description = typeof body.description === 'string' ? body.description.trim() : undefined
  if (name === undefined && description === undefined) return jsonError(400, 'Nothing to update')
  try {
    const found = await updatePlaylist(id, { name, description })
    return found ? Response.json({ ok: true }) : jsonError(404, 'Playlist not found')
  } catch (error) {
    console.error('[playlists/update] failed:', error)
    return jsonError(500, 'Could not update the playlist')
  }
}

export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Playlist id must be a UUID')
  try {
    const found = await deletePlaylist(id)
    return found ? Response.json({ ok: true }) : jsonError(404, 'Playlist not found')
  } catch (error) {
    console.error('[playlists/delete] failed:', error)
    return jsonError(500, 'Could not delete the playlist')
  }
}
