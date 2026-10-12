// GET /api/library (SPEC 8.6): the whole library in one snapshot: every
// track newest first, playlists with their song order, favourite albums,
// recently played, the display name and the downloader snapshot the header
// needs. The phone keeps this snapshot for offline use (SPEC 8.9).
// Session-gated by the proxy like every non-agent /api route.
import { getLibrarySnapshot } from '../../../lib/library'
import { jsonError } from '../agent/requests'

export async function GET(request: Request): Promise<Response> {
  // Reading the request keeps Cache Components from freezing this handler
  // at build time: the snapshot is only valid right now. Unknown query
  // params (the page's poll cache-buster) are ignored.
  new URL(request.url)
  try {
    return Response.json(await getLibrarySnapshot(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[library] failed:', error)
    return jsonError(500, 'Library unavailable')
  }
}
