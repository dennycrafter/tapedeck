// GET /api/profile/downloader (SPEC 8.6): the Downloader setup panel's data:
// APP_URL and AGENT_TOKEN to copy into the downloader's .env, plus the live
// downloader status. AGENT_TOKEN is the bearer secret the downloader already
// uses; the proxy's session gate keeps this owner-only (SPEC 8.1).
//
// Ownership note (T1d coordination): unowned read side shipped by the UI
// tracer (T1b owns the agent API, T1c the add pipeline); flagged to the
// coordinator in the task report.
import { sql, type Row } from '../../../../lib/db'
import { jsonError } from '../../agent/requests'

export async function GET(request: Request): Promise<Response> {
  const agentToken = process.env.AGENT_TOKEN
  if (!agentToken) {
    // Fail loudly: a panel with an empty token would invite a broken setup.
    console.error('[profile/downloader] AGENT_TOKEN is not configured')
    return jsonError(500, 'Downloader setup unavailable')
  }
  try {
    const settingsRows = (await sql`
      select agent_last_seen from settings where id = 1
    `) as { agent_last_seen: Row['agent_last_seen'] }[]
    const waitingRows = (await sql`
      select count(*) as count from tracks where status = 'waiting'
    `) as { count: string | number }[]
    const lastSeenRaw = settingsRows[0]?.agent_last_seen
    return Response.json({
      // SPEC 5.1: APP_URL is the deployment's public URL; fall back to the
      // request origin in dev/test where the env var is not set.
      appUrl: process.env.APP_URL || new URL(request.url).origin,
      agentToken,
      lastSeenAt:
        lastSeenRaw == null ? null : lastSeenRaw instanceof Date ? lastSeenRaw.toISOString() : String(lastSeenRaw),
      waitingCount: Number(waitingRows[0]?.count ?? 0),
    })
  } catch (error) {
    console.error('[profile/downloader] failed:', error)
    return jsonError(500, 'Downloader setup unavailable')
  }
}
