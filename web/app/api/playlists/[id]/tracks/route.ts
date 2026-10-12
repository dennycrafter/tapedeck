// POST /api/playlists/[id]/tracks { trackIds }: add songs to the end.
// PUT  /api/playlists/[id]/tracks { trackIds }: the new full order after a
// drag (SPEC 8.6). The order must name exactly the playlist's songs.
import { isUuid, jsonError, readJsonObject } from '../../../agent/requests'
import { addToPlaylist, reorderPlaylist } from '../../../../../lib/library'

type RouteContext = { params: Promise<{ id: string }> }

const MAX_IDS = 1000

async function readTrackIds(request: Request): Promise<string[] | null> {
  const body = await readJsonObject(request)
  const ids = body?.trackIds
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every(isUuid)) return null
  return ids as string[]
}

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Playlist id must be a UUID')
  const trackIds = await readTrackIds(request)
  if (!trackIds || trackIds.length === 0) return jsonError(400, 'Expected { trackIds: uuid[] }')
  try {
    const result = await addToPlaylist(id, trackIds)
    if (!result.found) return jsonError(404, 'Playlist not found')
    return Response.json({ added: result.added })
  } catch (error) {
    console.error('[playlists/add] failed:', error)
    return jsonError(500, 'Could not add to the playlist')
  }
}

export async function PUT(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Playlist id must be a UUID')
  const trackIds = await readTrackIds(request)
  if (!trackIds) return jsonError(400, 'Expected { trackIds: uuid[] }')
  try {
    const result = await reorderPlaylist(id, trackIds)
    if (result === 'not_found') return jsonError(404, 'Playlist not found')
    if (result === 'mismatch') return jsonError(409, 'The playlist changed. Reload and try again.')
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[playlists/reorder] failed:', error)
    return jsonError(500, 'Could not save the new order')
  }
}
