// POST /api/agent/upload-url (SPEC 8.3): the downloader asks where to PUT the
// finished .m4a. Body `{ trackId }` → `{ url, key }`, a presigned PUT valid
// for 15 minutes (storage.ts UPLOAD_URL_TTL_SECONDS) with the object key from
// SPEC 4: `tracks/<track_id>.m4a`. The track must exist: a stale id (the
// song was deleted while queued) is a 404 the downloader logs and moves past.
// Auth: bearer AGENT_TOKEN only (the proxy exempts /api/agent/, SPEC 2).

import { agentAuthorized } from '../auth'
import { isUuid, jsonError, readJsonObject } from '../requests'
import { getStorage } from '../../../../lib/storage'
import { trackKey } from '../../../../lib/agent-queue'
import { sql } from '../../../../lib/db'

export async function POST(request: Request): Promise<Response> {
  if (!agentAuthorized(request)) {
    return jsonError(401, 'Unauthorized')
  }

  const body = await readJsonObject(request)
  const trackId = body?.trackId
  if (!isUuid(trackId)) {
    return jsonError(400, 'trackId must be a track UUID')
  }

  try {
    const rows = await sql`select id from tracks where id = ${trackId}`
    if (rows.length === 0) {
      return jsonError(404, 'Track not found')
    }
    const key = trackKey(trackId)
    const url = await getStorage().uploadUrl(key)
    return Response.json({ url, key })
  } catch (error) {
    console.error('[agent/upload-url] failed:', error)
    return jsonError(500, 'Could not create the upload URL')
  }
}
