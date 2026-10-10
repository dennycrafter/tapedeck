// GET /api/search?q= — YouTube search for the Add window (SPEC 8.7).
// Session-gated like every /api route (the proxy's cookie check is the
// guard). Runs only on an explicit submit (the UI's job, to save quota),
// requires at least 2 characters, and surfaces the SPEC's no-key and quota
// messages as a `message` the box can show instead of failing.

import { jsonError } from '../agent/requests'
import { searchYoutube, SearchQuotaError } from '../../../lib/search-youtube'

const MIN_QUERY_LENGTH = 2

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (query.length < MIN_QUERY_LENGTH) {
    return jsonError(400, 'Type at least 2 characters to search')
  }

  try {
    const { results, message } = await searchYoutube(query, process.env.YOUTUBE_API_KEY)
    return Response.json(message ? { results, message } : { results })
  } catch (cause) {
    if (cause instanceof SearchQuotaError) {
      return Response.json({
        results: [],
        message: 'Search limit reached for today. Paste a link instead, or try again tomorrow.',
      })
    }
    console.error('[search] failed:', cause)
    return jsonError(502, 'Could not search YouTube')
  }
}
