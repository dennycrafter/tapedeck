// POST /api/import/jobs/:id/list (V2-PLAN T13): list the playlists of a job
// in status `new`, which is where a job lands after the PC finished its part
// (lib/import-jobs.ts releasePcJob). Any other status answers the job as is.
import { jsonError } from '../../../../agent/requests'
import { jobView } from '../../../../../../lib/import-progress'
import { listInputFor, runListing } from '../../../../../../lib/import-run'
import { jobAndImporter, NO_STORE } from '../../../shared'

export const maxDuration = 60

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  try {
    const found = await jobAndImporter(id)
    if ('response' in found) return found.response
    const job = found.job.status === 'new' ? await runListing(found.job, found.importer, listInputFor(found.job)) : found.job
    return Response.json({ job: await jobView(job) }, { headers: NO_STORE })
  } catch (error) {
    console.error('[import/list] failed:', error)
    return jsonError(500, 'Could not list the playlists')
  }
}
