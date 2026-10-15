// POST /api/tracks/[id]/pick (V2-PLAN T12, item 5): the song menu's "Pick
// another version" for catalog songs.
//   { url: string }       download that copy: one of the saved candidates
//                         (kept as is) or a YouTube or SoundCloud song link
//                         (stored in its canonical form)
//   { searchAgain: true } clear the pick so the PC searches again
// Both send the song back to waiting. Session-gated like every other
// /api/tracks route (the proxy's cookie check is the guard).
import { isUuid, jsonError, readJsonObject } from '../../../agent/requests'
import { resolvePickUrl } from '../../../../../lib/pick-version'
import { pickTarget, pickVersion } from '../../../../../lib/pick-version-db'

type RouteContext = { params: Promise<{ id: string }> }

const NOT_CATALOG = 'Only songs added from the catalog can pick another version'
const BUSY = 'Your PC is downloading this song right now. Try again in a minute.'

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Track id must be a UUID')

  const body = await readJsonObject(request)
  const wantsUrl = typeof body?.url === 'string'
  if (!body || (!wantsUrl && body.searchAgain !== true)) {
    return jsonError(400, 'Send { url } or { searchAgain: true }')
  }

  try {
    const target = await pickTarget(id)
    if (!target) return jsonError(404, 'Track not found')
    if (target.source !== 'catalog') return jsonError(409, NOT_CATALOG)

    let url: string | null = null
    if (wantsUrl) {
      const resolved = resolvePickUrl(body.url as string, target.matchInfo)
      if (resolved.error !== undefined) return jsonError(400, resolved.error)
      url = resolved.url
    }

    const result = await pickVersion(id, url)
    if (result === 'not-found') return jsonError(404, 'Track not found')
    if (result === 'not-catalog') return jsonError(409, NOT_CATALOG)
    if (result === 'busy') return jsonError(409, BUSY)
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[tracks/pick] failed:', error)
    return jsonError(500, 'Could not update the song')
  }
}
