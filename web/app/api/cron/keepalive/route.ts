// /api/cron/keepalive (SPEC 7.8, T0 step 7): the daily cron Vercel fires to
// keep the Supabase database from pausing (the free tier pauses after 7 days
// without a database request). One `select` on `settings` counts as activity
// and resets that idle clock.
//
// Auth (SPEC 7.8): Vercel sends `Authorization: Bearer ${CRON_SECRET}`;
// anything else is rejected with 401. The proxy's session gate exempts this
// path (SPEC 2 lists /api/cron/keepalive), so this check is the only guard.
// CRON_SECRET is read from the environment in every mode: a Vercel env var
// in production, appEnv() in the e2e harness. The shared dev-secrets file is
// not consulted: its writer (login/session.ts) persists only SESSION_SECRET
// and would clobber other keys. With no secret configured the route fails
// closed and 401s every request.
//
// The query is a plain SELECT on purpose: agent_last_seen means "downloader
// seen" (SPEC treats the downloader as online within 2 minutes of it), and
// this route must not fake downloader presence. A select is enough database
// activity for the pause timer.
//
// Reading `request` keeps the handler per-request (Next 16 Cache Components
// removes the `dynamic` segment config), so the response is never cached.

import { sql } from '../../../../lib/db'
// Same constant-time compare the login route uses for APP_PASSWORD; a
// bearer secret deserves the same treatment (SPEC's constant-time convention).
import { constantTimeEqual } from '../../login/session'

/** SPEC 7.8 bearer check: exactly `Bearer ${CRON_SECRET}`, nothing else. */
function authorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const [scheme, token] = (request.headers.get('authorization') ?? '').split(' ')
  return scheme === 'Bearer' && typeof token === 'string' && constantTimeEqual(token, expected)
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    // The SPEC's one query (7.8): touch the settings row so the database
    // shows activity.
    await sql`select id from settings limit 1`
    return Response.json({ ok: true })
  } catch (error) {
    // Surface the fault: the cron's whole job is proving the database works.
    console.error('[cron/keepalive] settings select failed:', error)
    return Response.json({ error: 'Keepalive failed' }, { status: 500 })
  }
}
