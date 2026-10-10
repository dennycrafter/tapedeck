/**
 * Bearer-token guard for /api/agent/* (SPEC 8.3, SPEC 2).
 *
 * The proxy's session gate exempts /api/agent/ ("uses its own bearer token",
 * SPEC 2) because the PC downloader has no session cookie, so this check is
 * the only guard for every agent route. Exactly `Bearer ${AGENT_TOKEN}`
 * authorizes; anything else — missing header, wrong scheme, wrong token, or
 * no AGENT_TOKEN configured — fails closed. The comparison is constant-time
 * (the same `constantTimeEqual` helper the login and keepalive routes use)
 * so request timing cannot probe the token.
 */
import { constantTimeEqual } from '../login/session'

export function agentAuthorized(request: Request): boolean {
  const expected = process.env.AGENT_TOKEN
  if (!expected) return false
  const [scheme, token] = (request.headers.get('authorization') ?? '').split(' ')
  return scheme === 'Bearer' && typeof token === 'string' && constantTimeEqual(token, expected)
}

/**
 * The downloader's version, sent as `X-Agent-Version` (optional). Recorded
 * into settings.agent_version on the agent's first claim and kept fresh on
 * every poll that carries it (SPEC 8.3 brief: "app_version ... on first run").
 */
export function agentVersion(request: Request): string | null {
  return request.headers.get('x-agent-version')?.trim() || null
}
