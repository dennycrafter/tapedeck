// GET /api/import/callback/:importer (V2-PLAN T13): where a log-in page
// sends the browser back. The importer's `login.finish` reads the query
// (code, state, ...) and names the job; its payload (the provider's user
// id, per job only) is stored, the playlists are listed, and the browser
// lands on the import screen. Session-gated like every /api route: the
// owner's cookie comes back with the top-level navigation.
import { getJob, updateJob } from '../../../../../lib/import-jobs'
import { runListing } from '../../../../../lib/import-run'
import { findImporter } from '../../../../../lib/importers'
import { ImportUserError } from '../../../../../lib/importers/types'
import { isUuid } from '../../../agent/requests'

type RouteContext = { params: Promise<{ importer: string }> }

function back(request: Request, query: Record<string, string>): Response {
  const url = new URL('/import', request.url)
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  return Response.redirect(url, 303)
}

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const { importer: importerId } = await ctx.params
  const importer = findImporter(importerId)
  if (!importer?.login) return back(request, { error: 'That log in is not available any more.' })
  const callbackUrl = new URL(`/api/import/callback/${importer.id}`, request.url).toString()
  try {
    const { jobId, payload } = await importer.login.finish(new URL(request.url).searchParams, { callbackUrl })
    const job = isUuid(jobId) ? await getJob(jobId) : null
    if (!job || job.importer !== importer.id) return back(request, { error: 'That log in has expired. Start again.' })
    if (job.status === 'login') {
      const ready = await updateJob(job.id, { status: 'new', payload }, ['login'])
      if (ready) await runListing(ready, importer, { method: 'login' })
    }
    return back(request, { job: job.id })
  } catch (cause) {
    const message = cause instanceof ImportUserError ? cause.message : 'The log in did not work. Try again.'
    if (!(cause instanceof ImportUserError)) console.error('[import/callback] failed:', cause)
    return back(request, { error: message })
  }
}
