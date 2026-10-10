// POST /api/agent/complete (SPEC 8.3): the downloader finished a track.
// Body `{ trackId, key, bytes, durationSec }` → the track becomes `ready`
// with storage_key, bytes and duration_sec set, ready_at=now(), error
// cleared. The key is echoed from upload-url's response; durationSec is the
// real duration from ffprobe (rounded to the int column; omitted or null
// leaves the stored value — completing must not erase known metadata).
// Auth: bearer AGENT_TOKEN only (the proxy exempts /api/agent/, SPEC 2).

import { agentAuthorized } from '../auth'
import { isUuid, jsonError, readJsonObject } from '../requests'
import { completeTrack } from '../../../../lib/agent-queue'

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
  const key = body.key
  if (typeof key !== 'string' || key.length === 0) {
    return jsonError(400, 'key must be a non-empty string')
  }
  const bytes = body.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    return jsonError(400, 'bytes must be a non-negative integer')
  }
  let durationSec: number | null = null
  if (body.durationSec != null) {
    const duration = body.durationSec
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
      return jsonError(400, 'durationSec must be a positive number of seconds')
    }
    durationSec = duration
  }

  try {
    const completed = await completeTrack({ trackId, key, bytes, durationSec })
    if (!completed) {
      return jsonError(404, 'Track not found')
    }
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[agent/complete] failed:', error)
    return jsonError(500, 'Could not mark the track ready')
  }
}
