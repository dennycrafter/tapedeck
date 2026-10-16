/**
 * The catalog stand-in (SPEC 4.1 pattern, V2-PLAN T11): recorded Deezer and
 * iTunes responses served from web/e2e/fixtures/catalog-*.json instead of
 * the network. The e2e app server (TAPEDECK_TEST=1) always uses it, so tests
 * and CI never call Deezer or iTunes; a developer can turn it on for offline
 * work with CATALOG_SOURCE=fixtures.
 *
 * Every fixture is keyed by request path plus its sorted query, with the
 * search text lowercased and spaces collapsed (`fixtureKey`), so the same
 * file also backs the MSW handlers in the unit tests.
 */

/** True when catalog calls answer from fixtures instead of the network. */
export function catalogUsesFixtures(env: NodeJS.ProcessEnv = process.env): boolean {
  const choice = env.CATALOG_SOURCE?.trim().toLowerCase()
  if (choice === 'live') return false
  // Never in a real production deploy: the e2e production server sets TAPEDECK_TEST.
  if (choice === 'fixtures') return env.NODE_ENV !== 'production' || env.TAPEDECK_TEST === '1'
  return env.TAPEDECK_TEST === '1'
}

const SEARCH_PARAMS = new Set(['q', 'term'])

/** `/search?limit=25&q=daft punk` for `https://api.deezer.com/search?q=Daft%20Punk&limit=25`. */
export function fixtureKey(rawUrl: string): string {
  const url = new URL(rawUrl)
  const names = [...new Set(url.searchParams.keys())].sort()
  const parts = names.map((name) => {
    let value = url.searchParams.get(name) ?? ''
    if (SEARCH_PARAMS.has(name)) value = value.trim().toLowerCase().replace(/\s+/g, ' ')
    return `${name}=${value}`
  })
  return url.pathname + (parts.length > 0 ? `?${parts.join('&')}` : '')
}

interface DeezerFixtures {
  responses: Record<string, unknown>
  unknown: unknown
  empty: unknown
}

interface ItunesFixtures {
  responses: Record<string, unknown>
  empty: unknown
}

let deezerFixtures: Promise<DeezerFixtures> | null = null
let itunesFixtures: Promise<ItunesFixtures> | null = null

function loadDeezer(): Promise<DeezerFixtures> {
  deezerFixtures ??= import('../e2e/fixtures/catalog-deezer.json').then((m) => (m.default ?? m) as DeezerFixtures)
  return deezerFixtures
}

function loadItunes(): Promise<ItunesFixtures> {
  itunesFixtures ??= import('../e2e/fixtures/catalog-itunes.json').then((m) => (m.default ?? m) as ItunesFixtures)
  return itunesFixtures
}

/**
 * The recorded body for a Deezer or iTunes URL. Unknown searches answer
 * with the recorded empty result; an unknown Deezer id answers with the
 * recorded "no data" error (Deezer sends errors as HTTP 200 bodies).
 */
export async function fixtureResponse(rawUrl: string): Promise<unknown> {
  const url = new URL(rawUrl)
  const key = fixtureKey(rawUrl)
  if (url.hostname === 'api.deezer.com') {
    const fixtures = await loadDeezer()
    if (key in fixtures.responses) return structuredClone(fixtures.responses[key])
    return structuredClone(url.pathname.startsWith('/search') ? fixtures.empty : fixtures.unknown)
  }
  if (url.hostname === 'itunes.apple.com') {
    const fixtures = await loadItunes()
    if (key in fixtures.responses) return structuredClone(fixtures.responses[key])
    return structuredClone(fixtures.empty)
  }
  throw new Error(`No catalog fixture host for ${url.hostname}`)
}
