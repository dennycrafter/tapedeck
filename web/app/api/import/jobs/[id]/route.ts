// GET /api/import/jobs/:id (V2-PLAN T13): the job with its checklist
// (already imported playlists marked) and, once started, the live progress.
// The import screen polls this while waiting for the PC and while the PC
// downloads the songs.
import { isUuid, jsonError } from '../../../agent/requests'
import { getJob } from '../../../../../lib/import-jobs'
import { jobView } from '../../../../../lib/import-progress'
import { NO_STORE } from '../../shared'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  new URL(request.url) // per request, never frozen at build time (Cache Components)
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Import id must be a UUID')
  try {
    const job = await getJob(id)
    if (!job) return jsonError(404, 'Import not found')
    return Response.json({ job: await jobView(job) }, { headers: NO_STORE })
  } catch (error) {
    console.error('[import/job] failed:', error)
    return jsonError(500, 'Could not load the import')
  }
}
