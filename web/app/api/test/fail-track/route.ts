// Test-only (V2-PLAN T13 e2e): puts a song in the state the PC leaves it in
// after its third "Couldn't find a matching version" (status failed,
// attempts 3, the alternatives saved), so the import progress screen has a
// song that needs a look. The real path, three claims and three fails
// through /api/agent/*, would also claim the other waiting songs of the
// shared e2e library. Exists ONLY when TAPEDECK_TEST=1 (404 everywhere
// else) and sits behind the app password like every /api route.
//
// POST { trackId, error?, matchInfo? } -> 200 { ok: true }
import { isUuid, jsonError, readJsonObject } from '../../agent/requests'
import { sql } from '../../../../lib/db'

export async function POST(request: Request): Promise<Response> {
  if (process.env.TAPEDECK_TEST !== '1') return new Response('Not found', { status: 404 })
  const body = await readJsonObject(request)
  if (!body || !isUuid(body.trackId)) return jsonError(400, 'Expected { trackId }')
  const error = typeof body.error === 'string' ? body.error : "Couldn't find a matching version"
  const matchInfo = body.matchInfo && typeof body.matchInfo === 'object' ? JSON.stringify(body.matchInfo) : null
  const rows = await sql`
    update tracks set status = 'failed', attempts = 3, error = ${error},
                      match_info = coalesce(${matchInfo}::jsonb, match_info)
    where id = ${body.trackId}
    returning id`
  if (rows.length === 0) return jsonError(404, 'Track not found')
  return Response.json({ ok: true })
}
