// POST /api/playlists { name, description? } (SPEC 8.6): create a playlist.
import { jsonError, readJsonObject } from '../agent/requests'
import { cleanName, createPlaylist } from '../../../lib/library'

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const name = cleanName(body?.name)
  if (!name) return jsonError(400, 'Give the playlist a name')
  const description = typeof body?.description === 'string' ? body.description.trim() : ''
  try {
    return Response.json(await createPlaylist(name, description), { status: 201 })
  } catch (error) {
    console.error('[playlists/create] failed:', error)
    return jsonError(500, 'Could not create the playlist')
  }
}
