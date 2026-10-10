// POST /api/tracks/[id]/retry (SPEC 8.3): the library's "Retry" action on a
// failed track. Requeues it: status='waiting', attempts=0, error cleared —
// the next downloader poll claims it fresh. Session-gated like every other
// /api/tracks route (the proxy's cookie check is the guard; no bearer here —
// this endpoint belongs to the owner's browser, not the downloader).
// The first argument is part of the Next handler signature; the proxy's
// session gate has already run by the time the route executes.

import { isUuid, jsonError } from '../../../agent/requests'
import { retryTrack } from '../../../../../lib/agent-queue'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params
  if (!isUuid(id)) {
    return jsonError(400, 'Track id must be a UUID')
  }

  try {
    const retried = await retryTrack(id)
    if (!retried) {
      return jsonError(404, 'Track not found')
    }
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[tracks/retry] failed:', error)
    return jsonError(500, 'Could not requeue the track')
  }
}
