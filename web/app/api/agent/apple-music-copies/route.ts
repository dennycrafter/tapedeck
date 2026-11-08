// POST /api/agent/apple-music-copies (T15 follow-up): the downloader asks
// for uploaded songs to copy into Apple Music. They have no link to download
// again, so the answer holds short-lived links to the stored files instead:
// `{ copies: [{ id, title, artist, album, albumArtist, format, audioUrl,
// coverUrl }] }`, at most 3, each claimed for 15 minutes (lib/apple-music-
// uploads.ts). The downloader reports each one with /api/agent/apple-music-done.
// Auth: bearer AGENT_TOKEN only (the proxy exempts /api/agent/, SPEC 2).

import { agentAuthorized } from '../auth'
import { jsonError } from '../requests'
import { claimAppleMusicCopies } from '../../../../lib/apple-music-uploads'

export async function POST(request: Request): Promise<Response> {
  if (!agentAuthorized(request)) {
    return jsonError(401, 'Unauthorized')
  }

  try {
    return Response.json({ copies: await claimAppleMusicCopies() })
  } catch (error) {
    console.error('[agent/apple-music-copies] failed:', error)
    return jsonError(500, 'Could not claim Apple Music copies')
  }
}
