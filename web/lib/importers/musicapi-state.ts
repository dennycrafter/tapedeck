/**
 * The tamper-proof `state` for the MusicAPI log in (V2-PLAN T13): the import
 * job id travels through MusicAPI's page inside the return address and comes
 * back to /api/import/callback/musicapi. It is signed with the app's existing
 * SESSION_SECRET (the one that signs the login cookie), so a changed job id
 * or an old link is refused.
 *
 *   state = <jobId>.<expiry unix seconds>.<HMAC-SHA256 in base64url>
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveSessionSecret } from '../../app/api/login/session'

/** How long a started log in stays valid. */
export const STATE_TTL_SECONDS = 30 * 60

function signature(jobId: string, expiry: number, secret: string): string {
  // A label of its own, so this signature can never stand in for a session cookie.
  return createHmac('sha256', secret).update(`tapedeck:musicapi-login:${jobId}:${expiry}`).digest('base64url')
}

export function signState(jobId: string, secret: string, nowMs: number = Date.now()): string {
  const expiry = Math.floor(nowMs / 1000) + STATE_TTL_SECONDS
  return `${jobId}.${expiry}.${signature(jobId, expiry, secret)}`
}

/** The job id when the state is ours, unchanged and not expired, else null. */
export function verifyState(state: string | null, secret: string, nowMs: number = Date.now()): string | null {
  if (!state) return null
  const parts = state.split('.')
  if (parts.length !== 3) return null
  const [jobId, rawExpiry, given] = parts
  if (!jobId || !/^\d{1,12}$/.test(rawExpiry)) return null
  const expiry = Number(rawExpiry)
  if (expiry < Math.floor(nowMs / 1000)) return null
  const expected = Buffer.from(signature(jobId, expiry, secret))
  const actual = Buffer.from(given)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  return jobId
}

/** SESSION_SECRET (or the dev stand-in secret). Null only in a production build that is not set up. */
export async function stateSecret(): Promise<string | null> {
  return resolveSessionSecret()
}
