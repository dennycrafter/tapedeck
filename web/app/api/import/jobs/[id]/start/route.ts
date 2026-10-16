// POST /api/import/jobs/:id/start { refs: string[] } (V2-PLAN T13): the
// ticked playlists become Tapedeck playlists with the same names (a playlist
// imported before is reused) and the job starts importing. The browser then
// drives /chunk until it answers done.
import { isUuid, jsonError, readJsonObject } from '../../../../agent/requests'
import { jobView } from '../../../../../../lib/import-progress'
import { startImport } from '../../../../../../lib/import-run'
import { NO_STORE } from '../../../shared'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Import id must be a UUID')
  const body = await readJsonObject(request)
  try {
    const result = await startImport(id, body?.refs)
    if ('error' in result) return jsonError(result.status, result.error)
    return Response.json({ job: await jobView(result.job) }, { headers: NO_STORE })
  } catch (error) {
    console.error('[import/start] failed:', error)
    return jsonError(500, 'Could not start the import')
  }
}
