// POST /api/agent/apple-music-done (SPEC 8.3): the downloader reports it
// copied a finished song into the Apple Music auto-add folder (8.11). Sets
// apple_music_done_at=now() so the UI can show the export happened. The
// endpoint ships with T1 so the downloader's pipeline is complete from day
// one; only the folder-copy step stays T6.
// Auth: bearer AGENT_TOKEN only (the proxy exempts /api/agent/, SPEC 2).

import { agentAuthorized } from '../auth'
import { isUuid, jsonError, readJsonObject } from '../requests'
import { markAppleMusicDone } from '../../../../lib/agent-queue'

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
    const done = await markAppleMusicDone(trackId)
    if (!done) {
      return jsonError(404, 'Track not found')
    }
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[agent/apple-music-done] failed:', error)
    return jsonError(500, 'Could not record the Apple Music export')
  }
}
