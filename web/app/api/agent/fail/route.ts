// POST /api/agent/fail (SPEC 8.3): the downloader could not finish a track.
// Body `{ trackId, error }`. While attempts allow another try the track goes
// back to `waiting` so the next poll picks it up again; once attempts reach
// 3 (MAX_ATTEMPTS — the claim increments attempts, so the third failure is
// final) it becomes `failed` and only the UI "Retry" can requeue it. The
// error is stored truncated to its first 500 characters. Returns the new
// status so the downloader can log the outcome.
// Auth: bearer AGENT_TOKEN only (the proxy exempts /api/agent/, SPEC 2).

import { agentAuthorized } from '../auth'
import { isUuid, jsonError, readJsonObject } from '../requests'
import { failTrack } from '../../../../lib/agent-queue'

export async function POST(request: Request): Promise<Response> {
  if (!agentAuthorized(request)) {
    return jsonError(401, 'Unauthorized')
  }

  const body = await readJsonObject(request)
  if (!body) {
    return jsonError(400, 'Invalid request body')
  }

  const trackId = body.trackId
  if (!isUuid(trackId)) {
    return jsonError(400, 'trackId must be a track UUID')
  }
  const error = body.error
  if (typeof error !== 'string') {
    return jsonError(400, 'error must be a string')
  }

  try {
    const status = await failTrack(trackId, error)
    if (!status) {
      return jsonError(404, 'Track not found')
    }
    return Response.json({ status })
  } catch (err) {
    console.error('[agent/fail] failed:', err)
    return jsonError(500, 'Could not record the failure')
  }
}
