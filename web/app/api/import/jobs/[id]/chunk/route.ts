// POST /api/import/jobs/:id/chunk (V2-PLAN T13): one step of an import,
// driven by the browser: read the next pages of songs, else match and add
// the next 50. Each request starts no new work after 8 seconds, well inside
// Vercel's function time limit. `busy` means another request is working on
// this job (a second tab): wait a moment and call again.
import { jsonError } from '../../../../agent/requests'
import { jobView } from '../../../../../../lib/import-progress'
import { runChunk } from '../../../../../../lib/import-run'
import type { ChunkResponse } from '../../../../../../lib/import-types'
import { jobAndImporter, NO_STORE } from '../../../shared'

export const maxDuration = 60

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  try {
    const found = await jobAndImporter(id)
    if ('response' in found) return found.response
    const outcome = await runChunk(found.job.id, found.importer)
    if (!outcome) return jsonError(404, 'Import not found')
    const body: ChunkResponse = { job: await jobView(outcome.job), done: outcome.done }
    if (outcome.busy) body.busy = true
    return Response.json(body, { headers: NO_STORE })
  } catch (error) {
    console.error('[import/chunk] failed:', error)
    return jsonError(500, 'The import stopped. Try again.')
  }
}
