// POST /api/agent/claim (SPEC 8.3): the downloader's poll.
//
// Auth: exactly `Bearer ${AGENT_TOKEN}`, constant-time. It is the only guard,
// since the proxy exempts /api/agent/ (the downloader has no session cookie).
// Sequence per SPEC: reset stale claims (downloading rows older than 15
// minutes), claim up to 3 waiting tracks oldest-first in one atomic CTE
// (`for update skip locked`), then record agent_last_seen (+ agent_version
// when the `X-Agent-Version` header is present: the agent's "first run"
// fingerprint). Seen is recorded only after a successful claim so a failing
// poll never fakes downloader presence (same reasoning as /api/cron/keepalive).
//
// Response: a bare JSON array of claimed tracks with the SPEC 8.3 field list
// (id, source, source_url, title, artist, album, cover_url, duration_sec,
// apple_music) plus the v2 fields isrc, catalog_id and resolved_url; the
// downloader iterates it directly.
//
// v2 (V2-PLAN T9): an optional body `{ capabilities: string[] }`. Catalog
// songs only go to a downloader that sends "catalog"; older ones send no
// body and never get them.
//
// Reading `request` keeps the handler per-request (Next 16 Cache Components),
// so the response is never cached.

import { agentAuthorized, agentVersion } from '../auth'
import { jsonError, readJsonObject } from '../requests'
import { parseCapabilities } from '../v2-fields'
import { claimTracks, recordAgentSeen } from '../../../../lib/agent-queue'

export async function POST(request: Request): Promise<Response> {
  if (!agentAuthorized(request)) {
    return jsonError(401, 'Unauthorized')
  }
  try {
    const capabilities = parseCapabilities(await readJsonObject(request))
    const tracks = await claimTracks(undefined, capabilities)
    await recordAgentSeen(agentVersion(request))
    return Response.json(tracks)
  } catch (error) {
    console.error('[agent/claim] failed:', error)
    return jsonError(500, 'Claim failed')
  }
}
