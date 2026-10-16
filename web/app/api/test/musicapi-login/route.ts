// Test-only (V2-PLAN T13, "login flow (fake provider)"): plays MusicAPI's
// hosted log-in page for the MusicAPI importer's stand-in
// (lib/importers/musicapi-standin.ts). "Allow" goes back to the return
// address with a `data64` answer for the fixture listener, the way MusicAPI
// does; "Cancel" goes back with a failed answer. Exists ONLY when
// TAPEDECK_TEST=1 (404 everywhere else) and sits behind the app password
// like every /api route. It only ever sends the browser back to this app's
// own MusicAPI callback.
//
// GET ?returnUrl=<callback with state>&ms=<service>&forwardFailures=true -> an HTML page
import { encodeCallback } from '../../../../lib/importers/musicapi-client'
import { loadStandinFixtures } from '../../../../lib/importers/musicapi-standin'

const CALLBACK_PATH = '/api/import/callback/musicapi'

const LABELS: Record<string, string> = {
  spotify: 'Spotify',
  appleMusic: 'Apple Music',
  youtube: 'YouTube Music',
  tidal: 'Tidal',
  deezer: 'Deezer',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function back(returnUrl: URL, data64: string): string {
  const url = new URL(returnUrl)
  url.searchParams.set('data64', data64)
  return url.toString()
}

export async function GET(request: Request): Promise<Response> {
  if (process.env.TAPEDECK_TEST !== '1') return new Response('Not found', { status: 404 })
  const here = new URL(request.url)
  let returnUrl: URL
  try {
    returnUrl = new URL(here.searchParams.get('returnUrl') ?? '')
  } catch {
    return new Response('Expected returnUrl', { status: 400 })
  }
  if (returnUrl.origin !== here.origin || returnUrl.pathname !== CALLBACK_PATH) {
    return new Response('returnUrl must be this app\'s MusicAPI callback', { status: 400 })
  }
  const ms = here.searchParams.get('ms') ?? ''
  const label = LABELS[ms] ?? 'your music service'
  const { user } = await loadStandinFixtures()
  const allow = back(returnUrl, encodeCallback({
    integrationUserUUID: user,
    authModel: { uuid: '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6', status: 'success', error: null },
    integration: { type: ms },
  }))
  const cancel = back(returnUrl, encodeCallback({
    integrationUserUUID: null,
    authModel: { uuid: '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d7', status: 'error', error: 'accessDenied' },
    integration: { type: ms },
  }))
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stand-in MusicAPI log in</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; max-width: 30rem">
<h1 data-testid="musicapi-standin-title">Log in to ${escapeHtml(label)}</h1>
<p>This is the test stand-in for MusicAPI's log-in page. Tapedeck wants to read your playlists and liked songs.</p>
<p><a data-testid="musicapi-allow" href="${escapeHtml(allow)}">Allow</a></p>
<p><a data-testid="musicapi-cancel" href="${escapeHtml(cancel)}">Cancel</a></p>
</body>
</html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}
