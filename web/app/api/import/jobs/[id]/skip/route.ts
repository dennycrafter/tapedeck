// POST /api/import/jobs/:id/skip { itemId } (V2-PLAN T13): "Skip" on a song
// that needs a look. The song leaves this import and its playlists; when
// this import added it and it never became ready, the library row goes too
// (lib/import-run.ts skipItem).
import { isUuid, jsonError, readJsonObject } from '../../../../agent/requests'
import { getJob } from '../../../../../../lib/import-jobs'
import { jobView } from '../../../../../../lib/import-progress'
import { skipItem } from '../../../../../../lib/import-run'
import { NO_STORE } from '../../../shared'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) return jsonError(400, 'Import id must be a UUID')
  const body = await readJsonObject(request)
  if (!isUuid(body?.itemId)) return jsonError(400, 'Expected { itemId }')
  try {
    if ((await skipItem(id, body.itemId)) === 'not-found') return jsonError(404, 'That song is not in this import')
    const job = await getJob(id)
    if (!job) return jsonError(404, 'Import not found')
    return Response.json({ job: await jobView(job) }, { headers: NO_STORE })
  } catch (error) {
    console.error('[import/skip] failed:', error)
    return jsonError(500, 'Could not skip that song')
  }
}
