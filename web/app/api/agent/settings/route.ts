// GET /api/agent/settings (SPEC 8.3): the downloader fetches this once per
// loop to decide whether it should also copy finished songs into the Apple
// Music folder (8.11, off by default).
// Auth: bearer AGENT_TOKEN only (the proxy exempts /api/agent/, SPEC 2).
// Reading `request` keeps the handler per-request (Next 16 Cache Components),
// so the response is never cached.

import { agentAuthorized } from '../auth'
import { jsonError } from '../requests'
import { sql } from '../../../../lib/db'

export async function GET(request: Request): Promise<Response> {
  if (!agentAuthorized(request)) {
    return jsonError(401, 'Unauthorized')
  }
  try {
    const rows = await sql`select apple_music_export from settings where id = 1`
    if (rows.length === 0) {
      // The schema seeds this row on create; a missing row means a broken
      // database state, not an empty setting — fail loudly instead of
      // silently disabling the owner's export preference.
      console.error('[agent/settings] settings row is missing')
      return jsonError(500, 'Settings unavailable')
    }
    return Response.json({ apple_music_export: rows[0].apple_music_export === true })
  } catch (error) {
    console.error('[agent/settings] failed:', error)
    return jsonError(500, 'Settings unavailable')
  }
}
