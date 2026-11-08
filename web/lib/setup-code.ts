/**
 * The downloader setup code (T17): APP_URL and AGENT_TOKEN in one line that
 * the PC installer takes (agent/setup_code.py), so setting up the downloader
 * is a single copy and paste instead of editing agent\.env in Notepad.
 *
 * Format: "tapedeck1:" then base64url (no padding) of {"u": url, "t": token}.
 * It holds the agent token, so it is as secret as the token itself: the
 * Profile page that shows it is behind the app password.
 */
export const SETUP_CODE_PREFIX = 'tapedeck1:'

export interface SetupValues {
  appUrl: string
  agentToken: string
}

export function encodeSetupCode({ appUrl, agentToken }: SetupValues): string {
  return SETUP_CODE_PREFIX + Buffer.from(JSON.stringify({ u: appUrl, t: agentToken }), 'utf8').toString('base64url')
}

/** The values in a code, or null when it is not a valid one (spaces around it are fine). */
export function decodeSetupCode(code: string): SetupValues | null {
  const trimmed = code.trim()
  if (!trimmed.startsWith(SETUP_CODE_PREFIX)) return null
  try {
    const data = JSON.parse(Buffer.from(trimmed.slice(SETUP_CODE_PREFIX.length), 'base64url').toString('utf8')) as unknown
    if (!data || typeof data !== 'object') return null
    const { u, t } = data as { u?: unknown; t?: unknown }
    if (typeof u !== 'string' || !/^https?:\/\/\S+$/.test(u) || typeof t !== 'string' || !t) return null
    return { appUrl: u.replace(/\/+$/, ''), agentToken: t }
  } catch {
    return null
  }
}
